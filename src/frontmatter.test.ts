import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	applyFrontmatterPatch,
	desiredFrontmatter,
	diffManaged,
	MANAGED_KEY_NAMES,
} from "./frontmatter.ts";
import type { ProjectFrontmatter, RepoFacts, ScoreResult } from "./types.ts";

const NOW = Date.parse("2026-10-01T00:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function facts(overrides: Partial<RepoFacts> = {}): RepoFacts {
	return {
		path: "/repos/waifu-rag",
		name: "waifu-rag",
		root: "/repos",
		gitReadable: true,
		remote: "git@github.com:J0na555/waifu-rag.git",
		github: "J0na555/waifu-rag",
		branch: "main",
		defaultBranch: "main",
		onNonDefaultBranch: false,
		lastCommit: "2026-08-30T18:51:55+03:00",
		dirtyCount: 12,
		dirMtime: NOW - DAY_MS,
		...overrides,
	};
}

const score: ScoreResult = { score: 29, status: "active", parts: [] };

/**
 * What is actually on disk: the managed keys plus whatever the user added.
 * Obsidian hands the plugin the whole YAML block, so unknown keys are real.
 */
type DiskFrontmatter = ProjectFrontmatter & Record<string, unknown>;

function desired(overrides: Partial<RepoFacts> = {}, pin = 0): ProjectFrontmatter {
	return desiredFrontmatter(facts(overrides), score, pin, NOW);
}

describe("desiredFrontmatter remote keys", () => {
	it("writes a clickable github URL as the remote", () => {
		const fm = desired();
		assert.equal(fm.remote, "https://github.com/J0na555/waifu-rag");
		assert.equal(fm.web, "https://github.com/J0na555/waifu-rag");
	});

	it("keeps the exact git remote so nothing is lost", () => {
		assert.equal(desired().remote_raw, "git@github.com:J0na555/waifu-rag.git");
	});

	it("leaves the github slug exactly as parseGithubSlug reported it", () => {
		assert.equal(desired().github, "J0na555/waifu-rag");
	});

	it("leaves an https remote alone", () => {
		const fm = desired({ remote: "https://github.com/owner/repo", github: "owner/repo" });
		assert.equal(fm.remote, "https://github.com/owner/repo");
		assert.equal(fm.web, "https://github.com/owner/repo");
	});

	it("keeps a gitlab ssh remote a gitlab ssh remote", () => {
		const fm = desired({ remote: "git@gitlab.com:owner/repo.git", github: "owner/repo" });
		assert.equal(fm.remote, "git@gitlab.com:owner/repo.git");
		assert.equal(fm.remote_raw, "git@gitlab.com:owner/repo.git");
		assert.equal(fm.web, null);
	});

	it("marks every remote key absent for a repo with no remote", () => {
		const fm = desired({ remote: null, github: null });
		assert.equal(fm.remote, null);
		assert.equal(fm.remote_raw, null);
		assert.equal(fm.web, null);
	});
});

describe("desiredFrontmatter last_commit", () => {
	it("writes a readable date instead of a raw timestamp", () => {
		assert.equal(desired().last_commit, "2026-08-30");
	});

	it("writes the relative age the panel already computes", () => {
		assert.equal(desired().last_commit_rel, "31d ago");
	});

	it("says so when there are no commits", () => {
		const fm = desired({ lastCommit: null });
		assert.equal(fm.last_commit, null);
		assert.equal(fm.last_commit_rel, "no commits");
	});
});

describe("desiredFrontmatter when git could not be read", () => {
	it("writes only what does not come from git", () => {
		// A transient failure must not record a dirty count of 0 or a score built
		// on a commit date that was never read.
		const fm = desired({ gitReadable: false });
		assert.deepEqual(fm, { project: "waifu-rag", pinned: 0 });
	});

	it("does not present a skipped key as a deletion", () => {
		// undefined means "unknown", so an unreadable scan must not delete anything.
		const current: ProjectFrontmatter = {
			remote: "https://github.com/J0na555/waifu-rag",
			web: "https://github.com/J0na555/waifu-rag",
		};
		const patch = diffManaged(current, desired({ gitReadable: false }));
		for (const key of ["remote", "web", "remote_raw", "last_commit", "branch", "github"]) {
			assert.equal(key in patch, false, `${key} should have been left alone`);
		}
	});
});

