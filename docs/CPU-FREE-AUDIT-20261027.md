# Workers Free CPU investigation — 2026-10-27 JST

Status: PARTIAL. No production cutover and no claim of CPU-limit compliance.

Cloudflare adaptive Analytics initially returned approximately 294 invocations / 187 `exceededResources` outcomes over the preceding 24 hours, and 2,203 / 1,797 over seven days. These are provider aggregates, not exact unsampled CPU-event counts. The Worker has one five-minute Cron; no service binding, Queue, Workflow, route or custom domain was found for it. The active deployed source was downloaded privately before changes and checked directly for the affected scheduled functions.

The production tail also observed a scheduled invocation reported as `ok` with CPU 45 ms and elapsed time 3,418 ms. A successful outcome is not proof of fitting the Free 10-ms CPU allowance. Profile capture returned `No recent executions were found for this Worker.` The exact hot function remains unverified; resource-limit aggregates do not independently distinguish every CPU or memory failure.

## Change

The current scheduled pipeline obtains the same-scope service-account OAuth token separately in background sync, optional award processing and final diagnostics/status recording. Each acquisition reparses the credential, imports the RSA key, signs a JWT and exchanges it for a token. One invocation now acquires one token and passes it explicitly to those stages and failure reporting. The token stays local to that invocation; standalone helper calls still acquire their own token when needed.

No persistent credential cache, schema/Rules change, target membership reuse, source freshness change, increased refresh limits, Cron change or public API change. Full-user-tree reads, repeated persistence target discovery, HTML parsing and ETag reconciliation remain possible CPU contributors. This patch does not claim that reducing repeated OAuth work alone resolves them.

## Validation

- `npm run check`: PASS.
- `node --test tests/*.test.mjs`: 85 passed, including idle/background/failure token reuse, standalone-helper fallback and existing freshness/persistence/parser contracts.
- `git diff --check`: PASS.
- Production CPU before/after comparison: NOT RUN; production code and traffic were not changed.

Production changes still require Lead Engineer review under `AGENTS.md` and `docs/CANONICAL-DEPLOY.md`. Do not set the deploy approval flag solely because local tests pass. After reviewed preview/promotion, compare CPU/resource errors on the exact version, preserve the recorded rollback version, existing bindings and five-minute Cron, and verify source freshness plus owner/shared-view consistency. An invocation may require bounded work decomposition or a free alternative execution architecture if actual parsing/persistence cannot fit the allowance; that has not been decided by this patch.
