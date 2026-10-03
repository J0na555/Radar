import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	AI_SUFFIX,
	extractSummaryBody,
	findLegacySummaryNotes,
	isLegacySummaryPath,
	legacyFolders,
	legacySummaryFileName,
	projectNameFromLegacySummary,
	readLegacyHeader,
	recordFromLegacyHeader,
} from "./legacy-notes.ts";

/** A v0.1 summary note, built the way that version wrote it. */
function legacyNote(options: { project?: string; provider?: string; summary?: string; steps?: string[] } = {}): string {
	const summary = options.summary ?? "The plugin scans a folder for repos and ranks them.";
	const steps = options.steps ?? ["Ship the change"];
	return [
		"---",
		`project: ${JSON.stringify(options.project ?? "api-ai")}`,
		`repo_path: ${JSON.stringify("/home/me/projects/api-ai")}`,
		"ai_generated: true",
		`generated_at: ${JSON.stringify("2026-09-01T10:00:00.000Z")}`,
		`commit: ${JSON.stringify("de1b882")}`,
		"dirty: false",
		"dirty_count: 0",
		`provider: ${JSON.stringify(options.provider ?? "codex")}`,
		"---",
		"",
		"> [!warning] Machine-generated. Do not edit.",
		"> This note was written by a language model.",
		"",
		"## api-ai",
		"",
		`Generated 2026-09-01T10:00:00.000Z from Commit \`de1b882\` on branch \`main\`.`,
		"The working tree was clean at this point.",
		"",
		"Source note: [[api-ai]]",
		"",
		"---",
		"",
		"## Summary",
		"",
		summary,
		"",
		"## Suggested next steps",
		"",
		"Proposed by the model, not a to-do list you agreed to.",
		"",
		...steps.map((step) => `- ${step}`),
		"",
	].join("\n");
}

describe("isLegacySummaryPath", () => {
	it("recognises the v0.1 naming", () => {
		assert.equal(isLegacySummaryPath("private/Project Tracker/projects/api-ai.md"), true);
		assert.equal(isLegacySummaryPath("api-ai-ai.md"), true);
		assert.equal(isLegacySummaryPath("API-AI.md"), true);
	});

	it("cannot tell a summary note from a project note, and says so", () => {
		// `api-ai.md` is both the summary note for a repo called `api` and the project note for
		// one called `api-ai`. The suffix narrows it down; only the frontmatter settles it.
		assert.equal(isLegacySummaryPath("Notes/api-ai.md"), true);
	});

	it("ignores everything else", () => {
		assert.equal(isLegacySummaryPath("Notes/ai-api.md"), false);
		assert.equal(isLegacySummaryPath("Notes/api-ai.txt"), false);
		assert.equal(isLegacySummaryPath("Notes/project-ai.md.bak"), false);
	});
});

describe("legacySummaryFileName", () => {
	it("sanitises through the same rules the old note went through", () => {
		assert.equal(legacySummaryFileName("foo/bar"), `foo-bar${AI_SUFFIX}.md`);
		assert.equal(legacySummaryFileName(""), `untitled${AI_SUFFIX}.md`);
	});

	it("round-trips a project whose name already ends in the suffix", () => {
		// `foo-ai` became `foo-ai-ai.md`, which is why stripping one suffix leaves `foo-ai`.
		assert.equal(projectNameFromLegacySummary("foo-ai-ai.md", null), "foo-ai");
	});
});

describe("projectNameFromLegacySummary", () => {
	it("prefers the frontmatter value", () => {
		assert.equal(projectNameFromLegacySummary("renamed.md", "api-ai"), "api-ai");
	});

	it("falls back to the filename when the frontmatter says nothing", () => {
		// A hand-edit that removed the key must not orphan a summary. The fallback is ambiguous
		// on its own, which is why it is only reached for a note that already proved it is ours.
		assert.equal(projectNameFromLegacySummary("Notes/api-ai-ai.md", undefined), "api-ai");
		assert.equal(projectNameFromLegacySummary("Notes/api-ai-ai.md", "   "), "api-ai");
		assert.equal(projectNameFromLegacySummary("Notes/api-ai.md", undefined), "api");
	});

	it("returns null for a name that is only the suffix", () => {
		assert.equal(projectNameFromLegacySummary("Notes/-ai.md", null), null);
	});
});

