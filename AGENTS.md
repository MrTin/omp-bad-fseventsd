# omp-bad-fseventsd: agent instructions

An omp extension for macOS. Bun + TypeScript, no build step, no runtime dependencies.

## Layout

| File | Role | Rule |
|---|---|---|
| `src/scan.ts` | Parsing: top, helper output, ps, fseventsd history | Pure: no I/O. Every behaviour change gets a case in `test/scan.test.ts` |
| `src/system.ts` | OS boundary: top, ps, sudo, osascript, the history snapshot, install scripts | Takes `exec` |
| `src/store.ts` | Settings, shared state, leader lease | Settings are declared once in `package.json#omp.settings`; never hardcode a default here |
| `src/index.ts` | omp wiring: timer, warnings, `/fsnuke` | Keep logic out of it |
| `helper/omp-bad-fseventsd.sh` | The root helper | Runs as root. See Rules |

## Commands

```bash
bun install          # dev types only
bun test             # unit tests; nothing needs root
bun run check        # tsc --noEmit
omp plugin link .    # load this checkout in omp; restart omp after changes
```

## Rules

- Nothing restarts `fseventsd` without the user confirming in `/fsnuke`. No timer, tool or agent message may call `runHelper(…, "restart")`.
- Root-side limits (floor, rate limit, binary path, logging) live in `helper/omp-bad-fseventsd.sh`, never in TypeScript: anything the user can write, an agent can write.
- The helper takes no input besides `clients` or `restart`. Adding a command means changing the sudoers line in `installScript` too, and the test that runs it through `visudo`.
- Changing the helper makes installed copies show as `outdated`; mention `/fsnuke install` in the CHANGELOG entry.
- A new setting goes in `package.json#omp.settings` with `default`, `env` (`OMP_BAD_FSEVENTSD_*`) and `description`, plus a row in the README settings table.
- Commit no personal paths, session ids, hostnames or credentials. Tests use fake ids and temp dirs (`test/setup.ts`).
- No runtime dependencies. `@oh-my-pi/*` imports resolve to the host omp at runtime, and omp's internals change between releases: import only types from `pi-coding-agent`, and at runtime nothing beyond the `pi-utils` path helpers already used. UI goes through `ctx.ui` (`notify`, `confirm`, `setWidget` with string lines), never pi-tui components. The daily `latest-omp` CI job checks against the newest omp.

## Workflow

`main` is protected: no direct pushes (admins included), CI (`test (macos-latest)`) must pass, linear history, squash merge only, branches auto-deleted after merge.

```bash
git checkout main && git pull
git checkout -b <type>/<short-description>   # feat/ fix/ chore/ docs/ test/
# ... change, add a CHANGELOG "Unreleased" line if users notice it ...
git push -u origin HEAD
gh pr create --fill
gh pr merge --squash --auto                  # merges once CI is green
```

PR title = the squash commit subject, so write it as a Conventional Commit: `fix: …`, `feat: …`.

## Releasing

Releases are cut from `main`, through a PR like any other change:

1. Branch `release/vX.Y.Z`. Move the `Unreleased` entries in `CHANGELOG.md` under `## X.Y.Z - YYYY-MM-DD`.
2. `npm version X.Y.Z --no-git-tag-version` (bumps `package.json`), commit, PR titled `release: vX.Y.Z`, squash-merge.
3. Tag the merged commit: `git checkout main && git pull && git tag vX.Y.Z && git push origin vX.Y.Z`.
4. The `release` workflow creates the GitHub Release from that CHANGELOG section.

Patch: fixes. Minor: new behaviour or setting. Major: a setting removed or renamed, or anything that restarts with less confirmation than before.
