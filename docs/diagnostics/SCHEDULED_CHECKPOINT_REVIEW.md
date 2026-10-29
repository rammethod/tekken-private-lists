# Scheduled bounded checkpoint review — Issue #32

Authority: [Lead #6484906650](https://github.com/rammethod/tekken-private-lists/issues/32#issuecomment-6484906650).
Base: `ba880ad91095b57a9ae88e4b347b4965cb7fc82e`, revalidated remote main before work.
Scope: **code-only Draft PR / PRODUCTION HOLD**. No production upload, deploy, merge,
Firebase operation, forced Cron, profiler retry, or persistent observability change.
The existing 57.77% resource failures and one successful Scheduled 648ms invocation
remain separate historical evidence. This patch does not establish their cause or fix them.

## Diagnostic contract

Only the Scheduled handler creates the invocation-local recorder. HTTP/fetch does
not create or pass it, including HTTP automation-status diagnostics. Optional
checkpoint arguments are otherwise null. There is no flag/secret/config change.

Each new diagnostic is one string beginning `KENTOMO_SCHEDULED_CHECKPOINT`, followed
by a fixed stage enum and fixed outcome (`begin`, `done`, `failed`, `skipped`). Only
`due_selected` can append `due=0` or `due=1`, from the existing bounded `due.length`.
There are no timestamps, correlation IDs, player/user/list/share identifiers,
URLs, payloads, exception objects/messages/stacks, or credential values.

The recorder consumes one of **12 slots before attempting console.log**. A failed
sink is swallowed inside diagnostics only, consumes its slot, and is never retried.
Existing business catches, legacy console warnings/errors, Promise/await sites,
and `ctx.waitUntil` remain in place. The cap and no-sensitive-output guarantees
cover the **new prefixed checkpoint strings**, not Cloudflare envelopes or legacy
error logs that this change neither creates nor broadens.

| Path | New checkpoint sequence | Maximum events |
|---|---|---:|
| Idle | scheduled begin, oauth done, users begin, due_selected done due=0, award done, diagnostics done, status done | 7 |
| Due success | scheduled begin, oauth done, users begin, due_selected done due=1, source begin/done, targets begin/done, cas done, award skipped, diagnostics done, status done | 12 |
| Source/target/CAS failure | failed marker for current stage, then the original backoff/award/diagnostics/status work | <=12 |
| Status failure/fallback | failed marker, then original failed PATCH; fallback result logged only if a slot remains | <=12 |
| OAuth failure twice | oauth failed, original retry to obtain token for failed PATCH, status_fallback failed | <=12 |
| HTTP | none | 0 |

No marker is inserted into an unbounded users/list/member traversal or into CAS
retry loops. Due-loop instrumentation is bounded by existing
`BACKGROUND_SYNC_PER_TICK=1`. The invocation-local count resets on repeat Cron;
there is no cross-invocation queue, array, cache, or retained payload.

## What a marker means

`users begin` through `due_selected done` covers users fetch/parse, target/share
traversal, state fetch, filtering and sort. It does not distinguish all of those
substeps. `targets` retains the **fresh users re-read** in the due publisher.
`cas` covers canonical/view persistence and existing shared updatedAt writes.
No extra Firebase read, early skip, request reorder, source/ACL/CAS shortcut or
award-window guard is introduced. The formatter optimization is excluded.

Primary diagnostic value is stage entry/completion presence. It is **not a CPU
timer**. No Date/performance readings are added. On Workers these clocks do not
advance during CPU-only work without I/O; a 0ms delta cannot prove zero CPU.

Missing markers are ambiguous: logger failure, provider sampling/drop, resource
termination, transport loss and the 12-event cap can all hide them. In the worst
due status failure, the failure marker uses slot 12 and the later successful or
failed fallback PATCH marker is intentionally absent. The PATCH still executes.
Concurrent Scheduled logs have no application correlation ID; only an existing
provider invocation envelope may group them. Without that envelope, interleaved
strings cannot reliably be assigned to one invocation. A last marker is a lead
for investigation, not `CAUSE_PROVEN` or proof that the next stage never ran.

## Compatibility evidence

`tests/helpers/scheduled-checkpoint-harness.mjs` reads the exact baseline from
Git history and fails closed if unavailable; shallow clones must fetch the base
commit before running these tests. No provider/network call is made by the tests.
Synthetic auth and source boundaries are substituted; real Firebase request,
fresh-target, source-snapshot and CAS helpers use a strict local mock transport.

Before/after tests compare request method/order/count/headers/body, final database,
auth/source call counts, return/error result, legacy logging and waitUntil count.
They cover idle, due success, the previous seven failure cases, OAuth/status
failures, failed PATCH vs successful PUT, source failure, real CAS exhaustion at
three attempts, reset even when disabled, fresh target deletion, ambiguous shared
ownership, newer canonical source, repeated Cron, sink throw and dropped records,
invalid date, JST month-end/new-year/leap boundaries and HTTP silence.
An additional 1,152 date fixtures plus invalid inputs remain equivalent. The HTTP
handler text (after line-ending normalization) and total await-site count are
identical to baseline. Existing 77 stats and four token-reuse tests are preserved.
Final scoped test count: 41 new tests plus four original token-reuse tests (45).
The 41 include the 1,152-date batch, HTTP automation-status parity, invalid enum
rejection and 100 attempted emits staying at 12. Simulated every-second-log loss
receives six of the 12 due-success records with unchanged business traces; this
is a controlled test of ambiguity, not a measured provider drop rate.
Final verification: `npm run check` PASS; all repository tests **126 PASS**
(including stats77, token4, checkpoints41 and existing inspection tests4).
Local Wrangler dry-run PASS, with no upload/deploy. Candidate bundled JS is
136,151 bytes, SHA256
`3c6aa56a97bfdfe65dc3c8f00ffbc554c7b3b4f4ed3650403a25b145298ffa71`.
`git diff --check` PASS. Remote main was rechecked unchanged before final handoff.

## Offline overhead and limits

Reproduce with `npm run bench:scheduled-checkpoints`. Full raw numbers and method:
[`scheduled-checkpoint-overhead.json`](./scheduled-checkpoint-overhead.json).
Pinned installed Miniflare 5.20260820.0-alpha/workerd and compatibility 2026-07-23
were used. No dependencies, version or runtime configuration were changed.

| Measurement | Baseline | With checkpoints | Difference / interpretation |
|---|---:|---:|---|
| workerd warm idle wall median ms/tick | 0.08997 | 0.13037 | +0.04040 ms |
| workerd warm due wall median ms/tick | 0.05444 | 0.10281 | +0.04837 ms |
| workerd cold idle host wall median ms | 18.6574 | 19.6625 | +1.0051 ms; includes compilation/IPC, not CPU |
| workerd cold due host wall median ms | 18.6058 | 19.5753 | +0.9695 ms; same limitation |
| Node cold VM declaration/helper CPU ms/context | 0.235 | 0.390 | +0.155 ms; not full cold handler/Workers CPU |
| Node warm emitter CPU, 12 events/invocation | — | 0.001015 ms | 200,000 invocations, quantized process CPU |

Warm workerd alternates 10 batches of 250 ticks per variant/path; cold uses eight
fresh isolates per variant/path. Actual console calls are included, Miniflare
host log output is disabled. Auth/Firebase/profile/CAS are synthetic no-ops and
payloads are small. Host monotonic wall measurements include IPC; Node process
CPU is not Cloudflare provider CPU. Cold variance is substantial; the initial
run showed +0.81–1.08ms host wall differences too. Do not discard that cost or
claim Free CPU compliance. These probes are diagnostic-overhead estimates only,
not performance tests of the real 648ms workload or a justification to deploy.

The predeclared local review gate is <0.5ms added **warm median wall** per tick and
<0.5ms Node emitter CPU per invocation. It passed; neither gate measures cold
provider CPU. Cold CPU and real log-sink behavior remain material release-review
limitations. Lead may reject a rollout even though code-review tests pass.

Heap: <=12 new records, each <100 UTF-8 bytes (test asserted), so <=1,200 bytes of
logical checkpoint message content per invocation. This is **not** a V8 heap
bound: strings/closures/platform buffering have additional costs. Node used-heap
delta over 200,000 invocations was +32,079,320 bytes before GC and -248,600 bytes
after GC relative to the initial reading; these are GC-dependent net values,
not peak/per-invocation/workerd heap. No diagnostic array or error/payload is held
in the production recorder. Workerd peak heap/provider log-buffer allocation
was not measured and must not be claimed safe by the logical message bound.

## Handoff / release gate

This Draft is for exact-head Lead review only. Tests and the local warm gate do
not authorize a production observability enablement or prove the CPU incident
resolved. A separate Owner+Lead operation would have to review cold/heap limits,
log retention, natural-tail observation, old version/config, immediate stop
conditions, and rollback tradeoff. Rollback would be a separately authorized
operation, never automatic. No replacement monitoring automation was created.
