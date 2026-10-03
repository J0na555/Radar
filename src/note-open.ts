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
		`Project Tracker: no note for ${project.facts.name}. Write one named ${project.facts.name}.md anywhere in the vault, or put "tracked: ${project.facts.name}" in a note's frontmatter, and it will be linked from the dashboard.`,
	);
}

/**
 * Open the note holding one project's AI summary.
 *
 * Every summary is in one file now, so the target is the dashboard rather than anything derived
 * from the project. It is still passed in rather than read off the project: the summary state
 * knows what a summary was generated from and not where its text lives, and a field naming a
 * file would be naming one the user can rename or delete at any time.
 *
 * A project with no summary is a no-op. There is nothing to open and nothing is wrong, and the
 * same keystroke reaches this from the panel and from the search box.
 */
export async function openSummaryNote(app: App, project: Project, target: string): Promise<void> {
	if (!project.summary) return;
	const file = app.vault.getAbstractFileByPath(target);
	if (file instanceof TFile) {
		await app.workspace.getLeaf(false).openFile(file);
		return;
	}
	new Notice(
		`Project Tracker: ${target} is not in the vault. It is the dashboard, which the plugin creates on the next scan; generate the summary again after a refresh.`,
	);
}
