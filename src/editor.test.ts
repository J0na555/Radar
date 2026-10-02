import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { isReadableRepo, openRepoFolder, parseEditorCommand, revealCommand } from "./editor.ts";
import type { RepoFacts } from "./types.ts";

/** A temp dir that cleans itself up. */
function tmp(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function facts(dir: string): RepoFacts {
	return {
		path: dir,
		name: path.basename(dir),
		root: dir,
		gitReadable: true,
		remote: null,
		github: null,
		branch: "main",
		defaultBranch: "main",
		onNonDefaultBranch: false,
		lastCommit: null,
		dirtyCount: 0,
		dirMtime: 0,
	};
}

function gitRepo(prefix: string): string {
	const dir = tmp(prefix);
	const init = spawnSync("git", ["init", "-q", dir], { encoding: "utf8" });
	assert.equal(init.status, 0, `git init failed: ${init.stderr}`);
	return dir;
}

/**
 * A real executable that records what it was called with.
 *
 * A real process rather than a stub, because the thing under test is the spawn
 * itself: an argv array with no shell between us and the editor, one argument
 * for the folder even when the folder's name has a space in it.
 */
function recordingEditor(dir: string, sleepSeconds: number): { script: string; calls: () => string[] } {
	const script = path.join(dir, "fake-editor.sh");
	fs.writeFileSync(
		script,
		[
			"#!/bin/sh",
			`printf '%s\\n' "$@" >> ${JSON.stringify(path.join(dir, "calls.txt"))}`,
			`printf 'started\\n' >> ${JSON.stringify(path.join(dir, "calls.txt"))}`,
			`sleep ${sleepSeconds}`,
			`printf 'finished\\n' >> ${JSON.stringify(path.join(dir, "calls.txt"))}`,
			"",
		].join("\n"),
	);
	fs.chmodSync(script, 0o755);
	return { script, calls: () => (fs.existsSync(path.join(dir, "calls.txt")) ? fs.readFileSync(path.join(dir, "calls.txt"), "utf8").split("\n").filter(Boolean) : []) };
}

/** Poll until `check` passes or the budget runs out. */
async function waitFor(check: () => boolean, ms = 4000): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (check()) return true;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return check();
}

describe("parseEditorCommand", () => {
	it("reads an empty setting as no editor at all", () => {
		assert.equal(parseEditorCommand(""), null);
		assert.equal(parseEditorCommand("   "), null);
	});

	it("takes a bare binary name as the whole command", () => {
		assert.deepEqual(parseEditorCommand("code"), { command: "code", args: [] });
	});

	it("keeps the leading arguments, so a terminal emulator can be wrapped", () => {
		assert.deepEqual(parseEditorCommand("kitty --single-instance --directory"), {
			command: "kitty",
			args: ["--single-instance", "--directory"],
		});
	});

	it("collapses runs of whitespace rather than making empty arguments", () => {
		assert.deepEqual(parseEditorCommand("  code \t -n  "), { command: "code", args: ["-n"] });
	});

	// No shell runs, so nothing in the value can become a second command. The
	// tokens are passed through as-is and `code` is what gets executed.
	it("treats shell syntax as literal argv tokens", () => {
		assert.deepEqual(parseEditorCommand("code; rm -rf ~"), {
			command: "code;",
			args: ["rm", "-rf", "~"],
		});
	});
});

describe("revealCommand", () => {
	it("picks the file manager for the platform", () => {
		assert.deepEqual(revealCommand("/repos/a", "darwin"), { command: "open", args: ["/repos/a"] });
		assert.deepEqual(revealCommand("/repos/a", "win32"), { command: "explorer.exe", args: ["/repos/a"] });
		assert.deepEqual(revealCommand("/repos/a", "linux"), { command: "xdg-open", args: ["/repos/a"] });
	});
});

describe("isReadableRepo", () => {
	it("accepts a real git repository", () => {
		assert.equal(isReadableRepo(gitRepo("pt-readable-")), true);
	});

	it("refuses a directory with no git in it", () => {
		assert.equal(isReadableRepo(tmp("pt-not-a-repo-")), false);
	});

	it("refuses a path that is not there", () => {
		assert.equal(isReadableRepo(path.join(os.tmpdir(), "pt-no-such-dir-xyz")), false);
	});
});

