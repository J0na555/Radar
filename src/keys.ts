/**
 * The panel's keyboard map and the arithmetic of the selected row.
 *
 * Both live out here, away from the ItemView, for one reason: neither can be
 * tested in Obsidian. The keys are registered through `View.scope`, so Obsidian
 * only dispatches them while this panel has focus, and there is no headless way
 * to make that happen. Everything the key handler *decides* is here instead, where
 * `node --test` can check it.
 *
 * The rules are deliberately strict, because the failure mode of a global
 * keydown listener is that it keeps working when the user has moved on:
 *
 *  - Anything typed into an input, a textarea, or a contenteditable is ignored,
 *    so `/` followed by "api" does not pin or summarize anything.
 *  - Ctrl, Alt, Meta, and Shift are all ignored. Shift is the one that is easy to
 *    forget and the one that does real damage: `J` and `K` are not `j` and `k`.
 *    The cost is that `/` does not work on a layout where the slash is a shifted
 *    key, which is the same trade Obsidian's own commands make.
 *  - Unknown keys are ignored rather than swallowed, so they keep working for
 *    whatever else the panel might grow.
 */

/** What a key does in this panel. */
export type PanelAction = "down" | "up" | "open" | "summarize" | "pin" | "refresh" | "search" | "clear";

/** One registered hotkey. One key per entry, because Obsidian's Scope takes one. */
export interface KeyBinding {
	/** A `KeyboardEvent.key` value. */
	key: string;
	action: PanelAction;
}

/**
 * Every key this panel answers to.
 *
 * `j`/`k` alongside the arrow keys because the arrow keys are what a new user
 * reaches for and `j`/`k` is what somebody who came from a file manager expects.
 * `Escape` clears rather than closes, because the panel is not a modal and there
 * is nothing for it to close.
 */
export const KEY_BINDINGS: readonly KeyBinding[] = [
	{ key: "j", action: "down" },
	{ key: "ArrowDown", action: "down" },
	{ key: "k", action: "up" },
	{ key: "ArrowUp", action: "up" },
	{ key: "Enter", action: "open" },
	{ key: "s", action: "summarize" },
	{ key: "p", action: "pin" },
	{ key: "r", action: "refresh" },
	{ key: "/", action: "search" },
	{ key: "Escape", action: "clear" },
];

/** The same map as a lookup, so the view does not walk the list itself. */
const BY_KEY = new Map(KEY_BINDINGS.map((binding) => [binding.key, binding.action]));

/** What a key does, or null when this panel has nothing to do with it. */
export function mapKey(key: string): PanelAction | null {
	return BY_KEY.get(key) ?? null;
}

/**
 * The keys, in the panel's own footer, so the shortcuts are discoverable.
 *
 * Keyboard support nobody can find is the same as no keyboard support. One line,
 * in the same small grey as everything else the panel says for its own benefit.
 */
export function keyHints(): string {
	return "j/k move · Enter open · s summarize · p pin · r refresh · / search · Esc clear";
}

/** The subset of a KeyboardEvent the decisions below depend on. */
export interface KeyEventLike {
	key: string;
	ctrlKey?: boolean;
	altKey?: boolean;
	metaKey?: boolean;
	shiftKey?: boolean;
	/** `tagName` of the event target, upper-case, or "" when there is no target. */
	targetTag?: string;
	/** True when the target is a contenteditable region. */
	targetEditable?: boolean;
}

/** Elements that own the keyboard while they have focus. */
const TYPING_TAGS: readonly string[] = ["INPUT", "TEXTAREA", "SELECT"];

/** True when the event came from somewhere the user is typing rather than navigating. */
export function isTypingTarget(target: { tagName?: string; isContentEditable?: boolean }): boolean {
	const tag = (target.tagName ?? "").toUpperCase();
	if (TYPING_TAGS.includes(tag)) return true;
	// Obsidian's own editors are contenteditable, and so is every `contenteditable`
	// region a plugin might put inside the panel.
	return target.isContentEditable === true;
}

/**
 * True when this event must not reach a panel action at all.
 *
 * The modifier rule is checked before the target rule because it is the cheaper
 * one and the more common reason to pass: a modified key belongs to Obsidian or to
 * the operating system, not to a list of projects.
 */
export function shouldIgnoreKey(event: KeyEventLike): boolean {
	if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return true;
	return isTypingTarget({ tagName: event.targetTag, isContentEditable: event.targetEditable });
}

/** Nothing is selected, which only happens when there is nothing to select. */
export const NO_SELECTION = -1;

/** An index that is a real row of a list this long, or NO_SELECTION if there are none. */
export function clampSelection(index: number, length: number): number {
	if (length <= 0) return NO_SELECTION;
	if (!Number.isFinite(index) || index < 0) return 0;
	return Math.min(Math.floor(index), length - 1);
}

/**
 * Move the selection one row, stopping at the ends.
 *
 * No wrap-around on purpose. A list the user has pinned projects into has an order
 * they chose; wrapping from the bottom to the top makes `j` feel like it lost its
 * place, and nothing else in the panel moves on its own.
 */
export function moveSelection(index: number, length: number, direction: 1 | -1): number {
	if (length <= 0) return NO_SELECTION;
	if (index < 0) return direction === 1 ? 0 : length - 1;
	return clampSelection(index + direction, length);
}

/**
 * Where the selection should be after the list has been rebuilt.
 *
 * The selection is remembered by project name, not by index, because a row's index
 * is not a fact about the project: pinning it moves it, and a summary finishing
 * re-renders the list around it. Keying on the name means the row the user is
 * looking at stays the row they are looking at, and `j` afterwards continues from
 * its new position.
 *
 * When the filter hides the selected project there is nothing to keep, and the
 * deliberate choice is to stay at the same index rather than jump to the top. The
 * rows above the cursor have not moved in the user's mind, and a jump to the top
 * would put the cursor somewhere they have to hunt for again.
 *
 * `NO_SELECTION` (an empty list) stays `NO_SELECTION`; any other out-of-range index
 * clamps into the list, and a list that has never had a selection starts at the top
 * so that `Enter` and `s` do something without a prior `j`.
 */
export function reconcileSelection(
	previousIndex: number,
	names: readonly string[],
	previousName: string | null,
): number {
	if (names.length === 0) return NO_SELECTION;
	if (previousName !== null) {
		const found = names.indexOf(previousName);
		if (found >= 0) return found;
	}
	return clampSelection(previousIndex, names.length);
}
