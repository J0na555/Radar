/**
 * The CLI layer: build an argv, run it with a timeout, and turn whatever comes
 * back into either a summary or a readable error.
 *
 * Imports carry explicit `.ts` extensions and nothing here imports `obsidian`,
 * so `node --test` can exercise this file directly with no bundler and no GUI.
 */
import { spawn, spawnSync } from "child_process";
import type { SpawnSyncReturns } from "child_process";
import { tmpdir } from "os";
import type { ProbeState, ProviderId, ProviderProbe } from "./types.ts";

export type { ProviderProbe, ProbeState };

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

/** Non-empty, trimmed lines. JSONL, and harmless for a single JSON object. */
function nonEmptyLines(value: string): string[] {
	return value
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

/** A trimmed non-empty string, or null. */
function asText(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const text = value.trim();
	return text.length > 0 ? text : null;
}

/**
 * The provider's own error message inside one parsed event, or null.
 *
 * Three shapes are handled, all of them measured rather than guessed:
 *
 * - gemini: `{"error":{"type":"Error","message":"...","code":41}}` on one object.
 * - codex: `{"type":"turn.failed","error":{"message":"..."}}`, and separately
 *   `{"type":"error","message":"..."}`.
 * - opencode: `{"type":"error","error":{"name":"UnknownError","data":{"message":"...","ref":"err_..."}}}`,
 *   where the message sits one level deeper than the others.
 *
 * The message may also hang off a nested item, which is codex's
 * `{"type":"item.completed","item":{"type":"error","message":"..."}}`.
 */
function messageInEvent(event: Record<string, unknown>): string | null {
	const direct = asText(event.message);
	if (direct) return direct;

	// A bare string, e.g. {"error":"quota exceeded"}.
	const stringError = asText(event.error);
	if (stringError) return stringError;

	const error = asRecord(event.error);
	if (error) {
		const directError = asText(error.message);
		if (directError) return directError;
		// opencode: {name, data: {message, ref}}.
		const data = asRecord(error.data);
		const nested = data ? asText(data.message) : null;
		if (nested) return nested;
	}

	const item = asRecord(event.item);
	if (item) {
		const itemMessage = asText(item.message);
		if (itemMessage) return itemMessage;
	}

	return null;
}

/**
 * Drop a retry counter from the front of codex's reconnect messages.
 *
 * codex reports each attempt as `Reconnecting... 3/5 (<the real reason>)`. The
 * reason is what the user can act on and the counter is not, so the counter goes
 * and the reason is kept. Measured on codex 0.141.0, the probe's own 15s limit cuts
 * the turn off mid-retry, so this prefix is the last thing printed and would
 * otherwise be the whole reported failure.
 */
function withoutRetryCounter(message: string): string {
	const match = /^Reconnecting\.{3}\s*\d+\/\d+\s*\(?(.*?)\)?$/.exec(message);
	return match ? match[1].trim() : message;
}

/** Append whatever code or reference the CLI attached, so the message stays traceable. */
function annotate(event: Record<string, unknown>, message: string): string {
	const error = asRecord(event.error);
	if (!error) return message;

	const parts: string[] = [];
	const code = error.code;
	if (typeof code === "number" || (typeof code === "string" && code.trim().length > 0)) {
		parts.push(`code ${String(code).trim()}`);
	}
	const ref = asText(asRecord(error.data)?.ref);
	if (ref) parts.push(ref);

	return parts.length > 0 ? `${message} (${parts.join(", ")})` : message;
}

/**
 * The failure a provider reported in its own output, or null if there is none.
 *
 * `extractOutput` only looks for a success payload, so it is blind to failures:
 * gemini's auth error is a JSON object with an `error` member and no `response`,
 * which came out as "gemini produced no readable output" and hid the one line
 * that said how to fix it. This reads the CLI's own words instead.
 *
 * Three signals are accepted, in the order they were found in real output:
 *
 * - an `error` member on any event (gemini, codex `turn.failed`, opencode).
 * - an event `type` containing "error" or "fail" (codex's `error` events,
 *   `turn.failed`).
 * - an item whose own `type` is an error type (codex's error items).
 *
 * A recognised event type with no message still reports, naming the type, so the
 * user gets the CLI's word for the failure rather than a generic fallback.
 *
 * The **last** match wins. codex emits `error` events for every reconnect
 * attempt before the terminal `turn.failed`, so the first match on a real failure
 * was "Reconnecting... 2/5" rather than the 404 that caused it.
 */
export function extractProviderError(provider: ProviderId, stdout: string): string | null {
	// Line by line first: every CLI that streams reports one JSON object per line,
	// and only this reading can tell codex's reconnect chatter from the terminal
	// failure that follows it.
	const perLine = errorFromEvents(stdout, provider);
	if (perLine) return perLine;

	// Then the whole text as one object. gemini's `-o json` error is pretty-printed
	// across several lines, not JSONL, so no single line of it parses; measured on
	// gemini 0.42.0 the auth failure came back as a multi-line object on stderr and
	// was therefore invisible to a line-only reader.
	const whole = asRecord(tryJson(stdout.trim()));
	return whole ? errorFromEvent(whole, provider) : null;
}

/** The last error-shaped event in JSONL text, or null. */
function errorFromEvents(text: string, provider: ProviderId): string | null {
	let found: string | null = null;

	for (const line of nonEmptyLines(text)) {
		const event = asRecord(tryJson(line));
		if (!event) continue;
		const match = errorFromEvent(event, provider);
		if (match !== null) found = match;
	}

	return found;
}

/** One event's error message, or null if this event does not report a failure. */
function errorFromEvent(event: Record<string, unknown>, provider: ProviderId): string | null {
	const label = LABELS[provider];
	const type = typeof event.type === "string" ? event.type.toLowerCase() : "";
	const itemType = asText(asRecord(event.item)?.type)?.toLowerCase() ?? "";
	const isErrorEvent = type.includes("error") || type.includes("fail") || itemType.includes("error");
	const hasErrorMember = "error" in event;

	const message = messageInEvent(event);
	if (message !== null && (isErrorEvent || hasErrorMember)) {
		return annotate(event, withoutRetryCounter(message));
	}
	if (isErrorEvent && hasErrorMember) {
		// An error event whose payload held no message, e.g. `{"type":"error",
		// "error":{}}`. Report the type rather than nothing.
		return `${label} reported "${type}" with no message in it`;
	}
	return null;
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
 * caller can put it in a Notice. Both streams are returned on failure as well as
 * stdout on success, because that is where the reason lives: codex prints its
 * whole failing turn, including the 404 that caused it, to stdout and then exits
 * 1, so discarding stdout on a non-zero exit discards the diagnosis.
 */
export async function runCommand(
	command: string,
	args: string[],
	options: RunOptions,
): Promise<
	| { ok: true; stdout: string }
	| { ok: false; error: string; stdout: string; stderr: string }
> {
	const run = await runGenerationProcess(command, args, options);

	if (!run.timedOut && run.spawnCode === undefined && run.status === 0) {
		return { ok: true, stdout: run.stdout };
	}

	// `describeFailure` reads the shape it has always read, so a killed or
	// non-zero run still produces the same wording it did under execFile.
	const error = describeFailure(command, {
		code: run.spawnCode ?? run.status,
		killed: run.timedOut,
		signal: run.signal,
		stdout: run.stdout,
		stderr: run.stderr,
		message: run.spawnMessage,
	});

	return { ok: false, error, stdout: run.stdout, stderr: run.stderr };
}

/**
 * Spawn one generation and collect both streams, killing it at the limit.
 *
 * `spawn` rather than `execFile`, for one measured reason: `execFile` cannot
 * leave stdin alone. It always hands the child a pipe that nothing writes to and
 * never closes, and opencode blocks on it: measured, the identical command
 * returned in 15.4s from a shell, 13-20s under `spawn` with stdin ignored, and
 * never at all under `execFile`, where it was killed at the limit every time.
 * codex is explicit about the same thing ("Reading additional input from
 * stdin..."). Everything else about the call is unchanged, argv array and no
 * shell either way.
 */
function runGenerationProcess(
	command: string,
	args: string[],
	options: RunOptions,
): Promise<ProbeRun> {
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let spawnCode: string | undefined;
		let spawnMessage: string | undefined;
		let settled = false;

		const finish = (status: number | null, signal: NodeJS.Signals | null): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearTimeout(pipeTimer);
			child.stdout?.destroy();
			child.stderr?.destroy();
			resolve({ stdout, stderr, status, signal, timedOut, spawnCode, spawnMessage });
		};

		let pipeTimer: NodeJS.Timeout = setTimeout(() => undefined, 0);
		const settleExit = (status: number | null, signal: NodeJS.Signals | null): void => {
			pipeTimer = setTimeout(() => finish(status, signal), PIPE_GRACE_MS);
		};

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, options.timeoutMs);

		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			// The same runaway agent that would exhaust memory under `maxBuffer` still
			// gets stopped here, since nothing bounds `spawn` output. Truncated output
			// is worth far less than a killed process, and the parse will say so.
			if (stdout.length < MAX_BUFFER) stdout += chunk;
		});
		child.stderr?.on("data", (chunk: string) => {
			if (stderr.length < MAX_BUFFER) stderr += chunk;
		});

		child.on("error", (error: NodeJS.ErrnoException) => {
			spawnCode = error.code;
			spawnMessage = error.message;
			finish(null, null);
		});

		child.on("exit", settleExit);
		child.on("close", finish);
	});
}

