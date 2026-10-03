import { App, TFile, TFolder, normalizePath } from "obsidian";
import { applyFrontmatterPatch, desiredFrontmatter, diffManaged } from "./frontmatter";
import { spawnSync } from "child_process";
import { stateFromRecord } from "./machine-state";
import type { LegacyNoteState, LegacySummaryFrontmatter } from "./machine-state";
import { aiNotePath, sanitizeBase } from "./summary";
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
 * Every legacy note's managed frontmatter, for the one-time state seed.
 *
 * Only ever called by the upgrade path, and only once. After the seed, this plugin never
 * reads `pinned` or `dirty` out of a note again: a note is a document the user owns, and
 * state that has to be right cannot live in one. See `applyLegacyNotes`.
 */
export function readLegacyNotes(app: App, settings: PluginSettings): LegacyNoteState[] {
	const notes: LegacyNoteState[] = [];
	const folder = app.vault.getAbstractFileByPath(normalizePath(settings.notesFolder));
	if (!(folder instanceof TFolder)) return notes;

	for (const child of folder.children) {
		if (!(child instanceof TFile) || child.extension !== "md") continue;
		// Read as both shapes at once because a note in this folder is one of two things: a
		// generated project note, or a generated summary note. Both were written by this plugin,
		// so either key set appearing without the other is a hand edit rather than a normal case.
		const fm = app.metadataCache.getFileCache(child)?.frontmatter as
			| (ProjectFrontmatter & LegacySummaryFrontmatter)
			| undefined;
		// The filename is the fallback rather than the primary key: a note whose `project` was
		// hand-edited away is still that project's note, and dropping it would lose a pin.
		const project = typeof fm?.project === "string" && fm.project !== "" ? fm.project : child.basename;
		notes.push({
			project,
			pinned: fm?.pinned,
			dirty: fm?.dirty,
			// Null unless the note says it is ours. A `commit` key in a hand-written note is
			// not a summary, and `stampFromLegacySummary` is what refuses it.
			summary: fm && fm.ai_generated === true ? fm : null,
		});
	}
	return notes;
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

/**
 * Short HEAD sha for a repo, used to judge whether a summary has gone stale.
 *
 * Exported because staleness is now a comparison between data.json and the repo, and this is
 * the other half of it. One `rev-parse` per project, exactly as before.
 */
export function headSha(repoPath: string): string | null {
	const res = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
		cwd: repoPath,
		encoding: "utf8",
		windowsHide: true,
	});
	if (res.error || res.status !== 0) return null;
	return res.stdout.trim() || null;
}

/**
 * Rebuild every project's summary state from machine state, comparing each against the repo
 * as it is now.
 *
 * Reads data.json, not notes. Freshness used to be the summary note's frontmatter, which put
 * the answer to "is this out of date" in a file whose whole purpose was to hold the thing
 * being judged. A project with no record is absent from the map, and the panel shows that as
 * "none", which is the normal case: summaries are made on request.
 *
 * `head` is injected rather than called here so this stays a lookup and a comparison. The git
 * call behind it is one `rev-parse` per project, the same one the old reader made.
 */
export function readSummaryStates(
	settings: PluginSettings,
	projects: Project[],
	head: (facts: RepoFacts) => string | null,
): Map<string, SummaryState> {
	const states = new Map<string, SummaryState>();
	const records = settings.state.summaries;

	for (const project of projects) {
		const record = records[project.facts.name];
		if (!record) continue;
		states.set(project.facts.name, stateFromRecord(record, project.facts, head(project.facts)));
	}

	return states;
}