/**
 * Git-only context for the model, and the prompt built from it.
 *
 * v0.1 sends git facts and nothing else. The user's other vault notes are never
 * read, never searched, and never sent anywhere. That is a deliberate limit
 * rather than a missing feature: a summary is only as trustworthy as the context
 * behind it, and a version that quietly starts reading the whole vault is a
 * different product with a different privacy story.
 *
 * Explicit `.ts` extensions and no `obsidian` import, so `node --test` loads it
 * directly.
 */
import { spawnSync } from "child_process";
import type { RepoFacts } from "./types.ts";

/** Bounds on what the plugin will read out of a repo for one prompt. */
export const COMMIT_COUNT_MIN = 1;
export const COMMIT_COUNT_MAX = 200;
export const COMMIT_COUNT_DEFAULT = 20;

/** One commit as the model sees it: a short sha and its subject, nothing else. */
export interface CommitLine {
	sha: string;
	subject: string;
}

/**
 * Everything the model is told about a project.
 *
 * `dirtyFiles` is a list of paths, never contents. Knowing that `src/main.ts` is
 * modified is what makes a summary useful; knowing what is inside it is the
 * user's business, and reading it would be sending the vault's contents to a
 * model provider.
 */
export interface GitContext {
	projectName: string;
	repoPath: string;
	branch: string | null;
	defaultBranch: string | null;
	onDefaultBranch: boolean;
	lastCommitDate: string | null;
	dirtyCount: number;
	dirtyFiles: string[];
	commits: CommitLine[];
	/** Short sha of HEAD, the anchor for the freshness stamp. */
	head: string | null;
	remote: string | null;
}

/** Run git and return trimmed stdout, or null when it fails. */
function git(cwd: string, args: string[]): string | null {
	const res = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
	if (res.error || res.status !== 0) return null;
	return res.stdout.trim();
}

/** Clamp a user-entered commit count into a range that cannot blow up a prompt. */
export function clampCommitCount(value: number): number {
	if (!Number.isFinite(value)) return COMMIT_COUNT_DEFAULT;
	return Math.min(COMMIT_COUNT_MAX, Math.max(COMMIT_COUNT_MIN, Math.floor(value)));
}

/** Clamp a timeout in seconds, in both directions. */
export function clampTimeoutSeconds(value: number): number {
	if (!Number.isFinite(value)) return 120;
	return Math.min(1800, Math.max(5, Math.floor(value)));
}

/**
 * Read the git facts a summary prompt is built from.
 *
 * Everything degrades to an empty value rather than throwing, matching
 * `readRepoFacts`: one odd repository should produce a thin prompt, not a stack
 * trace in the middle of the panel.
 */
export function buildGitContext(facts: RepoFacts, commitCount: number): GitContext {
	const count = clampCommitCount(commitCount);
	const repo = facts.path;

	const rawLog = git(repo, ["log", `-n${count}`, "--format=%h%x09%s"]);
	const commits: CommitLine[] = rawLog
		? rawLog
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.length > 0)
				.map((line) => {
					const tab = line.indexOf("\t");
					// A commit subject containing a tab would misparse, so fall back to
					// splitting on the first space and keep the whole remainder.
					return tab === -1
						? { sha: line.split(" ")[0], subject: line }
						: { sha: line.slice(0, tab), subject: line.slice(tab + 1) };
				})
		: [];

  const porcelain = git(repo, ["status", "--porcelain", "-z"]);
  const dirtyFiles = porcelain
    ? porcelain
        .split("\0")
        .filter((entry) => entry.length > 0)
        .map((entry) => {
          // With -z, git emits NUL-separated entries; the path starts at index 3
          // and is not quoted. Do not trim the entry to avoid stripping meaningful chars.
          if (entry.length < 3) return null;
          // With -z, the first two chars are status (or ??) and possibly a space char
          // in the third position for some formats? Standard is XY followed by space then path
          // or XY followed by path char for untracked? But we need to be precise
          let start = 2;
          if (entry.length >= 3 && entry[2] === ' ') {
            start = 3;
          }
          const rest = entry.slice(start);
          if (rest.length === 0) return null;
          const arrow = rest.lastIndexOf(" -> ");
          const value = arrow === -1 ? rest : rest.slice(arrow + 4);
          if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
            try {
              return JSON.parse(value) as string;
            } catch {
              return value.slice(1, -1);
            }
          }
          return value;
        })
        .filter((file): file is string => file !== null)
    : [];

	const head = git(repo, ["rev-parse", "--short", "HEAD"]);

	return {
		projectName: facts.name,
		repoPath: repo,
		branch: facts.branch,
		defaultBranch: facts.defaultBranch,
		onDefaultBranch: facts.branch !== null && facts.branch === facts.defaultBranch,
		lastCommitDate: facts.lastCommit,
		dirtyCount: facts.dirtyCount,
		dirtyFiles,
		commits,
		head,
		remote: facts.remote,
	};
}

