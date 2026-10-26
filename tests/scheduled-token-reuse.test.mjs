import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../worker/ewgf-worker-with-stat-pentagon.js", import.meta.url), "utf8");
function body(name, end) {
  const start = source.indexOf(`async function ${name}(`);
  return source.slice(start, source.indexOf(end, start));
}

for (const scenario of ["idle", "background", "failure"]) {
  test(`scheduled ${scenario} uses one invocation-local OAuth token including status writes`, async () => {
    let oauth = 0;
    const seen = [];
    const run = runInNewContext(`(() => {
      ${body("runScheduledAutomation", "\nexport default")}
      return runScheduledAutomation;
    })()`, {
      Date, console: { error() {} }, WORKER_BUILD: "synthetic",
      async getFirebaseAccessToken() { oauth++; return "synthetic-token"; },
      async runBackgroundSync(_env, token) {
        seen.push(["background", token]);
        if (scenario === "failure") throw new Error("synthetic failure");
        return { processed: scenario === "background" ? 1 : 0, failures: 0 };
      },
      async runAwardAutomation(_env, token) { seen.push(["awards", token]); return { processed: 0 }; },
      async awardDiagnostics(_env, token) { seen.push(["diagnostics", token]); return {}; },
      async firebaseRequest(_env, token, path) { seen.push([path, token]); },
    });
    await run({});
    assert.equal(oauth, 1);
    assert.ok(seen.length >= 2);
    assert.ok(seen.every(([, token]) => token === "synthetic-token"));
    assert.equal(seen.some(([stage]) => stage === "awards"), scenario === "idle");
    assert.equal(seen.at(-1)[0], "automationStatus");
  });
}

test("standalone background and award calls still acquire a token when none is supplied", async () => {
  for (const [name, end] of [["runBackgroundSync", "\nasync function runAwardAutomation"], ["runAwardAutomation", "\nasync function awardDiagnostics"]]) {
    let oauth = 0;
    const run = runInNewContext(`(() => { ${body(name, end)}; return ${name}; })()`, {
      Date, Map, Set, Number, String, Object,
      BACKGROUND_SYNC_SCHEMA: "synthetic", BACKGROUND_SYNC_PER_TICK: 1, BACKGROUND_SYNC_INTERVAL_MS: 100,
      async getFirebaseAccessToken() { oauth++; return "synthetic-token"; },
      async firebaseRequest() { return {}; },
      jstDateParts() { return { year: 2026, month: 10, day: 10 }; },
      awardPeriodKey() { return "2026-10"; }, lastJstDay() { return 31; },
    });
    await run({ FIREBASE_SERVICE_ACCOUNT_JSON: "synthetic-marker" });
    assert.equal(oauth, 1, name);
    await run({ FIREBASE_SERVICE_ACCOUNT_JSON: "synthetic-marker" }, "supplied-synthetic-token");
    assert.equal(oauth, 1, name);
  }
});
