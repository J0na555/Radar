import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	clampSelection,
	isTypingTarget,
	keyHints,
	KEY_BINDINGS,
	mapKey,
	moveSelection,
	NO_SELECTION,
	reconcileSelection,
	shouldIgnoreKey,
} from "./keys.ts";
import type { PanelAction } from "./keys.ts";

/** A plain key press, with nothing else attached to it. */
function press(key: string) {
	return { key, targetTag: "DIV" };
}

describe("the key map", () => {
	it("moves the selection with j and k", () => {
		assert.equal(mapKey("j"), "down");
		assert.equal(mapKey("k"), "up");
	});

	it("moves the selection with the arrow keys too", () => {
		assert.equal(mapKey("ArrowDown"), "down");
		assert.equal(mapKey("ArrowUp"), "up");
	});

	it("acts on the selected row", () => {
		assert.equal(mapKey("Enter"), "open");
		assert.equal(mapKey("s"), "summarize");
		assert.equal(mapKey("p"), "pin");
		assert.equal(mapKey("r"), "refresh");
	});

	it("reaches the search box and clears", () => {
		assert.equal(mapKey("/"), "search");
		assert.equal(mapKey("Escape"), "clear");
	});

	it("has no opinion about any other key", () => {
		// Returning null rather than swallowing the event is what keeps whatever else
		// the panel grows working.
		for (const key of ["a", "J", "K", "S", "Tab", "Home", "PageDown", " ", "F5"]) {
			assert.equal(mapKey(key), null, `claimed ${key}`);
		}
	});

	it("registers each key once, and every binding is reachable", () => {
		const keys = KEY_BINDINGS.map((binding) => binding.key);
		assert.equal(new Set(keys).size, keys.length, "a key is registered twice");
		for (const binding of KEY_BINDINGS) {
			assert.equal(mapKey(binding.key), binding.action, `no lookup for ${binding.key}`);
		}
	});

	it("covers every action the panel has", () => {
		// Otherwise an action is unreachable by keyboard and nothing says so.
		const mapped = new Set<PanelAction>(KEY_BINDINGS.map((binding) => binding.action));
		assert.deepEqual(
			[...mapped].sort(),
			["clear", "down", "open", "pin", "refresh", "search", "summarize", "up"].sort(),
		);
	});

	it("lists the shortcuts where the user can find them", () => {
		const hints = keyHints();
		for (const key of ["j/k", "Enter", "s ", "p ", "r ", "/", "Esc"]) {
			assert.ok(hints.includes(key), `hints leave out ${key}: ${hints}`);
		}
	});
});

describe("which keys are left alone", () => {
	it("ignores a modified key, so Obsidian and the OS keep their shortcuts", () => {
		// Ctrl+J is Obsidian's own command palette prefix on Linux and Windows. Shift
		// is here because `J` is not `j`.
		for (const modifier of ["ctrlKey", "altKey", "metaKey", "shiftKey"] as const) {
			assert.equal(shouldIgnoreKey({ ...press("j"), [modifier]: true }), true, `j with ${modifier}`);
			assert.equal(shouldIgnoreKey({ ...press("/"), [modifier]: true }), true, `/ with ${modifier}`);
		}
	});

	it("takes an unmodified key", () => {
		assert.equal(shouldIgnoreKey(press("j")), false);
		assert.equal(shouldIgnoreKey(press("/")), false);
	});

	it("ignores anything typed into a text field", () => {
		// The load-bearing case: `/` focuses the box, and everything after that is
		// the user typing "api".
		for (const tag of ["INPUT", "TEXTAREA", "SELECT"]) {
			assert.equal(shouldIgnoreKey({ key: "j", targetTag: tag }), true, `in a ${tag}`);
		}
		assert.equal(shouldIgnoreKey({ key: "INPUT", targetTag: "INPUT" }), true);
	});

	it("ignores a contenteditable region, which is what Obsidian's editor is", () => {
		assert.equal(shouldIgnoreKey({ key: "s", targetTag: "DIV", targetEditable: true }), true);
	});

	it("still takes keys aimed at the panel itself", () => {
		// A toggle button holds focus after a click, and the user should be able to
		// carry straight on with j/k rather than having to click the list again.
		assert.equal(shouldIgnoreKey({ key: "j", targetTag: "BUTTON" }), false);
		assert.equal(shouldIgnoreKey({ key: "j", targetTag: "DIV" }), false);
		assert.equal(shouldIgnoreKey({ key: "j" }), false);
	});

	it("copes with a missing target, which a synthesised event has", () => {
		assert.equal(shouldIgnoreKey({ key: "j" }), false);
		assert.equal(isTypingTarget({}), false);
		assert.equal(isTypingTarget({ tagName: "input" }), true, "tagName case");
	});
});

