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
import { openRepoFolder } from "./editor";
import { ErrorLog } from "./log-writer";
import {
	detectProvidersAsync,
	isProviderId,
	probeCapabilityAsync,
	probeProvider,
	PROVIDER_IDS,
	runProvider,
	sanitizeProbes,
	selectProvider,
} from "./provider";
import { scoreRepo } from "./rank";
import { StartupLog } from "./startup-log";
import {
	aiNotePath,
	assertSafeTarget,
	computeStamp,
	renderSummaryNote,
} from "./summary";
import {
	PluginSettings,
	Project,
	ProviderDetection,
	ProviderId,
	ProviderProbe,
	RepoFacts,
	SummaryState,
} from "./types";
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
	// null means "detect a working CLI", which is the point of auto-detection. A
	// value here would be a choice the user never made, and honouring it would
	// reinstate the exact bug detection exists to fix.
	provider: null,
	commitCount: COMMIT_COUNT_DEFAULT,
	timeoutSeconds: 120,
	// Empty means "reveal the folder in the file manager". Auto-detection is
	// deliberately absent here: see the resolved decision in FEATURE-PLAN.md.
	editorCommand: "",
	detection: { checkedAt: 0, probes: [], selected: null },
};

const RIBBON_TITLE = "Open Project Tracker";

/**
 * Binaries found on the author's machine, listed as copyable examples.
 *
 * A literal list, not a probe and not a ranking. The plugin does not look for
 * editors at runtime and does not order them: which one you use is not something
 * a plugin can know, and offering a preference list would be it guessing.
 */
const EDITOR_COMMAND_EXAMPLES = ["code", "cursor", "nvim", "vim"];

/**
 * The working form for a terminal editor, which cannot use `nvim` directly.
 *
 * Obsidian has no terminal to hand one, so the terminal emulator goes in this
 * field and the editor becomes its argument. Spelled out here because it is the
 * one case where the obvious answer does not work.
 */
const TERMINAL_EDITOR_EXAMPLE = "kitty --single-instance --directory";

