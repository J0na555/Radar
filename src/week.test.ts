import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { replaceSection, sectionBody } from "./markers.ts";
import {
	assertSafeWeeklyTarget,
	isoWeekKey,
	isWeeklyNotePath,
	renderWeeklySection,
	weekEndKey,
	weekStartKey,
	WEEKLY_SUBFOLDER,
	weeklyFolder,
	weeklyPath,
} from "./week.ts";
import type { PluginSettings, Project, RepoFacts } from "./types.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Local noon on a day, so the test does not depend on the machine's timezone offset. */
function at(year: number, month: number, day: number): number {
	return new Date(year, month - 1, day, 12, 0, 0).getTime();
}

/** Sunday 2026-10-18, the mid-year date with a known week. */
const NOW = at(2026, 10, 18);

/**
 * The repo path a project with this name gets.
 *
 * The commit map is keyed by path rather than name, because two repos can share a directory
 * name. The fixtures below read by name and translate here, so they cannot quietly drift back
 * to the name-keyed lookups the renderer no longer does.
 */
function pathFor(name: string): string {
	return `/home/me/projects/${name}`;
}

function settings(notesFolder = "Gitdeck"): PluginSettings {
	return { notesFolder } as PluginSettings;
}

function facts(overrides: Partial<RepoFacts> = {}): RepoFacts {
	const name = overrides.name ?? "api-ai";
	return {
		name,
		// Derived from the name so a test that renames a project cannot leave its path behind and
		// hide a lookup that missed.
		path: overrides.path ?? pathFor(name),
		root: "/home/me/projects",
		gitReadable: true,
		remote: null,
		github: null,
		branch: "main",
		defaultBranch: "main",
		onNonDefaultBranch: false,
		lastCommit: new Date(NOW - 2 * DAY_MS).toISOString(),
		dirtyCount: 0,
		stashCount: 0,
		unpushedCount: 0,
		dirMtime: NOW,
		...overrides,
	};
}

function project(overrides: Partial<Project> = {}, factOverrides: Partial<RepoFacts> = {}): Project {
	return {
		facts: facts(factOverrides),
		score: { score: 62, status: "active", parts: [] } as Project["score"],
		pin: 0,
		health: [],
		...overrides,
	} as Project;
}

/**
 * A commit-count map as the renderer reads it: keyed by repo path. The entries are written by
 * project name because that is what each test is about, and translated here so the fixtures
 * cannot assert the old name-keyed lookups.
 */
function commits(entries: Record<string, number>): Map<string, number> {
	return new Map(Object.entries(entries).map(([name, count]) => [pathFor(name), count]));
}

/** One rendered row split into cells the way the table parser splits it. */
function cells(row: string): string[] {
	const inner = row.startsWith("|") && row.endsWith("|") ? row.slice(1, -1) : row;
	return inner
		.split(/(?<!\\)\|/)
		.map((value) => value.trim().replace(/\\\|/g, "|"));
}

describe("isoWeekKey", () => {
	// ISO week-years are not calendar years. Every case here is a hand-checked boundary from
	// the ISO 8601 rules: a week belongs to the year that holds its Thursday.
	it("puts a Thursday January 1st in week 1 of the new year", () => {
		assert.equal(isoWeekKey(at(2026, 1, 1)), "2026-W01");
	});

	it("puts a Friday January 1st in the last week of the previous year", () => {
		assert.equal(isoWeekKey(at(2021, 1, 1)), "2020-W53");
	});

	it("puts the last day of 2020 in 2020-W53", () => {
		assert.equal(isoWeekKey(at(2020, 12, 31)), "2020-W53");
	});

	it("puts a Monday December 30th 2019 in week 1 of 2020", () => {
		assert.equal(isoWeekKey(at(2019, 12, 30)), "2020-W01");
	});

	it("puts a Friday January 1st 2027 in 2026-W53", () => {
		assert.equal(isoWeekKey(at(2027, 1, 1)), "2026-W53");
	});

	it("reads a mid-year date", () => {
		assert.equal(isoWeekKey(NOW), "2026-W42");
	});

	it("zero-pads the week", () => {
		assert.equal(isoWeekKey(at(2026, 1, 5)), "2026-W02");
	});
});

