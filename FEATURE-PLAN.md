# Project Tracker feature plan

Status: proposed, not built. Written 2026-10-02.
Covers everything after v0.1: the AI summary work landed in `f5b75f9`, and these are the
requested additions on top.

## Read this first: two things in the request conflict with what is built

**1. "Kill the file-per-project sprawl" vs. the AI summaries.**

Summaries currently land in `<name>-ai.md` siblings, one per project, because that was
Option B: keep the project note body untouched so the plugin never fights your writing.
Collapsing to a single dashboard note means the summaries have to move too, or they stay
behind as orphans. So this is not a cosmetic change, it relocates the whole note model.

The plan below resolves it by making the dashboard note the only thing the plugin owns,
and treating per-project notes as something *you* create when you want one. Summary text
lives in the dashboard note, in a section the plugin owns.

**2. Two existing bugs are load-bearing for everything below.**

Auto-detection, health warnings, and the weekly note all produce errors the user has to be
able to read. Right now a summary failure goes to a transient `Notice` and nowhere else
(`src/view.ts:177`), which is why an auth error could not be copied earlier. And gemini
exits **0** while printing an auth error, so exit status alone cannot be trusted. Fix
these first or every later feature inherits an invisible failure mode.

## Verified constraints

Checked on this machine, 2026-10-02.

- A 45-repo scan takes **0.17s**. Any per-keypress rescan is fine. No debounce needed, but
  do not add one either: the cost is already negligible.
- `periodic-notes` is **not installed**. The weekly note cannot assume it. Only
  `daily-notes` (core) is available, so a weekly note must be its own markdown file, or
  opt-in to periodic-notes if the user has it.
- Available launchers: `code`, `cursor`, `nvim`, `alacritty`, `kitty`. The installed
  `terminal` plugin uses `child_process.spawn`, so the same approach works.
- No `keydown` handling in the view at all today. The panel currently has zero keyboard
  support, so this is greenfield rather than an extension.
- `git status --porcelain -z` is how dirty paths are read. Stash counts and unpushed
  commits are cheap extra `git` calls.
- Only one repo has a stash (`AniFlow`, 1). Nothing is unpushed anywhere, so an
  "unpushed" warning has nothing to show on this machine and cannot be evaluated here.

## Priority order

P0 is what makes the plugin trustworthy. P1 is what people notice daily. P2 is polish.

---

### P0-a. Auto-detect the working CLI

Replaces the `provider` setting with a detected value, with manual override still
available.

Why: on this machine gemini is installed, not authenticated, and fails with **exit code 0**
while printing an auth error. A user who installed a CLI months ago and never used it will
hit this with no way to diagnose it. Detection is what makes the plugin work on first run
with zero configuration.

Probe design, based on the failures observed:

- Do **not** probe with `--version`. gemini passes `--version` and still fails auth, which
  is exactly the trap.
- Probe with a real minimal call per CLI, `spawnSync` with an argv array, short timeout
  (suggest 15s), and treat the result as "answers correctly" or not.
- Detection is a **capability check, not a preference check**. Success means the CLI
  produced a usable answer, not that it exited 0.
- Cache the result in `data.json` with a timestamp, and re-probe when the user clicks a
  "retest" button or when a generation fails, so fixing auth elsewhere gets picked up
  without a restart.
- Order of preference when several work: keep the user's manual choice if they made one,
  otherwise a fixed order. Do not guess by recency.

Accept when: on this machine, with gemini unauthenticated, the plugin selects opencode or
codex and a summary generates successfully with no settings touched.

### P0-b. Errors go to a durable log

Reuse the `StartupLog` pattern that already exists for load failures.

- Write every generation failure to `errors.log` in the plugin folder, append-only,
  timestamped, with the provider, the project, and the raw stderr.
- The `Notice` stays, and should link to the log location.
- Trim or rotate so the file cannot grow without bound.
- Why: a load failure once presented as "no ribbon icon, no error anywhere" and cost real
  debugging time. Generation failures now do the same thing.

### P0-c. Do not trust exit code alone

gemini returned exit 0 with an error object in stdout. `parseSummary` must detect an
`error` member in the response shape and surface that message as a user-facing failure
rather than letting it fail downstream as a confusing parse error. Test both shapes.

---

### P1-a. One dashboard note, per-project notes optional

This is the "kill the sprawl" change and the biggest structural shift in this plan.

Target state:

- One file, `<user-chosen folder>/Dashboard.md`, owned by the plugin.
- The folder is a setting with a picker. The plugin assumes nothing about the user's vault
  layout or hosting. Not everyone publishes their notes, and the plugin must not pretend to
  know that anyone does.
- It holds the project list, derived state, and AI summaries.
- Per-project notes are no longer auto-created. If you want a note for a project, you
  create it yourself, and the plugin links to it.
