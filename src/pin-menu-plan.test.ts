import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LAST_PIN, pinMenuPlan } from "./pin-menu-plan.ts";
import type { PinMenuPlanItem } from "./pin-menu-plan.ts";
import type { SummaryState } from "./types.ts";

/** A project with nothing else on it, which is what the plan actually reads. */
function project(pin: number, summary?: SummaryState) {
	return { pin, summary };
}

/** Every action in a plan, in order. */
function actions(items: PinMenuPlanItem[]): string[] {
	return items.map((item) => item.action);
}

/** What one action would write, or undefined when the plan has no such item. */
function writes(items: PinMenuPlanItem[], action: PinMenuPlanItem["action"]): number | undefined {
	const item = items.find((candidate) => candidate.action === action);
	return item && "pin" in item ? item.pin : undefined;
}

/** A summary that exists, so `project.summary` is truthy. The plan only checks that. */
const HAS_SUMMARY: SummaryState = {
	path: "Projects/api-ai.md",
	generatedAt: "2026-10-01T10:00:00Z",
	commit: "abc1234",
	dirty: false,
	dirtyCount: 0,
	stale: false,
	staleReason: "",
};

describe("the pin menu plan", () => {
	it("offers a pin and a pin-last for an unpinned project", () => {
		assert.deepEqual(actions(pinMenuPlan(project(0), 4)), ["togglePin", "pinLast"]);
	});

	it("offers an unpin and both moves for a pinned project", () => {
		assert.deepEqual(actions(pinMenuPlan(project(3), 1)), ["togglePin", "moveUp", "moveDown"]);
	});

	it("labels the first item by what it will do", () => {
		// The title is the only thing standing between the user and an unpin they did
		// not mean, so "Unpin" has to be the word on it and not "Pin".
		assert.equal(pinMenuPlan(project(2), 1)[0].title, "Unpin");
		assert.equal(pinMenuPlan(project(0), 1)[0].title, "Pin to top");
	});

	it("always leads with the toggle, whatever else is on offer", () => {
		for (const pin of [0, 1, 2, 9999]) {
			for (const topRank of [1, 2, 9999]) {
				assert.equal(pinMenuPlan(project(pin), topRank)[0].action, "togglePin");
			}
		}
	});
});

describe("what each item writes", () => {
	it("unpins by writing 0, and pins to top by writing the caller's rank", () => {
		assert.equal(writes(pinMenuPlan(project(5), 1), "togglePin"), 0);
		assert.equal(writes(pinMenuPlan(project(0), 4), "togglePin"), 4);
	});

	it("clamps a top rank that is not a rank, rather than writing 0", () => {
		// 0 means unpinned. "Pin to top" that writes 0 does nothing at all and the
		// row looks broken, so the plan floors it instead of trusting the caller.
		for (const topRank of [0, -1, -9999]) {
			assert.equal(writes(pinMenuPlan(project(0), topRank), "togglePin"), 1, `topRank ${topRank}`);
		}
	});

	it("steps down by exactly one rank", () => {
		assert.equal(writes(pinMenuPlan(project(2), 1), "moveUp"), 1);
		assert.equal(writes(pinMenuPlan(project(9), 1), "moveUp"), 8);
		assert.equal(writes(pinMenuPlan(project(9), 1), "moveDown"), 10);
	});

	it("pins last at the documented rank", () => {
		assert.equal(writes(pinMenuPlan(project(0), 1), "pinLast"), LAST_PIN);
		assert.equal(LAST_PIN, 9999);
	});

	it("leaves a non-pinning item with nothing to write", () => {
		// There is no `pin` on this variant at all, so a summary click cannot write a
		// rank by accident.
		const [summaryItem] = pinMenuPlan(project(0, HAS_SUMMARY), 1).filter(
			(item) => item.action === "openSummary",
		);
		assert.equal("pin" in summaryItem, false);
	});
});

