import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ErrorLog, LogWriter, resolvePluginFolderPath } from "./log-writer.ts";
import type { PluginFolder } from "./log-writer.ts";

/**
 * A stand-in for the parts of `Plugin` that matter here.
 *
 * Structurally typed rather than a real `Plugin`, which is the whole reason
 * `log-writer.ts` imports no obsidian: this file runs under plain `node --test`
 * with no bundler and no vault.
 */
function fakePlugin(adapter: unknown = { getFullPath: (p: string) => p }): PluginFolder {
	return {
		manifest: { dir: "project-tracker" },
		app: { vault: { configDir: "/vault/.obsidian", adapter } },
	};
}

describe("resolvePluginFolderPath", () => {
	it("resolves inside the vault config directory's plugin folder", () => {
		const plugin = fakePlugin();
		assert.equal(
			resolvePluginFolderPath(plugin, "errors.log"),
			"/vault/.obsidian/plugins/project-tracker/errors.log",
		);
	});

	it("returns null when the manifest carries no directory", () => {
		// Mobile vaults, and manifests read before Obsidian fills `dir` in. No
		// folder means no log, and the caller has to say so rather than guess.
		const plugin = fakePlugin();
		plugin.manifest.dir = undefined;
		assert.equal(resolvePluginFolderPath(plugin, "errors.log"), null);
	});

	it("returns null when the adapter has no getFullPath", () => {
		// `getFullPath` lives on FileSystemAdapter, not on DataAdapter, so it has
		// to be narrowed at runtime. An adapter without it must not be called.
		assert.equal(resolvePluginFolderPath(fakePlugin({}), "errors.log"), null);
		assert.equal(resolvePluginFolderPath(fakePlugin(null), "errors.log"), null);
	});
});

