/**
 * One project row, and the widgets it is made of.
 *
 * Out of `view.ts` because the row grew past the point where the state and the markup were
 * in the same function. The view decides what happens, this builds the elements and hands
 * back the click handlers.
 *
 * The labelling contract is the same everywhere in here: a control that acts gets its full
 * wording on both `aria-label` and `title`, so the explanation is reachable by keyboard and
 * readable on hover.
 *
 * Plain `createElement` and `textContent` throughout rather than Obsidian's prototype
 * helpers, which only exist once Obsidian has patched the DOM: a row that throws while
 * drawing leaves an empty panel with a stack trace nobody sees.
 */
import { setIcon } from "obsidian";
import { relativeAge } from "./format";
import { describeScore } from "./rank";
import type { HealthSignal, Project, ScoreResult } from "./types";

/** What one row needs to draw itself, and what its controls should do. */
export interface ProjectRowOptions {
	project: Project;
	/** Drawn in the pinned group, which also decides whether the pin slot has a rank. */
	pinned: boolean;
	/** Highlighted because the keyboard selection is on it. */
	selected: boolean;
	/** The query matched only by scattering characters, so dim rather than hide it. */
	weak: boolean;
	/** Draw the "why this score" line under the name. */
	explainScores: boolean;
	/** Wording for the editor control, which depends on the configured command. */
	editorLabel: string;
	/** One clock for every row, so ages on the same panel agree. */
	now: number;
	/** A summary is running for this project, so its control is disabled. */
	summarizing: boolean;
	/**
	 * Put the keyboard selection on this row. Separate from the row's own actions because
	 * selecting is not acting: clicking a name selects the row and opens its note, and the
	 * highlight has to move either way, or the panel ends up with two different notions of
	 * "the row I am on".
	 */
	onSelect: () => void;
	onOpenNote: (project: Project) => void;
	onRunSummary: (project: Project) => void;
	onOpenEditor: (project: Project) => void;
	/** Right-click, which is where every other action lives. */
	onContextMenu: (event: MouseEvent, project: Project) => void;
}

/**
 * One project row, whole.
 *
 * Element order on the right is fixed for every row: pin slot, editor, summary, score. The
 * pin slot is drawn even when the project is unpinned, so the score never moves sideways
 * when something gets pinned.
 */
export function createProjectRow(doc: Document, options: ProjectRowOptions): HTMLElement {
	const { project, pinned, selected, weak, explainScores, now, summarizing } = options;

	const classes = ["pt-row"];
	if (pinned) classes.push("is-pinned");
	if (selected) classes.push("is-selected");
	if (weak) classes.push("is-weak");
	if (project.score.status !== "active") classes.push(`is-${project.score.status}`);

	const row = doc.createElement("div");
	row.className = classes.join(" ");

	const main = doc.createElement("div");
	main.className = "pt-main";
	row.appendChild(main);

	const name = doc.createElement("div");
	name.className = "pt-name";
	name.textContent = project.facts.name;
	// The mouse equivalent of moving the cursor here and pressing Enter, and it has to select
	// as well as open. Otherwise the panel carries two ideas of the current row: the
	// highlighted one, which `j`, `Enter`, `s` and `p` all act on, and the one the user last
	// clicked. They drift apart the moment somebody clicks a row and then presses `s`.
	name.addEventListener("click", () => {
		options.onSelect();
		options.onOpenNote(project);
	});
	main.appendChild(name);

	const meta = doc.createElement("div");
	meta.className = "pt-meta";
	main.appendChild(meta);
	if (project.facts.branch) {
		const branch = doc.createElement("span");
		branch.className = "pt-branch";
		branch.textContent = project.facts.branch;
		meta.appendChild(branch);
	}
	if (project.facts.dirtyCount > 0) {
		const dirty = doc.createElement("span");
		dirty.className = "pt-dirty";
		dirty.textContent = `${project.facts.dirtyCount} dirty`;
		meta.appendChild(dirty);
	}
	const age = doc.createElement("span");
	age.className = "pt-age";
	age.textContent = relativeAge(project.facts.lastCommit, now);
	meta.appendChild(age);

// After the facts, so the eye reads what the repo is before what is wrong with it.
		// Empty for a healthy repo, which is every row most of the time.
	appendHealthBadges(meta, project.health);

	// Off unless asked for, and once per row rather than per score: the tooltip is always
		// there, this is for reading without hovering anything.
	if (explainScores) main.appendChild(createWhyLine(doc, project.score));

	const right = doc.createElement("div");
	right.className = "pt-right";
	row.appendChild(right);
	right.appendChild(createPinSlot(doc, pinned ? project.pin : null));
	right.appendChild(createOpenControl(doc, options.editorLabel, () => options.onOpenEditor(project)));
	right.appendChild(createSummaryControl(doc, project, summarizing, () => options.onRunSummary(project)));
	right.appendChild(createScoreSlot(doc, project.score));

	row.addEventListener("contextmenu", (event) => {
		event.preventDefault();
		options.onContextMenu(event, project);
	});
	return row;
}


