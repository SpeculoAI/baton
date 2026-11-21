# Contributing

## Workflow

Baton uses trunk-based development. `main` is always releasable and is protected:

- No direct pushes, force-pushes, or deletion of `main`. This applies to admins too.
- Every change lands through a pull request.
- The `ci-ok` check must pass, and the branch must be up to date with `main`.
- All review conversations must be resolved.
- Merges are **squash only**. The PR title becomes the commit on `main`, so main stays linear.

```bash
git switch main && git pull
git switch -c feat/short-description     # or fix/, docs/, chore/, refactor/, test/, ci/
# ...commit as often as you like...
npm test
git push -u origin HEAD
gh pr create --fill
```

Keep branches short-lived (a few days at most) and PRs small enough to review in one sitting. Branches are deleted automatically after merge.

## PR titles

PR titles must follow [Conventional Commits](https://www.conventionalcommits.org/); CI rejects anything else.

```
feat: add --isolate to baton start
fix(cursor): keep --model across reply
docs: explain worktree cleanup
feat!: refuse in-place write jobs on a dirty tree
```

Use `!` (or a `BREAKING CHANGE:` line in the PR body) for anything that changes CLI flags, statuses, JSON fields, or MCP tool contracts.

## CI

`.github/workflows/ci.yml` runs on every PR and every push to `main`:

| Job | What it checks |
|---|---|
| PR title | Conventional Commits format |
| Test | `npm test` (typecheck + `node --test`) on Ubuntu and macOS, Node 24 (the development runtime) |
| dist on Node 20.17 | The built `dist/` starts on the lowest supported Node |
| Package contents | `npm pack` ships `dist/`, `README.md`, `LICENSE` and nothing from `src/` or `test/` |
| Dependency audit | No high-severity advisories in runtime dependencies |
| `ci-ok` | Aggregates the above; this is the single required check |

When CI fails, reproduce it locally with the same command (`npm test`) before pushing a fix.

## Releasing

Versions follow [SemVer](https://semver.org/). Breaking changes bump MAJOR (MINOR while we're in `0.x`).

1. Open a PR titled `chore: release vX.Y.Z` that bumps the version in `package.json` and every manifest. `test/manifests.test.ts` fails if one is missed.
2. Merge it.
3. Tag the merge commit and push the tag:
   ```bash
   git switch main && git pull
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```
4. `.github/workflows/release.yml` then takes over. It verifies that the tag matches `package.json` and is on `main`, runs the tests, publishes to npm with provenance through trusted publishing (no npm token is stored), and creates the GitHub release with generated notes.

Release tags (`v*`) cannot be moved or deleted.

## Local checks

```bash
npm ci
npm test          # typecheck + all tests; uses fake CLIs, spends no model quota
npm run build     # emits dist/
```

Everything in the repository is English. `test/english.test.ts` enforces this, except for the two Chinese manuals.
