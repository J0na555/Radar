/**
 * Filtering and grouping for the project list.
 *
 * Everything here runs on the projects a scan already found, in memory. A filter never
 * rescans: that would work, at about 0.17s for 45 repos, but holding down a key in the
 * search box would fork 45 `git` processes, rewrite 45 note frontmatter blocks, and can fail
 * for reasons that have nothing to do with filtering. Only the refresh button and `r`
 * rescan.
 *
 * The grouping is the same three groups the panel has always drawn, in the same order:
 * pinned first in the user's order, then active by score, then the rest. Every group reports
 * what it is hiding, so a filtered panel can never be mistaken for one that lost data.
 *
 * Nothing here mutates its input. `rankProjects` hands over a fresh sorted array and this
 * module only reads it, so filtering cannot reorder the plugin's own project list out from
 * under the next render.
 */
import { fuzzyScore, weakMatchThreshold } from "./fuzzy.ts";
import type { Project } from "./types.ts";

/** The three groups the panel draws, in the order it draws them. */
export type GroupKey = "pinned" | "active" | "dormant";

/**
 * Which filter hid a project, phrased so it drops into a sentence. These strings are the
 * panel's explanation of itself, so they are written to be read next to a number: "3 hidden
 * by search", "4 hidden by Active only".
 */
export type HiddenBy = "search" | "Active only" | "Pinned only" | "the Dormant toggle";

/**
 * Every `HiddenBy`, in the order the panel lists them: from the broadest thing standing
 * between the user and the project to the thing they are holding down right now, so the
 * breakdown reads as a list of what to undo rather than a hash table's iteration order.
 */
export const HIDDEN_BY: readonly HiddenBy[] = [
	"Pinned only",
	"the Dormant toggle",
	"Active only",
	"search",
];

/**
 * What the user has asked to see.
 *
 * `showDormant` is not a view-only flag: it is the plugin's own persisted setting, the same
 * one the settings tab writes. It is passed in rather than held here so there is exactly one
 * copy of it, and so `Esc` cannot silently undo a choice the user expects to still be there
 * tomorrow.
 */
export interface FilterState {
	/** Fuzzy query over the project name. Blank means no text filtering. */
	query: string;
	/** Hide everything that is not active. */
	activeOnly: boolean;
	/** Show projects with no live work. The persisted `showDormant` setting. */
	showDormant: boolean;
	/** Show only pinned projects. */
	pinnedOnly: boolean;
}

/** One visible row, and why it is the match it is. */
export interface FilterRow {
	project: Project;
	/**
	 * Fuzzy score, or null when no query is filtering. Null rather than zero: "not
	 * searched for" and "searched for and matched badly" are different, and only one of
	 * them should be dimmed.
	 */
	score: number | null;
	/** True when the query only matched by scattering characters across the name. */
	weak: boolean;
}

/** One group, with what it is showing and what it is not. */
export interface FilterGroup {
	key: GroupKey;
	label: string;
	rows: FilterRow[];
	/** Projects that belong in this group, before any filter ran. */
	total: number;
	/** How many of them the filters are hiding. */
	hidden: number;
	/** Which filter hid the most of them, for the heading's tooltip. */
	hiddenBy: HiddenBy | null;
}

export interface FilterResult {
	groups: FilterGroup[];
	/** Every visible row in display order, which is what the selection indexes into. */
	rows: FilterRow[];
	/** The query that was applied, echoed so the caller can describe the state. */
	query: string;
	/** Projects the scan found, before any filter ran. */
	scanned: number;
	/** Projects visible now. */
	visible: number;
	/** How many projects are hidden, and which filter hid each one. */
	hidden: { total: number; by: Record<HiddenBy, number> };
	/** Visible rows that matched only weakly, dimmed rather than dropped. */
	weak: number;
}

/** A row plus where it sat in the ranked list, which is the tie-break for search order. */
interface ScoredRow extends FilterRow {
	rank: number;
}

/** `1 project` rather than `1 projects`. */
export function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** True when anything at all is narrowing the list, which is what the headings report. */
export function isFiltering(state: FilterState): boolean {
	return state.query.trim() !== "" || state.activeOnly || state.pinnedOnly || !state.showDormant;
}

/**
 * What `Esc` should do.
 *
 * The query first, then the view-only toggles. Never `showDormant`: that one is a
 * persisted setting, and an escape key is not consent to forget it.
 */
export function nextStateOnEscape(state: FilterState): FilterState {
	if (state.query.trim() !== "") return { ...state, query: "" };
	return { ...state, activeOnly: false, pinnedOnly: false };
}

/**
 * Which filter excludes this project, or null when nothing does.
 *
 * One place decides this, and `filterProjects` is its only caller, because two copies of
 * "what does Pinned only mean" is how a panel ends up hiding a project without saying so.
 *
 * The order is the order of how much the user would have to undo. A pinned project outranks
 * every toggle, which is what pinning has always meant: it is a direct instruction about
 * this project, so no view toggle may hide it. After that a standing setting
 * (`showDormant`, off by default) is named before a filter the user is holding down right
 * now, because it is what was already hiding these projects before the keystroke. The search
 * query is last, and reported only for projects that would otherwise have been shown, which
 * keeps the counts summing to the number actually hidden.
 */
export function hiddenBy(project: Project, state: FilterState): HiddenBy | null {
	if (state.pinnedOnly && project.pin <= 0) return "Pinned only";
	if (project.pin > 0) return null;
	if (project.score.status === "active") return null;
	if (!state.showDormant) return "the Dormant toggle";
	if (state.activeOnly) return "Active only";
	return null;
}

/**
 * Group the projects and apply the filters.
 *
 * `projects` is expected to be ranked already, and is only read.
 */
