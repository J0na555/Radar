/**
 * The AI summary's judgement calls: what it was generated from, and whether that still
 * describes the repo.
 *
 * Where a summary is stored and rendered is not here any more. It used to be: a summary was a
 * whole file named after the project, rewritten every time, carrying the stamp in its
 * frontmatter. Now the dashboard holds one entry per project and data.json carries the stamp,
 * which leaves exactly the two questions that need a real answer, how old is this and is it
 * still true. Neither of them is about markdown.
 *
 * Explicit `.ts` extensions and no `obsidian` import, so `node --test` loads it
 * directly.
 */
import type { RepoFacts } from "./types.ts";

/**
 * Turn a directory name into something legal for a filename.
 *
 * Strips the characters a path separator needs, so a name can never escape the folder or
 * produce a `.md` that reads as something else. Also where a project's own note name comes
 * from, which is how a repository called `foo/bar` ends up linked to a note called `foo-bar`.
 */
export function sanitizeBase(name: string): string {
	return name
		.replace(/[\\/:*?"<>|]/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "")
		.trim();
}

/** The facts recorded so a reader can tell what the summary was looking at. */
export interface FreshnessStamp {
	/** ISO 8601 generation time. */
	generatedAt: string;
	/** Short commit SHA, or null for a repo with no commits. */
	commit: string | null;
	/** Uncommitted file count at generation time. */
	dirtyCount: number;
	/** Branch at generation time, for a human reading the entry. */
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

/**
 * Why a summary no longer describes the repo, or "" when it still does.
 *
 * `stamp` is the pair of fields this reads rather than a whole `FreshnessStamp`, so the same
 * comparison serves a record persisted in data.json and a stamp read off a note. One
 * question, one implementation, because two of those is how they start disagreeing about
 * whether a summary is out of date.
 */
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
export function detectStale(
	stamp: Pick<FreshnessStamp, "commit" | "dirtyCount">,
	facts: RepoFacts,
	currentHead: string | null,
): StaleReason {
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

/** The parsed model reply, ready to render. */
export interface SummaryBody {
	summary: string;
	nextSteps: string[];
}