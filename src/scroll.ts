/**
 * Where the panel's scroll position has to move, decided without a layout engine.
 *
 * Its own module because it has to be testable and `panel-body.ts` is not: that file
 * draws rows through `row-controls.ts`, which imports `obsidian` for real, and
 * `node --test` cannot load a package with no runtime entry. The decision is four
 * comparisons; the part worth testing is which box they are made against.
 */

/** The edges of a box, which is all this comparison reads off a `DOMRect`. */
export interface Edges {
	top: number;
	bottom: number;
	left: number;
	right: number;
}

/**
 * A pixel of slack, so a row flush against the edge counts as visible.
 *
 * Rows land on fractions of a pixel, and calling one of those off-screen would scroll
 * on renders where nothing moved, which is the fight with the user that not scrolling
 * an already-visible row exists to avoid.
 */
const EDGE_SLACK_PX = 1;

/**
 * Whether `row` is inside the visible box of the thing that scrolls it.
 *
 * `scrollBox` has to be the scroller itself: `.pt-body`, which is what rows live in
 * and what the panel's `scrollTop` is on. An earlier version asked the row for its
 * `offsetParent`, which is the nearest *positioned* ancestor. `.pt-body` declares no
 * `position`, so it can never be the answer, and the comparison ran against a taller
 * box starting above the list by the height of the title, controls and status line. A
 * row scrolled a little way past the top of the list sits in that band, inside the
 * ancestor's rect, so it was called visible and the panel refused to scroll to it.
 * Pinning a row from the middle of the list is exactly such a case, so the flagship
 * `p` interaction stayed broken for any jump shorter than the header.
 *
 * `panel-body.test.ts` pins both boxes, since the difference between them is the whole
 * bug. Which element the panel hands in is not covered by any test.
 */
export function isInsideScrollBox(scrollBox: Edges, row: Edges): boolean {
	return (
		row.top >= scrollBox.top - EDGE_SLACK_PX &&
		row.bottom <= scrollBox.bottom + EDGE_SLACK_PX &&
		row.left >= scrollBox.left - EDGE_SLACK_PX &&
		row.right <= scrollBox.right + EDGE_SLACK_PX
	);
}