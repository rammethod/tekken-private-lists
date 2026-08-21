# Canonical source and deployment boundary

This repository contains the static 拳トモくん frontend and the canonical source
copy of the Cloudflare Worker used by the data-refresh path.

## Sources of truth

- Frontend source is the repository root and its `assets/` directory.
- Worker source is `worker/ewgf-worker-with-stat-pentagon.js`.
- Firebase Rules are preserved as named candidates under `firebase/candidates/`.
- `FIREBASE RULES CANONICALITY: UNRESOLVED`. The candidate files must not be
  treated as proof of the currently published Firebase Rules.

The production Worker settings confirmed during canonical cutover are: name
`tight-bar-55c1`, compatibility date `2026-07-23`, no compatibility flags,
`workers.dev` enabled, Preview URLs disabled, no routes, no custom domains, no
non-secret vars, and cron `*/5 * * * *`. The required runtime secret binding
names `EWGF_PUBLIC_API_KEY` and `FIREBASE_SERVICE_ACCOUNT_JSON` were both
confirmed present after cutover. Secret values were not read or recorded.

The parent checkout copies of the Worker and Rules are retained as provenance
outside this repository. The original Worker is not the sanitized deploy source.

## Secret boundary

`EWGF_PUBLIC_API_KEY` and `FIREBASE_SERVICE_ACCOUNT_JSON` are runtime bindings,
declared as required names in `wrangler.toml` but never as values. Private keys, bearer tokens, API credentials,
`.env`, `.dev.vars`, and `*.local` files must not be committed.

The canonical Worker fails closed when `EWGF_PUBLIC_API_KEY` is not bound. Do not
add a secret value to source, Wrangler config, Rules files, documentation, or
test fixtures.

## Validation

Run the read-only repository checks from this directory:

```text
npm run check
npm run inspect:worker
```

The first command validates JSON, JavaScript syntax, secret-shaped literals,
the canonical Worker path, and whitespace errors. The second command performs
a read-only Cloudflare settings inspection and prints names/types only; it
never prints secret values.

## Deployment guardrails

Worker deployment remains guarded by a fresh read-only confirmation gate and
explicit operator approval. The guarded command is:

```powershell
$env:KENTOMO_ALLOW_WORKER_DEPLOY = "1"
$env:KENTOMO_WORKER_REMOTE_CONFIRMED = "1"
npm run deploy:worker
```

It uses the pinned local Wrangler CLI with `--strict` and `--keep-vars`, and
rechecks the remote settings, including the disabled Preview URLs state, and
requires both pre-existing Cloudflare secret bindings. It does not run
`wrangler secret put`.

Rules deployment requires an explicit candidate and Firebase project:

```powershell
$env:KENTOMO_ALLOW_RULES_DEPLOY = "1"
npm run deploy:rules -- --candidate admin --project <project-id>
```

Select `prototype` only when that candidate has been intentionally reviewed.
The guarded command does not establish which Rules candidate is production
canonical.