describe("extractSummaryBody", () => {
	it("takes the prose between the two headings", () => {
		const body = extractSummaryBody(legacyNote());
		assert.equal(body?.summary, "The plugin scans a folder for repos and ranks them.");
		assert.deepEqual(body?.nextSteps, ["Ship the change"]);
	});

	it("keeps interior blank lines, which are paragraph breaks", () => {
		const body = extractSummaryBody(legacyNote({ summary: "First para.\n\nSecond para." }));
		assert.equal(body?.summary, "First para.\n\nSecond para.");
	});

	it("drops the warning callout and the header above the summary", () => {
		// Re-migrating the warning would stack a second one inside the dashboard's own.
		const body = extractSummaryBody(legacyNote());
		assert.doesNotMatch(body?.summary ?? "", /Machine-generated/);
		assert.doesNotMatch(body?.summary ?? "", /Source note/);
	});

	it("works without a next-steps heading", () => {
		const markdown = ["---", "---", "## Summary", "", "Just this."].join("\n");
		assert.deepEqual(extractSummaryBody(markdown), { summary: "Just this.", nextSteps: [] });
	});

	it("returns null when there is no summary heading", () => {
		assert.equal(extractSummaryBody("# Just a note"), null);
		assert.equal(extractSummaryBody(""), null);
	});

	it("returns null when the summary body is empty", () => {
		// An empty callout in the dashboard is noise, and it is a real case: a note whose body
		// somebody emptied by hand.
		const markdown = ["## Summary", "", "", "## Suggested next steps", "", "- x"].join("\n");
		assert.equal(extractSummaryBody(markdown), null);
	});

	it("returns null when the heading is only mentioned, not a heading", () => {
		assert.equal(extractSummaryBody("### Summary\n\nNot this one."), null);
	});

	it("skips a non-bullet line inside the next-steps block rather than guessing", () => {
		const markdown = ["## Summary", "", "Body.", "", "## Suggested next steps", "", "- one", "a stray line", "- two"].join("\n");
		assert.deepEqual(extractSummaryBody(markdown)?.nextSteps, ["one", "two"]);
	});
});

describe("findLegacySummaryNotes", () => {
	it("finds the summaries and names their projects", () => {
		const paths = ["Notes/api-ai-ai.md", "Notes/web-ai-ai.md", "Notes/unrelated.md"];
		const found = findLegacySummaryNotes(paths, (path) =>
			legacyNote({ project: path.includes("web") ? "web-ai" : "api-ai" }),
		);
		assert.deepEqual(
			found.map((note) => [note.projectName, note.path]),
			[
				["api-ai", "Notes/api-ai-ai.md"],
				["web-ai", "Notes/web-ai-ai.md"],
			],
		);
		assert.equal(found[0].header.provider, "codex");
	});

	it("refuses a project note whose name happens to end in the suffix", () => {
		// The case that made the frontmatter check necessary: v0.1 wrote a project note called
		// `api-ai.md` for a repo called `api-ai`, into this same folder.
		const projectNote = ["---", 'project: "api-ai"', 'repo_path: "/x"', "pinned: 1", "---", "", "# api-ai", "", "My notes."].join("\n");
		assert.deepEqual(findLegacySummaryNotes(["Notes/api-ai.md"], () => projectNote), []);
	});

	it("refuses a hand-written note that happens to be named like one", () => {
		assert.deepEqual(findLegacySummaryNotes(["Notes/thing-ai.md"], () => "# my own notes"), []);
	});

	it("skips a note it cannot read rather than treating it as empty", () => {
		// The two would be indistinguishable at the call site, and one would silently migrate as
		// an empty summary.
		const found = findLegacySummaryNotes(["Notes/api-ai-ai.md"], () => null);
		assert.deepEqual(found, []);
	});

	it("keeps the first of two notes claiming one project", () => {
		const first = legacyNote({ project: "api-ai", summary: "The original." });
		const second = legacyNote({ project: "api-ai", summary: "A hand-edited copy." });
		const found = findLegacySummaryNotes(["a/api-ai-ai.md", "b/api-ai-ai.md"], (path) =>
			path.startsWith("a/") ? first : second,
		);
		assert.equal(found.length, 1);
		assert.equal(found[0].body.summary, "The original.");
	});

	it("skips a note with no summary body in it", () => {
		assert.deepEqual(findLegacySummaryNotes(["Notes/api-ai-ai.md"], () => "# only a heading"), []);
	});

	it("reads only what the suffix could mean, and leaves the rest of the vault alone", () => {
		// `Notes/api-ai.md` is read and then refused on its frontmatter. Reading it is the cost of
		// not trusting filenames; not reading anything else is what keeps a 5,000-note vault from
		// being opened file by file on the first scan.
		const projectNote = ["---", 'project: "api-ai"', "---", "", "# api-ai", "", "Mine."].join("\n");
		const read: string[] = [];
		const found = findLegacySummaryNotes(["Notes/api-ai.md", "Notes/api-ai-ai.md", "Notes/web.md"], (path) => {
			read.push(path);
			return path === "Notes/api-ai.md" ? projectNote : legacyNote();
		});
		assert.deepEqual(read, ["Notes/api-ai.md", "Notes/api-ai-ai.md"]);
		assert.deepEqual(
			found.map((note) => note.path),
			["Notes/api-ai-ai.md"],
		);
	});

	it("handles a note whose provider is missing", () => {
		const markdown = legacyNote().replace(/^provider:.*$/m, "");
		assert.equal(findLegacySummaryNotes(["Notes/api-ai-ai.md"], () => markdown)[0].header.provider, null);
	});
});

