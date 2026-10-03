import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	describeFilter,
	describeGroup,
	explainGroup,
	filterProjects,
	hiddenBy,
	isFiltering,
	nextStateOnEscape,
	plural,
} from "./filter.ts";
import type { FilterState } from "./filter.ts";
import { rankProjects } from "./rank.ts";
import type { Project, ProjectStatus, RepoFacts, ScoreResult } from "./types.ts";

function project(name: string, overrides: { pin?: number; status?: ProjectStatus; score?: number } = {}): Project {
	const facts: RepoFacts = {
		path: `/repos/${name}`,
		name,
		root: "/repos",
		gitReadable: true,
		remote: null,
		github: null,
		branch: "main",
		defaultBranch: "main",
		onNonDefaultBranch: false,
		lastCommit: new Date().toISOString(),
		dirtyCount: 0,
		stashCount: 0,
		unpushedCount: 0,
		dirMtime: Date.now(),
	};
	const score: ScoreResult = {
		score: overrides.score ?? 10,
		status: overrides.status ?? "active",
		parts: [],
	};
	return { facts, score, pin: overrides.pin ?? 0, health: [] };
}

/** The filter state of an unfiltered panel, with dormant projects on. */
function state(overrides: Partial<FilterState> = {}): FilterState {
	return { query: "", activeOnly: false, showDormant: true, pinnedOnly: false, ...overrides };
}

function names(result: { rows: { project: Project }[] }): string[] {
	return result.rows.map((row) => row.project.facts.name);
}

/** The panel as the view sees it: ranked, then filtered. */
function panel(projects: Project[], overrides: Partial<FilterState> = {}) {
	return filterProjects(rankProjects(projects), state(overrides));
}

describe("grouping without any filter", () => {
	it("keeps the three groups in the order the panel has always drawn them", () => {
		const result = panel([
			project("sleepy", { status: "dormant" }),
			project("busy", { score: 90 }),
			project("calm", { score: 50 }),
			project("chosen", { pin: 1, score: 1 }),
		]);
		assert.deepEqual(
			result.groups.map((group) => group.key),
			["pinned", "active", "dormant"],
		);
		assert.deepEqual(names(result), ["chosen", "busy", "calm", "sleepy"]);
	});

	it("shows a dormant project when dormant projects are included", () => {
		assert.deepEqual(names(panel([project("sleepy", { status: "dormant" })])), ["sleepy"]);
	});

	it("hides a dormant project when they are not, which is the default", () => {
		// This is the pre-existing behaviour of `showDormant`, unchanged: the panel
		// has always hidden non-active projects unless asked otherwise.
		const result = panel([project("busy"), project("sleepy", { status: "dormant" })], { showDormant: false });
		assert.deepEqual(names(result), ["busy"]);
	});

	it("counts a hidden group without drawing it", () => {
		const result = panel([project("busy"), project("sleepy", { status: "dormant" })], { showDormant: false });
		const dormant = result.groups.find((group) => group.key === "dormant");
		assert.deepEqual([dormant?.total, dormant?.hidden, dormant?.rows.length], [1, 1, 0]);
	});

	it("leaves an empty group out entirely", () => {
		// Three headings all saying "(0)" is noise on a panel with nothing filtered.
		const result = panel([project("busy")]);
		assert.deepEqual(
			result.groups.map((group) => group.key),
			["active"],
		);
	});

	it("keeps a pinned dormant project visible, as it always did", () => {
		// The Dormant toggle has only ever applied to unpinned projects: a pin is a
		// direct instruction about one project, so a view toggle may not hide it.
		const result = panel([project("old-but-pinned", { pin: 1, status: "dormant" })], { showDormant: false });
		assert.deepEqual(names(result), ["old-but-pinned"]);
	});

	it("says so when there is nothing to show at all", () => {
		const result = panel([]);
		assert.equal(result.visible, 0);
		assert.equal(describeFilter(result), "No git repositories found under the scan root.");
	});
});

