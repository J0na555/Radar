import { homedir } from "os";
import * as path from "path";
import { App, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import {
	buildGitContext,
	buildPrompt,
	clampCommitCount,
	clampTimeoutSeconds,
	COMMIT_COUNT_DEFAULT,
	COMMIT_COUNT_MAX,
	COMMIT_COUNT_MIN,
} from "./context";
import { scanProjects } from "./git";
import { isProviderId, probeProvider, PROVIDER_IDS, runProvider } from "./provider";
import { scoreRepo } from "./rank";
import { StartupLog } from "./startup-log";
import {
	aiNotePath,
	assertSafeTarget,
	computeStamp,
	renderSummaryNote,
} from "./summary";
import { PluginSettings, Project, RepoFacts, SummaryState } from "./types";
import { readPins, readSummaryStates, syncAllNotes, writeSummaryNote } from "./vault";
import {
	ICON_PROJECT_TRACKER,
	ProjectTrackerView,
	VIEW_TYPE_PROJECT_TRACKER,
} from "./view";

const DEFAULT_SETTINGS: PluginSettings = {
	scanRoot: path.join(homedir(), "Documents", "projects"),
	notesFolder: "private/Project Tracker/projects",
	showDormant: false,
	provider: "gemini",
	commitCount: COMMIT_COUNT_DEFAULT,
	timeoutSeconds: 120,
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

		const notes = await syncAllNotes(this.app, this.settings, this.projects, now);
		for (const project of this.projects) {
			const notePath = notes.get(project.facts.name);
			if (notePath) project.notePath = notePath;
		}

		// Read back what summaries already exist. A project with no summary note is
		// the normal case, so nothing is created here: this only looks.
		const states = await readSummaryStates(this.app, this.settings, this.projects);
		for (const project of this.projects) {
			const state = states.get(project.facts.name);
			if (state) project.summary = state;
			else delete project.summary;
		}

		return this.projects;
	}

	/**
	 * Generate or regenerate one project's AI summary.
	 *
	 * Manual trigger only, and one project at a time. Nothing here runs on a
	 * timer, on scan, or on view open, because a summary is a snapshot of a model
	 * call and those are expensive and easy to make stale by accident.
	 *
	 * Writes exactly one file, the `<name>-ai.md` sibling, and only after the
	 * model's reply has parsed into the expected shape. Every failure path, from
	 * a missing binary to a hung CLI to a reply in the wrong shape, reports
	 * through a Notice and writes nothing.
	 */
	async generateSummary(project: Project): Promise<SummaryState | null> {
		const name = project.facts.name;
		const provider = this.settings.provider;
		const existed = Boolean(project.summary);

		const context = buildGitContext(project.facts, this.settings.commitCount);
		const prompt = buildPrompt(context);
		const stamp = computeStamp(project.facts, Date.now(), context.head);

		new Notice(`Project Tracker: asking ${provider} about ${name}...`, 0);
		const result = await runProvider(provider, prompt, {
			cwd: project.facts.path,
			timeoutMs: this.settings.timeoutSeconds * 1000,
		});

		if (!result.ok) {
			new Notice(`Project Tracker: no summary written for ${name}. ${result.error}`, 0);
			return null;
		}

		const content = renderSummaryNote({
			projectName: name,
			repoPath: project.facts.path,
			stamp,
			provider,
			body: result.summary,
		});

		const target = aiNotePath(this.settings, name);
		try {
			assertSafeTarget(this.settings, name, target);
		} catch (error) {
			// Belt and braces: the naming makes this unreachable, but this write is
			// the only thing standing between the user and their own notes.
			new Notice(`Project Tracker: ${name} not summarised. ${String(error)}`, 0);
			return null;
		}

		const written = await writeSummaryNote(this.app, this.settings, name, content);
		if (!written) {
			new Notice(`Project Tracker: could not write ${target}. Check the vault is writable.`, 0);
			return null;
		}

		const nextHead = buildGitContext(project.facts, 1).head;
		const state: SummaryState = {
			path: target,
			generatedAt: stamp.generatedAt,
			commit: stamp.commit,
			dirty: stamp.dirtyCount > 0,
			dirtyCount: stamp.dirtyCount,
			stale: false,
			staleReason: "",
		};
		project.summary = state;

		const dirtyNote = stamp.dirtyCount > 0 ? ` (${stamp.dirtyCount} uncommitted, not in any commit)` : "";
		new Notice(
			`Project Tracker: ${existed ? "regenerated" : "wrote"} ${name} summary from ${stamp.commit ?? "no commit"}${dirtyNote}.`,
		);

		// The repo may have moved while the CLI ran, so recompute rather than
		// reporting fresh. `nextHead` differing from the stamp is the same check
		// the panel makes on the next scan.
		if (nextHead !== null && nextHead !== stamp.commit) {
			state.stale = true;
			state.staleReason = `repo moved during generation (${stamp.commit} to ${nextHead})`;
		}

		return state;
	}

	async loadSettings(): Promise<void> {
		// Clamped after the merge, not before: an existing data.json can hold a
		// provider id or a commit count this build no longer accepts, and settings
		// that are wrong on load are what produced a silently broken panel before.
		const loaded = (await this.loadData()) as Partial<PluginSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded ?? {});
		if (!isProviderId(this.settings.provider)) this.settings.provider = DEFAULT_SETTINGS.provider;
		this.settings.commitCount = clampCommitCount(Number(this.settings.commitCount));
		this.settings.timeoutSeconds = clampTimeoutSeconds(Number(this.settings.timeoutSeconds));
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

		containerEl.createEl("h3", { text: "AI summaries" });

		new Setting(containerEl)
			.setName("Provider CLI")
			.setDesc(
				"Which local CLI writes the summary. Only git facts are sent: recent commit subjects, the paths of uncommitted files, the branch. No note from this vault is ever read or sent.",
			)
			.addDropdown((dropdown) => {
				for (const id of PROVIDER_IDS) {
					dropdown.addOption(id, id);
				}
				dropdown.setValue(this.plugin.settings.provider);
				dropdown.onChange(async (value) => {
					if (!isProviderId(value)) return;
					this.plugin.settings.provider = value;
					await this.plugin.saveSettings();
					this.display();
				});
			});

		const probe = probeProvider(this.plugin.settings.provider);
		const probeNote = containerEl.createDiv({ cls: "pt-probe" });
		probeNote.setText(
			probe.available
				? `${this.plugin.settings.provider}: ${probe.detail}`
				: `${this.plugin.settings.provider} is not usable: ${probe.detail}`,
		);
		probeNote.toggleClass("is-bad", !probe.available);

		new Setting(containerEl)
			.setName("Commits in context")
			.setDesc(
				`How many recent commit subjects to send, ${COMMIT_COUNT_MIN} to ${COMMIT_COUNT_MAX}. More commits cost tokens and rarely add anything.`,
			)
			.addText((text) => {
				text.setValue(String(this.plugin.settings.commitCount));
				text.onChange(async (value) => {
					const parsed = Number.parseInt(value, 10);
					if (Number.isNaN(parsed)) return;
					this.plugin.settings.commitCount = clampCommitCount(parsed);
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Timeout")
			.setDesc("Seconds a provider may run before it is killed. Long enough for a big repo, short enough that a wedged CLI does not hang the panel.")
			.addText((text) => {
				text.setValue(String(this.plugin.settings.timeoutSeconds));
				text.onChange(async (value) => {
					const parsed = Number.parseInt(value, 10);
					if (Number.isNaN(parsed)) return;
					this.plugin.settings.timeoutSeconds = clampTimeoutSeconds(parsed);
					await this.plugin.saveSettings();
				});
			});
	}
}