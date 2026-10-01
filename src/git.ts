import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import type { RepoFacts } from "./types";

/** Directories never worth descending into when hunting for repos. */
const SKIP_DIRS = new Set(["node_modules", "vendor", "dist", "build", "target", "venv", ".venv"]);

/**
 * Run a git command in `cwd`. Returns trimmed stdout on success, or null when
 * git fails. Many probes are expected to fail on healthy repos (a repo with no
 * commits makes `git log` exit 128), so failure is normal, not exceptional.
 */
function git(cwd: string, args: string[]): string | null {
	const res = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		maxBuffer: 10 * 1024 * 1024,
		windowsHide: true,
	});
	if (res.error || res.status !== 0) return null;
	return res.stdout.trim();
}

/** True when `dir` is the root of a git repository (dir or worktree file). */
function isRepo(dir: string): boolean {
	return fs.existsSync(path.join(dir, ".git"));
}

/**
 * Find git repositories under `root`, up to `maxDepth` directory levels below it.
 * Hidden directories are skipped so we never walk into .git internals.
 */
export function findRepos(root: string, maxDepth = 2): string[] {
	const found: string[] = [];

	const walk = (dir: string, depth: number): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
			const child = path.join(dir, entry.name);
			if (isRepo(child)) {
				found.push(child);
				// A repo's own subdirectories are its content, not separate projects.
				continue;
			}
			if (depth >= maxDepth) continue;
			if (SKIP_DIRS.has(entry.name)) continue;
			walk(child, depth + 1);
		}
	};

	walk(root, 0);
	return found.sort((a, b) => a.localeCompare(b));
}

/**
 * Strip common remote forms down to an owner/name slug.
 * Handles `git@github.com:owner/repo.git`, `ssh://git@github.com/owner/repo`,
 * `https://github.com/owner/repo.git`, and bare `owner/repo`.
 */
export function parseGithubSlug(remote: string | null): string | null {
	if (!remote) return null;

	const patterns = [
		/^git@[^:]+:([^/]+)\/(.+?)(?:\.git)?$/,
		/^ssh:\/\/[^@]+@[^/]+\/([^/]+)\/(.+?)(?:\.git)?$/,
		/^https?:\/\/[^/]+\/([^/]+)\/(.+?)(?:\.git)?$/,
		/^git:\/\/[^/]+\/([^/]+)\/(.+?)(?:\.git)?$/,
	];

	for (const pattern of patterns) {
		const match = remote.match(pattern);
		if (match) return `${match[1]}/${match[2]}`;
	}
	return null;
}

/**
 * Split a remote URL into its host and owner/repo, or null when the shape is one
 * we do not recognise.
 *
 * Kept separate from `parseGithubSlug` on purpose. That function throws the host
 * away, so `git@gitlab.com:me/tool.git` and `git@github.com:me/tool.git` both come
 * back as `me/tool`. Building a browser URL from it would hand a GitLab user a
 * github.com link to whatever repo happened to share the name.
 *
 * Handles scp-style (`git@host:owner/repo.git`), scheme URLs with or without a
 * user and a port, and both `.git` suffixes.
 */
function splitRemote(remote: string): { host: string; owner: string; repo: string } | null {
	const scp = remote.match(/^(?:[^@/]+@)?([^:/]+):([^/]+\/.+)$/);
	if (scp) {
		const path = splitRepoPath(scp[2]);
		return path ? { host: scp[1], ...path } : null;
	}

	const url = remote.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i);
	if (url) {
		const path = splitRepoPath(url[2]);
		return path ? { host: url[1], ...path } : null;
	}

	return null;
}

/** Split `owner/repo(.git)` and strip the `.git` and any trailing slash. */
function splitRepoPath(value: string): { owner: string; repo: string } | null {
	const path = value.replace(/\/+$/, "").replace(/\.git$/i, "");
	const slash = path.indexOf("/");
	if (slash <= 0 || slash === path.length - 1) return null;
	return { owner: path.slice(0, slash), repo: path.slice(slash + 1) };
}

/**
 * Turn a git remote into a URL that opens in a browser, or null when no honest
 * one can be built.
 *
 * Only github.com qualifies. A GitLab or self-hosted remote comes back null
 * rather than a github.com guess, because a plausible-looking link to the wrong
 * host is worse than no link.
 *
 * `git@github.com:owner/repo.git`  ->  https://github.com/owner/repo
 * `ssh://git@github.com/owner/repo` ->  https://github.com/owner/repo
 * `https://github.com/owner/repo`   ->  https://github.com/owner/repo
 */
export function toWebUrl(remote: string | null): string | null {
	if (!remote) return null;
	const parts = splitRemote(remote);
	if (!parts) return null;
	if (parts.host.toLowerCase() !== "github.com") return null;
	return `https://github.com/${parts.owner}/${parts.repo}`;
}

/**
 * Resolve the branch origin treats as default.
 *
 * `refs/remotes/origin/HEAD` is the correct source but it is unset on roughly a
 * third of the local repos here, so fall back to the well-known names before
 * giving up and reporting an unknown default.
 */
function resolveDefaultBranch(cwd: string): string | null {
	const head = git(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
	if (head) return head.replace(/^origin\//, "");

	const refs = git(cwd, ["for-each-ref", "refs/remotes/origin", "--format=%(refname:short)"]);
	if (!refs) return null;

	const names = refs
		.split("\n")
		.map((line) => line.replace(/^origin\//, ""))
		.filter((name) => name && name !== "HEAD");

	for (const candidate of ["main", "master", "trunk", "develop"]) {
		if (names.includes(candidate)) return candidate;
	}
	return null;
}

/**
 * Collect git facts for one repository. Assumes `repoPath` is a repo root.
 * Every probe degrades to null rather than throwing, so a single odd repo
 * cannot abort a whole scan.
 */
export function readRepoFacts(repoPath: string, root: string): RepoFacts {
	const name = path.basename(repoPath);
	const remote = git(repoPath, ["remote", "get-url", "origin"]);
	const branch = git(repoPath, ["branch", "--show-current"]) || null;
	const defaultBranch = resolveDefaultBranch(repoPath);

	// `rev-parse --git-dir` succeeds for a readable repository whether or not it has
	// any commits, so a false here means the failure was not "this value is
	// absent". Every absent probe result below is only trustworthy when this is true.
	const gitReadable = git(repoPath, ["rev-parse", "--git-dir"]) !== null;

	// `--format=%cI` is committer date in strict ISO 8601, timezone included.
	const lastCommit = git(repoPath, ["log", "-1", "--format=%cI"]) || null;

	const porcelain = git(repoPath, ["status", "--porcelain"]);
	const dirtyCount = porcelain === null ? 0 : porcelain.split("\n").filter((l) => l.length > 0).length;

	let dirMtime = 0;
	try {
		dirMtime = fs.statSync(repoPath).mtimeMs;
	} catch {
		dirMtime = 0;
	}

	return {
		path: repoPath,
		name,
		root,
		gitReadable,
		remote,
		github: parseGithubSlug(remote),
		branch,
		defaultBranch,
		// With no known default, treating the branch as default avoids a
		// permanent false +25 on every repo missing an origin/HEAD ref.
		onNonDefaultBranch: branch !== null && defaultBranch !== null && branch !== defaultBranch,
		lastCommit,
		dirtyCount,
		dirMtime,
	};
}

/** Scan `root` and read facts for every repository found. */
export function scanProjects(root: string, maxDepth = 2): RepoFacts[] {
	if (!fs.existsSync(root)) return [];
	return findRepos(root, maxDepth).map((repo) => readRepoFacts(repo, root));
}