import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	describeScore,
	DEFAULT_WEIGHTS,
	dirtyPoints,
	rankProjects,
	recencyPoints,
	sanitizeWeights,
	scoreRepo,
	WEIGHT_BOUNDS,
	WEIGHT_KEYS,
	WEIGHT_LABELS,
} from "./rank.ts";
import type { RepoFacts, ScoreResult, ScoreWeights } from "./types.ts";

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
		gitReadable: true,
		remote: "git@github.com:me/example.git",
		github: "me/example",
		branch: "main",
		defaultBranch: "main",
		onNonDefaultBranch: false,
		lastCommit: daysAgo(1),
		dirtyCount: 0,
		stashCount: 0,
		unpushedCount: 0,
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
		assert.ok(dirtyPoints(1) < DEFAULT_WEIGHTS.dirty / 4);
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
		assert.equal(dirtyPoints(DEFAULT_WEIGHTS.dirtySaturation), DEFAULT_WEIGHTS.dirty);
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

describe("injectable weights", () => {
	/** A complete set of weights with overrides on top. */
	function weights(overrides: Partial<ScoreWeights> = {}): ScoreWeights {
		return { ...DEFAULT_WEIGHTS, ...overrides };
	}

	it("scores the same as before when nothing is overridden", () => {
		// Every existing call site passes only (facts, now) and must keep the
		// numbers it shipped with.
		const repo = facts({ dirtyCount: 12, lastCommit: daysAgo(90), dirMtime: NOW - 90 * DAY_MS });
		assert.deepEqual(scoreRepo(repo, NOW), scoreRepo(repo, NOW, DEFAULT_WEIGHTS));
		assert.equal(dirtyPoints(12), dirtyPoints(12, DEFAULT_WEIGHTS));
	});

	it("moves the branch weight when the user drags that slider", () => {
		const repo = facts({ onNonDefaultBranch: true, branch: "jonaz" });
		const full = scoreRepo(repo, NOW);
		const cheaper = scoreRepo(repo, NOW, weights({ nonDefaultBranch: 0 }));
		assert.equal(DEFAULT_WEIGHTS.nonDefaultBranch, 25);
		assert.equal(full.score - cheaper.score, 25);
		// Zeroed means the part is gone rather than shown as a 0.
		assert.ok(!cheaper.parts.some((part) => part.label.startsWith("on ")));
	});

	it("moves where the dirty curve saturates", () => {
		// The log curve's shape was chosen by feel, and this is the slider that
		// changes it: saturating at 8 files instead of 32 flattens the top.
		const repo = facts({ dirtyCount: 20, lastCommit: daysAgo(90), dirMtime: NOW - 90 * DAY_MS });
		assert.equal(scoreRepo(repo, NOW, weights({ dirtySaturation: 8 })).score, 40);
		assert.ok(scoreRepo(repo, NOW, weights({ dirtySaturation: 200 })).score < 40);
	});

	it("moves the window that decides when a project goes dormant", () => {
		// The 30-day line is used by three things: recency points, dormancy, and the
		// long-lived branch warning. Dragging it has to move all of them together.
		const repo = facts({ lastCommit: daysAgo(20) });
		assert.equal(scoreRepo(repo, NOW).status, "active");
		const shorter = scoreRepo(repo, NOW, weights({ staleCommitWindowDays: 10 }));
		assert.equal(shorter.status, "dormant");
	});

	it("scores zero points rather than NaN when a divisor is zeroed", () => {
		// sanitizeWeights floors these at 1, but a caller can pass anything, and a
		// scoring model that returns NaN sorts worse than one that returns 0.
		assert.equal(dirtyPoints(12, weights({ dirtySaturation: 0 })), 40);
		assert.equal(Number.isNaN(recencyPoints(3, weights({ recentCommitWindowDays: 0 }))), false);
		assert.equal(Number.isNaN(recencyPoints(20, weights({ staleCommitWindowDays: 0 }))), false);
	});
});

