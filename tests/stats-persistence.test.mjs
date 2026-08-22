import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

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
    [paths.target, {
      value: materializeFetchedStats({ current: {}, sourceSnapshots: sources(), ...metadata() }),
      etag: "target-0",
    }],
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
    compatibilityPaths: [paths.target, paths.legacy],
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
    compatibilityPaths: [paths.target, paths.legacy],
    targetPaths: [{ path: paths.target, legacyPath: paths.legacy }],
    incomingSnapshots: sources(),
    metadata: metadata("2026-08-22T00:00:00.000Z"),
  });
  assert.equal(second.status, "complete");
  assert.deepEqual(store.get(paths.canonical).value.sourceSnapshots, canonicalBefore.sourceSnapshots);
  assert.deepEqual(store.get(paths.target).value.sourceSnapshots, canonicalBefore.sourceSnapshots);
});

test("Worker-only canonical seeds exclude browser returnTracking while compatibility views retain it", async () => {
  const paths = {
    canonical: "workerStatsByGameId/PLAYER-002",
    target: "sharedLists/share/members/member/workerFetchedStats",
    legacy: "sharedLists/share/members/member/fetchedStats",
  };
  const browserTracking = {
    schema: "20260801-return-player",
    dormantSince: Date.parse("2026-08-01T00:00:00.000Z"),
    baselineLatestRankedBattleAt: "2026-08-01T00:00:00.000Z",
    returnReportedAt: Date.parse("2026-08-02T00:00:00.000Z"),
    returnBadgeUntil: Date.parse("2026-08-05T00:00:00.000Z"),
    returnedBattleAt: "2026-08-02T12:00:00.000Z",
  };
  const store = new Map([
    [paths.canonical, { value: null, etag: "canonical-0" }],
    [paths.target, { value: null, etag: "target-0" }],
    [paths.legacy, {
      value: {
        returnTracking: browserTracking,
        activityStats: { returnTracking: browserTracking },
      },
      etag: "legacy-0",
    }],
  ]);
  const transport = {
    async read(path) {
      const entry = store.get(path) || { value: null, etag: `${path}-0` };
      return { value: entry.value, etag: entry.etag };
    },
    async write(path, value, etag) {
      const current = store.get(path) || { value: null, etag: `${path}-0` };
      assert.equal(etag, current.etag);
      store.set(path, { value, etag: `${path}-written` });
      return { ok: true, status: 200 };
    },
  };

  const result = await persistCanonicalStatsAndViews({
    transport,
    canonicalPath: paths.canonical,
    compatibilityPaths: [paths.legacy],
    targetPaths: [{ path: paths.target, legacyPath: paths.legacy }],
    incomingSnapshots: sources(),
    metadata: metadata(),
  });
  assert.equal(result.status, "complete");
  const canonical = store.get(paths.canonical).value;
  const target = store.get(paths.target).value;
  assert.equal(canonical.returnTracking, undefined);
  assert.equal(canonical.profileStats.returnTracking, undefined);
  assert.equal(canonical.activityStats.returnTracking, undefined);
  assert.deepEqual(target.returnTracking, browserTracking);
  assert.deepEqual(target.activityStats.returnTracking, browserTracking);
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
    ewgfProfileRevisionAt: profile.latestBattleAt,
    latestBattleCharacter: latest.battle.character,
    latestBattleType: latest.battle.battleType,
    wavuRatings: wavu,
  }, profileObservedAt);
  assert.deepEqual(Object.keys(background).sort(), ["ewgfProfile", "latestActivity", "wavuRatings"]);
  assert.equal(background.ewgfProfile.revisionAt, Date.parse(profile.latestBattleAt));
  assert.equal(background.wavuRatings.revisionAt, Date.parse(wavu.latestRankedBattleAt));
  assert.equal(background.latestActivity.revisionAt, Date.parse(latest.battle.at));
  assert.equal(background.latestActivity.data.latestBattleRevisionAt, Date.parse(latest.battle.at));
});

test("Wavu latest activity cannot advance the EWGF profile revision", () => {
  const background = buildBackgroundSourceSnapshots({
    ...profile,
    latestBattleAt: "2026-08-22T12:00:00.000Z",
    ewgfProfileRevisionAt: "2026-08-20T10:00:00.000Z",
    latestBattleSource: "wavu-latest-ranked-fallback",
    latestBattleScope: "ranked-only-fallback",
    wavuRatings: { ...wavu, latestRankedBattleAt: "2026-08-22T12:00:00.000Z" },
  }, "2026-08-22T12:05:00.000Z");

  assert.equal(background.latestActivity.revisionAt, Date.parse("2026-08-22T12:00:00.000Z"));
  assert.equal(background.wavuRatings.revisionAt, Date.parse("2026-08-22T12:00:00.000Z"));
  assert.equal(background.ewgfProfile.revisionAt, Date.parse("2026-08-20T10:00:00.000Z"));
});

