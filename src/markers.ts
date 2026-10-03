/**
 * The two sections of the dashboard note the plugin owns, and the replacement that touches
 * nothing outside them.
 *
 * This is the one write path in the plugin that edits a document a person may have written in.
 * Everything here exists to make that safe, so the rules are deliberately narrow:
 *
 * - A section is exactly the span from the first start marker to the last end marker, and only
 *   when a start marker precedes an end marker. An unbalanced, reversed or half-copied marker
 *   means the section does not exist, and a section that does not exist gets a new pair appended
 *   rather than half-repaired in place. Guessing at a broken span means deleting text on a
 *   hypothesis.
 * - A line is a marker only when its whole content is the marker. A marker buried in a sentence
 *   is prose, and treating it as a delimiter would swallow the sentence.
 * - Text outside the span is copied through untouched. There is no path here that rewrites a
 *   line the plugin did not put there.
 *
 * No `obsidian` import, so `node --test` loads this directly. Same rule as `pin-queue.ts`.
 */

/** The sections the plugin owns, in the order they appear in the note. */
export type SectionId = "projects" | "summaries";

/**
 * The markers themselves.
 *
 * HTML comments rather than Obsidian callouts because they are invisible in reading view and in
 * a published build, survive a round trip through any markdown tool unchanged, and cannot be
 * deleted by editing the text inside them.
 */
export const SECTION_MARKERS: Record<SectionId, { start: string; end: string }> = {
	projects: { start: "<!-- pt:projects:start -->", end: "<!-- pt:projects:end -->" },
	summaries: { start: "<!-- pt:summaries:start -->", end: "<!-- pt:summaries:end -->" },
};

/**
 * What every marker starts with, so a generated body can be refused before it is written.
 *
 * A summary is model output, so it can contain anything, and an HTML comment in it is
 * indistinguishable from a marker once it is in the file. Refusing the write costs the user one
 * summary; writing it would corrupt the section structure the next regeneration depends on.
 */
export const MARKER_PREFIX = "<!-- pt:";

/** A section's markers, as inclusive line numbers. Null when the section is not in the file. */
export interface SectionSpan {
	startLine: number;
	endLine: number;
}

/**
 * Where a section is, or null when it is not there.
 *
 * First start, last end: a duplicated pair is left over from a bug that appended twice, and
 * collapsing the whole run into one span is what makes the next write converge instead of
 * leaving two sections showing different data.
 */
export function findSection(lines: readonly string[], id: SectionId): SectionSpan | null {
	const { start, end } = SECTION_MARKERS[id];

	let startLine = -1;
	for (let index = 0; index < lines.length; index++) {
		if (isMarkerLine(lines[index], start)) {
			startLine = index;
			break;
		}
	}
	if (startLine < 0) return null;

	// From the bottom, and never at or before the start. An end marker with no start before it is
	// not a section: treating everything above it as ours would claim a user's whole document.
	for (let index = lines.length - 1; index > startLine; index--) {
		if (isMarkerLine(lines[index], end)) return { startLine, endLine: index };
	}
	return null;
}

/**
 * Replace what is between one section's markers, and nothing else.
 *
 * Adds the pair at the end of the note when it is missing, so the first write to a file the user
 * wrote themselves appends to it. That case is the reason this function is careful: `Dashboard.md`
 * is a filename a person picks, and adopting theirs must not cost them a byte of it.
 *
 * Throws when the body contains a marker. See `MARKER_PREFIX`.
 */
export function replaceSection(doc: string, id: SectionId, body: string): string {
	if (body.includes(MARKER_PREFIX)) {
		throw new Error(`refusing to write a ${id} section containing a pt: marker`);
	}

	// A note that is empty or all whitespace has nothing to preserve, and splitting it would
	// leave a blank first line above the markers for no reason.
	const lines = doc.trim() === "" ? [] : doc.split("\n");
	const span = findSection(lines, id);
	const inner = bodyLines(body);
	const { start, end } = SECTION_MARKERS[id];

	if (!span) {
		const out = [...lines];
		if (out.length > 0 && out[out.length - 1].trim() !== "") out.push("");
		out.push(start, ...inner, end);
		return out.join("\n");
	}

	const tail = lines.slice(span.endLine + 1);
	// One blank line separates the section from whatever the user has below it, added only when
	// there is nothing already doing that job. Every other line of the tail is passed through as
	// it was found.
	if (tail.length > 0 && tail[0].trim() !== "") tail.unshift("");

	return [...lines.slice(0, span.startLine), start, ...inner, end, ...tail].join("\n");
}

/** What is between one section's markers, or null when the section is not in the file. */
export function sectionBody(doc: string, id: SectionId): string | null {
	const lines = doc.split("\n");
	const span = findSection(lines, id);
	if (!span) return null;
	return lines.slice(span.startLine + 1, span.endLine).join("\n");
}

/** A line is a marker only if it is nothing but the marker. */
function isMarkerLine(line: string | undefined, marker: string): boolean {
	return line !== undefined && line.trim() === marker;
}

/**
 * The body as lines, with its trailing blank lines dropped.
 *
 * Trailing blanks would otherwise accumulate one rewrite at a time, because each rewrite puts
 * one back on the end of the section and the next one keeps what it finds.
 */
function bodyLines(body: string): string[] {
	const trimmed = body.replace(/\s+$/, "");
	return trimmed === "" ? [] : trimmed.split("\n");
}
