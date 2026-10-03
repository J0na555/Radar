/**
 * Formatting shared by the note writer and the sidebar.
 *
 * Nothing here imports `obsidian`, so the plugin's own tests can exercise these
 * functions directly.
 */

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