export function filterProjects(projects: readonly Project[], state: FilterState): FilterResult {
	const by = emptyTally();
	const groups: FilterGroup[] = [];
	const rows: FilterRow[] = [];
	const blank = state.query.trim() === "";

	for (const [key, label] of [
		["pinned", "Pinned"],
		["active", "Active"],
		["dormant", "Dormant"],
	] as [GroupKey, string][]) {
		const members = projects.filter((project) => groupOf(project) === key);
		const matched: ScoredRow[] = [];
		// Tallied here rather than recounted afterwards: the group needs to say what it is
		// hiding, and a second pass would either re-run every fuzzy match or duplicate the
		// rules in `hiddenBy` and risk the two disagreeing.
		const tally = emptyTally();

		members.forEach((project, rank) => {
			const reason = hiddenBy(project, state);
			if (reason !== null) {
				by[reason]++;
				tally[reason]++;
				return;
			}
			// Only a project a toggle has already let through gets searched, so the search
			// tally can never claim credit for hiding something already hidden.
			const score = blank ? null : fuzzyScore(state.query, project.facts.name);
			if (!blank && score === null) {
				by.search++;
				tally.search++;
				return;
			}
			matched.push({
				project,
				score,
				weak: score !== null && score < weakMatchThreshold(state.query),
				rank,
			});
		});

		// A text query reorders within the group, best match first, rank breaking ties. The
		// groups themselves do not move: pinned stays above active, because a pin is a
		// stronger statement than a match quality.
		if (!blank) matched.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.rank - b.rank);

		const hidden = members.length - matched.length;
		groups.push({
			key,
			label,
			rows: matched,
			total: members.length,
			hidden,
			hiddenBy: hidden > 0 ? leadingReason(tally) : null,
		});
		for (const row of matched) rows.push(row);
	}

	// An empty group is not drawn at all, so it must not report itself as hiding
	// anything. Three headings all saying "0" is noise on an unfiltered panel.
	const drawn = groups.filter((group) => group.total > 0);
	const hiddenTotal = HIDDEN_BY.reduce((total, reason) => total + by[reason], 0);
	return {
		groups: drawn,
		rows,
		query: state.query,
		scanned: projects.length,
		visible: rows.length,
		hidden: { total: hiddenTotal, by },
		weak: rows.filter((row) => row.weak).length,
	};
}

/**
 * One line saying what the panel is showing and what it is not.
 *
 * The panel has to be honest about hiding things: a row that vanished with no explanation
 * reads as data loss, and the user's next move is to press refresh for no reason. Every
 * number comes from the filter result, so the sentence cannot disagree with the list
 * underneath it.
 */
export function describeFilter(result: FilterResult): string {
	if (result.scanned === 0) return "No git repositories found under the scan root.";

	const reasons = HIDDEN_BY.filter((reason) => result.hidden.by[reason] > 0).map(
		(reason) => `${result.hidden.by[reason]} hidden by ${reason}`,
	);

	if (result.visible === 0) {
		// An empty panel is where the explanation matters most: nothing on screen is the moment
		// "the filter ate my projects" is most believable, so the breakdown is included rather
		// than left to a non-empty list.
		const because = reasons.length > 0 ? ` ${reasons.join(", ")}.` : "";
		return `Nothing shown. ${plural(result.scanned, "project")} scanned.${because}`;
	}

	if (reasons.length === 0) {
		// The weak count still appears: those rows are dimmed, and a dimmed row with no
		// explanation is the same problem one step smaller.
		const weak = result.weak > 0 ? ` ${result.weak} only matched loosely.` : "";
		return `${plural(result.scanned, "project")}.${weak}`;
	}

	return `${result.visible} of ${result.scanned} shown. ${reasons.join(", ")}.`;
}

/**
 * The heading for one group: its name, and how much of it is on screen.
 *
 * Just the count when nothing is being filtered, which is how the panel has always looked.
 * `(2 of 5)` once something is, because a heading saying "(2)" while the filter says "5
 * shown" is two numbers that appear to contradict each other.
 */
export function describeGroup(group: FilterGroup, filtering: boolean): string {
	if (!filtering || group.hidden === 0) return `${group.label} (${group.rows.length})`;
	return `${group.label} (${group.rows.length} of ${group.total})`;
}

/**
 * What this group is hiding, in words. Empty string when it is hiding nothing, and the
 * reason is the one that hid the most, because that is the one worth changing.
 *
 * On the heading's tooltip and its `aria-label`, so it is reachable without hunting for the
 * status line and read aloud to anybody not looking at the screen.
 */
export function explainGroup(group: FilterGroup): string {
	if (group.hidden === 0) return "";
	const by = group.hiddenBy === null ? "" : ` by ${group.hiddenBy}`;
	return `${plural(group.hidden, "project")} hidden${by}.`;
}

/** Which of the three groups a project belongs to, before any filter runs. */
function groupOf(project: Project): GroupKey {
	if (project.pin > 0) return "pinned";
	return project.score.status === "active" ? "active" : "dormant";
}

/** A fresh tally of zero, one key per reason so nothing can be forgotten. */
function emptyTally(): Record<HiddenBy, number> {
	return { search: 0, "Active only": 0, "Pinned only": 0, "the Dormant toggle": 0 };
}

/**
 * The reason to name for a group when several of its projects are hidden: the one that hid
 * the most, because that is the one worth changing. Ties go to the earlier entry in
 * `HIDDEN_BY`, which is ordered broadest first, so the same filters always name the same
 * reason.
 */
function leadingReason(tally: Record<HiddenBy, number>): HiddenBy | null {
	let best: HiddenBy | null = null;
	for (const reason of HIDDEN_BY) {
		if (tally[reason] > 0 && (best === null || tally[reason] > tally[best])) best = reason;
	}
	return best;
}