/**
 * Run one provider and parse the result.
 *
 * Never throws. A missing binary, a crash, a hang, a CLI that reports its own
 * failure, and a reply in the wrong shape all come back as `{ok: false, error}`
 * so the caller can put the reason in a Notice and write nothing.
 */
export async function runProvider(
	provider: ProviderId,
	prompt: string,
	options: RunOptions,
): Promise<ProviderResult> {
	const { command, args } = buildInvocation(provider, prompt);
	const result = await runCommand(command, args, options);

	if (!result.ok) {
		// A CLI can also fail by exit status while still having produced something.
		// Exit status is the least reliable signal these three give: measured here,
		// gemini 0.42.0 exits 41 with stdout empty and the auth JSON on stderr, and
		// codex 0.141.0 exits 1 with a whole failing turn on stdout whose
		// `turn.failed` event names a model the account cannot use. codex also
		// exits 1 on a turn that produced a good answer after reconnecting.
		//
		// So the order is: a usable reply, then the CLI's own error, then the exit
		// status. A reply still has to survive `parseSummary`, so a partial answer
		// cannot quietly become a summary.
		const recovered = parseSummaryFromFailure(provider, result.stdout, result.stderr);
		if (recovered) return recovered;

		const reported =
			extractProviderError(provider, result.stderr) ?? extractProviderError(provider, result.stdout);
		if (reported) return { ok: false, error: reported };

		return { ok: false, error: result.error };
	}

	// Consult the CLI's reported error before the reply, because the two are not
	// alternatives: a run can print an error object and no usable reply, which is
	// gemini's exit-0 auth failure. `extractOutput` cannot see that, and would
	// otherwise report "produced no readable output".
	const reported = extractProviderError(provider, result.stdout);
	const text = extractOutput(provider, result.stdout);

	if (text === null) {
		if (reported) return { ok: false, error: reported };
		return { ok: false, error: `${LABELS[provider]} produced no readable output` };
	}

	// A reply exists, so the run worked. codex emits `error` events while it
	// reconnects mid-turn and can still finish, and those must not fail a good
	// reply. The reported error is therefore only fatal when there is nothing to
	// parse.
	return parseSummary(text);
}

