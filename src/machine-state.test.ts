import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	applyLegacyNotes,
	emptyMachineState,
	MAX_DIRTY_COUNT,
	MAX_PIN_RANK,
	needsLegacySeed,
	pinRankFor,
	previousDirtyFor,
	sanitizeMachineState,
	stampFromLegacySummary,
	stateFromRecord,
	STATE_VERSION,
} from "./machine-state.ts";
import type { LegacySummaryFrontmatter } from "./machine-state.ts";
import type { MachineState, RepoFacts, SummaryRecord } from "./types.ts";

const NOW = Date.parse("2026-10-01T00:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function facts(overrides: Partial<RepoFacts> = {}): RepoFacts {
	return {
		path: "/repos/example",
		name: "example",
		root: "/repos",
		gitReadable: true,
		remote: null,
		github: null,
		branch: "main",
		defaultBranch: "main",
		onNonDefaultBranch: false,
		lastCommit: new Date(NOW - DAY_MS).toISOString(),
		dirtyCount: 0,
		stashCount: 0,
		unpushedCount: 0,
		dirMtime: NOW - DAY_MS,
		...overrides,
	};
}

/**
 * Frontmatter as the vault actually hands it over, which is whatever the user's YAML parsed to.
 * The declared types are what the plugin wrote, not what can be in the file.
 */
function fm(raw: unknown): LegacySummaryFrontmatter {
	return raw as LegacySummaryFrontmatter;
}

function record(overrides: Partial<SummaryRecord> = {}): SummaryRecord {
	return {
		generatedAt: "2026-09-30T10:00:00.000Z",
		commit: "abc1234",
		dirtyCount: 0,
		...overrides,
	};
}

describe("sanitizeMachineState", () => {
	it("turns nothing into empty state rather than undefined", () => {
		for (const loaded of [undefined, null, 7, "state", [], true]) {
			const state = sanitizeMachineState(loaded);
			assert.deepEqual(state.pins, {});
			assert.deepEqual(state.previousDirty, {});
			assert.deepEqual(state.summaries, {});
			assert.equal(state.version, 0);
		}
	});

	// The whole point of the sanitizer: a hand-edited data.json must cost a pin, never the
	// panel. Every one of these values would reach a comparison that assumes a real rank.
	it("keeps only ranks that are positive whole numbers in range", () => {
		const state = sanitizeMachineState({
			pins: {
				good: 3,
				big: MAX_PIN_RANK,
				zero: 0,
				negative: -1,
				fractional: 2.5,
				text: "3",
				nothing: null,
				nan: Number.NaN,
				infinite: Number.POSITIVE_INFINITY,
				absurd: MAX_PIN_RANK + 1,
			},
		});
		assert.deepEqual(state.pins, { good: 3, big: MAX_PIN_RANK });
	});

	it("keeps only dirty counts that are non-negative whole numbers in range", () => {
		const state = sanitizeMachineState({
			previousDirty: {
				clean: 0,
				pile: 144,
				negative: -1,
				fractional: 0.5,
				text: "144",
				nothing: null,
				nan: Number.NaN,
				absurd: MAX_DIRTY_COUNT + 1,
			},
		});
		assert.deepEqual(state.previousDirty, { clean: 0, pile: 144 });
	});

	it("keeps a zero dirty count rather than reading it as no history", () => {
		// Zero and absent are different facts: "was clean last scan" is what lets the
		// sustained-dirty warning decide, and dropping it would make every repo look new.
		const state = sanitizeMachineState({ previousDirty: { clean: 0 } });
		assert.equal(previousDirtyFor(state.previousDirty, "clean"), 0);
		assert.equal(previousDirtyFor(state.previousDirty, "unknown"), null);
	});

	it("refuses a project name that would reach the prototype instead of the record", () => {
		const state = sanitizeMachineState(JSON.parse('{"pins":{"__proto__":7,"constructor":8,"real":1}}'));
		assert.deepEqual(state.pins, { real: 1 });
		assert.equal(({} as Record<string, unknown>).polluted, undefined);
	});

	it("validates each summary field on its own", () => {
		const state = sanitizeMachineState({
			summaries: {
				good: { generatedAt: "2026-09-30T10:00:00.000Z", commit: "abc1234", dirtyCount: 3 },
				unreadableDate: { generatedAt: "last tuesday", commit: "abc1234", dirtyCount: 0 },
				noCommit: { generatedAt: "2026-09-30T10:00:00.000Z", commit: "", dirtyCount: 0 },
				noDirtyCount: { generatedAt: "2026-09-30T10:00:00.000Z", commit: "abc1234" },
				absurdDirty: { generatedAt: "2026-09-30T10:00:00.000Z", commit: "abc1234", dirtyCount: 1e9 },
				textDirty: { generatedAt: "2026-09-30T10:00:00.000Z", commit: "abc1234", dirtyCount: "3" },
			},
		});

		assert.deepEqual(state.summaries.good, {
			generatedAt: "2026-09-30T10:00:00.000Z",
			commit: "abc1234",
			dirtyCount: 3,
		});
		assert.equal(state.summaries.unreadableDate.generatedAt, null);
		assert.equal(state.summaries.unreadableDate.commit, "abc1234");
		assert.equal(state.summaries.noCommit.commit, null);
		assert.equal(state.summaries.noDirtyCount.dirtyCount, 0);
		assert.equal(state.summaries.absurdDirty.dirtyCount, 0);
		assert.equal(state.summaries.textDirty.dirtyCount, 0);
	});

	it("drops a summary entry that is not an object at all", () => {
		const state = sanitizeMachineState({ summaries: { good: record(), text: "written", nothing: null } });
		assert.deepEqual(Object.keys(state.summaries), ["good"]);
	});

	// A load must not mark an unseeded upgrade as seeded. Forcing the version forward here is
	// how every pin in every install gets reset on first load, once and silently.
	it("leaves the version as it was found", () => {
		assert.equal(sanitizeMachineState({ pins: {}, version: 0 }).version, 0);
		assert.equal(sanitizeMachineState({ pins: {}, version: 7 }).version, 7);
		assert.equal(sanitizeMachineState({ pins: {}, version: "1" }).version, 0);
		assert.equal(sanitizeMachineState({ pins: {}, version: Number.NaN }).version, 0);
	});

	it("returns fresh records so one caller cannot write into another's state", () => {
		const first = sanitizeMachineState({ pins: { a: 1 } });
		const second = sanitizeMachineState({ pins: { a: 1 } });
		first.pins.b = 2;
		assert.deepEqual(second.pins, { a: 1 });
		assert.deepEqual(emptyMachineState(), { version: 0, pins: {}, previousDirty: {}, summaries: {} });
	});
});

