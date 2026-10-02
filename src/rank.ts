import type { RepoFacts, ScorePart, ScoreResult, ScoreWeights } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * What the score model weighs, as it was when it was written.
 *
 * Defaults rather than constants now: the log curve's shape and the 25 points
 * for a non-default branch were both chosen by feel and neither survives being
 * handed to the user as a slider. Every function here takes the weights as a
 * parameter so the settings tab, a test, and a caller that does not care can all
 * use the same code with different numbers.
 */
export const DEFAULT_WEIGHTS: ScoreWeights = {
	/** Points at the top of the uncommitted-change curve. Reached at `dirtySaturation` files. */
	dirty: 40,
	/** Files at which the uncommitted-change points saturate at `dirty`. */
	dirtySaturation: 32,
	nonDefaultBranch: 25,
	recentCommit: 30,
	recentCommitWindowDays: 7,
	staleCommit: 15,
	staleCommitWindowDays: 30,
	freshDir: 10,
	freshDirWindowDays: 2,
};

/** What a slider may be set to. Minimums are 1 where a zero would break a formula. */
interface WeightBounds {
	min: number;
	max: number;
	step: number;
}

/**
 * Bounds for each weight, in the order the settings tab shows them.
 *
 * The two window minimums of 1 are load-bearing rather than fussy: the dirty
 * curve divides by log2(1 + dirtySaturation) and the recency curve divides by
 * its window, so a zero there is a division by zero rather than a small score.
 */
export const WEIGHT_BOUNDS = {
	dirty: { min: 0, max: 100, step: 5 },
	dirtySaturation: { min: 1, max: 200, step: 1 },
	nonDefaultBranch: { min: 0, max: 100, step: 5 },
	recentCommit: { min: 0, max: 100, step: 5 },
	recentCommitWindowDays: { min: 1, max: 90, step: 1 },
	staleCommit: { min: 0, max: 100, step: 5 },
	staleCommitWindowDays: { min: 1, max: 365, step: 5 },
	freshDir: { min: 0, max: 100, step: 5 },
	freshDirWindowDays: { min: 0, max: 30, step: 1 },
} as const satisfies Record<keyof ScoreWeights, WeightBounds>;

/** Setting names, in the order the sliders appear. */
export const WEIGHT_KEYS = Object.keys(WEIGHT_BOUNDS) as (keyof ScoreWeights)[];

/**
 * What each weight means, for the slider's label.
 *
 * Written here next to the number rather than in the settings tab, so the
 * explanation of the model lives in the model.
 */
export const WEIGHT_LABELS: Record<keyof ScoreWeights, string> = {
	dirty: "Points for uncommitted work",
	dirtySaturation: "Files where uncommitted points saturate",
	nonDefaultBranch: "Points for being on a non-default branch",
	recentCommit: "Points for a commit today",
	recentCommitWindowDays: "Days a commit counts as recent",
	staleCommit: "Points for a commit fading out of the recent window",
	staleCommitWindowDays: "Days before a commit stops counting, and a project counts as dormant",
	freshDir: "Points for a recently touched folder",
	freshDirWindowDays: "Days a folder counts as recently touched",
};

/**
 * Turn whatever was in `data.json` into a usable set of weights.
 *
 * `data.json` is a file a person can edit, so every field here is treated as
 * hostile: a missing weight keeps its default, a non-number keeps its default, and
 * a number outside the slider's range is pulled back inside it. A scoring model
 * that quietly reads NaN for half its rules is worse than one that ignores the
 * edit.
 *
 * Always returns a new object, never the defaults themselves, so a caller cannot
 * mutate the defaults by writing to its own settings.
 */
export function sanitizeWeights(loaded: unknown): ScoreWeights {
	const source = (loaded ?? {}) as Partial<Record<keyof ScoreWeights, unknown>>;
	const weights: ScoreWeights = { ...DEFAULT_WEIGHTS };

	for (const key of WEIGHT_KEYS) {
		const value = source[key];
		// Only a real, finite number is accepted. `Number("")`, `Number(null)` and
		// `Number(false)` are all 0, so a numeric cast would turn one stray null in
		// a hand-edited data.json into a silently zeroed weight.
		if (typeof value !== "number" || !Number.isFinite(value)) continue;
		const { min, max } = WEIGHT_BOUNDS[key];
		weights[key] = Math.min(max, Math.max(min, Math.round(value)));
	}
	return weights;
}

/** Days since an ISO date, or null when the date is unparseable/absent. */
export function ageInDays(iso: string | null, now: number): number | null {
	if (!iso) return null;
	const time = Date.parse(iso);
	if (Number.isNaN(time)) return null;
	return (now - time) / DAY_MS;
}

/**
 * Uncommitted-change points on a log scale, capped at the full dirty weight.
 *
 * A flat weight made 1 changed file score the same as 144, which collapsed the
 * top of the ranking into alphabetical order. log2 spreads small counts apart
 * and grows slowly, so meaningful effort registers without letting one enormous
 * working tree dominate the list. Saturates at `dirtySaturation` files.
 */
export function dirtyPoints(dirtyCount: number, weights: ScoreWeights = DEFAULT_WEIGHTS): number {
	if (dirtyCount <= 0) return 0;
	// Floored at 1 because this divides by log2(1 + saturation). The sanitizer
	// enforces the same floor; this keeps the function safe on its own.
	const saturation = Math.max(1, weights.dirtySaturation);
	const t = Math.log2(1 + dirtyCount) / Math.log2(1 + saturation);
	return Math.round(weights.dirty * Math.min(1, t));
}