describe("the toggles", () => {
	const projects = [
		project("busy", { score: 90 }),
		project("calm", { score: 50 }),
		project("sleepy", { status: "dormant" }),
		project("chosen", { pin: 1 }),
	];

	it("shows only active projects", () => {
		assert.deepEqual(names(panel(projects, { activeOnly: true })), ["chosen", "busy", "calm"]);
	});

	it("shows only pinned projects", () => {
		assert.deepEqual(names(panel(projects, { pinnedOnly: true })), ["chosen"]);
	});

	it("does not confuse Pinned only with the pinned group", () => {
		// The toggle hides; it does not promote. A pinned project whose name does not
		// match a query stays hidden by the query.
		const result = panel(projects, { pinnedOnly: true, query: "chosen" });
		assert.deepEqual(names(result), ["chosen"]);
		assert.deepEqual(names(panel(projects, { pinnedOnly: true, query: "busy" })), []);
	});

	it("counts what each toggle hid", () => {
		const result = panel(projects, { activeOnly: true });
		assert.equal(result.hidden.by["Active only"], 1);
		assert.equal(result.hidden.by["Pinned only"], 0);
		assert.equal(result.hidden.total, 1);
	});

	it("reports every hidden project exactly once", () => {
		// The breakdown has to add up, or two filters both claim the same row and the
		// status line says more was hidden than exists.
		const result = panel(projects, { activeOnly: true, pinnedOnly: true, query: "s" });
		const summed = result.hidden.by.search + result.hidden.by["Active only"] + result.hidden.by["Pinned only"] + result.hidden.by["the Dormant toggle"];
		assert.equal(result.hidden.total, result.scanned - result.visible);
		assert.equal(summed, result.hidden.total);
	});

	it("knows whether anything is filtering, for the N of M headings", () => {
		assert.equal(isFiltering(state()), false);
		assert.equal(isFiltering(state({ showDormant: false })), true);
		assert.equal(isFiltering(state({ query: "x" })), true);
		assert.equal(isFiltering(state({ activeOnly: true })), true);
		assert.equal(isFiltering(state({ pinnedOnly: true })), true);
	});
});

describe("hiddenBy", () => {
	it("blames the standing setting before the filter being held down", () => {
		// The Dormant toggle is off by default, so it is what was hiding these before
		// the user typed anything. Naming Active only instead would send them to
		// change a setting they never touched.
		assert.equal(hiddenBy(project("sleepy", { status: "dormant" }), state({ showDormant: false })), "the Dormant toggle");
		assert.equal(
			hiddenBy(project("sleepy", { status: "dormant" }), state({ showDormant: true, activeOnly: true })),
			"Active only",
		);
	});

	it("blames Pinned only for an unpinned project, whatever its status", () => {
		assert.equal(hiddenBy(project("busy"), state({ pinnedOnly: true })), "Pinned only");
		assert.equal(hiddenBy(project("sleepy", { status: "dormant" }), state({ pinnedOnly: true })), "Pinned only");
	});

	it("never blames anything for a project nothing hides", () => {
		assert.equal(hiddenBy(project("busy"), state()), null);
		assert.equal(hiddenBy(project("chosen", { pin: 1 }), state({ pinnedOnly: true })), null);
		// The one case where a project survives every toggle that would hide its
		// neighbours, which is the whole of what pinning means.
		assert.equal(hiddenBy(project("chosen", { pin: 1 }), state({ pinnedOnly: true, activeOnly: true })), null);
	});
});

