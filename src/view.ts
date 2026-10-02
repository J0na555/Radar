import { ItemView, Menu, Notice, TFile, WorkspaceLeaf } from "obsidian";
import { relativeAge } from "./format";
import { PluginSettings, Project, ProjectStatus, SummaryState } from "./types";
import { rankProjects } from "./rank";

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

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: {
			settings: PluginSettings;
			saveSettings: () => Promise<void>;
			refresh: () => Promise<Project[]>;
			getProjects: () => Project[];
			generateSummary: (project: Project) => Promise<SummaryState | null>;
			/** Where a failure is recorded, so a notice can name the file. */
			errorLogSentence: string;
		},
	) {
		super(leaf);
	}

	override async onOpen(): Promise<void> {
		await this.refresh();
	}

	/** Rescan the filesystem, then redraw. */
	async refresh(): Promise<void> {
		if (this.scanning) return;
		this.scanning = true;
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

	override getViewType(): string {
		return VIEW_TYPE_PROJECT_TRACKER;
	}

	override getDisplayText(): string {
		return "Project Tracker";
	}

	override getIcon(): string {
		return ICON_PROJECT_TRACKER;
	}

	override async onClose(): Promise<void> {
		this.contentEl.empty();
	}

	/** Persist a new pin rank (0 unpins) and re-rank. */
	private async setPin(name: string, pin: number): Promise<void> {
		const project = this.projects.find((p) => p.facts.name === name);
		if (!project) return;
		project.pin = pin;
		await this.plugin.refresh();
		this.projects = this.plugin.getProjects();
		this.render();
	}

	private renderHeader(): HTMLElement {
		const header = this.contentEl.createDiv({ cls: "pt-header" });

		const title = header.createDiv({ cls: "pt-title" });
		title.setText("Projects");

		const controls = header.createDiv({ cls: "pt-controls" });

		const refresh = controls.createEl("button", {
			cls: "pt-btn",
			attr: { "aria-label": "Rescan projects" },
		});
		refresh.setText(this.scanning ? "…" : "Refresh");
		refresh.addEventListener("click", () => void this.refresh());

		const dormant = controls.createEl("button", {
			cls: `pt-btn ${this.plugin.settings.showDormant ? "is-on" : ""}`.trim(),
			attr: { "aria-pressed": String(this.plugin.settings.showDormant) },
		});
		dormant.setText("Dormant");
		dormant.addEventListener("click", () => {
			void (async () => {
				this.plugin.settings.showDormant = !this.plugin.settings.showDormant;
				await this.plugin.saveSettings();
				this.render();
			})();
		});

		const root = this.contentEl.createDiv({ cls: "pt-root" });
		root.setText(this.plugin.settings.scanRoot);
		return header;
	}

	/** Right-click menu for pinning actions. */
	private showPinMenu(event: MouseEvent, project: Project): void {
		const menu = new Menu();
		const isPinned = project.pin > 0;

		menu.addItem((item) =>
			item
				.setTitle(isPinned ? "Unpin" : "Pin to top")
				.setIcon(isPinned ? "x" : "pin")
				.onClick(() => void this.setPin(project.facts.name, 0)),
		);

		if (isPinned) {
			menu.addItem((item) =>
				item.setTitle("Move up").setIcon("arrow-up").onClick(() => void this.setPin(project.facts.name, project.pin - 1)),
			);
			menu.addItem((item) =>
				item
					.setTitle("Move down")
					.setIcon("arrow-down")
					.onClick(() => void this.setPin(project.facts.name, project.pin + 1)),
			);
		} else {
			menu.addItem((item) =>
				item.setTitle("Pin last").setIcon("pin").onClick(() => void this.setPin(project.facts.name, 9999)),
			);
		}

		if (project.summary) {
			menu.addItem((item) =>
				item
					.setTitle("Open AI summary")
					.setIcon("bot")
					.onClick(() => void this.openSummary(project)),
			);
		}

		menu.addSeparator();
		menu.addItem((item) =>
			item.setTitle("Open note").setIcon("file-text").onClick(() => void this.openNote(project)),
		);
		menu.showAtMouseEvent(event);
	}

	/**
	 * Run one summary, then redraw.
	 *
	 * The in-flight guard is here rather than in the plugin because the button is
	 * what needs it: a second click while a CLI is running would put two prompts
	 * and two writes in flight for the same file, and the second would win for no
	 * reason the user could see.
	 */
	private async runSummary(project: Project): Promise<void> {
		if (this.summarizing.has(project.facts.name)) return;
		this.summarizing.add(project.facts.name);
		this.render();
		try {
			await this.plugin.generateSummary(project);
		} catch (error) {
			// generateSummary handles its own failures and records them; this
			// catches anything that escapes it so a thrown error never leaves the
			// button stuck on "…". Names the log, because the point of the log is
			// that a failure is readable without the devtools console.
			new Notice(
				`Project Tracker: summary failed for ${project.facts.name} (${String(error)}). ${this.plugin.errorLogSentence}`,
				0,
			);
		} finally {
			this.summarizing.delete(project.facts.name);
			this.render();
		}
	}

	private async openSummary(project: Project): Promise<void> {
		const summary = project.summary;
		if (!summary) return;
		const file = this.app.vault.getAbstractFileByPath(summary.path);
		if (file instanceof TFile) {
			await this.app.workspace.getLeaf(false).openFile(file);
			return;
		}
		new Notice(`Project Tracker: ${summary.path} is not in the vault any more. Regenerate it.`);
	}

	/**
	 * The summary control for one row.
	 *
	 * Three states, and the difference between them is the point of the whole
	 * feature: nothing generated, something generated and current, and something
	 * generated that the repo has since moved past. A stale summary is the one
	 * that reads as authoritative while being wrong, so it gets its own wording
	 * and a warning colour rather than sharing a button with the current case.
	 */
	private renderSummaryControl(project: Project): HTMLElement {
		const summary = project.summary;
		const running = this.summarizing.has(project.facts.name);

		const label = running
			? "…"
			: !summary
				? "AI"
				: summary.stale
					? "stale"
					: "AI";

		const button = this.contentEl.ownerDocument.createElement("button");
		button.className = [
			"pt-btn",
			"pt-ai",
			summary?.stale ? "is-stale" : "",
			!summary ? "is-none" : "",
		]
			.filter(Boolean)
			.join(" ");
		button.setAttribute("type", "button");
		button.textContent = label;
		button.disabled = running;

		let title = summary
			? `Regenerate AI summary (written ${summary.generatedAt ?? "at an unknown time"} from ${summary.commit ?? "no commit"})`
			: "Generate an AI summary from git history";
		if (summary?.stale) {
			title = `Regenerate AI summary. This one is out of date: ${summary.staleReason}`;
		}
		button.setAttribute("aria-label", title);
		button.setAttribute("title", title);
		button.addEventListener("click", (event) => {
			event.stopPropagation();
			void this.runSummary(project);
		});

		return button;
	}

	private async openNote(project: Project): Promise<void> {
		const file = project.notePath ? this.app.vault.getAbstractFileByPath(project.notePath) : null;
		if (file instanceof TFile) {
			await this.app.workspace.getLeaf(false).openFile(file);
			return;
		}
		new Notice(`Project Tracker: no note yet for ${project.facts.name}. Run a refresh first.`);
	}

	private renderProject(project: Project, pinned: boolean): void {
		const row = this.contentEl.createDiv({ cls: `pt-row ${pinned ? "is-pinned" : ""}`.trim() });

		const main = row.createDiv({ cls: "pt-main" });
		const name = main.createDiv({ cls: "pt-name" });
		name.setText(project.facts.name);
		name.addEventListener("click", () => void this.openNote(project));

		const meta = main.createDiv({ cls: "pt-meta" });
		if (project.facts.branch) {
			const branch = meta.createSpan({ cls: "pt-branch" });
			branch.setText(project.facts.branch);
		}
		if (project.facts.dirtyCount > 0) {
			const dirty = meta.createSpan({ cls: "pt-dirty" });
			dirty.setText(`${project.facts.dirtyCount} dirty`);
		}
		const age = meta.createSpan({ cls: "pt-age" });
		age.setText(relativeAge(project.facts.lastCommit, this.now));

		const right = row.createDiv({ cls: "pt-right" });
		if (pinned) {
			const pin = right.createSpan({ cls: "pt-pin" });
			pin.setText(`#${project.pin}`);
		}
		// The summary control sits with the other row-level controls, so the
		// existing pt-main / pt-right split is unchanged.
		const ai = right.createSpan({ cls: "pt-ai-slot" });
		ai.appendChild(this.renderSummaryControl(project));
		const score = right.createSpan({ cls: "pt-score" });
		score.setText(String(project.score.score));

		if (project.score.status !== "active") {
			row.addClass(`is-${project.score.status satisfies ProjectStatus}`);
		}

		row.addEventListener("contextmenu", (event) => {
			event.preventDefault();
			this.showPinMenu(event, project);
		});
	}

	private renderGroup(label: string, projects: Project[], pinned: boolean): void {
		if (projects.length === 0) return;
		const heading = this.contentEl.createDiv({ cls: "pt-group" });
		heading.setText(`${label} (${projects.length})`);
		for (const project of projects) this.renderProject(project, pinned);
	}

	private render(): void {
		this.contentEl.empty();
		this.renderHeader();

		const ranked = rankProjects(this.projects);
		const pinned = ranked.filter((p) => p.pin > 0);
		const active = ranked.filter((p) => p.pin === 0 && p.score.status === "active");
		const dormant = ranked.filter((p) => p.pin === 0 && p.score.status !== "active");

		this.renderGroup("Pinned", pinned, true);
		this.renderGroup("Active", active, false);

		if (dormant.length > 0) {
			if (this.plugin.settings.showDormant) {
				this.renderGroup("Dormant", dormant, false);
			} else {
				const hidden = this.contentEl.createDiv({ cls: "pt-hidden-note" });
				hidden.setText(`${dormant.length} dormant project(s) hidden.`);
			}
		}

		if (ranked.length === 0) {
			const empty = this.contentEl.createDiv({ cls: "pt-empty" });
			empty.setText("No git repositories found under the scan root.");
		}
	}
}