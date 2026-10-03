import { homedir } from "os";
import * as path from "path";
import { App, Notice, Plugin, PluginSettingTab, Setting, TFile } from "obsidian";
import {
	buildGitContext,
	buildPrompt,
	clampCommitCount,
	clampTimeoutSeconds,
	COMMIT_COUNT_DEFAULT,
	COMMIT_COUNT_MAX,
	COMMIT_COUNT_MIN,
} from "./context";
import { dashboardPath, upsertSummaryEntry } from "./dashboard";
import type { SummaryEntry } from "./dashboard";
import { scanProjects } from "./git";
import { openRepoFolder } from "./editor";
import { healthSignals } from "./health";
import { ErrorLog } from "./log-writer";
import { folderChoices } from "./folder-picker";
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
import {
	applyLegacyNotes,
	emptyMachineState,
	needsLegacySeed,
	pinRankFor,
	previousDirtyFor,
	sanitizeMachineState,
	STATE_VERSION,
} from "./machine-state";
import { resolveProjectNote } from "./note-link";
import { PinQueue } from "./pin-queue";
import { DEFAULT_WEIGHTS, scoreRepo, sanitizeWeights } from "./rank";
import { StartupLog } from "./startup-log";
import { computeStamp } from "./summary";
import {
	PluginSettings,
	Project,
	ProviderDetection,
	ProviderId,
	ProviderProbe,
	RepoFacts,
	SummaryRecord,
	SummaryState,
} from "./types";
import {
	headSha,
	listVaultFolders,
	readLegacyNotes,
	readNoteCandidates,
	readSummaryStates,
	syncDashboard,
	writeDashboard,
} from "./vault";
import { WriteChain } from "./write-chain";
import { renderWeightSettings } from "./weight-settings";
import {
	ICON_PROJECT_TRACKER,
	ProjectTrackerView,
	VIEW_TYPE_PROJECT_TRACKER,
} from "./view";

const DEFAULT_SETTINGS: PluginSettings = {
	scanRoot: path.join(homedir(), "Documents", "projects"),
	// Not under private/, unlike the folder this setting used to default to. That folder held
	// generated machine output nobody was meant to read; this one is a table of projects with
	// links in it, which is a note a person may want to link to. Existing installs keep whatever
	// they had, because their 45 notes are in it.
	notesFolder: "Project Tracker",
	showDormant: false,
	// The "why this score" line doubles the height of the list, so it is a toggle
	// rather than a default. The tooltip on the score needs no permission.
	explainScores: false,
	weights: { ...DEFAULT_WEIGHTS },
	// null means "detect a working CLI", which is the point of auto-detection. A value
	// here would be a choice the user never made, and honouring it would reinstate the
	// exact bug detection exists to fix.
	provider: null,
	commitCount: COMMIT_COUNT_DEFAULT,
	timeoutSeconds: 120,
	// Empty means "reveal the folder in the file manager". Auto-detection is
	// deliberately absent here, for the reason spelled out at EDITOR_COMMAND_EXAMPLES.
	editorCommand: "",
	detection: { checkedAt: 0, probes: [], selected: null },
	// A fresh object per process, and `loadSettings` replaces it with another one. Sharing a
	// nested default across every settings object is how a mutation of one user's state ends up
	// as the factory default.
	state: emptyMachineState(),
};

const RIBBON_TITLE = "Open Project Tracker";

/**
 * Binaries found on the author's machine, listed as copyable examples. A literal list, not
 * a probe and not a ranking: which editor someone uses is not something a plugin can know,
 * and offering a preference list would be it guessing.
 */
const EDITOR_COMMAND_EXAMPLES = ["code", "cursor", "nvim", "vim"];

/**
 * The working form for a terminal editor, which cannot use `nvim` directly. Obsidian has no
 * terminal to hand one, so the terminal emulator goes in this field and the editor becomes
 * its argument. Spelled out because it is the one case where the obvious answer fails.
 */
const TERMINAL_EDITOR_EXAMPLE = "kitty --single-instance --directory";