describe("searching", () => {
	const projects = [
		project("ClientRadar"),
		project("client-radar-tests"),
		project("codec"),
		project("AniFlow"),
		project("api-server"),
	];

	it("matches on a subsequence, in order", () => {
		assert.deepEqual(names(panel(projects, { query: "cr" })), ["ClientRadar", "client-radar-tests"]);
	});

	it("puts the best match first within a group", () => {
		assert.deepEqual(names(panel(projects, { query: "cr" }))[0], "ClientRadar");
	});

	it("ranks the whole query above a partial one", () => {
		// "client-radar-tests" contains every letter of "cr" but the hump-and-prefix
		// match has to win, or the longest name wins every search.
		const result = panel(projects, { query: "cr" });
		const [best, second] = result.rows;
		assert.ok((best.score ?? 0) > (second.score ?? 0), `${best.score} !> ${second.score}`);
	});

	it("drops a project whose name does not contain the query", () => {
		assert.deepEqual(names(panel(projects, { query: "zzz" })), []);
	});

	it("does not reorder the groups, only the rows inside them", () => {
		const result = panel([...projects, project("zzz-pinned", { pin: 1 })], { query: "cr" });
		assert.deepEqual(
			result.groups.map((group) => group.key),
			["pinned", "active"],
		);
		// The pinned row is hidden by the search, so the pinned group still leads.
		assert.equal(result.rows.length, 2);
	});

	it("keeps a weak match, dimmed, rather than dropping it", () => {
		// A name that contains the letters but only scattered is more likely to be
		// the one that was meant than one that does not contain them at all.
		const result = panel([project("dashboard-ui-kit")], { query: "dbt" });
		assert.deepEqual(names(result), ["dashboard-ui-kit"]);
		assert.equal(result.weak, 1);
		assert.equal(result.rows[0].weak, true);
	});

	it("does not call a strong match weak", () => {
		const result = panel([project("codec")], { query: "code" });
		assert.equal(result.weak, 0);
		assert.equal(result.rows[0].weak, false);
	});

	it("calls nothing weak for a one-character query", () => {
		// One character cannot be scattered, so nothing is a poor match. It used to dim
		// nearly everything: a mid-word single-character match scores at most MATCH, and
		// half the ceiling for a one-character query is one point above that.
		const result = panel([project("codec"), project("context")], { query: "c" });
		// Best match first, and none of them dimmed.
		assert.deepEqual(names(result), ["codec", "context"]);
		assert.equal(result.weak, 0);
		for (const row of result.rows) assert.equal(row.weak, false, `${row.project.facts.name} dimmed`);
	});

	it("reports no score at all when no query is filtering", () => {
		// Null rather than zero, because "not searched for" is not a bad match.
		const result = panel(projects);
		for (const row of result.rows) assert.equal(row.score, null);
		assert.equal(result.weak, 0);
	});

	it("ignores a query that is only whitespace", () => {
		assert.equal(panel(projects, { query: "   " }).visible, projects.length);
	});
});

describe("not mutating what it was given", () => {
	it("leaves the caller's array in the order it arrived", () => {
		const projects = [project("aaa"), project("zzz"), project("mmm")];
		const before = [...projects];
		// A query that reorders hard, to make sure the sort has something to do.
		filterProjects(projects, state({ query: "zzz" }));
		assert.deepEqual(projects, before);
	});

	it("leaves the ranked array alone, so the next render starts from the same place", () => {
		const ranked = rankProjects([project("aaa"), project("zzz"), project("mmm")]);
		const before = [...ranked];
		// Equal scores, so the ranking is alphabetical and the search has to fight it.
		assert.deepEqual(
			ranked.map((p) => p.facts.name),
			["aaa", "mmm", "zzz"],
		);
		const result = filterProjects(ranked, state({ query: "mmm" }));
		assert.equal(result.rows.length, 1);
		assert.deepEqual(ranked, before);
	});

	it("does not sort in place", () => {
		// `rankProjects` copies before sorting for exactly this reason. If either it
		// or this module stopped doing that, the plugin's own list would come back
		// reordered and the next render would show something else.
		const projects = [project("bbb"), project("aaa")];
		const original = projects[0];
		filterProjects(projects, state({ query: "aaa" }));
		assert.equal(projects[0], original);
	});
});

