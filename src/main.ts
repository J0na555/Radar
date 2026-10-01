import { homedir } from "os";
import * as path from "path";
import { App, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { scanProjects } from "./git";
import { scoreRepo } from "./rank";
import { StartupLog } from "./startup-log";
import { PluginSettings, Project, RepoFacts } from "./types";
import { readPins, syncAllNotes } from "./vault";
import {
	ICON_PROJECT_TRACKER,
	ProjectTrackerView,
	VIEW_TYPE_PROJECT_TRACKER,
} from "./view";

const DEFAULT_SETTINGS: PluginSettings = {
	scanRoot: path.join(homedir(), "Documents", "projects"),
	notesFolder: "private/Project Tracker/projects",
	showDormant: false,
};

const RIBBON_TITLE = "Open Project Tracker";

export default class ProjectTrackerPlugin extends Plugin {
	settings: PluginSettings = { ...DEFAULT_SETTINGS };
	private projects: Project[] = [];

	/**
	 * Register everything the plugin adds to the workspace.
	 *
	 * Each step runs inside its own guard on purpose. A single throw used to
	 * abort the rest of onload, which presented as a plugin with no ribbon icon,
	 * no commands, and no settings tab and no error anywhere: Obsidian's own
	 * report of a failed onload is a notice that flashes past plus a console
	 * message behind the devtools window. Isolating the steps means the worst
	 * case is one missing feature with a named, readable reason.
	 */
	override async onload(): Promise<void> {
		const log = new StartupLog(this);

		// Settings come first because every step below reads them, but a failure
		// here falls back to the defaults rather than costing the whole plugin.
		try {
			await this.loadSettings();
			log.pass("loadSettings");
		} catch (error) {
			this.settings = { ...DEFAULT_SETTINGS };
			log.fail("loadSettings", error);
		}

		this.guard(log, "registerView", () => {
			this.registerView(VIEW_TYPE_PROJECT_TRACKER, (leaf) => new ProjectTrackerView(leaf, this));
		});

		this.guard(log, "addRibbonIcon", () => {
			this.addRibbonIcon(ICON_PROJECT_TRACKER, RIBBON_TITLE, () => {
				void this.activateView();
			});
		});

		this.guard(log, "addCommand:open-project-tracker", () => {
			this.addCommand({
				id: "open-project-tracker",
				name: RIBBON_TITLE,
				callback: () => void this.activateView(),
			});
		});

		this.guard(log, "addCommand:rescan-projects", () => {
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
		});

		this.guard(log, "addSettingTab", () => {
			this.addSettingTab(new ProjectTrackerSettingTab(this.app, this));
		});

		log.finish();
	}

	/** Run one registration step so a throw in it cannot abort the ones after it. */
	private guard(log: StartupLog, step: string, run: () => void): void {
		try {
			run();
			log.pass(step);
		} catch (error) {
			log.fail(step, error);
		}
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
			.setDesc("Show projects with no live work and no commit in the last 30 days. Pinned projects always show.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showDormant).onChange(async (value) => {
					this.plugin.settings.showDormant = value;
					await this.plugin.saveSettings();
				}),
			);
	}
}