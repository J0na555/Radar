/**
 * Where the panel's scroll position has to move, decided without a layout engine.
 *
 * Its own module because it has to be testable and `panel-body.ts` is not: that file
 * draws rows through `row-controls.ts`, which imports `obsidian` for real, and
 * `node --test` cannot load a package with no runtime entry.
 */

/** The edges of a box, which is all this comparison reads off a `DOMRect`. */
export interface Edges {
	top: number;
	bottom: number;
	left: number;
	right: number;
}

/**
 * A pixel of slack, so a row flush against the edge counts as visible. Rows land on
 * fractions of a pixel, and calling one of those off-screen would scroll on renders
 * where nothing moved.
 */
const EDGE_SLACK_PX = 1;

/**
 * Whether `row` is inside the visible box of the thing that scrolls it.
 *
 * `scrollBox` has to be the scroller itself, `.gd-body`. Asking the row for its
 * `offsetParent` instead gives the nearest *positioned* ancestor, and `.gd-body`
 * declares no `position`, so it can never be the answer: the comparison ran against
 * a taller box starting above the list, where a row scrolled slightly past the top
 * reads as visible. That is what broke `p`, since pinning jumps exactly that far.
 *
 * `scroll.test.ts` pins both boxes. Which element the panel hands in is untested.
 */
export function isInsideScrollBox(scrollBox: Edges, row: Edges): boolean {
	return (
		row.top >= scrollBox.top - EDGE_SLACK_PX &&
		row.bottom <= scrollBox.bottom + EDGE_SLACK_PX &&
		row.left >= scrollBox.left - EDGE_SLACK_PX &&
		row.right <= scrollBox.right + EDGE_SLACK_PX
	);
}