describe("what the panel says about itself", () => {
	it("reports nothing but a count when nothing is hidden", () => {
		assert.equal(describeFilter(panel([project("busy"), project("calm")])), "2 projects.");
	});

	it("uses the singular for one project", () => {
		assert.equal(describeFilter(panel([project("busy")])), "1 project.");
		assert.equal(plural(1, "project"), "1 project");
		assert.equal(plural(2, "project"), "2 projects");
	});

	it("says how many of how many are shown", () => {
		const projects = [project("busy"), project("sleepy", { status: "dormant" })];
		const text = describeFilter(panel(projects, { showDormant: false }));
		assert.equal(text, "1 of 2 shown. 1 hidden by the Dormant toggle.");
	});

	it("names every filter that hid something", () => {
		const projects = [project("busy"), project("calm"), project("sleepy", { status: "dormant" })];
		// "s" matches busy, but not calm. sleepy's group is closed by Active only
		// before the search is ever consulted, so the two reasons do not collide.
		const filters = state({ showDormant: true, activeOnly: true, query: "s" });
		const text = describeFilter(panel(projects, filters));
		assert.equal(text, "1 of 3 shown. 1 hidden by Active only, 1 hidden by search.");
	});

	it("says a search found nothing rather than nothing existing", () => {
		// The load-bearing sentence. "No projects" would read as data loss and send
		// the user off to press refresh, so the scanned count leads and the reason is
		// named even though there is nothing left on screen to point at.
		const filters = state({ query: "zzz" });
		assert.equal(
			describeFilter(panel([project("busy")], filters)),
			"Nothing shown. 1 project scanned. 1 hidden by search.",
		);
	});

	it("says nothing matches the toggles when no query was typed", () => {
		const filters = state({ pinnedOnly: true });
		assert.equal(
			describeFilter(panel([project("busy")], filters)),
			"Nothing shown. 1 project scanned. 1 hidden by Pinned only.",
		);
	});

	it("never leaves an empty panel unexplained", () => {
		// Everything hidden by two things at once, which is the case where naming one
		// of them would be misleading.
		const projects = [project("busy"), project("sleepy", { status: "dormant" })];
		const text = describeFilter(panel(projects, state({ pinnedOnly: true, showDormant: false })));
		assert.equal(text, "Nothing shown. 2 projects scanned. 2 hidden by Pinned only.");
	});

	it("mentions a loose match instead of dimming it in silence", () => {
		const text = describeFilter(panel([project("dashboard-ui-kit")], { query: "dbt" }));
		assert.equal(text, "1 project. 1 only matched loosely.");
	});
});

describe("escape", () => {
	it("clears the query first, before anything else", () => {
		const filters = state({ query: "monk", activeOnly: true, pinnedOnly: true });
		assert.equal(nextStateOnEscape(filters).query, "");
		assert.equal(nextStateOnEscape(filters).activeOnly, true);
	});

	it("then clears the view-only toggles", () => {
		const filters = state({ activeOnly: true, pinnedOnly: true });
		const next = nextStateOnEscape(filters);
		assert.deepEqual([next.activeOnly, next.pinnedOnly], [false, false]);
	});

	it("never forgets the persisted dormant setting", () => {
		// It is a setting the user chose, not a filter they are holding down. Losing
		// it on a stray Esc would be the plugin changing their mind for them.
		const filters = state({ showDormant: false, query: "x", activeOnly: true });
		assert.equal(nextStateOnEscape(filters).showDormant, false);
		assert.equal(nextStateOnEscape(filters).showDormant, nextStateOnEscape(nextStateOnEscape(filters)).showDormant);
	});

	it("does not mutate the state it was given", () => {
		const filters = state({ query: "monk" });
		nextStateOnEscape(filters);
		assert.equal(filters.query, "monk");
	});
});

describe("group headings", () => {
	it("shows a plain count when nothing is filtered", () => {
		// How the panel has always looked, so an unfiltered panel does not change
		// shape just because it can now say more.
		const result = panel([project("busy"), project("calm")]);
		const active = result.groups[0];
		assert.equal(describeGroup(active, false), "Active (2)");
		assert.equal(explainGroup(active), "");
	});

	it("shows how much of the group survived once something is filtered", () => {
		// Two numbers on screen that appear to contradict each other is the failure
		// this avoids: the heading says 2, the status line says 5, neither is wrong.
		const result = panel([project("busy"), project("calm"), project("client")], { query: "cli" });
		const active = result.groups[0];
		assert.equal(describeGroup(active, true), "Active (1 of 3)");
		assert.equal(explainGroup(active), "2 projects hidden by search.");
	});

	it("says what hid the group, using the singular for one", () => {
		const result = panel([project("busy"), project("sleepy", { status: "dormant" })], { showDormant: false });
		const active = result.groups.find((group) => group.key === "active");
		const dormant = result.groups.find((group) => group.key === "dormant");
		assert.equal(explainGroup(dormant!), "1 project hidden by the Dormant toggle.");
		assert.equal(explainGroup(active!), "");
	});

	it("names the reason that hid the most of them", () => {
		const projects = [project("busy"), project("breeze"), project("calm"), project("sleepy", { status: "dormant" })];
		const result = panel(projects, { query: "b" });
		const active = result.groups.find((group) => group.key === "active");
		// One of the three active projects is hidden, by the search. Naming "Active
		// only" here would send the user to change a toggle they never touched.
		assert.equal(active!.hiddenBy, "search");
		assert.equal(explainGroup(active!), "1 project hidden by search.");
	});
});