- 45 generated files go away, replaced by 1.

Why this is right: the generated notes currently hold almost nothing. Each is frontmatter
you did not write plus a placeholder line. 180K of near-identical files for 45 projects is
the kind of thing that makes people uninstall.

Migration, since 45 real files exist on disk:

- One-time migration that moves existing AI summaries into the dashboard note, then leaves
  the old files **untouched** and unreferenced. Do not delete user files automatically.
  Print a Notice naming the old folder and telling the user they can delete it.
- Anything the user wrote into a project note body is their content. Do not move, merge,
  or delete it.
- Repoint the existing `notesFolder` setting to the new location without losing it, and
  offer to archive the old folder rather than silently leaving 45 dead files behind.

Sections the plugin owns inside the dashboard note, marked with HTML comments so
regeneration never eats surrounding text:

- `<!-- pt:projects:start -->` / `end` — the project table
- `<!-- pt:summaries:start -->` / `end` — AI summaries

Accepted risk: one file with 45 projects and a summary each gets large. Mitigation is
summaries living under a per-project heading that is collapsed by default, and the file
being plain markdown so it stays fast to open.

### P1-b. Search and filter

- Type-to-filter by project name, fuzzy, no plugin dependency.
- Toggles: active only, include dormant, pinned only.
- Show counts per group so the filter state is never mysterious.
- Non-trivial part: filter must not trigger a git rescan. Filter the already-scanned list.
  The scan is fast enough that either works, but filtering in memory is more predictable
  and does not churn files.

### P1-c. Keyboard navigation

The panel has no keyboard support today. Add it properly rather than half.

- `j` / `k` or arrows move selection, `Enter` opens the note, `s` summarizes,
  `p` pins, `r` refreshes, `/` focuses search, `Esc` clears.
- Register via Obsidian's `scope` on the view so keys only apply when the panel has focus,
  and do not steal keystrokes while the user types in a note or a search box.
- Visible selection state, and the selected row must scroll into view.

### P1-d. Make the score legible, or drop it

The bare number beside the AI button currently has no label and no explanation. Two of your
projects were said to have it and it could not be identified.

Do all three, they are cheap together:

- Hover tooltip naming the signal breakdown, e.g. "40 dirty, 25 branch, 30 recent".
- A "why this score" line per project, or in the detail view.
- Weight sliders in settings so the model is inspectable and tunable, since the log curve
  and the 25-point branch weight were both chosen somewhat arbitrarily.

Also fix the display collision: `pt-right` currently shows the pin rank `#3` when pinned and
the score when not, in the same position with no styling difference, so position carries
meaning by accident.

### P1-e. Health warnings

Cheap signals that need one extra `git` call each, and only shown when they actually fire.
A warning that is always on is noise.

- Large dirty count sustained over time. `monk-mode` at 144 and `ClientRadar` at 79 are
  your real examples.
- Long-lived branch. `AniFlow` is on `pr5-6-visual-identity-atmosphere` and `cursor-virtually`
  on `jonaz`; both are stale.
- Stashes present. Only `AniFlow` has one, which is exactly the case where it matters,
  because a stash is work parked deliberately and easy to forget.
- Unpushed commits. Nothing on this machine today, so it cannot be evaluated here and
  should ship quietly or last.

Presentation: badges on the row, and the full explanation on hover or in the detail view.
Do not add a number to the row for every warning, that is the sprawl problem again.

### P1-f. "Pick up where you left off"

One click opens the project in an editor. Nothing to do with the AI provider; see the
resolved-decisions table above, this is the second and separate "which binary" choice.

- One "Editor command" text setting, empty by default, listing the discovered binaries
  (`code`, `cursor`, `nvim`, `vim` are all present on this machine) in the description as
  copyable examples. No picker and no preference ordering, because guessing a ranking for
  someone else's setup is worse than a field they fill in.
- Empty setting means reveal the repo folder, so the feature degrades to something harmless
  instead of erroring.
- Launch via `spawnSync`/`spawn` with an argv array, never a shell string. Same rule the AI
  provider layer already follows.
- Obsidian's `isDesktopOnly: true` already covers this, since it shells out.
- Refuse to launch on a repo that is not a readable git repo, and say why.

---

### P2. Weekly note

Highest delight, so it is tempting to ship early. It has one dependency risk.

- **Rewrites itself, per user decision.** One file per ISO week, regenerated rather than
  appended, so it never becomes a sequence of stale daily blocks. Everything the plugin owns
  sits between `<!-- pt:weekly:start -->` and `<!-- pt:weekly:end -->` and is replaced
  wholesale on each refresh; text outside the markers is preserved. Say in the file itself
  that the middle is machine-owned.
