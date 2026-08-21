import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  STATS_SCHEMA,
  applySourceSnapshotsToFetchedStats,
  buildBackgroundSourceSnapshots,
  buildEwgfProfileSourceSnapshot,
  buildLatestActivitySourceSnapshot,
  buildWavuSourceSnapshot,
  createFirebaseStatsTransport,
  dedupeStatsTargetPaths,
  materializeFetchedStats,
  persistCanonicalStatsAndViews,
  persistStatsWithCas,
} from "../worker/stats-persistence.mjs";

const profileObservedAt = "2026-08-21T10:00:00.000Z";
const profile = {
  ewgfId: "PLAYER-001",
  latestBattleAt: "2026-08-20T10:00:00.000Z",
  mainCharacter: "Kazuya",
  characters: [
    { character: "Kazuya", currentRank: "Fujin", rankIcon: "kazuya.png", characterImage: "kazuya-full.png", games: 12, wins: 7, losses: 5 },
    { character: "Jin", currentRank: "Raijin", rankIcon: "jin.png", characterImage: "jin-full.png", games: 8, wins: 4, losses: 4 },
  ],
  rankedCharacterStats: {
    Kazuya: { games: 12, wins: 7, losses: 5, winRate: 7 / 12 },
    Jin: { games: 8, wins: 4, losses: 4, winRate: 0.5 },
  },
  totalRankedGames: 20,
  totalPlayerMatchGames: 3,
  totalQuickMatchGames: 2,
  totalGroupMatchGames: 1,
  totalRecordedGames: 26,
  tekkenProwess: 123456,
  statPentagon: { offense: 80 },
  playerMessage: "hello",
  platformProfile: { platform: "steam", platformId: "steam-001", platformProfileUrl: "https://example.invalid/player" },
};

const wavu = {
  mainChar: "Jin",
  mainCharGames: 15,
  selectionSource: "wavu-leaderboard-highest-mu",
  ratingMu: 84.5,
  charGamesMap: { Jin: 15 },
  charRatingMap: { Jin: 84.5 },
  qualifiedCharRatingMap: { Jin: 84.5 },
  recentRankedGames7d: 2,
  recentRankedGames30d: 9,
  recentRankedSampleSize: 10,
  latestRankedBattleAt: "2026-08-20T11:00:00.000Z",
};

const latest = {
  battle: { at: "2026-08-20T12:00:00.000Z", character: "Jin", battleType: "RANKED_BATTLE" },
  source: "ewgf-profile-recent-battles",
  scope: "all-battle-types",
};

function sources() {
  return {
    ewgfProfile: buildEwgfProfileSourceSnapshot(profile, profileObservedAt),
    wavuRatings: buildWavuSourceSnapshot(wavu, profileObservedAt),
    latestActivity: buildLatestActivitySourceSnapshot(latest, profileObservedAt),
  };
}

function metadata(completedAt = profileObservedAt) {
  return {
    fetchMeta: { state: "ready", completedAt, fetchedBy: "test", schema: STATS_SCHEMA },
    cachedAt: completedAt,
    updatedAt: completedAt,
  };
}

test("Firebase stats transport uses ETag GET and If-Match PUT only", async () => {
  const calls = [];
  const transport = createFirebaseStatsTransport({
    databaseUrl: "https://example.firebaseio.test",
    token: "test-token",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (options.method === "GET") return new Response(JSON.stringify({ old: true }), { status: 200, headers: { ETag: "etag-1" } });
      return new Response("{}", { status: 200 });
    },
  });

  const remote = await transport.read("users/u/lists/l/members/m/fetchedStats");
  await transport.write("users/u/lists/l/members/m/fetchedStats", { next: true }, remote.etag);

  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.headers["X-Firebase-ETag"], "true");
  assert.equal(calls[1].options.method, "PUT");
  assert.equal(calls[1].options.headers["If-Match"], "etag-1");
  assert.equal(calls.some(({ options }) => options.method === "PATCH"), false);
  assert.match(calls[1].url, /users\/u\/lists\/l\/members\/m\/fetchedStats\.json$/);
});

