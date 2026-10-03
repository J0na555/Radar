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
	 * True when git could read this repository. False means the probes returned
	 * null for a reason other than the value being absent, so every absent value
	 * here is unreliable and must not be written over good data already on disk.
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
	/**
	 * Entries in `git stash list`, or null when the probe could not answer.
	 *
	 * Null is not zero: a failed probe must not read as "no stashes".
	 */
	stashCount: number | null;
	/**
	 * Commits on this branch that its upstream does not have, or null when there
	 * is no upstream or the probe failed. A repo with no remote has no upstream, so
	 * this is null on every repo that was never pushed: normal, not a warning.
	 */
	unpushedCount: number | null;
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

/**
 * The score model's tunables.
 *
 * A settings value rather than module constants, because the log curve and the
 * 25 points for a non-default branch were both chosen by feel. `src/rank.ts`
 * holds the defaults and the bounds.
 */
export interface ScoreWeights {
	/** Points at the top of the uncommitted-change curve. */
	dirty: number;
	/** Files at which the uncommitted-change points saturate at `dirty`. */
	dirtySaturation: number;
	nonDefaultBranch: number;
	/** Points for a commit made today. */
	recentCommit: number;
	/** Days over which a commit fades from `recentCommit` to nothing. */
	recentCommitWindowDays: number;
	/** Points for a commit in the fade-out band between the two windows. */
	staleCommit: number;
	/** Days after which a commit counts for nothing and a project can go dormant. */
	staleCommitWindowDays: number;
	/** Points for a folder that has been touched very recently. */
	freshDir: number;
	/** Days a folder counts as recently touched. */
	freshDirWindowDays: number;
}

/** Which health warning fired. */
export type HealthSignalId = "sustained-dirty" | "long-branch" | "stashed" | "unpushed";

/**
 * One health warning, as the row shows it.
 *
 * A `badge` and a `detail`, never a bare number: a count beside each of 45
 * projects for every possible problem is how the panel became unreadable.
 */
export interface HealthSignal {
	id: HealthSignalId;
	/** The compact word on the row. */
	badge: string;
	/** The whole explanation, for the hover and for a screen reader. */
	detail: string;
}

/** A repo plus its ranking, as persisted in frontmatter and shown in the view. */
export interface Project {
	facts: RepoFacts;
	score: ScoreResult;
	/** User-controlled rank. 0 means unpinned. Lower sorts first. */
	pin: number;
	/**
	 * Health warnings that fired on the last scan. Empty for a healthy repo, which
	 * is the normal case: only a firing signal earns any space on the row.
	 */
	health: HealthSignal[];
	/** Absolute vault path of the per-project note, once synced. */
	notePath?: string;
	/**
	 * What is known about the AI summary, refilled on every scan. Absent means no
	 * summary note exists, which is normal: notes are created on request only.
	 */
	summary?: SummaryState;
}

/** Freshness of a project's AI summary, as read back from the summary note. */
export interface SummaryState {
	/** Vault path of the sibling `<name>-ai.md` note. */
	path: string;
	/** Generation time recorded in the note, ISO 8601. */
	generatedAt: string | null;
	/** Short commit the summary was written from. */
	commit: string | null;
	/** Whether the working tree was dirty at generation time. */
	dirty: boolean;
	/** Uncommitted file count at generation time. */
	dirtyCount: number;
	/**
	 * True when the repo has moved since the note was written, so the summary
	 * describes a state that no longer exists.
	 */
	stale: boolean;
	/** Why the summary is stale, for the tooltip. Empty when it is current. */
	staleReason: string;
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

/** Which local CLI produces the summary. */
export type ProviderId = "gemini" | "codex" | "opencode";

/** How a provider actually behaves, which is three states and not two. */
export type ProbeState = "works" | "broken" | "absent";

/**
 * What one provider probe found.
 *
 * Three states, not two. "Installed" and "usable" are different facts, and
 * collapsing them is what hid a failure: gemini is installed on this machine and
 * passes `--version` with exit 0 while being unable to authenticate.
 */
export interface ProviderProbe {
	provider: ProviderId;
	state: ProbeState;
	/** What to show the user. The CLI's own words where it supplied any. */
	detail: string;
	/** Epoch millis the probe ran. */
	checkedAt: number;
}

/** Cached capability-probe results, persisted in data.json. */
export interface ProviderDetection {
	/** Epoch millis of the last full probe pass, 0 when never probed. */
	checkedAt: number;
	probes: ProviderProbe[];
	/** Provider auto-detection chose, or null when none of them answered. */
	selected: ProviderId | null;
}

export interface PluginSettings {
	/** Absolute path scanned for git repositories. */
	scanRoot: string;
	/** Vault-relative folder holding one generated note per project. */
	notesFolder: string;
	/** Show projects with no live work and no commit in the last 30 days. */
	showDormant: boolean;
	/**
	 * Show the "why this score" line under every project name. Off by default
	 * because it doubles the height of a 45-row list, which is the cost that made
	 * the bare number unreadable. The score tooltip is there either way.
	 */
	explainScores: boolean;
	/** Points the score model awards. */
	weights: ScoreWeights;
	/**
	 * CLI used to generate AI summaries, or null to use the detected one. null is
	 * the default, which is what makes detection mean anything: a fresh install
	 * has made no choice, and anything the user does pick is an override that
	 * detection never quietly replaces.
	 */
	provider: ProviderId | null;
	/** Recent commits handed to the model as context. */
	commitCount: number;
	/** Seconds a provider may run before it is killed. */
	timeoutSeconds: number;
	/**
	 * Command that opens a project folder, or "" to reveal the folder in the OS
	 * file manager instead. Empty by default and not auto-detected: which editor
	 * someone uses is not a fact a plugin can guess, and so is a ranking of what
	 * to try. The empty case is a real behaviour, not an error.
	 */
	editorCommand: string;
	/** Cached provider detection, with the time it was taken. */
	detection: ProviderDetection;
}