test("complete EWGF refresh repairs a legacy contaminated revision without rollback", () => {
  const contaminatedCurrent = buildEwgfProfileSourceSnapshot({
    ...profile,
    latestBattleAt: "2026-08-22T12:00:00.000Z",
    tekkenProwess: 999999,
    statPentagon: null,
  }, profileObservedAt);
  const current = materializeFetchedStats({
    current: {},
    sourceSnapshots: { ewgfProfile: contaminatedCurrent },
    ...metadata(),
  });
  const completeIncoming = buildEwgfProfileSourceSnapshot({
    ...profile,
    latestBattleAt: "2026-08-20T10:00:00.000Z",
    tekkenProwess: 111111,
    statPentagon: { offense: 90, defense: 88, technique: 86, spirit: 84, stamina: 82 },
  }, "2026-08-22T12:05:00.000Z");

  const applied = applySourceSnapshotsToFetchedStats(current, { ewgfProfile: completeIncoming }, metadata("2026-08-22T12:05:00.000Z"));
  assert.equal(applied.changed, true);
  assert.equal(applied.decisions.ewgfProfile.action, "repair");
  assert.equal(applied.node.sourceSnapshots.ewgfProfile.revisionAt, Date.parse("2026-08-22T12:00:00.000Z"));
  assert.equal(applied.node.sourceSnapshots.ewgfProfile.observedAt, "2026-08-22T12:05:00.000Z");
  assert.equal(applied.node.profileStats.tekkenPower, 999999);
  assert.deepEqual(applied.node.profileStats.statPentagon, completeIncoming.data.statPentagon);
});

test("newer complete EWGF refresh still replaces an older profile normally", () => {
  const current = materializeFetchedStats({
    current: {},
    sourceSnapshots: {
      ewgfProfile: buildEwgfProfileSourceSnapshot({
        ...profile,
        latestBattleAt: "2026-08-20T10:00:00.000Z",
      }, profileObservedAt),
    },
    ...metadata(),
  });
  const newer = buildEwgfProfileSourceSnapshot({
    ...profile,
    latestBattleAt: "2026-08-23T10:00:00.000Z",
    tekkenProwess: 888888,
    statPentagon: { offense: 91, defense: 89, technique: 87, spirit: 85, stamina: 83 },
  }, "2026-08-23T10:05:00.000Z");

  const applied = applySourceSnapshotsToFetchedStats(current, { ewgfProfile: newer }, metadata("2026-08-23T10:05:00.000Z"));
  assert.equal(applied.decisions.ewgfProfile.action, "applied");
  assert.equal(applied.node.sourceSnapshots.ewgfProfile.revisionAt, Date.parse("2026-08-23T10:00:00.000Z"));
  assert.equal(applied.node.profileStats.tekkenPower, 888888);
  assert.deepEqual(applied.node.profileStats.statPentagon, newer.data.statPentagon);
});

test("canonical materialization restores historical Wavu mu only for a matching EWGF main", () => {
  const ewgf = buildEwgfProfileSourceSnapshot(profile, profileObservedAt);
  const matchingHistorical = buildWavuSourceSnapshot({
    ...wavu,
    mainChar: null,
    mainCharGames: null,
    ratingMu: null,
    selectionSource: "no-qualified-character",
    charGamesMap: { Kazuya: 99 },
    charRatingMap: { Kazuya: 77.25 },
    qualifiedCharRatingMap: {},
  }, profileObservedAt);
  const matchingNode = materializeFetchedStats({
    current: {},
    sourceSnapshots: { ewgfProfile: ewgf, wavuRatings: matchingHistorical },
    ...metadata(),
  });
  assert.equal(matchingNode.profileStats.mainChar, "Kazuya");
  assert.equal(matchingNode.profileStats.ratingMu, 77.25);
  assert.equal(matchingNode.profileStats.ratingCharacter, "Kazuya");
  assert.equal(matchingNode.profileStats.ratingIsHistorical, true);

  const noMatchingRating = buildWavuSourceSnapshot({
    ...wavu,
    mainChar: null,
    mainCharGames: null,
    ratingMu: null,
    selectionSource: "no-qualified-character",
    charGamesMap: { Jin: 99 },
    charRatingMap: { Jin: 88.5 },
    qualifiedCharRatingMap: {},
  }, profileObservedAt);
  const missingNode = materializeFetchedStats({
    current: {},
    sourceSnapshots: { ewgfProfile: ewgf, wavuRatings: noMatchingRating },
    ...metadata(),
  });
  assert.equal(missingNode.profileStats.ratingMu, undefined);
  assert.equal(missingNode.profileStats.ratingCharacter, undefined);
  assert.notEqual(missingNode.profileStats.ratingIsHistorical, true);

  const qualifiedNode = materializeFetchedStats({
    current: {},
    sourceSnapshots: { ewgfProfile: ewgf, wavuRatings: buildWavuSourceSnapshot(wavu, profileObservedAt) },
    ...metadata(),
  });
  assert.equal(qualifiedNode.profileStats.ratingMu, wavu.ratingMu);
  assert.equal(qualifiedNode.profileStats.ratingCharacter, wavu.mainChar);
  assert.notEqual(qualifiedNode.profileStats.ratingIsHistorical, true);
});