/**
 * Extract a path from one `git status --porcelain` line.
 *
 * The first two columns are the staged and unstaged status codes, the third is a
 * space, and the rest is the path. Renames read `old -> new`; the new name is the
 * one the user recognises. A path with spaces or quotes comes back quoted from
 * git, so the quotes are stripped.
 */
export function parsePorcelainPath(line: string): string | null {
	if (line.length < 4) return null;
	const rest = line.slice(3).trim();
	if (rest.length === 0) return null;
	const arrow = rest.lastIndexOf(" -> ");
	const value = arrow === -1 ? rest : rest.slice(arrow + 4);
	if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
		try {
			return JSON.parse(value) as string;
		} catch {
			return value.slice(1, -1);
		}
	}
	return value;
}

/**
 * Render the context as the prompt body.
 *
 * Fixed layout with explicit section names, and a short instruction block that
 * asks for one JSON object and nothing else. The reply is parsed and validated
 * before anything is written, so a model that ignores the instruction produces a
 * reported error rather than a note full of prose.
 */
export function buildPrompt(context: GitContext): string {
	const lines: string[] = [];

	lines.push(`Summarise the software project "${context.projectName}" from the git facts below.`);
	lines.push("");
	lines.push("These facts are the only context you have. You cannot read the repository, its files, or");
	lines.push("any notes, so do not describe code you have not been told about. Say what the commit history");
	lines.push("and the working tree state suggest about where this project stands and what is in flight.");
	lines.push("");

	lines.push("## Repository");
	lines.push(`- Project name: ${context.projectName}`);
	lines.push(`- Local path: ${context.repoPath}`);
	lines.push(`- Remote: ${context.remote ?? "none configured"}`);
	lines.push(`- Current branch: ${context.branch ?? "detached or unknown"}`);
	lines.push(
		`- Default branch: ${context.defaultBranch ?? "unknown"}${context.onDefaultBranch ? " (you are on it)" : ""}`,
	);
	lines.push(`- Last commit date: ${context.lastCommitDate ?? "no commits yet"}`);
	lines.push(`- Uncommitted files: ${context.dirtyCount}`);

	lines.push("");
	lines.push(`## Uncommitted file paths (${context.dirtyFiles.length})`);
	if (context.dirtyFiles.length === 0) {
		lines.push("The working tree is clean.");
	} else {
		// Paths only. This is the whole reason v0.1 can be described as git-only.
		for (const file of context.dirtyFiles) lines.push(`- ${file}`);
	}

	lines.push("");
	lines.push(`## Recent commits (${context.commits.length})`);
	if (context.commits.length === 0) {
		lines.push("No commits.");
	} else {
		for (const commit of context.commits) lines.push(`- ${commit.sha} ${commit.subject}`);
	}

	lines.push("");
	lines.push("## Reply format");
	lines.push("Reply with one JSON object and nothing else. No prose, no code fences.");
	lines.push('{"summary": "two or three sentences on the state of this project", "next_steps": ["short imperative step"]}');
	lines.push('"next_steps" is optional and may be an empty array. Every value must be a string.');

	return lines.join("\n");
}