/**
 * The AI summary control for one row.
 *
 * Three states, and the difference between them is the point of the whole feature: nothing
 * generated, something generated and current, and something generated that the repo has
 * since moved past. A stale summary reads as authoritative while being wrong, so it gets its
 * own wording and a warning colour rather than sharing a button with the current case.
 */
export function createSummaryControl(
	doc: Document,
	project: Project,
	running: boolean,
	onRun: () => void,
): HTMLElement {
	const summary = project.summary;
	const label = running ? "…" : !summary ? "AI" : summary.stale ? "stale" : "AI";

	const button = doc.createElement("button");
	button.className = ["pt-btn", "pt-ai", summary?.stale ? "is-stale" : "", !summary ? "is-none" : ""]
		.filter(Boolean)
		.join(" ");
	button.setAttribute("type", "button");
	button.textContent = label;
	button.disabled = running;

	let title = summary
		? `Regenerate AI summary (written ${summary.generatedAt ?? "at an unknown time"} from ${summary.commit ?? "no commit"})`
		: "Generate an AI summary from git history";
	if (summary?.stale) {
		title = `Regenerate AI summary. This one is out of date: ${summary.staleReason}`;
	}
	button.setAttribute("aria-label", title);
	button.setAttribute("title", title);
	button.addEventListener("click", (event) => {
		event.stopPropagation();
		onRun();
	});

	return button;
}

/**
 * The button that hands the repo folder to the editor. An icon rather than text, because
 * every row carries one and the panel is a list, not a form.
 */
export function createOpenControl(doc: Document, label: string, onOpen: () => void): HTMLElement {
	const button = doc.createElement("button");
	button.className = "pt-btn pt-open";
	button.setAttribute("type", "button");
	button.setAttribute("aria-label", label);
	button.setAttribute("title", label);
	setIcon(button, "folder-open");
	button.addEventListener("click", (event) => {
		event.stopPropagation();
		onOpen();
	});
	return button;
}

/**
 * The score, in its own slot, as a bare number.
 *
 * The word `score` used to sit beside it, because two of these projects were reported as
 * having "it" and nobody could tell what. The pin rank carries a `#` and this is the only
 * bare number on the row, so one marker tells them apart, and a word here would be a width
 * the row cannot give up when the sidebar narrows. What the number is made of stays on the
 * tooltip and the `Why` line, and both come from `parts`, so neither can describe a
 * different score than the number beside it.
 */
export function createScoreSlot(doc: Document, score: ScoreResult): HTMLElement {
	const slot = doc.createElement("span");
	slot.className = "pt-slot pt-slot-score";

	const value = doc.createElement("span");
	value.className = "pt-slot-value";
	value.textContent = String(score.score);
	slot.appendChild(value);

	const label = describeScore(score);
	slot.setAttribute("aria-label", label);
	slot.setAttribute("title", label);
	return slot;
}

/**
 * The user's pin rank, in a slot of its own. Rendered whether or not the project is pinned,
 * so the score does not slide sideways when a project is pinned. That was the collision: pin
 * rank and score shared one position, with nothing on the row to say which was which.
 */
export function createPinSlot(doc: Document, pin: number | null): HTMLElement {
	const slot = doc.createElement("span");
	slot.className = "pt-slot pt-slot-pin";
	if (pin === null) return slot;

	const value = doc.createElement("span");
	slot.appendChild(value);
	value.className = "pt-slot-value";
	value.textContent = `#${pin}`;
	slot.setAttribute("aria-label", `Pinned at rank ${pin}`);
	slot.setAttribute("title", `Pinned at rank ${pin}`);
	return slot;
}

/**
 * One compact word per firing health signal, with the explanation on hover. Appended to the
 * row's fact line rather than given a line of its own, and never given a number: see the
 * note in `src/health.ts`.
 */
export function appendHealthBadges(host: HTMLElement, signals: HealthSignal[]): void {
	const doc = host.ownerDocument;
	for (const signal of signals) {
		const badge = doc.createElement("span");
		badge.className = `pt-warn is-${signal.id}`;
		badge.textContent = signal.badge;
		badge.setAttribute("aria-label", signal.detail);
		badge.setAttribute("title", signal.detail);
		host.appendChild(badge);
	}
}

/**
 * The "why this score" line. Same sentence as the tooltip, on purpose: a second wording for
 * the same score is how two explanations of a number start disagreeing.
 */
export function createWhyLine(doc: Document, score: ScoreResult): HTMLElement {
	const line = doc.createElement("div");
	line.className = "pt-why";
	line.textContent = describeScore(score);
	return line;
}