test("identical Wavu source repairs missing historical mu once and then becomes a noop", async () => {
  const ewgf = buildEwgfProfileSourceSnapshot(profile, profileObservedAt);
  const historicalWavu = buildWavuSourceSnapshot({
    ...wavu,
    mainChar: null,
    mainCharGames: null,
    ratingMu: null,
    selectionSource: "no-qualified-character",
    charGamesMap: { Kazuya: 99 },
    charRatingMap: { Kazuya: 77.25 },
    qualifiedCharRatingMap: {},
  }, profileObservedAt);
  const canonical = materializeFetchedStats({
    current: {},
    sourceSnapshots: { ewgfProfile: ewgf, wavuRatings: historicalWavu },
    ...metadata(),
  });
  const damaged = JSON.parse(JSON.stringify(canonical));
  delete damaged.profileStats.ratingMu;
  delete damaged.profileStats.ratingCharacter;
  delete damaged.profileStats.ratingIsHistorical;
  delete damaged.ratingMu;
  delete damaged.ratingCharacter;
  delete damaged.ratingIsHistorical;
  const sourceSnapshotsBefore = JSON.parse(JSON.stringify(damaged.sourceSnapshots));
  let stored = damaged;
  let writes = 0;
  const transport = {
    async read() { return { value: stored, etag: `etag-${writes}` }; },
    async write(path, value) {
      writes += 1;
      stored = value;
      return { ok: true, status: 200 };
    },
  };

  const first = await persistStatsWithCas({
    transport,
    path: "stats",
    incomingSnapshots: { wavuRatings: historicalWavu },
    metadata: metadata("2026-08-22T12:05:00.000Z"),
  });
  assert.equal(first.status, "written");
  assert.equal(writes, 1);
  assert.equal(stored.profileStats.ratingMu, 77.25);
  assert.equal(stored.profileStats.ratingCharacter, "Kazuya");
  assert.equal(stored.profileStats.ratingIsHistorical, true);
  assert.deepEqual(stored.sourceSnapshots, sourceSnapshotsBefore);

  const second = await persistStatsWithCas({
    transport,
    path: "stats",
    incomingSnapshots: { wavuRatings: historicalWavu },
    metadata: metadata("2026-08-22T12:06:00.000Z"),
  });
  assert.equal(second.status, "noop");
  assert.equal(writes, 1);
});

test("background profile snapshots retain complete EWGF fields and omit unavailable Wavu authority", () => {
  const current = materializeFetchedStats({
    current: {},
    sourceSnapshots: sources(),
    ...metadata(),
  });
  const incompleteWavuBackground = buildBackgroundSourceSnapshots({
    ...profile,
    latestBattleAt: "2026-08-21T12:00:00.000Z",
    wavuRatings: null,
  }, "2026-08-21T12:05:00.000Z");

  assert.deepEqual(incompleteWavuBackground.ewgfProfile.data.statPentagon, profile.statPentagon);
  assert.equal(incompleteWavuBackground.ewgfProfile.data.playerMessage, profile.playerMessage);
  assert.equal(incompleteWavuBackground.ewgfProfile.data.platform, profile.platformProfile.platform);
  assert.equal(incompleteWavuBackground.wavuRatings, undefined);

  const applied = applySourceSnapshotsToFetchedStats(current, incompleteWavuBackground, metadata("2026-08-21T12:05:00.000Z"));
  assert.deepEqual(applied.node.profileStats.statPentagon, profile.statPentagon);
  assert.equal(applied.node.profileStats.playerMessage, profile.playerMessage);
  assert.equal(applied.node.profileStats.platformProfileUrl, profile.platformProfile.platformProfileUrl);
  assert.equal(applied.node.profileStats.ratingMu, wavu.ratingMu);

  const validWavuBackground = buildBackgroundSourceSnapshots({
    ...profile,
    latestBattleAt: "2026-08-21T13:00:00.000Z",
    wavuRatings: { ...wavu, ratingMu: 91.5, latestRankedBattleAt: "2026-08-21T13:00:00.000Z" },
  }, "2026-08-21T13:05:00.000Z");
  assert.equal(validWavuBackground.wavuRatings.data.ratingMu, 91.5);
  const updated = applySourceSnapshotsToFetchedStats(applied.node, validWavuBackground, metadata("2026-08-21T13:05:00.000Z"));
  assert.equal(updated.node.profileStats.ratingMu, 91.5);
});

test("partial background EWGF capture preserves existing authority while independent domains advance", () => {
  const current = materializeFetchedStats({
    current: {},
    sourceSnapshots: sources(),
    ...metadata(),
  });
  const partial = buildBackgroundSourceSnapshots({
    ...profile,
    statPentagon: null,
    latestBattleAt: "2026-08-22T12:00:00.000Z",
    wavuRatings: { ...wavu, ratingMu: 91.5, latestRankedBattleAt: "2026-08-22T12:00:00.000Z" },
  }, "2026-08-22T12:05:00.000Z");

  assert.equal(partial.ewgfProfile, undefined);
  assert.equal(partial.wavuRatings.data.ratingMu, 91.5);
  assert.equal(partial.latestActivity.revisionAt, Date.parse("2026-08-22T12:00:00.000Z"));

  const applied = applySourceSnapshotsToFetchedStats(current, partial, metadata("2026-08-22T12:05:00.000Z"));
  assert.deepEqual(applied.node.profileStats.statPentagon, profile.statPentagon);
  assert.equal(applied.node.profileStats.ratingMu, 91.5);
  assert.equal(applied.node.activityStats.latestBattleAt, "2026-08-22T12:00:00.000Z");

  const invalid = buildBackgroundSourceSnapshots({
    ...profile,
    statPentagon: {},
    wavuRatings: null,
  }, "2026-08-22T12:10:00.000Z");
  assert.equal(invalid.ewgfProfile, undefined);
});

