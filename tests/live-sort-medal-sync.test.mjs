import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const source = readFileSync(`${repoRoot}/user-lists-prototype.js`, "utf8");
const index = readFileSync(`${repoRoot}/index.html`, "utf8");
const integration = readFileSync(`${repoRoot}/stats-integration-v4.js`, "utf8");

test("both stats-only reorder paths resync medals after moving cards", () => {
  const reorderStatements = [...source.matchAll(/grid\.appendChild\(fragment\);/g)];
  const reorderSyncs = [...source.matchAll(/grid\.appendChild\(fragment\);\s*addPerCardListActions\(\);/g)];

  assert.equal(reorderStatements.length, 2, "private and shared stats-only paths should each reorder cards");
  assert.equal(reorderSyncs.length, 2, "both stats-only reorder paths must resync card badges after DOM movement");
});

test("medal rank and value remain derived from the recalculated member maps", () => {
  assert.match(source, /const key = memberKeyFromCard\(card\);/);
  assert.match(source, /const skillRank = window\.memberSkillRanks && window\.memberSkillRanks\[key\];/);
  assert.match(source, /window\.memberSkillRankValues && window\.memberSkillRankValues\[key\]/);
});

test("the frontend script cache-buster identifies the medal-sync fix", () => {
  assert.match(index, /user-lists-prototype\.js\?v=20260821-latest-activity-persistence/);
});

test("page-open freshness requires a complete canonical profile before using the existing bounded repair path", () => {
  assert.match(source, /const hasCompleteCanonicalProfileSnapshot =/);
  assert.match(source, /hasFreshProfileSnapshot = \(member, now = Date\.now\(\)\) => \{\s*if \(!hasCompleteCanonicalProfileSnapshot\(member\)\) return false;/);
  assert.match(source, /PAGE_OPEN_PROFILE_FRESHNESS_MS = 24 \* 60 \* 60 \* 1000/);
  assert.match(source, /\.filter\(\(\{ member \}\) => !hasFreshProfileSnapshot\(member, now\)\)/);
  assert.match(source, /window\.refreshCardStats\(gameId, key, \{[\s\S]*force: true/);
});

test("canonical profile freshness follows EWGF observedAt rather than latestActivity metadata", () => {
  const helperStart = source.indexOf("const canonicalWorkerStatsSchema =");
  const helperEnd = source.indexOf("\n  const clearPageOpenProfileRetryTimers", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "canonical freshness helpers must remain discoverable");
  const helperBlock = source.slice(helperStart, helperEnd);
  const { profileSnapshotTimestamp, hasFreshProfileSnapshot } = runInNewContext(
    `(() => { ${helperBlock}; return { profileSnapshotTimestamp, hasFreshProfileSnapshot }; })()`,
    { memberStats: member => member.workerFetchedStats, PAGE_OPEN_PROFILE_FRESHNESS_MS: 24 * 60 * 60 * 1000 },
  );
  const member = {
    workerFetchedStats: {
      schema: "20260821-source-snapshots-v1",
      updatedAt: "2026-08-22T12:00:00.000Z",
      fetchMeta: { completedAt: "2026-08-22T12:00:00.000Z" },
      sourceSnapshots: {
        ewgfProfile: { observedAt: "2026-08-20T00:00:00.000Z", data: { statPentagon: { offense: 80 } } },
        latestActivity: { observedAt: "2026-08-22T12:00:00.000Z", data: { latestBattleAt: "2026-08-22T12:00:00.000Z" } },
      },
    },
  };
  const ewgfTimestamp = Date.parse("2026-08-20T00:00:00.000Z");
  assert.equal(profileSnapshotTimestamp(member), ewgfTimestamp);

  const activityAdvanced = JSON.parse(JSON.stringify(member));
  activityAdvanced.workerFetchedStats.updatedAt = "2026-08-23T12:00:00.000Z";
  activityAdvanced.workerFetchedStats.fetchMeta.completedAt = "2026-08-23T12:00:00.000Z";
  activityAdvanced.workerFetchedStats.sourceSnapshots.latestActivity.observedAt = "2026-08-23T12:00:00.000Z";
  assert.equal(profileSnapshotTimestamp(activityAdvanced), ewgfTimestamp);

  const ewgfAdvanced = JSON.parse(JSON.stringify(member));
  ewgfAdvanced.workerFetchedStats.sourceSnapshots.ewgfProfile.observedAt = "2026-08-22T00:00:00.000Z";
  assert.equal(profileSnapshotTimestamp(ewgfAdvanced), Date.parse("2026-08-22T00:00:00.000Z"));
  assert.equal(hasFreshProfileSnapshot(ewgfAdvanced, Date.parse("2026-08-22T23:00:00.000Z")), true);
});

test("all visible rating paths reject undefined, null, and non-finite values", () => {
  const liveCardStart = index.indexOf("const ratingEl = container.querySelector('.val-rating');");
  const liveCardEnd = index.indexOf("const powerEl = container.querySelector('.val-power');", liveCardStart);
  assert.ok(liveCardStart >= 0 && liveCardEnd > liveCardStart);
  assert.match(index.slice(liveCardStart, liveCardEnd), /Number\.isFinite\(ratingValue\)/);
  assert.match(index, /stats-preview-rating val-rating[^\n]*Number\.isFinite\(Number\(cachedStats\.ratingMu\)\)/);
  assert.match(index, /const rating = stats\.ratingMu !== null && stats\.ratingMu !== undefined && stats\.ratingMu !== '' && Number\.isFinite\(Number\(stats\.ratingMu\)\)/);
  assert.match(integration, /const hasRating = stats\.ratingMu !== null && stats\.ratingMu !== undefined && stats\.ratingMu !== '' && Number\.isFinite\(numericRating\)/);
});
