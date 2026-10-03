/**
 * What the pin menu offers on one project row, decided with nothing but arithmetic.
 *
 * Split out of `pin-menu.ts` so `node --test` can load it. That file imports `Menu`
 * from `obsidian`, which is a types-only package with no runtime entry, so anything
 * importing it fails to load outside Obsidian: the plan was extractable and
 * exported but still untestable until it lived somewhere the test runner could
 * reach. Same reasoning as `frontmatter.ts` and `keys.ts`.
 *
 * The contract this module keeps is that it decides *everything* about the menu:
 * which items appear, and what pin rank each one writes. `showPinMenu` only draws
 * the result. Anything decided here that also needs deciding there is a bug in one
 * of the two.
 */
import type { Project } from "./types.ts";

/**
 * Rank for "Pin last".
 *
 * Used as the target rank when pinning an unpinned project to the bottom of the
 * pinned group. Note: hand-edited frontmatter could have a pinned project at
 * this rank; the value is a target, not a guaranteed "unused" rank.
 */
export const LAST_PIN = 9999;

/** The actions that write a pin rank. Every other plan item opens something instead. */
export type PinningAction = "togglePin" | "moveUp" | "moveDown" | "pinLast";

/**
 * One item in the plan.
 *
 * Two variants rather than one interface with an optional `pin`, so a handler cannot
 * forget the rank: it is required on the pinning variant, and `showPinMenu` gets a
 * compile error instead of writing `item.pin ?? 0`, which would be an unpin.
 */
export type PinMenuPlanItem =
	| { action: PinningAction; title: string; icon: string; pin: number }
	| { action: "openSummary"; title: string; icon: string };

/**
 * The items for one project row, in the order the menu shows them.
 *
 * `topRank` is the rank "Pin to top" aims at, and it is clamped here rather than
 * trusted: a caller passing 0 would otherwise write "pin to 0", which is not a pin at
 * all, and the row would silently stay where it was.
 *
 * "Move up" is on the menu exactly when one step up is still a pin. That test is
 * `pin > 1` and nothing else, deliberately. An earlier version asked whether
 * `pin > topRank`, which made one row's menu depend on every other row's pin, and
 * put `pin - 1 -> 0` within reach: "Move up" from rank 1 writes 0, and 0 means
 * unpinned everywhere else in the plugin, so the project would leave the pinned
 * group without an unpin having been asked for. Rank 1 is the floor because of that.
 */
export function pinMenuPlan(
	project: Pick<Project, "pin" | "summary">,
	topRank: number,
): PinMenuPlanItem[] {
	const items: PinMenuPlanItem[] = [];
	const isPinned = project.pin > 0;

	items.push({
		title: isPinned ? "Unpin" : "Pin to top",
		icon: isPinned ? "x" : "pin",
		pin: isPinned ? 0 : Math.max(1, topRank),
		action: "togglePin",
	});

	if (isPinned) {
		// Ranks are the user's own numbers, so "one step" is arithmetic rather than a
		// swap: two pinned projects at 1 and 2 that both move up end up tied, which
		// the name ordering then separates.
		if (project.pin > 1) {
			items.push({
				title: "Move up",
				icon: "arrow-up",
				// Plain arithmetic, no clamp: the guard above means `pin - 1` is already at
				// least 1, so a `Math.max(1, ...)` here would never change an answer.
				// It looked like a second line of defence and was not one, because the
				// guard it appeared to protect is what actually keeps 0 off this item, and
				// that is what the tests in `pin-menu-plan.test.ts` pin.
				pin: project.pin - 1,
				action: "moveUp",
			});
		}
		items.push({
			title: "Move down",
			icon: "arrow-down",
			pin: project.pin + 1,
			action: "moveDown",
		});
	} else {
		items.push({
			title: "Pin last",
			icon: "pin",
			pin: LAST_PIN,
			action: "pinLast",
		});
	}

	if (project.summary) {
		items.push({
			title: "Open AI summary",
			icon: "bot",
			action: "openSummary",
		});
	}

	return items;
}