describe("move up cannot unpin a project", () => {
	it("is not on the menu at rank 1, whatever the caller's rank is", () => {
		// This is the case the item exists for. "Move up" from rank 1 writes 0, and 0
		// is unpinned, so the project leaves the pinned group without the user having
		// asked for an unpin.
		for (const topRank of [1, 2, 5, 9999]) {
			assert.equal(
				actions(pinMenuPlan(project(1), topRank)).includes("moveUp"),
				false,
				`move up offered at rank 1 with topRank ${topRank}`,
			);
		}
	});

	it("clamps the rank it writes, so 0 cannot come out of it", () => {
		// Belt and braces against the guard above being edited back into arithmetic
		// that trusts the current rank.
		for (const pin of [2, 3, 50, LAST_PIN]) {
			const written = writes(pinMenuPlan(project(pin), 1), "moveUp");
			assert.ok(written !== undefined, `no move up at ${pin}`);
			assert.ok(written >= 1, `move up from ${pin} would write ${written}`);
		}
	});

	it("only ever writes 0 for the deliberate unpin", () => {
		// The whole surface, swept. Every rank a user can end up holding, against every
		// top rank a caller can produce, including the impossible ones, because the
		// point is that the plan holds the line on inputs nobody has found yet.
		const pins = [0, 1, 2, 3, 7, 100, LAST_PIN, LAST_PIN + 1];
		const topRanks = [-3, 0, 1, 2, 4, 9998, 9999, 100000];
		for (const pin of pins) {
			for (const topRank of topRanks) {
				const unpinning = pin > 0;
				for (const item of pinMenuPlan(project(pin), topRank)) {
					if (!("pin" in item)) continue;
					if (item.pin === 0) {
						assert.equal(unpinning, true, `pin 0 offered for unpinned row at ${pin}`);
						assert.equal(item.action, "togglePin", `pin 0 from ${item.action} at ${pin}`);
						continue;
					}
					assert.ok(
						Number.isInteger(item.pin) && item.pin >= 1,
						`${item.action} at pin ${pin} would write ${item.pin}`,
					);
				}
			}
		}
	});

	it("does not hide move up because another project happens to be pinned higher", () => {
		// The old rule was `pin > topRank`, which made one row's menu depend on every
		// other row's pin: a project at rank 3 lost its "Move up" because the caller's
		// top rank was 9. It is on the menu here, and writes 2.
		const items = pinMenuPlan(project(3), 9);
		assert.equal(actions(items).includes("moveUp"), true, "move up hidden by an unrelated rank");
		assert.equal(writes(items, "moveUp"), 2);
	});
});

describe("the summary item", () => {
	it("is there when the project has a summary", () => {
		const items = pinMenuPlan(project(0, HAS_SUMMARY), 1);
		assert.deepEqual(actions(items), ["togglePin", "pinLast", "openSummary"]);
		assert.equal(items[2].title, "Open AI summary");
	});

	it("is absent when there is nothing to open", () => {
		// The normal case: most projects have never had a summary generated, so `summary`
		// is simply not on the object.
		assert.equal(actions(pinMenuPlan(project(0), 1)).includes("openSummary"), false);
		assert.equal(actions(pinMenuPlan(project(4), 1)).includes("openSummary"), false);
	});
});

describe("the plan as a function", () => {
	it("changes nothing about the project it was given", () => {
		const given = project(2, HAS_SUMMARY);
		const before = JSON.stringify(given);
		pinMenuPlan(given, 1);
		assert.equal(JSON.stringify(given), before);
	});

	it("gives the same answer twice", () => {
		// Pure, so the menu cannot differ between a right-click and a re-render.
		assert.deepEqual(pinMenuPlan(project(3, HAS_SUMMARY), 2), pinMenuPlan(project(3, HAS_SUMMARY), 2));
	});

	it("has no duplicate actions", () => {
		// Two items with the same action would mean the menu draws the first and the
		// handler fires whichever the user actually clicked.
		for (const pin of [0, 1, 2, 9999]) {
			const seen = actions(pinMenuPlan(project(pin, HAS_SUMMARY), 1));
			assert.equal(new Set(seen).size, seen.length, `duplicate action for pin ${pin}`);
		}
	});
});