/**
 * The weekly note: where it is, what it says, and the guard that keeps a generated write off
 * anything that is not ours.
 *
 * Pure, like `dashboard.ts` and for the same reason: one markdown document is generated on
 * every scan, so every case that could eat a person's writing is a string in and a string out
 * and can be reproduced in a test without Obsidian.
 *
 * The vault side is in `vault.ts`: read the file, hand it here, write back what comes out.
 */
import { cell, linkCell, relativeAge } from "./format.ts";
import { normalizePath } from "./obsidian-compat.ts";
import { rankProjects } from "./rank.ts";
import type { PluginSettings, Project } from "./types.ts";

/** The folder the weekly notes live in, under the dashboard folder. */
export const WEEKLY_SUBFOLDER = "Weekly";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The folder holding this week's note.
 *
 * An empty notes folder means the vault root, so the result is plain `Weekly`: same rule as
 * the dashboard, and no hardcoded folder to fall back to.
 */
export function weeklyFolder(settings: PluginSettings): string {
	return normalizePath(`${settings.notesFolder}/${WEEKLY_SUBFOLDER}`);
}

/**
 * The one file a scan writes: `<dashboard folder>/Weekly/<ISO week>.md`.
 *
 * `now` is passed in rather than read here so a caller computes the path, the guard and the
 * render for the same instant.
 */
export function weeklyPath(settings: PluginSettings, now: number): string {
	return `${weeklyFolder(settings)}/${isoWeekKey(now)}.md`;
}

/**
 * The basename of a file the weekly writer could have created: an ISO week key, week 1 to 53.
 *
 * The week is bounded on purpose. `2026-W99` is not a week this plugin can ever write, so a
 * journal a person named that is their note and stays linkable.
 */
const WEEKLY_FILE = /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/;

/**
 * True when `path` names a file the weekly writer could have created.
 *
 * The folder alone is not enough to exclude a note from the project-note candidates. With an
 * empty notes folder the weekly folder is literally `Weekly`, and a user who keeps project notes
 * there would lose every link in it whether or not they ever turned the feature on. Only the
 * plugin's own filenames are skipped: a direct child of the weekly folder whose basename is a
 * real ISO week key (`YYYY-Www`). A user note called `Notes.md` or `2026-plan.md` in that folder,
 * a nested file under it, and a week-shaped name anywhere else are the user's and stay in the
 * list.
 *
 * The extension is compared without case so a case-insensitive filesystem cannot present the
 * plugin's own file as a candidate under a different spelling.
 */
export function isWeeklyNotePath(settings: PluginSettings, path: string): boolean {
	const folder = weeklyFolder(settings);
	const prefix = `${folder}/`;
	if (!path.startsWith(prefix)) return false;
	const rest = path.slice(prefix.length);
	// A direct child only: a nested folder under the weekly folder is the user's.
	if (rest.includes("/")) return false;
	if (!rest.toLowerCase().endsWith(".md")) return false;
	return WEEKLY_FILE.test(rest.slice(0, -3));
}

/**
 * The ISO week of `now` as `YYYY-Www`, the week zero-padded to two digits.
 *
 * The week-year is not the calendar year. The last days of December can belong to week 1 of
 * the next year, and the first days of January can belong to week 52 or 53 of the previous
 * one. The ISO rule is that a week belongs to the year holding its Thursday, so the arithmetic
 * below finds this week's Thursday and asks which year it is in.
 *
 * Read in local time, because the note is written for the day the user is living in rather than
 * for UTC. The day arithmetic runs on `Date.UTC` fields so a daylight-saving shift in the local
 * zone cannot make a week 167 or 169 hours long.
 */
export function isoWeekKey(now: number): string {
	const { year, week } = isoWeek(now);
	return `${year}-W${String(week).padStart(2, "0")}`;
}

/**
 * The Monday of the ISO week containing `now` as `YYYY-MM-DD`, in local time.
 *
 * `setDate` rather than millisecond subtraction so month and year boundaries roll over the way
 * a calendar does, and the result is read from the local fields so the date is the one the user
 * is living in.
 */
export function weekStartKey(now: number): string {
	const date = new Date(now);
	date.setDate(date.getDate() - isoDayOfLocal(date));
	return localDateKey(date);
}

/** The Sunday of the ISO week containing `now` as `YYYY-MM-DD`, in local time. */
export function weekEndKey(now: number): string {
	const date = new Date(now);
	date.setDate(date.getDate() - isoDayOfLocal(date) + 6);
	return localDateKey(date);
}

/**
 * This week's note body, as markdown.
 *
 * Two tables and nothing else, because a week is a question with two answers: what moved, and
 * what is open but did not. The first is ordered by commit count so the busiest project is on
 * top, with the name as a tiebreak so the order is deterministic. The second is ordered by
 * `rankProjects`, the same function the panel ranks with, so the note and the sidebar cannot
 * disagree about what is on top. Nothing here is generated prose: a table cell is short enough
 * that a sentence would be worse.
 *
 * Commits come from `countCommitsSince` per repo, counted along HEAD only, and `commitsThisWeek`
 * is keyed by repository path rather than project name: two repos can share a basename, and a map
 * keyed by name would give both the other's count. A project that committed this week is in the
 * first table; a project with live work but no commit this week is in the second; a project with
 * neither is in neither, whatever the dormant setting says. The two tables can never overlap,
 * because the second only takes projects whose count is 0.
 *
 * The Note column is the honest part, exactly as on the dashboard: a project with no note says
 * so in words rather than rendering a link that goes nowhere.
 */
