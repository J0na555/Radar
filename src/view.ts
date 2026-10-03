import { ItemView, Notice, Scope, WorkspaceLeaf } from "obsidian";
import type { KeymapEventHandler } from "obsidian";
import { editorActionLabel } from "./editor";
import { describeFilter, filterProjects, isFiltering, nextStateOnEscape } from "./filter";
import type { FilterRow, FilterState } from "./filter";
import { moveSelection, NO_SELECTION, reconcileSelection } from "./keys";
import { openProjectNote, openSummaryNote } from "./note-open";
import { drawPanelBody } from "./panel-body";
import { PanelHeader } from "./panel-header";
import { bindPanelKeys, unbindPanelKeys } from "./panel-keys";
import { showPinMenu } from "./pin-menu";
import type { PinMenuActions } from "./pin-menu";
import { applyPin } from "./pin-queue";
import { rankProjects, topPinRank } from "./rank";
import { isInsideScrollBox } from "./scroll";
import type { Project, PluginSettings, SummaryState } from "./types";

export const VIEW_TYPE_PROJECT_TRACKER = "project-tracker-view";

/**
 * Icon for the ribbon button and the view tab.
 *
 * Obsidian types this parameter as a plain string, so a typo here compiles
 * cleanly and then renders as a blank button instead of failing. Verified
 * against the icon map shipped in Obsidian 1.13.7, which defines "git-branch".
 */
export const ICON_PROJECT_TRACKER = "git-branch";

export class ProjectTrackerView extends ItemView {
	private projects: Project[] = [];
	private now = Date.now();
	private scanning = false;
	/** Project names with a summary run in flight, so the button cannot double-fire. */
	private summarizing = new Set<string>();
	/**
	 * True from `onClose` on, so nothing that settles late draws into a dead view.
	 *
	 * A pin write outlives the panel that started it: it is a note write, not a redraw.
	 * The queue itself lives in the plugin (see `plugin.refresh`), so a queued write
	 * still has to finish after this view is gone.
	 */
	private closed = false;

	/**
	 * The parts of the filter the view owns.
	 *
	 * `showDormant` is deliberately not here: it is the plugin's own persisted
	 * setting, so the settings tab and this panel cannot disagree about it.
	 */
	private viewFilters = { query: "", activeOnly: false, pinnedOnly: false };

	/** The selection, remembered by name. See `reconcileSelection`. */
	private selectedName: string | null = null;
	private selectedIndex = NO_SELECTION;
	/**
	 * What is on screen, in display order.
	 *
	 * The project and its element in one entry, because the selection is an index
	 * into this list and two parallel arrays would be two things to keep in step.
	 */
	private visible: { row: FilterRow; el: HTMLElement }[] = [];