test("background capture carries the complete profile contract and only bumps the existing sync marker", () => {
  const workerSource = readFileSync(new URL("../worker/ewgf-worker-with-stat-pentagon.js", import.meta.url), "utf8");
  const backgroundStart = workerSource.indexOf("async function fetchAwardSnapshot");
  const backgroundEnd = workerSource.indexOf("\nfunction normalizeCharacterKey", backgroundStart);
  assert.ok(backgroundStart >= 0 && backgroundEnd > backgroundStart, "background snapshot function must remain discoverable");
  const backgroundSource = workerSource.slice(backgroundStart, backgroundEnd);
  assert.match(backgroundSource, /const statPentagon = extractStatPentagon\(html\)/);
  assert.match(backgroundSource, /const highestRankProfile = extractHighestRankProfile\(html\)/);
  assert.match(backgroundSource, /const playerMessage = extractPlayerMessage\(html\)/);
  assert.match(backgroundSource, /const platformProfile = extractPlatformProfile\(html\)/);
  assert.match(backgroundSource, /const ewgfProfileRevisionAt = profileLatest\?\.at \|\| officialLatest\?\.at \|\| null/);
  assert.match(backgroundSource, /statPentagon,/);
  assert.match(backgroundSource, /playerMessage,/);
  assert.match(backgroundSource, /platformProfile,/);
  assert.match(backgroundSource, /highestRankIcon: highestRankProfile\.rankIcon \|\| null/);
  assert.match(backgroundSource, /ewgfProfileRevisionAt,/);
  assert.match(workerSource, /const BACKGROUND_SYNC_SCHEMA = "20260822-dormant-all-time-highest-rank"/);
  assert.match(workerSource, /const BACKGROUND_SYNC_PER_TICK = 1/);
});

test("background latest selection considers Wavu timestamp without stale profile details", () => {
  const workerSource = readFileSync(new URL("../worker/ewgf-worker-with-stat-pentagon.js", import.meta.url), "utf8");
  const selectionStart = workerSource.indexOf("function selectLatestBattle");
  const selectionEnd = workerSource.indexOf("\nfunction extractWavuRatings", selectionStart);
  assert.ok(selectionStart >= 0 && selectionEnd > selectionStart, "latest selection helper must remain discoverable");
  const selectLatestBattle = runInNewContext(`(${workerSource.slice(selectionStart, selectionEnd)})`);
  const selected = selectLatestBattle([
    {
      battle: { at: "2026-08-20T10:00:00.000Z", battleType: "Ranked Battle", character: "Stale Character" },
      source: "ewgf-profile-recent-battles",
      scope: "all-battle-types",
    },
    {
      battle: { at: "2026-08-21T10:00:00.000Z", battleType: "", character: "" },
      source: "wavu-latest-ranked-fallback",
      scope: "ranked-only-fallback",
    },
  ]);
  assert.equal(selected.source, "wavu-latest-ranked-fallback");
  assert.equal(selected.battle.at, "2026-08-21T10:00:00.000Z");
  assert.equal(selected.battle.character, "");
  assert.equal(selected.battle.battleType, "");

  const backgroundStart = workerSource.indexOf("async function fetchAwardSnapshot");
  const backgroundEnd = workerSource.indexOf("\nfunction normalizeCharacterKey", backgroundStart);
  assert.ok(backgroundStart >= 0 && backgroundEnd > backgroundStart, "background snapshot function must remain discoverable");
  const backgroundSource = workerSource.slice(backgroundStart, backgroundEnd);
  assert.match(backgroundSource, /wavu\?\.latestRankedBattleAt/);
  assert.match(backgroundSource, /const selectedLatest = selectLatestBattle\(latestCandidates\)/);
  assert.match(backgroundSource, /latestBattleSource: selectedLatest\?\.source/);
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
    highestRankIcon: "supreme.png",
    characterRanks: { Kazuya: { rank: "Fujin", rankIcon: "fujin.png" } },
    rankedCharacterStats: { Kazuya: { games: 10, wins: 6, losses: 4, winRate: 0.6 } },
    totalRankedGames: 10,
  }, profileObservedAt);
  assert.equal(snapshot.data.danRank, "Fujin");
  assert.equal(snapshot.data.rankIcon, "fujin.png");
  assert.equal(snapshot.data.highestRankIcon, "supreme.png");
  assert.equal(snapshot.data.rankIsAllTimeHighest, false);
});

