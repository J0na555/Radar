import { Notice } from "obsidian";
import type { Plugin } from "obsidian";
import { LogWriter, resolvePluginFolderPath } from "./log-writer";

/** Name of the log written next to main.js. */
const LOG_NAME = "startup.log";

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
 * that failed. The disk work is shared with `errors.log` through `LogWriter`,
 * because both logs need the same thing: append, cap, swallow every error.
 */
export class StartupLog {
	private readonly writer: LogWriter;
	private readonly failures: string[] = [];

	constructor(plugin: Plugin) {
		this.writer = new LogWriter(resolvePluginFolderPath(plugin, LOG_NAME));
		// Start a fresh log so it always describes the current session.
		this.writer.start(`--- Project Tracker startup ${new Date().toISOString()} ---`);
	}

	/** Record a step that succeeded. */
	pass(step: string): void {
		this.writer.append(`PASS  ${step}`);
	}

	/**
	 * Record a step that threw. onload carries on afterwards, so this reports
	 * the failure and returns rather than rethrowing.
	 */
	fail(step: string, error: unknown): void {
		this.failures.push(step);
		const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
		console.error(`Project Tracker: ${step} failed during onload`, error);
		this.writer.append(`FAIL  ${step}\n      ${detail.split("\n").join("\n      ")}`);
	}

	/** Close the log out and put any failure on screen where it cannot be missed. */
	finish(): void {
		if (this.failures.length === 0) {
			this.writer.append("OK    onload completed, every registration succeeded");
			return;
		}

		const names = this.failures.join(", ");
		this.writer.append(`DONE  ${this.failures.length} step(s) failed: ${names}`);
		// A log that could not be written is itself a failure to report, otherwise
		// the notice points at a file that does not exist.
		const where = this.writer.written
			? `Details in ${LOG_NAME}, in the plugin folder.`
			: `${LOG_NAME} could not be written, so the stack trace is only in the developer console.`;
		// Duration 0 keeps the notice up until the user dismisses it, which is the
		// point: a load failure that scrolls away is the failure being reported.
		new Notice(`Project Tracker loaded with errors in: ${names}. ${where}`, 0);
	}
}