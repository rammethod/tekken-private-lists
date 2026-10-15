import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";

import worker from "../worker/ewgf-worker-with-stat-pentagon.js";

// Synthetic credentials are generated per test process. No real Firebase or
// upstream requests are permitted: every network call passes through mockFetch.
const keypair = await webcrypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 1024, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
);
const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey("pkcs8", keypair.privateKey));
const privateKey = `-----BEGIN PRIVATE KEY-----\n${pkcs8.toString("base64").match(/.{1,64}/g).join("\n")}\n-----END PRIVATE KEY-----\n`;
const env = {
  FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: "tests@fixture.invalid", private_key: privateKey }),
  FIREBASE_DATABASE_URL: "https://firebase-fixture.invalid",
};

async function runScheduledFixture({ users = {}, schedules = {}, state = {}, failUsers = false, rejectUpstream = false } = {}) {
  const originalFetch = globalThis.fetch;
  const originalCrypto = globalThis.crypto;
  const requests = [];
  let authRequests = 0;
  let awaitedTask;
  let statusBody = null;
  const storedSchedules = structuredClone(schedules);

  globalThis.crypto = webcrypto;
  globalThis.fetch = async (url, options = {}) => {
    const target = new URL(String(url));
    const method = options.method || "GET";
    if (target.hostname === "oauth2.googleapis.com" && target.pathname === "/token") {
      assert.equal(method, "POST");
      authRequests += 1;
      requests.push("POST oauth");
      return Response.json({ access_token: "synthetic-access-token" });
    }
    if (target.hostname === "ewgf.gg" || target.hostname === "wank.wavu.wiki") {
      requests.push(`${method} ${target.hostname}${target.pathname}`);
      if (!rejectUpstream) throw new Error("Unexpected upstream request in fixture");
      return new Response("", { status: 503 });
    }
    assert.equal(target.hostname, "firebase-fixture.invalid", `Unexpected network request: ${target.hostname}`);
    assert.ok(target.pathname.endsWith(".json"), "Firebase request must target a JSON endpoint");
    assert.equal(options.headers?.Authorization, "Bearer synthetic-access-token");
    const path = target.pathname.slice(1, -5).split("/").map(decodeURIComponent).join("/");
    requests.push(`${method} ${path}`);
    if (method === "GET") {
      if (path === "users" && failUsers) return new Response("unavailable", { status: 503 });
      const value = path === "users" ? users
        : path === "backgroundSyncState" ? state
        : path === "awardSchedules" ? storedSchedules
        : path === "awardRuns" ? {}
        : null;
      assert.notEqual(value, null, `Unexpected Firebase GET: ${path}`);
      return Response.json(value);
    }
    const body = options.body === undefined ? null : JSON.parse(options.body);
    if (method === "PUT" && path === "automationStatus") {
      statusBody = body;
      return Response.json(body);
    }
    if (method === "PATCH" && path === "automationStatus") {
      statusBody = body;
      return Response.json(body);
    }
    if (method === "PUT" && path.startsWith("backgroundSyncState/")) return Response.json(body);
    if (method === "DELETE" && path.startsWith("awardRuns/")) return Response.json(null);
    if (method === "PATCH" && path.startsWith("awardSchedules/")) {
      const [uid, listId] = path.slice("awardSchedules/".length).split("/");
      storedSchedules[uid][listId] = { ...storedSchedules[uid][listId], ...body };
      return Response.json(storedSchedules[uid][listId]);
    }
    assert.fail(`Unexpected Firebase mutation: ${method} ${path}`);
  };

  try {
    await worker.scheduled({}, env, { waitUntil(task) { awaitedTask = task; } });
    assert.ok(awaitedTask, "scheduled must register waitUntil");
    await awaitedTask;
    return { authRequests, requests, statusBody };
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.crypto = originalCrypto;
  }
}

test("idle Cron signs one Firebase JWT and preserves award diagnostics/status", async () => {
  const result = await runScheduledFixture();
  assert.equal(result.authRequests, 1, "single Cron invocation should reuse its OAuth token");
  assert.deepEqual(result.requests, [
    "POST oauth",
    "GET users",
    "GET backgroundSyncState",
    "GET awardSchedules",
    "GET awardSchedules",
    "GET awardRuns",
    "PUT automationStatus",
  ]);
  assert.equal(result.statusBody.ok, true);
  assert.equal(result.statusBody.background.processed, 0);
  assert.equal(result.statusBody.awards.processed, 0);
  assert.equal(result.statusBody.awardData.totalSchedules, 0);
});

test("monthly award reset preserves DELETE/PATCH/status with one OAuth token", async () => {
  const result = await runScheduledFixture({
    schedules: { owner1: { list1: { enabled: false, resetRequestedAt: 1 } } },
  });
  assert.equal(result.authRequests, 1);
  assert.equal(result.requests.filter(call => call === "DELETE awardRuns/owner1/list1/" + result.statusBody.awardData.period).length, 1);
  assert.ok(result.requests.includes("PATCH awardSchedules/owner1/list1"));
  assert.equal(result.statusBody.awards.processed, 1);
  assert.equal(result.statusBody.awardData.totalSchedules, 1);
  assert.equal(result.statusBody.awardData.enabledSchedules, 0);
});

test("due player upstream failure preserves backoff/status without paid API calls", async () => {
  const result = await runScheduledFixture({
    users: { owner1: { lists: { list1: { members: { member1: { gameId: "ABC123" } } } } } },
    rejectUpstream: true,
  });
  assert.equal(result.authRequests, 1);
  assert.ok(result.requests.includes("GET ewgf.gg/player/ABC123"));
  assert.ok(result.requests.includes("GET wank.wavu.wiki/player/ABC123"));
  assert.ok(result.requests.includes("PUT backgroundSyncState/ABC123"));
  assert.equal(result.requests.some(call => call.includes("/battles")), false, "must not spend paid EWGF battles API");
  assert.equal(result.statusBody.ok, false);
  assert.equal(result.statusBody.background.failures, 1);
});

test("Firebase read failure preserves fail-closed error status on a fallback OAuth", async () => {
  const result = await runScheduledFixture({ failUsers: true });
  assert.equal(result.authRequests, 2, "error status continues to use a fresh fallback token");
  assert.ok(result.requests.includes("PATCH automationStatus"));
  assert.equal(result.statusBody.ok, false);
  assert.ok(String(result.statusBody.error).includes("Firebase RTDB GET 503"));
});
