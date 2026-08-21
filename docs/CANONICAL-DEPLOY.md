# Canonical source and deployment boundary

This repository contains the static 拳トモくん frontend and the canonical source
copy of the Cloudflare Worker used by the data-refresh path.

## Sources of truth

- Frontend source is the repository root and its `assets/` directory.
- Worker source is `worker/ewgf-worker-with-stat-pentagon.js`.
- Firebase Rules are preserved as named candidates under `firebase/candidates/`.
- `FIREBASE RULES CANONICALITY: UNRESOLVED`. The candidate files must not be
  treated as proof of the currently published Firebase Rules.

The parent checkout copies of the Worker and Rules are retained as provenance
outside this repository. The original Worker is not the sanitized deploy source.

## Secret boundary

`EWGF_PUBLIC_API_KEY` and `FIREBASE_SERVICE_ACCOUNT_JSON` are runtime bindings,
not repository configuration. Private keys, bearer tokens, API credentials,
`.env`, `.dev.vars`, and `*.local` files must not be committed.

The canonical Worker fails closed when `EWGF_PUBLIC_API_KEY` is not bound. Do not
add a secret value to source, Wrangler config, Rules files, documentation, or
test fixtures.

## Validation

Run the read-only repository checks from this directory:

```text
npm run check
```

The check validates JSON, JavaScript syntax, secret-shaped literals, the
canonical Worker path, and whitespace errors. It does not contact production.

## Deployment guardrails

Worker deployment is intentionally unresolved until Lead Engineer review fills
in the Worker name, compatibility date, and scheduled trigger in
`wrangler.toml`. The guarded command is:

```powershell
$env:KENTOMO_ALLOW_WORKER_DEPLOY = "1"
npm run deploy:worker
```

It also requires the `wrangler` CLI and pre-existing Cloudflare secret bindings.
Do not run it until the target settings and bindings are independently confirmed.

Rules deployment requires an explicit candidate and Firebase project:

```powershell
$env:KENTOMO_ALLOW_RULES_DEPLOY = "1"
npm run deploy:rules -- --candidate admin --project <project-id>
```

Select `prototype` only when that candidate has been intentionally reviewed.
The guarded command does not establish which Rules candidate is production
canonical.