test("canonical EWGF rank presentation uses current icon before all-time-highest fallback", () => {
  const currentRank = buildEwgfProfileSourceSnapshot({
    ...profile,
    highestRank: "Tekken God Supreme",
    highestRankIcon: "supreme.png",
  }, profileObservedAt);
  assert.equal(currentRank.data.danRank, "Fujin");
  assert.equal(currentRank.data.rankIcon, "kazuya.png");
  assert.equal(currentRank.data.highestRankIcon, "supreme.png");
  assert.equal(currentRank.data.rankIsAllTimeHighest, false);

  const fallbackRank = buildEwgfProfileSourceSnapshot({
    ...profile,
    rankIcon: "",
    highestRank: "Tekken God Supreme",
    highestRankIcon: "supreme.png",
    characters: [{ ...profile.characters[0], rankIcon: "" }, profile.characters[1]],
  }, profileObservedAt);
  assert.equal(fallbackRank.data.danRank, "Tekken God Supreme");
  assert.equal(fallbackRank.data.rankIcon, "supreme.png");
  assert.equal(fallbackRank.data.highestRankIcon, "supreme.png");
  assert.equal(fallbackRank.data.rankIsAllTimeHighest, true);
  const materialized = materializeFetchedStats({
    current: {},
    sourceSnapshots: { ewgfProfile: fallbackRank },
    ...metadata(),
  });
  assert.equal(materialized.profileStats.rankIcon, "supreme.png");
  assert.equal(materialized.profileStats.highestRankIcon, "supreme.png");
  assert.equal(materialized.profileStats.rankIsAllTimeHighest, true);
  assert.equal(materialized.rankIcon, "supreme.png");
  assert.equal(materialized.rankIsAllTimeHighest, true);

  const noHistoricalIcon = buildEwgfProfileSourceSnapshot({
    ...profile,
    rankIcon: "",
    highestRank: "Tekken God Supreme",
    highestRankIcon: "",
    characters: [{ ...profile.characters[0], rankIcon: "" }, profile.characters[1]],
  }, profileObservedAt);
  assert.equal(noHistoricalIcon.data.danRank, "Fujin");
  assert.equal(noHistoricalIcon.data.rankIcon, "");
  assert.equal(noHistoricalIcon.data.rankIsAllTimeHighest, false);
});

test("damaged canonical EWGF rank presentation repairs without rollback and then becomes a noop", async () => {
  const currentSource = buildEwgfProfileSourceSnapshot({
    ...profile,
    latestBattleAt: "2026-08-22T12:00:00.000Z",
    rankIcon: "",
    highestRank: "Tekken God Supreme",
    highestRankIcon: "supreme.png",
    characters: [{ ...profile.characters[0], rankIcon: "" }, profile.characters[1]],
  }, "2026-08-22T12:05:00.000Z");
  const canonical = materializeFetchedStats({
    current: {},
    sourceSnapshots: { ewgfProfile: currentSource },
    ...metadata("2026-08-22T12:05:00.000Z"),
  });
  const damaged = JSON.parse(JSON.stringify(canonical));
  for (const target of [damaged.sourceSnapshots.ewgfProfile.data, damaged.profileStats, damaged]) {
    target.rankIcon = "";
    target.highestRankIcon = "";
    target.rankIsAllTimeHighest = false;
    target.danRank = "-";
  }
  damaged.sourceSnapshots.ewgfProfile.data.tekkenPower = 999999;
  damaged.profileStats.tekkenPower = 999999;
  damaged.tekkenPower = 999999;

  const incoming = buildEwgfProfileSourceSnapshot({
    ...profile,
    latestBattleAt: "2026-08-20T10:00:00.000Z",
    rankIcon: "",
    highestRank: "Tekken God Supreme",
    highestRankIcon: "supreme.png",
    characters: [{ ...profile.characters[0], rankIcon: "" }, profile.characters[1]],
  }, "2026-08-23T12:05:00.000Z");
  let stored = damaged;
  let writes = 0;
  const transport = {
    async read() { return { value: stored, etag: `etag-${writes}` }; },
    async write(path, value) {
      writes += 1;
      stored = value;
      return { ok: true, status: 200 };
    },
  };

  const first = await persistStatsWithCas({
    transport,
    path: "stats",
    incomingSnapshots: { ewgfProfile: incoming },
    metadata: metadata("2026-08-23T12:05:00.000Z"),
  });
  assert.equal(first.status, "written");
  assert.equal(writes, 1);
  assert.equal(stored.sourceSnapshots.ewgfProfile.revisionAt, Date.parse("2026-08-22T12:00:00.000Z"));
  assert.equal(stored.sourceSnapshots.ewgfProfile.observedAt, "2026-08-23T12:05:00.000Z");
  assert.equal(stored.profileStats.rankIcon, "supreme.png");
  assert.equal(stored.profileStats.highestRankIcon, "supreme.png");
  assert.equal(stored.profileStats.rankIsAllTimeHighest, true);
  assert.equal(stored.profileStats.danRank, "Tekken God Supreme");
  assert.equal(stored.profileStats.tekkenPower, 999999);

  const second = await persistStatsWithCas({
    transport,
    path: "stats",
    incomingSnapshots: { ewgfProfile: incoming },
    metadata: metadata("2026-08-23T12:06:00.000Z"),
  });
  assert.equal(second.status, "noop");
  assert.equal(writes, 1);
});