describe("reading state", () => {
	it("reads an absent pin as unpinned rather than as missing", () => {
		const pins = { pinned: 3 };
		assert.equal(pinRankFor(pins, "pinned"), 3);
		assert.equal(pinRankFor(pins, "other"), 0);
	});
});

describe("needsLegacySeed", () => {
	it("is true only for a layout older than this one", () => {
		assert.equal(needsLegacySeed(emptyMachineState()), true);
		assert.equal(needsLegacySeed({ ...emptyMachineState(), version: STATE_VERSION }), false);
		assert.equal(needsLegacySeed({ ...emptyMachineState(), version: STATE_VERSION + 1 }), false);
	});
});

describe("stateFromRecord", () => {
	it("rebuilds what the panel renders from what was persisted", () => {
		const state = stateFromRecord(record({ dirtyCount: 4 }), facts({ dirtyCount: 4 }), "abc1234");
		assert.deepEqual(state, {
			generatedAt: "2026-09-30T10:00:00.000Z",
			commit: "abc1234",
			dirty: true,
			dirtyCount: 4,
			stale: false,
			staleReason: "",
		});
	});

	it("calls a summary stale when the repo has moved since", () => {
		const state = stateFromRecord(record(), facts(), "def5678");
		assert.equal(state.stale, true);
		assert.match(state.staleReason, /abc1234 to def5678/);
	});

	it("calls a summary stale when the working tree changed size", () => {
		const state = stateFromRecord(record({ dirtyCount: 0 }), facts({ dirtyCount: 12 }), "abc1234");
		assert.equal(state.stale, true);
		assert.match(state.staleReason, /0 to 12 files/);
	});

	// A repo with no commits cannot be compared, and not knowing is not the same as being out of
	// date. A summary that says so would send the user regenerating for nothing.
	it("does not call a summary stale when there is nothing to compare against", () => {
		const state = stateFromRecord(record({ commit: null }), facts(), null);
		assert.equal(state.stale, false);
		assert.equal(state.staleReason, "");
	});

	it("keeps the generation time even when the commit is unreadable", () => {
		const state = stateFromRecord(record({ commit: null, generatedAt: null }), facts(), "abc1234");
		assert.equal(state.generatedAt, null);
		assert.equal(state.commit, null);
	});
});

describe("stampFromLegacySummary", () => {
	it("reads a generated note and refuses anything else", () => {
		assert.equal(stampFromLegacySummary(null), null);
		assert.equal(stampFromLegacySummary(undefined), null);
		// A hand-written note with a `commit` key is not a summary. `ai_generated` is the mark
		// the old writer put on purpose, and nothing else may stand in for it.
		assert.equal(stampFromLegacySummary({ commit: "abc1234" }), null);
		assert.equal(stampFromLegacySummary(fm({ ai_generated: "yes" })), null);

		assert.deepEqual(
			stampFromLegacySummary({
				ai_generated: true,
				generated_at: "2026-09-30T10:00:00.000Z",
				commit: "abc1234",
				dirty_count: 144,
			}),
			{ generatedAt: "2026-09-30T10:00:00.000Z", commit: "abc1234", dirtyCount: 144 },
		);
	});

	it("accepts a generated note with no commit and no dirty count", () => {
		assert.deepEqual(stampFromLegacySummary({ ai_generated: true }), {
			generatedAt: null,
			commit: null,
			dirtyCount: 0,
		});
	});

	it("refuses a stored value that is not the type it claims to be", () => {
		assert.deepEqual(
			stampFromLegacySummary(
				fm({ ai_generated: true, generated_at: "whenever", commit: 42, dirty_count: "144" }),
			),
			{ generatedAt: null, commit: null, dirtyCount: 0 },
		);
	});
});