describe("weekStartKey and weekEndKey", () => {
	it("returns the Monday and Sunday of the week containing the mid-year date", () => {
		assert.equal(weekStartKey(NOW), "2026-10-12");
		assert.equal(weekEndKey(NOW), "2026-10-18");
	});

	it("keeps a Sunday in the week that started the preceding Monday", () => {
		assert.equal(weekStartKey(at(2026, 10, 18)), "2026-10-12");
		assert.equal(weekEndKey(at(2026, 10, 18)), "2026-10-18");
	});

	it("spans the year boundary from a Thursday January 1st", () => {
		assert.equal(weekStartKey(at(2026, 1, 1)), "2025-12-29");
		assert.equal(weekEndKey(at(2026, 1, 1)), "2026-01-04");
	});

	it("puts a Friday January 1st 2021 in the previous year's last full week", () => {
		assert.equal(weekStartKey(at(2021, 1, 1)), "2020-12-28");
		assert.equal(weekEndKey(at(2021, 1, 1)), "2021-01-03");
	});

	it("starts week 1 of 2020 on Monday December 30th 2019", () => {
		assert.equal(weekStartKey(at(2019, 12, 30)), "2019-12-30");
		assert.equal(weekEndKey(at(2019, 12, 30)), "2020-01-05");
	});

	it("rolls a late-December Friday into the next year's week 53", () => {
		assert.equal(weekStartKey(at(2027, 1, 1)), "2026-12-28");
		assert.equal(weekEndKey(at(2027, 1, 1)), "2027-01-03");
	});

	it("keeps a Sunday January 4th in the week that began in December", () => {
		assert.equal(weekStartKey(at(2026, 1, 4)), "2025-12-29");
		assert.equal(weekEndKey(at(2026, 1, 4)), "2026-01-04");
	});
});

describe("weeklyFolder and weeklyPath", () => {
	it("names the subfolder", () => {
		assert.equal(WEEKLY_SUBFOLDER, "Weekly");
	});

	it("puts the folder under the dashboard folder", () => {
		assert.equal(weeklyFolder(settings("Gitdeck")), "Gitdeck/Weekly");
	});

	it("uses the vault root for an empty notes folder", () => {
		assert.equal(weeklyFolder(settings("")), "Weekly");
	});

	it("normalises the join", () => {
		assert.equal(weeklyFolder(settings("/Gitdeck/")), "Gitdeck/Weekly");
	});

	it("names the file after the ISO week", () => {
		assert.equal(weeklyPath(settings("Gitdeck"), NOW), "Gitdeck/Weekly/2026-W42.md");
		assert.equal(weeklyPath(settings(""), NOW), "Weekly/2026-W42.md");
	});
});

describe("assertSafeWeeklyTarget", () => {
	it("accepts this week's note", () => {
		assert.doesNotThrow(() => assertSafeWeeklyTarget(settings(), "Gitdeck/Weekly/2026-W42.md", NOW));
	});

	it("accepts the root when the notes folder is empty", () => {
		assert.doesNotThrow(() => assertSafeWeeklyTarget(settings(""), "Weekly/2026-W42.md", NOW));
	});

	it("refuses the dashboard", () => {
		assert.throws(() => assertSafeWeeklyTarget(settings(), "Gitdeck/Dashboard.md", NOW), /the weekly note is/);
	});

	// The `.md` and inside-the-folder checks after the path comparison cannot fire for a caller
	// that passes the path derived from this same `now`: the expected path already ends in `.md`
	// and already sits in the folder. They are defence-in-depth for a hand-built target, so these
	// two cases can only reach the path-mismatch refusal. Do not delete the branches: they are
	// what stops a future caller that skips the comparison.
	it("refuses a note elsewhere in the vault, as a path mismatch", () => {
		assert.throws(() => assertSafeWeeklyTarget(settings(), "Notes/2026-W42.md", NOW), /the weekly note is/);
	});

	it("refuses a non-markdown target, as a path mismatch", () => {
		assert.throws(() => assertSafeWeeklyTarget(settings(), "Gitdeck/Weekly/2026-W42.txt", NOW), /the weekly note is/);
	});

	it("refuses another week's note", () => {
		const otherWeek = weeklyPath(settings(), at(2026, 10, 25));
		assert.throws(() => assertSafeWeeklyTarget(settings(), otherWeek, NOW), /the weekly note is/);
	});

	it("refuses the right path for a different moment", () => {
		// A scan that straddles the week boundary must not validate one week's file against
		// another moment's expectation, and this is that mismatch made loud.
		assert.throws(
			() => assertSafeWeeklyTarget(settings(), "Gitdeck/Weekly/2026-W42.md", at(2026, 10, 25)),
			/the weekly note is/,
		);
	});
});

