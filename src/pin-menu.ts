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
 *
 * What is on offer is `pinMenuPlan`, which lives in `pin-menu-plan.ts` because this
 * file cannot be loaded outside Obsidian: it imports `Menu`, and `obsidian` is a
 * types-only package. The decisions are all there so `node --test` can check them.
 */
import { Menu } from "obsidian";
import { pinMenuPlan } from "./pin-menu-plan";
import type { Project } from "./types";

export interface PinMenuActions {
	/** Move the project to this rank. 0 unpins it. */
	onPin(project: Project, pin: number): void;
	/**
	 * The highest rank a pin can take: one below the lowest rank in use, floored at
	 * 1. Only "Pin to top" uses it, and the plan clamps it again in case a caller
	 * passes something lower.
	 */
	topRank: number;
	onOpenSummary(project: Project): void;
	onOpenEditor(project: Project): void;
	onOpenNote(project: Project): void;
	/** Wording for the editor item, which depends on the configured command. */
	editorLabel: string;
}

export type { PinMenuPlanItem } from "./pin-menu-plan";

/** Build and show the menu for one project at the mouse. */
export function showPinMenu(event: MouseEvent, project: Project, actions: PinMenuActions): void {
	const menu = new Menu();
	const plan = pinMenuPlan(project, actions.topRank);

	for (const item of plan) {
		if (item.action === "openSummary") {
			menu.addItem((mi) =>
				mi
					.setTitle(item.title)
					.setIcon(item.icon)
					.onClick(() => actions.onOpenSummary(project)),
			);
			continue;
		}
		// The plan's other variant, narrowed by the type: `pin` is required here, so
		// there is no "forgot the rank" case that silently writes 0.
		menu.addItem((mi) =>
			mi
				.setTitle(item.title)
				.setIcon(item.icon)
				.onClick(() => actions.onPin(project, item.pin)),
		);
	}

	menu.addSeparator();
	menu.addItem((item) =>
		item.setTitle(actions.editorLabel).setIcon("folder-open").onClick(() => actions.onOpenEditor(project)),
	);
	menu.addItem((item) => item.setTitle("Open note").setIcon("file-text").onClick(() => actions.onOpenNote(project)));
	menu.showAtMouseEvent(event);
}