/**
 * Recency points, decaying to zero at each window edge.
 *
 * 0-7 days earns up to 30, fading linearly to 0. Beyond 7 days it switches to a
 * smaller 15-point budget that fades to 0 at 30 days. Past 30 days the commit
 * contributes nothing at all, which with no other live work makes the project
 * dormant. Age alone never makes a project dormant: see `scoreRepo`.
 */
export function recencyPoints(ageDays: number | null, weights: ScoreWeights = DEFAULT_WEIGHTS): number {
	if (ageDays === null) return 0;
	if (ageDays <= 0) return weights.recentCommit;
	// Floored for the same reason as the dirty curve: the recent window is a
	// divisor. Clamping it up can only widen the stale span, never invert it.
	const recentWindow = Math.max(1, weights.recentCommitWindowDays);
	if (ageDays <= recentWindow) {
		const t = ageDays / recentWindow;
		return weights.recentCommit * (1 - t);
	}
	if (ageDays <= weights.staleCommitWindowDays) {
		const span = weights.staleCommitWindowDays - recentWindow;
		const t = (ageDays - recentWindow) / span;
		return weights.staleCommit * (1 - t);
	}
	return 0;
}

/**
 * Score a repo's facts. Deterministic and offline: no LLM, no network.
 *
 * `now` is injectable so tests and the view can pass a single consistent clock,
 * and `weights` so the settings tab can change the model without a code change.
 * Both default, so every existing call site keeps working unchanged.
 */
export function scoreRepo(
	facts: RepoFacts,
	now = Date.now(),
	weights: ScoreWeights = DEFAULT_WEIGHTS,
): ScoreResult {
	const parts: ScorePart[] = [];
	const ageDays = ageInDays(facts.lastCommit, now);
	const dirAgeDays = facts.dirMtime > 0 ? (now - facts.dirMtime) / DAY_MS : null;

	const dirty = dirtyPoints(facts.dirtyCount, weights);
	if (dirty > 0) {
		parts.push({ label: `${facts.dirtyCount} uncommitted`, points: dirty });
	}
	// Every part is guarded on its own points rather than only on the condition
	// that produced it. A weight the user has dragged to 0 must drop out of the
	// explanation entirely, or the row would say "0 on jonaz" as a reason for its
	// score.
	const branchPoints = facts.onNonDefaultBranch ? weights.nonDefaultBranch : 0;
	if (branchPoints > 0) {
		parts.push({ label: `on ${facts.branch}`, points: branchPoints });
	}

	const recency = recencyPoints(ageDays, weights);
	if (recency > 0) {
		const days = ageDays === null ? 0 : Math.round(ageDays);
		parts.push({ label: days === 0 ? "committed today" : `commit ${days}d ago`, points: recency });
	}

	if (dirAgeDays !== null && dirAgeDays <= weights.freshDirWindowDays && weights.freshDir > 0) {
		parts.push({ label: "touched recently", points: weights.freshDir });
	}

	const score = Math.round(parts.reduce((total, part) => total + part.points, 0));

	// A stale commit is not by itself evidence that a project is abandoned.
	// Uncommitted changes or a non-default branch are evidence of live work, and
	// they keep the project active no matter how long ago the last commit landed:
	// a project with 79 unshipped files waiting behind an old commit is the most
	// active thing on the disk, not a dormant one. Only a project with no live
	// work and no recent commit goes dormant.
	//
	// A repo with no commits yet has no commit age to judge, so its status falls
	// back to filesystem activity. A brand new `git init` should read as active;
	// an abandoned one goes dormant once the directory stops being touched.
	const hasLiveWork = facts.dirtyCount > 0 || facts.onNonDefaultBranch;
	const inactiveDays = ageDays ?? dirAgeDays;
	const status =
		!hasLiveWork && inactiveDays !== null && inactiveDays > weights.staleCommitWindowDays
			? "dormant"
			: "active";

	return { score, status, parts };
}

/**
 * The score in words, for a tooltip and for the "why this score" line.
 *
 * Built from `parts` rather than by recomputing the rules, so the explanation
 * cannot drift from the number it explains. One function for both surfaces
 * because two different sentences for the same score is how they start
 * disagreeing.
 */
export function describeScore(score: ScoreResult): string {
	if (score.parts.length === 0) {
		return `Score ${score.score}: nothing is scoring. Clean tree, default branch, and nothing recent.`;
	}
	const breakdown = score.parts.map((part) => `${part.points} ${part.label}`).join(", ");
	return `Score ${score.score}: ${breakdown}.`;
}

/**
 * Order projects: pinned first in the user's order, then by score, then by name.
 *
 * Two layers, never blended. A pin of 0 means unpinned and sorts below every
 * pinned project regardless of score.
 */
export function rankProjects<T extends { pin: number; score: ScoreResult; facts: RepoFacts }>(
	projects: T[],
): T[] {
	return [...projects].sort((a, b) => {
		const aPinned = a.pin > 0;
		const bPinned = b.pin > 0;
		if (aPinned !== bPinned) return aPinned ? -1 : 1;
		if (aPinned && bPinned && a.pin !== b.pin) return a.pin - b.pin;
		if (a.score.score !== b.score.score) return b.score.score - a.score.score;
		return a.facts.name.localeCompare(b.facts.name);
	});
}