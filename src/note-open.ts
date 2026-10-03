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
 * Open the note this project has.
 *
 * The plugin does not create notes any more, so "no note" is the normal state for anything
 * the user has not written one for, and the notice says how to change that. It used to say
 * "run a refresh first", which stopped being true the moment notes stopped being generated:
 * a refresh cannot produce a note the user has not written.
 *
 * `null` means there is nothing to open, which happens when the list is empty or the filter
 * hides everything. That is a no-op rather than a complaint, because the same call serves both
 * "Enter on the selected row" and "Enter in the search box", and a keystroke on an empty list
 * is not a mistake worth a notice.
 */
export async function openProjectNote(app: App, project: Project | null): Promise<void> {
	if (!project) return;
	const file = project.notePath ? app.vault.getAbstractFileByPath(project.notePath) : null;
	if (file instanceof TFile) {
		await app.workspace.getLeaf(false).openFile(file);
		return;
	}
	new Notice(
		`Project Tracker: no note for ${project.facts.name}. Write one named ${project.facts.name}.md, or put tracked: true in its frontmatter, and it will be linked from the dashboard.`,
	);
}

/**
 * Open the note holding one project's AI summary.
 *
 * `target` is where the summaries live, passed in rather than read off the state: freshness
 * no longer knows where its own text is, and a field that named a file would be naming one
 * that a user can rename or delete at any time. The caller resolves it once, so there is a
 * single answer to "where the summaries are" even after they move.
 */
export async function openSummaryNote(app: App, project: Project, target: string): Promise<void> {
	if (!project.summary) return;
	const file = app.vault.getAbstractFileByPath(target);
	if (file instanceof TFile) {
		await app.workspace.getLeaf(false).openFile(file);
		return;
	}
	new Notice(`Project Tracker: ${target} is not in the vault any more. Regenerate the summary to write it.`);
}
