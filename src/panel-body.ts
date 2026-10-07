/**
 * The panel's rows: group headings and the projects under them.
 *
 * Out of `view.ts` to sit beside `panel-header.ts`, which owns the other half of
 * the panel's fixed furniture. Both are rebuilt-and-drawn code that takes what it
 * needs from the view and hands back elements; neither owns state.
 *
 * The rows are rebuilt on every render, unlike the header, and that is safe because
 * nothing is typing into them: the search box is in the header, and the only
 * focusable things in a row are its controls, which are disabled while their
 * summary is running anyway. What does not survive a rebuild is the scroll
 * position, because emptying a scrolling container clamps its scrollTop to zero.
 * Saving and restoring that is the view's job, not this one's.
 */
import { describeGroup, explainGroup } from "./filter.ts";
import type { FilterResult } from "./filter.ts";
import { createProjectRow } from "./row-controls.ts";
import type { Project } from "./types.ts";

/** What each row needs from the view, and where its index came from. */
export interface PanelBodyOptions {
	/** Which row the keyboard selection is on. */
	selectedIndex: number;
	/** True when anything is filtering, which changes how the headings count. */
	filtering: boolean;
	explainScores: boolean;
	/** Wording for the editor control, from `editorActionLabel`. */
	editorLabel: (project: Project) => string;
	/** One clock for every row, so ages on the same panel agree. */
	now: number;
	/** Project names with a summary in flight, so their control is disabled. */
	summarizing: ReadonlySet<string>;
	/** Put the keyboard selection on a row the user clicked. */
	onSelect: (index: number, project: Project) => void;
	onOpenNote: (project: Project) => void;
	onRunSummary: (project: Project) => void;
	onOpenEditor: (project: Project) => void;
	onContextMenu: (event: MouseEvent, project: Project) => void;
}

/**
 * Draw the whole list into `body`, replacing whatever was in it.
 *
 * Returns the row elements in display order, so the caller can scroll the selected
 * one into view without having to search the DOM for it.
 */
export function drawPanelBody(
	doc: Document,
	body: HTMLElement,
	result: FilterResult,
	options: PanelBodyOptions,
): HTMLElement[] {
	body.empty();
	const rowEls: HTMLElement[] = [];

	for (const group of result.groups) {
		const heading = doc.createElement("div");
		heading.className = "gd-group";
		heading.textContent = describeGroup(group, options.filtering);
		// What this group is hiding, on hover and for a screen reader. Empty when the
		// group is showing everything, in which case there is nothing to say.
		const explanation = explainGroup(group);
		if (explanation !== "") {
			heading.setAttribute("aria-label", explanation);
			heading.setAttribute("title", explanation);
		}
		body.appendChild(heading);

		for (const row of group.rows) {
			rowEls.push(drawRow(doc, body, rowEls.length, row, options));
		}
	}
	return rowEls;
}

function drawRow(
	doc: Document,
	body: HTMLElement,
	index: number,
	row: FilterResult["rows"][number],
	options: PanelBodyOptions,
): HTMLElement {
	const { project } = row;
	const el = createProjectRow(doc, {
		project,
		pinned: project.pin > 0,
		selected: index === options.selectedIndex,
		weak: row.weak,
		explainScores: options.explainScores,
		editorLabel: options.editorLabel(project),
		now: options.now,
		summarizing: options.summarizing.has(project.facts.name),
		// The index is this row's place in the visible list, which is what the selection
		// is an index into. Row order and selection order are the same order here
		// because every row comes out of `group.rows` in display order.
		onSelect: () => options.onSelect(index, project),
		onOpenNote: options.onOpenNote,
		onRunSummary: options.onRunSummary,
		onOpenEditor: options.onOpenEditor,
		onContextMenu: options.onContextMenu,
	});
	body.appendChild(el);
	return el;
}