describe("legacyFolders", () => {
	it("counts per folder, biggest first", () => {
		const paths = [
			"private/Project Tracker/projects/a-ai.md",
			"private/Project Tracker/projects/b-ai.md",
			"Archive/c-ai.md",
			"Notes/not-ours.md",
		];
		assert.deepEqual(legacyFolders(paths), [
			{ folder: "private/Project Tracker/projects", count: 2 },
			{ folder: "Archive", count: 1 },
		]);
	});

	it("returns nothing when there is nothing to report", () => {
		assert.deepEqual(legacyFolders([]), []);
		assert.deepEqual(legacyFolders(["Notes/my-project.md", "Notes/readme.md"]), []);
	});
});
describe("readLegacyHeader", () => {
	it("reads what v0.1 wrote", () => {
		const header = readLegacyHeader(legacyNote());
		assert.deepEqual(header, {
			project: "api-ai",
			provider: "codex",
			generatedAt: "2026-09-01T10:00:00.000Z",
			commit: "de1b882",
			dirtyCount: 0,
			aiGenerated: true,
		});
	});

	it("returns nulls for a file with no frontmatter", () => {
		const header = readLegacyHeader("# A note\n\nNo frontmatter here.");
		assert.equal(header.aiGenerated, false);
		assert.equal(header.project, null);
		assert.equal(header.commit, null);
	});

	it("rejects a commit that is not a sha, so staleness cannot be judged against it", () => {
		// A hand-edited stamp that is not a sha would mark the summary stale forever, or never.
		assert.equal(readLegacyHeader(legacyNote().replace("de1b882", "not-a-commit")).commit, null);
		assert.equal(readLegacyHeader(legacyNote().replace("de1b882", "")).commit, null);
	});

	it("rejects a generation time that is not a date", () => {
		assert.equal(readLegacyHeader(legacyNote().replace("2026-09-01T10:00:00.000Z", "yesterday")).generatedAt, null);
	});

	it("rejects a dirty count that is not a number", () => {
		assert.equal(readLegacyHeader(legacyNote().replace("dirty_count: 0", 'dirty_count: "lots"')).dirtyCount, null);
	});

	it("does not read a key from the body", () => {
		// `---` appears as a horizontal rule mid-document; only the first block is frontmatter.
		const markdown = ["---", "ai_generated: true", "---", "", "## Summary", "", "commit: nope"].join("\n");
		assert.equal(readLegacyHeader(markdown).commit, null);
	});

	it("leaves a bare yaml word alone rather than coercing it", () => {
		// `provider: no` is the string "no" here. A YAML parser would hand back false.
		assert.equal(readLegacyHeader(legacyNote().replace('"codex"', "no")).provider, "no");
	});
});

describe("recordFromLegacyHeader", () => {
	it("carries the freshness across so the panel can judge staleness", () => {
		const record = recordFromLegacyHeader(readLegacyHeader(legacyNote()));
		assert.deepEqual(record, { generatedAt: "2026-09-01T10:00:00.000Z", commit: "de1b882", dirtyCount: 0 });
	});

	it("is null when the note recorded nothing usable", () => {
		// Better than a record of blanks, which would claim a clean tree at a checkable commit.
		assert.equal(recordFromLegacyHeader(readLegacyHeader("# nothing")), null);
		assert.equal(
			recordFromLegacyHeader({
				project: "p",
				provider: null,
				generatedAt: null,
				commit: null,
				dirtyCount: null,
				aiGenerated: true,
			}),
			null,
		);
	});

	it("keeps a partial record rather than dropping all of it", () => {
		const record = recordFromLegacyHeader({
			project: "p",
			provider: null,
			generatedAt: "2026-09-01T10:00:00.000Z",
			commit: null,
			dirtyCount: null,
			aiGenerated: true,
		});
		assert.deepEqual(record, { generatedAt: "2026-09-01T10:00:00.000Z", commit: null, dirtyCount: 0 });
	});
});
