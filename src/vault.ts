import { App, TFile, TFolder, normalizePath } from "obsidian";
import { applyFrontmatterPatch, desiredFrontmatter, diffManaged } from "./frontmatter";
import { spawnSync } from "child_process";
import { aiNotePath, sanitizeBase, stateFromFrontmatter, SummaryFrontmatter } from "./summary";
import { PluginSettings, Project, ProjectFrontmatter, RepoFacts, ScoreResult, SummaryState } from "./types";

/** Map a project name to a safe note filename. */
export function noteFileName(projectName: string): string {
	return `${sanitizeBase(projectName) || "untitled"}.md`;
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
 * Every existing project note's managed frontmatter, keyed by project name. One walk of the
 * notes folder, shared by the readers below. A project with no note is simply absent, which is
 * the normal case for anything the user never touched.
 */
function readNoteFrontmatter(app: App, settings: PluginSettings): Map<string, ProjectFrontmatter> {
	const notes = new Map<string, ProjectFrontmatter>();
	const folder = app.vault.getAbstractFileByPath(normalizePath(settings.notesFolder));
	if (!(folder instanceof TFolder)) return notes;

	for (const child of folder.children) {
		if (!(child instanceof TFile) || child.extension !== "md") continue;
		const fm = app.metadataCache.getFileCache(child)?.frontmatter as ProjectFrontmatter | undefined;
		if (!fm) continue;
		notes.set(typeof fm.project === "string" ? fm.project : child.basename, fm);
	}
	return notes;
}

/**
 * Read the user's pin rank from every existing project note. A project with no note, or a note
 * with no numeric `pinned`, is absent from the map and treated as unpinned.
 */
export async function readPins(app: App, settings: PluginSettings): Promise<Map<string, number>> {
	const pins = new Map<string, number>();
	for (const [name, fm] of readNoteFrontmatter(app, settings)) {
		const pinned = Number(fm.pinned);
		if (Number.isFinite(pinned) && pinned > 0) pins.set(name, pinned);
	}
	return pins;
}

/**
 * Read the dirty file count each project had at the previous scan. `dirty` is written on every
 * scan, so this is the memory the "sustained dirty" warning reads instead of a history file of
 * its own. Absent means "no history", which the warning treats as nothing to say.
 *
 * Must be read before `syncAllNotes` runs in the same scan, or it reads the value this scan
 * just wrote and every repo looks like it has been dirty for a while. `main.refresh` orders
 * the two for exactly that reason.
 */
export async function readPreviousDirty(app: App, settings: PluginSettings): Promise<Map<string, number>> {
	const counts = new Map<string, number>();
	for (const [name, fm] of readNoteFrontmatter(app, settings)) {
		const dirty = Number(fm.dirty);
		if (Number.isFinite(dirty)) counts.set(name, dirty);
	}
	return counts;
}

/**
 * Create or update one project's note.
 *
 * Only the managed frontmatter keys are written. The body is never read, rewritten or removed:
 * `processFrontMatter` rewrites the YAML block in place and leaves every byte after the
 * closing delimiter untouched.
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
 * Write one project's pin into its note, and nothing else.
 *
 * Exists because `syncProjectNote` recomputes every managed key, and one of them cannot be
 * recomputed the same way twice: `last_commit_rel` is an age measured against `Date.now()`,
 * so a pin written five minutes after the scan computes a different string than the scan
 * did and rewrites the key. Pinning one project used to quietly restate how old its last
 * commit was.
 *
 * So the pin write patches `pinned` alone. Everything else is left for the next scan, which
 * is the thing that owns it. A project with no note yet still gets a whole one written,
 * because there is nothing to patch and a created note has to be complete.
 */
export async function writePin(app: App, settings: PluginSettings, project: Project): Promise<string | null> {
	await ensureFolder(app, settings.notesFolder);
	const target = notePath(settings, project.facts.name);
	const existing = app.vault.getAbstractFileByPath(target);

	// No note yet: create it whole, so every key the plugin manages exists from the start.
	if (!(existing instanceof TFile)) {
		return syncProjectNote(app, settings, project.facts, project.score, project.pin);
	}

	try {
		await app.fileManager.processFrontMatter(existing, (fm) => {
			// Written rather than routed through `diffManaged`, whose whole job is comparing a freshly
			// computed set of keys against the note. Here there is one key and one value, and the
			// value is not computed at all.
			(fm as Record<string, unknown>).pinned = project.pin > 0 ? project.pin : 0;
		});
	} catch {
		return null;
	}
	return target;
}

/**
 * Write a batch of notes sequentially. Sequential rather than parallel on purpose:
 * `processFrontMatter` reads and rewrites the same files Obsidian is tracking, and interleaved
 * writes against one vault produce flaky results.
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

/**
 * Write one AI summary note, replacing whatever was there. The whole file is replaced rather
 * than merged, because a summary note holds only machine output and a freshness stamp.
 * Nothing the user could have written in it survives regeneration, and that is intended: the
 * note is a cache of a model call, not a document. The project note is never a target here.
 */
export async function writeSummaryNote(
	app: App,
	settings: PluginSettings,
	projectName: string,
	content: string,
): Promise<string | null> {
	await ensureFolder(app, settings.notesFolder);
	const target = aiNotePath(settings, projectName);
	const existing = app.vault.getAbstractFileByPath(target);

	try {
		if (existing instanceof TFile) await app.vault.modify(existing, content);
		else await app.vault.create(target, content);
	} catch {
		return null;
	}
	return target;
}

/** Short HEAD sha for a repo, used to judge whether a summary has gone stale. */
function headSha(repoPath: string): string | null {
	const res = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
		cwd: repoPath,
		encoding: "utf8",
		windowsHide: true,
	});
	if (res.error || res.status !== 0) return null;
	return res.stdout.trim() || null;
}

/**
 * Read every existing summary note's state back out of frontmatter. Reads only, and only for
 * notes that already exist. The 45 notes this plugin could generate do not get generated here:
 * a project with no summary is absent from the map, and the panel shows that as "none".
 */
export async function readSummaryStates(
	app: App,
	settings: PluginSettings,
	projects: Project[],
): Promise<Map<string, SummaryState>> {
	const states = new Map<string, SummaryState>();

	for (const project of projects) {
		const path = aiNotePath(settings, project.facts.name);
		const file = app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) continue;

		const fm = app.metadataCache.getFileCache(file)?.frontmatter as SummaryFrontmatter | undefined;
		const state = stateFromFrontmatter(fm, path, project.facts, headSha(project.facts.path));
		if (state) states.set(project.facts.name, state);
	}

	return states;
}