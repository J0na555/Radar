/**
 * Append-only file logging, shared by `startup.log` and `errors.log`.
 *
 * Two logs with the same needs grew out of one pattern: load failures during
 * onload, and generation failures afterwards. Forking a second near-identical
 * writer for the second log would leave two places to fix every disk, encoding,
 * and rotation bug, so the pattern lives here once and each log supplies only its
 * own filename and entry format.
 *
 * Nothing here imports `obsidian`. The path is passed in, structurally typed
 * rather than declared as a `Plugin`, so `node --test` can exercise rotation and
 * truncation against a real temp file with no bundler and no GUI.
 */
import { appendFileSync, closeSync, openSync, readSync, statSync, writeFileSync } from "fs";

/**
 * Default cap on one log file.
 *
 * Startup traces are a few kilobytes a session. Generation errors are rarer but
 * carry a CLI's own message, which can run to a few hundred bytes each, so this
 * is generous for both while still bounding the file.
 */
export const DEFAULT_MAX_BYTES = 256 * 1024;

/**
 * The slice of `Plugin` needed to find the plugin folder.
 *
 * Structural on purpose: `Plugin` satisfies this without an import of `obsidian`,
 * which keeps this file runnable under `node --test`. `getFullPath` is declared
 * on `FileSystemAdapter` rather than on `DataAdapter`, so it is narrowed here at
 * runtime rather than assumed by the type.
 */
export interface PluginFolder {
	manifest: { dir?: string | undefined };
	app: { vault: { configDir: string; adapter: unknown } };
}

/**
 * Absolute path of `fileName` inside this plugin's folder, or null when it cannot
 * be resolved.
 *
 * Null is a normal answer, not an error: a mobile vault, or one whose adapter has
 * no `getFullPath`, has no plugin folder to write into.
 */
export function resolvePluginFolderPath(plugin: PluginFolder, fileName: string): string | null {
	const dir = plugin.manifest.dir;
	if (!dir) return null;
	const adapter = plugin.app.vault.adapter as { getFullPath?: (path: string) => string } | undefined;
	if (typeof adapter?.getFullPath !== "function") return null;
	return adapter.getFullPath(`${plugin.app.vault.configDir}/plugins/${dir}/${fileName}`);
}

/**
 * Append-only log with a size cap, in one file at a stable path.
 *
 * Trimming happens in place rather than by rotating to `errors.log.1`, because
 * the plugin names this exact path in the notice it shows the user. A second file
 * would be one more place to go looking when something has already gone wrong.
 *
 * Writing is best effort throughout. A logger that throws is its own outage, so
 * every filesystem call is swallowed and `wroteToDisk` reports whether the caller
 * can honestly claim a log exists.
 */
export class LogWriter {
	private readonly path: string | null;
	private readonly maxBytes: number;
	private wroteToDisk = false;

	// Explicit fields rather than constructor parameter properties: this file is
	// imported directly by `node --test`, and Node's TypeScript support is
	// strip-only, which cannot erase a parameter property.
	constructor(path: string | null, maxBytes: number = DEFAULT_MAX_BYTES) {
		this.path = path;
		this.maxBytes = maxBytes;
	}

	/** True once a write has landed, so callers do not point at a missing file. */
	get written(): boolean {
		return this.wroteToDisk;
	}

	/** Absolute log path, or null when none could be resolved. */
	get location(): string | null {
		return this.path;
	}

	/** Start a fresh log so it always describes the current session. */
	start(header: string): void {
		if (!this.path) return;
		try {
			writeFileSync(this.path, ensureNewline(header));
			this.wroteToDisk = true;
		} catch {
			// No writable log location. The notice and console still report.
		}
	}

	/** Append one entry. Never throws. */
	append(entry: string): void {
		if (!this.path) return;
		const text = this.bound(ensureNewline(entry));
		try {
			// Byte length, not string length. The cap is about what lands on disk,
			// and `"å".repeat(1000)` is 1000 characters but 2000 bytes.
			this.trim(Buffer.byteLength(text, "utf8"));
			appendFileSync(this.path, text);
			this.wroteToDisk = true;
		} catch {
			// See start().
		}
	}