export function renderWeeklySection(
	projects: readonly Project[],
	commitsThisWeek: ReadonlyMap<string, number>,
	now: number,
): string {
	const commitsFor = (project: Project): number => commitsThisWeek.get(project.facts.path) ?? 0;

	const worked = projects.filter((project) => commitsFor(project) > 0).sort((a, b) => {
		const difference = commitsFor(b) - commitsFor(a);
		return difference !== 0 ? difference : a.facts.name.localeCompare(b.facts.name);
	});

	// Ranked on a copy so the caller's list comes back as it was found.
	const open = rankProjects(
		projects.filter(
			(project) =>
				commitsFor(project) === 0 && (project.facts.dirtyCount > 0 || project.facts.onNonDefaultBranch),
		),
	);

	const lines: string[] = [];
	lines.push(
		`Week of ${weekStartKey(now)} to ${weekEndKey(now)} (${isoWeekKey(now)}). Written between the markers below on every scan. Everything outside them is yours.`,
	);
	lines.push("");
	if (worked.length === 0 && open.length === 0) {
		lines.push("_No activity recorded this week._");
		return lines.join("\n");
	}

	lines.push("## Worked on this week");
	lines.push("");
	lines.push("| Project | Commits | Branch | Last commit | Note |");
	lines.push("| --- | --- | --- | --- | --- |");
	for (const project of worked) {
		const row = [
			cell(project.facts.name),
			cell(String(commitsFor(project))),
			cell(project.facts.branch ?? ""),
			cell(relativeAge(project.facts.lastCommit, now)),
			noteCell(project),
		];
		lines.push(`| ${row.join(" | ")} |`);
	}
	lines.push("");

	lines.push("## Still open, nothing this week");
	lines.push("");
	lines.push("| Project | Branch | Uncommitted | Last commit | Warnings | Note |");
	lines.push("| --- | --- | --- | --- | --- | --- |");
	for (const project of open) {
		const row = [
			cell(project.facts.name),
			cell(project.facts.branch ?? ""),
			cell(String(project.facts.dirtyCount)),
			cell(relativeAge(project.facts.lastCommit, now)),
			cell(project.health.map((signal) => signal.badge).join(", ")),
			noteCell(project),
		];
		lines.push(`| ${row.join(" | ")} |`);
	}
	return lines.join("\n");
}

/**
 * Throw unless `target` is safe to write generated content to.
 *
 * Mirrors `assertSafeTarget` in `dashboard.ts`, and for the same reason: it re-derives the path
 * and compares rather than trusting the caller to have picked the right one, because the
 * failure being prevented is a generated write landing on a document somebody wrote. The extra
 * argument is `now`, because the target is a week: a scan that straddles a week boundary has
 * two different right answers, and the guard has to be told which one this write is for.
 *
 * Three refusals, in the order they would matter:
 *
 * - Not this week's weekly path. A caller that computed something else, or computed for another
 *   moment, has a bug, and the bug should be loud.
 * - Not a markdown file.
 * - Not inside the weekly folder. When the folder is the vault root, everything is inside it.
 */
export function assertSafeWeeklyTarget(settings: PluginSettings, target: string, now: number): void {
	const expected = weeklyPath(settings, now);
	if (target !== expected) {
		throw new Error(`refusing to write ${target}: the weekly note is ${expected}`);
	}
	if (!target.endsWith(".md")) {
		throw new Error(`refusing to write ${target}: not a markdown file`);
	}
	const folder = weeklyFolder(settings);
	if (folder !== "" && !target.startsWith(`${folder}/`)) {
		throw new Error(`refusing to write outside ${folder}: ${target}`);
	}
}

/** A project's note cell: its link, or the words `no note` rather than a dead wikilink. */
function noteCell(project: Project): string {
	return project.notePath ? linkCell(project.notePath) : "no note";
}

/** The ISO week-year and week number of `now`, read in local time. */
function isoWeek(now: number): { year: number; week: number } {
	const date = new Date(now);
	const today = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
	// Monday is 0 and Sunday is 6, which are the ISO week's first and last day.
	const thursday = new Date(today + (3 - isoDay(today)) * DAY_MS);
	const year = thursday.getUTCFullYear();

	// The first Thursday of the week-year is the Thursday of the week containing January 4th,
	// which is the shortest way to say "the week that holds the first Thursday of the year".
	const jan4 = Date.UTC(year, 0, 4);
	const firstThursday = jan4 + (3 - isoDay(jan4)) * DAY_MS;
	const week = Math.round((thursday.getTime() - firstThursday) / (7 * DAY_MS)) + 1;
	return { year, week };
}

/** Monday 0 through Sunday 6 for a UTC calendar day. */
function isoDay(dayUtc: number): number {
	return (new Date(dayUtc).getUTCDay() + 6) % 7;
}

/** Monday 0 through Sunday 6 for a local date. */
function isoDayOfLocal(date: Date): number {
	return isoDay(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
}

/** A local date's `YYYY-MM-DD`. */
function localDateKey(date: Date): string {
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}
