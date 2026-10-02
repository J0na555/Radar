/**
 * The CLI layer: build an argv, run it with a timeout, and turn whatever comes
 * back into either a summary or a readable error.
 *
 * Imports carry explicit `.ts` extensions and nothing here imports `obsidian`,
 * so `node --test` can exercise this file directly with no bundler and no GUI.
 */
import { execFile, spawnSync } from "child_process";
import { promisify } from "util";
import type { ProviderId } from "./types.ts";

const execFileAsync = promisify(execFile);

/** Upper bound on a CLI's stdout. A runaway agent should not exhaust memory. */
const MAX_BUFFER = 8 * 1024 * 1024;

/** The command each provider is invoked as. */
const COMMANDS: Record<ProviderId, string> = {
	gemini: "gemini",
	codex: "codex",
	opencode: "opencode",
};

/** Human-readable name for messages. */
const LABELS: Record<ProviderId, string> = {
	gemini: "gemini",
	codex: "codex",
	opencode: "opencode",
};

/**
 * The exact argv for one provider.
 *
 * The prompt is always a single element of the array, never interpolated into a
 * command string. Repo paths, branch names, and commit subjects all come from
 * disk, so a repository named `foo; rm -rf ~` would otherwise be a shell command
 * rather than a filename. `execFile` without a shell takes the array literally.
 *
 * Each provider gets its own JSON affordance, so the model reply can be parsed
 * as data instead of scraped out of prose:
 *
 * - `gemini -o json` prints one JSON object with the reply under `response`.
 * - `codex exec --json` prints JSONL events; the final reply arrives as an
 *   `item.completed` event whose item is an `agent_message`.
 * - `opencode run --format json` prints JSONL events; the reply arrives as a
 *   `text` event carrying `part.text`.
 */
export function buildArgv(provider: ProviderId, prompt: string): string[] {
	switch (provider) {
		case "gemini":
			return ["-p", prompt, "-o", "json"];
		case "codex":
			return ["exec", prompt, "--json"];
		case "opencode":
			return ["run", "--format", "json", prompt];
	}
}

/** The full invocation: program plus argv. */
export function buildInvocation(
	provider: ProviderId,
	prompt: string,
): { command: string; args: string[] } {
	return { command: COMMANDS[provider], args: buildArgv(provider, prompt) };
}

/** What the plugin parses out of a provider's stdout. */
export interface ParsedSummary {
	summary: string;
	nextSteps: string[];
}

/** Result of one generation attempt. Never throws; every failure is data. */
export type ProviderResult =
	| { ok: true; summary: ParsedSummary }
	| { ok: false; error: string };

/** Parse the JSONL or JSON body a provider printed, per provider. */
export function extractOutput(provider: ProviderId, stdout: string): string | null {
	const lines = stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);

	if (provider === "gemini") {
		// A single JSON object, reply under `response`.
		for (const line of lines) {
			const parsed = tryJson(line);
			if (parsed && typeof (parsed as { response?: unknown }).response === "string") {
				return (parsed as { response: string }).response;
			}
		}
		return null;
	}

	if (provider === "codex") {
		// JSONL. The last agent_message wins; earlier ones are intermediate steps.
		let found: string | null = null;
		for (const line of lines) {
			const event = tryJson(line) as
				| { type?: string; item?: { type?: string; text?: unknown } }
				| null;
			const item = event?.item;
			if (event?.type === "item.completed" && item?.type === "agent_message") {
				if (typeof item.text === "string") found = item.text;
			}
		}
		return found;
	}

	// opencode: JSONL with the reply split across one or more text parts.
	const parts: string[] = [];
	for (const line of lines) {
		const event = tryJson(line) as
			| { type?: string; part?: { type?: string; text?: unknown } }
			| null;
		if (event?.type === "text" && event.part?.type === "text" && typeof event.part.text === "string") {
			parts.push(event.part.text);
		}
	}
	return parts.length > 0 ? parts.join("") : null;
}

function tryJson(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}

/**
 * Pull a `{summary, next_steps}` object out of whatever text the model replied
 * with, and refuse anything that is not that shape.
 *
 * Models wrap JSON in prose or fences often enough that a strict parse would
 * fail on a perfectly good answer, so the first balanced `{...}` in the text is
 * tried. Everything after that is strict: a reply with no usable JSON is a
 * failure, never raw model text written into a note.
 */
export function parseSummary(text: string): ProviderResult {
	const candidate = firstJsonObject(text);
	if (candidate === null) {
		return { ok: false, error: "model reply contained no JSON object to parse" };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(candidate);
	} catch {
		return { ok: false, error: "model reply was not valid JSON" };
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { ok: false, error: "model reply was not a JSON object" };
	}

	const record = parsed as Record<string, unknown>;
	const summary = record.summary;
	if (typeof summary !== "string" || summary.trim().length === 0) {
		return { ok: false, error: "model reply had no non-empty `summary` string" };
	}

	// `next_steps` is optional. Present-but-wrong is an error, because silently
	// dropping a malformed list hides the fact that the model did not follow the
	// shape it was asked for.
	let nextSteps: string[] = [];
	if (record.next_steps !== undefined && record.next_steps !== null) {
		if (!Array.isArray(record.next_steps)) {
			return { ok: false, error: "model reply had a `next_steps` that was not an array" };
		}
		if (!record.next_steps.every((item) => typeof item === "string")) {
			return { ok: false, error: "model reply had a `next_steps` entry that was not a string" };
		}
		nextSteps = (record.next_steps as string[]).map((item) => item.trim()).filter((item) => item.length > 0);
	}

	return { ok: true, summary: { summary: summary.trim(), nextSteps } };
}