describe("openRepoFolder refusals", () => {
	it("names the project when it is not a git repository, and launches nothing", () => {
		const dir = tmp("pt-open-refuse-");
		const launched: string[] = [];
		const result = openRepoFolder(facts(dir), "code", (message) => launched.push(message));
		assert.equal(result.ok, false);
		assert.match(result.ok ? "" : result.error, /not a readable git repository/);
		assert.match(result.ok ? "" : result.error, new RegExp(path.basename(dir)));
		assert.deepEqual(launched, []);
	});

	it("says the folder is gone when the path no longer exists", () => {
		const result = openRepoFolder(facts("/nope/not/here"), "code", () => {});
		assert.equal(result.ok, false);
		assert.match(result.ok ? "" : result.error, /is gone/);
	});

	it("reveals the folder instead of failing when the setting is empty", () => {
		const dir = gitRepo("pt-open-reveal-");
		const result = openRepoFolder(facts(dir), "  ", () => {});
		assert.deepEqual(result, { ok: true, mode: "reveal", command: revealCommand(dir).command });
	});
});

describe("openRepoFolder launching", () => {
	// The real question this feature has to get right: does clicking the row
	// return, or does Obsidian wait for the editor to close? Everything below runs
	// a real process and measures the call.
	const skip = process.platform === "win32" ? "needs a POSIX shell to fake an editor" : false;

	it("passes the repo folder as one argument, with no shell in between", { skip }, async () => {
		const dir = tmp("pt-open-argv-");
		const repo = path.join(dir, "repo with a space");
		fs.mkdirSync(repo);
		spawnSync("git", ["init", "-q", repo], { encoding: "utf8" });
		const editor = recordingEditor(dir, 0);

		const result = openRepoFolder(facts(repo), editor.script, () => {});
		assert.equal(result.ok && result.mode, "editor");

		assert.ok(await waitFor(() => editor.calls().includes("started")));
		// One argument, the folder, verbatim. A shell string would have split this
		// into two and the editor would have received a path that does not exist.
		const call = editor.calls();
		assert.equal(call[0], repo);
		assert.ok(call.includes("finished"));
	});

	it("returns while the editor is still running", { skip }, async () => {
		const dir = tmp("pt-open-nonblocking-");
		const repo = gitRepoIn(dir, "repo");
		const editor = recordingEditor(dir, 2);

		const started = Date.now();
		const result = openRepoFolder(facts(repo), editor.script, () => {});
		const elapsed = Date.now() - started;

		assert.equal(result.ok, true);
		// Two claims, and the second is the machine-independent one: the call came
		// back before the child's minimum lifetime of 2000ms, not merely quickly.
		assert.ok(elapsed < 2000, `launch blocked for ${elapsed}ms, past the editor's own 2000ms`);
		assert.ok(elapsed < 1000, `launch took ${elapsed}ms`);

		// The point of the measurement: the editor is provably mid-session, so the
		// call really did not wait for it.
		assert.ok(await waitFor(() => editor.calls().includes("started")));
		assert.ok(!editor.calls().includes("finished"), "the editor had already exited, so nothing was proven");

		// Leave nothing running past the suite.
		await waitFor(() => editor.calls().includes("finished"), 5000);
	});

	it("reports a missing binary instead of failing silently", { skip }, async () => {
		const repo = gitRepo("pt-open-missing-");
		const messages: string[] = [];
		const result = openRepoFolder(facts(repo), "pt-no-such-editor-binary", (message) => messages.push(message));
		assert.equal(result.ok, true);
		assert.ok(
			await waitFor(() => messages.length > 0),
			"a spawn failure produced no message",
		);
		assert.match(messages[0], /not on PATH/);
	});
});

/** `git init` inside `parent`, returning the new repo's path. */
function gitRepoIn(parent: string, name: string): string {
	const repo = path.join(parent, name);
	fs.mkdirSync(repo);
	const init = spawnSync("git", ["init", "-q", repo], { encoding: "utf8" });
	assert.equal(init.status, 0, `git init failed: ${init.stderr}`);
	return repo;
}