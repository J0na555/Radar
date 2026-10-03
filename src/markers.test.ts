import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findSection, MARKER_PREFIX, replaceSection, sectionBody } from "./markers.ts";

const START = "<!-- pt:projects:start -->";
const END = "<!-- pt:projects:end -->";

/** A file the plugin has written before, with a user line above and below the section. */
function existing(): string {
	return ["My own heading", "", START, "old row", END, "", "A line I wrote myself.", ""].join("\n");
}

describe("findSection", () => {
	it("finds a well-formed section", () => {
		assert.deepEqual(findSection(["a", START, "body", END, "b"], "projects"), { startLine: 1, endLine: 3 });
	});

	it("accepts an indented marker", () => {
		assert.deepEqual(findSection(["\t" + START, END], "projects"), { startLine: 0, endLine: 1 });
	});

	it("does not treat a marker inside a sentence as a delimiter", () => {
		// A line that merely mentions the marker is prose. Treating it as a delimiter would
		// make the section start mid-sentence and swallow the rest of the line above it.
		assert.equal(findSection([`see ${START} for details`, END], "projects"), null);
	});

	it("ignores a marker of the other section", () => {
		assert.equal(findSection(["<!-- pt:summaries:start -->", "x", "<!-- pt:summaries:end -->"], "projects"), null);
	});

	it("refuses an end marker with no start before it", () => {
		// Everything above an unmatched end marker would be claimed as ours.
		assert.equal(findSection(["a user's whole note", END], "projects"), null);
	});

	it("spans a duplicated pair, first start to last end", () => {
		// Left over from a bug that appended twice. Collapsing the run is what makes the next
		// write converge instead of leaving two sections disagreeing.
		const span = findSection([START, "one", END, "junk", START, "two", END], "projects");
		assert.deepEqual(span, { startLine: 0, endLine: 6 });
	});
});

describe("replaceSection", () => {
	it("leaves everything outside the markers byte for byte", () => {
		const before = existing();
		const after = replaceSection(before, "projects", "new row");
		assert.ok(after.startsWith("My own heading\n\n" + START + "\nnew row\n" + END));
		assert.ok(after.endsWith("\n\nA line I wrote myself.\n"), "the user's trailing text and newline survive");
	});

	it("is stable when run twice", () => {
		const once = replaceSection(existing(), "projects", "new row");
		assert.equal(replaceSection(once, "projects", "new row"), once);
	});

	it("does not accumulate blank lines at the end of the section", () => {
		let doc = "";
		for (let round = 0; round < 5; round++) doc = replaceSection(doc, "projects", "row");
		assert.equal(doc, [START, "row", END].join("\n"));
	});

	it("appends the pair to a note the user wrote, keeping their text", () => {
		const after = replaceSection("# My notes\n\nSomething important.", "projects", "row");
		assert.equal(after, ["# My notes", "", "Something important.", "", START, "row", END].join("\n"));
	});

	it("appends to an empty note without a leading blank line", () => {
		assert.equal(replaceSection("", "projects", "row"), [START, "row", END].join("\n"));
		assert.equal(replaceSection("\n\n", "projects", "row"), [START, "row", END].join("\n"));
	});

	it("collapses a duplicated pair into one on the next write", () => {
		const doubled = [START, "one", END, START, "two", END].join("\n");
		const after = replaceSection(doubled, "projects", "row");
		assert.equal(after, [START, "row", END].join("\n"));
		assert.equal(after.match(/pt:projects/g)?.length, 2);
	});

	it("adds a second section without disturbing the first", () => {
		const withProjects = replaceSection("# mine", "projects", "row");
		const withBoth = replaceSection(withProjects, "summaries", "callout");
		assert.equal(sectionBody(withBoth, "projects"), "row");
		assert.equal(sectionBody(withBoth, "summaries"), "callout");
		assert.ok(withBoth.startsWith("# mine"));
	});

	it("adds a blank line only when the user's text does not already start with one", () => {
		const tight = replaceSection(["user", START, "old", END, "mine"].join("\n"), "projects", "row");
		const loose = replaceSection(["user", START, "old", END, "", "mine"].join("\n"), "projects", "row");
		assert.equal(tight, ["user", START, "row", END, "", "mine"].join("\n"));
		assert.equal(loose, ["user", START, "row", END, "", "mine"].join("\n"));
	});

	it("empties the section when the body is blank", () => {
		const after = replaceSection(existing(), "projects", "");
		assert.equal(sectionBody(after, "projects"), "");
		assert.ok(after.includes(START + "\n" + END));
	});

	it("refuses a body carrying a marker", () => {
		// Model output can contain anything, and an HTML comment in it is indistinguishable from a
		// marker once written. Refusing costs one summary; writing it would corrupt the structure.
		assert.throws(() => replaceSection("", "projects", `row\n${MARKER_PREFIX}fake`), /refusing to write/);
		assert.throws(() => replaceSection("", "summaries", `${MARKER_PREFIX}projects:end -->`), /refusing to write/);
	});

	it("allows the word pt: in ordinary prose", () => {
		const after = replaceSection("", "projects", "the pt: prefix means nothing here");
		assert.equal(sectionBody(after, "projects"), "the pt: prefix means nothing here");
	});
});

describe("sectionBody", () => {
	it("returns what is between the markers", () => {
		assert.equal(sectionBody(["a", START, "one", "two", END, "b"].join("\n"), "projects"), "one\ntwo");
	});

	it("returns null when the section is absent", () => {
		assert.equal(sectionBody("# just a note", "projects"), null);
	});

	it("returns null for an unbalanced section rather than guessing", () => {
		assert.equal(sectionBody(["a", START, "one"].join("\n"), "projects"), null);
	});
});