	private header: PanelHeader | null = null;
	private keyHandlers: KeymapEventHandler[] = [];

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: {
			settings: PluginSettings;
			saveSettings: () => Promise<void>;
			/** The only call in this file that rescans. Everything else filters in memory. */
			refresh: () => Promise<Project[]>;
			getProjects: () => Project[];
			/** Write one project's pin without rescanning. False when the write failed. */
			savePin: (project: Project) => Promise<boolean>;
			/**
			 * Hand one pin write to the plugin's queue, which orders it per project and
			 * which `plugin.refresh` waits on before it reads pins back out of the notes.
			 */
			queuePinWrite: (
				project: Project,
				target: () => number,
				write: (pin: number) => Promise<void>,
			) => Promise<void>;
			generateSummary: (project: Project) => Promise<SummaryState | null>;
			/** Hand a project's folder to the configured editor. */
			openRepoFolder: (project: Project) => Promise<void>;
			/** Where a failure is recorded, so a notice can name the file. */
			errorLogSentence: string;
		},
	) {
		super(leaf);
	}

	override async onOpen(): Promise<void> {
		// Cleared again in case this instance is ever reopened, so the flag can only
		// ever mean "the view is not on screen", never "it was not at some point".
		this.closed = false;
		this.buildChrome();
		this.registerKeys();
		await this.refresh();
	}

	override async onClose(): Promise<void> {
		// Set first, so anything that settles while this method is running draws
		// nothing. A pin write or a summary finishing afterwards used to reach
		// `render`, which found `header === null` and called `buildChrome`, putting a
		// fresh header into a view Obsidian has already torn down.
		this.closed = true;
		// Unregistered by hand rather than left to the scope, so a closed view holds
		// no reference to this project's actions.
		unbindPanelKeys(this.scope, this.keyHandlers);
		this.keyHandlers = [];
		this.scope = null;
		this.summarizing.clear();
		this.header?.destroy();
		this.header = null;
		this.visible = [];
		this.contentEl.empty();
	}

	override getViewType(): string {
		return VIEW_TYPE_PROJECT_TRACKER;
	}

	override getDisplayText(): string {
		return "Project Tracker";
	}

	override getIcon(): string {
		return ICON_PROJECT_TRACKER;
	}

	/**
	 * Rescan the filesystem, then redraw. The only thing that forks `git`.
	 *
	 * The pin queue is settled inside `plugin.refresh`, not here. It used to be settled
	 * here, which covered this one path and left "Rescan projects" in the command
	 * palette racing any pin in flight.
	 */
	async refresh(): Promise<void> {
		if (this.scanning) return;
		this.scanning = true;
		// Drawn before the scan, so the button says it is working rather than
		// appearing to hang for a fifth of a second.
		this.render();
		try {
			await this.plugin.refresh();
			this.projects = this.plugin.getProjects();
			this.now = Date.now();
		} catch (error) {
			new Notice(`Project Tracker: scan failed (${String(error)})`);
		} finally {
			this.scanning = false;
			this.render();
		}
	}

	// ---------------------------------------------------------------- rendering

	/**
	 * Redraw the list.
	 *
	 * The header, the search box and the toggles are built once by `buildChrome` and
	 * only ever updated here. Rows are rebuilt every time, and nothing else is.
	 *
	 * This is not a style preference, it is what makes the two features above work:
	 *
	 *  - `contentEl.empty()` at the top of this method would destroy the search input
	 *    on the first keystroke. The element the user is typing into would be
	 *    replaced by a fresh empty one, focus would go back to the panel body, and the
	 *    second character would land nowhere. A filter box that cannot be typed into
	 *    is not a filter box.
	 *  - It would throw away the selection as well, since the selection is a position
	 *    in a list of rows and the rows would be new elements. `j` would land on a row
	 *    nobody had highlighted, and the highlighted row would be gone after a summary
	 *    finished.
	 *
	 * So: the furniture persists, the rows do not, and the scroll offset and the
	 * selected project are both carried across. If someone is tempted to "simplify"
	 * this back to one `empty()`, the search box and the keyboard selection go with
	 * it, and neither failure is visible until somebody uses them.
	 */
	private render(): void {
		// A pin write or a summary that settles after the view closed would otherwise
		// find `header === null` and rebuild the chrome into a view that is gone.
		if (this.closed) return;
		// Something outside the plugin can empty a view between renders. Drawing into
		// detached elements shows nothing at all, so rebuild rather than go blank.
		if (!this.header || !this.contentEl.contains(this.header.rowsEl)) this.buildChrome();
		const header = this.header;
		if (!header) return;

		const filters = this.filterState();
		// Both of these hand back a new array. Nothing below sorts or writes to the
		// plugin's own project list, which is why a filter can be undone.
		const ranked = rankProjects(this.projects);
		const result = filterProjects(ranked, filters);

		// The selection is resolved before anything is drawn, because a row has to
		// know whether it is the selected one while it is being built.
		const names = result.rows.map((row) => row.project.facts.name);
		this.selectedIndex = reconcileSelection(this.selectedIndex, names, this.selectedName);
		this.selectedName = names[this.selectedIndex] ?? null;

		header.update({
			query: filters.query,
			filters,
			scanning: this.scanning,
			explainScores: this.plugin.settings.explainScores,
			status: describeFilter(result),
			scanRoot: this.plugin.settings.scanRoot,
		});

		// Emptying a scrolling container clamps its scrollTop to zero, so the position
		// is saved and put back around the rebuild. Without this the panel jumps back to
		// the top on every keystroke in the filter box.
		const scrolled = header.rowsEl.scrollTop;

		const els = drawPanelBody(this.doc, header.rowsEl, result, {
			selectedIndex: this.selectedIndex,
			filtering: isFiltering(filters),
			explainScores: this.plugin.settings.explainScores,
			editorLabel: (project) => editorActionLabel(project.facts.name, this.plugin.settings.editorCommand),
			now: this.now,
			summarizing: this.summarizing,
			onSelect: (index, project) => this.selectRow(index, project),
			onOpenNote: (project) => void openProjectNote(this.app, project),
			onRunSummary: (project) => void this.runSummary(project),
			onOpenEditor: (project) => void this.plugin.openRepoFolder(project),
			onContextMenu: (event, project) =>
				showPinMenu(event, project, {
					...this.pinMenuActions(),
					editorLabel: editorActionLabel(project.facts.name, this.plugin.settings.editorCommand),
				}),
		});
		this.visible = result.rows.map((row, index) => ({ row, el: els[index] }));

		header.rowsEl.scrollTop = scrolled;
		this.scrollSelectionIntoView(header.rowsEl);
	}

	/**
	 * Keep the selected row on screen, but only when it is not already visible.
	 *
	 * Scrolling on every render would fight the user: a summary finishing in the
	 * background would drag the viewport back to the cursor mid-scroll. The old
	 * check compared by project name, which conflates "same project" with "same
	 * place on screen". For example, pinning a row at index 20 can move it into
	 * the pinned group at index 0 while the cursor follows it by name; if
	 * `scrolledToName` is unchanged, the early return fires and the highlight can
	 * end up off screen. Pressing `p` again would then appear to do nothing.
	 *
	 * So after the scroll restore, check the selected element against the box it is
	 * actually scrolled inside, and scroll only if it is not visible there.
	 *
	 * The scroller is `header.rowsEl`, passed in, and that detail is the whole fix.
	 * This used to ask the row for its `offsetParent`, which is the nearest
	 * *positioned* ancestor. `.pt-body` declares no `position`, so it can never be the
	 * answer: the comparison ran against a higher box that starts above `.pt-body` by
	 * the height of the title, controls and status line. A row scrolled a little way
	 * past the top of the list sits in that band, inside the ancestor's rect, so
	 * `isVisible` came out true and nothing scrolled. Pinning a row from the middle of
	 * the list jumps it to the top, which is exactly such a case, so the flagship `p`
	 * interaction stayed broken for any jump shorter than the header.
	 *
	 * O(1), and it handles pin, unpin, filter and `j`/`k` uniformly, while still
	 * protecting against background renders yanking the viewport: an element already
	 * visible does not scroll.
	 *
	 * Not covered by a test, because it needs real layout. What is tested is the
	 * decision in `scroll.ts`, against the two boxes this mistake produced.
	 */
	private scrollSelectionIntoView(scroller: HTMLElement): void {
		const selected = this.visible[this.selectedIndex];
		if (!selected) return;
		const el = selected.el;
		if (!isInsideScrollBox(scroller.getBoundingClientRect(), el.getBoundingClientRect())) {
			el.scrollIntoView({ block: "nearest" });
		}
	}

	/** The filter the panel is showing, with the persisted dormant setting folded in. */
	private filterState(): FilterState {
		return { ...this.viewFilters, showDormant: this.plugin.settings.showDormant };
	}

	private buildChrome(): void {
		this.header = new PanelHeader(this.doc, this.contentEl, {
			onQueryChange: (query) => {
				// Filtering the projects already in memory. No scan, deliberately.
				this.viewFilters.query = query;
				this.render();
			},
			onToggleActiveOnly: () => {
				this.viewFilters.activeOnly = !this.viewFilters.activeOnly;
				this.render();
			},
			onTogglePinnedOnly: () => {
				this.viewFilters.pinnedOnly = !this.viewFilters.pinnedOnly;
				this.render();
			},
			onToggleShowDormant: () => void this.toggleShowDormant(),
			onToggleExplainScores: () => void this.toggleExplainScores(),
			onRefresh: () => void this.refresh(),
			onSearchSubmit: () => void openProjectNote(this.app, this.selectedProject()),
		});
	}

	private async toggleShowDormant(): Promise<void> {
		this.plugin.settings.showDormant = !this.plugin.settings.showDormant;
		await this.plugin.saveSettings();
		this.render();
	}

	private async toggleExplainScores(): Promise<void> {
		this.plugin.settings.explainScores = !this.plugin.settings.explainScores;
		await this.plugin.saveSettings();
		this.render();
	}

	// ------------------------------------------------------------------ actions

	private moveSelectionBy(direction: 1 | -1): void {
		this.selectedIndex = moveSelection(this.selectedIndex, this.visible.length, direction);
		this.selectedName = this.selectedProject()?.facts.name ?? null;
		this.render();
	}

	/**
	 * Put the selection on a row the user clicked.
	 *
	 * One notion of the current row, deliberately. Clicking a row's name used to open
	 * its note and leave the highlight where it was, so the panel had two: this one,
	 * which `j`, `Enter`, `s` and `p` act on, and whichever was last clicked. Click a
	 * row, press `s`, and the summary ran somewhere else.
	 *
	 * Both fields are set rather than leaving `render` to reconcile them. The click
	 * happens on an element that `render` is about to replace, and the index is the
	 * row's own, so there is nothing to reconcile.
	 */
	private selectRow(index: number, project: Project): void {
		this.selectedIndex = index;
		this.selectedName = project.facts.name;
		this.render();
	}

	private clearFilters(): void {
		const next = nextStateOnEscape(this.filterState());
		// showDormant is not copied across: it is the persisted setting, and `Esc` is
		// not consent to forget it.
		this.viewFilters = { query: next.query, activeOnly: next.activeOnly, pinnedOnly: next.pinnedOnly };
		this.header?.blurSearch();
		this.render();
	}

	/**
	 * Queue a pin write for one project, behind whatever is already writing it.
	 *
	 * The ordering lives in the plugin (`pin-queue.ts`) because the plugin's
	 * `refresh` is the thing that has to wait for it, and two callers reach that.
	 * What is left here is the part that is about this panel.
	 */
	private queuePin(project: Project, target: () => number): Promise<void> {
		return this.plugin.queuePinWrite(project, target, (pin) => this.writePin(project, pin));
	}

	/**
	 * One pin write: draw it, write it, and put the row back if the write failed.
	 *
	 * This used to call `refresh`, which forked a `git` process per repository and
	 * rewrote every note to store one integer, on a panel that had just been told to
	 * make a 45-row list easier to use. The pin is one field of one note, so it is
	 * written on its own.
	 *
	 * `applyPin` does the draw-write-rollback, because that ordering is what has to be
	 * tested and this file cannot be loaded by the test runner. The rollback is only
	 * safe because the queue runs this after the previous write for this project has
	 * settled; see `PinQueue`.
	 */
	private async writePin(project: Project, pin: number): Promise<void> {
		const saved = await applyPin(project, pin, {
			save: (target) => this.plugin.savePin(target),
			onChange: () => this.render(),
		});
		if (saved) return;
		new Notice(
			`Project Tracker: could not save the pin for ${project.facts.name}. ${this.plugin.errorLogSentence}`,
			0,
		);
	}

	/**
	 * `p` on a row: pin it above everything else, or unpin it if it is already pinned.
	 *
	 * `topPinRank` is the highest rank a pin can take, so this lands in the pinned
	 * group at the front of it. When something is already pinned at rank 1 the new
	 * pin ties it and score order decides, which is what the menu's "Move up" is for.
	 */
	private togglePin(project: Project): Promise<void> {
		return this.queuePin(project, () => (project.pin > 0 ? 0 : topPinRank(this.projects)));
	}

	/**
	 * Run one summary, then redraw.
	 *
	 * The in-flight guard is here rather than in the plugin because the button and the
	 * `s` key are what need it: a second run while a CLI is working would put two
	 * prompts and two writes in flight for the same file, and the second would win for
	 * no reason the user could see.
	 */
	private async runSummary(project: Project): Promise<void> {
		if (this.summarizing.has(project.facts.name)) return;
		this.summarizing.add(project.facts.name);
		this.render();
		try {
			await this.plugin.generateSummary(project);
		} catch (error) {
			// generateSummary handles its own failures and records them; this catches
			// anything that escapes it so a thrown error never leaves the control stuck
			// on "…". Names the log, because the point of the log is that a failure is
			// readable without the devtools console.
			new Notice(
				`Project Tracker: summary failed for ${project.facts.name} (${String(error)}). ${this.plugin.errorLogSentence}`,
				0,
			);
		} finally {
			this.summarizing.delete(project.facts.name);
			this.render();
		}
	}

	// ----------------------------------------------------------------- keyboard

	/**
	 * Bind the panel's keys, through Obsidian's scope for this view.
	 *
	 * `panel-keys.ts` has the scope mechanics and the "leave this event alone"
	 * rules; this method is the list of what each key means. Nothing here filters,
	 * opens a file, or rescans by accident: every action goes through one of the
	 * view's own methods.
	 */
	private registerKeys(): void {
		const scope = new Scope(this.app.scope);
		this.scope = scope;
		this.keyHandlers = bindPanelKeys(scope, {
			onDown: () => this.moveSelectionBy(1),
			onUp: () => this.moveSelectionBy(-1),
			onOpen: () => void openProjectNote(this.app, this.selectedProject()),
			onSummarize: () => {
				const project = this.selectedProject();
				if (project) void this.runSummary(project);
			},
			onPin: () => {
				const project = this.selectedProject();
				if (project) void this.togglePin(project);
			},
			onRefresh: () => void this.refresh(),
			onSearch: () => this.header?.focusSearch(),
			onClear: () => this.clearFilters(),
		});
	}

	/** The project the keyboard is on, or null when there is nothing to act on. */
	private selectedProject(): Project | null {
		return this.selectedIndex >= 0 ? (this.visible[this.selectedIndex]?.row.project ?? null) : null;
	}

	/** Everything the right-click menu can do, apart from the one label it needs. */
	private pinMenuActions(): Omit<PinMenuActions, "editorLabel"> {
		return {
			onPin: (project, pin) => void this.queuePin(project, () => pin),
			topRank: topPinRank(this.projects),
			onOpenSummary: (project) => void openSummaryNote(this.app, project),
			onOpenEditor: (project) => void this.plugin.openRepoFolder(project),
			onOpenNote: (project) => void openProjectNote(this.app, project),
		};
	}

	/** The document this view draws into. Rows build their elements from it. */
	private get doc(): Document {
		return this.contentEl.ownerDocument;
	}
}
