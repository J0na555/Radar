import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isInsideScrollBox } from "./scroll.ts";

/**
 * A row, and the box it is being scrolled inside.
 *
 * The panel's own numbers: a 400px-tall `.pt-body` below a 120px header, so the ancestor box
 * starts 120px above the list. Everything here is about which box the comparison is handed.
 */
const HEADER_PX = 120;
const BODY_PX = 400;
const WIDTH = 300;
const ROW_PX = 40;

/** The scroller itself: `.pt-body`, with `overflow-y: auto`. */
function scrollBox(): { top: number; bottom: number; left: number; right: number } {
	return { top: HEADER_PX, bottom: HEADER_PX + BODY_PX, left: 0, right: WIDTH };
}

/**
 * The box `offsetParent` used to hand over instead: a positioned ancestor starting above the
 * list, with the header's height between its top edge and the first row.
 */
function offsetParentBox(): { top: number; bottom: number; left: number; right: number } {
	return { top: 0, bottom: HEADER_PX + BODY_PX, left: 0, right: WIDTH };
}

/** A row whose top edge is `fromTop` pixels below the top of `.pt-body`. */
function row(fromTop: number): { top: number; bottom: number; left: number; right: number } {
	return {
		top: HEADER_PX + fromTop,
		bottom: HEADER_PX + fromTop + ROW_PX,
		left: 0,
		right: WIDTH,
	};
}

describe("isInsideScrollBox", () => {
	it("calls a row that is off the top of the scroller outside", () => {
		// The flagship `p` bug. Pinning a row from the middle of the list jumps it to
		// the top of the pinned group, which puts it a little way above the visible
		// box. This has to come out false or nothing scrolls.
		for (const fromTop of [-80, -40, -8, -2]) {
			assert.equal(
				isInsideScrollBox(scrollBox(), row(fromTop)),
				false,
				`a row ${-fromTop}px above the top of the list was called visible`,
			);
		}
	});

	it("calls the same row visible against the ancestor box", () => {
		// `.pt-body` declares no `position`, so `offsetParent` skipped it and returned a box
		// 120px taller at the top. Every row in that header band is inside it, so the panel
		// decided the row was already on screen and left the scroll alone.
		assert.equal(isInsideScrollBox(offsetParentBox(), row(-40)), true);
		assert.equal(isInsideScrollBox(offsetParentBox(), row(-1)), true);
		// The same row, both ways round, so the two boxes cannot be swapped by accident.
		assert.equal(isInsideScrollBox(scrollBox(), row(-40)), false);
	});

	it("calls a row that is off the bottom outside", () => {
		assert.equal(isInsideScrollBox(scrollBox(), row(BODY_PX - ROW_PX + 2)), false);
		assert.equal(isInsideScrollBox(scrollBox(), row(BODY_PX)), false);
	});

	it("calls a row that overhangs a side outside", () => {
		const wide = { top: HEADER_PX + 10, bottom: HEADER_PX + 10 + ROW_PX, left: -4, right: WIDTH };
		assert.equal(isInsideScrollBox(scrollBox(), wide), false);
		const past = { top: HEADER_PX + 10, bottom: HEADER_PX + 10 + ROW_PX, left: 0, right: WIDTH + 4 };
		assert.equal(isInsideScrollBox(scrollBox(), past), false);
	});

	it("counts a row within a pixel of the edge as visible", () => {
		// Rows land on fractions of a pixel, and a row just over the edge is not off screen.
		// Scrolling there would move the viewport on renders where nothing moved. One pixel
		// is the whole slack, so the boundary is at -1.
		assert.equal(isInsideScrollBox(scrollBox(), row(0)), true);
		assert.equal(isInsideScrollBox(scrollBox(), row(BODY_PX - ROW_PX)), true);
		assert.equal(isInsideScrollBox(scrollBox(), row(-1)), true, "a row 1px over the edge");
		assert.equal(isInsideScrollBox(scrollBox(), row(-1.5)), false, "a row 1.5px over the edge");
	});

	it("never calls a row taller than the scroller visible", () => {
		// There is no scroll position that shows all of it, and `block: "nearest"` against
		// a box that already fills the scroller moves nothing. A tall row is what the "Why"
		// toggle makes of a project with a long breakdown.
		const tall = {
			top: HEADER_PX + 10,
			bottom: HEADER_PX + 10 + BODY_PX + 40,
			left: 0,
			right: WIDTH,
		};
		assert.equal(isInsideScrollBox(scrollBox(), tall), false);
	});
});