describe("isWeeklyNotePath", () => {
	// This is the predicate that decides whether a note in the vault is hidden from the
	// project-note candidates. Hiding too little leaves a dead link; hiding too much loses a
	// link the user wrote. The cases below pin both directions.

	it("recognises the file the writer would create", () => {
		assert.equal(isWeeklyNotePath(settings("Gitdeck"), weeklyPath(settings("Gitdeck"), NOW)), true);
	});

	it("recognises a week file at the vault root", () => {
		assert.equal(isWeeklyNotePath(settings(""), "Weekly/2026-W42.md"), true);
	});

	it("recognises the first and last weeks of a year", () => {
		assert.equal(isWeeklyNotePath(settings(), "Gitdeck/Weekly/2026-W01.md"), true);
		assert.equal(isWeeklyNotePath(settings(), "Gitdeck/Weekly/2020-W53.md"), true);
	});

	it("leaves a user note in the same folder alone", () => {
		assert.equal(isWeeklyNotePath(settings(), "Gitdeck/Weekly/Notes.md"), false);
		assert.equal(isWeeklyNotePath(settings(), "Gitdeck/Weekly/2026-plan.md"), false);
		assert.equal(isWeeklyNotePath(settings(), "Gitdeck/Weekly/Planner.md"), false);
	});

	it("leaves a nested file alone", () => {
		assert.equal(isWeeklyNotePath(settings(), "Gitdeck/Weekly/archive/2026-W42.md"), false);
	});

	it("leaves a week-shaped name outside the folder alone", () => {
		assert.equal(isWeeklyNotePath(settings(), "Notes/2026-W42.md"), false);
		assert.equal(isWeeklyNotePath(settings(), "2026-W42.md"), false);
	});

	it("does not mistake a lookalike folder for the weekly folder", () => {
		assert.equal(isWeeklyNotePath(settings(), "Gitdeck/Weekly-archive/2026-W42.md"), false);
	});

	it("leaves a name that is not a real week alone", () => {
		// The writer can never emit these, so they belong to whoever made them.
		assert.equal(isWeeklyNotePath(settings(), "Gitdeck/Weekly/2026-W99.md"), false);
		assert.equal(isWeeklyNotePath(settings(), "Gitdeck/Weekly/2026-W00.md"), false);
		assert.equal(isWeeklyNotePath(settings(), "Gitdeck/Weekly/2026-W4.md"), false);
		assert.equal(isWeeklyNotePath(settings(), "Gitdeck/Weekly/2026-W42.md.bak"), false);
	});

	it("still recognises the file when the extension case differs", () => {
		// The writer only emits lowercase, but a case-insensitive filesystem must not hand the
		// plugin's own file back as a project-note candidate under another spelling.
		assert.equal(isWeeklyNotePath(settings(), "Gitdeck/Weekly/2026-W42.MD"), true);
	});
});

