/**
 * Cheap health signals about a repo, for the ones worth warning about.
 *
 * Every signal here costs one extra git call at most, and none of them is a
 * judgement about the work. They are the things that are easy to forget: an
 * uncommitted pile that has survived more than one scan, a branch nobody has
 * touched since it was cut, work somebody deliberately parked in a stash, work
 * that exists on exactly one machine.
 *
 * A signal that always fires is noise, so each of these has to be a condition
 * rather than a fact. If the panel is showing the same badge on every row, the
 * badge is wrong.
 *
 * No `obsidian` import, so `node --test` loads this directly.
 */
import { relativeAge } from "./format.ts";
import { ageInDays, WEIGHTS } from "./rank.ts";
import type { HealthSignal, RepoFacts } from "./types.ts";

/**
 * Uncommitted files that count as a pile rather than a day's work.
 *
 * 32, because that is where the scoring curve already saturates: past this many
 * files the score stops rewarding more, so the warning starts exactly where the
 * ranking has stopped caring. One constant, two features, no second opinion.
 */
export const SUSTAINED_DIRTY_THRESHOLD = 32;

export type { HealthSignal };

/**
 * "1 commit" rather than "1 commits".
 *
 * Both forms passed in rather than guessed: `stash` does not pluralise by adding
 * an s, and a health warning that says "2 stashs" is worse than no warning.
 */
function count(count: number, singular: string, pluralForm: string): string {
	return `${count} ${count === 1 ? singular : pluralForm}`;
}

/**
 * A working tree that was already a pile last scan.
 *
 * Two scans, not a time series. The previous scan's dirty count is already
 * persisted in the project note's `dirty` frontmatter, written on every scan, so
 * "sustained" costs nothing extra to detect and no history file has to exist.
 * That also bounds the claim honestly: it means "this has survived at least one
 * scan", which for a panel scanned every morning is a week, and for one opened
 * once a month is a day. Neither is worse than what the alternative would cost.
 */
function sustainedDirty(facts: RepoFacts, previousDirtyCount: number | null): HealthSignal | null {
	if (facts.dirtyCount < SUSTAINED_DIRTY_THRESHOLD) return null;
	// No recorded previous count means this is the first scan that has seen this
	// repo, which is not evidence of anything.
	if (previousDirtyCount === null || previousDirtyCount < SUSTAINED_DIRTY_THRESHOLD) return null;

	return {
		id: "sustained-dirty",
		badge: "dirty",
		detail: `${facts.dirtyCount} uncommitted files, and ${previousDirtyCount} at the last scan. This has been going on for more than one scan.`,
	};
}

/**
 * A feature branch with nothing committed to it for a long time.
 *
 * The same 30 days that decides whether a project counts as dormant, so the
 * panel never disagrees with itself about what "stale" means. Needs no extra git
 * call: the branch and the last commit date are already read for the score.
 */
function longLivedBranch(facts: RepoFacts, now: number): HealthSignal | null {
	if (!facts.onNonDefaultBranch || facts.branch === null) return null;
	const ageDays = ageInDays(facts.lastCommit, now);
	// No commit date means a repo with no commits, which is new rather than stale.
	if (ageDays === null || ageDays <= WEIGHTS.staleCommitWindowDays) return null;

	return {
		id: "long-branch",
		badge: "branch",
		detail: `On ${facts.branch}, and the last commit anywhere on it is ${relativeAge(facts.lastCommit, now)}. That is past the ${WEIGHTS.staleCommitWindowDays}-day line this panel uses for everything else.`,
	};
}

/**
 * Work parked in a stash.
 *
 * A stash is a deliberate act, which is exactly why it gets forgotten: nothing
 * in the working tree changes, no branch points at it, and the only sign is the
 * reflog. One repo on this machine has one.
 */
function stashedWork(facts: RepoFacts): HealthSignal | null {
	// null means the probe failed, which is not evidence of a clean stash list.
	if (facts.stashCount === null || facts.stashCount <= 0) return null;

	return {
		id: "stashed",
		badge: "stash",
		detail: `${count(facts.stashCount, "stash", "stashes")} on this repo. Stashed work is in no branch and no working tree, so nothing else will mention it again. Run git stash list in the folder.`,
	};
}

/**
 * Commits that exist on this machine and nowhere else.
 *
 * The one signal with no real example to point at: nothing on this machine is
 * unpushed today, so this has never fired here. It is cheap, so it ships, but it
 * is the part of this feature that should be watched rather than trusted.
 */
function unpushedCommits(facts: RepoFacts): HealthSignal | null {
	if (facts.unpushedCount === null || facts.unpushedCount <= 0) return null;

	return {
		id: "unpushed",
		badge: "unpushed",
		detail: `${count(facts.unpushedCount, "commit", "commits")} on this branch that the upstream does not have. No other copy exists, so a lost disk loses them.`,
	};
}

/**
 * Every signal that fires for one repo.
 *
 * The plan's order: the two that need no extra git call come first, then the two
 * that cost one. Left as given rather than sorted by my own idea of urgency,
 * because a badge ordering is a preference and the plan already made it.
 */
export function healthSignals(
	facts: RepoFacts,
	previousDirtyCount: number | null,
	now: number,
): HealthSignal[] {
	// Nothing git reports about this repo can be believed, so there is nothing to
	// warn about. A failed scan must not leave last scan's warnings on screen
	// either: they were true of a repo nobody could read this time.
	if (!facts.gitReadable) return [];

	const signals = [
		sustainedDirty(facts, previousDirtyCount),
		longLivedBranch(facts, now),
		stashedWork(facts),
		unpushedCommits(facts),
	];
	return signals.filter((signal): signal is HealthSignal => signal !== null);
}