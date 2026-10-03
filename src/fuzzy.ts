/**
 * Fuzzy subsequence matching for the project filter.
 *
 * Written here rather than pulled in as a dependency because the whole
 * requirement is "type a few letters, see the projects that could be meant",
 * which is about eighty lines, and because the ranking rules here are the point
 * rather than an implementation detail: the panel otherwise ranks by score, and a
 * filter that reorders by somebody else's idea of relevance fights that.
 *
 * The ranking, in plain words. Every matched character earns the same base
 * points, and then:
 *
 *  - A character that starts a word is worth more than one in the middle of a
 *    word. A word starts at the beginning of the name, after `-`, `_`, `.`, `/`
 *    or a space, and at a hump in camelCase. That is why "cr" finds
 *    "ClientRadar" and not just a scattered c...r.
 *  - The query's *first* character is worth more at a word start than the later
 *    characters are: typing "cl" means "ClientRadar", not "Calculator".
 *  - A character that continues the previous match is worth more than one that
 *    does not, so "api" prefers "api-server" over "a-p-i-something".
 *  - Every character skipped between two matches costs a little, so a match that
 *    has to cross the whole name loses to one where the letters sit together.
 *  - Every character of the name the query never uses costs a little, so between
 *    two equally good matches the tighter name wins.
 *
 * The best alignment is found by a small dynamic program rather than by taking
 * the leftmost match: leftmost is not the same as best when the query could start
 * at a word boundary further along. Names are short enough that the O(query x
 * name x name) cost is irrelevant, and it only runs on a keystroke over the
 * projects already in memory.
 *
 * `null` means the query is not a subsequence of the name at all, which is a
 * different answer from a poor match. A weak match is shown, dimmed; a missing
 * one is not shown at all. See `weakMatchThreshold`.
 */

/** Base points for every matched character, wherever it lands. */
const MATCH = 16;
/** Extra when the query's first character starts a word. */
const FIRST_BOUNDARY = 18;
/** Extra when a later character starts a word. */
const LATER_BOUNDARY = 10;
/** Extra for each character that continues the previous match. */
const CONSECUTIVE = 10;
/** Deducted per name character skipped between two matched ones. */
const GAP = 3;
/** Deducted per name character the query never matches, so tight names win ties. */
const SLACK = 1;

/**
 * How far below the best possible score a match may fall and still count as weak.
 *
 * A ratio rather than a fixed number, because the best possible score grows with
 * the query: a two-letter query has little room to be scattered, and a seven-letter
 * one can be scattered a lot without being wrong. Half is chosen because at half,
 * every match still has to be contiguous-ish, land on a word start, or both.
 *
 * Applies from two characters up. `weakMatchThreshold` exempts the one-character
 * query, where this ratio works against itself.
 */
export const WEAK_MATCH_RATIO = 0.5;

/**
 * Best score an alignment of this query could possibly reach.
 *
 * The score of a query that matches its whole name from the very first character,
 * which is attainable for any name without a separator in it. Names with
 * separators can land a boundary bonus on top of this, so the ceiling is not a
 * hard maximum; it is the reachable floor for "this query matched as well as it
 * possibly could", which is what the weak threshold needs to be measured against.
 */
export function bestPossibleScore(query: string): number {
	const length = query.trim().length;
	if (length === 0) return 0;
	return FIRST_BOUNDARY + length * MATCH + (length - 1) * CONSECUTIVE;
}

/** Score below which a match is too scattered to deserve a full-strength row. */
export function weakMatchThreshold(query: string): number {
	const length = query.trim().length;
	// A one-character query is exempt, and it has to be. There is no alignment to
	// judge when there is one character: the name contains it or it does not. Worse,
	// the ratio inverts for such a query. A single character earns no consecutive
	// bonus, so its entire ceiling is FIRST_BOUNDARY + MATCH, and half of that sits
	// one point above MATCH itself. Every mid-word single-character match scores at
	// most MATCH, so every one of them was dimmed however good it was, and typing "c"
	// greyed out almost the whole panel by construction.
	//
	// Rows still sort best match first, so the ordering carries the quality the dimming
	// used to; they just are not all dimmed.
	if (length <= 1) return 0;
	return bestPossibleScore(query) * WEAK_MATCH_RATIO;
}

/**
 * Score `text` against `query`, or null when the query is not a subsequence of it.
 *
 * Case-insensitive. A blank query returns null rather than a score, because
 * "no query" is not a search that matched everything badly: callers must decide
 * what a blank query means, and here it means nothing to score.
 */
export function fuzzyScore(query: string, text: string): number | null {
	const needle = query.trim().toLowerCase();
	if (needle.length === 0) return null;

	const haystack = text.toLowerCase();
	if (needle.length > haystack.length) return null;

	const boundaries = wordStarts(text);
	// Deducted, so the tighter name wins between two otherwise equal matches.
	// Negative, and added at the end, because "characters the query never used"
	// only means anything once the whole query has been placed.
	const slack = -SLACK * (haystack.length - needle.length);

	// `row[j]` is the best way to have matched `needle[0..i]` with `needle[i]`
	// landing on `haystack[j]`, or null when that is impossible. Only the previous
	// row is needed, so two rows are kept rather than a matrix.
	let row: Array<{ score: number } | null> = new Array<{ score: number } | null>(haystack.length).fill(null);

	for (let i = 0; i < needle.length; i++) {
		const next: Array<{ score: number } | null> = new Array<{ score: number } | null>(haystack.length).fill(null);
		// The i-th needle character cannot land before the i-th haystack one.
		for (let j = i; j < haystack.length; j++) {
			if (haystack[j] !== needle[i]) continue;

			let best: number | null = null;
			if (i === 0) {
				best = MATCH + (boundaries[j] ? FIRST_BOUNDARY : 0);
			} else {
				for (let k = i - 1; k < j; k++) {
					const prior = row[k];
					if (!prior) continue;
					const gap = j - k - 1;
					const score =
						prior.score + MATCH - GAP * gap + (gap === 0 ? CONSECUTIVE : 0) + (boundaries[j] ? LATER_BOUNDARY : 0);
					if (best === null || score > best) best = score;
				}
			}
			if (best !== null) next[j] = { score: best };
		}
		row = next;
	}

	let top: number | null = null;
	for (const cell of row) {
		if (cell && (top === null || cell.score > top)) top = cell.score;
	}
	return top === null ? null : Math.round(top + slack);
}

/**
 * Which positions in `text` begin a word.
 *
 * Read from the original casing rather than a lowercased copy, because a camelCase
 * hump only exists in the original.
 */
function wordStarts(text: string): boolean[] {
	const flags = new Array<boolean>(text.length).fill(false);
	for (let j = 0; j < text.length; j++) {
		if (j === 0) {
			flags[j] = true;
			continue;
		}
		const previous = text[j - 1];
		// Anything that is not a letter or a digit separates words. A character
		// class rather than a list of separators, so an unusual one like a `+`
		// counts instead of turning into a mid-word match.
		if (!/[a-z0-9]/i.test(previous)) {
			flags[j] = true;
			continue;
		}
		// A hump in camelCase is a word start. Tested as "differs from its own
		// lower case" rather than "is its own upper case", because a digit is its
		// own upper case and "s3" would then read as two words.
		if (text[j] !== text[j].toLowerCase() && previous !== previous.toUpperCase()) {
			flags[j] = true;
		}
	}
	return flags;
}