test("newer source snapshots write a materialized node", async () => {
  const calls = [];
  const transport = {
    async read() { return { value: {}, etag: "etag-1" }; },
    async write(path, value, etag) { calls.push({ path, value, etag }); return { ok: true, status: 200 }; },
  };

  const result = await persistStatsWithCas({ transport, path: "stats", incomingSnapshots: sources(), metadata: metadata() });
  assert.equal(result.status, "written");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].etag, "etag-1");
  assert.equal(calls[0].value.schema, STATS_SCHEMA);
  assert.equal(calls[0].value.profileStats.mainChar, "Jin");
  assert.equal(calls[0].value.activityStats.latestBattleCharacter, "Jin");
});

test("first canonical write seeds from legacy fetchedStats without writing legacy", async () => {
  const calls = [];
  const values = {
    canonical: { value: null, etag: "canonical-etag" },
    legacy: {
      value: {
        gameId: "PLAYER-LEGACY",
        mainChar: "Legacy Kazuya",
        mainCharGames: 42,
        returnTracking: { dormantSince: 1 },
      },
      etag: "legacy-etag",
    },
  };
  const transport = {
    async read(path) {
      calls.push({ method: "GET", path });
      return values[path];
    },
    async write(path, value, etag) {
      calls.push({ method: "PUT", path, value, etag });
      return { ok: true, status: 200 };
    },
  };
  const noWavuMain = buildWavuSourceSnapshot({ ...wavu, mainChar: null, mainCharGames: null }, profileObservedAt);
  const result = await persistStatsWithCas({
    transport,
    path: "canonical",
    legacyPath: "legacy",
    incomingSnapshots: { wavuRatings: noWavuMain },
    metadata: metadata(),
  });
  assert.equal(result.status, "written");
  assert.deepEqual(calls.map(call => `${call.method}:${call.path}`), ["GET:canonical", "GET:legacy", "PUT:canonical"]);
  const write = calls.find(call => call.method === "PUT");
  assert.equal(write.etag, "canonical-etag");
  assert.equal(write.value.profileStats.mainChar, "Legacy Kazuya");
  assert.equal(write.value.profileStats.mainCharGames, 42);
  assert.deepEqual(write.value.returnTracking, { dormantSince: 1 });
  assert.equal(values.legacy.value.schema, undefined);
});

test("Worker-only canonical authority survives old target removal and rehydrates the view", async () => {
  const paths = {
    canonical: "workerStatsByGameId/PLAYER-001",
    target: "sharedLists/share/members/member/workerFetchedStats",
    legacy: "sharedLists/share/members/member/fetchedStats",
  };
  const store = new Map([
    [paths.canonical, { value: null, etag: "canonical-0" }],
    [paths.target, { value: null, etag: "target-0" }],
    [paths.legacy, { value: null, etag: "legacy-0" }],
  ]);
  const transport = {
    async read(path) {
      const entry = store.get(path) || { value: null, etag: `${path}-0` };
      return { value: entry.value, etag: entry.etag };
    },
    async write(path, value, etag) {
      const current = store.get(path) || { value: null, etag: `${path}-0` };
      assert.equal(etag, current.etag);
      store.set(path, { value, etag: `${path}-${Date.now()}` });
      return { ok: true, status: 200 };
    },
  };

  const first = await persistCanonicalStatsAndViews({
    transport,
    canonicalPath: paths.canonical,
    legacyPaths: [paths.legacy],
    targetPaths: [{ path: paths.target, legacyPath: paths.legacy }],
    incomingSnapshots: sources(),
    metadata: metadata(),
  });
  assert.equal(first.status, "complete");
  const canonicalBefore = store.get(paths.canonical).value;
  assert.equal(canonicalBefore.sourceSnapshots.ewgfProfile.revisionAt, sources().ewgfProfile.revisionAt);

  // An old browser parent write can remove the derived target view, but it
  // cannot reach the Worker-only canonical path.
  store.set(paths.target, { value: null, etag: "target-erased-by-old-tab" });
  const second = await persistCanonicalStatsAndViews({
    transport,
    canonicalPath: paths.canonical,
    legacyPaths: [paths.legacy],
    targetPaths: [{ path: paths.target, legacyPath: paths.legacy }],
    incomingSnapshots: sources(),
    metadata: metadata("2026-08-22T00:00:00.000Z"),
  });
  assert.equal(second.status, "complete");
  assert.deepEqual(store.get(paths.canonical).value.sourceSnapshots, canonicalBefore.sourceSnapshots);
  assert.deepEqual(store.get(paths.target).value.sourceSnapshots, canonicalBefore.sourceSnapshots);
});

