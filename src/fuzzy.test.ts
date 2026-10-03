import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	bestPossibleScore,
	fuzzyScore,
	weakMatchThreshold,
	WEAK_MATCH_RATIO,
} from "./fuzzy.ts";

/** Score of a query against a name, failing the test instead of returning null. */
function score(query: string, text: string): number {
	const value = fuzzyScore(query, text);
	assert.ok(value !== null, `expected "${query}" to match "${text}"`);
	return value;
}

/**
 * Every query/name pair the tests below care about.
 *
 * Used by the brute force, so the pairs are short enough to enumerate: the worst
 * case is a query of 3 over a name of 12, which is a few hundred placements.
 */
const PAIRS: [string, string][] = [
	["api", "api-server"],
	["api", "a-p-i-worker"],
	["api", "api-documentation-archive"],
	["cr", "ClientRadar"],
	["cr", "camaraderie-rehearsal"],
	["aa", "aaa-a"],
	["at", "flat-map"],
	["s3", "s3-proxy"],
	["dbt", "dashboard-ui-kit"],
	["cl", "client-radar"],
];

/** The documented rules, spelled out independently of the implementation. */
function alignmentScore(query: string, text: string, at: number[]): number {
	let total = 0;
	for (let i = 0; i < query.length; i++) {
		total += 16; // MATCH
		const startsWord =
			at[i] === 0 || !/[a-z0-9]/i.test(text[at[i] - 1]) || text[at[i]] !== text[at[i]].toLowerCase();
		if (startsWord) total += i === 0 ? 18 : 10; // FIRST_BOUNDARY : LATER_BOUNDARY
		if (i > 0) {
			const gap = at[i] - at[i - 1] - 1;
			total -= 3 * gap; // GAP
			if (gap === 0) total += 10; // CONSECUTIVE
		}
	}
	total -= text.length - query.length; // SLACK
	return total;
}

/** Highest score over every in-order placement of the query in the name. */
function bruteForce(query: string, text: string): number | null {
	const lowerQuery = query.toLowerCase();
	const lowerText = text.toLowerCase();
	let best: number | null = null;
	const place = (index: number, chosen: number[]): void => {
		if (index === query.length) {
			const value = alignmentScore(lowerQuery, text, chosen);
			if (best === null || value > best) best = value;
			return;
		}
		for (let j = chosen.length === 0 ? 0 : chosen[chosen.length - 1] + 1; j < text.length; j++) {
			if (lowerText[j] !== lowerQuery[index]) continue;
			place(index + 1, [...chosen, j]);
		}
	};
	place(0, []);
	return best;
}

describe("what counts as a match", () => {
	it("matches a contiguous run", () => {
		assert.notEqual(fuzzyScore("api", "api-server"), null);
	});

	it("matches a subsequence in order", () => {
		assert.notEqual(fuzzyScore("aps", "api-server"), null);
	});

	it("does not match out of order", () => {
		// The difference between fuzzy and a plain substring search, and the thing
		// that makes a broken matcher feel broken rather than merely strict.
		assert.equal(fuzzyScore("sra", "server"), null);
		assert.equal(fuzzyScore("zz", "server"), null);
	});

	it("ignores case", () => {
		assert.equal(fuzzyScore("API", "api-server"), score("api", "api-server"));
		assert.notEqual(fuzzyScore("cr", "ClientRadar"), null);
	});

	it("treats a blank query as nothing to score", () => {
		// Not a match of everything at score zero: the caller decides what no
		// query means, because "no filter" and "matched nothing" are not the same.
		assert.equal(fuzzyScore("", "anything"), null);
		assert.equal(fuzzyScore("   ", "anything"), null);
		assert.equal(bestPossibleScore(""), 0);
	});

	it("cannot match a query longer than the name", () => {
		assert.equal(fuzzyScore("server", "api"), null);
	});
});

