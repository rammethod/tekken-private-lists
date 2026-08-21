# 拳トモくん repository guide

## What this repository is

- This public repository is the canonical development source for 拳トモくん / Kentomo.
- `index.html` is the GitHub Pages entry point and loads the public JS/CSS files from this repository.
- The application itself remains a static browser app. `package.json` / `package-lock.json` exist for pinned validation and deployment tooling; do not introduce a bundler or framework migration unless explicitly requested.
- Cloudflare Worker source is versioned in GitHub. Manual Dashboard copy/paste is not a canonical development path.

## Repository map

- `index.html` is the deployable public HTML.
- `user-lists-prototype.js/css`, `stats-integration-v4.js/css`, `stats-pentagon-prototype.js/css`, and `admin-access-prototype.js/css` are public application sources loaded by `index.html`.
- `worker/ewgf-worker-with-stat-pentagon.js` is the canonical Cloudflare Worker source.
- `wrangler.toml` records the reviewed Worker target/settings. Secret values never belong in this file.
- `tools/check-repo.mjs` performs repository/static/secret-shape checks.
- `tools/inspect-worker.mjs` performs read-only Cloudflare Worker state inspection.
- `tools/deploy-worker.mjs` is the guarded production Worker deployment path and requires explicit operator gates plus fresh remote-state checks.
- `firebase/candidates/` contains Firebase Realtime Database Rules candidates only.
- `FIREBASE RULES CANONICALITY: UNRESOLVED`. Do not infer that any candidate is the currently published production Rules.
- `tests/` contains deterministic Node tests when a behavior contract has been extracted for testing.
- `html2canvas.min.js` is vendored/minified dependency code; do not edit it as ordinary source.

## Canonical development boundary

- GitHub is the development code source of truth.
- Prefer GitHub/current provider evidence over old local copies or old handoff notes when they disagree.
- Do not copy repo-external prototype Worker/Rules files over the canonical GitHub versions without explicit review.
- Keep CURRENT branch/SHA/deployment IDs out of this guide; resolve mutable state from GitHub/provider evidence when needed.

## Stable invariants

- Firebase Realtime Database and Firebase compat Auth are the application backend.
- User data is scoped under `users/{uid}`. Shared-list views are read-only to viewers.
- `listIndex` is the lightweight list catalog; full member data remains under owner lists.
- EWGF profile, Wavu ratings, and latest battle/activity are separate freshness domains. Do not collapse them into one player-wide freshness timestamp.
- Browser `Date.now()`, `cachedAt`, `updatedAt`, request start/completion time, and Worker cache timestamps are not source-data freshness authority.
- Late older source payloads must not be allowed to roll newer persisted stats backward.
- Preserve existing script load order and public storage/Firebase compatibility unless the task explicitly includes a migration.
- When an external JS/CSS file changes, update the corresponding cache-busting query string in `index.html` if the deployed asset URL requires it.

## Change discipline

- Search for existing helpers/guards before adding new abstractions.
- Use targeted reads around matched functions and their callers before editing large JS/HTML files.
- Keep changes narrow, reversible, and behavior-preserving.
- Do not split monolithic files merely for cleanliness; first pin behavior with tests where feasible.
- Do not perform unrelated formatting sweeps, renames, dependency upgrades, cleanup, or refactors inside a bounded mission.
- Preserve dirty human worktrees. Never stash/reset/discard unrelated changes automatically.
- Inspect the final diff and run `git diff --check` before push/review.

## Security and data boundaries

- This repository is public. Never commit or quote secret values.
- Forbidden repository material includes API credentials, bearer tokens, Cloudflare secret values, Firebase service-account secrets/private keys, access/refresh tokens, cookies/sessions, `.env`, `.dev.vars`, private user data, Firebase dumps, credential-bearing logs, and machine-local backups.
- Runtime secret binding names may be versioned; secret values may not.
- The Worker must fail closed when a required credential binding is missing.
- Firebase client configuration is public by design; authorization comes from Firebase Rules.
- Do not weaken owner checks or shared-view read-only behavior to make a test pass.
- Real exports/member records are private user data and must not be added to this public repository or fixtures.

## Cloudflare Worker workflow

- Prefer official Cloudflare documentation/current behavior over guessing about Wrangler, Versions, Deployments, Preview URLs, secrets, routes, cron, or compatibility settings.
- Canonical read-only checks:
  - `npm run check`
  - `npm run inspect:worker`
- Production Worker changes require Lead Engineer review.
- Use preview/version validation before production cutover when practical.
- Prefer promoting the exact validated Worker version rather than rebuilding a different artifact for production.
- Do not run `wrangler secret put`, change routes/cron/domains, or alter production traffic unless the active mission explicitly authorizes it.

## Firebase Rules workflow

- Rules files in this repository are candidates until production canonicality is explicitly established.
- Rules publication is a separate production operation requiring Lead Engineer review.
- Do not publish Rules merely because a candidate parses or because local behavior appears correct.
- Read current production state before a Rules cutover when provider access allows it.

## Verification

- Install pinned tooling with `npm ci` when dependencies are needed.
- Run `npm run check` for repository/static checks.
- Run scoped deterministic tests required by the mission, such as `npm run test:freshness` when the freshness contract is involved.
- Run `node --check` on changed standalone JavaScript where applicable.
- Run `git diff --check` before commit/push.
- Static checks do not prove browser interaction, Firebase permissions, or production runtime behavior; use bounded provider/runtime evidence for those boundaries.

## Do not do

- Do not reintroduce Dashboard copy/paste as the canonical Worker deployment workflow.
- Do not commit secret values or private user data.
- Do not treat Firebase Rules candidates as production canonical without evidence.
- Do not use browser-local clocks as cross-device/source freshness authority.
- Do not add ordinary-user unbounded `force=1` refreshes or broad external load tests.
- Do not perform production deploys, Rules publishes, destructive database operations, or unrelated refactors outside the explicitly reviewed mission.
