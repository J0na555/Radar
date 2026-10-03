/**
 * The plugin's own state, as it sits in data.json: pin ranks, the previous scan's dirty
 * counts, and what each AI summary was written from.
 *
 * All three used to live in note frontmatter, and all three moved for one reason. They
 * are written on every scan and never hand-edited by the user, which makes them machine
 * state rather than note content, and they belong somewhere the user cannot delete by
 * rewriting a note. A user who tidied their vault lost their pin order along with it.
 *
 * Every reader here treats the stored value as hostile, because data.json is a file a
 * person can edit: `sanitizeMachineState` drops anything that is not the right shape
 * rather than letting it reach the panel. The model is the same one `sanitizeWeights`
 * uses for the score weights, and for the same reason: half a ranking reading NaN is worse
 * than ignoring the edit.
 *
 * No `obsidian` import, deliberately: `node --test` cannot load that package, so a module
 * that imports it is a module with no tests. Same rule as `pin-queue.ts`.
 */
import { detectStale } from "./summary.ts";
import type { MachineState, RepoFacts, SummaryRecord, SummaryState } from "./types.ts";

/**
 * Layout version of the persisted state.
 *
 * Bumping this re-runs the legacy seed, which only ever fills in what is missing, so a
 * future change to the shape costs a rescan and nothing else. It is a guard on the shape,
 * not a migration ledger: there is no per-version step to keep in step with it.
 */
export const STATE_VERSION = 1;

/**
 * The largest pin rank and dirty count accepted from disk.
 *
 * Ranks are the user's own integers and the menu grows them by one, so there is no natural
 * ceiling; this one exists only so a hand-edited `1e308` cannot be stored and read back as
 * a number no comparison behaves sensibly on. It is far above anything real.
 */
export const MAX_PIN_RANK = 1_000_000;
export const MAX_DIRTY_COUNT = 1_000_000;

/** Keys that must never be written into a record read from `data.json`. */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Machine state for a plugin that has stored nothing yet. */
export function emptyMachineState(): MachineState {
	return { version: 0, pins: {}, previousDirty: {}, summaries: {} };
}

/**
 * Turn whatever was in `data.json` into usable state.
 *
 * Always returns fresh objects, never `emptyMachineState()` itself, so a caller cannot
 * reach back into the defaults through its own settings the way a shared nested object
 * allows. Version is preserved from the file rather than forced forward: a load must not
 * quietly mark an unseeded upgrade as done.
 */
export function sanitizeMachineState(loaded: unknown): MachineState {
	const source = isRecord(loaded) ? loaded : {};
	return {
		version: typeof source.version === "number" && Number.isFinite(source.version) ? Math.floor(source.version) : 0,
		pins: numberRecord(source.pins, isPinRank),
		previousDirty: numberRecord(source.previousDirty, isDirtyCount),
		summaries: summaryRecords(source.summaries),
	};
}

/**
 * True when the persisted state predates this layout and still needs seeding from the
 * notes it used to be written to.
 *
 * Seeded once and then never again, which is the whole requirement: a seed that ran on
 * every load would quietly overwrite live state with whatever the notes still say, and a
 * user who has since pinned something would watch it unpin itself at startup.
 */
export function needsLegacySeed(state: MachineState): boolean {
	return state.version < STATE_VERSION;
}

/** A project's pin rank. 0 means unpinned, which is also what an absent name means. */
export function pinRankFor(pins: Readonly<Record<string, number>>, name: string): number {
	return pins[name] ?? 0;
}

/**
 * A project's uncommitted file count at the previous scan, or null when there is no
 * history.
 *
 * Null is not zero. The sustained-dirty warning compares the last scan against this one,
 * and a repo with no recorded history has not been clean before: it has never been looked
 * at, which is not evidence of anything.
 */
export function previousDirtyFor(counts: Readonly<Record<string, number>>, name: string): number | null {
	return counts[name] ?? null;
}

/** What a summary was generated from, rebuilt into the state the panel renders. */
export function stateFromRecord(
	record: SummaryRecord,
	facts: RepoFacts,
	currentHead: string | null,
): SummaryState {
	// `detectStale` reads the commit and the dirty count and nothing else, so a record and a
	// frontmatter stamp are the same question asked at different times. Passing only the two
	// fields it uses keeps one comparison behind both.
	const { stale, reason } = detectStale({ commit: record.commit, dirtyCount: record.dirtyCount }, facts, currentHead);
	return {
		generatedAt: record.generatedAt,
		commit: record.commit,
		dirty: record.dirtyCount > 0,
		dirtyCount: record.dirtyCount,
		stale,
		staleReason: reason,
	};
}

/**
 * The frontmatter a v0.1 summary note wrote, read once to seed state.
 *
 * Only ever consulted by the upgrade path. After that this plugin never reads its own
 * freshness out of a note again: a note is a document, and a document the user can edit is
 * not a place to keep state that has to be right.
 */
export interface LegacySummaryFrontmatter {
	ai_generated?: boolean;
	generated_at?: string;
	commit?: string | null;
	dirty_count?: number;
}

/**
 * One legacy note's contribution to the seed, in whatever shape it came out of the vault.
 *
 * Structural, and every field `unknown`, because the caller reads it off the metadata cache
 * and that object is whatever the user's YAML parsed to. The validation is here, where it
 * can be tested, rather than in the vault walk that cannot be.
 */
