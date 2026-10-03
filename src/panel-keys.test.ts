import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Scope } from "obsidian";
import { bindPanelKeys, unbindPanelKeys } from "./panel-keys.ts";
import { KEY_BINDINGS } from "./keys.ts";
import type { PanelAction } from "./keys.ts";
import type { PanelKeyActions } from "./panel-keys.ts";

/**
 * A stand-in for Obsidian's `Scope`, about ten lines.
 *
 * `register` keeps what it was given and hands the handler straight back, which is
 * what the real one does; `unregister` drops it. That is the whole contract
 * `bindPanelKeys` relies on, so this is enough to drive it without Obsidian and
 * without a DOM: the handlers only read properties off the event.
 */
function stubScope() {
	const live: { modifiers: string[] | null; key: string | null; handler: (event: KeyboardEvent) => unknown }[] =
		[];
	const removed: unknown[] = [];

	const scope = {
		register(modifiers: string[] | null, key: string | null, handler: (event: KeyboardEvent) => unknown) {
			live.push({ modifiers, key, handler });
			return handler;
		},
		unregister(handler: unknown) {
			removed.push(handler);
			const at = live.findIndex((entry) => entry.handler === handler);
			if (at >= 0) live.splice(at, 1);
		},
	} as unknown as Scope;

	return { scope, live, removed };
}

/** A key event with nothing else on it, which is the panel's normal case. */
function press(key: string, overrides: Partial<Record<string, unknown>> = {}): KeyboardEvent {
	return {
		key,
		ctrlKey: false,
		altKey: false,
		metaKey: false,
		shiftKey: false,
		target: null,
		...overrides,
	} as unknown as KeyboardEvent;
}

/** An event aimed at an element, for the "who owns the keyboard" rule. */
function pressAt(key: string, target: unknown, overrides: Partial<Record<string, unknown>> = {}): KeyboardEvent {
	return press(key, { target, ...overrides });
}

/**
 * The callback each action has to reach.
 *
 * Written out rather than derived from the name, because `dispatch` is a switch over
 * these names and this table is the other half of it: a new `PanelAction` with no
 * entry here is a compile error in this file, which is the point.
 */
const CALLBACKS: Record<PanelAction, keyof PanelKeyActions> = {
	down: "onDown",
	up: "onUp",
	open: "onOpen",
	summarize: "onSummarize",
	pin: "onPin",
	refresh: "onRefresh",
	search: "onSearch",
	clear: "onClear",
};

/** One recorder per action, so a test can see exactly which one fired. */
function recorder() {
	const calls: PanelAction[] = [];
	const actions = {} as Record<keyof PanelKeyActions, () => void>;
	for (const [action, callback] of Object.entries(CALLBACKS) as [PanelAction, keyof PanelKeyActions][]) {
		actions[callback] = () => calls.push(action);
	}
	return { calls, actions };
}

/** Bind against a stub scope and hand back everything the tests need to poke at it. */
function bound() {
	const { scope, live, removed } = stubScope();
	const { calls, actions } = recorder();
	const handlers = bindPanelKeys(scope, actions);
	return { scope, live, removed, calls, handlers };
}

/** Run the handler bound to `key`. Fails loudly rather than passing on a typo. */
function fire(live: ReturnType<typeof bound>["live"], key: string, event: KeyboardEvent): unknown {
	const entry = live.find((candidate) => candidate.key === key);
	assert.ok(entry, `nothing is bound to ${key}`);
	return entry.handler(event);
}

describe("binding the panel's keys", () => {
	it("binds every key in the table, once, with no modifiers", () => {
		// The empty modifier list is what makes these bare keys. Obsidian dispatches by
		// key name first, so `Ctrl+J` reaches this handler too and has to be turned
		// away by the handler rather than by never being registered.
		const { live } = bound();
		assert.deepEqual(
			live.map((entry) => entry.key),
			KEY_BINDINGS.map((binding) => binding.key),
		);
		for (const entry of live) {
			assert.deepEqual(entry.modifiers, [], `${String(entry.key)} was bound to a modifier`);
		}
	});

	it("sends each key to its own action and nothing else", () => {
		const { live, calls } = bound();
		for (const { key, action } of KEY_BINDINGS) {
			calls.length = 0;
			fire(live, key, press(key));
			assert.deepEqual(calls, [action], `${key} did not run ${action}`);
		}
	});

	it("covers every action the table names", () => {
		// `dispatch` is a switch, so a new action with no case would compile and do
		// nothing at all. This is the only thing that would notice.
		const { live, calls } = bound();
		const reachable = new Set<PanelAction>();
		for (const { key } of KEY_BINDINGS) {
			calls.length = 0;
			fire(live, key, press(key));
			for (const action of calls) reachable.add(action);
		}
		assert.deepEqual(
			[...reachable].sort(),
			[...new Set(KEY_BINDINGS.map((binding) => binding.action))].sort(),
		);
	});
});

