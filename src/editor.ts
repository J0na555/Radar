/**
 * Opening a repo folder in the user's editor.
 *
 * Two separate jobs, and the reason this is its own file: deciding *whether* to
 * launch anything is a pure function of the settings and the repo, while running
 * it is the part that touches processes. Keeping them apart is what makes the
 * refusal and the degrade-to-reveal behaviour testable without a GUI.
 *
 * This is the second "which binary do we call" decision in the plugin and it has
 * nothing to do with the AI provider. That one picks a model CLI to summarise a
 * repo; this one picks an editor to open a folder in. See FEATURE-PLAN.md,
 * resolved decision 3.
 *
 * No `obsidian` import, so `node --test` loads this directly.
 */
import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import type { RepoFacts } from "./types";

/** A parsed `editorCommand`: one executable plus whatever tokens followed it. */
export interface EditorCommand {
	command: string;
	args: string[];
}

export type OpenResult =
	| { ok: true; mode: "editor" | "reveal"; command: string }
	| { ok: false; error: string };

/**
 * How much of a failed launch's stderr to keep before throwing the rest away.
 *
 * An editor that runs all day must not grow a buffer in the plugin's process,
 * and the first line is the only part that ever names a fix.
 */
const STDERR_LIMIT = 2000;

/**
 * Split the `editorCommand` setting into an executable and its arguments.
 *
 * Whitespace-separated tokens, nothing more. No shell is involved, so nothing
 * here expands globs, resolves `$PATH` inside a word, or honours `&&`: a value
 * like `code && rm -rf ~` becomes three literal argv entries and `code` is the
 * only program that runs. That is the same rule `src/provider.ts` follows, and
 * it is why this accepts arguments at all: a terminal editor needs a terminal
 * emulator in front of it, and the emulator needs flags.
 *
 * Null means "the user configured nothing", which the caller turns into a
 * reveal rather than an error.
 */
export function parseEditorCommand(setting: string): EditorCommand | null {
	const trimmed = setting.trim();
	if (trimmed === "") return null;
	const tokens = trimmed.split(/\s+/);
	return { command: tokens[0], args: tokens.slice(1) };
}

/**
 * The file manager for this platform, as a command plus argv.
 *
 * `explorer.exe` on Windows returns exit code 1 even when it opened the folder
 * successfully, which is why a non-zero exit with nothing on stderr is treated
 * as success everywhere.
 */
export function revealCommand(repoPath: string, platform: NodeJS.Platform = process.platform): EditorCommand {
	if (platform === "darwin") return { command: "open", args: [repoPath] };
	if (platform === "win32") return { command: "explorer.exe", args: [repoPath] };
	return { command: "xdg-open", args: [repoPath] };
}

/**
 * Can git read this repository right now?
 *
 * Checked at click time rather than trusted from the last scan, because a repo
 * can be deleted, moved, or half-copied between two scans and the answer the
 * user gets has to be true at the moment they click. One cheap call.
 */
export function isReadableRepo(repoPath: string): boolean {
	if (!fs.existsSync(repoPath)) return false;
	const res = spawnSync("git", ["rev-parse", "--git-dir"], {
		cwd: repoPath,
		encoding: "utf8",
		windowsHide: true,
	});
	return !res.error && res.status === 0;
}

