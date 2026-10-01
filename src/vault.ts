import { App, TFile, TFolder, normalizePath } from "obsidian";
import { applyFrontmatterPatch, desiredFrontmatter, diffManaged } from "./frontmatter";
import { PluginSettings, ProjectFrontmatter, RepoFacts, ScoreResult } from "./types";

/** Map a project name to a safe note filename. */
export function noteFileName(projectName: string): string {
	const safe = projectName
		.replace(/[\\/:*?"<>|]/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "")
		.trim();
	return `${safe || "untitled"}.md`;
}

/** Absolute vault-relative path of a project's note. */
export function notePath(settings: PluginSettings, projectName: string): string {
	return normalizePath(`${settings.notesFolder}/${noteFileName(projectName)}`);
}

/** Create `folder` and any missing parents. No-op when it already exists. */
export async function ensureFolder(app: App, folder: string): Promise<void> {
	const parts = normalizePath(folder).split("/").filter(Boolean);
	let current = "";
	for (const part of parts) {
		current = current ? `${current}/${part}` : part;
		if (!app.vault.getAbstractFileByPath(current)) {
			try {
				await app.vault.createFolder(current);
			} catch {
				// Lost a race with another writer; the folder existing is what matters.
			}
		}
	}
}

/**
 * Read the user's pin rank from every existing project note.
 *
 * Returns a map of project name to pin. A project with no note, or a note with
 * no numeric `pinned`, is absent from the map and treated as unpinned.
 */
export async function readPins(app: App, settings: PluginSettings): Promise<Map<string, number>> {
	const pins = new Map<string, number>();
	const folder = app.vault.getAbstractFileByPath(normalizePath(settings.notesFolder));
	if (!(folder instanceof TFolder)) return pins;

	for (const child of folder.children) {
		if (!(child instanceof TFile) || child.extension !== "md") continue;
		const cache = app.metadataCache.getFileCache(child);
		const fm = cache?.frontmatter as ProjectFrontmatter | undefined;
		if (!fm) continue;
		const name = typeof fm.project === "string" ? fm.project : child.basename;
		const pinned = Number(fm.pinned);
		if (Number.isFinite(pinned) && pinned > 0) pins.set(name, pinned);
	}
	return pins;
}

/**
 * Create or update one project's note.
 *
 * Only the managed frontmatter keys are written. The body is never read,
 * rewritten, or removed: `processFrontMatter` rewrites the YAML block in place
 * and leaves every byte after the closing delimiter untouched.
 *
 * Returns the note path, or null when the note could not be written.
 */
export async function syncProjectNote(
	app: App,
	settings: PluginSettings,
	facts: RepoFacts,
	score: ScoreResult,
	pin: number,
	now: number = Date.now(),
): Promise<string | null> {
	await ensureFolder(app, settings.notesFolder);
	const target = notePath(settings, facts.name);
	const desired = desiredFrontmatter(facts, score, pin, now);
	const existing = app.vault.getAbstractFileByPath(target);

	if (existing instanceof TFile) {
		try {
			await app.fileManager.processFrontMatter(existing, (fm) => {
				const patch = diffManaged(fm as ProjectFrontmatter, desired);
				applyFrontmatterPatch(fm as Record<string, unknown>, patch);
			});
		} catch {
			return null;
		}
		return target;
	}

	const lines = Object.entries(desired)
		.filter(([, value]) => value !== undefined && value !== null)
		.map(([key, value]) => `${key}: ${JSON.stringify(value)}`);

	const body = [
		"---",
		...lines,
		"---",
		"",
		`# ${facts.name}`,
		"",
		"Notes for this project go here. The dashboard manages the frontmatter above and never touches this body.",
		"",
	].join("\n");

	try {
		await app.vault.create(target, body);
	} catch {
		return null;
	}
	return target;
}

/**
 * Write a batch of notes sequentially.
 *
 * Sequential rather than parallel on purpose: `processFrontMatter` reads and
 * rewrites the same files Obsidian is tracking, and interleaved writes against
 * one vault produce flaky results.
 */
export async function syncAllNotes(
	app: App,
	settings: PluginSettings,
	entries: { facts: RepoFacts; score: ScoreResult; pin: number }[],
	now: number = Date.now(),
): Promise<Map<string, string>> {
	const written = new Map<string, string>();
	for (const entry of entries) {
		const path = await syncProjectNote(app, settings, entry.facts, entry.score, entry.pin, now);
		if (path) written.set(entry.facts.name, path);
	}
	return written;
}