describe("moving the selection", () => {
	it("steps one row at a time", () => {
		assert.equal(moveSelection(0, 5, 1), 1);
		assert.equal(moveSelection(3, 5, -1), 2);
	});

	it("stops at the ends rather than wrapping", () => {
		assert.equal(moveSelection(4, 5, 1), 4);
		assert.equal(moveSelection(0, 5, -1), 0);
	});

	it("starts at the top or the bottom depending on the direction", () => {
		assert.equal(moveSelection(NO_SELECTION, 5, 1), 0);
		assert.equal(moveSelection(NO_SELECTION, 5, -1), 4);
	});

	it("has nowhere to move in an empty list", () => {
		assert.equal(moveSelection(0, 0, 1), NO_SELECTION);
		assert.equal(moveSelection(0, 0, -1), NO_SELECTION);
	});
});

describe("clamping", () => {
	it("pulls an index past the end back onto the last row", () => {
		assert.equal(clampSelection(40, 5), 4);
	});

	it("treats no selection as the top row", () => {
		assert.equal(clampSelection(NO_SELECTION, 5), 0);
		assert.equal(clampSelection(-7, 5), 0);
	});

	it("leaves a good index alone", () => {
		assert.equal(clampSelection(3, 5), 3);
		assert.equal(clampSelection(0, 5), 0);
	});

	it("has no selection at all in an empty list", () => {
		assert.equal(clampSelection(0, 0), NO_SELECTION);
		assert.equal(clampSelection(NO_SELECTION, 0), NO_SELECTION);
	});

	it("survives a nonsense index rather than producing one", () => {
		// A NaN index would make every row compare false and the selected row would
		// silently disappear.
		assert.equal(clampSelection(Number.NaN, 5), 0);
	});
});

describe("surviving a rebuild", () => {
	const before = ["pinned-one", "busy", "calm", "sleepy"];
	const after = ["pinned-one", "sleepy", "busy", "calm"];

	it("follows the project, not its position", () => {
		// Pinning re-ranks the list. The row the user is on is the same row even
		// though it is now the fourth instead of the second, and `j` afterwards
		// continues from where it ended up.
		assert.equal(reconcileSelection(1, after, "busy"), 2);
	});

	it("stays at the same index when the filter hid the selected project", () => {
		// The deliberate choice. Jumping to the top would put the cursor somewhere
		// the user has to find again; the rows above the cursor have not moved in
		// their mind, so the cursor does not move either.
		assert.equal(reconcileSelection(1, before, "gone-from-under-me"), 1);
	});

	it("clamps instead of falling off the end when the list shrank", () => {
		// A pin can move a row out of the visible list entirely.
		assert.equal(reconcileSelection(3, ["only", "two"], "whatever"), 1);
	});

	it("selects the top row when there has never been a selection", () => {
		// So Enter and `s` do something without a prior `j`.
		assert.equal(reconcileSelection(NO_SELECTION, before, null), 0);
	});

	it("has no selection when the list is empty", () => {
		assert.equal(reconcileSelection(2, [], "busy"), NO_SELECTION);
		assert.equal(reconcileSelection(NO_SELECTION, [], null), NO_SELECTION);
	});

	it("re-selects by name even after a summary finished and re-rendered", () => {
		// A summary changes a row's buttons and nothing else, but the list is rebuilt
		// from the ranked scan, so this is the same code path as a pin.
		const rerendered = ["busy", "calm", "pinned-one", "sleepy"];
		assert.equal(reconcileSelection(0, rerendered, "busy"), 0);
		assert.equal(reconcileSelection(1, rerendered, "sleepy"), 3);
	});
});
