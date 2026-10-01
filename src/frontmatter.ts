/**
 * What the plugin writes into a note's frontmatter, and how it merges it.
 *
 * Imports carry explicit `.ts` extensions, unlike the Obsidian-facing modules.
 * That is what lets `node --test` load this file directly, with no bundler: node
 * resolves a path ending in `.ts` and leaves the rest alone. tsconfig sets
 * `allowImportingTsExtensions` and esbuild resolves it without complaint.
 *
 * Nothing here imports `obsidian`, for the same reason.
 */
import { isoDate, relativeAge } from "./format.ts";
import { toWebUrl } from "./git.ts";
import type { FrontmatterPatch, ProjectFrontmatter, RepoFacts, ScoreResult } from "./types";

/** Keys this plugin owns. Anything else in the frontmatter is the user's. */
const MANAGED_KEYS = [
	"project",
	"repo_path",
	"remote",
	"remote_raw",
	"web",
	"github",
	"pinned",
	"last_commit",
	"last_commit_rel",
	"dirty",
	"branch",
	"score",
	"status",
] as const;

/**
 * The frontmatter we want for a project, right now.
 *
 * Each key carries one of three states, and telling them apart is the whole
 * point:
 *
 * - a value: write it.
 * - `null`: definitively absent. Remove the key.
 * - `undefined`: this scan could not determine the value. Leave the key alone.
 *
 * Skipping `undefined` is what stops a transient git failure from erasing good
 * data. It is also how a stale key used to live forever: a repo that lost its
 * remote kept the old URL on disk, because "there is no remote" and "the probe
 * failed" were both spelled `undefined` and therefore both ignored.
 *
 * `now` is the clock the relative age is measured against, passed in so a scan
 * has one consistent time across the score and the note.
 */
export function desiredFrontmatter(
	facts: RepoFacts,
	score: ScoreResult,
	pin: number,
	now: number = Date.now(),
): ProjectFrontmatter {
	// Nothing git reported this scan can be believed, so nothing git reported gets
	// written. Writing it would record a dirty count of 0 and a score built on a
	// commit date we never read. The two values below come from the note and the
	// user's own pin, not from git, so they still hold.
	if (!facts.gitReadable) {
		return { project: facts.name, pinned: pin > 0 ? pin : 0 };
	}

	const web = toWebUrl(facts.remote);

	return {
		project: facts.name,
		repo_path: facts.path,
		// The value people click, so it has to open in a browser. Obsidian reads
		// `git@github.com:owner/repo.git` as a mailto address and hands it to a mail
		// client, which is how a GitHub remote ended up opening Gmail.
		remote: web ?? facts.remote ?? null,
		// What git says, byte for byte, so the rewrite above loses nothing.
		remote_raw: facts.remote ?? null,
		// The browser URL on its own key. Null for anything that is not a GitHub
		// remote: a GitLab remote stays a GitLab remote rather than becoming a
		// github.com link to whatever shares its name.
		web: web ?? null,
		// The owner/repo slug, unchanged. Left exactly as parseGithubSlug has always
		// reported it because something outside this repo may already read it.
		github: facts.github ?? null,
		// Always written, including 0. Skipping the key when unpinned would leave a
		// stale rank on disk forever, because unpinning only changes it to 0.
		pinned: pin > 0 ? pin : 0,
		last_commit: isoDate(facts.lastCommit) ?? null,
		last_commit_rel: relativeAge(facts.lastCommit, now),
		dirty: facts.dirtyCount,
		branch: facts.branch ?? null,
		score: score.score,
		status: score.status,
	};
}

/**
 * Compare managed keys between what's on disk and what we want.
 * Returns the drifted keys only, so unchanged values are left alone.
 *
 * A desired `undefined` means "this scan does not know", and the key is skipped.
 * A desired `null` means "this key should not exist" and is returned so the caller
 * deletes it. Without that second state a key can never be removed once written.
 */
export function diffManaged(current: ProjectFrontmatter, desired: ProjectFrontmatter): FrontmatterPatch {
	const patch: Record<string, unknown> = {};
	const source = current as Record<string, unknown>;

	for (const key of MANAGED_KEYS) {
		const want = (desired as Record<string, unknown>)[key];
		const have = source[key];
		if (want === undefined) continue; // Unknown this scan. Leave what is there.
		if (have === want) continue;
		patch[key] = want; // null lands here and means delete.
	}
	return patch as FrontmatterPatch;
}

/**
 * Apply a patch to the frontmatter object Obsidian hands us.
 *
 * `null` deletes the key rather than assigning null, because Obsidian serializes
 * this object back to YAML and a real null would be written out as the literal
 * text `null` instead of removing the line.
 */
export function applyFrontmatterPatch(fm: Record<string, unknown>, patch: FrontmatterPatch): void {
	for (const [key, value] of Object.entries(patch)) {
		if (value === null) delete fm[key];
		else fm[key] = value;
	}
}

/** Exported for tests: the keys this plugin will overwrite or remove. */
export const MANAGED_KEY_NAMES: readonly string[] = MANAGED_KEYS;