describe("applyLegacyNotes", () => {
	// This is the upgrade path for an install that has 45 notes on disk with real pin ranks in
	// them. Anything that loses one of those is the worst bug this change can ship.
	it("carries pins, dirty counts and summary stamps across from the notes", () => {
		const state = applyLegacyNotes(emptyMachineState(), [
			{ project: "monk-mode", pinned: 3, dirty: 144 },
			{ project: "api-ai", pinned: 1, dirty: 0 },
			{
				project: "cursor-virtually",
				summary: { ai_generated: true, generated_at: "2026-09-30T10:00:00.000Z", commit: "abc1234", dirty_count: 2 },
			},
		]);

		assert.deepEqual(state.pins, { "monk-mode": 3, "api-ai": 1 });
		assert.deepEqual(state.previousDirty, { "monk-mode": 144, "api-ai": 0 });
		assert.deepEqual(Object.keys(state.summaries), ["cursor-virtually"]);
	});

	it("leaves the version to the caller", () => {
		// The version and the seed are written together so a failed save leaves both to retry.
		// A seed that set its own version would be claiming the work before it was persisted.
		const state = applyLegacyNotes(emptyMachineState(), [{ project: "api-ai", pinned: 1 }]);
		assert.equal(state.version, 0);
	});

	// Running twice must not do the work twice, and the version is what normally stops it. This
	// is the property that makes the seed safe to run again after a failed save.
	it("changes nothing the second time", () => {
		const notes = [{ project: "monk-mode", pinned: 3, dirty: 144 }];
		const once = applyLegacyNotes(emptyMachineState(), notes);
		const twice = applyLegacyNotes(once, notes);
		assert.deepEqual(twice, once);
	});

	// The seed only ever fills a gap, so a rank the user set after the upgrade is not something
	// a leftover note can take back.
	it("never overwrites a rank or a count that already has a value", () => {
		const current: MachineState = {
			version: STATE_VERSION,
			pins: { "monk-mode": 1 },
			previousDirty: { "monk-mode": 0 },
			summaries: { "monk-mode": { generatedAt: "2026-10-01T00:00:00.000Z", commit: "newer", dirtyCount: 5 } },
		};
		const state = applyLegacyNotes(current, [
			{
				project: "monk-mode",
				pinned: 3,
				dirty: 144,
				summary: { ai_generated: true, generated_at: "2026-09-30T10:00:00.000Z", commit: "abc1234" },
			},
		]);

		assert.equal(state.pins["monk-mode"], 1);
		assert.equal(state.previousDirty["monk-mode"], 0);
		assert.equal(state.summaries["monk-mode"].commit, "newer");
	});

	it("ignores a note whose project name is empty", () => {
		// The caller falls back to the filename, so an empty name means it had neither, and a
		// key of "" would collide with every other nameless note.
		const state = applyLegacyNotes(emptyMachineState(), [{ project: "", pinned: 3, dirty: 144 }]);
		assert.deepEqual(state.pins, {});
		assert.deepEqual(state.previousDirty, {});
	});

	it("ignores pin and dirty values that are not what they claim to be", () => {
		const state = applyLegacyNotes(emptyMachineState(), [
			{ project: "zero", pinned: 0, dirty: 0 },
			{ project: "negative", pinned: -2, dirty: -1 },
			{ project: "text", pinned: "3", dirty: "144" },
			{ project: "fractional", pinned: 1.5, dirty: 0.5 },
			{ project: "absurd", pinned: 1e9, dirty: 1e9 },
			{ project: "nan", pinned: Number.NaN, dirty: Number.NaN },
		]);

		// A zero dirty count is a real fact and survives; a zero pin is not a rank and does not.
		assert.deepEqual(state.pins, {});
		assert.deepEqual(state.previousDirty, { zero: 0 });
	});

	it("reads pinned and dirty from a plain note and the stamp from a generated one", () => {
		const state = applyLegacyNotes(emptyMachineState(), [
			{ project: "api-ai", pinned: 1, dirty: 0, summary: null },
		]);
		assert.equal(state.pins["api-ai"], 1);
		assert.equal(state.summaries["api-ai"], undefined);
	});

	it("does not share record objects with the state it was given", () => {
		const current = emptyMachineState();
		const state = applyLegacyNotes(current, [{ project: "api-ai", pinned: 1 }]);
		assert.notEqual(state.pins, current.pins);
		assert.deepEqual(current.pins, {});
	});
});