	/**
	 * Cap a single entry against the whole budget.
	 *
	 * Without this a long entry escapes the cap: a CLI can print a megabyte of
	 * stack trace, and trimming only ever compares against what is already in the
	 * file, so the first huge append would grow the file without limit.
	 *
	 * Cut on a byte budget and iterate by code point, so a multi-byte character is
	 * either wholly kept or wholly dropped. Slicing by index would split one in
	 * half and write a broken glyph.
	 */
	private bound(text: string): string {
		if (Buffer.byteLength(text, "utf8") <= this.maxBytes) return text;

		const notice = "\n    [entry truncated to fit the log cap]\n";
		const room = Math.max(0, this.maxBytes - Buffer.byteLength(notice, "utf8"));
		let head = "";
		let used = 0;
		for (const char of text) {
			const width = Buffer.byteLength(char, "utf8");
			if (used + width > room) break;
			head += char;
			used += width;
		}
		// The head goes first because that is where a failure describes itself.
		return head + notice;
	}

	/**
	 * Drop the oldest lines so `incoming` more bytes still fit under the cap.
	 *
	 * Only the tail worth keeping is ever read, so adopting an already-huge file
	 * costs a fixed amount of I/O rather than its whole size. The cut lands on a
	 * newline so the first surviving entry is a whole entry, which also means a
	 * cut through a multi-byte character discards that character instead of
	 * writing half of one.
	 */
	private trim(incoming: number): void {
		const path = this.path;
		if (!path) return;

		let size: number;
		try {
			size = statSync(path).size;
		} catch {
			// No file yet, so there is nothing to trim.
			return;
		}
		if (size + incoming <= this.maxBytes) return;

		const header = `--- Project Tracker log trimmed at ${new Date().toISOString()}; older lines above were removed ---\n`;
		const keep = this.maxBytes - incoming - header.length;
		if (keep <= 0) {
			// A cap so small the incoming entry nearly fills it alone. The entry is
			// worth more than the marker, and `incoming` is already bounded to the
			// cap, so emptying the file here keeps the size invariant either way.
			writeFileSync(path, "");
			return;
		}

		const fd = openSync(path, "r");
		try {
			const tail = Buffer.alloc(keep);
			readSync(fd, tail, 0, keep, size - keep);
			const newline = tail.indexOf(0x0a);
			if (newline === -1) {
				// Nothing whole survives the cut, so there is nothing to keep but
				// the marker saying the rest is gone.
				writeFileSync(path, header);
				return;
			}
			writeFileSync(path, header + tail.subarray(newline + 1).toString("utf8"));
		} finally {
			closeSync(fd);
		}
	}
}

function ensureNewline(value: string): string {
	return value.endsWith("\n") ? value : `${value}\n`;
}

/** One recorded failure: who, what, when. */
export interface ErrorEntry {
	/** Provider that was asked, or "none" when nothing was reachable. */
	provider: string;
	/** Project the failure belongs to, or "unknown". */
	project: string;
	/** What went wrong, as the plugin knows it. */
	message: string;
}

/**
 * The durable record of generation failures.
 *
 * This exists because the alternative was a failure nobody could see. A summary
 * error went to a transient Notice and nowhere else, so an auth error printed by
 * a CLI was unreadable without the devtools console. Everything lands in
 * `errors.log` in the plugin folder instead: timestamp, provider, project, and
 * the message, which is the CLI's own words whenever the CLI supplied any.
 */
export class ErrorLog {
	/** Name of the file in the plugin folder, named in every notice that points at it. */
	static readonly FILE_NAME = "errors.log";

	private readonly writer: LogWriter;

	constructor(plugin: PluginFolder, maxBytes?: number) {
		this.writer = new LogWriter(resolvePluginFolderPath(plugin, ErrorLog.FILE_NAME), maxBytes);
	}

	/** True once a record has landed on disk. */
	get written(): boolean {
		return this.writer.written;
	}

	/**
	 * Sentence for a notice, telling the user where the detail is. Says so
	 * plainly when the log could not be written, because a notice pointing at a
	 * file that does not exist is worse than no notice.
	 */
	get whereSentence(): string {
		return this.writer.written
			? `Details in ${ErrorLog.FILE_NAME}, in the Project Tracker plugin folder.`
			: `${ErrorLog.FILE_NAME} could not be written, so this is only recorded in the developer console.`;
	}

	/** Record one failure. Never throws. */
	record(entry: ErrorEntry): void {
		const stamp = new Date().toISOString();
		const provider = entry.provider.trim() || "unknown";
		const project = entry.project.trim() || "unknown";
		// The blank line matters: without it a multi-line message runs straight
		// into the next entry's timestamp and the log becomes unreadable, which is
		// the only reason it exists.
		this.writer.append(
			`${stamp}  provider=${provider}  project=${project}\n${indent(entry.message)}\n\n`,
		);
	}
}

/** Indent a multi-line message so its continuation lines read as part of it. */
function indent(message: string): string {
	const text = message.replace(/\r\n/g, "\n").trimEnd();
	return text
		.split("\n")
		.map((line) => `    ${line}`)
		.join("\n");
}