import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dirtyPoints, rankProjects, recencyPoints, scoreRepo, WEIGHTS } from "./rank.ts";
import type { RepoFacts, ScoreResult } from "./types.ts";

const NOW = Date.parse("2026-10-01T00:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

/** ISO date `days` before the fixed clock. */
function daysAgo(days: number): string {
	return new Date(NOW - days * DAY_MS).toISOString();
}

function facts(overrides: Partial<RepoFacts> = {}): RepoFacts {
	return {
		path: "/repos/example",
		name: "example",
		root: "/repos",
		remote: "git@github.com:me/example.git",
		github: "me/example",
		branch: "main",
		defaultBranch: "main",
		onNonDefaultBranch: false,
		lastCommit: daysAgo(1),
		dirtyCount: 0,
		dirMtime: NOW - DAY_MS,
		...overrides,
	};
}

function scoreOf(overrides: Partial<RepoFacts> = {}): ScoreResult {
	return scoreRepo(facts(overrides), NOW);
}

describe("dirtyPoints", () => {
	it("awards nothing for a clean tree", () => {
		assert.equal(dirtyPoints(0), 0);
	});

	it("gives a single changed file far less than a full working tree", () => {
		assert.equal(dirtyPoints(1), 8);
		assert.ok(dirtyPoints(1) < WEIGHTS.dirty / 4);
	});

	// The authored curve table listed 22 here. log2(1+4) / log2(1+32) * 40 is
	// 18.41, so the formula in the design note cannot produce 22. Asserting the
	// formula's real output; see the report.
	it("grows on a log curve through the small counts", () => {
		assert.equal(dirtyPoints(2), 13);
		assert.equal(dirtyPoints(3), 16);
		assert.equal(dirtyPoints(4), 18);
		assert.equal(dirtyPoints(8), 25);
		assert.equal(dirtyPoints(12), 29);
		assert.equal(dirtyPoints(13), 30);
	});

	it("saturates at the full weight and stays there", () => {
		assert.equal(dirtyPoints(WEIGHTS.dirtySaturation), WEIGHTS.dirty);
		assert.equal(dirtyPoints(32), 40);
		assert.equal(dirtyPoints(33), 40);
		assert.equal(dirtyPoints(144), 40);
		assert.equal(dirtyPoints(100_000), 40);
	});

	it("separates counts the old flat weight tied together", () => {
		// 1 file and 144 files used to score the same 40.
		assert.ok(dirtyPoints(144) > dirtyPoints(1));
		// Neighbouring small counts are distinguishable, not collapsed.
		assert.ok(dirtyPoints(2) > dirtyPoints(1));
		assert.ok(dirtyPoints(3) > dirtyPoints(2));
	});

	it("treats a nonsensical negative count as clean", () => {
		assert.equal(dirtyPoints(-1), 0);
	});
});

describe("scoreRepo uncommitted part", () => {
	// Stale commit and untouched directory, so the dirty part is the only one.
	const quiet = { lastCommit: daysAgo(90), dirMtime: NOW - 90 * DAY_MS };

	it("reports the file count in the label and the curve in the points", () => {
		const result = scoreOf({ ...quiet, dirtyCount: 12 });
		assert.deepEqual(result.parts, [{ label: "12 uncommitted", points: 29 }]);
		assert.equal(result.score, 29);
	});

	it("no longer ties 1 changed file to 144 changed files", () => {
		assert.notEqual(dirtyPoints(1), dirtyPoints(144));
		assert.equal(scoreOf({ ...quiet, dirtyCount: 1 }).score, 8);
		assert.equal(scoreOf({ ...quiet, dirtyCount: 144 }).score, 40);
	});

	it("scores monk-mode's 144 files no higher than the 32-file cap", () => {
		assert.equal(dirtyPoints(144), dirtyPoints(32));
	});
});

describe("scoreRepo status", () => {
	it("keeps a stale project active when it has uncommitted work", () => {
		const result = scoreOf({ lastCommit: daysAgo(87), dirtyCount: 79 });
		assert.equal(result.status, "active");
	});

	it("keeps a stale project active when it is on a non-default branch", () => {
		const result = scoreOf({
			lastCommit: daysAgo(200),
			onNonDefaultBranch: true,
			branch: "feat/ai-lead-research",
		});
		assert.equal(result.status, "active");
	});

	it("marks a stale project with no live work dormant", () => {
		const result = scoreOf({ lastCommit: daysAgo(31), dirtyCount: 0, onNonDefaultBranch: false });
		assert.equal(result.status, "dormant");
	});

	it("does not read the 30-day window as inclusive", () => {
		assert.equal(scoreOf({ lastCommit: daysAgo(30) }).status, "active");
		assert.equal(scoreOf({ lastCommit: daysAgo(31) }).status, "dormant");
	});

	it("keeps a recently committed clean project active", () => {
		assert.equal(scoreOf({ lastCommit: daysAgo(3) }).status, "active");
	});

	it("keeps an unshipped single-file change active however old the commit", () => {
		// a2sv-practice on the real disk: 1 dirty file, last commit 153 days ago.
		const result = scoreOf({
			lastCommit: daysAgo(153),
			dirtyCount: 1,
			dirMtime: NOW - 153 * DAY_MS,
		});
		assert.equal(result.status, "active");
		assert.equal(result.score, 8);
	});

	it("falls back to directory mtime for a repo with no commits", () => {
		const noCommits = scoreOf({ lastCommit: null, dirMtime: NOW - 1 * DAY_MS });
		assert.equal(noCommits.status, "active");

		const abandoned = scoreOf({ lastCommit: null, dirMtime: NOW - 90 * DAY_MS });
		assert.equal(abandoned.status, "dormant");
	});

	it("awards no recency points past the stale window", () => {
		assert.equal(recencyPoints(31), 0);
		assert.equal(recencyPoints(null), 0);
	});
});

describe("rankProjects", () => {
	it("separates the top of the ranking that the flat weight tied", () => {
		const projects = [
			{ facts: facts({ name: "one-file" }), score: scoreOf({ dirtyCount: 1 }), pin: 0 },
			{ facts: facts({ name: "four-files" }), score: scoreOf({ dirtyCount: 4 }), pin: 0 },
			{ facts: facts({ name: "twelve-files" }), score: scoreOf({ dirtyCount: 12 }), pin: 0 },
			{ facts: facts({ name: "huge-tree" }), score: scoreOf({ dirtyCount: 144 }), pin: 0 },
		];
		assert.deepEqual(
			rankProjects(projects).map((p) => p.facts.name),
			["huge-tree", "twelve-files", "four-files", "one-file"],
		);
	});

	it("still falls back to alphabetical order on an exact score tie", () => {
		const a = { facts: facts({ name: "aaa" }), score: scoreOf(), pin: 0 };
		const b = { facts: facts({ name: "zzz" }), score: scoreOf(), pin: 0 };
		assert.deepEqual(
			rankProjects([b, a]).map((p) => p.facts.name),
			["aaa", "zzz"],
		);
	});

	it("puts pins above every derived score, in pin order", () => {
		const projects = [
			{ facts: facts({ name: "hot" }), score: scoreOf({ dirtyCount: 144 }), pin: 0 },
			{ facts: facts({ name: "second" }), score: scoreOf(), pin: 2 },
			{ facts: facts({ name: "first" }), score: scoreOf(), pin: 1 },
		];
		assert.deepEqual(
			rankProjects(projects).map((p) => p.facts.name),
			["first", "second", "hot"],
		);
	});
});