describe("ranking", () => {
	it("puts a word-boundary match above a mid-word one", () => {
		// Both are real matches for "at". In "atlas" the a starts the name; in
		// "flat-map" the a is the last letter of a word.
		assert.ok(score("at", "atlas") > score("at", "flat-map"));
	});

	it("puts a contiguous run above a scattered one", () => {
		assert.ok(score("api", "api-server") > score("api", "a-p-i-worker"));
	});

	it("puts a run together above one spread across the name", () => {
		assert.ok(score("api", "api-server") > score("api", "another-picky-instrument"));
	});

	it("prefers the tighter name when the match is otherwise equal", () => {
		// Same three letters, same boundary, but one name is mostly matched. This is
		// what keeps "api" from putting "api-documentation-archive" above "api".
		assert.ok(score("api", "api") > score("api", "api-documentation-archive"));
	});

	it("weighs the query's first character at a word start more than its last", () => {
		// "cl" typed by a person means ClientRadar. Both names start with a word,
		// so the difference has to come from where the *first* character lands.
		const boundaries = score("cl", "client-radar");
		const scattered = score("cl", "c-l-library");
		assert.ok(boundaries > scattered, `${boundaries} !> ${scattered}`);
	});

	it("does not let a run in the middle outrank a run at the front", () => {
		// The leftmost alignment is not always the best one, and this is the pair
		// that shows it: in "aaa-a" the leftmost a...a is a scattered match, while
		// the a after the dash starts a word and wins.
		assert.ok(score("aa", "aaa-a") > score("aa", "aaa-aaa"));
	});

	it("scores the best alignment, not the leftmost one", () => {
		// A brute force over every way of placing the query, scored by the documented
		// rules, as the reference the dynamic program has to agree with. If the
		// program ever degenerates to "take the first match that works", this fails.
		for (const [query, text] of PAIRS) {
			assert.equal(fuzzyScore(query, text), bruteForce(query, text), `${query} in ${text}`);
		}
	});

	it("finds a camelCase hump as a word start", () => {
		// ClientRadar on the real disk. Without hump detection "cr" would have to
		// scatter across the whole name.
		assert.ok(score("cr", "ClientRadar") > score("cr", "camaraderie-rehearsal"));
	});

	it("counts an unusual separator as a word start too", () => {
		// The separator check is a character class, not a list, so this is a word
		// start rather than a mid-word character.
		assert.ok(score("ab", "a+b") > score("ab", "acb"));
	});

	it("reaches the best possible score when the query is the whole name", () => {
		// The ceiling the weak threshold is measured against, so the ratio below is
		// only meaningful if a perfect match actually attains it. Names with no
		// separator in them, because a separator costs a run bonus and wins a
		// boundary one that the ceiling does not count.
		for (const name of ["api", "s3", "monkmode"]) {
			assert.equal(score(name, name), bestPossibleScore(name), `for ${name}`);
		}
	});
});

describe("weak matches", () => {
	it("scores a scattered match below the weak threshold", () => {
		// d-b-t across "dashboard-ui-kit": two of the three characters are
		// mid-word and the last one is fifteen characters away from the second.
		const scattered = score("dbt", "dashboard-ui-kit");
		assert.ok(
			scattered < weakMatchThreshold("dbt"),
			`${scattered} should be under ${weakMatchThreshold("dbt")}`,
		);
	});

	it("scores a contiguous match above the weak threshold", () => {
		assert.ok(score("dash", "dashboard-ui-kit") > weakMatchThreshold("dash"));
	});

	it("thresholds at the documented ratio of the best possible score", () => {
		// A one-letter query has almost no room to be scattered, and a seven-letter
		// one has plenty, which is why the threshold scales instead of being a
		// fixed number.
		assert.equal(weakMatchThreshold("a"), bestPossibleScore("a") * WEAK_MATCH_RATIO);
		assert.ok(weakMatchThreshold("dashboard") > weakMatchThreshold("d"));
	});

	it("keeps the threshold above zero for every non-empty query", () => {
		// Otherwise a one-letter query would make every match weak.
		for (const query of ["a", "d", "cr", "api"]) {
			assert.ok(weakMatchThreshold(query) > 0, `zero threshold for ${query}`);
		}
	});
});
