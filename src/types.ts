/**
 * Types shared across the plugin.
 */

/**
 * Lifecycle of a project.
 *
 * Dormant means no live work and no recent commit: no uncommitted changes, on the
 * default branch, and nothing committed or touched in the last 30 days. Uncommitted
 * changes or a non-default branch make a project active on their own, whatever the
 * age of its last commit.
 */
export type ProjectStatus = "active" | "dormant" | "shipped";

/** Git facts read off disk for one repository. */
export interface RepoFacts {
	/** Absolute path to the repository root. */
	path: string;
	/** Directory name, used as the display name. */
	name: string;
	/** Absolute path of the configured scan root. */
	root: string;
	/**
	 * True when git could read this repository.
	 *
	 * False means the probes returned null for a reason other than the value being
	 * absent, so every absent value here is unreliable and must not be written over
	 * good data already on disk.
	 */
	gitReadable: boolean;
	/** Origin remote URL, or null when the repo has no `origin`. */
	remote: string | null;
	/** Slug like `J0na555/myredis`, or null when there is no usable remote. */
	github: string | null;
	/** Current branch name, or null when HEAD is detached or unborn. */
	branch: string | null;
	/** Branch that origin considers default, or null when undeterminable. */
	defaultBranch: string | null;
	/** True when `branch` is known and differs from `defaultBranch`. */
	onNonDefaultBranch: boolean;
	/** ISO 8601 commit date, or null when the repo has no commits yet. */
	lastCommit: string | null;
	/** Count of `git status --porcelain` lines. */
	dirtyCount: number;
	/** Filesystem mtime of the repo directory, in epoch millis. */
	dirMtime: number;
}

/** Derived score plus the status it implies. */
export interface ScoreResult {
	score: number;
	status: ProjectStatus;
	/** Per-rule breakdown, so the UI can explain the number. */
	parts: ScorePart[];
}

export interface ScorePart {
	label: string;
	points: number;
}

/** A repo plus its ranking, as persisted in frontmatter and shown in the view. */
export interface Project {
	facts: RepoFacts;
	score: ScoreResult;
	/** User-controlled rank. 0 means unpinned. Lower sorts first. */
	pin: number;
	/** Absolute vault path of the per-project note, once synced. */
	notePath?: string;
}

/** Plugin-managed frontmatter keys. The note body is never touched. */
export interface ProjectFrontmatter {
	project?: string;
	repo_path?: string;
	/**
	 * The remote as a user would open it: a browser URL for a GitHub repo, the
	 * verbatim git remote otherwise. `remote_raw` keeps the verbatim form.
	 */
	remote?: string | null;
	/** Origin remote exactly as git reports it, or null when there is no remote. */
	remote_raw?: string | null;
	/** Browser URL for the remote, or null when the host is not github.com. */
	web?: string | null;
	github?: string | null;
	pinned?: number;
	/** Last commit date, `YYYY-MM-DD`. */
	last_commit?: string | null;
	/** The same age in words, e.g. "31d ago". Display only, never sort on it. */
	last_commit_rel?: string | null;
	dirty?: number;
	branch?: string | null;
	score?: number;
	status?: string | null;
}

/**
 * A change to apply to existing frontmatter. A `null` value means delete the key,
 * as opposed to `undefined` in `ProjectFrontmatter`, which means leave it alone.
 */
export type FrontmatterPatch = {
	[K in keyof ProjectFrontmatter]?: ProjectFrontmatter[K] | null;
};

export interface PluginSettings {
	/** Absolute path scanned for git repositories. */
	scanRoot: string;
	/** Vault-relative folder holding one generated note per project. */
	notesFolder: string;
	/** Show projects with no live work and no commit in the last 30 days. */
	showDormant: boolean;
}