/**
 * Some CLIs exit non-zero but still print the reply. Worth one look.
 *
 * stderr first, then stdout. gemini's convention when it does this at all is
 * stderr; codex's is stdout.
 */
function parseSummaryFromFailure(
	provider: ProviderId,
	stdout: string,
	stderr: string,
): ProviderResult | null {
	for (const stream of [stderr, stdout]) {
		if (typeof stream !== "string" || stream.trim().length === 0) continue;
		const text = extractOutput(provider, stream);
		if (text === null) continue;
		return parseSummary(text);
	}
	return null;
}

/**
 * Whether a provider's binary is on PATH, plus its reported version.
 *
 * Called from the settings tab so the user finds out there rather than by
 * triggering a generation and reading a failure. `--version` exits 0 on all
 * three CLIs and prints a single line.
 *
 * This answers "is it installed", and nothing more. On this machine gemini 0.42.0
 * is installed and passes this check while being completely unusable, so it is
 * kept only as the absent/installed distinction and never used to decide which
 * CLI to generate with. Use `probeCapability` for that.
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

/**
 * Fixed prompt for the capability probe.
 *
 * Deliberately not a real question. The probe only has to prove the CLI can
 * complete one call and return something parseable, so this asks for a two-key
 * JSON object, which is the cheapest answer any of the three can produce and
 * which a broken or half-authenticated CLI cannot fake.
 */