describe("diffManaged", () => {
	it("manages the URL keys", () => {
		for (const key of ["web", "remote_raw", "remote", "last_commit", "last_commit_rel"]) {
			assert.ok(MANAGED_KEY_NAMES.includes(key), `${key} is not managed`);
		}
	});

	it("returns nothing when the note already matches", () => {
		const fm = desired();
		assert.deepEqual(diffManaged(fm, fm), {});
	});

	it("leaves the user's own keys and pinned alone", () => {
		const current: DiskFrontmatter = { project: "waifu-rag", pinned: 3, my_note: "keep me" };
		const patch = diffManaged(current, desired({}, 3));
		assert.equal("pinned" in patch, false);
		assert.equal("my_note" in patch, false);
		assert.equal("remote" in patch, true);
	});

	it("removes a key the plugin decided no longer exists", () => {
		// The stale-key case: a repo that lost its remote used to keep the old URL
		// forever, because absence and probe failure were both undefined.
		const current: ProjectFrontmatter = {
			remote: "https://github.com/J0na555/waifu-rag",
			web: "https://github.com/J0na555/waifu-rag",
			remote_raw: "git@github.com:J0na555/waifu-rag.git",
		};
		const patch = diffManaged(current, desired({ remote: null, github: null }));
		assert.equal(patch.web, null);
		assert.equal(patch.remote, null);
		assert.equal(patch.remote_raw, null);
	});

	it("emits a removal as null, which is a no-op on an absent key", () => {
		// The value is what marks a removal, not the presence of the key, so a key
		// that is already gone still gets a harmless delete.
		const patch = diffManaged({}, desired({ remote: null, github: null }));
		assert.equal(patch.web, null);

		const fm: Record<string, unknown> = {};
		applyFrontmatterPatch(fm, patch);
		assert.equal("web" in fm, false);
	});
});

describe("applyFrontmatterPatch", () => {
	it("deletes a key given null instead of writing the word null", () => {
		const fm: Record<string, unknown> = { web: "https://github.com/o/r", pinned: 0 };
		applyFrontmatterPatch(fm, { web: null });
		assert.equal("web" in fm, false);
		assert.equal(fm.pinned, 0);
	});

	it("assigns a value that is not null", () => {
		const fm: Record<string, unknown> = { remote: "git@github.com:o/r.git" };
		applyFrontmatterPatch(fm, { remote: "https://github.com/o/r" });
		assert.equal(fm.remote, "https://github.com/o/r");
	});
});

describe("rewriting a note written by the previous version", () => {
	// The 42 SSH notes already on disk, exactly as the previous version wrote them.
	const onDisk: DiskFrontmatter = {
		project: "waifu-rag",
		repo_path: "/repos/waifu-rag",
		remote: "git@github.com:J0na555/waifu-rag.git",
		github: "J0na555/waifu-rag",
		pinned: 2,
		last_commit: "2026-08-30T18:51:55+03:00",
		dirty: 12,
		branch: "main",
		score: 29,
		status: "active",
	};

	it("replaces the mailto bait and the raw timestamp, and adds the URL keys", () => {
		const fm = { ...onDisk };
		applyFrontmatterPatch(fm, diffManaged(fm, desired({}, 2)));

		assert.equal(fm.remote, "https://github.com/J0na555/waifu-rag");
		assert.equal(fm.web, "https://github.com/J0na555/waifu-rag");
		assert.equal(fm.remote_raw, "git@github.com:J0na555/waifu-rag.git");
		assert.equal(fm.last_commit, "2026-08-30");
		assert.equal(fm.last_commit_rel, "31d ago");
	});

	it("keeps the pin, the slug and every other managed value", () => {
		const fm = { ...onDisk };
		applyFrontmatterPatch(fm, diffManaged(fm, desired({}, 2)));

		assert.equal(fm.pinned, 2);
		assert.equal(fm.github, "J0na555/waifu-rag");
		assert.equal(fm.dirty, 12);
		assert.equal(fm.branch, "main");
		assert.equal(fm.score, 29);
		assert.equal(fm.status, "active");
		assert.equal(fm.repo_path, "/repos/waifu-rag");
	});

	it("is idempotent, so a second rescan changes nothing", () => {
		const fm = { ...onDisk };
		applyFrontmatterPatch(fm, diffManaged(fm, desired({}, 2)));
		const afterFirst = { ...fm };
		assert.deepEqual(diffManaged(afterFirst, desired({}, 2)), {});
	});

	it("leaves a user key in the frontmatter alone", () => {
		const fm: DiskFrontmatter = { ...onDisk, my_note: "keep me" };
		applyFrontmatterPatch(fm, diffManaged(fm, desired({}, 2)));
		assert.equal(fm.my_note, "keep me");
	});
});