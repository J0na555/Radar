import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compareCandidates, resolveProjectNote } from "./note-link.ts";
import type { NoteCandidate } from "./note-link.ts";

function note(path: string, tracked = false, tracks: string | null = null): NoteCandidate {
	return { path, basename: path.split("/").pop()!.replace(/\.md$/, ""), tracked, tracks };
}

describe("resolveProjectNote", () => {
	it("matches a note named after the project", () => {
		const found = resolveProjectNote("api-ai", [note("Notes/api-ai.md"), note("Other/x.md")]);
		assert.equal(found?.path, "Notes/api-ai.md");
	});

	it("returns null when nothing matches", () => {
		assert.equal(resolveProjectNote("api-ai", [note("Notes/other.md")]), null);
	});

	it("returns null for an empty project name", () => {
		assert.equal(resolveProjectNote("", [note("Notes/x.md")]), null);
		assert.equal(resolveProjectNote("   ", [note("a.md")]), null);
	});

	it("binds a note that names its project in frontmatter, whatever it is called", () => {
		// The form that survives renaming the note, and the only one that works before any note
		// happens to be named after the project.
		const found = resolveProjectNote("api-ai", [note("Notes/sprint-12.md", false, "api-ai")]);
		assert.equal(found?.path, "Notes/sprint-12.md");
	});

	it("prefers a frontmatter claim over a filename match", () => {
		const found = resolveProjectNote("api-ai", [note("api-ai.md"), note("Archive/sprint-12.md", false, "api-ai")]);
		assert.equal(found?.path, "Archive/sprint-12.md");
	});

	it("ignores a claim naming a different project", () => {
		assert.equal(resolveProjectNote("api-ai", [note("Notes/x.md", false, "web-ai")]), null);
	});

	it("prefers a tracked note over an untracked filename match", () => {
		const found = resolveProjectNote("api-ai", [note("api-ai.md"), note("Archive/2023/api-ai.md", true)]);
		assert.equal(found?.path, "Archive/2023/api-ai.md");
	});

	it("prefers the shallowest note when both are untracked", () => {
		const found = resolveProjectNote("api-ai", [note("a/b/c/api-ai.md"), note("api-ai.md")]);
		assert.equal(found?.path, "api-ai.md");
	});

	it("falls back to alphabetical when depth is equal", () => {
		// A link that opens the wrong note once in a while is worse than no link, so the outcome
		// must not depend on directory iteration order.
		assert.equal(resolveProjectNote("api-ai", [note("z/api-ai.md"), note("a/api-ai.md")])?.path, "a/api-ai.md");
	});

	it("is independent of the order candidates arrive in", () => {
		const candidates = [note("z/api-ai.md"), note("a/api-ai.md"), note("m/api-ai.md", true), note("n.md", false, "api-ai")];
		const forward = resolveProjectNote("api-ai", candidates)?.path;
		const reversed = resolveProjectNote("api-ai", [...candidates].reverse())?.path;
		assert.equal(forward, "n.md");
		assert.equal(reversed, forward);
	});

	it("ignores case differences", () => {
		// A project directory and a note filename disagree about case on macOS and Windows
		// without the user doing anything wrong.
		assert.equal(resolveProjectNote("API-AI", [note("Notes/api-ai.md")])?.path, "Notes/api-ai.md");
		assert.equal(resolveProjectNote("api-ai", [note("Notes/X.md", false, "API-AI")])?.path, "Notes/X.md");
	});

	it("matches through the same sanitising a generated note used to go through", () => {
		// `foo/bar` became `foo-bar.md`, so that is the note that has to match.
		assert.equal(resolveProjectNote("foo/bar", [note("Notes/foo-bar.md")])?.path, "Notes/foo-bar.md");
	});

	it("does not match a note whose sanitised name merely looks similar", () => {
		// The accepted risk of a filename fallback: a project called `my-app` will link to
		// somebody's unrelated `my-app.md`. `tracked` overrides it in either form.
		assert.equal(resolveProjectNote("my-app", [note("other/my_app.md")]), null);
		assert.equal(resolveProjectNote("my-app", [note("other/my_app.md", false, "my-app")])?.path, "other/my_app.md");
	});
});

describe("compareCandidates", () => {
	it("puts tracked first, then shallowest, then alphabetical", () => {
		const sorted = [
			note("b/api-ai.md"),
			note("a/deep/api-ai.md"),
			note("a/api-ai.md"),
			note("a/api-ai.md", true),
		].sort(compareCandidates);
		assert.deepEqual(
			sorted.map((candidate) => `${candidate.path}${candidate.tracked ? " (tracked)" : ""}`),
			// Depth is compared before the name, so `b/api-ai.md` sorts ahead of the deeper
			// `a/deep/api-ai.md` even though it sorts later alphabetically.
			["a/api-ai.md (tracked)", "a/api-ai.md", "b/api-ai.md", "a/deep/api-ai.md"],
		);
	});

	it("does not sort on the frontmatter claim", () => {
		// Two notes claiming one project is a tie-break situation, not a ranking one.
		const a = note("a.md", false, "p");
		const b = note("b.md", false, "p");
		assert.ok(compareCandidates(a, b) < 0);
		assert.ok(compareCandidates(b, a) > 0);
	});
});