export const PROBE_PROMPT = 'Reply with only this JSON and nothing else: {"ok":true}';

/**
 * Wall-clock limit for one probe.
 *
 * Measured on this machine, three times each: gemini's auth failure returns in
 * about 6s, opencode's success in 14.2-16.0s, and codex does not settle inside a
 * minute at all, printing its first 404 at 9.6s and its terminal `turn.failed` at
 * 69.5s.
 *
 * 30s is set by the two things that have to fit. opencode is the one that must
 * finish, and 15s was measured cutting it off, which filed the only working
 * provider as broken and left the plugin with no provider at all; 16s of
 * observed maximum leaves real headroom. codex's full turn does not fit in any
 * limit worth blocking a user for, so the probe reads its partial output instead:
 * the 404 is in the first 10s, and `judgeProbe` prefers that reported error over
 * the timeout verdict, so the cutoff costs nothing but the last line.
 */
export const PROBE_TIMEOUT_MS = 30_000;

/**
 * How long to keep reading a killed probe's pipes before settling anyway.
 *
 * Long enough for a normal process's buffered output to arrive after its `exit`,
 * short enough that an orphaned grandchild holding stdout cannot stretch a probe's
 * cost past the limit by much. Measured: without it, a stub whose child inherited
 * the pipe held an 800ms probe for the full 30s of that child.
 */
const PIPE_GRACE_MS = 250;

/**
 * Argv for one capability probe.
 *
 * The same shape as `buildArgv`, with one addition. The probe runs from a
 * scratch directory rather than a repository, and codex refuses to start outside
 * a trusted directory: measured on codex 0.141.0, it exits 1 with "Not inside a
 * trusted directory and --skip-git-repo-check was not specified." So the probe
 * adds that flag while generation, which runs inside a real repo, does not need it.
 */
export function buildProbeArgv(provider: ProviderId, prompt: string = PROBE_PROMPT): string[] {
	const argv = buildArgv(provider, prompt);
	if (provider === "codex") argv.push("--skip-git-repo-check");
	return argv;
}

/** Options for one probe pass. */
export interface ProbeOptions {
	/** Working directory. Defaults to the OS temp dir, never a user repo. */
	cwd?: string;
	/** Per-provider wall-clock limit. Defaults to `PROBE_TIMEOUT_MS`. */
	timeoutMs?: number;
	/** Clock, injectable so tests can assert on the timestamp. */
	now?: () => number;
}

/**
 * Does this CLI actually produce an answer?
 *
 * The check is capability, not preference, and specifically not `--version`:
 * gemini passes `--version` with exit 0 while being unable to authenticate, which
 * is the exact trap that left a first-run user with a failure nobody could
 * diagnose. So this runs the cheapest real call and judges the result.
 *
 * Success means a usable reply came back. Exit status is not the test, because
 * the three CLIs disagree about it: gemini's auth failure has been seen with both
 * exit 0 and exit 41 across versions, and codex reports its own failure on stdout
 * while exiting 1.
 *
 * Three states, because "installed" and "usable" are different facts and merging
 * them is what hid this bug:
 *
 * - `absent`: not on PATH.
 * - `broken`: present and running, but no usable answer. Carries the CLI's own
 *   error message when it gave one, which is usually the fix.
 * - `works`: a reply parsed.
 *
 * Runs with `spawnSync` and an argv array, never a shell string, and with stdin
 * ignored so a CLI that reads a prompt from stdin cannot block on a pipe that
 * nobody writes to.
 */