test("older Worker persistence cannot roll canonical or materialized target views backward", async () => {
  const canonicalPath = "workerStatsByGameId/PLAYER-001";
  const targetPath = "users/u/lists/l/members/m/workerFetchedStats";
  const store = new Map([
    [canonicalPath, { value: null, etag: "canonical-0" }],
    [targetPath, { value: null, etag: "target-0" }],
  ]);
  const transport = {
    async read(path) { return store.get(path) || { value: null, etag: `${path}-0` }; },
    async write(path, value, etag) {
      const current = store.get(path) || { value: null, etag: `${path}-0` };
      assert.equal(etag, current.etag);
      store.set(path, { value, etag: `${path}-${Math.random()}` });
      return { ok: true, status: 200 };
    },
  };
  await persistCanonicalStatsAndViews({
    transport,
    canonicalPath,
    targetPaths: [{ path: targetPath }],
    incomingSnapshots: sources(),
    metadata: metadata(),
  });
  const olderSources = {
    ewgfProfile: { ...sources().ewgfProfile, revisionAt: "2026-08-19T00:00:00.000Z" },
    wavuRatings: { ...sources().wavuRatings, revisionAt: "2026-08-19T00:00:00.000Z" },
    latestActivity: { ...sources().latestActivity, revisionAt: "2026-08-19T00:00:00.000Z" },
  };
  const before = store.get(canonicalPath).value.sourceSnapshots;
  const result = await persistCanonicalStatsAndViews({
    transport,
    canonicalPath,
    targetPaths: [{ path: targetPath }],
    incomingSnapshots: olderSources,
    metadata: metadata("2026-08-22T00:00:00.000Z"),
  });
  assert.equal(result.canonical.status, "noop");
  assert.equal(result.targets[0].status, "noop");
  assert.deepEqual(store.get(canonicalPath).value.sourceSnapshots, before);
  assert.deepEqual(store.get(targetPath).value.sourceSnapshots, before);
});

test("older, unversioned, and equal unchanged sources are no-ops", async (t) => {
  const current = materializeFetchedStats({
    current: {},
    sourceSnapshots: sources(),
    ...metadata(),
  });
  const calls = [];
  const transport = {
    async read() { return { value: current, etag: "etag-current" }; },
    async write() { calls.push(true); return { ok: true, status: 200 }; },
  };

  const older = {
    ewgfProfile: { ...sources().ewgfProfile, revisionAt: "2026-08-19T00:00:00.000Z" },
  };
  const unversioned = { wavuRatings: { ...sources().wavuRatings, revisionAt: null } };
  const equal = { latestActivity: { ...sources().latestActivity, observedAt: "2026-08-22T00:00:00.000Z" } };
  for (const [name, incoming] of [["older", older], ["unversioned", unversioned], ["equal", equal]]) {
    await t.test(name, async () => {
      const result = await persistStatsWithCas({ transport, path: "stats", incomingSnapshots: incoming, metadata: { ...metadata("2026-08-22T00:00:00.000Z") } });
      assert.equal(result.status, "noop");
    });
  }
  assert.equal(calls.length, 0);
});

test("equal source revisions fill missing fields without changing revision", async () => {
  const full = sources().ewgfProfile;
  const current = materializeFetchedStats({
    current: {},
    sourceSnapshots: { ewgfProfile: { revisionAt: full.revisionAt, observedAt: profileObservedAt, data: { gameId: "PLAYER-001", mainChar: "Kazuya" } } },
    ...metadata(),
  });
  const incoming = { ...full, data: { ...full.data, playerMessage: "filled" } };
  let written;
  const result = await persistStatsWithCas({
    transport: {
      async read() { return { value: current, etag: "etag" }; },
      async write(path, value) { written = { path, value }; return { ok: true, status: 200 }; },
    },
    path: "stats",
    incomingSnapshots: { ewgfProfile: incoming },
    metadata: metadata(),
  });
  assert.equal(result.status, "written");
  assert.equal(written.value.sourceSnapshots.ewgfProfile.revisionAt, full.revisionAt);
  assert.equal(written.value.profileStats.playerMessage, "filled");
});