describe("LogWriter", () => {
	let dir = "";
	let file = "";

	beforeEach(() => {
		dir = mkdtempSync(path.join(tmpdir(), "pt-log-"));
		file = path.join(dir, "errors.log");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("appends rather than replacing, so nothing already written is lost", () => {
		const log = new LogWriter(file);
		log.append("first");
		log.append("second");
		assert.equal(readFileSync(file, "utf8"), "first\nsecond\n");
	});

	it("adds the trailing newline a caller left out", () => {
		const log = new LogWriter(file);
		log.append("no newline here");
		assert.equal(readFileSync(file, "utf8"), "no newline here\n");
	});

	it("reports whether it actually wrote, so a notice cannot lie", () => {
		const log = new LogWriter(file);
		assert.equal(log.written, false);
		log.append("something");
		assert.equal(log.written, true);
	});

	it("never throws when the path cannot be written", () => {
		// A logger that throws is its own outage, so an unwritable log must be
		// silent and must not claim success.
		const log = new LogWriter(path.join(dir, "no", "such", "dir", "errors.log"));
		assert.doesNotThrow(() => log.append("anything"));
		assert.equal(log.written, false);
	});

	it("never throws when there is no path at all", () => {
		const log = new LogWriter(null);
		assert.doesNotThrow(() => log.append("anything"));
		assert.equal(log.written, false);
		assert.equal(log.location, null);
	});

	it("starts a fresh file, discarding the previous session's contents", () => {
		writeFileSync(file, "yesterday's contents\n");
		const log = new LogWriter(file);
		log.start("--- today ---");
		assert.equal(readFileSync(file, "utf8"), "--- today ---\n");
	});

	// The cap is the only thing stopping a log that records every failed summary
	// from filling a disk over months of use.
	it("keeps the file under its cap instead of growing without bound", () => {
		const log = new LogWriter(file, 2000);
		for (let i = 0; i < 500; i++) {
			log.append(`entry ${i} ${"x".repeat(60)}`);
		}
		const size = statSync(file).size;
		assert.ok(size <= 2000, `file grew to ${size} bytes, past the 2000 byte cap`);
	});

	it("trims the oldest entries and keeps the newest", () => {
		const log = new LogWriter(file, 1200);
		for (let i = 0; i < 200; i++) {
			log.append(`entry-${i} ${"y".repeat(40)}`);
		}
		const contents = readFileSync(file, "utf8");
		// The latest entry is the one worth having.
		assert.match(contents, /entry-199/);
		// The oldest is gone, and the loss is stated rather than silent.
		assert.doesNotMatch(contents, /entry-0 /);
		assert.match(contents, /trimmed at .* older lines above were removed/);
	});

	it("leaves a file that fits untouched", () => {
		const log = new LogWriter(file, 10_000);
		log.append("one");
		log.append("two");
		assert.equal(readFileSync(file, "utf8"), "one\ntwo\n");
		assert.doesNotMatch(readFileSync(file, "utf8"), /trimmed/);
	});

	it("trims to whole lines, so no entry starts half-written", () => {
		const log = new LogWriter(file, 700);
		for (let i = 0; i < 100; i++) {
			log.append(`line-${i} ${"z".repeat(50)}`);
		}
		const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
		// Every line after the trim marker is a complete entry, matched by pattern.
		for (const line of lines) {
			assert.match(line, /^(--- Project Tracker log trimmed|line-\d+ z+)/);
		}
		assert.ok(lines.length > 1, "the trim must leave something readable behind");
	});

	it("keeps the entry when the cap is barely larger than one entry", () => {
		// Degenerate, but the entry itself is the reason the file exists, so the
		// marker is what gets dropped, not the record.
		const log = new LogWriter(file, 200);
		log.append("x".repeat(150));
		log.append("the entry that matters");
		const contents = readFileSync(file, "utf8");
		assert.ok(statSync(file).size <= 200, `grew to ${statSync(file).size}`);
		assert.match(contents, /the entry that matters/);
	});

	it("caps an entry that is on its own larger than the whole budget", () => {
		// A CLI can print a megabyte of stack trace. Trimming only compares against
		// what is already on disk, so without a per-entry bound the very first
		// huge append would grow the file without limit.
		const log = new LogWriter(file, 500);
		log.append("HEAD of the message".padEnd(50, "h") + "z".repeat(50_000));
		const contents = readFileSync(file, "utf8");
		assert.ok(statSync(file).size <= 500, `grew to ${statSync(file).size}`);
		// The head survives, because that is where the failure is described.
		assert.match(contents, /HEAD of the message/);
		assert.match(contents, /entry truncated to fit the log cap/);
	});

	it("does not split a multi-byte character when it caps an entry", () => {
		const log = new LogWriter(file, 300);
		log.append("å".repeat(1000));
		const contents = readFileSync(file, "utf8");
		assert.doesNotMatch(contents, /\uFFFD/);
		assert.ok(statSync(file).size <= 300);
	});

	it("does not split a multi-byte character when it trims", () => {
		const log = new LogWriter(file, 700);
		for (let i = 0; i < 100; i++) {
			log.append(`entry-${i} ${"åäö".repeat(20)}`);
		}
		const contents = readFileSync(file, "utf8");
		// A cut through a character would leave a lone surrogate or a replacement
		// char, so the file has to be valid UTF-8 with no partial glyph.
		assert.doesNotMatch(contents, /\uFFFD/);
		for (const line of contents.split("\n").filter(Boolean)) {
			assert.match(line, /^(--- Project Tracker log trimmed|entry-\d+ (åäö)+)/);
		}
	});

	it("adopts an already-huge file rather than reading all of it into memory", () => {
		// A log written by an older build, or by hand, can already be large. The
		// trim only ever reads the tail worth keeping.
		writeFileSync(file, `${"j".repeat(50_000)}\nrecent tail\n`);
		const log = new LogWriter(file, 1000);
		log.append("new entry");
		const contents = readFileSync(file, "utf8");
		assert.ok(statSync(file).size <= 1000);
		assert.match(contents, /new entry/);
		assert.match(contents, /recent tail/);
	});
});

describe("ErrorLog", () => {
	let dir = "";
	let file = "";

	beforeEach(() => {
		dir = mkdtempSync(path.join(tmpdir(), "pt-errors-"));
		file = path.join(dir, "errors.log");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("records timestamp, provider, project and message on one line", () => {
		const log = new ErrorLog(fakePlugin({ getFullPath: () => file }));
		log.record({
			provider: "gemini",
			project: "waifu-rag",
			message: "Please set an Auth method in your settings.json",
		});
		const line = readFileSync(file, "utf8");
		assert.match(line, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z {2}provider=gemini {2}project=waifu-rag$/m);
		assert.match(line, /^ {4}Please set an Auth method/m);
	});

	it("writes to errors.log in the plugin folder", () => {
		const log = new ErrorLog(fakePlugin({ getFullPath: () => file }));
		log.record({ provider: "codex", project: "a", message: "boom" });
		assert.equal(log.written, true);
		assert.equal(ErrorLog.FILE_NAME, "errors.log");
		assert.match(readFileSync(file, "utf8"), /provider=codex/);
	});

	it("resolves errors.log under the vault's plugin folder", () => {
		// Separate from writing, because the two answer different questions: the
		// name the notice gives the user, and whether the bytes landed.
		assert.equal(
			resolvePluginFolderPath(fakePlugin({ getFullPath: (p: string) => p }), ErrorLog.FILE_NAME),
			"/vault/.obsidian/plugins/project-tracker/errors.log",
		);
	});

	it("keeps a multi-line message attached to its entry", () => {
		// CLI errors arrive with stack traces and multi-line JSON. Without the
		// indent they interleave with the next entry and become unreadable, and
		// without the blank line the next entry's timestamp follows on directly.
		const log = new ErrorLog(fakePlugin({ getFullPath: () => file }));
		log.record({ provider: "codex", project: "a", message: "line one\nline two" });
		log.record({ provider: "opencode", project: "b", message: "second" });
		const lines = readFileSync(file, "utf8").split("\n");
		assert.match(lines[0] ?? "", /provider=codex {2}project=a$/);
		assert.match(lines[1] ?? "", /^ {4}line one$/);
		assert.match(lines[2] ?? "", /^ {4}line two$/);
		// A blank separator line, then the next entry header.
		assert.equal(lines[3] ?? "", "");
		assert.match(lines[4] ?? "", /provider=opencode {2}project=b$/);
		assert.match(lines[5] ?? "", /^ {4}second$/);
	});

	it("substitutes a placeholder for an empty provider or project", () => {
		// The point of the log is that an entry can be acted on. `provider=` with
		// nothing after it is not.
		const log = new ErrorLog(fakePlugin({ getFullPath: () => file }));
		log.record({ provider: "  ", project: "", message: "no provider" });
		const line = readFileSync(file, "utf8");
		assert.match(line, /provider=unknown {2}project=unknown/);
	});

	it("appends rather than replacing, across many failures", () => {
		// Every error path in a generation logs, so the file has to accumulate a
		// history rather than showing only the latest thing that went wrong.
		const log = new ErrorLog(fakePlugin({ getFullPath: () => file }));
		log.record({ provider: "gemini", project: "a", message: "first" });
		log.record({ provider: "gemini", project: "b", message: "second" });
		log.record({ provider: "gemini", project: "c", message: "third" });
		const contents = readFileSync(file, "utf8");
		for (const text of ["first", "second", "third"]) {
			assert.match(contents, new RegExp(text));
		}
	});

	it("stays under a cap even across a great many failures", () => {
		const log = new ErrorLog(fakePlugin({ getFullPath: () => file }), 2000);
		for (let i = 0; i < 300; i++) {
			log.record({ provider: "gemini", project: `project-${i}`, message: "x".repeat(80) });
		}
		assert.ok(statSync(file).size <= 2000, `grew to ${statSync(file).size}`);
	});

	it("says where the log is once something has been written", () => {
		const log = new ErrorLog(fakePlugin({ getFullPath: () => file }));
		// Before anything is written there is no file to point at, so the sentence
		// has to admit that rather than naming a path.
		assert.match(log.whereSentence, /could not be written/);
		log.record({ provider: "gemini", project: "a", message: "boom" });
		assert.match(log.whereSentence, /Details in errors\.log/);
		assert.match(log.whereSentence, /plugin folder/);
	});

	it("says plainly when it could not write, rather than naming a missing file", () => {
		const log = new ErrorLog(fakePlugin({ getFullPath: () => path.join(dir, "nope", "errors.log") }));
		log.record({ provider: "gemini", project: "a", message: "boom" });
		// A notice pointing at a file that does not exist is worse than no notice.
		assert.match(log.whereSentence, /could not be written/);
		assert.doesNotMatch(log.whereSentence, /Details in/);
	});

	it("never throws when the folder cannot be resolved at all", () => {
		const plugin = fakePlugin();
		plugin.manifest.dir = undefined;
		const log = new ErrorLog(plugin);
		assert.doesNotThrow(() => log.record({ provider: "gemini", project: "a", message: "boom" }));
		assert.equal(log.written, false);
	});
});