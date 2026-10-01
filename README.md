# Project Tracker

An Obsidian sidebar plugin that shows which local git projects you are actually
working on, ranked, with one note per project in your vault.

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

## Notes in your vault

Each project gets one note under `private/Project Tracker/projects/`. The plugin
manages only these frontmatter keys:

`project`, `repo_path`, `remote`, `github`, `pinned`, `last_commit`, `dirty`,
`branch`, `score`, `status`

The body of the note is yours. The plugin never reads, rewrites, or deletes it.
Pin a project by editing `pinned` in the note's frontmatter, or by
right-clicking it in the sidebar.

Keeping the folder under `private/` means your Quartz config's
`ignorePatterns` leaves these notes out of published builds.

## Usage

- Click the git-branch ribbon icon, or run "Project Tracker: Open Project Tracker".
- "Project Tracker: Rescan projects" rescans without opening the panel.
- Right-click a row to pin, unpin, reorder, or open the note.

## Settings

- **Scan root**: absolute path scanned for repositories. Defaults to
  `~/Documents/projects`.
- **Notes folder**: vault-relative folder for generated notes.
- **Show dormant projects**: toggle visibility of dormant projects.

## Build

```sh
pnpm install
pnpm dev      # watch build
pnpm build    # typecheck + production bundle to main.js
pnpm test     # node --test, runs src/rank.test.ts
```

Deploy by copying `main.js`, `manifest.json`, and `styles.css` into
`<vault>/.obsidian/plugins/project-tracker/`.