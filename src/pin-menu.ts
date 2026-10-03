/**
 * The right-click menu on one project row.
 *
 * Out of `view.ts` because it is a self-contained list of what can be done to one
 * project, and because it grew: it was a 48-line method sitting in the middle of
 * the render code, and nothing in it needs the view's state except the project, the
 * editor setting, and the rank a new pin should take.
 *
 * Every action comes in as a callback. The menu decides what is on offer and the
 * view decides what happens, which is the same split `row-controls.ts` uses.
 */
import { Menu } from "obsidian";
import type { Project } from "./types";

/**
 * Rank for "Pin last".
 *
 * Used as the target rank when pinning an unpinned project to the bottom of the
 * pinned group. Note: hand-edited frontmatter could have a pinned project at
 * this rank; the value is a target, not a guaranteed "unused" rank.
 */
export const LAST_PIN = 9999;

export interface PinMenuActions {
	/** Move the project to this rank. 0 unpins it. */
	onPin(project: Project, pin: number): void;
	/**
	 * The highest rank a pin can take: one below the lowest rank in use, floored at
	 * 1. Doubles as "is this project already first?", which is what decides whether
	 * "Move up" is on the menu at all.
	 */
	topRank: number;
	onOpenSummary(project: Project): void;
	onOpenEditor(project: Project): void;
	onOpenNote(project: Project): void;
	/** Wording for the editor item, which depends on the configured command. */
	editorLabel: string;
}

/** A menu item in the pin menu plan. */
export interface PinMenuPlanItem {
	title: string;
	icon: string;
	/** Pin rank to write, or undefined if this item does not pin. */
	pin?: number;
	/** Action key to perform (not clicking - just identifying the action). */
	action: "togglePin" | "moveUp" | "moveDown" | "pinLast" | "openSummary" | "openEditor" | "openNote";
}

/** Pure plan for pin menu items - testable without Obsidian. */
export function pinMenuPlan(
	project: Pick<Project, "pin" | "summary">,
	topRank: number,
): PinMenuPlanItem[] {
	const items: PinMenuPlanItem[] = [];
	const isPinned = project.pin > 0;

	items.push({
		title: isPinned ? "Unpin" : "Pin to top",
		icon: isPinned ? "x" : "pin",
		pin: isPinned ? 0 : topRank,
		action: "togglePin",
	});

	if (isPinned) {
		// Ranks are the user's own numbers, so "one step" is arithmetic rather than a
		// swap: two pinned projects at 1 and 2 that both move up end up tied, which
		// the name ordering then separates.
		//
		// "Move up" is hidden once the project is already at or at the top boundary
		// where moving up would land at 0 (unpinned). Clamp to not go below 1.
		if (project.pin > 1) {
			items.push({
				title: "Move up",
				icon: "arrow-up",
				pin: Math.max(1, project.pin - 1),
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

/** Build and show the menu for one project at the mouse. */
export function showPinMenu(event: MouseEvent, project: Project, actions: PinMenuActions): void {
	const menu = new Menu();
	const plan = pinMenuPlan(project, actions.topRank);

	for (const item of plan) {
		if (item.action === "togglePin" || item.action === "moveUp" || item.action === "moveDown" || item.action === "pinLast") {
			menu.addItem((mi) =>
				mi
					.setTitle(item.title)
					.setIcon(item.icon)
					.onClick(() => actions.onPin(project, item.pin ?? 0)),
			);
			continue;
		}
		if (item.action === "openSummary") {
			menu.addItem((mi) =>
				mi
					.setTitle(item.title)
					.setIcon(item.icon)
					.onClick(() => actions.onOpenSummary(project)),
			);
			continue;
		}
	}

	menu.addSeparator();
	menu.addItem((item) =>
		item.setTitle(actions.editorLabel).setIcon("folder-open").onClick(() => actions.onOpenEditor(project)),
	);
	menu.addItem((item) => item.setTitle("Open note").setIcon("file-text").onClick(() => actions.onOpenNote(project)));
	menu.showAtMouseEvent(event);
}
