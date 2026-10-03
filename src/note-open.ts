/**
 * Opening a project's note, or saying plainly why it could not be opened.
 *
 * Out of `view.ts` because this is vault I/O rather than panel state: it reads a
 * path off a project, finds the file, and either opens it or explains itself. Both
 * functions do the same shape of thing, and the explanations are the part worth
 * keeping in one place: a click that does nothing is the failure users cannot act
 * on, so every path that fails says what is missing and what to do about it.
 */
import { Notice, TFile } from "obsidian";
import type { App } from "obsidian";
import type { Project } from "./types";

/**
 * Open the note this plugin keeps for a project.
 *
 * A project with no note is a normal state rather than an error: notes are created
 * by the scan, so a project the user just added is briefly without one.
 *
 * `null` means there is nothing to open, which happens when the list is empty or
 * the filter hides everything. It is a no-op rather than a complaint, because the
 * same call serves both "Enter on the selected row" and "Enter in the search box",
 * and a keystroke on an empty list is not a mistake worth a notice.
 */
export async function openProjectNote(app: App, project: Project | null): Promise<void> {
	if (!project) return;
	const file = project.notePath ? app.vault.getAbstractFileByPath(project.notePath) : null;
	if (file instanceof TFile) {
		await app.workspace.getLeaf(false).openFile(file);
		return;
	}
	new Notice(`Project Tracker: no note yet for ${project.facts.name}. Run a refresh first.`);
}

/**
 * Open a project's AI summary note.
 *
 * Separate from the project note because the summary is a cache of a model call
 * that a regeneration replaces, and it can be gone for a reason that has nothing to
 * do with the project: it was deleted, or it was moved.
 */
export async function openSummaryNote(app: App, project: Project): Promise<void> {
	const summary = project.summary;
	if (!summary) return;
	const file = app.vault.getAbstractFileByPath(summary.path);
	if (file instanceof TFile) {
		await app.workspace.getLeaf(false).openFile(file);
		return;
	}
	new Notice(`Project Tracker: ${summary.path} is not in the vault any more. Regenerate it.`);
}