test("historical icon with a damaged flag repairs once and then becomes a noop", async () => {
  const historicalSource = buildEwgfProfileSourceSnapshot({
    ...profile,
    highestRank: "Tekken God Supreme",
    highestRankIcon: "supreme.png",
    rankIcon: "",
    characters: [{ ...profile.characters[0], rankIcon: "" }, profile.characters[1]],
  }, profileObservedAt);
  const damaged = materializeFetchedStats({
    current: {},
    sourceSnapshots: { ewgfProfile: historicalSource },
    ...metadata(),
  });
  for (const target of [damaged.sourceSnapshots.ewgfProfile.data, damaged.profileStats, damaged]) {
    target.rankIsAllTimeHighest = false;
  }
  const incoming = buildEwgfProfileSourceSnapshot({
    ...profile,
    highestRank: "Tekken God Supreme",
    highestRankIcon: "supreme.png",
    rankIcon: "",
    characters: [{ ...profile.characters[0], rankIcon: "" }, profile.characters[1]],
  }, "2026-08-23T12:05:00.000Z");
  let stored = damaged;
  let writes = 0;
  const transport = {
    async read() { return { value: stored, etag: `etag-${writes}` }; },
    async write(path, value) {
      writes += 1;
      stored = value;
      return { ok: true, status: 200 };
    },
  };

  const first = await persistStatsWithCas({
    transport,
    path: "stats",
    incomingSnapshots: { ewgfProfile: incoming },
    metadata: metadata("2026-08-23T12:05:00.000Z"),
  });
  assert.equal(first.status, "written");
  assert.equal(stored.profileStats.rankIcon, "supreme.png");
  assert.equal(stored.profileStats.rankIsAllTimeHighest, true);

  const second = await persistStatsWithCas({
    transport,
    path: "stats",
    incomingSnapshots: { ewgfProfile: incoming },
    metadata: metadata("2026-08-23T12:06:00.000Z"),
  });
  assert.equal(second.status, "noop");
  assert.equal(writes, 1);
});

test("newer equal-revision EWGF observation promotes historical fallback to current rank", () => {
  const historical = buildEwgfProfileSourceSnapshot({
    ...profile,
    latestBattleAt: "2026-08-22T12:00:00.000Z",
    highestRank: "Tekken God Supreme",
    highestRankIcon: "supreme.png",
    rankIcon: "",
    characters: [{ ...profile.characters[0], rankIcon: "" }, profile.characters[1]],
  }, "2026-08-22T12:05:00.000Z");
  const current = materializeFetchedStats({
    current: {},
    sourceSnapshots: { ewgfProfile: historical },
    ...metadata("2026-08-22T12:05:00.000Z"),
  });
  const incoming = buildEwgfProfileSourceSnapshot({
    ...profile,
    latestBattleAt: "2026-08-22T12:00:00.000Z",
  }, "2026-08-22T12:06:00.000Z");

  const applied = applySourceSnapshotsToFetchedStats(current, { ewgfProfile: incoming }, metadata("2026-08-22T12:06:00.000Z"));
  assert.equal(applied.changed, true);
  assert.equal(applied.decisions.ewgfProfile.action, "repair");
  assert.equal(applied.node.sourceSnapshots.ewgfProfile.revisionAt, historical.revisionAt);
  assert.equal(applied.node.sourceSnapshots.ewgfProfile.observedAt, "2026-08-22T12:06:00.000Z");
  assert.equal(applied.node.profileStats.danRank, "Fujin");
  assert.equal(applied.node.profileStats.rankIcon, "kazuya.png");
  assert.equal(applied.node.profileStats.rankIsAllTimeHighest, false);

  const replay = applySourceSnapshotsToFetchedStats(applied.node, { ewgfProfile: incoming }, metadata("2026-08-22T12:07:00.000Z"));
  assert.equal(replay.changed, false);
});

test("older EWGF observation cannot replace a valid current rank presentation", () => {
  const currentSource = buildEwgfProfileSourceSnapshot({
    ...profile,
    latestBattleAt: "2026-08-22T12:00:00.000Z",
  }, "2026-08-22T12:05:00.000Z");
  const current = materializeFetchedStats({
    current: {},
    sourceSnapshots: { ewgfProfile: currentSource },
    ...metadata("2026-08-22T12:05:00.000Z"),
  });
  const olderHistorical = buildEwgfProfileSourceSnapshot({
    ...profile,
    latestBattleAt: "2026-08-20T10:00:00.000Z",
    characters: [{ ...profile.characters[0], currentRank: "Raijin", rankIcon: "older.png" }, profile.characters[1]],
  }, "2026-08-23T12:06:00.000Z");

  const applied = applySourceSnapshotsToFetchedStats(current, { ewgfProfile: olderHistorical }, metadata("2026-08-23T12:06:00.000Z"));
  assert.equal(applied.changed, false);
  assert.equal(applied.node.profileStats.danRank, "Fujin");
  assert.equal(applied.node.profileStats.rankIcon, "kazuya.png");
  assert.equal(applied.node.profileStats.rankIsAllTimeHighest, false);
  assert.equal(applied.node.sourceSnapshots.ewgfProfile.revisionAt, currentSource.revisionAt);
});