describe("sanitizeWeights", () => {
	it("keeps every default when nothing is stored", () => {
		assert.deepEqual(sanitizeWeights(undefined), DEFAULT_WEIGHTS);
		assert.deepEqual(sanitizeWeights({}), DEFAULT_WEIGHTS);
		assert.deepEqual(sanitizeWeights(null), DEFAULT_WEIGHTS);
	});

	it("takes a stored value it recognises", () => {
		assert.equal(sanitizeWeights({ dirty: 60 }).dirty, 60);
		assert.equal(sanitizeWeights({ dirty: 60, freshDir: 0 }).freshDir, 0);
	});

	it("ignores a field that is not a number", () => {
		// data.json is a file someone can edit, and half a model reading NaN is
		// worse than ignoring the edit.
		assert.equal(sanitizeWeights({ dirty: "sixty" }).dirty, DEFAULT_WEIGHTS.dirty);
		assert.equal(sanitizeWeights({ dirty: "60" }).dirty, DEFAULT_WEIGHTS.dirty);
		assert.equal(sanitizeWeights({ dirty: null }).dirty, DEFAULT_WEIGHTS.dirty);
		assert.equal(sanitizeWeights({ dirty: false }).dirty, DEFAULT_WEIGHTS.dirty);
		assert.equal(sanitizeWeights({ dirty: "" }).dirty, DEFAULT_WEIGHTS.dirty);
		assert.equal(sanitizeWeights({ dirty: Number.NaN }).dirty, DEFAULT_WEIGHTS.dirty);
		assert.equal(sanitizeWeights({ dirty: { nope: 1 } }).dirty, DEFAULT_WEIGHTS.dirty);
	});

	it("pulls a value back inside the slider's range", () => {
		assert.equal(sanitizeWeights({ dirty: 9999 }).dirty, WEIGHT_BOUNDS.dirty.max);
		assert.equal(sanitizeWeights({ dirty: -40 }).dirty, WEIGHT_BOUNDS.dirty.min);
	});

	it("floors the two divisors at 1", () => {
		assert.equal(sanitizeWeights({ dirtySaturation: 0 }).dirtySaturation, 1);
		assert.equal(sanitizeWeights({ recentCommitWindowDays: 0 }).recentCommitWindowDays, 1);
	});

	it("rounds a fractional value the way a slider step would", () => {
		assert.equal(sanitizeWeights({ dirty: 17.6 }).dirty, 18);
	});

	it("never hands back the defaults themselves", () => {
		// Otherwise writing to the returned object would edit the defaults for the
		// rest of the session.
		const loaded = sanitizeWeights({ dirty: 60 });
		loaded.dirty = 5;
		assert.equal(DEFAULT_WEIGHTS.dirty, 40);
	});
});

describe("describeScore", () => {
	it("names every part with its points", () => {
		const result = scoreRepo(
			facts({ dirtyCount: 12, onNonDefaultBranch: true, branch: "jonaz", lastCommit: daysAgo(90) }),
			NOW,
		);
		const text = describeScore(result);
		assert.match(text, /^Score \d+: /);
		assert.match(text, /29 12 uncommitted/);
		assert.match(text, /25 on jonaz/);
		// Every part appears, in the order the score adds them up.
		assert.deepEqual(
			result.parts.map((part) => text.includes(`${part.points} ${part.label}`)),
			result.parts.map(() => true),
		);
	});

	it("says why the score is nothing rather than showing an empty breakdown", () => {
		const quiet = facts({ lastCommit: daysAgo(200), dirMtime: NOW - 200 * DAY_MS });
		assert.deepEqual(scoreRepo(quiet, NOW).parts, []);
		assert.match(describeScore(scoreRepo(quiet, NOW)), /nothing is scoring/);
	});

	it("is built from the parts, so it cannot describe a different score", () => {
		// Hand-built parts that do not add up to the score. The sentence has to
		// report what it was given rather than recomputing anything.
		const text = describeScore({
			score: 999,
			status: "active",
			parts: [{ label: "uncommitted", points: 1 }],
		});
		assert.equal(text, "Score 999: 1 uncommitted.");
	});
});

describe("the model is inspectable", () => {
	it("gives every weight a label and a bounded range", () => {
		for (const key of WEIGHT_KEYS) {
			assert.ok(WEIGHT_LABELS[key]?.length > 5, `${key} has no usable label`);
			const bounds = WEIGHT_BOUNDS[key];
			assert.ok(bounds.min < bounds.max, `${key} has an impossible range`);
			assert.ok(bounds.min >= 0, `${key} can go negative`);
		}
		assert.deepEqual(Object.keys(WEIGHT_BOUNDS).sort(), [...WEIGHT_KEYS].sort());
	});

	it("keeps every default inside its own slider range", () => {
		// A default outside its own bounds means the tab opens with a handle that
		// does not match what the plugin is actually using.
		for (const key of WEIGHT_KEYS) {
			const bounds = WEIGHT_BOUNDS[key];
			const value = DEFAULT_WEIGHTS[key];
			assert.ok(
				value >= bounds.min && value <= bounds.max,
				`${key} default ${value} is outside ${bounds.min}..${bounds.max}`,
			);
		}
	});
});