/**
 * Spawn an editor, or the file manager, and return immediately.
 *
 * Why async `spawn` and not `spawnSync`, for every binary rather than per-binary
 * choice:
 *
 * `spawnSync` returns when the child exits. `detached` and `unref` do not change
 * that, because `SpawnSyncReturns` has no `unref` and its `detached` option only
 * puts the child in a new process group. So a `spawnSync` launch of `nvim` would
 * hold Obsidian's single thread for the entire editing session, which is a hang
 * with no way out. `code` and `cursor` are better but not safe either: the VS Code
 * CLI holds the process while it hands off to a window, and blocks outright when
 * it has to ask about workspace trust. There is no flag that makes any of them
 * not block, so the fix is structural rather than per-binary: spawn, unref, and
 * never wait.
 *
 * `stdio` is `ignore` on stdin and stdout for a second reason that is specific to
 * the terminal editors. Obsidian's own stdin and stdout are inherited by the
 * child by default, and when Obsidian was itself started from a terminal those
 * are a real TTY: `nvim` would then draw into whatever shell launched Obsidian
 * and block on input nobody can type. Ignoring them means the child can never
 * take over a terminal. The cost is that `nvim` in this field cannot work at
 * all, since there is no TTY left to give it, and it fails immediately with
 * "Input is not from a terminal" rather than hanging. That is the intended
 * trade: a visible failure the settings description explains beats a frozen UI.
 *
 * `onError` is called for the failures that arrive after the spawn: a missing
 * binary, and a non-zero exit that printed something. `cwd` is the repo so an
 * editor opens the tree the user is looking at rather than the scan root.
 */
export function runOpen(
	plan: EditorCommand,
	repoPath: string,
	onError: (message: string) => void,
): void {
	const args = [...plan.args, repoPath];

	let child;
	try {
		child = spawn(plan.command, args, {
			cwd: repoPath,
			windowsHide: true,
			detached: true,
			stdio: ["ignore", "ignore", "pipe"],
		});
	} catch (error) {
		onError(`could not run ${plan.command}: ${String(error)}`);
		return;
	}

	// Both of these, or the plugin holds the editor open in its event loop: the
	// child handle, and the stderr pipe that stays open for as long as the editor
	// runs. The pipe is a socket at runtime, where `unref` exists, but it is typed
	// as a plain Readable, so the call is guarded instead of cast.
	child.unref();
	const stderrStream = child.stderr as typeof child.stderr & { unref?: () => void };
	stderrStream?.unref?.();

	child.once("error", (error: NodeJS.ErrnoException) => {
		onError(
			error.code === "ENOENT"
				? `${plan.command} is not on PATH. Fix the editor command in the Project Tracker settings, or clear it to open the folder in the file manager.`
				: `could not run ${plan.command}: ${error.message}`,
		);
	});

	let output = "";
	stderrStream?.setEncoding("utf8");
	stderrStream?.on("data", (chunk: string) => {
		// Read forever, remember the first cap's worth: a full editor session's
		// stderr must not accumulate here.
		if (output.length < STDERR_LIMIT) output += chunk;
	});

	child.once("close", (code) => {
		if (code === 0) return;
		const line = firstLine(output);
		// Only when it said something. A silent non-zero exit is a normal outcome
		// for explorer.exe on Windows and is not worth a notice about.
		if (line) onError(`${plan.command} exited ${code}: ${line}`);
	});
}

/**
 * Open a repo folder: in the configured editor, or revealed in the file manager.
 *
 * Refuses on anything git cannot read, and says which of the two reasons it was,
 * because "nothing happened" is the failure a user cannot act on.
 *
 * `onError` covers what can only be known after the spawn. The returned value
 * covers the refusals, which are the only failures decided synchronously.
 */
export function openRepoFolder(
	facts: RepoFacts,
	setting: string,
	onError: (message: string) => void,
): OpenResult {
	if (!fs.existsSync(facts.path)) {
		return { ok: false, error: `${facts.name} is gone: ${facts.path} does not exist. Rescan.` };
	}
	if (!isReadableRepo(facts.path)) {
		return {
			ok: false,
			error: `${facts.name} is not a readable git repository, so there is nothing to open: ${facts.path}`,
		};
	}

	const parsed = parseEditorCommand(setting);
	if (parsed === null) {
		const plan = revealCommand(facts.path);
		runOpen(plan, facts.path, onError);
		return { ok: true, mode: "reveal", command: plan.command };
	}

	runOpen(parsed, facts.path, onError);
	return { ok: true, mode: "editor", command: parsed.command };
}

/** First non-empty line of captured output, or empty. */
function firstLine(value: string): string {
	for (const line of value.split("\n")) {
		const trimmed = line.trim();
		if (trimmed !== "") return trimmed;
	}
	return "";
}