test("background source snapshots carry the highest-rank icon and fallback flag", () => {
  const background = buildBackgroundSourceSnapshots({
    ...profile,
    rankIcon: "",
    highestRank: "Tekken God Supreme",
    highestRankIcon: "supreme.png",
    characters: [{ ...profile.characters[0], rankIcon: "" }, profile.characters[1]],
    wavuRatings: null,
  }, profileObservedAt);
  assert.equal(background.ewgfProfile.data.highestRankIcon, "supreme.png");
  assert.equal(background.ewgfProfile.data.rankIcon, "supreme.png");
  assert.equal(background.ewgfProfile.data.rankIsAllTimeHighest, true);
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
  assert.match(workerSource, /const latestCachedResponse = await getFreshCachedJson\(cache, latestCacheKey, LATEST_BATTLE_CACHE_TTL_SECONDS\);[\s\S]*?if \(latestCachedResponse\) \{[\s\S]*?if \(latestPersistRequested\) \{[\s\S]*?"latestActivity",\s*buildLatestActivitySourceSnapshot/);
  assert.match(workerSource, /if \(!forceRefresh\) \{[\s\S]*?const latestCachedResponse = await getFreshCachedJson\(cache, latestCacheKey/);
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
  assert.match(browserSource, /child\(['"]fetchedStats\/activityStats\/returnTracking['"]\)\.set/);
  assert.doesNotMatch(browserSource, /child\(['"]fetchedStats['"]\)\.child\(['"]activityStats['"]\)/);
  assert.match(browserSource, /getNewestReturnTracking\(legacyMemberStats,\s*localStats/);
  assert.match(listsSource, /workerFetchedStats/);
  assert.match(listsSource, /includeReturnTracking/);
  assert.match(listsSource, /setSharedBrowserMemberField/);
  assert.match(listsSource, /fetchedStats\/activityStats\/returnTracking/);
  const visibleLatestStart = listsSource.indexOf("  async function refreshVisibleLatestBattles");
  const visibleLatestEnd = listsSource.indexOf("\n  // Refresh the lightweight latest-battle endpoint", visibleLatestStart);
  assert.ok(visibleLatestStart >= 0 && visibleLatestEnd > visibleLatestStart, "visible latest refresh block must remain discoverable");
  const visibleLatestSource = listsSource.slice(visibleLatestStart, visibleLatestEnd);
  assert.match(visibleLatestSource, /mode=latest&persist=1\$\{force \? '&force=1' : ''\}/);
  assert.doesNotMatch(visibleLatestSource, /membersRef|firebase\.database|db\.ref/);
  const latestCardStart = listsSource.indexOf("  const updateLatestBattleCard");
  const latestCardEnd = listsSource.indexOf("\n  async function refreshNewMemberLatestBattle", latestCardStart);
  assert.ok(latestCardStart >= 0 && latestCardEnd > latestCardStart, "latest card update block must remain discoverable");
  const latestCardSource = listsSource.slice(latestCardStart, latestCardEnd);
  assert.match(latestCardSource, /stats\.latestBattleRevisionAt = previousAt/);
  assert.match(latestCardSource, /stats\.latestBattleRevisionAt = parsedAt/);
  assert.doesNotMatch(latestCardSource, /latestBattleRevisionAt\s*=\s*checkedAt/);
  assert.match(listsSource, /const existingSnapshot = await db\.ref\(root\)\.once\(['"]value['"]\)/);
  assert.match(listsSource, /await writeSharedListDelta\(shareId, previous, next\)/);
  assert.doesNotMatch(listsSource, /db\.ref\(root\)\.set\(payload\)/);
  assert.doesNotMatch(listsSource, /updates\[`sharedLists\/\$\{shareId\}\/members\/\$\{memberId\}`\]\s*=\s*after/);
  assert.match(listsSource, /Object\.entries\(after\)\.forEach/);
  assert.doesNotMatch(listsSource, /child\(key\)\.child\(['"]fetchedStats['"]\)\.child\(['"]activityStats['"]\)/);
  assert.match(integrationSource, /isManual\s*&&\s*forceRefresh[\s\S]*manualRefresh=1/);
});

test("canonical browser stats preserve and narrowly persist returnTracking", () => {
  const browserSource = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const start = browserSource.indexOf("    const WORKER_STATS_SCHEMA");
  const end = browserSource.indexOf("\n    function setLocalStats", start);
  assert.ok(start >= 0 && end > start, "return-tracking browser contract block must remain discoverable");
  const context = {
    console,
    localStorage: (() => {
      const values = new Map();
      return {
        getItem: key => values.has(key) ? values.get(key) : null,
        setItem: (key, value) => values.set(key, String(value)),
      };
    })(),
    window: {
      isDormantStats: stats => Boolean(stats?.rankIsAllTimeHighest)
        && Number(stats?.recentRankedGames7d || 0) < 3
        && Number(stats?.recentRankedGames30d || 0) < 10,
    },
    cleanTekkenId: value => String(value || "").replace(/[-ー−\s]/g, "").trim(),
  };
  context.writes = [];
  context.membersRef = {
    child: memberKey => ({
      child: path => ({
        set: value => {
          context.writes.push({ memberKey, path, value });
          return Promise.resolve();
        },
      }),
    }),
  };
  runInNewContext(`
    const LOCAL_STATS_CACHE_KEY = 'test-stats';
    const membersRef = globalThis.membersRef;
    const cleanTekkenId = globalThis.cleanTekkenId;
    const window = globalThis.window;
    const localStorage = globalThis.localStorage;
    ${browserSource.slice(start, end)}
    globalThis.getCanonicalStats = getLocalStats;
    globalThis.ensureCanonicalReturnTracking = window.ensureDormantReturnTracking;
  `, context);

  const previousTracking = {
    schema: "20260801-return-player",
    dormantSince: Date.parse("2026-08-01T00:00:00.000Z"),
    baselineLatestRankedBattleAt: "2026-08-01T00:00:00.000Z",
    returnReportedAt: 0,
    returnBadgeUntil: 0,
    returnedBattleAt: "",
  };
  const member = {
    gameId: "PLAYER-001",
    workerFetchedStats: {
      schema: "20260821-source-snapshots-v1",
      sourceSnapshots: {},
      profileStats: { mainChar: "Canonical Main", rankIsAllTimeHighest: true },
      activityStats: { latestRankedBattleAt: "2026-08-20T00:00:00.000Z" },
    },
    fetchedStats: {
      profileStats: { mainChar: "Stale Legacy Main" },
      activityStats: { returnTracking: previousTracking },
    },
  };

  const firstRead = context.getCanonicalStats("PLAYER-001", member);
  assert.equal(firstRead.mainChar, "Canonical Main");
  assert.deepEqual(JSON.parse(JSON.stringify(firstRead.returnTracking)), previousTracking);

  const transitioned = context.ensureCanonicalReturnTracking("member-1", member, firstRead);
  assert.ok(Number(transitioned.returnReportedAt) > 0);
  assert.equal(context.writes.length, 1);
  assert.deepEqual(context.writes[0].path, "fetchedStats/activityStats/returnTracking");

  const secondRead = context.getCanonicalStats("PLAYER-001", member);
  assert.equal(secondRead.mainChar, "Canonical Main");
  assert.deepEqual(JSON.parse(JSON.stringify(secondRead.returnTracking)), JSON.parse(JSON.stringify(transitioned)));
});

test("expired returnTracking null-clear is not resurrected from stale canonical stats", () => {
  const browserSource = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const start = browserSource.indexOf("    const WORKER_STATS_SCHEMA");
  const end = browserSource.indexOf("\n    function setLocalStats", start);
  assert.ok(start >= 0 && end > start, "return-tracking browser contract block must remain discoverable");
  const context = {
    console,
    localStorage: (() => {
      const values = new Map();
      return {
        getItem: key => values.has(key) ? values.get(key) : null,
        setItem: (key, value) => values.set(key, String(value)),
      };
    })(),
    window: {
      isDormantStats: stats => Boolean(stats?.rankIsAllTimeHighest)
        && Number(stats?.recentRankedGames7d || 0) < 3
        && Number(stats?.recentRankedGames30d || 0) < 10,
    },
    cleanTekkenId: value => String(value || "").replace(/[-ー−\s]/g, "").trim(),
  };
  context.writes = [];
  context.membersRef = {
    child: memberKey => ({
      child: path => ({
        set: value => {
          context.writes.push({ memberKey, path, value });
          return Promise.resolve();
        },
      }),
    }),
  };
  runInNewContext(`
    const LOCAL_STATS_CACHE_KEY = 'test-stats';
    const membersRef = globalThis.membersRef;
    const cleanTekkenId = globalThis.cleanTekkenId;
    const window = globalThis.window;
    const localStorage = globalThis.localStorage;
    ${browserSource.slice(start, end)}
    globalThis.getCanonicalStats = getLocalStats;
    globalThis.ensureCanonicalReturnTracking = window.ensureDormantReturnTracking;
  `, context);

  const staleTracking = {
    schema: "20260801-return-player",
    dormantSince: Date.parse("2026-08-01T00:00:00.000Z"),
    baselineLatestRankedBattleAt: "2026-08-01T00:00:00.000Z",
    returnReportedAt: Date.parse("2026-08-02T00:00:00.000Z"),
    returnBadgeUntil: Date.parse("2026-08-05T00:00:00.000Z"),
    returnedBattleAt: "2026-08-02T12:00:00.000Z",
  };
  const member = {
    gameId: "PLAYER002",
    workerFetchedStats: {
      schema: "20260821-source-snapshots-v1",
      sourceSnapshots: {},
      profileStats: {
        mainChar: "Canonical Main",
        rankIsAllTimeHighest: false,
        recentRankedGames7d: 3,
        returnTracking: staleTracking,
      },
      activityStats: {
        latestRankedBattleAt: "2026-08-20T00:00:00.000Z",
        returnTracking: staleTracking,
      },
      returnTracking: staleTracking,
    },
    fetchedStats: {
      profileStats: { mainChar: "Stale Legacy Main" },
      activityStats: { returnTracking: staleTracking },
    },
  };

  const firstRead = context.getCanonicalStats("PLAYER002", member);
  assert.equal(firstRead.mainChar, "Canonical Main");
  assert.equal(firstRead.latestRankedBattleAt, "2026-08-20T00:00:00.000Z");
  assert.deepEqual(JSON.parse(JSON.stringify(firstRead.returnTracking)), staleTracking);

  const cleared = context.ensureCanonicalReturnTracking("member-2", member, firstRead);
  assert.equal(cleared, null);
  assert.equal(context.writes.length, 1);
  assert.deepEqual(context.writes[0], {
    memberKey: "member-2",
    path: "fetchedStats/activityStats/returnTracking",
    value: null,
  });

  const secondRead = context.getCanonicalStats("PLAYER002", member);
  assert.equal(secondRead.mainChar, "Canonical Main");
  assert.equal(secondRead.latestRankedBattleAt, "2026-08-20T00:00:00.000Z");
  assert.equal(secondRead.returnTracking, undefined);
  assert.equal(secondRead.profileStats, undefined);
  assert.equal(secondRead.activityStats, undefined);
});
