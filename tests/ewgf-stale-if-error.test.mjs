import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import worker, {
  buildProfileLastKnownGoodCacheKey,
  buildStaleIfErrorProfileResponse,
  getBoundedLastKnownGoodProfile,
  isRetriableEwgfFailure,
} from "../worker/ewgf-worker-with-stat-pentagon.js";

class MemoryCache {
  constructor() {
    this.entries = new Map();
    this.writeCount = 0;
  }

  keyOf(key) {
    return key?.url || String(key);
  }

  async match(key) {
    const response = this.entries.get(this.keyOf(key));
    return response ? response.clone() : null;
  }

  async put(key, response) {
    this.writeCount += 1;
    this.entries.set(this.keyOf(key), response.clone());
  }
}

const PROFILE_URL = "https://worker.test/profile-v2?ewgfId=synthetic-player";
const SOURCE_OBSERVED_AT = "2026-08-30T10:00:00.000Z";
const SOURCE_REVISION_AT = "2026-08-29T10:00:00.000Z";

const PROFILE_HTML = `
  <img src="/static/rank-icons/tekken-god.png" alt="Tekken God rank icon">
  <span>Tekken Prowess:</span><span class="text-amber-400">123,456</span>
  <table><tbody><tr>
    <td><a href="/character/kazuya">
      <img src="/static/circular_character_icons/kazuya.png" alt="Kazuya">
      <img src="/static/rank-icons/fujin.png" alt="Fujin">
    </a></td>
    <td><span class="text-green-500">10</span><span class="text-red-500">2</span></td>
  </tr></tbody></table>
  <script>
    {"battleAt":"2026-08-29T10:00:00.000Z","battleType":"RANKED_BATTLE","p1PolarisId":"synthetic-player","p1Char":"Kazuya"}
    self.__next_f.push(["1", "{\"statPentagonData\":{\"attack\":80,\"defense\":70,\"technique\":60,\"spirit\":50,\"appeal\":40,\"attackComponents\":{\"a\":20},\"defenseComponents\":{\"a\":20},\"techniqueComponents\":{\"a\":20},\"spiritComponents\":{\"a\":20},\"appealComponents\":{\"a\":20}},\"playedCharacters\":{\"Kazuya\":{\"RANKED_BATTLE\":{\"wins\":10,\"losses\":2,\"characterWinrate\":0.83}}}}"]);
  </script>
`;

function makeCachedProfile(overrides = {}) {
  return {
    ok: true,
    ewgfId: "synthetic-player",
    workerCachedAt: SOURCE_OBSERVED_AT,
    ewgfProfileRevisionAt: SOURCE_REVISION_AT,
    characters: [{ character: "Kazuya", rankIcon: "kazuya-rank.png" }],
    statPentagon: { attack: 80 },
    ...overrides,
  };
}

async function runWorker(cache, requestUrl, fetchImpl, { waitUntil = true } = {}) {
  const tasks = [];
  const response = await worker.fetch(
    new Request(requestUrl),
    {},
    { waitUntil: task => tasks.push(task) },
  );
  if (waitUntil) await Promise.all(tasks);
  return { response, tasks };
}

async function withWorkerGlobals(cache, fetchImpl, callback) {
  const previousCaches = globalThis.caches;
  const previousFetch = globalThis.fetch;
  globalThis.caches = { default: cache };
  globalThis.fetch = fetchImpl;
  try {
    return await callback();
  } finally {
    globalThis.caches = previousCaches;
    globalThis.fetch = previousFetch;
  }
}

test("EWGF retriable status classification excludes definitive invalid/not-found responses", () => {
  for (const status of [429, 500, 502, 503, 504, 522, 524]) {
    assert.equal(isRetriableEwgfFailure(status), true, `status ${status}`);
  }
  for (const status of [400, 401, 403, 404, 422]) {
    assert.equal(isRetriableEwgfFailure(status), false, `status ${status}`);
  }
  assert.equal(isRetriableEwgfFailure(new TypeError("network timeout")), true);
});

test("successful profile refresh writes normal cache and independent bounded LKG cache", async () => {
  const cache = new MemoryCache();
  await withWorkerGlobals(cache, async () => new Response(PROFILE_HTML, { status: 200 }), async () => {
    const result = await runWorker(cache, PROFILE_URL, globalThis.fetch);
    assert.equal(result.response.status, 200);
    assert.equal((await result.response.json()).ok, true);
  });

  const normalKey = new Request("https://worker.test/profile-v2?ewgfId=synthetic-player&schema=profile-20260802-lazy-matchups-v1");
  const lkgKey = buildProfileLastKnownGoodCacheKey(normalKey);
  assert.ok(await cache.match(normalKey), "normal profile cache is populated");
  assert.ok(await cache.match(lkgKey), "last-known-good profile cache is populated");
  assert.equal(cache.writeCount, 2);
});

