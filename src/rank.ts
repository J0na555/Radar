import { RepoFacts, ScorePart, ScoreResult } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

export const WEIGHTS = {
	dirty: 40,
	nonDefaultBranch: 25,
	recentCommit: 30,
	recentCommitWindowDays: 7,
	staleCommit: 15,
	staleCommitWindowDays: 30,
	freshDir: 10,
	freshDirWindowDays: 2,
} as const;

/** Days since an ISO date, or null when the date is unparseable/absent. */
function ageInDays(iso: string | null, now: number): number | null {
	if (!iso) return null;
	const time = Date.parse(iso);
	if (Number.isNaN(time)) return null;
	return (now - time) / DAY_MS;
}

/**
 * Recency points, decaying to zero at each window edge.
 *
 * 0-7 days earns up to 30, fading linearly to 0. Beyond 7 days it switches to a
 * smaller 15-point budget that fades to 0 at 30 days. Past 30 days the commit
 * contributes nothing at all and the project is dormant.
 */
export function recencyPoints(ageDays: number | null): number {
	if (ageDays === null) return 0;
	if (ageDays <= 0) return WEIGHTS.recentCommit;
	if (ageDays <= WEIGHTS.recentCommitWindowDays) {
		const t = ageDays / WEIGHTS.recentCommitWindowDays;
		return WEIGHTS.recentCommit * (1 - t);
	}
	if (ageDays <= WEIGHTS.staleCommitWindowDays) {
		const span = WEIGHTS.staleCommitWindowDays - WEIGHTS.recentCommitWindowDays;
		const t = (ageDays - WEIGHTS.recentCommitWindowDays) / span;
		return WEIGHTS.staleCommit * (1 - t);
	}
	return 0;
}

/**
 * Score a repo's facts. Deterministic and offline: no LLM, no network.
 *
 * `now` is injectable so tests and the view can pass a single consistent clock.
 */
export function scoreRepo(facts: RepoFacts, now = Date.now()): ScoreResult {
	const parts: ScorePart[] = [];
	const ageDays = ageInDays(facts.lastCommit, now);
	const dirAgeDays = facts.dirMtime > 0 ? (now - facts.dirMtime) / DAY_MS : null;

	if (facts.dirtyCount > 0) {
		parts.push({ label: `${facts.dirtyCount} uncommitted`, points: WEIGHTS.dirty });
	}
	if (facts.onNonDefaultBranch) {
		parts.push({ label: `on ${facts.branch}`, points: WEIGHTS.nonDefaultBranch });
	}

	const recency = recencyPoints(ageDays);
	if (recency > 0) {
		const days = ageDays === null ? 0 : Math.round(ageDays);
		parts.push({ label: days === 0 ? "committed today" : `commit ${days}d ago`, points: recency });
	}

	if (dirAgeDays !== null && dirAgeDays <= WEIGHTS.freshDirWindowDays) {
		parts.push({ label: "touched recently", points: WEIGHTS.freshDir });
	}

	const score = Math.round(parts.reduce((total, part) => total + part.points, 0));

	// A repo with no commits yet has no commit age to judge, so its status falls
	// back to filesystem activity. A brand new `git init` should read as active;
	// an abandoned one goes dormant once the directory stops being touched.
	const inactiveDays = ageDays ?? dirAgeDays;
	const status = inactiveDays !== null && inactiveDays > WEIGHTS.staleCommitWindowDays ? "dormant" : "active";

	return { score, status, parts };
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