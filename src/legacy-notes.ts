/**
 * Finding the v0.1 notes on disk and reading the AI summary text out of them.
 *
 * This is the one-directional half of the upgrade. It reads and never writes, which is the
 * whole safety argument: nobody's 45 existing notes get deleted, emptied, or marked by this
 * code. A migration that moves files is a migration that can lose files, and the cost of
 * losing one is somebody's notes.
 *
 * What happens to the old files is the user's call, and `findLegacySummaryNotes` returns
 * enough for them to make it in one click rather than hunting a folder.
 *
 * No `obsidian` import, so `node --test` loads this directly.
 */
import { sanitizeBase, type SummaryBody } from "./summary.ts";
import type { SummaryRecord } from "./types.ts";

/** Suffix v0.1 gave a generated summary note. */
export const AI_SUFFIX = "-ai";

/** Filename of one project's v0.1 summary note. */
export function legacySummaryFileName(projectName: string): string {
	return `${sanitizeBase(projectName) || "untitled"}${AI_SUFFIX}.md`;
}

/**
 * True when a vault path is one of ours from v0.1.
 *
 * The `-ai` suffix and nothing else, as a cheap pre-filter. Permissive about the folder,
 * because the user's setting is whatever it was in v0.1 and might have moved since, and a
 * false negative here means a summary silently not coming across.
 *
 * Not sufficient on its own: `api-ai.md` also matches, and that one may be a project note.
 * `findLegacySummaryNotes` checks the frontmatter before believing it.
 */
export function isLegacySummaryPath(path: string): boolean {
	return path.toLowerCase().endsWith(`${AI_SUFFIX}.md`);
}

/** Which project a v0.1 summary note was for, from the two places it says. */
export function projectNameFromLegacySummary(path: string, frontmatterProject: unknown): string | null {
	// Frontmatter first, since it is the authoritative record and the filename is sanitised.
	if (typeof frontmatterProject === "string" && frontmatterProject.trim() !== "") {
		return frontmatterProject.trim();
	}
	// Fall back to the filename, which is what v0.1 wrote and which a hand-edit to the
	// frontmatter must not be able to orphan.
	const file = path.split("/").pop() ?? path;
	const base = file.replace(/\.md$/i, "");
	if (base === "" || base.toLowerCase().endsWith(AI_SUFFIX) === false) return null;
	const name = base.slice(0, -AI_SUFFIX.length);
	return name === "" ? null : name;
}

/**
 * Pull the summary text out of a v0.1 summary note.
 *
 * Returns null when there is nothing worth bringing across, which is a real case: a note
 * carrying only frontmatter, one whose body was emptied by hand, or one that is somebody's
 * prose with an `-ai` filename. Migrating those would put an empty callout in the dashboard
 * and, for the third, put a person's writing somewhere they did not put it.
 *
 * The two `##` headings v0.1 wrote are what is looked for, because the prose between them is
 * the model's answer. Anything before the first heading is dropped: v0.1 wrote a warning
 * callout there, and re-migrating that would stack a second one on top.
 */
export function extractSummaryBody(markdown: string): SummaryBody | null {
	const lines = markdown.split("\n");
	const summaryAt = indexOfHeading(lines, "Summary");
	if (summaryAt === -1) return null;

	const nextAt = indexOfHeading(lines, "Suggested next steps", summaryAt + 1);
	const summaryEnd = nextAt === -1 ? lines.length : nextAt;
	const summary = trimBlankEdges(lines.slice(summaryAt + 1, summaryEnd));
	if (summary.length === 0) return null;

	const nextSteps: string[] = [];
	if (nextAt !== -1) {
		for (const line of lines.slice(nextAt + 1)) {
			// v0.1 wrote one bullet per step, and nothing else in this block. A non-bullet line is
			// somebody's edit, so the rest of the block is left alone rather than guessed at.
			const bullet = /^-\s+(.*\S)\s*$/.exec(line);
			if (!bullet) continue;
			nextSteps.push(bullet[1]);
		}
	}

	return { summary: summary.join("\n"), nextSteps };
}

/**
 * The v0.1 summary notes in a vault, oldest-style first.
 *
 * Takes paths and contents as arguments rather than reaching into Obsidian, so the whole
 * migration can be checked against a list of strings. `pathFor` maps a vault path to its text,
 * returning null for a file that cannot be read; a file that fails to read is skipped rather
 * than treated as empty, since the two would otherwise be indistinguishable at the call site.
 */
export function findLegacySummaryNotes(
	paths: readonly string[],
	read: (path: string) => string | null,
): LegacySummaryNote[] {
	const found: LegacySummaryNote[] = [];
	const seen = new Set<string>();

	for (const path of paths) {
		if (!isLegacySummaryPath(path)) continue;
		const markdown = read(path);
		if (markdown === null) continue;
		const header = readLegacyHeader(markdown);

		// The suffix alone is not enough to claim a file, and this is not a technicality.
		// `api-ai.md` ends in `-ai.md` and is also the project note for a repo called `api-ai`,
		// which the old plugin wrote into this same folder. Taking the filename at face value
		// would move somebody's project note into the summaries section and attribute it to a
		// repo called `api`. So the frontmatter has to say the file is ours, which is what v0.1
		// wrote and what a hand-written note will not have.
		if (!header.aiGenerated) continue;

		// Frontmatter first, filename as the fallback for a note whose `project` key was
		// hand-edited away, which must not orphan a summary.
		const projectName = projectNameFromLegacySummary(path, header.project);
		if (projectName === null || seen.has(projectName)) continue;
		const body = extractSummaryBody(markdown);
		if (body === null) continue;

		seen.add(projectName);
		found.push({ projectName, path, body, header });
	}

	return found;
}

