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
 * A number no pinned project can hold, because `pin` is a plain number the panel
 * has never clamped, and ranks sort ascending, so this lands at the bottom of the
 * pinned group.
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

/** Build and show the menu for one project at the mouse. */
export function showPinMenu(event: MouseEvent, project: Project, actions: PinMenuActions): void {
	const menu = new Menu();
	const isPinned = project.pin > 0;

	menu.addItem((item) =>
		item
			.setTitle(isPinned ? "Unpin" : "Pin to top")
			.setIcon(isPinned ? "x" : "pin")
			.onClick(() => actions.onPin(project, isPinned ? 0 : actions.topRank)),
	);

	if (isPinned) {
		// Ranks are the user's own numbers, so "one step" is arithmetic rather than a
		// swap: two pinned projects at 1 and 2 that both move up end up tied, which
		// the name ordering then separates.
		//
		// "Move up" is hidden once the project is already at `topRank`, which is the
		// highest rank anything can take. Without that it would subtract 1 from rank 1
		// and land on 0, and 0 is not "one above the first pin", it is unpinned: the
		// project would disappear from the pinned group with no unpin having been
		// asked for.
		if (project.pin > actions.topRank) {
			menu.addItem((item) =>
				item
					.setTitle("Move up")
					.setIcon("arrow-up")
					.onClick(() => actions.onPin(project, Math.max(1, project.pin - 1))),
			);
		}
		menu.addItem((item) =>
			item.setTitle("Move down").setIcon("arrow-down").onClick(() => actions.onPin(project, project.pin + 1)),
		);
	} else {
		menu.addItem((item) =>
			item.setTitle("Pin last").setIcon("pin").onClick(() => actions.onPin(project, LAST_PIN)),
		);
	}

	if (project.summary) {
		menu.addItem((item) =>
			item
				.setTitle("Open AI summary")
				.setIcon("bot")
				.onClick(() => actions.onOpenSummary(project)),
		);
	}

	menu.addSeparator();
	menu.addItem((item) =>
		item.setTitle(actions.editorLabel).setIcon("folder-open").onClick(() => actions.onOpenEditor(project)),
	);
	menu.addItem((item) => item.setTitle("Open note").setIcon("file-text").onClick(() => actions.onOpenNote(project)));
	menu.showAtMouseEvent(event);
}
