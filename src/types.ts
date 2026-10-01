/**
 * Types shared across the plugin.
 */

/** Lifecycle of a project, derived from its last commit age. */
export type ProjectStatus = "active" | "dormant" | "shipped";

/** Git facts read off disk for one repository. */
export interface RepoFacts {
	/** Absolute path to the repository root. */
	path: string;
	/** Directory name, used as the display name. */
	name: string;
	/** Absolute path of the configured scan root. */
	root: string;
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
	remote?: string;
	github?: string;
	pinned?: number;
	last_commit?: string;
	dirty?: number;
	branch?: string;
	score?: number;
	status?: string;
}

export interface PluginSettings {
	/** Absolute path scanned for git repositories. */
	scanRoot: string;
	/** Vault-relative folder holding one generated note per project. */
	notesFolder: string;
	/** Show projects whose last commit is older than 30 days. */
	showDormant: boolean;
}