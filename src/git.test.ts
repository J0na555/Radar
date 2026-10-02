import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { isoDate, relativeAge } from "./format.ts";
import { parseGithubSlug, readRepoFacts, toWebUrl } from "./git.ts";

describe("toWebUrl", () => {
	it("converts an scp-style ssh remote to a github.com URL", () => {
		assert.equal(toWebUrl("git@github.com:J0na555/waifu-rag.git"), "https://github.com/J0na555/waifu-rag");
	});

	it("converts an scp-style ssh remote that has no .git suffix", () => {
		assert.equal(toWebUrl("git@github.com:owner/repo"), "https://github.com/owner/repo");
	});

	it("converts an ssh:// URL", () => {
		assert.equal(toWebUrl("ssh://git@github.com/owner/repo"), "https://github.com/owner/repo");
		assert.equal(toWebUrl("ssh://git@github.com:2222/owner/repo.git"), "https://github.com/owner/repo");
	});

	it("strips .git off an https remote", () => {
		assert.equal(toWebUrl("https://github.com/owner/repo.git"), "https://github.com/owner/repo");
	});

	it("leaves an https remote that is already clean alone", () => {
		assert.equal(toWebUrl("https://github.com/owner/repo"), "https://github.com/owner/repo");
	});

	it("drops a trailing slash rather than producing a doubled one", () => {
		assert.equal(toWebUrl("https://github.com/owner/repo/"), "https://github.com/owner/repo");
	});

	it("handles a host in mixed case", () => {
		assert.equal(toWebUrl("git@GitHub.com:owner/repo.git"), "https://github.com/owner/repo");
	});

	it("returns null for a null remote", () => {
		assert.equal(toWebUrl(null), null);
	});

	// The whole point of not reusing parseGithubSlug: a plausible link to the wrong
	// host is worse than no link.
	it("refuses to invent a github.com URL for a gitlab remote", () => {
		assert.equal(toWebUrl("git@gitlab.com:owner/repo.git"), null);
		assert.equal(toWebUrl("https://gitlab.com/owner/repo.git"), null);
		assert.equal(toWebUrl("ssh://git@gitlab.com/owner/repo"), null);
	});

	it("refuses to invent a github.com URL for a self-hosted remote", () => {
		assert.equal(toWebUrl("ssh://git@git.internal.example:8443/team/tool.git"), null);
		assert.equal(toWebUrl("https://git.internal.example/team/tool"), null);
	});

	it("refuses a local path remote", () => {
		assert.equal(toWebUrl("/srv/git/repo.git"), null);
	});

	it("leaves the gitlab slug reported by parseGithubSlug untouched", () => {
		// parseGithubSlug drops the host, so a gitlab remote yields a slug. That is
		// the pre-existing behaviour the `github` key depends on, so it stays.
		assert.equal(parseGithubSlug("git@gitlab.com:owner/repo.git"), "owner/repo");
	});
});

describe("isoDate", () => {
	it("keeps only the date from a full ISO timestamp with an offset", () => {
		assert.equal(isoDate("2026-08-30T18:51:55+03:00"), "2026-08-30");
		assert.equal(isoDate("2026-08-30T15:51:55Z"), "2026-08-30");
	});

	it("passes a date-only value straight through", () => {
		assert.equal(isoDate("2026-08-30"), "2026-08-30");
	});

	it("returns null for a repo with no commits", () => {
		assert.equal(isoDate(null), null);
	});

	it("returns null rather than writing junk for an unparseable value", () => {
		assert.equal(isoDate("not-a-date"), null);
		assert.equal(isoDate(""), null);
	});

	it("stays sortable as plain text", () => {
		const dates = ["2026-08-30", "2025-12-01", "2026-01-15"].map((d) => isoDate(d) as string);
		assert.deepEqual([...dates].sort(), ["2025-12-01", "2026-01-15", "2026-08-30"]);
	});
});

describe("relativeAge", () => {
	const NOW = Date.parse("2026-10-01T00:00:00Z");
	const DAY_MS = 24 * 60 * 60 * 1000;
	const daysAgo = (days: number) => new Date(NOW - days * DAY_MS).toISOString();

	it("reads as words for the ages the panel shows", () => {
		assert.equal(relativeAge(daysAgo(0), NOW), "today");
		assert.equal(relativeAge(daysAgo(1), NOW), "yesterday");
		assert.equal(relativeAge(daysAgo(31), NOW), "31d ago");
		assert.equal(relativeAge(daysAgo(90), NOW), "3mo ago");
	});

	it("says so when there is no commit to measure", () => {
		assert.equal(relativeAge(null, NOW), "no commits");
		assert.equal(relativeAge("rubbish", NOW), "unknown");
	});
});

