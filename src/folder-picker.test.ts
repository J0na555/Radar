import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { folderChoices } from "./folder-picker.ts";

describe("folderChoices", () => {
	it("lists the folders that exist, alphabetically", () => {
		const choices = folderChoices("Notes", ["Zebra", "Notes", "Archive/2023"]);
		assert.deepEqual(
			choices.map((choice) => choice.value),
			["Archive/2023", "Notes", "Zebra", ""],
		);
	});

	it("offers the vault root as a real choice", () => {
		// Empty means the root. It is a choice somebody may want to make, not a missing value.
		const root = folderChoices("Notes", ["Notes"]).at(-1);
		assert.deepEqual(root, { value: "", label: "Vault root" });
	});

	it("keeps the current folder listed when it no longer exists", () => {
		// A setting pointing at a folder somebody deleted is a normal state. Omitting it shows the
		// wrong folder as selected, and the next save writes a different one.
		const choices = folderChoices("Old/Place", ["Notes"]);
		assert.equal(choices[0].value, "Old/Place");
		assert.match(choices[0].label, /missing, will be created/);
	});

	it("does not duplicate the current folder when it does exist", () => {
		const values = folderChoices("Notes", ["Notes", "Other"]).map((choice) => choice.value);
		assert.deepEqual(values, ["Notes", "Other", ""]);
	});

	it("normalises what the vault hands it", () => {
		const values = folderChoices("Notes", ["/Notes/", "Notes//sub/"]).map((choice) => choice.value);
		assert.deepEqual(values, ["Notes", "Notes/sub", ""]);
	});

	it("handles a vault with no folders at all", () => {
		assert.deepEqual(folderChoices("", []), [{ value: "", label: "Vault root" }]);
	});

	it("handles the root being chosen as the current value", () => {
		assert.deepEqual(folderChoices("", ["Notes"]).map((c) => c.value), ["Notes", ""]);
	});

	it("does not reshuffle when a folder is added", () => {
		const before = folderChoices("Notes", ["A", "Notes", "Z"]).map((c) => c.value);
		const after = folderChoices("Notes", ["A", "B", "Notes", "Z"]).map((c) => c.value);
		assert.deepEqual(before, ["A", "Notes", "Z", ""]);
		assert.deepEqual(after, ["A", "B", "Notes", "Z", ""]);
	});
});