/** How old a cached probe pass may be before load re-probes, in days. */
const DETECTION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export default class ProjectTrackerPlugin extends Plugin {
	settings: PluginSettings = { ...DEFAULT_SETTINGS };
	private projects: Project[] = [];
	private errorLog: ErrorLog | null = null;

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

		this.guard(log, "addCommand:retest-providers", () => {
			this.addCommand({
				id: "retest-providers",
				name: "Retest AI provider CLIs",
				callback: () => {
					void (async () => {
						await this.retestProviders();
					})();
				},
			});
		});

		this.guard(log, "addSettingTab", () => {
			this.addSettingTab(new ProjectTrackerSettingTab(this.app, this));
		});

		// Probing spawns child processes, so it is not part of onload's critical path:
		// a stale cache is repaired by the retest button, by the command above, or by
		// a generation failure, none of which need onload to have finished. A cached
		// pass is reused as-is; only a missing or old one is re-run.
		this.guard(log, "ensureDetection", () => {
			if (this.detectionIsStale()) void this.retestProviders(false);
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
		// No long-lived child processes: a probe is killed at PROBE_TIMEOUT_MS and
		// nothing else outlives the call that started it. Scans are still spawnSync,
		// and they finish before unload returns.
	}

/** Where a failure was recorded, for a notice to name. */
	get errorLogSentence(): string {
		return this.errors().whereSentence;
	}

	/**
	 * The durable failure log, built on first use.
	 *
	 * Lazy rather than built in onload because resolving the plugin folder needs
	 * a loaded `Plugin`, and nothing that touches the log has to happen before
	 * the rest of the plugin is registered.
	 */
	private errors(): ErrorLog {
		if (!this.errorLog) this.errorLog = new ErrorLog(this);
		return this.errorLog;
	}

	/**
	 * Record one failure to `errors.log` and tell the user where it went.
	 *
	 * Every generation failure goes through here, not just the ones that happened
	 * to reach the view. A failure with only a transient Notice behind it is a
	 * failure nobody can act on later, and the auth error that motivated this was
	 * invisible for exactly that reason. Duration 0 stays: the notice should
	 * still be there when the user looks.
	 */
	private fail(project: string, provider: string, message: string): null {
		this.errors().record({ provider, project, message });
		new Notice(`Project Tracker: no summary written for ${project}. ${message} ${this.errors().whereSentence}`, 0);
		return null;
	}

	/** The CLI to generate with: a manual choice if there is one, else the detected one. */
	currentProvider(): ProviderId | null {
		return selectProvider(this.settings.provider, this.settings.detection.probes);
	}

	/** True when there is no usable cache, so a probe pass is due. */
	private detectionIsStale(): boolean {
		if (this.settings.provider !== null) return false;
		const { checkedAt, probes } = this.settings.detection;
		if (checkedAt === 0 || probes.length === 0) return true;
		return Date.now() - checkedAt > DETECTION_MAX_AGE_MS;
	}

	/**
	 * Probe all three CLIs and cache the result.
	 *
	 * Concurrent and non-blocking. Sequential blocking probes froze the main thread
	 * for 37-43s measured; concurrently the total is the slowest single probe.
	 *
	 * `announce` distinguishes the two callers: the settings button tells the user
	 * what it found, load-time repair stays quiet because a notice nobody asked for
	 * is noise.
	 */
	async retestProviders(announce = true): Promise<void> {
		const probes = await detectProvidersAsync();
		this.storeDetection(probes);
		if (!announce) return;

		const selected = this.currentProvider();
		new Notice(
			selected
				? `Project Tracker: ${selected} works and will be used. ${summarize(probes)}`
				: `Project Tracker: no working provider CLI found. ${summarize(probes)} ${this.errors().whereSentence}`,
			0,
		);
	}

	/** Persist a fresh probe pass. Resets when a write fails, rather than lying. */
	private storeDetection(probes: ProviderProbe[]): void {
		const detection: ProviderDetection = {
			checkedAt: Date.now(),
			probes,
			selected: this.settings.provider ?? selectProvider(null, probes),
		};
		this.settings.detection = detection;
		void this.saveSettings().catch((error) => {
			this.settings.detection = { checkedAt: 0, probes: [], selected: null };
			new Notice(`Project Tracker: could not save the provider detection (${String(error)})`);
		});
	}

	/**
	 * Re-probe one provider after it failed, then recompute the choice.
	 *
	 * Only the provider that failed is re-probed, not all three. Authentication
	 * gets fixed outside Obsidian, in a terminal, and the user should not have to
	 * restart the app for the plugin to notice; re-probing all three would cost
	 * three probes to react to one CLI's worth of news.
	 *
	 * Fire-and-forget: the failure has already been reported and logged, so nothing
	 * on screen is waiting on this.
	 */
	private async recheckProvider(provider: ProviderId): Promise<void> {
		const fresh = await probeCapabilityAsync(provider);
		const others = this.settings.detection.probes.filter((probe) => probe.provider !== provider);
		this.storeDetection([...others, fresh]);
	}

	/** Surface a panel, creating its leaf on first open. */
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
	 * Open one project's folder in the user's editor, or reveal it.
	 *
	 * Two outcomes and neither is an error worth hiding: an empty
	 * `editorCommand` reveals the folder in the file manager, which is what a
	 * fresh install does. Refusals name their reason, because a button that
	 * silently does nothing is the failure users cannot act on.
	 *
	 * Nothing here waits on the editor. See `src/editor.ts` for why that is not a
	 * per-binary decision.
	 */
	async openRepoFolder(project: Project): Promise<void> {
		const name = project.facts.name;
		const complain = (message: string): void => {
			new Notice(`Project Tracker: ${message}`, 0);
		};

		const result = openRepoFolder(project.facts, this.settings.editorCommand, complain);
		if (!result.ok) {
			complain(result.error);
			return;
		}

		new Notice(
			result.mode === "editor"
				? `Project Tracker: opened ${name} in ${result.command}.`
				: `Project Tracker: revealed ${name} in the file manager.`,
		);
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
	 * no working CLI to a missing binary to a hung CLI to a reply in the wrong
	 * shape, reports through a Notice, records to `errors.log`, and writes nothing.
	 */
	async generateSummary(project: Project): Promise<SummaryState | null> {
		const name = project.facts.name;
		const existed = Boolean(project.summary);

		const provider = this.currentProvider();
		if (provider === null) {
			return this.fail(
				name,
				"none",
				"No AI provider CLI is usable. Open the Project Tracker settings and retest; gemini needs an auth method, which `--version` does not check.",
			);
		}

		const context = buildGitContext(project.facts, this.settings.commitCount);
		const prompt = buildPrompt(context);
		const stamp = computeStamp(project.facts, Date.now(), context.head);

		new Notice(`Project Tracker: asking ${provider} about ${name}...`, 0);
		const result = await runProvider(provider, prompt, {
			cwd: project.facts.path,
			timeoutMs: this.settings.timeoutSeconds * 1000,
		});

		if (!result.ok) {
			// The failure may be a stale probe, since auth gets fixed in a terminal
			// rather than in Obsidian. Re-probe this one CLI so the next attempt
			// picks up the fix without an app restart.
			if (this.settings.provider === null) void this.recheckProvider(provider);
			return this.fail(name, provider, result.error);
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
			return this.fail(name, provider, String(error));
		}

		const written = await writeSummaryNote(this.app, this.settings, name, content);
		if (!written) {
			return this.fail(name, provider, `could not write ${target}. Check the vault is writable.`);
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

		// null is a valid stored value here and means "no manual choice", so this
		// narrows rather than replacing an invalid id with a provider.
		if (this.settings.provider !== null && !isProviderId(this.settings.provider)) {
			this.settings.provider = null;
		}

		// Replaced rather than merged, so a hand-edited or older data.json cannot
		// smuggle an unvalidated state into the settings tab. `sanitizeProbes`
		// discards anything it does not recognise, and a cache that survives as
		// empty simply reads as never probed.
		const detection = loaded?.detection;
		this.settings.detection = {
			checkedAt: typeof detection?.checkedAt === "number" && Number.isFinite(detection.checkedAt) ? detection.checkedAt : 0,
			probes: sanitizeProbes(detection?.probes),
			selected: isProviderId(detection?.selected) ? detection.selected : null,
		};

		this.settings.commitCount = clampCommitCount(Number(this.settings.commitCount));
		this.settings.timeoutSeconds = clampTimeoutSeconds(Number(this.settings.timeoutSeconds));
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}

/** One line describing every probe, for the retest notice. */
function summarize(probes: readonly ProviderProbe[]): string {
	return probes.map((probe) => `${probe.provider} ${probe.state}`).join(", ");
}

/**
 * The sentence describing one provider's detected state.
 *
 * The three states are worded as three different situations rather than a yes/no,
 * because "installed" and "works" are separate facts: gemini on this machine is
 * installed, runs, and cannot authenticate, and a tab that said only "available"
 * would read as fine.
 */
function detailFor(id: ProviderId, probe: ProviderProbe | undefined): string {
	switch (probe?.state) {
		case "works":
			return `${id} answered a test call.`;
		case "broken":
			// The CLI's own words, because that is where the fix usually is.
			return `${id} is installed but did not answer: ${probe.detail}`;
		case "absent":
			return `${id} is not installed: ${probe.detail}`;
		default:
			return `${id} has not been tested yet. Press Retest.`;
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

		const manual = this.plugin.settings.provider;
		const active = this.plugin.currentProvider();
		const { checkedAt, probes } = this.plugin.settings.detection;

		new Setting(containerEl)
			.setName("Provider CLI")
			.setDesc(
				"Auto picks the first CLI that actually answers a test call. Choosing one here overrides that and is never switched away from. Only git facts are sent: recent commit subjects, the paths of uncommitted files, the branch. No note from this vault is ever read or sent.",
			)
			.addDropdown((dropdown) => {
				dropdown.addOption("auto", `Auto${active ? ` (${active})` : ""}`);
				for (const id of PROVIDER_IDS) {
					dropdown.addOption(id, id);
				}
				dropdown.setValue(manual ?? "auto");
				dropdown.onChange(async (value) => {
					if (value === "auto") {
						this.plugin.settings.provider = null;
					} else if (isProviderId(value)) {
						this.plugin.settings.provider = value;
					} else {
						return;
					}
					await this.plugin.saveSettings();
					this.display();
				});
			})
			.addButton((button) =>
				button
					.setButtonText("Retest")
					.setTooltip("Run one test call per CLI and cache the result")
					.onClick(async () => {
						button.setDisabled(true);
						button.setButtonText("Retesting…");
						try {
							await this.plugin.retestProviders();
						} finally {
							this.display();
						}
					}),
			);

		// The installed version and the detected capability are shown as separate
		// facts on purpose. Version alone is what produced the trap: gemini passes
		// `--version` with exit 0 on a machine where it cannot authenticate, so a
		// settings tab reporting only the version reads as fine right up until a
		// summary fails.
		const detectionNote = containerEl.createDiv({ cls: "pt-probe" });
		const probedAt = checkedAt === 0 ? "never" : new Date(checkedAt).toLocaleString();
		detectionNote.setText(
			`Test calls last run ${probedAt}. Using: ${active ?? "nothing, no CLI answered"}. ${manual ? `${manual} is your manual choice.` : ""}`,
		);
		detectionNote.toggleClass("is-bad", active === null);

		for (const id of PROVIDER_IDS) {
			const probe = probes.find((entry) => entry.provider === id);
			const row = containerEl.createDiv({ cls: `pt-probe-row is-${probe?.state ?? "absent"}` });

			const state = row.createSpan({ cls: "pt-probe-state" });
			state.setText(probe?.state ?? "unknown");

			const detail = row.createSpan({ cls: "pt-probe-detail" });
			detail.setText(detailFor(id, probe));

			const version = row.createSpan({ cls: "pt-probe-version" });
			version.setText(`installed: ${probeProvider(id).detail}`);
		}

		const logNote = containerEl.createDiv({ cls: "pt-probe" });
		logNote.setText(`Generation failures are recorded to ${this.plugin.errorLogSentence}`);

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

		containerEl.createEl("h3", { text: "Opening a project" });

		new Setting(containerEl)
			.setName("Editor command")
			.setDesc(
				`What to run when you click the open button on a project. Leave it empty to open the folder in the file manager instead, which is what a fresh install does. Examples: ${EDITOR_COMMAND_EXAMPLES.join(", ")}. A terminal editor needs a terminal to run in, so give the emulator instead: ${TERMINAL_EDITOR_EXAMPLE}. Separate arguments with spaces. Nothing is run through a shell.`,
			)
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.editorCommand)
					.setValue(this.plugin.settings.editorCommand)
					.onChange(async (value) => {
						this.plugin.settings.editorCommand = value.trim();
						await this.plugin.saveSettings();
					}),
			);
	}
}