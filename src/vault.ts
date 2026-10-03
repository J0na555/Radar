import { App, TFile, TFolder, normalizePath } from "obsidian";
import { spawnSync } from "child_process";
import { assertSafeTarget, dashboardPath, renderDashboard } from "./dashboard";
import type { NoteCandidate } from "./note-link";
import { stateFromRecord } from "./machine-state";
import type { LegacyNoteState, LegacySummaryFrontmatter } from "./machine-state";
import { PluginSettings, Project, ProjectFrontmatter, RepoFacts, SummaryState } from "./types";

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
 * Every folder in the vault, for the notes-folder dropdown.
 *
 * Walked rather than read off `getAllFolderPaths`, which exists but is not in every Obsidian
 * version this plugin supports, and a settings tab that throws on an older app is worse than a
 * slower list.
 */
export function listVaultFolders(app: App): string[] {
	const root = app.vault.getRoot();
	const found: string[] = [];
	const walk = (folder: TFolder): void => {
		for (const child of folder.children) {
			if (!(child instanceof TFolder)) continue;
			found.push(child.path);
			walk(child);
		}
	};
	walk(root);
	return found;
}

/**
 * Every note in the vault that could belong to a project, for `resolveProjectNote` to choose from.
 *
 * The whole vault is searched rather than the notes folder, because the notes folder is now the
 * dashboard's home and a project note is wherever the user keeps their notes. A project's own
 * project note is what that folder used to hold, so somebody upgrading has 45 notes in there and
 * will keep adding new ones wherever they write them.
 *
 * The dashboard is excluded. A repository named `Dashboard` would otherwise resolve to the
 * dashboard as its own project note and link to itself, and the plugin's one file is not a
 * document about any one project.
 */
export function readNoteCandidates(app: App, settings: PluginSettings): NoteCandidate[] {
	const dashboard = dashboardPath(settings);
	const candidates: NoteCandidate[] = [];
	for (const file of app.vault.getMarkdownFiles()) {
		if (file.path === dashboard) continue;
		// `tracked` has two forms and only one of them is a boolean. `tracked: true` promotes the
		// note for the project it is named after; `tracked: api-ai` binds it to that project
		// whatever it is called. A string is therefore never read as a flag: `tracked: "yes"` in a
		// note somebody wrote is a claim about a project called "yes".
		const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter as
			| { tracked?: unknown }
			| undefined;
		const raw = frontmatter?.tracked;
		const tracks = typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
		candidates.push({
			path: file.path,
			basename: file.basename,
			tracked: raw === true,
			tracks: tracks === "true" ? null : tracks,
		});
	}
	return candidates;
}

/**
 * Write the dashboard: the project table inside its markers, and nothing else.
 *
 * Reads before writing so a scan that changes nothing does not modify the file. The dashboard
 * sits in the user's vault next to their own notes, and a plugin that rewrites an identical file
 * every 30 seconds shows up as a change in whatever syncs that vault.
 *
 * A failure here is not worth a notice. The panel already has everything it shows; this file is a
 * view of the same data, and a vault that cannot be written is the user's problem to see in
 * Obsidian's own terms.
 */
export async function syncDashboard(
	app: App,
	settings: PluginSettings,
	projects: Project[],
	now: number = Date.now(),
): Promise<string | null> {
	const target = dashboardPath(settings);
	assertSafeTarget(settings, target);
	await ensureFolder(app, settings.notesFolder);

	const existing = app.vault.getAbstractFileByPath(target);
	let doc: string | null = null;
	if (existing instanceof TFile) {
		try {
			doc = await app.vault.read(existing);
		} catch {
			return null;
		}
	}

	let content: string;
	try {
		content = renderDashboard(doc ?? "", projects, now);
	} catch {
		// A generated body carrying a marker would break the section structure the next write
		// depends on. Refusing the write keeps the note intact; the panel is unaffected.
		return null;
	}

	return writeDashboard(app, settings, content, doc);
}

/**
 * Write specific content to the dashboard.
 *
 * `previous` is what was read, or null when the file does not exist, and is only there so the
 * write can be skipped when nothing changed. Two callers: the scan, and summary generation.
 */
export async function writeDashboard(
	app: App,
	settings: PluginSettings,
	content: string,
	previous: string | null,
): Promise<string | null> {
	const target = dashboardPath(settings);
	assertSafeTarget(settings, target);
	const existing = app.vault.getAbstractFileByPath(target);

	if (existing instanceof TFile) {
		if (previous === content) return target;
		try {
			await app.vault.modify(existing, content);
		} catch {
			return null;
		}
		return target;
	}

	try {
		await app.vault.create(target, content);
	} catch {
		return null;
	}
	return target;
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