test("expired normal cache plus retriable 500 serves bounded degraded LKG without changing source timestamps", async () => {
  const cache = new MemoryCache();
  const normalKey = new Request("https://worker.test/profile-v2?ewgfId=synthetic-player&schema=profile-20260802-lazy-matchups-v1");
  const lkgKey = buildProfileLastKnownGoodCacheKey(normalKey);
  await cache.put(lkgKey, new Response(JSON.stringify(makeCachedProfile()), { status: 200 }));
  const writesBefore = cache.writeCount;

  await withWorkerGlobals(cache, async () => new Response("upstream unavailable", { status: 500 }), async () => {
    const { response, tasks } = await runWorker(cache, `${PROFILE_URL}&force=1&pageOpen=1`, globalThis.fetch);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("X-EWGF-Worker-Cache"), "STALE-IF-ERROR");
    assert.equal(response.headers.get("X-EWGF-Profile-State"), "degraded");
    const payload = await response.json();
    assert.equal(payload.degraded, true);
    assert.equal(payload.staleIfError, true);
    assert.equal(payload.workerCachedAt, SOURCE_OBSERVED_AT);
    assert.equal(payload.ewgfProfileRevisionAt, SOURCE_REVISION_AT);
    assert.equal(tasks.length, 0, "degraded replay does not schedule Firebase persistence or throttle writes");
  });

  assert.equal(cache.writeCount, writesBefore, "degraded replay does not write cache entries");
});

test("network timeout and 429 both use LKG, while non-retriable 404 stays failed", async () => {
  const cache = new MemoryCache();
  const normalKey = new Request("https://worker.test/profile-v2?ewgfId=synthetic-player&schema=profile-20260802-lazy-matchups-v1");
  const lkgKey = buildProfileLastKnownGoodCacheKey(normalKey);
  await cache.put(lkgKey, new Response(JSON.stringify(makeCachedProfile()), { status: 200 }));

  await withWorkerGlobals(cache, async () => { throw new TypeError("network timeout"); }, async () => {
    const { response } = await runWorker(cache, `${PROFILE_URL}&force=1`, globalThis.fetch);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).staleIfError, true);
  });

  await withWorkerGlobals(cache, async () => new Response("rate limited", { status: 429 }), async () => {
    const { response } = await runWorker(cache, `${PROFILE_URL}&force=1`, globalThis.fetch);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).staleIfError, true);
  });

  await withWorkerGlobals(cache, async () => new Response("not found", { status: 404 }), async () => {
    const { response } = await runWorker(cache, `${PROFILE_URL}&force=1`, globalThis.fetch);
    assert.equal(response.status, 502);
    assert.equal((await response.json()).staleIfError, undefined);
  });
});

test("repeated degraded refresh remains idempotent and an over-age or contaminated LKG is rejected", async () => {
  const cache = new MemoryCache();
  const key = new Request("https://worker.test/profile-v2?ewgfId=synthetic-player&schema=profile-20260802-lazy-matchups-v1");
  const lkgKey = buildProfileLastKnownGoodCacheKey(key);
  await cache.put(lkgKey, new Response(JSON.stringify(makeCachedProfile()), { status: 200 }));
  const writesBefore = cache.writeCount;

  await withWorkerGlobals(cache, async () => new Response("gateway timeout", { status: 504 }), async () => {
    const first = await runWorker(cache, `${PROFILE_URL}&force=1`, globalThis.fetch);
    const second = await runWorker(cache, `${PROFILE_URL}&force=1`, globalThis.fetch);
    assert.equal(first.response.status, 200);
    assert.equal(second.response.status, 200);
  });
  assert.equal(cache.writeCount, writesBefore, "repeated degraded responses do not churn cache writes");

  const overAge = await getBoundedLastKnownGoodProfile(
    { match: async () => new Response(JSON.stringify(makeCachedProfile({ workerCachedAt: "2026-08-20T10:00:00.000Z" })), { status: 200 }) },
    lkgKey,
    7 * 24 * 60 * 60,
    Date.parse("2026-08-28T10:00:00.000Z"),
  );
  assert.equal(overAge, null);

  const contaminated = await buildStaleIfErrorProfileResponse(
    new Response(JSON.stringify(makeCachedProfile()), { status: 200 }),
  );
  const contaminatedCache = { match: async () => contaminated };
  assert.equal(await getBoundedLastKnownGoodProfile(contaminatedCache, lkgKey), null);
});

test("browser marks stale-if-error as degraded and keeps source freshness anchored to EWGF observation", () => {
  const integration = readFileSync(new URL("../stats-integration-v4.js", import.meta.url), "utf8");
  const index = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(integration, /profile\?\.staleIfError === true \|\| profile\?\.degraded === true/);
  assert.match(integration, /state: ewgfDegraded \? 'degraded' : 'ready'/);
  assert.match(integration, /ewgfProfileObservedAt/);
  assert.match(index, /stats\.ewgfDegraded && degradedProfileObservedAt > 0/);
  assert.match(index, /EWGF一時障害のため前回取得データを表示/);
});