export function probeCapability(provider: ProviderId, options: ProbeOptions = {}): ProviderProbe {
	const res = spawnSync(COMMANDS[provider], buildProbeArgv(provider), {
		cwd: options.cwd ?? tmpdir(),
		encoding: "utf8",
		windowsHide: true,
		timeout: options.timeoutMs ?? PROBE_TIMEOUT_MS,
		// stdin ignored, stdout and stderr captured. codex announces "Reading
		// additional input from stdin..." and would otherwise wait on an open pipe.
		stdio: ["ignore", "pipe", "pipe"],
	});

	return judgeProbe(provider, flattenSync(res), options);
}

/** Flatten `spawnSync`'s result into the shared `ProbeRun` shape. */
function flattenSync(res: SpawnSyncReturns<string>): ProbeRun {
	const spawnCode = res.error ? (res.error as NodeJS.ErrnoException).code : undefined;
	return {
		stdout: res.stdout ?? "",
		stderr: res.stderr ?? "",
		status: res.status,
		// spawnSync signals its own timeout as ETIMEDOUT, and a CLI that leaves a
		// worker holding the pipe reports `status: 0` alongside it, so the status
		// alone cannot tell a timeout from a normal exit.
		timedOut: spawnCode === "ETIMEDOUT" || res.status === null,
		spawnCode,
		spawnMessage: res.error?.message,
	};
}

/**
 * What a finished probe process produced, in the shape both spawn paths report.
 *
 * `spawnSync` and the async wrapper in `probeCapabilityAsync` return different
 * shapes, so this flattens both into one thing for `judgeProbe` to read. That is
 * what lets the synchronous form stay: `node --test` drives real short-lived
 * processes through it, while the plugin uses the async one.
 */
interface ProbeRun {
	stdout: string;
	stderr: string;
	/** Exit status, or null when the process never produced one. */
	status: number | null;
	/** Signal that ended it, when a signal did. */
	signal?: NodeJS.Signals | null;
	/** Whether the timeout killed it. A forking CLI can exit 0 *and* time out. */
	timedOut: boolean;
	/** OS-level spawn failure code, e.g. ENOENT. Absent on a normal run. */
	spawnCode?: string;
	/** The spawn failure's own message, for the detail line. */
	spawnMessage?: string;
}

/**
 * Decide whether a probe answered.
 *
 * All of the verdict lives here, shared by both spawn paths, so the ordering of
 * the checks below is written down once and cannot drift between them.
 *
 * Order matters, and it is not the order the failures arrive in.
 *
 * ENOENT comes first and alone, because it is the only spawn error that means
 * "not installed": everything else is a CLI that is present and failed, and
 * calling a hang or a permission failure `absent` sends the user off to install
 * something they already have.
 *
 * The CLI's own reported error comes next, before the timeout verdict, because
 * the timeout is often only a symptom: measured on codex 0.141.0, a 404 for its
 * default model produced reconnect events and then a kill at the limit, and
 * "did not answer within Ns" would hide the 404 that is the actual fix. Partial
 * output from a killed process is read for the same reason.
 *
 * Exit status is consulted last of all, so a CLI that answers and exits non-zero
 * is judged on its answer rather than on codex's habit of exiting 1 after a turn
 * it finished.
 */
