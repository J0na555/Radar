import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import {
	buildGitContext,
	buildPrompt,
	clampCommitCount,
	clampTimeoutSeconds,
	COMMIT_COUNT_DEFAULT,
	parsePorcelainPath,
} from "./context.ts";
import type { PluginSettings, RepoFacts } from "./types.ts";

/**
 * A real git repository, because the interesting failures here are git's: a repo
 * with no commits, a path with a space in it, a subject containing a tab. Those
 * are the cases a hand-written fixture gets wrong.
 */
function makeRepo(script: (dir: string) => void): string {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pt-ctx-")));
	const git = (...args: string[]) => {
		const res = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
		assert.equal(res.status, 0, `git ${args.join(" ")} failed: ${res.stderr}`);
	};
	git("init", "-q");
	git("config", "user.email", "test@example.com");
	git("config", "user.name", "Test");
	script(dir);
	return dir;
}

const created: string[] = [];
after(() => {
	for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

function factsFor(dir: string, overrides: Partial<RepoFacts> = {}): RepoFacts {
	return {
		path: dir,
		name: path.basename(dir),
		root: path.dirname(dir),
		gitReadable: true,
		remote: "git@github.com:owner/repo.git",
		github: "owner/repo",
		branch: "main",
		defaultBranch: "main",
		onNonDefaultBranch: false,
		lastCommit: "2026-10-01T09:00:00+03:00",
		dirtyCount: 0,
		dirMtime: Date.now(),
		...overrides,
	};
}

describe("buildGitContext", () => {
	it("reads commit subjects and the head sha from a real repo", () => {
		const dir = makeRepo((d) => {
			fs.writeFileSync(path.join(d, "a.txt"), "one");
			spawnSync("git", ["add", "."], { cwd: d });
			spawnSync("git", ["commit", "-qm", "first commit"], { cwd: d });
			fs.writeFileSync(path.join(d, "b.txt"), "two");
			spawnSync("git", ["add", "."], { cwd: d });
			spawnSync("git", ["commit", "-qm", "second commit"], { cwd: d });
		});
		created.push(dir);

		const context = buildGitContext(factsFor(dir), 20);

		assert.equal(context.commits.length, 2);
		assert.equal(context.commits[0].subject, "second commit");
		assert.equal(context.commits[1].subject, "first commit");
		// The newest commit first, which is the useful order for a summary.
		assert.match(context.commits[0].sha, /^[0-9a-f]{7,}$/);
		assert.equal(context.head, context.commits[0].sha);
		assert.equal(context.dirtyCount, 0);
		assert.deepEqual(context.dirtyFiles, []);
	});

	it("honours the configured commit count", () => {
		const dir = makeRepo((d) => {
			for (const n of ["one", "two", "three", "four"]) {
				fs.writeFileSync(path.join(d, `${n}.txt`), n);
				spawnSync("git", ["add", "."], { cwd: d });
				spawnSync("git", ["commit", "-qm", `commit ${n}`], { cwd: d });
			}
		});
		created.push(dir);

		assert.equal(buildGitContext(factsFor(dir), 2).commits.length, 2);
		assert.equal(buildGitContext(factsFor(dir), 4).commits.length, 4);
		assert.equal(buildGitContext(factsFor(dir), 1).commits.length, 1);
	});

	it("lists uncommitted paths, not contents", () => {
		// The whole point of the v0.1 scope. A path is useful context; the bytes
		// behind it are the user's and never leave the disk.
		const dir = makeRepo((d) => {
			fs.writeFileSync(path.join(d, "tracked.txt"), "original");
			spawnSync("git", ["add", "."], { cwd: d });
			spawnSync("git", ["commit", "-qm", "init"], { cwd: d });
			fs.writeFileSync(path.join(d, "tracked.txt"), "SECRET_VALUE_MUST_NOT_APPEAR");
			fs.writeFileSync(path.join(d, "untracked.txt"), "ALSO_SECRET");
		});
		created.push(dir);

		const context = buildGitContext(factsFor(dir), 20);
		const prompt = buildPrompt(context);

		assert.ok(context.dirtyFiles.includes("tracked.txt"));
		assert.ok(context.dirtyFiles.includes("untracked.txt"));
		assert.doesNotMatch(prompt, /SECRET_VALUE_MUST_NOT_APPEAR/);
		assert.doesNotMatch(prompt, /ALSO_SECRET/);
	});

  it("handles a path containing a space", () => {
    const dir = makeRepo((d) => {
      fs.writeFileSync(path.join(d, "my notes.md"), "x");
      spawnSync("git", ["add", "."], { cwd: d });
    });
    created.push(dir);

    assert.deepEqual(buildGitContext(factsFor(dir), 20).dirtyFiles, ["my notes.md"]);
  });

	it("keeps a tab out of the sha when a subject contains one", () => {
		// git separates the two with a tab, and a subject may itself contain tabs. If
		// the split were on the wrong tab the sha would be wrong, and a wrong sha in
		// the freshness stamp makes every summary claim to be stale forever.
		const dir = makeRepo((d) => {
			fs.writeFileSync(path.join(d, "a.txt"), "one");
			spawnSync("git", ["add", "."], { cwd: d });
			spawnSync("git", ["commit", "-qm", "fix\tthe\tthing"], { cwd: d });
		});
		created.push(dir);

		const context = buildGitContext(factsFor(dir), 20);
		assert.match(context.commits[0].sha, /^[0-9a-f]+$/);
		assert.equal(context.commits[0].subject, "fix\tthe\tthing");
	});

	it("degrades to empty values on a repo with no commits", () => {
		const dir = makeRepo(() => {
			// No commits at all.
		});
		created.push(dir);

		const context = buildGitContext(factsFor(dir, { lastCommit: null }), 20);
		assert.deepEqual(context.commits, []);
		assert.equal(context.head, null);
		// The prompt still renders, saying so rather than pretending.
		assert.match(buildPrompt(context), /No commits\./);
	});

	it("reads nothing outside the repo it was pointed at", () => {
		// A path that is not a repo yields empty context rather than throwing, so
		// one bad entry cannot break a prompt.
		const context = buildGitContext(factsFor("/nonexistent-repo-for-test"), 20);
		assert.deepEqual(context.commits, []);
		assert.equal(context.head, null);
		assert.deepEqual(context.dirtyFiles, []);
	});
});

describe("clampCommitCount", () => {
	it("keeps a sane number as it is", () => {
		assert.equal(clampCommitCount(20), 20);
		assert.equal(clampCommitCount(1), 1);
	});

	it("pulls a hostile value back into range", () => {
		assert.equal(clampCommitCount(0), 1);
		assert.equal(clampCommitCount(-50), 1);
		assert.equal(clampCommitCount(100_000), 200);
		assert.equal(clampCommitCount(Number.NaN), COMMIT_COUNT_DEFAULT);
		assert.equal(clampCommitCount(Number.POSITIVE_INFINITY), COMMIT_COUNT_DEFAULT);
		assert.equal(clampCommitCount(20.7), 20);
	});
});

describe("clampTimeoutSeconds", () => {
	it("keeps a sane value and bounds the rest", () => {
		assert.equal(clampTimeoutSeconds(120), 120);
		assert.equal(clampTimeoutSeconds(0), 5);
		assert.equal(clampTimeoutSeconds(-10), 5);
		assert.equal(clampTimeoutSeconds(99_999), 1800);
		assert.equal(clampTimeoutSeconds(Number.NaN), 120);
	});
});

describe("parsePorcelainPath", () => {
	it("reads the path after the two status columns", () => {
		assert.equal(parsePorcelainPath(" M src/main.ts"), "src/main.ts");
		assert.equal(parsePorcelainPath("M  staged.ts"), "staged.ts");
		assert.equal(parsePorcelainPath("?? new.ts"), "new.ts");
		assert.equal(parsePorcelainPath("A  added.ts"), "added.ts");
	});

	it("takes the new name from a rename", () => {
		assert.equal(parsePorcelainPath("R  old.ts -> new.ts"), "new.ts");
	});

	it("unquotes a path git quoted", () => {
		assert.equal(parsePorcelainPath('?? "a file.md"'), "a file.md");
	});

	it("rejects a line too short to hold a path", () => {
		assert.equal(parsePorcelainPath(""), null);
		assert.equal(parsePorcelainPath(" M "), null);
	});
});

describe("buildPrompt", () => {
	const settings: PluginSettings = {
		scanRoot: "/repos",
		notesFolder: "private/Project Tracker/projects",
		showDormant: false,
		provider: "gemini",
		commitCount: 20,
		timeoutSeconds: 120,
		detection: { checkedAt: 0, probes: [], selected: null },
	};

	const context = {
		projectName: "waifu-rag",
		repoPath: "/repos/waifu-rag",
		branch: "feature/embeddings",
		defaultBranch: "main",
		onDefaultBranch: false,
		lastCommitDate: "2026-10-01T09:00:00+03:00",
		dirtyCount: 2,
		dirtyFiles: ["src/index.ts", "README.md"],
		commits: [
			{ sha: "e77f024", subject: "fix(vault): write clickable https remotes" },
			{ sha: "74727df", subject: "fix(main): isolate onload steps" },
		],
		head: "e77f024",
		remote: "git@github.com:J0na555/waifu-rag.git",
	};

	it("includes every fact the design calls for", () => {
		const prompt = buildPrompt(context);

		assert.match(prompt, /- Project name: waifu-rag/);
		assert.match(prompt, /- Current branch: feature\/embeddings/);
		assert.match(prompt, /- Default branch: main/);
		assert.match(prompt, /- Last commit date: 2026-10-01T09:00:00\+03:00/);
		assert.match(prompt, /- Uncommitted files: 2/);
		// Note the branch is not the default one, and the prompt says so.
		assert.doesNotMatch(prompt, /Default branch: main \(you are on it\)/);
	});

	it("lists commits with their short sha and subject", () => {
		const prompt = buildPrompt(context);
		assert.match(prompt, /- e77f024 fix\(vault\): write clickable https remotes/);
		assert.match(prompt, /- 74727df fix\(main\): isolate onload steps/);
	});

	it("lists uncommitted file paths", () => {
		const prompt = buildPrompt(context);
		assert.match(prompt, /## Uncommitted file paths \(2\)/);
		assert.match(prompt, /- src\/index\.ts/);
		assert.match(prompt, /- README\.md/);
	});

	it("says the tree is clean rather than showing an empty section", () => {
		const prompt = buildPrompt({ ...context, dirtyCount: 0, dirtyFiles: [] });
		assert.match(prompt, /The working tree is clean\./);
	});

	it("marks the default branch when the repo is on it", () => {
		const prompt = buildPrompt({ ...context, branch: "main", onDefaultBranch: true });
		assert.match(prompt, /- Default branch: main \(you are on it\)/);
	});

	it("states the reply format the parser will require", () => {
		// The prompt and the parser have to agree, or every run fails validation.
		const prompt = buildPrompt(context);
		assert.match(prompt, /one JSON object and nothing else/);
		assert.match(prompt, /"summary"/);
		assert.match(prompt, /"next_steps"/);
	});

	it("sends no note from the vault, and says it cannot see anything else", () => {
		const prompt = buildPrompt(context);
		assert.match(prompt, /You cannot read the repository, its files, or/);
		assert.match(prompt, /any notes/);
		assert.doesNotMatch(prompt, /\.md`|\[\[/);
	});

	it("has a plausible settings fixture for future tests", () => {
		// Not an assertion about behaviour: keeps the fixture honest if the shape of
		// PluginSettings changes.
		assert.equal(settings.notesFolder, "private/Project Tracker/projects");
	});
});