describe("returning false, which is what stops a key doing two things", () => {
	it("returns false for an arrow key, so the panel does not also scroll", () => {
		// Obsidian reads `false` as "I handled this, preventDefault". Without it `j`
		// would move the selection and scroll the panel in the same keystroke, and the
		// cursor would land somewhere the user did not ask for.
		const { live } = bound();
		assert.equal(fire(live, "ArrowDown", press("ArrowDown")), false);
		assert.equal(fire(live, "ArrowUp", press("ArrowUp")), false);
	});

	it("returns false for every key it does act on", () => {
		const { live } = bound();
		for (const { key } of KEY_BINDINGS) {
			assert.equal(fire(live, key, press(key)), false, `${key} was not marked handled`);
		}
	});

	it("returns undefined for a key it leaves alone, so it is not swallowed", () => {
		const { live, calls } = bound();
		calls.length = 0;
		assert.equal(fire(live, "j", press("j", { ctrlKey: true })), undefined);
		assert.deepEqual(calls, [], "Ctrl+J ran the move action anyway");
	});
});

describe("keys that belong to somebody else", () => {
	it("leaves Ctrl+J to Obsidian's command palette", () => {
		// The comment in this file claims it, and it is the reason the modifier check
		// is in the handler rather than left to the binding.
		const { live, calls } = bound();
		for (const modifier of ["ctrlKey", "altKey", "metaKey", "shiftKey"]) {
			calls.length = 0;
			fire(live, "j", press("j", { [modifier]: true }));
			assert.deepEqual(calls, [], `j with ${modifier}`);
		}
	});

	it("leaves a modified key alone for every key it binds, not just `j`", () => {
		const { live, calls } = bound();
		for (const { key } of KEY_BINDINGS) {
			calls.length = 0;
			assert.equal(fire(live, key, press(key, { metaKey: true })), undefined, `${key} with meta`);
			assert.deepEqual(calls, [], `${key} with meta ran an action`);
		}
	});

	it("ignores anything typed into the search box", () => {
		// `/` focuses the box and every character after that is the user typing a
		// query. Acting on those would pin or summarize whatever the query matched.
		const { live, calls } = bound();
		for (const key of ["j", "p", "s", "/", "Escape"]) {
			calls.length = 0;
			const input = { tagName: "INPUT", isContentEditable: false };
			assert.equal(fire(live, key, pressAt(key, input)), undefined, `${key} in an input`);
			assert.deepEqual(calls, [], `${key} in an input ran an action`);
		}
	});

	it("ignores a contenteditable region, which is Obsidian's own editor", () => {
		const { live, calls } = bound();
		calls.length = 0;
		const editable = { tagName: "DIV", isContentEditable: true };
		assert.equal(fire(live, "s", pressAt("s", editable)), undefined);
		assert.deepEqual(calls, []);
	});

	it("still takes keys aimed at the panel itself", () => {
		// A toggle button keeps focus after a click, and the user should be able to
		// carry straight on with j/k rather than clicking the list again.
		const { live, calls } = bound();
		calls.length = 0;
		const button = { tagName: "BUTTON", isContentEditable: false };
		assert.equal(fire(live, "j", pressAt("j", button)), false);
		assert.deepEqual(calls, ["down"]);
	});
});

describe("unbinding", () => {
	it("takes every handle it returned back off the scope", () => {
		const { scope, live, handlers, removed } = bound();
		assert.equal(live.length, KEY_BINDINGS.length);
		unbindPanelKeys(scope, handlers);
		assert.equal(removed.length, KEY_BINDINGS.length);
		assert.deepEqual(removed, handlers, "unregistered something that was not ours");
		assert.deepEqual(live, [], "something is still bound after unbind");
	});

	it("does nothing at all when there is no scope, which is a closed view", () => {
		const { handlers } = bound();
		// The view nulls its scope on close; a stale handler list must not throw there.
		assert.doesNotThrow(() => unbindPanelKeys(null, handlers));
	});

	it("is safe to call twice", () => {
		// Obsidian unregisters a scope's handlers itself when a view closes, so this can
		// run over a list that has already been emptied.
		const { scope, live, handlers } = bound();
		unbindPanelKeys(scope, handlers);
		unbindPanelKeys(scope, handlers);
		assert.deepEqual(live, []);
	});
});