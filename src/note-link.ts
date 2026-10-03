/**
 * Which note, if any, belongs to which project.
 *
 * The plugin stopped creating one note per project, so a note is now something a person has
 * written. Two ways a note can claim a project, and a third that guesses:
 *
 * 1. `tracked: <project name>` in its frontmatter. Explicit, survives a rename, and works
 *    before any note is named after the project at all.
 * 2. `tracked: true` in the frontmatter of a note named after the project.
 * 3. A note in the vault whose filename is the project's name, marked or not.
 *
 * The fallback is doing real work for the notes that already exist, and it is the acknowledged
 * risk of the whole approach: 45 repositories and a vault full of notes will produce accidental
 * matches. It is still the last resort rather than the rule, because requiring frontmatter on 45
 * notes nobody asked for would mean nothing links to them on the day they upgrade.
 *
 * No `obsidian` import, so `node --test` loads this directly.
 */
import { sanitizeBase } from "./summary.ts";

/** One markdown note in the vault, as far as note matching cares. */
export interface NoteCandidate {
	/** Vault-relative path, used for the link. */
	path: string;
	/** Filename without the extension. */
	basename: string;
	/** True when the note's own frontmatter says `tracked: true`. */
	tracked: boolean;
	/**
	 * The project this note claims, when its frontmatter says one: `tracked: api-ai`.
	 *
	 * A separate slot from `tracked` because a bare `true` cannot say which project it means, and
	 * a marker that cannot identify its subject is not an override, it is a tie-break. This is the
	 * form that survives renaming the note.
	 */
	tracks: string | null;
}

/**
 * The note for one project, or null when it has none.
 *
 * Tried in three steps, each strictly more willing to guess:
 *
 * 1. A note whose frontmatter names this project (`tracked: api-ai`). Explicit, and the only
 *    form that survives renaming the note.
 * 2. A note named after the project whose frontmatter says `tracked: true`. Somebody marked this
 *    note as belonging to the project it is named after.
 * 3. A note named after the project, marked or not.
 *
 * Among notes that qualify for a step, the one marked `tracked` wins, then the one nearest the
 * vault root, then the first alphabetically. All three tie-breaks exist because the result is a
 * link somebody will click: a note that depends on directory iteration order is a link that opens
 * the wrong thing once in a while, which is worse than no link.
 */
export function resolveProjectNote(
	projectName: string,
	candidates: readonly NoteCandidate[],
): NoteCandidate | null {
	const wanted = comparableName(projectName);
	if (wanted === "") return null;

	const claimed = candidates.filter((candidate) => candidate.tracks !== null && comparableName(candidate.tracks) === wanted);
	if (claimed.length > 0) return [...claimed].sort(compareCandidates)[0];

	const named = candidates.filter((candidate) => comparableName(candidate.basename) === wanted);
	if (named.length === 0) return null;

	return [...named].sort(compareCandidates)[0];
}

/**
 * Two notes claiming the same project: tracked first, then shallowest, then alphabetical.
 *
 * Exported for the tests rather than kept private, because these are the tie-breaks that decide
 * which link a user ends up following and there is nothing else to check them against.
 */
export function compareCandidates(a: NoteCandidate, b: NoteCandidate): number {
	if (a.tracked !== b.tracked) return a.tracked ? -1 : 1;
	const depth = depthOf(a.path) - depthOf(b.path);
	if (depth !== 0) return depth;
	return a.path.localeCompare(b.path);
}

/**
 * A filename and a project name reduced to the same thing.
 *
 * Both sides go through `sanitizeBase`, because that is what decided the name a generated note
 * would have had, and a project called `foo/bar` is not going to be matched by a note called
 * `foo-bar` by accident of a difference the plugin introduced. Case is folded because a project
 * directory and a note filename disagree about case on macOS and Windows without the user doing
 * anything wrong.
 */
function comparableName(name: string): string {
	return sanitizeBase(name).toLowerCase();
}

/** How many folders deep a vault path is. */
function depthOf(path: string): number {
	return path.split("/").length;
}
