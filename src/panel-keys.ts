/**
 * Binding the panel's keys to the view.
 *
 * Out of `view.ts` because binding keys and reacting to them are two different
 * jobs: this one knows about Obsidian's `Scope` and about which events have to be
 * left alone, and the view still owns what each key means.
 *
 * The scope is the whole reason keyboard support can be added safely. A view's
 * scope is on the stack only while that view has focus, so these bindings are live
 * in this panel and nowhere else. A listener on `document` would be live while the
 * user is typing in a note on the other side of the window, which is how `j` ends
 * up deleting a paragraph.
 *
 * Two rules do the work of not stealing anything, both in `keys.ts` where they can
 * be tested: an event aimed at an input is ignored, and so is any event carrying a
 * modifier. Unrecognised keys never reach a binding in the first place, since the
 * table below is the complete list of keys this panel claims.
 */
import { Scope } from "obsidian";
import type { KeymapEventHandler } from "obsidian";
import { KEY_BINDINGS, shouldIgnoreKey } from "./keys.ts";
import type { PanelAction } from "./keys.ts";

/** What each action means to the view. One callback per key, no arguments. */
export interface PanelKeyActions {
	onDown(): void;
	onUp(): void;
	onOpen(): void;
	onSummarize(): void;
	onPin(): void;
	onRefresh(): void;
	onSearch(): void;
	onClear(): void;
}

/**
 * Register every binding on `scope` and return the handles for undoing it.
 *
 * An empty modifier list means the bare key. Modifiers are still checked in the
 * handler, because Obsidian dispatches by key name first: without that check a
 * `Ctrl+J` would reach `onDown` and then be returned as handled, taking Obsidian's
 * own shortcut with it.
 */
export function bindPanelKeys(scope: Scope, actions: PanelKeyActions): KeymapEventHandler[] {
	const handlers: KeymapEventHandler[] = [];
	for (const { key, action } of KEY_BINDINGS) {
		handlers.push(scope.register([], key, (event) => handle(event, action, actions)));
	}
	return handlers;
}

/** Take every binding off the scope, so a closed view holds no callbacks at all. */
export function unbindPanelKeys(scope: Scope | null, handlers: readonly KeymapEventHandler[]): void {
	if (!scope) return;
	for (const handler of handlers) scope.unregister(handler);
}

/**
 * Run one key, or leave it for somebody else.
 *
 * Returning `false` is Obsidian's signal to preventDefault, which is what stops an
 * arrow key moving the selection and scrolling the panel at the same time.
 */
function handle(event: KeyboardEvent, action: PanelAction, actions: PanelKeyActions): false | undefined {
	const target = event.target as HTMLElement | null;
	if (
		shouldIgnoreKey({
			key: event.key,
			ctrlKey: event.ctrlKey,
			altKey: event.altKey,
			metaKey: event.metaKey,
			shiftKey: event.shiftKey,
			targetTag: target?.tagName,
			targetEditable: target?.isContentEditable,
		})
	) {
		return undefined;
	}

	dispatch(action, actions);
	return false;
}

function dispatch(action: PanelAction, actions: PanelKeyActions): void {
	switch (action) {
		case "down":
			actions.onDown();
			break;
		case "up":
			actions.onUp();
			break;
		case "open":
			actions.onOpen();
			break;
		case "summarize":
			actions.onSummarize();
			break;
		case "pin":
			actions.onPin();
			break;
		case "refresh":
			actions.onRefresh();
			break;
		case "search":
			actions.onSearch();
			break;
		case "clear":
			actions.onClear();
			break;
	}
}