test("a 412 rereads and retries, but the retry count is bounded", async (t) => {
  await t.test("retry succeeds", async () => {
    let reads = 0;
    let writes = 0;
    const result = await persistStatsWithCas({
      transport: {
        async read() { reads += 1; return { value: reads === 1 ? {} : { sourceSnapshots: {} }, etag: `etag-${reads}` }; },
        async write() { writes += 1; return writes === 1 ? { conflict: true, status: 412 } : { ok: true, status: 200 }; },
      },
      path: "stats",
      incomingSnapshots: { ewgfProfile: buildEwgfProfileSourceSnapshot(profile, profileObservedAt) },
      metadata: metadata(),
    });
    assert.equal(result.status, "written");
    assert.equal(reads, 2);
    assert.equal(writes, 2);
  });

  await t.test("three conflicts fail closed", async () => {
    let reads = 0;
    let writes = 0;
    const result = await persistStatsWithCas({
      transport: {
        async read() { reads += 1; return { value: {}, etag: `etag-${reads}` }; },
        async write() { writes += 1; return { conflict: true, status: 412 }; },
      },
      path: "stats",
      incomingSnapshots: { ewgfProfile: buildEwgfProfileSourceSnapshot(profile, profileObservedAt) },
      metadata: metadata(),
      maxAttempts: 3,
    });
    assert.equal(result.status, "conflict");
    assert.equal(reads, 3);
    assert.equal(writes, 3);
  });
});

test("a remote newer snapshot wins after a conflict without a second PUT", async () => {
  let reads = 0;
  let writes = 0;
  const remoteNewer = buildEwgfProfileSourceSnapshot({ ...profile, latestBattleAt: "2026-08-22T00:00:00.000Z" }, profileObservedAt);
  const result = await persistStatsWithCas({
    transport: {
      async read() { reads += 1; return reads === 1 ? { value: {}, etag: "old" } : { value: materializeFetchedStats({ current: {}, sourceSnapshots: { ewgfProfile: remoteNewer }, ...metadata() }), etag: "new" }; },
      async write() { writes += 1; return { conflict: true, status: 412 }; },
    },
    path: "stats",
    incomingSnapshots: { ewgfProfile: buildEwgfProfileSourceSnapshot(profile, profileObservedAt) },
    metadata: metadata(),
  });
  assert.equal(result.status, "noop");
  assert.equal(reads, 2);
  assert.equal(writes, 1);
});

test("source domain materialization is deterministic and preserves ownership", () => {
  const first = materializeFetchedStats({ current: {}, sourceSnapshots: sources(), ...metadata() });
  const second = materializeFetchedStats({
    current: {},
    sourceSnapshots: {
      latestActivity: sources().latestActivity,
      wavuRatings: sources().wavuRatings,
      ewgfProfile: sources().ewgfProfile,
    },
    ...metadata(),
  });
  assert.deepEqual(first, second);
  assert.equal(first.profileStats.mainChar, "Jin");
  assert.equal(first.profileStats.mainSelectionSource, "wavu-leaderboard-highest-mu");
  assert.equal(first.activityStats.latestBattleAt, latest.battle.at);
  assert.equal(first.activityStats.latestBattleRevisionAt, Date.parse(latest.battle.at));
  assert.equal(first.activityStats.latestBattleCheckedAt, profileObservedAt);
});

test("missing Wavu main character falls back to EWGF profile", () => {
  const noWavuMain = buildWavuSourceSnapshot({ ...wavu, mainChar: null }, profileObservedAt);
  const node = materializeFetchedStats({
    current: {},
    sourceSnapshots: {
      ewgfProfile: buildEwgfProfileSourceSnapshot(profile, profileObservedAt),
      wavuRatings: noWavuMain,
    },
    ...metadata(),
  });
  assert.equal(node.profileStats.mainChar, "Kazuya");
  assert.equal(node.profileStats.mainSelectionSource, undefined);
});

