# 拳トモくん repository guide

## What this repository is

- `stats-layout-preview` is a Windows working area for a static browser app that manages TEKKEN 8 player lists and displays EWGF/Wavu statistics.
- It is not a package-managed application: there is no `package.json`, lockfile, bundler config, or repository test framework.
- The public Git repository is the nested `tekken-private-lists` directory. Its `index.html` is the GitHub Pages entry point.
- `start-user-lists-prototype.cmd` starts a local Python HTTP server and opens the root `index-user-lists-prototype.html`; this is a local prototype entry, not automatically the public release.

## Repository map

- `tekken-private-lists/index.html` is the deployable public HTML and loads the public `user-lists-prototype.js/css`, `stats-integration-v4.js/css`, `stats-pentagon-prototype.js/css`, and `admin-access-prototype.js/css` files.
- Root `index*.html`, `*prototype*`, and `repair-user-lists.html` are prototypes, recovery tools, or older working copies. Confirm the intended entry point before editing or copying.
- Same-named root and nested files are not assumed to be identical; compare the actual files before synchronizing them. Do not bulk-copy a root HTML file over the public entry point.
- `ewgf-worker-with-stat-pentagon.js` is the local Cloudflare Worker source. It is deployed by replacing the Worker code in Cloudflare Dashboard, not by publishing it in GitHub Pages.
- `firebase-user-lists-admin-rules.json` is the current Rules candidate; `firebase-user-lists-rules-prototype.json` is an older/prototype Rules file. Rules publication is a separate Firebase Console operation.
- `local-tools/kentomo-load-diagnostics` is an owner-operated, bounded diagnostic tool and is intentionally outside the public site.

## Stable invariants

- Firebase Realtime Database and Firebase compat Auth are the application backend. Anonymous Auth is the normal guest path; Google login links or signs into an account for cross-device/account use.
- User data is scoped under `users/{uid}`. `listIndex` is a lightweight list catalog; full member data and `fetchedStats` remain under the owner list. `sharedLists` contains sanitized, read-only public snapshots.
- The admin panel checks `admins/{uid} === true` and must not expose individual users' private list contents. Account/diagnostic nodes are separate from ordinary user lists.
- Shared-list views are read-only. Do not add an owner-list mutation path to public-view code or treat browser-local display state as the authoritative Firebase source.
- EWGF and Wavu have separate responsibilities; the integration layer combines their results and the Worker provides the shared upstream/cache boundary. Preserve the existing load order because legacy inline functions can be overridden by external integration code.
- When an external JS/CSS file changes, update every corresponding cache-busting query string in the public `tekken-private-lists/index.html`.

## Change discipline

- Use targeted `rg` searches and bounded reads for the large HTML/JS files. Read the surrounding function and its callers before editing a match.
- Edit UTF-8 HTML/JS/CSS with `apply_patch` or an explicitly UTF-8-safe tool. Do not use PowerShell default-encoding rewrites or broad replacements on Japanese source files.
- Keep changes narrow and reversible. Inspect `git diff`, run `git diff --check`, and verify that only intended files in the nested public repository are staged.
- A public change requires an intentional update in `tekken-private-lists`; a Worker change requires a full manual Cloudflare deployment; a Rules change requires a full manual Firebase Rules publication and permission verification.
- Do not refactor the monolithic HTML or split/rename integration files merely for cleanliness. Preserve script order, storage keys, Firebase field names, and Worker schemas unless the task explicitly includes a migration.

## Security and data boundaries

- Firebase client configuration is visible by design; authorization comes from Firebase Rules. Do not weaken owner checks or shared-view read-only behavior to make a local test pass.
- The root legacy `index-user-lists-prototype.html` contains a non-empty upstream API-key literal, while the public nested HTML intentionally uses an empty client fallback and the Worker path. Never copy the legacy root HTML or credential values into public files.
- Treat the Worker source, Cloudflare `FIREBASE_SERVICE_ACCOUNT_JSON`, upstream API credentials, and any credential-bearing scratch files as non-public. Secrets belong in Cloudflare Secrets, never in HTML, GitHub, Rules files, logs, or chat.
- `existing-namecard-viewer-list.json` is a legacy export containing member records; treat it as potentially real user data, not disposable test data. Do not publish, normalize, or overwrite it casually.
- `html2canvas.min.js` is a vendored/minified dependency. CDN Firebase/Cropper/fonts/Twemoji assets and generated/static icon files are dependencies or assets, not normal source-edit targets.

## Verification

- From the workspace root, use `node --check` on changed external JS and the Worker; the same command is valid for the public nested copies. There is no npm build or unit-test command to invent.
- In `tekken-private-lists`, run `git diff --check` and verify the working tree/remote state before publishing.
- For the local diagnostic tool, `node .\local-tools\kentomo-load-diagnostics\kentomo-load-diagnostics.mjs --dry-run` performs zero network requests. Network modes require the explicit activation phrase documented in its README and must retain its hard limits.
- Use PowerShell/Node/static checks or HTTP responses for verification. This project does not use the Codex in-app browser; visual or interaction checks that cannot be verified statically are handed to the user for a normal browser.

## Do not do

- Do not put Worker source, Firebase Rules, internal handoff/diagnostic material, real exports, or secrets into the public nested GitHub repository.
- Do not add ordinary-user `force=1` refreshes, unbounded concurrency, or broad external load tests. Prefer the shared Worker cache and the existing staggered update path.
- Do not treat a successful syntax check as visual or Firebase permission proof; verify deployment and data-boundary changes separately.
