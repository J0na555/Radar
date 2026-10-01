import { homedir } from "os";
import * as path from "path";
import { App, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { scanProjects } from "./git";
import { scoreRepo } from "./rank";
import { PluginSettings, Project, RepoFacts } from "./types";
import { readPins, syncAllNotes } from "./vault";
import { ProjectTrackerView, VIEW_TYPE_PROJECT_TRACKER } from "./view";

const DEFAULT_SETTINGS: PluginSettings = {
	scanRoot: path.join(homedir(), "Documents", "projects"),
	notesFolder: "private/Project Tracker/projects",
	showDormant: false,
};

export default class ProjectTrackerPlugin extends Plugin {
	settings: PluginSettings = { ...DEFAULT_SETTINGS };
	private projects: Project[] = [];

	override async onload(): Promise<void> {
		await this.loadSettings();

		this.registerView(VIEW_TYPE_PROJECT_TRACKER, (leaf) => new ProjectTrackerView(leaf, this));

		this.addRibbonIcon("git-branch", "Open Project Tracker", () => {
			void this.activateView();
		});

		this.addCommand({
			id: "open-project-tracker",
			name: "Open Project Tracker",
			callback: () => void this.activateView(),
		});

		this.addCommand({
			id: "rescan-projects",
			name: "Rescan projects",
			callback: () => {
				void (async () => {
					const projects = await this.refresh();
					new Notice(`Project Tracker: ${projects.length} repositories scanned.`);
				})();
			},
		});

		this.addSettingTab(new ProjectTrackerSettingTab(this.app, this));
	}

	override onunload(): void {
		// Nothing to tear down: scans are short-lived spawnSync calls that finish
		// before unload, and no intervals or child processes are left running.
	}

	/** Surface the panel, creating its leaf on first open. */
	async activateView(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_PROJECT_TRACKER);
		if (existing.length > 0) {
			await this.app.workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf = this.app.workspace.getRightLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({ type: VIEW_TYPE_PROJECT_TRACKER, active: true });
		await this.app.workspace.revealLeaf(leaf);
	}

	getProjects(): Project[] {
		return this.projects;
	}

	/**
	 * Rescan, score, then write the per-project notes.
	 *
	 * Pins are read before scoring so a manual rank survives a rescan, and writes
	 * happen after ranking so notes reflect the same state the view displays.
	 */
	async refresh(): Promise<Project[]> {
		const facts = scanProjects(this.settings.scanRoot);
		const pins = await readPins(this.app, this.settings);
		const now = Date.now();

		this.projects = facts.map((fact: RepoFacts) => ({
			facts: fact,
			score: scoreRepo(fact, now),
			pin: pins.get(fact.name) ?? 0,
		}));

		const notes = await syncAllNotes(this.app, this.settings, this.projects);
		for (const project of this.projects) {
			const notePath = notes.get(project.facts.name);
			if (notePath) project.notePath = notePath;
		}

		return this.projects;
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}

class ProjectTrackerSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: ProjectTrackerPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Project Tracker" });

		new Setting(containerEl)
			.setName("Scan root")
			.setDesc("Absolute path scanned for git repositories.")
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.scanRoot)
					.setValue(this.plugin.settings.scanRoot)
					.onChange(async (value) => {
						this.plugin.settings.scanRoot = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Notes folder")
			.setDesc("Vault-relative folder holding one note per project. Keep it under private/ so it stays out of published builds.")
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.notesFolder)
					.setValue(this.plugin.settings.notesFolder)
					.onChange(async (value) => {
						this.plugin.settings.notesFolder = value.trim() || DEFAULT_SETTINGS.notesFolder;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Show dormant projects")
			.setDesc("Show projects with no activity in the last 30 days. Pinned projects always show.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showDormant).onChange(async (value) => {
					this.plugin.settings.showDormant = value;
					await this.plugin.saveSettings();
				}),
			);
	}
}