test("Wavu-first partial migration preserves legacy main character until EWGF authority arrives", () => {
  const noWavuMain = buildWavuSourceSnapshot({
    ...wavu,
    mainChar: null,
    mainCharGames: null,
    latestRankedBattleAt: "2026-08-21T11:00:00.000Z",
  }, profileObservedAt);
  const applied = applySourceSnapshotsToFetchedStats({
    mainChar: "Legacy Kazuya",
    mainCharGames: 42,
    legacyMarker: "keep me",
  }, { wavuRatings: noWavuMain }, metadata());
  assert.equal(applied.changed, true);
  assert.equal(applied.node.profileStats.mainChar, "Legacy Kazuya");
  assert.equal(applied.node.profileStats.mainCharGames, 42);
  assert.equal(applied.node.mainChar, "Legacy Kazuya");
  assert.equal(applied.node.mainCharGames, 42);
  assert.equal(applied.node.legacyMarker, "keep me");
});

test("split and flat legacy nodes survive the first partial migration", () => {
  const split = applySourceSnapshotsToFetchedStats({
    "20260729-split-fetched-stats": {
      profileStats: { gameId: "LEGACY", playerMessage: "legacy source-owned value", legacyMarker: "keep me" },
      activityStats: { latestBattleType: "PLAYER_BATTLE" },
    },
    returnTracking: { lastSeen: 3 },
  }, { ewgfProfile: buildEwgfProfileSourceSnapshot({ ...profile, playerMessage: "" }, profileObservedAt) }, metadata());
  assert.equal(split.changed, true);
  assert.equal(split.node.returnTracking.lastSeen, 3);
  assert.equal(split.node.profileStats.legacyMarker, "keep me");
  assert.equal(split.node.profileStats.playerMessage, undefined);
  assert.equal(split.node.activityStats.latestBattleType, "PLAYER_BATTLE");

  const flat = applySourceSnapshotsToFetchedStats({ gameId: "LEGACY-FLAT", latestBattleType: "GROUP_BATTLE" }, { wavuRatings: buildWavuSourceSnapshot(wavu, profileObservedAt) }, metadata());
  assert.equal(flat.node.gameId, "LEGACY-FLAT");
  assert.equal(flat.node.activityStats.latestBattleType, "GROUP_BATTLE");
});

test("source revisions are source-derived and never observedAt or Date.now", () => {
  const originalNow = Date.now;
  Date.now = () => 9999999999999;
  try {
    assert.equal(buildEwgfProfileSourceSnapshot(profile, "2099-01-01T00:00:00.000Z").revisionAt, Date.parse(profile.latestBattleAt));
    assert.equal(buildWavuSourceSnapshot(wavu, "2099-01-01T00:00:00.000Z").revisionAt, Date.parse(wavu.latestRankedBattleAt));
    assert.equal(buildLatestActivitySourceSnapshot(latest, "2099-01-01T00:00:00.000Z").revisionAt, Date.parse(latest.battle.at));
  } finally {
    Date.now = originalNow;
  }
});

test("background snapshots contain three independent domains", () => {
  const background = buildBackgroundSourceSnapshots({
    ...profile,
    latestBattleAt: latest.battle.at,
    latestBattleCharacter: latest.battle.character,
    latestBattleType: latest.battle.battleType,
    wavuRatings: wavu,
  }, profileObservedAt);
  assert.deepEqual(Object.keys(background).sort(), ["ewgfProfile", "latestActivity", "wavuRatings"]);
  assert.equal(background.ewgfProfile.revisionAt, Date.parse(latest.battle.at));
  assert.equal(background.wavuRatings.revisionAt, Date.parse(wavu.latestRankedBattleAt));
  assert.equal(background.latestActivity.revisionAt, Date.parse(latest.battle.at));
  assert.equal(background.latestActivity.data.latestBattleRevisionAt, Date.parse(latest.battle.at));
});