/** A temp dir that cleans itself up. */
function tmpDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/** Run git and fail the test loudly if it did not work. */
function runGit(cwd: string, args: string[]): void {
	const res = spawnSync("git", ["-c", "user.email=pt@example.com", "-c", "user.name=Project Tracker", ...args], {
		cwd,
		encoding: "utf8",
	});
	assert.equal(res.status, 0, `git ${args.join(" ")} failed: ${res.stderr}`);
}

/** An initialised repo with one commit on main. */
function repoWithCommit(prefix: string): string {
	const dir = tmpDir(prefix);
	runGit(dir, ["init", "-q", "-b", "main", "."]);
	runGit(dir, ["commit", "-q", "--allow-empty", "-m", "first"]);
	return dir;
}

/**
 * A clone of a bare origin that already holds one commit.
 *
 * A real clone, not a stubbed remote: the unpushed probe compares HEAD against an
 * upstream ref, so testing it without an upstream would only test the null path.
 */
function cloneWithOrigin(prefix: string): { repo: string; origin: string } {
	const root = tmpDir(prefix);
	const origin = path.join(root, "origin.git");
	const seed = path.join(root, "seed");

	runGit(root, ["init", "-q", "--bare", "-b", "main", origin]);
	runGit(root, ["clone", "-q", origin, seed]);
	runGit(seed, ["commit", "-q", "--allow-empty", "-m", "first"]);
	runGit(seed, ["push", "-q", "origin", "main"]);

	const repo = path.join(root, "repo");
	runGit(root, ["clone", "-q", origin, repo]);
	return { repo, origin };
}

describe("readRepoFacts health probes", () => {
	it("counts a stash", () => {
		// The one real case on this machine, reproduced for real rather than faked.
		const dir = repoWithCommit("pt-stash-");
		fs.writeFileSync(path.join(dir, "work.txt"), "half a feature\n");
		runGit(dir, ["add", "work.txt"]);
		runGit(dir, ["stash", "push", "-q", "-m", "half a feature"]);

		assert.equal(readRepoFacts(dir, dir).stashCount, 1);
	});

	it("reports zero stashes as zero, not as unknown", () => {
		const dir = repoWithCommit("pt-no-stash-");
		const facts = readRepoFacts(dir, dir);
		assert.equal(facts.stashCount, 0);
		assert.notEqual(facts.stashCount, null);
	});

	it("counts commits the upstream does not have", () => {
		const { repo } = cloneWithOrigin("pt-unpushed-");
		assert.equal(readRepoFacts(repo, repo).unpushedCount, 0);

		runGit(repo, ["commit", "-q", "--allow-empty", "-m", "local only"]);
		runGit(repo, ["commit", "-q", "--allow-empty", "-m", "also local"]);

		const facts = readRepoFacts(repo, repo);
		assert.equal(facts.unpushedCount, 2);
		// And the rest of the facts are still right, so one probe failing to be
		// interesting did not disturb anything else.
		assert.equal(facts.branch, "main");
		assert.equal(facts.defaultBranch, "main");
		assert.equal(facts.onNonDefaultBranch, false);
	});

	it("reports no upstream as unknown rather than as unpushed", () => {
		// Every repo that was never pushed has no upstream. Calling that "every
		// commit is unpushed" would fire the badge on all of them.
		const dir = repoWithCommit("pt-no-upstream-");
		runGit(dir, ["commit", "-q", "--allow-empty", "-m", "local only"]);

		const facts = readRepoFacts(dir, dir);
		assert.equal(facts.unpushedCount, null);
		assert.equal(facts.stashCount, 0);
	});

	it("leaves both probes unknown when git cannot read the repo at all", () => {
		const dir = tmpDir("pt-unreadable-");
		const facts = readRepoFacts(dir, dir);
		assert.equal(facts.gitReadable, false);
		assert.equal(facts.stashCount, null);
		assert.equal(facts.unpushedCount, null);
	});
});

describe("readRepoFacts on a repo with no commits", () => {
	it("reports no commit date but still trusts git", () => {
		// The load-bearing case for the note writer: a fresh `git init` has no
		// commit date, and "no commits" has to be distinguishable from "git failed",
		// otherwise an old date on disk can never be cleared.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-no-commits-"));
		try {
			const init = spawnSync("git", ["init", "-q", dir], { encoding: "utf8" });
			assert.equal(init.status, 0, `git init failed: ${init.stderr}`);

			const facts = readRepoFacts(dir, dir);
			assert.equal(facts.lastCommit, null);
			assert.equal(isoDate(facts.lastCommit), null);
			assert.equal(facts.gitReadable, true);
			assert.equal(relativeAge(facts.lastCommit, Date.now()), "no commits");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reports an unreadable repo as not readable", () => {
		// No .git at all: gitReadable false, so the note writer leaves the note alone
		// rather than recording zeros for facts it could not read.
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pt-not-a-repo-"));
		try {
			const facts = readRepoFacts(dir, dir);
			assert.equal(facts.gitReadable, false);
			assert.equal(facts.remote, null);
			assert.equal(facts.lastCommit, null);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});