export interface LegacyNoteState {
	/** The project the note belonged to, or the filename when it had no `project` key. */
	project: string;
	/** `pinned` from the note, unvalidated. */
	pinned?: unknown;
	/** `dirty` from the note, unvalidated. */
	dirty?: unknown;
	/** Frontmatter of a generated summary note, or null for anything the user wrote. */
	summary?: LegacySummaryFrontmatter | null;
}

/**
 * Fill in machine state from the notes it used to live in.
 *
 * Only ever fills a name that has no value yet. That is what makes running the seed twice
 * harmless rather than a reset: a pin the user has made since is not a name the seed can
 * fill, and a rank already in `pins` is a decision somebody made after the notes were
 * written.
 *
 * An unseeded upgrade has real data here, 45 notes' worth of pin ranks and dirty counts,
 * and this is the only function that can ever read it. Skipping it would reset every pin
 * in every install, silently and on first load, which is the worst outcome available to
 * this change.
 */
export function applyLegacyNotes(state: MachineState, notes: readonly LegacyNoteState[]): MachineState {
	const pins = { ...state.pins };
	const previousDirty = { ...state.previousDirty };
	const summaries = { ...state.summaries };

	for (const note of notes) {
		const name = note.project;
		if (name === "") continue;

		const pin = toFiniteNumber(note.pinned);
		if (!(name in pins) && isPinRank(pin)) pins[name] = pin;

		const dirty = toFiniteNumber(note.dirty);
		if (!(name in previousDirty) && isDirtyCount(dirty)) previousDirty[name] = dirty;

		if (!(name in summaries)) {
			const record = stampFromLegacySummary(note.summary);
			if (record) summaries[name] = record;
		}
	}

	return { version: state.version, pins, previousDirty, summaries };
}

/**
 * A legacy summary note's frontmatter as a record, or null when the note is not one.
 *
 * `ai_generated` is the marker the note carries rather than the `-ai` filename: it is what
 * the old writer set on purpose, and a filename test would read a user's own `notes-ai.md`
 * as ours.
 */
export function stampFromLegacySummary(fm: LegacySummaryFrontmatter | null | undefined): SummaryRecord | null {
	if (!fm || fm.ai_generated !== true) return null;
	const generatedAt = typeof fm.generated_at === "string" && isPlausibleDate(fm.generated_at) ? fm.generated_at : null;
	const commit = typeof fm.commit === "string" && fm.commit.length > 0 ? fm.commit : null;
	const dirtyCount = toFiniteNumber(fm.dirty_count);
	return {
		generatedAt,
		commit,
		dirtyCount: isDirtyCount(dirtyCount) ? dirtyCount : 0,
	};
}

/** True when a string is something `new Date` can actually read. */
function isPlausibleDate(value: string): boolean {
	return Number.isFinite(Date.parse(value));
}

/**
 * A stored number, or null for anything that is not one.
 *
 * `typeof x === "number" && Number.isFinite(x)` rather than `Number(x)`: `Number(null)`,
 * `Number("")` and `Number(false)` are all 0, and a hand-edited `null` in a data.json would
 * otherwise become a real pin of 0 or a real history of "was clean".
 */
function toFiniteNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A rank is a positive whole number: 0 is how every other comparison spells unpinned. */
function isPinRank(value: number | null): value is number {
	return value !== null && Number.isInteger(value) && value > 0 && value <= MAX_PIN_RANK;
}

/** A dirty count is a non-negative whole number no larger than the sanity ceiling. */
function isDirtyCount(value: number | null): value is number {
	return value !== null && Number.isInteger(value) && value >= 0 && value <= MAX_DIRTY_COUNT;
}

/** True for a plain object, and false for null, an array and anything primitive. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A record of project name to number, keeping only the entries `accept` allows.
 *
 * The unsafe-key check is not paranoia about a hostile attacker, it is about `__proto__`:
 * `Object.assign` and a plain assignment both reach the prototype rather than the object,
 * so a project literally named `__proto__` in the JSON would otherwise have changed the
 * shape of every lookup that followed.
 */
function numberRecord(loaded: unknown, accept: (value: number | null) => value is number): Record<string, number> {
	const out: Record<string, number> = {};
	if (!isRecord(loaded)) return out;
	for (const [name, raw] of Object.entries(loaded)) {
		if (name === "" || UNSAFE_KEYS.has(name)) continue;
		const value = toFiniteNumber(raw);
		if (accept(value)) out[name] = value;
	}
	return out;
}

/**
 * A record of summary records, validated field by field.
 *
 * A record with one bad field keeps its good fields and loses only that one, because a
 * summary whose commit is unreadable is still a summary that was generated, and throwing the
 * whole entry away would make the panel claim it has none.
 */
function summaryRecords(loaded: unknown): Record<string, SummaryRecord> {
	const out: Record<string, SummaryRecord> = {};
	if (!isRecord(loaded)) return out;
	for (const [name, raw] of Object.entries(loaded)) {
		if (name === "" || UNSAFE_KEYS.has(name) || !isRecord(raw)) continue;
		const generatedAt = typeof raw.generatedAt === "string" && isPlausibleDate(raw.generatedAt) ? raw.generatedAt : null;
		const dirtyCount = toFiniteNumber(raw.dirtyCount);
		out[name] = {
			generatedAt,
			commit: typeof raw.commit === "string" && raw.commit.length > 0 ? raw.commit : null,
			dirtyCount: isDirtyCount(dirtyCount) ? dirtyCount : 0,
		};
	}
	return out;
}
