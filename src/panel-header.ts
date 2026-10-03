/**
 * The panel's fixed furniture: title, search box, toggles, status line.
 *
 * Built once and then only updated. That is the whole reason this is a class
 * rather than a function that draws the header: the search box has to survive a
 * keystroke. A header rebuilt on every state change destroys the input the user is
 * typing into, which loses focus after one character and makes the filter unusable
 * no matter how good the matcher is.
 *
 * So the split is: this owns the elements that must persist, and `view.ts` owns
 * the rows, which are cheap to rebuild because nothing is typing into them.
 *
 * Plain `createElement` and `textContent` rather than Obsidian's `createDiv` and
 * `setText` prototype helpers, for the reason `row-controls.ts` uses them too:
 * the helpers only exist once Obsidian has patched the DOM, and a header that
 * throws while drawing leaves an empty panel with a stack trace nobody sees.
 */
import type { FilterState } from "./filter.ts";
import { keyHints } from "./keys.ts";

/** What the header shows on this pass. Everything here is set in place. */
export interface PanelHeaderState {
	/** Text in the box. Written into the input only when it is not already there. */
	query: string;
	filters: FilterState;
	/** True while a scan is running, which is the only thing that says so. */
	scanning: boolean;
	explainScores: boolean;
	/** The sentence from `describeFilter`, so the header does not count anything itself. */
	status: string;
	/** Absolute path being scanned, shown once under the controls. */
	scanRoot: string;
}

/** What the header reports back. All of it is the view's business, not the header's. */
export interface PanelHeaderActions {
	onQueryChange(query: string): void;
	onToggleActiveOnly(): void;
	onToggleShowDormant(): void;
	onTogglePinnedOnly(): void;
	onToggleExplainScores(): void;
	onRefresh(): void;
	/** Enter in the search box: open what is selected, the same as Enter outside it. */
	onSearchSubmit(): void;
}

/** The toggles, in the order they are drawn. The labels match the group headings. */
const TOGGLES = [
	{ key: "activeOnly", label: "Active", describe: "Show only active projects" },
	{ key: "showDormant", label: "Dormant", describe: "Include dormant projects, with no live work" },
	{ key: "pinnedOnly", label: "Pinned", describe: "Show only pinned projects" },
	{ key: "explainScores", label: "Why", describe: "Show why each project has the score it has" },
] as const;

export class PanelHeader {
	/** Where rows go. The only part of the panel that is emptied on every render. */
	readonly rowsEl: HTMLElement;

	private readonly doc: Document;
	private readonly searchEl: HTMLInputElement;
	private readonly statusEl: HTMLElement;
	private readonly rootEl: HTMLElement;
	private readonly refreshEl: HTMLButtonElement;
	private readonly toggles = new Map<string, HTMLButtonElement>();

