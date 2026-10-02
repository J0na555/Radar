/**
 * The summary note: where it lives, what marks it as machine-written, and when
 * it has gone stale.
 *
 * Explicit `.ts` extensions and no `obsidian` import, so `node --test` loads it
 * directly.
 */
import { normalizePath } from "./obsidian-compat.ts";
import type { PluginSettings, RepoFacts, SummaryState } from "./types.ts";

/** Suffix distinguishing a generated note from the user's own. */
export const AI_SUFFIX = "-ai";

/** Frontmatter keys the plugin owns in a summary note. */
export interface SummaryFrontmatter {
	project?: string;
	repo_path?: string;
	/** Always true. The marker that makes this file findable and suspicious. */
	ai_generated?: boolean;
	/** ISO 8601 time the summary was written. */
	generated_at?: string;
	/** Short commit SHA the summary was generated from. */
	commit?: string | null;
	/** Whether the working tree was dirty when it was written. */
	dirty?: boolean;
	/** Uncommitted file count when it was written. */
	dirty_count?: number;
	/** Which CLI produced it. */
	provider?: string;
}

/**
 * Filename of a project's AI summary note: `<name>-ai.md`.
 *
 * Sanitised through the same rules as the project note, so an awkward directory
 * name produces a legal filename and the two stay recognisably siblings.
 */
export function aiNoteFileName(projectName: string): string {
	const base = sanitizeBase(projectName);
	return `${base || "untitled"}${AI_SUFFIX}.md`;
}

/** Vault path of a project's summary note, beside its project note. */
export function aiNotePath(settings: PluginSettings, projectName: string): string {
	return normalizePath(`${settings.notesFolder}/${aiNoteFileName(projectName)}`);
}

/** The project note's own path, for the collision check. */
export function projectNotePath(settings: PluginSettings, projectName: string): string {
	const base = sanitizeBase(projectName);
	return normalizePath(`${settings.notesFolder}/${base || "untitled"}.md`);
}

/**
 * A summary path can never be a project note path.
 *
 * `sanitizeBase` strips the characters a path separator needs, so a name can
 * never escape the folder or produce a `.md` that reads as something else. The
 * suffix is appended after sanitising, which is what keeps the two from
 * colliding, including for a project literally named `foo-ai` whose own summary
 * becomes `foo-ai-ai.md`.
 */
