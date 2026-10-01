import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { RepoFacts } from "./types";

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