/** How old a cached probe pass may be before load re-probes, in days. */
const DETECTION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export default class ProjectTrackerPlugin extends Plugin {
	settings: PluginSettings = { ...DEFAULT_SETTINGS };
	private projects: Project[] = [];
	private errorLog: ErrorLog | null = null;

	/**
	 * Pin writes in flight, ordered per project, and the wait that drains them.
	 *
	 * Here rather than in the view because `refresh` below reads pins back out of the notes
	 * and has two doors into it: the panel's Refresh button and the command palette's
	 * "Rescan projects". A guard on one caller is not the invariant.
	 */
	private readonly pinWrites = new PinQueue();

	/**
	 * Settings writes, one at a time.
	 *
	 * Separate from `pinWrites` on purpose. That queue orders per project and lets different
	 * projects write concurrently, which cost nothing while a pin went into its own note. Pins
	 * are machine state now, so every one of those writes serialises the whole settings file,
	 * and two overlapping `saveData` calls can interleave so the later one writes a snapshot
	 * taken before the earlier one finished.
	 */
	private readonly settingsWrites = new WriteChain();

	/**
	 * Dashboard writes, strictly serial, for the same reason and with a sharper edge.
	 *
	 * Two writers, two jobs. A scan replaces the project table; a generation splices one project's
	 * summary into the section below it. Both read the file first, because the second one has to
	 * preserve the first one's work. Serialising only the writes would not help: they would still
	 * read the same version and the later write would drop the earlier change. So the read goes
	 * on the chain too, which is why this is a chain rather than a queue keyed by project.
	 */
	private readonly dashboardWrites = new WriteChain();

	/**
	 * Register everything the plugin adds to the workspace.
	 *
	 * Each step runs inside its own guard on purpose. A single throw used to abort the rest
	 * of onload, presenting as a plugin with no ribbon icon, no commands and no settings
	 * tab and no error anywhere: Obsidian's own report of a failed onload is a notice that
	 * flashes past plus a console message behind the devtools window. Isolating the steps
	 * means the worst case is one missing feature with a named, readable reason.
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

		// Probing spawns child processes, so it is not on onload's critical path: a stale cache
		// is repaired by the retest button, by the command above, or by a generation failure,
		// none of which need onload to have finished. A cached pass is reused as-is; only a
		// missing or old one is re-run.
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
		// No long-lived child processes: a probe is killed at PROBE_TIMEOUT_MS and nothing
		// else outlives the call that started it. Scans are still spawnSync, and finish
		// before unload returns.
	}

/** Where a failure was recorded, for a notice to name. */
	get errorLogSentence(): string {
		return this.errors().whereSentence;
	}

	/**
	 * The durable failure log, built on first use. Lazy because resolving the plugin folder
	 * needs a loaded `Plugin`, and nothing that touches the log has to happen before the
	 * rest of the plugin is registered.
	 */
	private errors(): ErrorLog {
		if (!this.errorLog) this.errorLog = new ErrorLog(this);
		return this.errorLog;
	}

	/**
	 * Record one failure to `errors.log` and tell the user where it went.
	 *
	 * Every generation failure goes through here, not just the ones that happened to reach
	 * the view. A failure with only a transient Notice behind it is a failure nobody can act
	 * on later, and the auth error that motivated this was invisible for exactly that
	 * reason. Duration 0 stays: the notice should still be there when the user looks.
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

	/**
	 * Where AI summary text is.
	 *
	 * One answer now, where there used to be one per project. The summary state knows what a
	 * summary was generated from and not where its text went, which is deliberate: the two have
	 * different lifetimes, and the text moved into a file whose lifetime is longer than any one
	 * summary's.
	 */
	summaryTarget(): string {
		return dashboardPath(this.settings);
	}

	/**
	 * Add one project's summary to the dashboard, leaving the others untouched.
	 *
	 * Read-modify-write rather than a write, and that is the whole risk in this function. The
	 * previous version replaced one file per project, so a failed write cost one summary. Here
	 * the dashboard is the only copy of every summary, so a read that misses what is on disk
	 * loses all of them.
	 *
	 * The whole read-splice-write goes through the dashboard chain, not just the write. A scan
	 * writing the project table at the same moment as a generation writing a summary would
	 * otherwise both read the same version and the second write would drop the first change,
	 * which for a summary means deleting it. Serialising the read is what makes the second
	 * writer see the first.
	 */
	private async upsertSummary(target: string, entry: SummaryEntry): Promise<string | null> {
		return this.dashboardWrites.run(async () => {
			const file = this.app.vault.getAbstractFileByPath(target);
			if (!(file instanceof TFile)) {
				// No dashboard yet. The next scan creates one, and the summary that asked for this
				// is lost rather than reported as saved. Creating one here would mean rendering a
				// project table for a scan that has not happened.
				return null;
			}
			let doc: string;
			try {
				doc = await this.app.vault.read(file);
			} catch {
				return null;
			}
			let content: string;
			try {
				content = upsertSummaryEntry(doc, entry);
			} catch {
				// A generated body carrying a marker would break the section structure. The
				// write is refused rather than corrupting the note.
				return null;
			}
			return writeDashboard(this.app, this.settings, content, doc);
		});
	}

	/** True when there is no usable cache, so a probe pass is due. */
	private detectionIsStale(): boolean {
		if (this.settings.provider !== null) return false;
		const { checkedAt, probes } = this.settings.detection;
		if (checkedAt === 0 || probes.length === 0) return true;
		return Date.now() - checkedAt > DETECTION_MAX_AGE_MS;
	}

	/**
	 * Probe all three CLIs and cache the result. Concurrent and non-blocking: sequential
	 * blocking probes froze the main thread for 37-43s measured, while concurrently the
	 * total is the slowest single probe. `announce` distinguishes the two callers, because
	 * load-time repair stays quiet where a notice nobody asked for is noise.
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
	 * Only the provider that failed, not all three. Authentication gets fixed outside
	 * Obsidian, in a terminal, and the user should not have to restart the app for the
	 * plugin to notice; re-probing all three would cost three probes to react to one
	 * CLI's worth of news. Fire-and-forget: the failure has already been reported and
	 * logged, so nothing on screen is waiting on this.
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
	 * Write one project's pin into machine state, without rescanning anything.
	 *
	 * Pinning used to call `refresh`, which forked a `git` process for every repository
	 * under the scan root and rewrote every note to store one integer, on a panel the user
	 * had just asked to make easier to use. The pin is one field, so it is written on its own
	 * and the panel re-ranks in memory.
	 *
	 * A pin rank is not stored as 0 when unpinning, it is removed. 0 already means unpinned in
	 * every comparison that reads the value, so a stored 0 would be a key that says nothing and
	 * grows one entry per project the user unpins.
	 *
	 * Rolls the stored rank back on a failed write as well as returning false, because
	 * `applyPin` only knows how to put the in-memory project back. A rank left in data.json with
	 * no row showing it is a pin the panel has forgotten about, and the next rescan would
	 * restore it out of nowhere.
	 *
	 * Returns whether the write landed. The view draws the new pin before calling this and
	 * puts it back if it comes back false, so a pin that silently did not save cannot be
	 * left on screen.
	 */
	async savePin(project: Project): Promise<boolean> {
		const name = project.facts.name;
		const had = name in this.settings.state.pins;
		const before = this.settings.state.pins[name];

		if (project.pin > 0) this.settings.state.pins[name] = project.pin;
		else delete this.settings.state.pins[name];

		try {
			await this.saveSettings();
			return true;
		} catch (error) {
			if (had) this.settings.state.pins[name] = before;
			else delete this.settings.state.pins[name];
			new Notice(`Project Tracker: could not save the pin for ${name} (${String(error)}).`);
			return false;
		}
	}

	/**
	 * Queue one pin write for one project, behind whatever is already writing it.
	 *
	 * `target` is a function rather than a rank because the write is queued: a `p` pressed
	 * twice has to read the rank the first press left, not the one on screen when the
	 * second key went down.
	 *
	 * The write itself belongs to the caller, because drawing the row before the write and
	 * putting it back after a failure is the view's business. This owns only the ordering,
	 * which is what `refresh` has to wait on.
	 */
	queuePinWrite(project: Project, target: () => number, write: (pin: number) => Promise<void>): Promise<void> {
		return this.pinWrites.queue(project.facts.name, () => write(target()));
	}

	/**
	 * Move the note-derived state into data.json, once, for an install that has notes.
	 *
	 * An install upgrading today has real pin ranks and real dirty counts sitting in 45 notes'
	 * frontmatter, and this is the only moment anything can read them. Skipping it would reset
	 * every pin in every install, silently, on first load, which is the worst outcome this
	 * change has available to it. So it runs before anything reads state, and the version that
	 * stops it running again is written in the same breath: a save that fails leaves the
	 * version unwritten and the seed runs again next time, which only fills gaps.
	 */
	private async seedStateFromLegacyNotes(): Promise<void> {
		if (!needsLegacySeed(this.settings.state)) return;

		const legacy = readLegacyNotes(this.app, this.settings);
		this.settings.state = {
			...applyLegacyNotes(this.settings.state, legacy),
			version: STATE_VERSION,
		};
		await this.saveSettings();
	}

	/**
	 * Rescan, score, link the notes that already exist, then write the dashboard.
	 *
	 * Settles the pin queue first, because a queued pin write replaces a rank that this method
	 * is about to read, and it builds new project objects: an in-flight write would leave the
	 * panel showing one rank and machine state holding another. Both entry points reach this
	 * line, so both are covered.
	 *
	 * The seed runs next, before anything reads state, for the upgrade reason above.
	 *
	 * Pins and the previous dirty count are read once, up front, so a manual rank survives a
	 * rescan and a sustained-dirty warning knows what the last scan saw. The dirty count in
	 * particular has to be read before this scan writes its own: reading it afterwards would
	 * compare the repo against itself and warn on every repo that has ever been dirty.
	 */
	async refresh(): Promise<Project[]> {
		await this.pinWrites.settle();
		await this.seedStateFromLegacyNotes();

		const facts = scanProjects(this.settings.scanRoot);
		const now = Date.now();
		const { pins, previousDirty } = this.settings.state;

		this.projects = facts.map((fact: RepoFacts) => ({
			facts: fact,
			score: scoreRepo(fact, now, this.settings.weights),
			pin: pinRankFor(pins, fact.name),
			health: healthSignals(fact, previousDirtyFor(previousDirty, fact.name), now),
		}));

		// Match against the notes that are already there rather than writing any. The plugin
		// stopped creating notes, so this decides which of somebody's existing notes each project
		// links to, and nothing else. The dashboard is excluded from the candidates by the reader.
		const candidates = readNoteCandidates(this.app, this.settings);
		for (const project of this.projects) {
			const note = resolveProjectNote(project.facts.name, candidates);
			if (note) project.notePath = note.path;
		}

		// Written after the links are resolved, because the project table has a Note column and
		// a table full of dead wikilinks is worse than no column. On the dashboard chain rather
		// than awaited inline, because a generation may already be splicing a summary into this
		// file and the two must not read it at the same time.
		await this.dashboardWrites.run(() => syncDashboard(this.app, this.settings, this.projects, now));

		// Read back what summaries already exist. A project with no summary is
		// the normal case, so nothing is created here: this only looks.
		const states = readSummaryStates(
			this.settings,
			this.projects,
			(project) => headSha(project.path),
		);
		for (const project of this.projects) {
			const state = states.get(project.facts.name);
			if (state) project.summary = state;
			else delete project.summary;
		}

		await this.saveScanState();

		return this.projects;
	}

	/**
	 * Record this scan's uncommitted counts so the next scan can tell a pile from a day's work.
	 *
	 * Only what git actually reported. A repo git could not read is left at whatever it was,
	 * because `RepoFacts.gitReadable` exists precisely to say that its absent values are
	 * unreliable: overwriting a real 144 with the 0 of a failed scan would make the warning
	 * stop firing on the one project it is about.
	 */
	private async saveScanState(): Promise<void> {
		const previousDirty = { ...this.settings.state.previousDirty };
		for (const project of this.projects) {
			if (project.facts.gitReadable) previousDirty[project.facts.name] = project.facts.dirtyCount;
		}
		this.settings.state.previousDirty = previousDirty;
		await this.saveSettings();
	}

	/**
	 * Open one project's folder in the user's editor, or reveal it.
	 *
	 * Two outcomes and neither is an error worth hiding: an empty `editorCommand` reveals
	 * the folder in the file manager, which is what a fresh install does. Refusals name
	 * their reason, because a button that silently does nothing is the failure users
	 * cannot act on. Nothing here waits on the editor; see `src/editor.ts` for why that is
	 * not a per-binary decision.
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
	 * Manual trigger only, and one project at a time. Nothing here runs on a timer, on
	 * scan, or on view open, because a summary is a snapshot of a model call and those are
	 * expensive and easy to make stale by accident.
	 *
	 * Writes exactly one file, the `<name>-ai.md` sibling, and only after the model's reply
	 * has parsed into the expected shape. Every failure path, from no working CLI to a
	 * missing binary to a hung CLI to a reply in the wrong shape, reports through a
	 * Notice, records to `errors.log`, and writes nothing.
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
			// rather than in Obsidian. Re-probe this one CLI so the next attempt picks
			// up the fix without an app restart.
			if (this.settings.provider === null) void this.recheckProvider(provider);
			return this.fail(name, provider, result.error);
		}

		const target = dashboardPath(this.settings);
		// The model's text goes into one entry in a section, not over a whole file. The write is
		// therefore a read, a splice and a write, and the read has to see what is already there:
		// this dashboard is the only copy of every other project's summary, and a generation for
		// one project must not take the other 44 with it.
		const written = await this.upsertSummary(target, {
			projectName: name,
			provider,
			record: { generatedAt: stamp.generatedAt, commit: stamp.commit, dirtyCount: stamp.dirtyCount },
			body: result.summary,
		});
		if (!written) {
			return this.fail(name, provider, `could not write ${target}. Check the vault is writable.`);
		}

		const nextHead = buildGitContext(project.facts, 1).head;
		// Freshness is machine state, so it is persisted here rather than read back out of the
		// note that holds the text. The note is a cache of the model's answer; this is the fact
		// the staleness check compares against the repo, and the two have different lifetimes.
		const record: SummaryRecord = {
			generatedAt: stamp.generatedAt,
			commit: stamp.commit,
			dirtyCount: stamp.dirtyCount,
		};
		this.settings.state.summaries[name] = record;
		// Persisted before anything reports success. If this fails the note is still written and
		// the panel will call the project un-summarised until the next generation, which is worse
		// than saying so. It must not go through `fail`, which claims no summary was written.
		try {
			await this.saveSettings();
		} catch (error) {
			const message = `The summary was written, but its freshness could not be saved, so the panel will not show it as current until the next one is generated (${String(error)}).`;
			this.errors().record({ provider, project: name, message });
			new Notice(`Project Tracker: ${name} summary written. ${message} ${this.errors().whereSentence}`, 0);
		}
		const state: SummaryState = {
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

		// The repo may have moved while the CLI ran, so recompute rather than reporting
		// fresh. `nextHead` differing from the stamp is the same check the panel makes
		// on the next scan.
		if (nextHead !== null && nextHead !== stamp.commit) {
			state.stale = true;
			state.staleReason = `repo moved during generation (${stamp.commit} to ${nextHead})`;
		}

		return state;
	}

	async loadSettings(): Promise<void> {
		// Clamped after the merge, not before: an existing data.json can hold a provider id
		// or a commit count this build no longer accepts, and settings that are wrong on
		// load are what produced a silently broken panel before.
		const loaded = (await this.loadData()) as Partial<PluginSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded ?? {});

		// null is a valid stored value here and means "no manual choice", so this
		// narrows rather than replacing an invalid id with a provider.
		if (this.settings.provider !== null && !isProviderId(this.settings.provider)) {
			this.settings.provider = null;
		}

		// Replaced rather than merged, so a hand-edited or older data.json cannot smuggle an
		// unvalidated state into the settings tab. `sanitizeProbes` discards anything it
		// does not recognise, and a cache that survives as empty reads as never probed.
		const detection = loaded?.detection;
		this.settings.detection = {
			checkedAt: typeof detection?.checkedAt === "number" && Number.isFinite(detection.checkedAt) ? detection.checkedAt : 0,
			probes: sanitizeProbes(detection?.probes),
			selected: isProviderId(detection?.selected) ? detection.selected : null,
		};

		this.settings.commitCount = clampCommitCount(Number(this.settings.commitCount));
		this.settings.timeoutSeconds = clampTimeoutSeconds(Number(this.settings.timeoutSeconds));

		// Replaced rather than merged, and validated field by field: data.json is a file a
		// person can edit, and half a scoring model reading NaN is worse than ignoring the
		// edit. Always a fresh object, so nothing the settings tab writes can reach back
		// and change the defaults.
		this.settings.weights = sanitizeWeights(loaded?.weights);

		// The editor command is a string with no valid values to reject, so it only
		// needs trimming: a field left as spaces is the same as an empty one.
		if (typeof this.settings.editorCommand !== "string") this.settings.editorCommand = "";

		// Replaced rather than merged, and validated field by field, for the same reason the
		// weights are: data.json is a file a person can edit. `version` survives as it was
		// found rather than being forced to current, because a load must not mark an unseeded
		// upgrade as seeded.
		this.settings.state = sanitizeMachineState(loaded?.state);
	}

	async saveSettings(): Promise<void> {
		// Every settings write goes through one chain. `PinQueue` lets pin writes for different
		// projects run at once, and each of those now serialises this whole file, so two
		// overlapping writes can otherwise interleave and lose one of the two changes.
		await this.settingsWrites.run(() => this.saveData(this.settings));
	}
}

/** One line describing every probe, for the retest notice. */
function summarize(probes: readonly ProviderProbe[]): string {
	return probes.map((probe) => `${probe.provider} ${probe.state}`).join(", ");
}

/**
 * The sentence describing one provider's detected state. The three states are worded as
 * three different situations rather than a yes/no, because "installed" and "works" are
 * separate facts: gemini on this machine is installed, runs, and cannot authenticate, and
 * a tab that said only "available" would read as fine.
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
			.setName("Dashboard folder")
			.setDesc(
				"Vault folder holding Dashboard.md, the one note the plugin owns. Anything outside its two marked sections is yours and is never rewritten. Move it under private/ if you publish this vault and would rather it stayed out.",
			)
			.addDropdown((dropdown) => {
				for (const choice of folderChoices(this.plugin.settings.notesFolder, listVaultFolders(this.app))) {
					dropdown.addOption(choice.value, choice.label);
				}
				dropdown.setValue(this.plugin.settings.notesFolder).onChange(async (value) => {
					this.plugin.settings.notesFolder = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Show dormant projects")
			.setDesc("Show projects with no live work and no commit in the last 30 days. Pinned projects always show.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showDormant).onChange(async (value) => {
					this.plugin.settings.showDormant = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Explain scores")
			.setDesc(
				"Show the score breakdown under every project name. Off, the score still carries it on hover; on, the list is twice as tall.",
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.explainScores).onChange(async (value) => {
					this.plugin.settings.explainScores = value;
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

		// The installed version and the detected capability are shown as separate facts on
		// purpose. Version alone is what produced the trap: gemini passes `--version` with
		// exit 0 on a machine where it cannot authenticate, so a settings tab reporting
		// only the version reads as fine right up until a summary fails.
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

		containerEl.createEl("h3", { text: "Score weights" });

		const weightNote = containerEl.createDiv({ cls: "pt-weight-note" });
		weightNote.setText(
			"The score is the sum of these. They were chosen by feel, so change anything that reads wrong. Takes effect on the next scan. The two day counts are independent: make the recent window wider than the stale one and the stale band is simply never reached, which is not an error and not worth warning you about.",
		);

		renderWeightSettings(containerEl, this.plugin.settings, () => this.plugin.saveSettings());
	}
}