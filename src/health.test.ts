import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { healthSignals, SUSTAINED_DIRTY_THRESHOLD } from "./health.ts";
import type { HealthSignal, RepoFacts } from "./types.ts";

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

/** The ids that fired, which is what the row actually shows. */
function ids(signals: HealthSignal[]): string[] {
	return signals.map((signal) => signal.id);
}

function firing(overrides: Partial<RepoFacts>, previousDirty: number | null = null): HealthSignal[] {
	return healthSignals(facts(overrides), previousDirty, NOW);
}

describe("healthSignals on a healthy repo", () => {
	it("says nothing at all", () => {
		// The load-bearing case. A badge that is always on is noise, and the panel
		// has 45 rows to prove that on.
		assert.deepEqual(firing({}), []);
	});

	it("says nothing about a repo whose probes failed", () => {
		assert.deepEqual(firing({ stashCount: null, unpushedCount: null }), []);
	});
});

describe("sustained dirty", () => {
	it("fires when this scan and the last one were both past the threshold", () => {
		// monk-mode on the real disk: 144 files, and 144 at the previous scan too.
		const signals = firing({ dirtyCount: 144 }, 144);
		assert.deepEqual(ids(signals), ["sustained-dirty"]);
		assert.match(signals[0].detail, /144 uncommitted files, and 144 at the last scan/);
	});

	it("does not fire on a big pile seen for the first time", () => {
		// One scan of a large working tree is a day of work, not a problem.
		assert.deepEqual(firing({ dirtyCount: 144 }, null), []);
		assert.deepEqual(firing({ dirtyCount: 144 }, 0), []);
	});

	it("does not fire when the previous count was below the threshold", () => {
		// A pile that appeared today, after a clean scan.
		assert.deepEqual(firing({ dirtyCount: 90 }, 3), []);
	});

	it("does not fire on a small count that happened to be there twice", () => {
		assert.deepEqual(firing({ dirtyCount: 5 }, 5), []);
	});

	it("fires exactly at the threshold, not above it", () => {
		assert.deepEqual(
			firing({ dirtyCount: SUSTAINED_DIRTY_THRESHOLD - 1 }, SUSTAINED_DIRTY_THRESHOLD),
			[],
		);
		assert.deepEqual(
			ids(firing({ dirtyCount: SUSTAINED_DIRTY_THRESHOLD }, SUSTAINED_DIRTY_THRESHOLD - 1)),
			[],
		);
		assert.deepEqual(
			ids(firing({ dirtyCount: SUSTAINED_DIRTY_THRESHOLD }, SUSTAINED_DIRTY_THRESHOLD)),
			["sustained-dirty"],
		);
	});

	it("reads as one word on the row, with the numbers in the explanation", () => {
		const [signal] = firing({ dirtyCount: 40 }, 44);
		assert.equal(signal.badge, "dirty");
		// No count on the row itself: that is the sprawl this feature avoids.
		assert.ok(!/\d/.test(signal.badge), `badge carries a number: ${signal.badge}`);
		assert.match(signal.detail, /40 uncommitted files/);
		assert.match(signal.detail, /44 at the last scan/);
	});

	it("ignores the previous count for a repo git could not read", () => {
		// A failed scan has dirtyCount 0 anyway, so the guard is belt and braces,
		// but the behaviour must not depend on that.
		assert.deepEqual(firing({ gitReadable: false, dirtyCount: 144 }, 144), []);
	});
});

describe("long-lived branch", () => {
	it("fires on a non-default branch whose last commit is past 30 days", () => {
		// cursor-virtually on the real disk: on jonaz, last commit 120 days back.
		const signals = firing({ onNonDefaultBranch: true, branch: "jonaz", lastCommit: daysAgo(120) });
		assert.deepEqual(ids(signals), ["long-branch"]);
		assert.match(signals[0].detail, /\bjonaz\b/);
		assert.match(signals[0].detail, /4mo ago/);
	});

	it("does not fire on a fresh feature branch", () => {
		assert.deepEqual(firing({ onNonDefaultBranch: true, branch: "feat/x", lastCommit: daysAgo(3) }), []);
	});

	it("does not fire on an old commit that is on the default branch", () => {
		assert.deepEqual(firing({ lastCommit: daysAgo(300), onNonDefaultBranch: false }), []);
	});

	it("does not treat the 30-day line as inclusive", () => {
		// The same boundary the dormant rule uses, so the panel cannot disagree
		// with itself about what stale means.
		const base = { onNonDefaultBranch: true, branch: "pr5-6" };
		assert.deepEqual(firing({ ...base, lastCommit: daysAgo(30) }), []);
		assert.deepEqual(ids(firing({ ...base, lastCommit: daysAgo(31) })), ["long-branch"]);
	});

	it("says nothing about a branch with no commits at all", () => {
		assert.deepEqual(firing({ onNonDefaultBranch: true, branch: "main", lastCommit: null }), []);
	});
});

describe("stashed work", () => {
	it("fires when the repo has a stash", () => {
		// AniFlow on the real disk: exactly one.
		const signals = firing({ stashCount: 1 });
		assert.deepEqual(ids(signals), ["stashed"]);
		assert.match(signals[0].detail, /1 stash on this repo/);
	});

	it("says 2 stashes in the plural", () => {
		assert.match(firing({ stashCount: 2 })[0].detail, /2 stashes/);
	});

	it("does not fire on a repo with an empty stash list", () => {
		assert.deepEqual(firing({ stashCount: 0 }), []);
	});

	it("does not fire when the probe could not answer", () => {
		assert.deepEqual(firing({ stashCount: null }), []);
	});
});

describe("unpushed commits", () => {
	it("fires when the upstream is behind the branch", () => {
		const signals = firing({ unpushedCount: 3 });
		assert.deepEqual(ids(signals), ["unpushed"]);
		assert.match(signals[0].detail, /3 commits on this branch that the upstream does not have/);
		assert.match(signals[0].detail, /No other copy exists/);
	});

	it("does not fire when the branch is fully pushed", () => {
		assert.deepEqual(firing({ unpushedCount: 0 }), []);
	});

	it("does not fire for a repo with no upstream to compare against", () => {
		// null, not zero: every repo that was never pushed reports null here, and
		// treating that as 2 unpushed commits would warn on all of them.
		assert.deepEqual(firing({ unpushedCount: null }), []);
	});
});

describe("several signals at once", () => {
	it("reports every one, in the order the panel draws them", () => {
		const signals = firing(
			{
				dirtyCount: 60,
				onNonDefaultBranch: true,
				branch: "pr5-6-visual-identity-atmosphere",
				lastCommit: daysAgo(117),
				stashCount: 1,
				unpushedCount: 2,
			},
			70,
		);
		assert.deepEqual(ids(signals), ["sustained-dirty", "long-branch", "stashed", "unpushed"]);
		assert.deepEqual(
			signals.map((signal) => signal.badge),
			["dirty", "branch", "stash", "unpushed"],
		);
	});

	it("gives every signal an explanation worth reading on hover", () => {
		const signals = firing({ dirtyCount: 60, stashCount: 1 }, 70);
		for (const signal of signals) {
			assert.ok(signal.detail.length > 30, `${signal.id} detail is too thin: ${signal.detail}`);
		}
	});
});