	constructor(doc: Document, host: HTMLElement, actions: PanelHeaderActions) {
		this.doc = doc;

		const header = doc.createElement("div");
		header.className = "pt-header";
		host.appendChild(header);

		const title = doc.createElement("div");
		title.className = "pt-title";
		title.textContent = "Projects";
		header.appendChild(title);

		const controls = doc.createElement("div");
		controls.className = "pt-controls";
		header.appendChild(controls);

		this.refreshEl = button(doc, "Refresh", "Rescan every repository under the scan root", () => {
			actions.onRefresh();
		});
		controls.appendChild(this.refreshEl);

		for (const toggle of TOGGLES) {
			const el = button(doc, toggle.label, toggle.describe, () => {
				switch (toggle.key) {
					case "activeOnly":
						actions.onToggleActiveOnly();
						break;
					case "showDormant":
						actions.onToggleShowDormant();
						break;
					case "pinnedOnly":
						actions.onTogglePinnedOnly();
						break;
					case "explainScores":
						actions.onToggleExplainScores();
						break;
				}
			});
			this.toggles.set(toggle.key, el);
			controls.appendChild(el);
		}

		// One input, built once. Its value is only ever written back when it differs
		// from what is already typed, because assigning `value` moves the caret to
		// the end even when the text is identical.
		this.searchEl = doc.createElement("input");
		this.searchEl.type = "search";
		this.searchEl.className = "pt-search";
		this.searchEl.placeholder = "Filter projects, or press / to focus";
		this.searchEl.setAttribute("aria-label", "Filter projects by name");
		this.searchEl.addEventListener("input", () => actions.onQueryChange(this.searchEl.value));
		// Enter and Escape are handled here rather than through the view's key scope:
		// the scope deliberately ignores everything aimed at an input, which is what
		// keeps typing a query from firing panel actions.
		//
		// Both hand the keyboard back to the panel. Enter opens what is selected, so
		// after typing a query the arrow keys pick a row and Enter goes there; that is
		// the search-then-choose path users expect from a list, and it is the one the
		// scope's Enter would have provided if the box were not focused.
		this.searchEl.addEventListener("keydown", (event) => {
			if (event.key === "Enter") {
				event.preventDefault();
				this.blurSearch();
				actions.onSearchSubmit();
				return;
			}
			if (event.key !== "Escape") return;
			event.preventDefault();
			this.searchEl.value = "";
			actions.onQueryChange("");
			this.blurSearch();
		});
		header.appendChild(this.searchEl);

		this.rootEl = doc.createElement("div");
		this.rootEl.className = "pt-root";
		host.appendChild(this.rootEl);

		const status = doc.createElement("div");
		status.className = "pt-status";
		host.appendChild(status);

		const statusText = doc.createElement("span");
		statusText.className = "pt-status-text";
		status.appendChild(statusText);

		const hints = doc.createElement("span");
		hints.className = "pt-keys";
		hints.textContent = keyHints();
		status.appendChild(hints);
		this.statusEl = statusText;

		this.rowsEl = doc.createElement("div");
		this.rowsEl.className = "pt-body";
		host.appendChild(this.rowsEl);
	}

	/**
	 * Refresh the furniture in place.
	 *
	 * No element is created or destroyed, which is the point: the input keeps focus
	 * and the caret, the buttons keep whatever the user is hovering, and nothing
	 * flickers.
	 */
	update(state: PanelHeaderState): void {
		if (this.searchEl.value !== state.query) this.searchEl.value = state.query;

		const label = state.scanning ? "…" : "Refresh";
		if (this.refreshEl.textContent !== label) this.refreshEl.textContent = label;
		this.refreshEl.disabled = state.scanning;

		const pressed: Record<string, boolean> = {
			activeOnly: state.filters.activeOnly,
			showDormant: state.filters.showDormant,
			pinnedOnly: state.filters.pinnedOnly,
			explainScores: state.explainScores,
		};
		for (const [key, el] of this.toggles) setPressed(el, pressed[key] === true);

		const root = state.scanRoot;
		if (this.rootEl.textContent !== root) this.rootEl.textContent = root;
		const status = state.status;
		if (this.statusEl.textContent !== status) this.statusEl.textContent = status;
	}

	/** Put the caret in the search box, with any query already in it selected. */
	focusSearch(): void {
		this.searchEl.focus();
		this.searchEl.select();
	}

	/** Take focus off the search box, so j/k and Enter go back to the panel. */
	blurSearch(): void {
		if (this.doc.activeElement === this.searchEl) this.searchEl.blur();
	}

	/** Forget the elements. The view drops its reference at the same time. */
	destroy(): void {
		this.rowsEl.remove();
	}
}

/** A header button, with the full wording on both `aria-label` and `title`. */
function button(doc: Document, label: string, describe: string, onClick: () => void): HTMLButtonElement {
	const el = doc.createElement("button");
	el.type = "button";
	el.className = "pt-btn";
	el.textContent = label;
	el.setAttribute("aria-label", describe);
	el.setAttribute("title", describe);
	el.addEventListener("click", (event) => {
		// Hand focus back to the panel. Left alone, a clicked toggle keeps focus and
		// the next Enter re-triggers it as well as opening the selected project.
		(event.currentTarget as HTMLElement).blur();
		onClick();
	});
	return el;
}

/** Show or clear a toggle's pressed state. Idempotent, so it is safe on every pass. */
function setPressed(el: HTMLButtonElement, pressed: boolean): void {
	el.classList.toggle("is-on", pressed);
	el.setAttribute("aria-pressed", String(pressed));
}