test("missing source timestamps remain unversioned", () => {
  assert.equal(buildEwgfProfileSourceSnapshot({ ...profile, latestBattleAt: null }, profileObservedAt).revisionAt, null);
  assert.equal(buildWavuSourceSnapshot({ ...wavu, latestRankedBattleAt: null }, profileObservedAt).revisionAt, null);
  assert.equal(buildLatestActivitySourceSnapshot({ battle: { character: "Jin" } }, profileObservedAt).revisionAt, null);
});

test("duplicate owner/shared target paths are deduplicated", () => {
  assert.deepEqual(dedupeStatsTargetPaths([
    { path: "sharedLists/share/members/member/fetchedStats", shareId: "share" },
    { path: "sharedLists/share/members/member/fetchedStats", shareId: "share" },
    { path: "users/u/lists/l/members/m/fetchedStats" },
    { path: "users/u/lists/l/members/m/fetchedStats" },
  ]), [
    { path: "sharedLists/share/members/member/fetchedStats", shareIds: ["share"] },
    { path: "users/u/lists/l/members/m/fetchedStats", shareIds: [] },
  ]);
});

test("EWGF character selection falls back to an existing source field", () => {
  const node = buildEwgfProfileSourceSnapshot({
    ...profile,
    rankedCharacterStats: {},
    characterSelectionTop: [{ character: "Kazuya", lifetimeGames: 4 }],
  }, profileObservedAt);
  assert.deepEqual(node.data.characterSelectionTop, [{ character: "Kazuya", lifetimeGames: 4 }]);
});

test("background characterRanks.rank remains the current rank when highestRank differs", () => {
  const snapshot = buildEwgfProfileSourceSnapshot({
    gameId: "PLAYER-001",
    highestRank: "Tekken God Supreme",
    characterRanks: { Kazuya: { rank: "Fujin", rankIcon: "fujin.png" } },
    rankedCharacterStats: { Kazuya: { games: 10, wins: 6, losses: 4, winRate: 0.6 } },
    totalRankedGames: 10,
  }, profileObservedAt);
  assert.equal(snapshot.data.danRank, "Fujin");
});

test("a newer authoritative Wavu snapshot clears omitted Wavu fields and falls back to EWGF", () => {
  const current = materializeFetchedStats({
    current: {},
    sourceSnapshots: {
      ewgfProfile: buildEwgfProfileSourceSnapshot(profile, profileObservedAt),
      wavuRatings: buildWavuSourceSnapshot(wavu, profileObservedAt),
    },
    ...metadata(),
  });
  const newerNoQualifiedMain = buildWavuSourceSnapshot({
    ...wavu,
    mainChar: null,
    mainCharGames: null,
    ratingMu: null,
    charGamesMap: {},
    charRatingMap: {},
    qualifiedCharRatingMap: {},
    latestRankedBattleAt: "2026-08-21T11:00:00.000Z",
  }, "2026-08-21T12:00:00.000Z");
  const applied = applySourceSnapshotsToFetchedStats(current, { wavuRatings: newerNoQualifiedMain }, metadata("2026-08-21T12:00:00.000Z"));
  assert.equal(applied.changed, true);
  assert.equal(applied.node.profileStats.mainChar, "Kazuya");
  assert.equal(applied.node.mainChar, "Kazuya");
  assert.equal(applied.node.profileStats.ratingMu, undefined);
  assert.equal(applied.node.profileStats.ratingCharacter, undefined);
  assert.equal(applied.node.profileStats.mainSelectionSource, undefined);
  assert.equal(applied.node.profileStats.qualifiedCharRatingMap, undefined);
});

test("a newer authoritative latest snapshot clears omitted character and type fields", () => {
  const current = materializeFetchedStats({
    current: {},
    sourceSnapshots: {
      latestActivity: buildLatestActivitySourceSnapshot(latest, profileObservedAt),
    },
    ...metadata(),
  });
  const newerMissingDetails = buildLatestActivitySourceSnapshot({
    battle: { at: "2026-08-21T12:00:00.000Z" },
    source: "ewgf-official-battles-api",
    scope: "all-battle-types",
  }, "2026-08-21T12:01:00.000Z");
  const applied = applySourceSnapshotsToFetchedStats(current, { latestActivity: newerMissingDetails }, metadata("2026-08-21T12:01:00.000Z"));
  assert.equal(applied.changed, true);
  assert.equal(applied.node.activityStats.latestBattleAt, "2026-08-21T12:00:00.000Z");
  assert.equal(applied.node.activityStats.latestBattleCharacter, undefined);
  assert.equal(applied.node.activityStats.latestBattleType, undefined);
  assert.equal(applied.node.latestBattleCharacter, undefined);
  assert.equal(applied.node.latestBattleType, undefined);
});