/** The first balanced `{...}` in `text`, ignoring braces inside strings. */
function firstJsonObject(text: string): string | null {
	const start = text.indexOf("{");
	if (start === -1) return null;

	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let i = start; i < text.length; i++) {
		const char = text[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (inString) {
			if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === "{") depth++;
		else if (char === "}") {
			depth--;
			if (depth === 0) return text.slice(start, i + 1);
		}
	}
	return null;
}

/**
 * Turn an execFile rejection into something worth showing a human.
 *
 * Takes the program name rather than a provider id, so the same message shape
 * works for a real provider and for any command the tests run.
 */
export function describeFailure(label: string, error: unknown): string {
	const err = error as {
		code?: string | number | null;
	 killed?: boolean;
	 signal?: string | null;
	 stderr?: string;
	 message?: string;
	};

	// A CLI that is not installed lands here. This is the single most likely
	// failure, so it gets the most actionable wording: the fix is to install
	// something or change the setting, and neither is guessable from ENOENT.
	if (err.code === "ENOENT") {
		return `${label} not found on PATH. Install it, or pick a different provider in the Project Tracker settings.`;
	}

	if (err.killed || err.signal === "SIGTERM" || err.signal === "SIGKILL") {
		return `${label} timed out and was killed. Raise the timeout in the Project Tracker settings, or try a smaller project.`;
	}

	const stderr = (err.stderr ?? "").trim();
	const status = typeof err.code === "number" ? err.code : null;
	if (status !== null) {
		const detail = stderr || firstLine(err.message ?? "") || "no output on stderr";
		return `${label} exited with code ${status}: ${detail}`;
	}

	return stderr || firstLine(err.message ?? "") || `${label} failed for an unknown reason`;
}

function firstLine(value: string): string {
	return value.split("\n")[0].trim();
}

/** Options for one generation run. */
export interface RunOptions {
	/** Wall-clock limit. The child is killed when it elapses. */
	timeoutMs: number;
	/** Working directory. Set to the repo root so the CLI sees the project. */
	cwd: string;
}

/**
 * Run one command with an argv array and a hard timeout.
 *
 * Separate from `runProvider` so the process handling, which is where the
 * injection and the hangs live, can be tested against real short-lived processes
 * instead of against whichever CLIs happen to be installed.
 *
 * Never throws. Every failure comes back as a string naming the program, so the
 * caller can put it in a Notice.
 */
export async function runCommand(
	command: string,
	args: string[],
	options: RunOptions,
): Promise<{ ok: true; stdout: string } | { ok: false; error: string; stderr: string }> {
	try {
		const result = await execFileAsync(command, args, {
			cwd: options.cwd,
			encoding: "utf8",
			// A hung CLI would otherwise wedge the panel with no way back. execFile
			// kills the child with SIGTERM when this elapses, and the rejection
			// carries `killed`/`signal`, which describeFailure turns into a timeout
			// message rather than a bare crash.
			timeout: options.timeoutMs,
			maxBuffer: MAX_BUFFER,
			windowsHide: true,
		});
		return { ok: true, stdout: result.stdout };
	} catch (error) {
		return { ok: false, error: describeFailure(command, error), stderr: (error as { stderr?: string }).stderr ?? "" };
	}
}

/**
 * Run one provider and parse the result.
 *
 * Never throws. A missing binary, a crash, a hang, and a reply in the wrong shape
 * all come back as `{ok: false, error}` so the caller can put the reason in a
 * Notice and write nothing.
 */
export async function runProvider(
	provider: ProviderId,
	prompt: string,
	options: RunOptions,
): Promise<ProviderResult> {
	const { command, args } = buildInvocation(provider, prompt);
	const result = await runCommand(command, args, options);

	if (!result.ok) {
		// A provider can also fail with a non-zero exit and put a usable reply on
		// stderr, which some CLIs do for auth problems. Worth one look before
		// declaring failure.
		const recovered = parseSummaryFromStderr(provider, result.stderr);
		if (recovered) return recovered;
		return { ok: false, error: result.error };
	}

	const text = extractOutput(provider, result.stdout);
	if (text === null) {
		return { ok: false, error: `${LABELS[provider]} produced no readable output` };
	}

	return parseSummary(text);
}

/** Some CLIs exit non-zero but put the reply on stderr. Worth one look. */
function parseSummaryFromStderr(provider: ProviderId, error: unknown): ProviderResult | null {
	const stderr = (error as { stderr?: string }).stderr;
	if (!stderr || stderr.trim().length === 0) return null;
	const text = extractOutput(provider, stderr);
	if (text === null) return null;
	return parseSummary(text);
}

/**
 * Whether a provider's binary is on PATH, plus its reported version.
 *
 * Called from the settings tab so the user finds out there rather than by
 * triggering a generation and reading a failure. `--version` exits 0 on all
 * three CLIs and prints a single line.
 */
export function probeProvider(provider: ProviderId): { available: boolean; detail: string } {
	const command = COMMANDS[provider];
	const res = spawnSync(command, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
	if (res.error) {
		const code = (res.error as { code?: string }).code;
		if (code === "ENOENT") {
			return { available: false, detail: `${command} not found on PATH` };
		}
		return { available: false, detail: firstLine(res.error.message) || "could not run it" };
	}
	if (res.status !== 0) {
		return { available: false, detail: firstLine(res.stderr ?? "") || `exited with code ${res.status}` };
	}
	return { available: true, detail: firstLine(res.stdout ?? "") || "installed" };
}

/** Every provider id, for the settings dropdown. */
export const PROVIDER_IDS: readonly ProviderId[] = ["gemini", "codex", "opencode"];

/** Narrow an untrusted string, e.g. one read back from an old data.json. */
export function isProviderId(value: unknown): value is ProviderId {
	return typeof value === "string" && (PROVIDER_IDS as readonly string[]).includes(value);
}
