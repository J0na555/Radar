import { App, TFile, TFolder, normalizePath } from "obsidian";
import { PluginSettings, ProjectFrontmatter, RepoFacts, ScoreResult } from "./types";

/** Keys this plugin owns. Anything else in the frontmatter is the user's. */
const MANAGED_KEYS = [
	"project",
	"repo_path",
	"remote",
	"github",
	"pinned",
	"last_commit",
	"dirty",
	"branch",
	"score",
	"status",
] as const;

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

/** The managed keys we want to write for a project, right now. */
export function desiredFrontmatter(
	facts: RepoFacts,
	score: ScoreResult,
	pin: number,
): ProjectFrontmatter {
	return {
		project: facts.name,
		repo_path: facts.path,
		remote: facts.remote ?? undefined,
		github: facts.github ?? undefined,
		// Always written, including 0. Skipping the key when unpinned would leave a
		// stale rank on disk forever, because unpinning only changes it to 0.
		pinned: pin > 0 ? pin : 0,
		last_commit: facts.lastCommit ?? undefined,
		dirty: facts.dirtyCount,
		branch: facts.branch ?? undefined,
		score: score.score,
		status: score.status,
	};
}

/**
 * Compare managed keys between what's on disk and what we want.
 * Returns the drifted keys only, so unchanged notes are never rewritten.
 */
export function diffManaged(current: ProjectFrontmatter, desired: ProjectFrontmatter): Partial<ProjectFrontmatter> {
	const patch: Record<string, unknown> = {};
	const source = current as Record<string, unknown>;

	for (const key of MANAGED_KEYS) {
		const want = (desired as Record<string, unknown>)[key];
		const have = source[key];
		if (want === undefined) continue; // Leave absent keys alone rather than clobbering.
		if (have === want) continue;
		patch[key] = want;
	}
	return patch as Partial<ProjectFrontmatter>;
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
): Promise<string | null> {
	await ensureFolder(app, settings.notesFolder);
	const target = notePath(settings, facts.name);
	const desired = desiredFrontmatter(facts, score, pin);
	const existing = app.vault.getAbstractFileByPath(target);

	if (existing instanceof TFile) {
		try {
			await app.fileManager.processFrontMatter(existing, (fm) => {
				const patch = diffManaged(fm as ProjectFrontmatter, desired);
				Object.assign(fm, patch);
			});
		} catch {
			return null;
		}
		return target;
	}

	const lines = Object.entries(desired)
		.filter(([, value]) => value !== undefined)
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
): Promise<Map<string, string>> {
	const written = new Map<string, string>();
	for (const entry of entries) {
		const path = await syncProjectNote(app, settings, entry.facts, entry.score, entry.pin);
		if (path) written.set(entry.facts.name, path);
	}
	return written;
}