function judgeProbe(provider: ProviderId, res: ProbeRun, options: ProbeOptions): ProviderProbe {
	const command = COMMANDS[provider];
	const checkedAt = (options.now ?? Date.now)();
	const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;

	if (res.spawnCode === "ENOENT") {
		return { provider, state: "absent", detail: `${command} not found on PATH`, checkedAt };
	}

	const reported =
		extractProviderError(provider, res.stdout) ?? extractProviderError(provider, res.stderr);
	if (reported) {
		return { provider, state: "broken", detail: reported, checkedAt };
	}

	if (res.timedOut) {
		return {
			provider,
			state: "broken",
			detail: `${command} did not answer within ${Math.round(timeoutMs / 1000)}s`,
			checkedAt,
		};
	}

	if (res.spawnCode !== undefined) {
		// Some other spawn failure: the binary is there and cannot be run. The
		// message carries the real reason, e.g. EACCES on a non-executable file.
		return {
			provider,
			state: "absent",
			detail: firstLine(res.spawnMessage ?? "") || "could not run it",
			checkedAt,
		};
	}

	if (extractOutput(provider, res.stdout) !== null) {
		return { provider, state: "works", detail: "answered a test call", checkedAt };
	}

	const fallback =
		firstLine(res.stderr) ||
		firstLine(res.stdout) ||
		`exited with code ${res.status} and no usable output`;
	return { provider, state: "broken", detail: `${command}: ${fallback}`, checkedAt };
}

/**
 * The async probe, used by the plugin.
 *
 * Same verdict as `probeCapability`, spawned without blocking. This is the form
 * the plugin needs because Obsidian runs plugin code on its main thread: three
 * sequential blocking probes measured 37-43s of an entirely frozen UI, and the
 * only way to avoid that is to not block.
 */
export async function probeCapabilityAsync(
	provider: ProviderId,
	options: ProbeOptions = {},
): Promise<ProviderProbe> {
	const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
	const run = await runProbeProcess(COMMANDS[provider], buildProbeArgv(provider), {
		cwd: options.cwd ?? tmpdir(),
		timeoutMs,
	});
	return judgeProbe(provider, run, options);
}

/**
 * Spawn one probe process and collect what it printed, killing it at the limit.
 *
 * Never rejects. A failed spawn is data, in the same `ProbeRun` shape a finished
 * one takes, because every reason a CLI can fail is something the settings tab
 * has to display rather than something to throw.
 */
function runProbeProcess(
	command: string,
	args: string[],
	options: { cwd: string; timeoutMs: number },
): Promise<ProbeRun> {
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			windowsHide: true,
			// stdin ignored, stdout and stderr captured. codex announces "Reading
			// additional input from stdin..." and would otherwise wait on an open pipe.
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let spawnCode: string | undefined;
		let spawnMessage: string | undefined;
		let settled = false;

		const finish = (status: number | null): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearTimeout(pipeTimer);
			// Detach the pipes. A grandchild that inherited stdout holds the stream
			// open, and an attached stream keeps a libuv handle referenced, so the host
			// process cannot exit until every orphan does. Measured: the probe suite ran
			// 5.4s of tests and then held the process open for 32s waiting on `sleep`
			// children nobody had killed. Destroying the streams ends that wait; the
			// child is already gone, so nothing that mattered is lost.
			child.stdout?.destroy();
			child.stderr?.destroy();
			resolve({
				stdout,
				stderr,
				status,
				// A CLI that forks a worker can exit 0 and still have been cut off at
				// the limit, which is what codex 0.141.0 does. So the timeout flag is
				// not derived from the status.
				timedOut,
				spawnCode,
				spawnMessage,
			});
		};

		// Killing the process is not enough to close its pipes. A grandchild that
		// inherited stdout keeps the pipe open after the direct child dies, and
		// `close` waits for the pipe: a stub running `sleep 30` under a killed `sh`
		// held the probe for the full 30s after an 800ms limit. Measured. So the
		// direct child's `exit` is what settles the result, and `close` only gets a
		// short grace period to deliver whatever is still buffered. The child has
		// already been SIGKILLed at that point, so nothing is being cut short.
		let pipeTimer: NodeJS.Timeout = setTimeout(() => undefined, 0);
		const settleExit = (status: number | null): void => {
			pipeTimer = setTimeout(() => finish(status), PIPE_GRACE_MS);
		};

		const timer = setTimeout(() => {
			timedOut = true;
			// SIGKILL, not SIGTERM. A CLI that traps SIGTERM and keeps running would
			// hold the pipe open past the limit, which is exactly the freeze this
			// grace period exists to bound.
			child.kill("SIGKILL");
		}, options.timeoutMs);

		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
		});

		child.on("error", (error: NodeJS.ErrnoException) => {
			spawnCode = error.code;
			spawnMessage = error.message;
			finish(null);
		});

		child.on("exit", (status) => settleExit(status));
		child.on("close", (status) => finish(status));
	});
}

