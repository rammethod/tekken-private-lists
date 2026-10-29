import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { baseline, candidate, run, prefix } from "./helpers/scheduled-checkpoint-harness.mjs";

const specs = [
  ["idle", {}], ["due", { due: true }], ["OAuth failure", { oauthFailure: true }],
  ["users read", { fail: "GET users#1" }], ["state read", { fail: "GET backgroundSyncState#1" }],
  ["schedule read", { fail: "GET awardSchedules#1" }],
  ["individual award GET retains failed PATCH", { fail: "GET awardRuns/owner/list/2026-10#1" }],
  ["diagnostics schedule", { fail: "GET awardSchedules#2" }], ["diagnostics runs", { fail: "GET awardRuns#1" }],
  ["source failure", { due: true, sourceFailure: true }], ["CAS exhausted", { due: true, casConflict: true }],
  ["status PUT fallback", { fail: "PUT automationStatus#1" }], ["status PUT and PATCH fail", { fail: "status-all" }],
  ["due status failure worst cap", { due: true, fail: "status-all" }],
  ["due retry state fails", { due: true, fail: "PUT backgroundSyncState/SYNTHETIC_001#1" }],
  ["award reset", { reset: true }], ["disabled reset still runs", { reset: true, disabled: true, epoch: Date.UTC(2026, 9, 31, 15) }],
  ["fresh target deleted", { due: true, freshDelete: true }], ["ambiguous share", { due: true, sharedCollision: true }],
  ["newer canonical source retained", { due: true, newerCanonical: true }],
  ["repeat Cron", { repeat: 2 }], ["sink throws", { due: true, sinkThrows: true }],
  ["dropped logs", { due: true, dropEvery: 2 }], ["invalid date", { epoch: NaN }], ["HTTP no markers", { http: true }],
  ["HTTP diagnostics no markers", { http: true, httpStatus: true }],
];
for (const [year, month, day] of [[2026, 0, 1], [2026, 11, 31], [2028, 1, 29], [2026, 1, 28]]) for (const delta of [-1, 0, 1]) specs.push([`JST boundary ${year}/${month + 1}/${day}/${delta}`, { epoch: Date.UTC(year, month, day, 15) + delta, emptyAward: true }]);

for (const [name, spec] of specs) test(`Scheduled checkpoint parity: ${name}`, async () => {
  const a = await run(baseline, spec), b = await run(candidate, spec);
  for (const key of ["trace", "db", "tokenCalls", "profileCalls", "snapshots", "error", "httpResult", "legacy"]) assert.deepEqual(b[key], a[key], key);
  assert.ok(b.attempts.length <= 12 * (spec.repeat ?? 1));
  for (const event of b.attempts) {
    assert.equal(typeof event, "string");
    assert.match(event, /^KENTOMO_SCHEDULED_CHECKPOINT (scheduled|oauth|users|due_selected|source|targets|cas|retry_state|award|diagnostics|status|status_fallback) (begin|done|failed|skipped)( due=[01])?$/);
    assert.ok(Buffer.byteLength(event) < 100);
    assert.doesNotMatch(event, /SENSITIVE|SYNTHETIC|owner|member|https?:|\d{4}-|TOKEN|Error/);
  }
  if (spec.http) assert.equal(b.attempts.length, 0);
  if (name === "due") {
    assert.equal(b.attempts.length, 12);
    assert.deepEqual(b.attempts, ["scheduled begin", "oauth done", "users begin", "due_selected done due=1", "source begin", "source done", "targets begin", "targets done", "cas done", "award skipped", "diagnostics done", "status done"].map(x => prefix + x));
    assert.equal(b.trace.filter(x => x.method === "GET" && x.path === "users").length, 2);
  }
  if (name === "idle") assert.equal(b.attempts.length, 7);
  if (name === "individual award GET retains failed PATCH") assert.equal(b.trace.at(-1).method, "PATCH");
  if (name === "CAS exhausted") assert.equal(b.trace.filter(x => x.path.startsWith("workerStatsByGameId/") && x.method === "PUT").length, 3);
  if (name === "fresh target deleted") assert.equal(b.trace.some(x => x.method === "PUT" && x.path.includes("workerFetchedStats")), false);
  if (name === "ambiguous share") assert.equal(b.trace.some(x => x.method === "PUT" && x.path.startsWith("sharedLists/")), false);
  if (name === "newer canonical source retained") assert.equal(b.db.workerStatsByGameId.SYNTHETIC_001.sourceSnapshots.ewgfProfile.revisionAt, Date.parse("2026-10-01T00:00:00Z"));
  if (name === "dropped logs") assert.equal(b.diagnostic.length, 6);
});

test("recorder rejects dynamic values and cannot exceed 12 attempts", () => {
  const messages = [];
  const helper = candidate.slice(candidate.indexOf("const SCHEDULED_CHECKPOINT_STAGES"), candidate.indexOf("\nfunction base64Url"));
  const create = vm.runInNewContext(helper + ";createScheduledCheckpoints", { console: { log: x => messages.push(x) } });
  const cp = create();
  cp.emit("SENSITIVE_FIXTURE_STAGE", "done", { private: "SENSITIVE" });
  cp.emit("oauth", "SENSITIVE_FIXTURE_OUTCOME");
  cp.emit({ toString() { throw Error("not allowed"); } }, "done");
  for (let i = 0; i < 100; i++) cp.emit("due_selected", "done", { private: "SENSITIVE" });
  assert.equal(messages.length, 12);
  assert.ok(messages.every(x => /^KENTOMO_SCHEDULED_CHECKPOINT (scheduled begin|due_selected done)$/.test(x)));
});

test("1152 original date cases and invalid-date errors unchanged", () => {
  const load = s => vm.runInNewContext(`(${s.slice(s.indexOf("function jstDateParts("), s.indexOf("\nfunction awardPeriodKey"))})`, { Date, Intl });
  const a = load(baseline), b = load(candidate); let count = 0;
  for (const year of [1970, 1999, 2000, 2024, 2026, 2028, 2099, 2100]) for (let month = 0; month < 12; month++) for (const day of [1, 2, 28, new Date(Date.UTC(year, month + 1, 0)).getUTCDate()]) for (const delta of [-1, 0, 1]) {
    const d = new Date(Date.UTC(year, month, day, 15) + delta);
    assert.equal(JSON.stringify(a(d)), JSON.stringify(b(d))); count++;
  }
  assert.equal(count, 1152);
  for (const value of [new Date(NaN), NaN, Infinity]) for (const fn of [a, b]) assert.throws(() => fn(value), { name: "RangeError" });
});

test("HTTP handler bytes and await sites remain identical", () => {
  const http = s => s.slice(s.indexOf("  async fetch(request, env, ctx)"), s.indexOf("  async scheduled(controller"));
  assert.equal(http(candidate), http(baseline));
  assert.equal((candidate.match(/\bawait\b/g) ?? []).length, (baseline.match(/\bawait\b/g) ?? []).length);
  assert.equal(candidate.includes("IO_BOUNDARY_TIME"), false); // no time/CPU measurements emitted
});
