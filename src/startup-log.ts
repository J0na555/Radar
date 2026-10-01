import { appendFileSync, writeFileSync } from "fs";
import { Notice } from "obsidian";
import type { FileSystemAdapter, Plugin } from "obsidian";

/** Name of the log written next to main.js. */
const LOG_NAME = "startup.log";

/**
 * Absolute path of this plugin's log file, or null when it cannot be resolved.
 *
 * `getFullPath` is declared on FileSystemAdapter rather than on the DataAdapter
 * interface, so it needs a narrowing check before use.
 */
function resolveLogPath(plugin: Plugin): string | null {
	const dir = plugin.manifest.dir;
	if (!dir) return null;
	const adapter = plugin.app.vault.adapter as Partial<FileSystemAdapter>;
	if (typeof adapter.getFullPath !== "function") return null;
	return adapter.getFullPath(`${plugin.app.vault.configDir}/plugins/${dir}/${LOG_NAME}`);
}

/**
 * Per-step record of what happened during onload.
 *
 * Obsidian makes a load failure easy to miss. When onload rejects, the app
 * raises a notice that flashes past, then keeps the real error for the devtools
 * console, which is a screen most users never open. A plugin whose ribbon icon,
 * commands, and settings tab all failed to register looks exactly like a plugin
 * that was never enabled, so there is nothing on screen to act on.
 *
 * This records each step to a file in the plugin folder, so the outcome is
 * readable without the GUI, and raises one persistent notice naming the steps
 * that failed. Writing the log is best effort: a logger that throws would be its
 * own outage, so every filesystem call here swallows its errors.
 */
export class StartupLog {
	private readonly logPath: string | null = null;
	private readonly failures: string[] = [];
	private wroteToDisk = false;

	constructor(plugin: Plugin) {
		this.logPath = resolveLogPath(plugin);
		this.truncate();
	}

	/** Record a step that succeeded. */
	pass(step: string): void {
		this.write(`PASS  ${step}`);
	}

	/**
	 * Record a step that threw. onload carries on afterwards, so this reports
	 * the failure and returns rather than rethrowing.
	 */
	fail(step: string, error: unknown): void {
		this.failures.push(step);
		const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
		console.error(`Project Tracker: ${step} failed during onload`, error);
		this.write(`FAIL  ${step}\n      ${detail.split("\n").join("\n      ")}`);
	}

	/** Close the log out and put any failure on screen where it cannot be missed. */
	finish(): void {
		if (this.failures.length === 0) {
			this.write("OK    onload completed, every registration succeeded");
			return;
		}

		const names = this.failures.join(", ");
		this.write(`DONE  ${this.failures.length} step(s) failed: ${names}`);
		// A log that could not be written is itself a failure to report, otherwise
		// the notice points at a file that does not exist.
		const where = this.wroteToDisk
			? `Details in ${LOG_NAME}, in the plugin folder.`
			: `${LOG_NAME} could not be written, so the stack trace is only in the developer console.`;
		// Duration 0 keeps the notice up until the user dismisses it, which is the
		// point: a load failure that scrolls away is the failure being reported.
		new Notice(`Project Tracker loaded with errors in: ${names}. ${where}`, 0);
	}

	/** Start a fresh log so it always describes the current session. */
	private truncate(): void {
		if (!this.logPath) return;
		try {
			writeFileSync(this.logPath, `--- Project Tracker startup ${new Date().toISOString()} ---\n`);
			this.wroteToDisk = true;
		} catch {
			// No writable log location. The notice and console still report.
		}
	}

	private write(line: string): void {
		if (!this.logPath) return;
		try {
			appendFileSync(this.logPath, `${line}\n`);
			this.wroteToDisk = true;
		} catch {
			// See truncate().
		}
	}
}