/** One v0.1 summary note, reduced to what the dashboard needs from it. */
export interface LegacySummaryNote {
	projectName: string;
	/** Where it is now. Reported so the user can find it, never deleted. */
	path: string;
	body: SummaryBody;
	header: LegacyNoteHeader;
}

/** What a v0.1 note's own frontmatter says, parsed and checked. */
export interface LegacyNoteHeader {
	project: string | null;
	/** The CLI that wrote it. */
	provider: string | null;
	/** ISO 8601 generation time, or null when it is not one. */
	generatedAt: string | null;
	/** Short commit sha, or null when absent or not shaped like one. */
	commit: string | null;
	/** Uncommitted file count at generation time, or null when not a number. */
	dirtyCount: number | null;
	/** Whether the note says it is ours. */
	aiGenerated: boolean;
}

/**
 * Read the frontmatter of a v0.1 note.
 *
 * Deliberately not a YAML parser. v0.1 wrote these keys itself with `JSON.stringify`, so the
 * values are JSON or bare, and a general parser would be a new dependency and a new way for
 * somebody's hand-written `provider: no` to become `false`.
 */
export function readLegacyHeader(markdown: string): LegacyNoteHeader {
	const generatedAt = frontmatterValue(markdown, "generated_at");
	const commit = frontmatterValue(markdown, "commit");
	const dirtyCount = frontmatterValue(markdown, "dirty_count");
	return {
		project: frontmatterValue(markdown, "project"),
		provider: frontmatterValue(markdown, "provider"),
		generatedAt: generatedAt !== null && !Number.isNaN(Date.parse(generatedAt)) ? new Date(generatedAt).toISOString() : null,
		// Checked rather than trusted. A stamp is what staleness is judged against, and a
		// hand-edited one that is not a sha would mark a summary stale forever.
		commit: commit !== null && /^[0-9a-f]{4,40}$/i.test(commit) ? commit : null,
		dirtyCount: dirtyCount !== null && Number.isFinite(Number(dirtyCount)) && Number(dirtyCount) >= 0 ? Math.floor(Number(dirtyCount)) : null,
		aiGenerated: frontmatterValue(markdown, "ai_generated") === "true",
	};
}

/**
 * The freshness record for a migrated summary, or null when the note recorded nothing usable.
 *
 * Null rather than a record of blanks, because a summary with no provenance should say so in the
 * dashboard instead of claiming a clean tree at a commit nobody can check.
 */
export function recordFromLegacyHeader(header: LegacyNoteHeader): SummaryRecord | null {
	if (header.generatedAt === null && header.commit === null && header.dirtyCount === null) return null;
	return {
		generatedAt: header.generatedAt,
		commit: header.commit,
		dirtyCount: header.dirtyCount ?? 0,
	};
}

/**
 * The folders holding notes we will not delete, for the notice.
 *
 * Counted per folder rather than listed as files: 45 filenames in one notice is a wall of text
 * nobody reads, and the folder is what somebody needs in order to go and look.
 */
export function legacyFolders(paths: readonly string[]): { folder: string; count: number }[] {
	const counts = new Map<string, number>();
	for (const path of paths) {
		if (!isLegacySummaryPath(path)) continue;
		const folder = path.split("/").slice(0, -1).join("/");
		counts.set(folder, (counts.get(folder) ?? 0) + 1);
	}
	return [...counts.entries()]
		.map(([folder, count]) => ({ folder, count }))
		.sort((a, b) => b.count - a.count || a.folder.localeCompare(b.folder));
}

/** The value of a top-level YAML key, or null. Enough for the keys v0.1 wrote itself. */
export function frontmatterValue(markdown: string, key: string): string | null {
	const lines = markdown.split("\n");
	if (lines[0]?.trim() !== "---") return null;
	for (let index = 1; index < lines.length; index++) {
		const line = lines[index];
		if (line.trim() === "---") return null;
		const match = new RegExp(`^${key}:\\s*(.*)$`).exec(line);
		if (!match) continue;
		const value = match[1].trim();
		if (value === "") return null;
		try {
			// v0.1 wrote these with JSON.stringify, so a quoted value needs unquoting. A bare value
			// is left alone rather than run through YAML, which would happily turn `no` into false.
			return typeof JSON.parse(value) === "string" ? String(JSON.parse(value)) : value;
		} catch {
			return value;
		}
	}
	return null;
}

/** Index of an ATX heading with exactly this text, ignoring case. */
function indexOfHeading(lines: readonly string[], text: string, from = 0): number {
	const wanted = text.toLowerCase();
	for (let index = from; index < lines.length; index++) {
		if (lines[index].trim().toLowerCase() === `## ${wanted}`) return index;
	}
	return -1;
}

/** Drop leading and trailing blank lines, keeping interior ones: they are paragraph breaks. */
function trimBlankEdges(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && lines[start].trim() === "") start++;
	while (end > start && lines[end - 1].trim() === "") end--;
	return lines.slice(start, end);
}