test("Worker routes retain cache-hit persistence wiring for throttled page-open/manual requests", () => {
  const workerSource = readFileSync(new URL("../worker/ewgf-worker-with-stat-pentagon.js", import.meta.url), "utf8");
  assert.match(workerSource, /const cached = await getFreshCachedJson\(cache, cacheKey, WAVU_RATINGS_CACHE_TTL_SECONDS\);[\s\S]*?if \(cached\) \{[\s\S]*?if \(statsPersistRequested\) \{[\s\S]*?scheduleCachedFirebaseSourceSnapshot\(/);
  assert.match(workerSource, /"wavuRatings",\s*buildWavuSourceSnapshot/);
  assert.match(workerSource, /const cachedResponse = await getFreshCachedJson\(cache, cacheKey, WORKER_CACHE_TTL_SECONDS\);[\s\S]*?if \(cachedResponse\) \{[\s\S]*?if \(statsPersistRequested\) \{[\s\S]*?scheduleCachedFirebaseSourceSnapshot\(/);
  assert.match(workerSource, /"ewgfProfile",\s*buildEwgfProfileSourceSnapshot/);
});

test("Worker persistence targets canonical sibling nodes and keeps legacy fallback paths", () => {
  const workerSource = readFileSync(new URL("../worker/ewgf-worker-with-stat-pentagon.js", import.meta.url), "utf8");
  assert.match(workerSource, /workerFetchedStats/);
  assert.match(workerSource, /workerStatsByGameId\/\$\{normalizedId\}/);
  assert.match(workerSource, /persistCanonicalStatsAndViews/);
  assert.match(workerSource, /legacyPath:\s*`\$\{ownerMemberPath\}\/fetchedStats`/);
  assert.match(workerSource, /legacyPath:\s*`\$\{sharedMemberPath\}\/fetchedStats`/);
});

test("active browser reads canonical stats and no longer publishes fetchedStats", () => {
  const browserSource = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const listsSource = readFileSync(new URL("../user-lists-prototype.js", import.meta.url), "utf8");
  const integrationSource = readFileSync(new URL("../stats-integration-v4.js", import.meta.url), "utf8");
  assert.match(browserSource, /WORKER_STATS_SCHEMA\s*=\s*['"]20260821-source-snapshots-v1/);
  assert.match(browserSource, /memberData\.workerFetchedStats/);
  assert.doesNotMatch(browserSource, /memberStatsUpdate\s*=\s*\{\s*fetchedStats/);
  assert.doesNotMatch(browserSource, /data\.fetchedStats\s*=/);
  assert.doesNotMatch(browserSource, /child\(['"]fetchedStats\/activityStats\/returnTracking/);
  assert.match(listsSource, /workerFetchedStats/);
  assert.match(listsSource, /mode=latest&persist=1/);
  assert.match(listsSource, /const existingSnapshot = await db\.ref\(root\)\.once\(['"]value['"]\)/);
  assert.match(listsSource, /await writeSharedListDelta\(shareId, previous, next\)/);
  assert.doesNotMatch(listsSource, /db\.ref\(root\)\.set\(payload\)/);
  assert.doesNotMatch(listsSource, /updates\[`sharedLists\/\$\{shareId\}\/members\/\$\{memberId\}`\]\s*=\s*after/);
  assert.match(listsSource, /Object\.entries\(after\)\.forEach/);
  assert.doesNotMatch(listsSource, /child\(key\)\.child\(['"]fetchedStats['"]\)\.child\(['"]activityStats['"]\)/);
  assert.match(integrationSource, /isManual\s*&&\s*forceRefresh[\s\S]*manualRefresh=1/);
});