/**
 * Probe every provider, in the fixed preference order.
 *
 * Synchronous, for tests and for callers that genuinely want to block. The plugin
 * uses `detectProvidersAsync`.
 */
export function detectProviders(options: ProbeOptions = {}): ProviderProbe[] {
	return PROVIDER_IDS.map((provider) => probeCapability(provider, options));
}

/**
 * Probe every provider concurrently, without blocking.
 *
 * Concurrent because sequential blocking probes froze the Obsidian main thread
 * for 37-43s, measured, and because nothing needs the answers in order:
 * `selectProvider` applies the preference order afterwards, to whatever came back.
 * The three runtimes do not add up: the total is the slowest one, measured 15s.
 *
 * Results come back in `PROVIDER_IDS` order regardless of which finished first, so
 * the cached list and its display order are stable between runs.
 */
export async function detectProvidersAsync(
	options: ProbeOptions = {},
): Promise<ProviderProbe[]> {
	const probes = await Promise.all(
		PROVIDER_IDS.map((provider) => probeCapabilityAsync(provider, options)),
	);
	return PROVIDER_IDS.map((provider) => probes.find((probe) => probe.provider === provider)!);
}

/**
 * Which CLI to generate with.
 *
 * A manual choice is an override and is honoured even when that provider probes
 * as broken: silently switching away from a CLI the user picked is how the
 * plugin stops being predictable. The settings tab shows the broken state instead,
 * so the choice stays visible rather than being quietly corrected.
 *
 * With no manual choice, the first provider in the fixed `PROVIDER_IDS` order that
 * actually works. Fixed rather than by recency, because "which one answered last"
 * is not a fact worth persisting.
 */
export function selectProvider(
	manual: ProviderId | null,
	probes: readonly ProviderProbe[],
): ProviderId | null {
	if (isProviderId(manual)) return manual;
	const probeFor = new Map(probes.map((probe) => [probe.provider, probe]));
	for (const provider of PROVIDER_IDS) {
		if (probeFor.get(provider)?.state === "works") return provider;
	}
	return null;
}

/**
 * Read cached probe results back out of `data.json`, dropping anything invalid.
 *
 * The cache is a hand-editable file and survives across builds, so it is treated
 * as untrusted input: a state that is not one of the three, a missing timestamp,
 * or an unknown provider id all get discarded rather than shown to the user as a
 * result. A cache that fails to parse yields no probes at all, which reads as
 * "not probed yet" and gets re-probed.
 */
export function sanitizeProbes(raw: unknown): ProviderProbe[] {
	if (!Array.isArray(raw)) return [];

	const out: ProviderProbe[] = [];
	for (const entry of raw) {
		const record = asRecord(entry);
		if (!record) continue;
		if (!isProviderId(record.provider)) continue;
		if (record.state !== "works" && record.state !== "broken" && record.state !== "absent") continue;
		const detail = asText(record.detail);
		if (!detail) continue;
		const at = typeof record.checkedAt === "number" && Number.isFinite(record.checkedAt) ? record.checkedAt : 0;
		out.push({ provider: record.provider, state: record.state, detail, checkedAt: at });
	}

	return out;
}

/** Every provider id, for the settings dropdown. */
export const PROVIDER_IDS: readonly ProviderId[] = ["gemini", "codex", "opencode"];

/** Narrow an untrusted string, e.g. one read back from an old data.json. */
export function isProviderId(value: unknown): value is ProviderId {
	return typeof value === "string" && (PROVIDER_IDS as readonly string[]).includes(value);
}
