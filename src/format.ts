/**
 * Formatting shared by the note writer and the sidebar.
 *
 * Nothing here imports `obsidian`, so the plugin's own tests can exercise these
 * functions directly.
 */

/** One table cell. A pipe in a value would otherwise split the row in two. */
export function cell(value: string): string {
	return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** The filename of a vault path, which is what a wikilink should be named after. */
export function basename(path: string): string {
	const name = path.split("/").pop() ?? path;
	return name.replace(/\.md$/i, "");
}

/**
 * A wikilink cell, with the alias separator escaped like every other pipe.
 *
 * Two parsers read this row, and they read it in order: the table parser splits the line into
 * cells on unescaped pipes, and the wikilink parser runs on the text of one cell afterwards.
 * So the separator is written `\|`, which is what tells the table parser the cell continues
 * past it, and the table parser hands the cell on with that backslash already removed, so the
 * link parser still sees `[[path|alias]]` with a real separator and the alias survives.
 * Obsidian documents this form for an alias inside a table, and its own editor writes it.
 *
 * The halves go through `cell` for the ordinary reason: a pipe in a path or a filename would
 * end the cell early just the same.
 *
 * Lives here rather than in `dashboard.ts` because the weekly note writes tables too, and two
 * copies of an escaping rule is how the two documents start disagreeing about a pipe.
 */
export function linkCell(path: string): string {
	return `[[${cell(path)}\\|${cell(basename(path))}]]`;
}

/** Human-readable age from an ISO date, e.g. "3d ago". */
export function relativeAge(iso: string | null, now: number): string {
	if (!iso) return "no commits";
	const time = Date.parse(iso);
	if (Number.isNaN(time)) return "unknown";
	const days = Math.floor((now - time) / (24 * 60 * 60 * 1000));
	if (days <= 0) return "today";
	if (days === 1) return "yesterday";
	if (days < 30) return `${days}d ago`;
	const months = Math.floor(days / 30);
	return months <= 1 ? `${days}d ago` : `${months}mo ago`;
}

/**
 * The date part of an ISO timestamp: `2026-08-30T18:51:55+03:00` becomes
 * `2026-08-30`.
 *
 * Date-only for the `last_commit` key, because `%cI` hands us a full timestamp with
 * a timezone offset that is unreadable in Obsidian's properties panel. Date-only
 * still reads as a date there, still sorts chronologically as plain text, and is
 * still valid input to `Date.parse`.
 *
 * Returns null for null and for anything not starting with a date, so an
 * unparseable commit date leaves the key out rather than writing junk.
 */
export function isoDate(iso: string | null): string | null {
	if (!iso) return null;
	const match = iso.match(/^(\d{4}-\d{2}-\d{2})(?:T|$)/);
	return match ? match[1] : null;
}