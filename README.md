# Project Tracker

An Obsidian sidebar plugin that shows which local git projects you are actually
working on, ranked, with one dashboard note in your vault.

Desktop only. It shells out to `git`, so it does not work on mobile.

## What it does

On refresh it scans a directory for git repositories and reads, per repo:

- date of the last commit
- number of uncommitted files (`git status --porcelain`)
- current branch, and whether that branch is not the remote default
- directory mtime

It then ranks projects in two layers that never blend:

1. **Pinned tier.** Anything you pinned sits on top in your order, always.
2. **Derived tier.** Everything else is ordered by a deterministic score:

| Signal | Points |
| --- | --- |
| has uncommitted changes | up to +40, on a log2 curve capped at 32 files |
| on a non-default branch | +25 |
| last commit within 7 days | +30 decaying to 0 |
| last commit 8 to 30 days | +15 decaying to 0 |
| directory touched within 2 days | +10 |

Uncommitted changes are not a flat +40. The points follow
`round(40 * log2(1 + files) / log2(1 + 32))`, so 1 changed file is 8, 4 is 18, 12
is 29, and 32 or more is the full 40. A flat weight gave 1 changed file the same
40 as 144, which left the top of the ranking separated by nothing but alphabetical
order.

A project is dormant only when it has no live work and no recent commit. Live work
means uncommitted changes or a non-default branch, either of which keeps a project
active on its own no matter how old its last commit is, so unshipped work is never
hidden. A project with no live work whose last commit is older than 30 days is
dormant, as is a repo with no commits whose directory has not been touched in 30
days. Dormant projects are hidden unless pinned, or unless you turn on "Show
dormant projects".

There is no LLM in the ranking. The score is arithmetic over git facts, so it is
free, offline, and explainable.

## The dashboard note

The plugin owns exactly one file: `Dashboard.md`, in the folder you pick in the
settings. It has two sections, between these markers:

```markdown
<!-- pt:projects:start -->
<!-- pt:projects:end -->
<!-- pt:summaries:start -->
<!-- pt:summaries:end -->
```

Everything outside them is yours. The plugin rewrites only what is between a
pair of markers and copies every other line through untouched, so you can write
your own notes above and below them. A section whose markers are unbalanced or
missing is treated as absent and a fresh pair is appended, rather than guessing
at a broken span and deleting text on a hypothesis.

The **projects** section is the scan as a table: pin rank, branch, uncommitted
count, age of the last commit, score, a link to your note, and any health
warnings. It is replaced on every scan.

The **summaries** section holds one folded AI summary per project, and only
changes when you generate one. Nothing else touches it.

### Your own project notes

The plugin does not create notes any more. It links to notes you already have,
and picks between them in this order:

1. A note whose frontmatter says `tracked: <project name>`. Explicit, and it
   survives renaming the note.
2. A note named after the project whose frontmatter says `tracked: true`.
3. A note named after the project, marked or not.

Step 3 is a guess, and on a large vault it will occasionally guess wrong: a
project called `api-ai` will link to somebody else's `api-ai.md`. Both `tracked`
forms override it. Add `tracked: <project name>` to any note to say exactly
what it belongs to, which is worth doing once per project rather than trusting
filenames forever.

### Upgrading from the per-project notes

v0.1 wrote one note per project plus a `<name>-ai.md` summary note for each project
you generated a summary for. This version owns one dashboard note instead, and on
your first scan it copies the AI summary text out of those `-ai` notes and into the
summaries section.

**Nothing is deleted.** The old notes stay exactly where they are, unreferenced by the
plugin, and a notice tells you which folders they are in once you are happy with the
dashboard. The frontmatter on those notes (pins, dirty counts, summary freshness) was
already moved into `data.json` when you upgraded, so it is safe to delete them. Copy
anything you wrote in them somewhere else first: the body of a project note is yours and
the plugin never copied it anywhere.

The copy runs once. If you delete the dashboard without keeping the old notes, those
summaries are gone, which is the only way to lose them.

Pin ranks, the previous scan's dirty counts and AI summary freshness are kept in
the plugin's own `data.json` rather than in your notes, so editing `pinned` or
`dirty` in a note has no effect on the panel. Nothing in your notes is read back
except the `tracked` key above.

## Usage

- Click the git-branch ribbon icon, or run "Project Tracker: Open Project Tracker".
- "Project Tracker: Rescan projects" rescans without opening the panel.
- Right-click a row to pin, unpin, reorder, or open the note.

## Settings

- **Scan root**: absolute path scanned for repositories. Defaults to
  `~/Documents/projects`.
- **Dashboard folder**: vault-relative folder holding `Dashboard.md`, picked
  from the folders in your vault. Defaults to `Project Tracker`. Move it under
  `private/` if you publish your vault and would rather the dashboard stayed out
  of published builds.
- **Show dormant projects**: toggle visibility of dormant projects.

## Build

```sh
pnpm install
pnpm dev      # watch build
pnpm build    # typecheck + production bundle to main.js
pnpm test     # node --test, runs the src/*.test.ts suites
```

Deploy by copying `main.js`, `manifest.json`, and `styles.css` into
`<vault>/.obsidian/plugins/project-tracker/`.