describe("renderWeeklySection", () => {
	it("opens with the week in words rather than a heading", () => {
		const text = renderWeeklySection([], commits({}), NOW);
		assert.match(text, /^Week of 2026-10-12 to 2026-10-18 \(2026-W42\)\./);
	});

	it("says so plainly when nothing happened", () => {
		const text = renderWeeklySection([], commits({}), NOW);
		assert.match(text, /_No activity recorded this week\._/);
		assert.doesNotMatch(text, /## Worked on this week/);
	});

	it("puts a project that committed this week in the first table with its commit count", () => {
		const text = renderWeeklySection([project()], commits({ "api-ai": 3 }), NOW);
		assert.match(text, /## Worked on this week/);
		assert.match(text, /\| api-ai \| 3 \| main \| 2d ago \| no note \|/);
	});

	it("puts a project with live work and no commits in the second table", () => {
		const text = renderWeeklySection([project({}, { dirtyCount: 5 })], commits({}), NOW);
		assert.match(text, /## Still open, nothing this week/);
		assert.match(text, /\| api-ai \| main \| 5 \| 2d ago \|  \| no note \|/);
	});

	it("never puts a project in both tables", () => {
		// A project that committed this week and is still dirty belongs to the first table only.
		const text = renderWeeklySection([project({}, { dirtyCount: 5 })], commits({ "api-ai": 2 }), NOW);
		assert.equal(text.match(/api-ai/g)?.length, 1, "the name appears once");
		assert.ok(
			text.indexOf("api-ai") > text.indexOf("## Worked on this week"),
			"it is under the worked table",
		);
		assert.ok(
			text.indexOf("api-ai") < text.indexOf("## Still open, nothing this week"),
			"and not under the open table",
		);
	});

	it("keeps a dirty project out of the worked table when it did not commit", () => {
		const text = renderWeeklySection([project({}, { dirtyCount: 9 })], commits({ "api-ai": 0 }), NOW);
		const worked = text.slice(0, text.indexOf("## Still open"));
		assert.doesNotMatch(worked, /api-ai/);
	});

	it("leaves a dormant project out of both tables", () => {
		// No live work and no commits this week, whatever `showDormant` says.
		const dormant = project({}, { dirtyCount: 0, onNonDefaultBranch: false });
		const text = renderWeeklySection([dormant], commits({}), NOW);
		assert.doesNotMatch(text, /api-ai/);
		assert.match(text, /_No activity recorded this week\._/);
	});

	it("orders the worked table by commits descending, then by name", () => {
		const text = renderWeeklySection(
			[project({}, { name: "alpha" }), project({}, { name: "beta" }), project({}, { name: "gamma" })],
			commits({ alpha: 2, beta: 5, gamma: 2 }),
			NOW,
		);
		assert.ok(text.indexOf("beta") < text.indexOf("alpha"), "the busiest is first");
		assert.ok(text.indexOf("alpha") < text.indexOf("gamma"), "a tie breaks on name ascending");
	});

	it("orders the open table the way the panel ranks, pins first", () => {
		const text = renderWeeklySection(
			[project({}, { name: "aaa-high", dirtyCount: 1 }), project({ pin: 1 }, { name: "zzz-pinned", dirtyCount: 1 })],
			commits({}),
			NOW,
		);
		assert.ok(text.indexOf("zzz-pinned") < text.indexOf("aaa-high"), "the pinned row comes first");
	});

	it("keeps two repos with the same name apart by path", () => {
		// Two checkouts of `api-ai` in different parents share a display name. The commit map is
		// keyed by path, so each row must carry its own count rather than both borrowing one.
		const text = renderWeeklySection(
			[
				project({}, { name: "api-ai", path: "/work/api-ai" }),
				project({}, { name: "api-ai", path: "/fork/api-ai" }),
			],
			new Map([
				["/work/api-ai", 3],
				["/fork/api-ai", 1],
			]),
			NOW,
		);
		assert.match(text, /\| api-ai \| 3 \|/);
		assert.match(text, /\| api-ai \| 1 \|/);
	});

	it("says no note rather than rendering a dead link", () => {
		const text = renderWeeklySection([project()], commits({ "api-ai": 1 }), NOW);
		assert.match(text, /\| no note \|/);
	});

	it("links a note by path with the alias separator escaped", () => {
		const text = renderWeeklySection(
			[project({ notePath: "Archive/api-ai.md" })],
			commits({ "api-ai": 1 }),
			NOW,
		);
		assert.match(text, /\[\[Archive\/api-ai\.md\\\|api-ai\]\]/);
	});

	it("escapes a pipe in a project name", () => {
		const text = renderWeeklySection([project({}, { name: "a|b" })], commits({ "a|b": 1 }), NOW);
		assert.match(text, /\| a\\\|b \| 1 \|/);
		const rows = text.split("\n").filter((line) => line.startsWith("|"));
		// A header, a rule and one row. The escaped name leaves the worked row at five cells.
		assert.equal(cells(rows[2]).length, 5);
	});

	it("carries warnings into the open table", () => {
		const text = renderWeeklySection(
			[project({ health: [{ id: "stashed", badge: "stashed", detail: "x" }] as Project["health"] }, { dirtyCount: 1 })],
			commits({}),
			NOW,
		);
		assert.match(text, /\| api-ai \| main \| 1 \| 2d ago \| stashed \| no note \|/);
	});

	it("is stable when nothing changed", () => {
		const once = renderWeeklySection([project()], commits({ "api-ai": 1 }), NOW);
		assert.equal(renderWeeklySection([project()], commits({ "api-ai": 1 }), NOW), once);
	});
});

describe("the weekly section and its markers", () => {
	it("round-trips a rendered body through replaceSection", () => {
		const body = renderWeeklySection([project()], commits({ "api-ai": 1 }), NOW);
		const doc = replaceSection("", "weekly", body);
		assert.equal(sectionBody(doc, "weekly"), body);
	});

	it("refuses a body carrying a marker rather than corrupting the section", () => {
		const body = renderWeeklySection([project()], commits({ "api-ai": 1 }), NOW);
		assert.throws(() => replaceSection("", "weekly", `${body}\n<!-- pt:weekly:end -->`), /refusing to write/);
	});
});
