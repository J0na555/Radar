import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { editorActionLabel, isReadableRepo, openRepoFolder, parseEditorCommand, revealCommand } from "./editor.ts";
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
		stashCount: 0,
		unpushedCount: 0,
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
 * A real executable that records what it was called with. A real process rather than a stub,
 * because the thing under test is the spawn itself: an argv array with no shell between us
 * and the editor, one argument for the folder even when the folder's name has a space.
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
async function waitFor(check: () => boolean, ms = 15000): Promise<boolean> {
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

	// No shell runs, so nothing in the value can become a second command.
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
		assert.equal(isReadableRepo(gitRepo("gd-readable-")), true);
	});

	it("refuses a directory with no git in it", () => {
		assert.equal(isReadableRepo(tmp("gd-not-a-repo-")), false);
	});

	it("refuses a path that is not there", () => {
		assert.equal(isReadableRepo(path.join(os.tmpdir(), "gd-no-such-dir-xyz")), false);
	});
});

describe("openRepoFolder refusals", () => {
	it("names the project when it is not a git repository, and launches nothing", () => {
		const dir = tmp("gd-open-refuse-");
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
		const dir = gitRepo("gd-open-reveal-");
		const result = openRepoFolder(facts(dir), "  ", () => {});
		assert.deepEqual(result, { ok: true, mode: "reveal", command: revealCommand(dir).command });
	});
});

describe("openRepoFolder launching", () => {
	// The real question this feature has to get right: does clicking the row return, or does
	// Obsidian wait for the editor to close? Everything below runs a real process and
	// measures the call.
	const skip = process.platform === "win32" ? "needs a POSIX shell to fake an editor" : false;

	it("passes the repo folder as one argument, with no shell in between", { skip }, async () => {
		const dir = tmp("gd-open-argv-");
		const repo = path.join(dir, "repo with a space");
		fs.mkdirSync(repo);
		spawnSync("git", ["init", "-q", repo], { encoding: "utf8" });
		const editor = recordingEditor(dir, 0);

		const result = openRepoFolder(facts(repo), editor.script, () => {});
		assert.equal(result.ok && result.mode, "editor");

		assert.ok(await waitFor(() => editor.calls().includes("started")));
		// One argument, the folder, verbatim. A shell string would have split this in two and
		// the editor would have received a path that does not exist.
		const call = editor.calls();
		assert.equal(call[0], repo);
		// Waited for, not asserted straight away. The script writes "started" and
		// "finished" in two separate appends with the sleep between them, so the file
		// is briefly readable with the first marker present and the second not yet
		// written. Reading it synchronously here made this fail under parallel load
		// without the code under test changing at all.
		assert.ok(
			await waitFor(() => editor.calls().includes("finished")),
			"fake editor never recorded finishing, so it did not run to completion",
		);
	});

	it("returns while the editor is still running", { skip }, async () => {
		const dir = tmp("gd-open-nonblocking-");
		const repo = gitRepoIn(dir, "repo");
		const editor = recordingEditor(dir, 4);

		const started = Date.now();
		const result = openRepoFolder(facts(repo), editor.script, () => {});
		const elapsed = Date.now() - started;

		assert.equal(result.ok, true);
		// The machine-independent claim: the call came back before the child's own 4000ms minimum
		// lifetime, so it did not wait for the editor to close. Headroom is real because this
		// suite runs in parallel and scheduling can jitter.
		assert.ok(elapsed < 2000, `launch blocked for ${elapsed}ms, past 2000ms headroom`);

		// The point of the measurement: the editor is provably mid-session.
		assert.ok(await waitFor(() => editor.calls().includes("started")));
		assert.ok(!editor.calls().includes("finished"), "the editor had already exited, so nothing was proven");

		// Leave nothing running past the suite.
		await waitFor(() => editor.calls().includes("finished"), 15000);
	});

	it("reports a missing binary instead of failing silently", { skip }, async () => {
		const repo = gitRepo("gd-open-missing-");
		const messages: string[] = [];
		const result = openRepoFolder(facts(repo), "gd-no-such-editor-binary", (message) => messages.push(message));
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
describe("editorActionLabel", () => {
	it("names the binary that will actually run", () => {
		assert.equal(editorActionLabel("anki", "code"), "Open anki in code");
		assert.equal(editorActionLabel("anki", "cursor"), "Open anki in cursor");
	});

	it("drops the arguments, which are not part of the binary's name", () => {
		// `kitty --single-instance --directory` reads as "in kitty", and naming the whole string
		// on a button nobody is going to type is noise.
		assert.equal(editorActionLabel("x", "kitty --single-instance --directory"), "Open x in kitty");
		assert.equal(editorActionLabel("x", "nvim   -p  "), "Open x in nvim");
	});

	it("says what an empty setting does instead", () => {
		assert.equal(editorActionLabel("anki", ""), "Reveal anki in the file manager");
		assert.equal(editorActionLabel("anki", "   "), "Reveal anki in the file manager");
	});

	it("keeps the project name in the wording, since the button has no room", () => {
		const label = editorActionLabel("commit-crystal-ball", "code");
		assert.match(label, /commit-crystal-ball/);
		assert.ok(label.length < 60, `label too long for a button: ${label}`);
	});
});
