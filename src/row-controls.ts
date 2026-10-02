/**
 * The widgets one project row is made of.
 *
 * Out of `view.ts` because the row grew past the point where the state and the
 * markup were in the same function: the view decides what happens, this builds
 * the elements and hands back the click handlers as callbacks.
 *
 * The labelling contract is the same everywhere in here, and it is the same one
 * the summary control already used: a control that acts gets its full wording on
 * both `aria-label` and `title`, so the explanation is reachable by keyboard and
 * readable on hover.
 *
 * Plain `createElement` and `textContent` throughout rather than Obsidian's
 * `createSpan`/`setText` prototype helpers. The helpers are nicer, but they only
 * exist once Obsidian has patched the DOM, and a row that throws while drawing
 * leaves an empty panel with a stack trace nobody sees.
 */
import { setIcon } from "obsidian";
import { describeScore } from "./rank";
import type { HealthSignal, Project, ScoreResult } from "./types";

/**
 * The AI summary control for one row.
 *
 * Three states, and the difference between them is the point of the whole
 * feature: nothing generated, something generated and current, and something
 * generated that the repo has since moved past. A stale summary is the one that
 * reads as authoritative while being wrong, so it gets its own wording and a
 * warning colour rather than sharing a button with the current case.
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
 * The button that hands the repo folder to the editor.
 *
 * An icon rather than text, because every row carries one and the panel is a
 * list, not a form.
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
 * The score, in its own slot, saying what it is.
 *
 * The word `score` is on the row rather than only in the tooltip because two of
 * these projects were reported as having "it" and nobody could tell what. The
 * breakdown comes from `parts`, so the tooltip cannot describe a different score
 * than the number beside it.
 */
export function createScoreSlot(doc: Document, score: ScoreResult): HTMLElement {
	const slot = doc.createElement("span");
	slot.className = "pt-slot pt-slot-score";

	const tag = doc.createElement("span");
	tag.className = "pt-slot-tag";
	tag.textContent = "score";
	slot.appendChild(tag);

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
 * The user's pin rank, in a slot of its own.
 *
 * Rendered whether or not the project is pinned, so the score does not slide
 * sideways when a project is pinned. That was the collision: pin rank and score
 * shared one position, with nothing on the row to say which was which.
 */
export function createPinSlot(doc: Document, pin: number | null): HTMLElement {
	const slot = doc.createElement("span");
	slot.className = "pt-slot pt-slot-pin";
	if (pin === null) return slot;

	const tag = doc.createElement("span");
	tag.className = "pt-slot-tag";
	tag.textContent = "pin";
	slot.appendChild(tag);

	const value = doc.createElement("span");
	slot.appendChild(value);
	value.className = "pt-slot-value";
	value.textContent = `#${pin}`;
	slot.setAttribute("aria-label", `Pinned at rank ${pin}`);
	slot.setAttribute("title", `Pinned at rank ${pin}`);
	return slot;
}

/**
 * One compact word per firing health signal, with the explanation on hover.
 *
 * Appended to the row's fact line rather than given a line of its own, and never
 * given a number: see the note in `src/health.ts`.
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
 * The "why this score" line.
 *
 * Same sentence as the tooltip, on purpose: a second wording for the same score
 * is how two explanations of a number start disagreeing.
 */
export function createWhyLine(doc: Document, score: ScoreResult): HTMLElement {
	const line = doc.createElement("div");
	line.className = "pt-why";
	line.textContent = describeScore(score);
	return line;
}