- Lands in the same user-chosen notes folder as the dashboard, so there is one location
  setting rather than two.
- `periodic-notes` is **not installed**, only `daily-notes` core. So: write to
  `<notes folder>/Weekly/<ISO-week>.md`, and additionally offer to use periodic-notes when
  the user has it. Do not assume the plugin exists.
- Gate behind an explicit opt-in setting, default off. Writing to someone's notes
  unprompted is the kind of thing that gets a plugin uninstalled.

---

## Explicitly rejected

**GitHub API integration.** Stars, PRs, issues, CI. Adds OAuth or a PAT, a credential
storage surface, rate limits, and a private-token failure mode, all to display numbers that
do not change what you do next. SSH already works for local git, which is all v0.1 needs.

**Mobile.** The data source is shelling out to git. Not recoverable.

**TODO/FIXME density as a signal.** Tested on this machine: every hit was `node_modules`,
1223 "files with markers" in `ClientRadar` reduced to **0** tracked files once vendor paths
were excluded. The signal is unusable without deep filtering, and deep filtering is not
worth it.

**Auto-refreshing summaries.** Manual regeneration only, so a note never changes under you
while you are reading it.

**Deleting the 45 existing notes automatically.** They may contain content you wrote.
Migration leaves them in place and tells you they are safe to remove.

## Resolved by the user (2026-10-02)

**1. The notes folder is user-chosen, not assumed.** Settled: the plugin must not encode
Quartz, `private/`, or any vault-specific layout.

- Folder picker in settings, defaulting to a sensible path but never assuming the user
  hosts their notes anywhere in particular. Not every user has Quartz; plenty have no
  publishing setup at all.
- Consequences to honour: do not hardcode `private/Project Tracker/` anywhere, do not
  describe the folder as private, and do not rely on `ignorePatterns` for privacy. If the
  user picks a folder that IS published, that is their call to make.
- All existing paths move behind a single setting with a migration for the 45 notes already
  written on this machine.

**2. The weekly note rewrites itself.** One file per ISO week, regenerated rather than
appended, so it never becomes a sequence of stale daily blocks.

- The marker contract is what makes this safe. The plugin owns everything between
  `<!-- pt:weekly:start -->` and `<!-- pt:weekly:end -->` and replaces it wholesale; text
  the user writes outside the markers survives a rewrite.
- State this plainly in the file itself, so a future reader knows the middle is
  machine-owned and the outside is theirs.
- Default the folder to the same user-chosen notes folder from item 1, so there is one
  location setting, not two.

**3. The editor choice is a separate feature from the AI provider.** Answering the
confusion here rather than in passing: the plan contains two independent "which binary do
we call" decisions, and they are not related.

| Decision | Used for | Options on this machine |
| --- | --- | --- |
| AI provider (P0-a) | Summarising a project from git facts | `gemini`, `codex`, `opencode` |
| Editor (P1-f) | Clicking a project to open its folder | `code`, `cursor`, `nvim`, `vim` |

The editor is not used for AI at any point. It exists solely for "pick up where you left
off": clicking a project opens that repo in your code editor, which is what makes the
dashboard a launcher instead of just a list to read.

Given the answer, do not auto-detect and do not present a ranking UI. Offer a single
"Editor command" text setting, empty by default, with the discovered binaries listed in the
setting description as copyable examples. The user types `code` or `cursor` or whatever
they actually use. That is one field instead of a picker plus preference order, and it does
not pretend to know anything about their setup.

- Resolution: launch the configured editor via `spawnSync` with an argv array, never a
  shell string, same rule the AI provider layer already follows.
- Empty setting means reveal the repo folder instead of launching anything, so the feature
  degrades to something harmless rather than erroring.
- Refuse to launch on a path that is not a readable git repo, and say why.

## Still open

**Per-project notes on demand.** What marks a project as "wants a note", now that the
plugin no longer creates one per project:

- A `tracked: true` frontmatter key the user sets themselves. Explicit, survives a rename,
  and works even when no note exists yet.
- Or: any existing vault note whose filename matches the project name. Zero effort, but
  accidental matches are likely with 45 repos and a notes vault.

Suggestion is the first, with the second as a fallback for notes that already exist. This
blocks P1-a and nothing else.

## Verification expectations for each item

State plainly, per item, what was tested and what was not. Existing precedent: the AI
summary feature shipped with 119 unit tests and zero verification of an actual model
round-trip, which is how an auth error reached the UI as a vague failure. For each item
here:

- Claim the automated test coverage with real numbers.
- Say explicitly whether anything was confirmed in the running Obsidian GUI. Neither the
  agent nor the user can drive it, so the honest answer is usually no.
- Where a feature depends on external state (an editor launch, a real model call), test the
  real thing or say it is untested. Do not simulate and present it as verified.