export function sanitizeBase(name: string): string {
	return name
		.replace(/[\\/:*?"<>|]/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "")
		.trim();
}

/**
 * Throw unless `summaryPath` is a safe target: inside the notes folder, and not
 * the project note itself.
 *
 * Cheap to be paranoid about. This is the one function standing between a
 * generated write and a user's own note, so it re-derives both paths and
 * compares, rather than trusting the caller to have picked the right one.
 */
export function assertSafeTarget(settings: PluginSettings, projectName: string, summaryPath: string): void {
	const folder = normalizePath(settings.notesFolder);
	if (!summaryPath.startsWith(`${folder}/`)) {
		throw new Error(`refusing to write outside ${folder}: ${summaryPath}`);
	}
	if (summaryPath === projectNotePath(settings, projectName)) {
		throw new Error(`refusing to write over the project note: ${summaryPath}`);
	}
}

/** The facts recorded so a reader can tell what the summary was looking at. */
export interface FreshnessStamp {
	/** ISO 8601 generation time. */
	generatedAt: string;
	/** Short commit SHA, or null for a repo with no commits. */
	commit: string | null;
	/** Uncommitted file count at generation time. */
	dirtyCount: number;
	/** Branch at generation time, for a human reading the note. */
	branch: string | null;
}

/** Build the stamp for a generation about to happen. */
export function computeStamp(facts: RepoFacts, now: number, head: string | null): FreshnessStamp {
	return {
		generatedAt: new Date(now).toISOString(),
		commit: head,
		dirtyCount: facts.dirtyCount,
		branch: facts.branch,
	};
}

/** Whether the working tree was dirty at generation time. */
export function wasDirty(stamp: FreshnessStamp): boolean {
	return stamp.dirtyCount > 0;
}

/** Why a summary no longer describes the repo, or "" when it still does. */
export interface StaleReason {
	stale: boolean;
	reason: string;
}

/**
 * Decide whether a stored stamp still describes the current repo.
 *
 * Two things count as movement: HEAD moving, and the set of uncommitted files
 * changing size. A summary of a clean tree that now has 12 dirty files is
 * describing a repository state that no longer exists, which is exactly the
 * failure mode a summary without this check invites.
 */
export function detectStale(stamp: FreshnessStamp, facts: RepoFacts, currentHead: string | null): StaleReason {
	if (stamp.commit === null || currentHead === null) {
		// A repo with no commits cannot be compared. Not knowing is not the same
		// as being out of date, so this is not reported as stale.
		return { stale: false, reason: "" };
	}
	if (stamp.commit !== currentHead) {
		return { stale: true, reason: `repo has moved since this summary (${stamp.commit} to ${currentHead})` };
	}
	if (stamp.dirtyCount !== facts.dirtyCount) {
		return {
			stale: true,
			reason: `uncommitted changes went from ${stamp.dirtyCount} to ${facts.dirtyCount} files`,
		};
	}
	return { stale: false, reason: "" };
}

/** Read a note's frontmatter keys back into a stamp. */
export function stampFromFrontmatter(fm: SummaryFrontmatter | undefined): FreshnessStamp | null {
	if (!fm || fm.ai_generated !== true) return null;
	const commit = typeof fm.commit === "string" && fm.commit.length > 0 ? fm.commit : null;
	const dirtyCount = typeof fm.dirty_count === "number" && Number.isFinite(fm.dirty_count) ? fm.dirty_count : 0;
	return {
		generatedAt: typeof fm.generated_at === "string" ? fm.generated_at : "",
		commit,
		dirtyCount,
		branch: null,
	};
}

/** Read a note's frontmatter back into the state the panel renders. */
export function stateFromFrontmatter(
	fm: SummaryFrontmatter | undefined,
	path: string,
	facts: RepoFacts,
	currentHead: string | null,
): SummaryState | null {
	const stamp = stampFromFrontmatter(fm);
	if (!stamp) return null;
	const { stale, reason } = detectStale(stamp, facts, currentHead);
	return {
		path,
		generatedAt: stamp.generatedAt || null,
		commit: stamp.commit,
		dirty: stamp.dirtyCount > 0,
		dirtyCount: stamp.dirtyCount,
		stale,
		staleReason: reason,
	};
}

/** The parsed model reply, ready to render. */
export interface SummaryBody {
	summary: string;
	nextSteps: string[];
}

/**
 * Render a summary note.
 *
 * The warning callout is first and fenced, because this file is the one place
 * where a reader can be actively misled: the prose below is confident and
 * plausible, and nothing in it would tell you it was written by a model from a
 * list of commit subjects. The stamp is stated again next to the body, not only
 * in frontmatter, so it is visible in a reading view where properties are
 * collapsed.
 *
 * Regeneration replaces the whole file. There is nothing here for the user to
 * keep, which is the point: the note is a cache of a model call, not a document.
 */
export function renderSummaryNote(options: {
	projectName: string;
	repoPath: string;
	stamp: FreshnessStamp;
	provider: string;
	body: SummaryBody;
}): string {
	const { projectName, repoPath, stamp, provider, body } = options;
	const dirtyNote = wasDirty(stamp)
		? `The working tree had ${stamp.dirtyCount} uncommitted file(s) at this point. Those changes are in no commit, so this summary describes work that exists nowhere in git history.`
		: "The working tree was clean at this point.";
	const commitNote = stamp.commit
		? `Commit \`${stamp.commit}\``
		: "No commit (the repository had no commits yet)";

	const lines: string[] = [];

	lines.push("---");
	lines.push(`project: ${JSON.stringify(projectName)}`);
	lines.push(`repo_path: ${JSON.stringify(repoPath)}`);
	lines.push("ai_generated: true");
	lines.push(`generated_at: ${JSON.stringify(stamp.generatedAt)}`);
	lines.push(`commit: ${stamp.commit === null ? "null" : JSON.stringify(stamp.commit)}`);
	lines.push(`dirty: ${wasDirty(stamp)}`);
	lines.push(`dirty_count: ${stamp.dirtyCount}`);
	lines.push(`provider: ${JSON.stringify(provider)}`);
	lines.push("---");
	lines.push("");
	lines.push("> [!warning] Machine-generated. Do not edit.");
	lines.push(`> This note was written by a language model (\`${provider}\`) from git metadata only.`);
	lines.push("> It is not your writing, it is not reviewed, and it can be wrong. The Project Tracker");
	lines.push("> plugin overwrites this file every time you regenerate the summary.");
	lines.push("");
	lines.push(`## ${projectName}`);
	lines.push("");
	lines.push(`Generated ${stamp.generatedAt} from ${commitNote} on branch \`${stamp.branch ?? "unknown"}\`.`);
	lines.push(dirtyNote);
	lines.push("");
	lines.push(`Source note: [[${projectName}]]`);
	lines.push("");
	lines.push("---");
	lines.push("");
	lines.push("## Summary");
	lines.push("");
	lines.push(body.summary);
	lines.push("");

	if (body.nextSteps.length > 0) {
		lines.push("## Suggested next steps");
		lines.push("");
		lines.push("Proposed by the model, not a to-do list you agreed to.");
		lines.push("");
		for (const step of body.nextSteps) lines.push(`- ${step}`);
		lines.push("");
	}

	return lines.join("\n");
}
