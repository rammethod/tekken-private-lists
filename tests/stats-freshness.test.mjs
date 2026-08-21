import assert from "node:assert/strict";
import test from "node:test";

import {
  applyMonotonicSourceSnapshot,
  compareSourceRevision,
  normalizeSourceRevision,
} from "../worker/stats-freshness.mjs";

const olderRevision = "2026-08-01T00:00:00.000Z";
const equalRevision = "2026-08-02T00:00:00.000Z";
const newerRevision = "2026-08-03T00:00:00.000Z";

function snapshot(revisionAt, data, observedAt = "2026-08-04T00:00:00.000Z") {
  return { revisionAt, observedAt, data };
}

test("newer payload applies", () => {
  const result = applyMonotonicSourceSnapshot(
    snapshot(olderRevision, { wins: 1 }),
    snapshot(newerRevision, { wins: 2 }),
  );

  assert.equal(compareSourceRevision(olderRevision, newerRevision), "newer");
  assert.equal(result.accepted, true);
  assert.equal(result.action, "applied");
  assert.deepEqual(result.snapshot.data, { wins: 2 });
  assert.equal(result.snapshot.revisionAt, normalizeSourceRevision(newerRevision));
});

test("late older payload is rejected", () => {
  const current = snapshot(newerRevision, { wins: 2 });
  const result = applyMonotonicSourceSnapshot(current, snapshot(olderRevision, { wins: 1 }));

  assert.equal(compareSourceRevision(newerRevision, olderRevision), "older");
  assert.equal(result.accepted, false);
  assert.equal(result.action, "rejected");
  assert.deepEqual(result.snapshot, current);
});

test("equal revision cannot overwrite existing populated fields", () => {
  const current = snapshot(equalRevision, { wins: 3, rank: "A", note: "kept" });
  const result = applyMonotonicSourceSnapshot(
    current,
    snapshot(equalRevision, { wins: 99, rank: "S", note: null, extra: "filled" }, "2026-08-05T00:00:00.000Z"),
  );

  assert.equal(result.comparison, "equal");
  assert.equal(result.action, "merged");
  assert.deepEqual(result.snapshot.data, { wins: 3, rank: "A", note: "kept", extra: "filled" });
  assert.equal(result.snapshot.observedAt, "2026-08-05T00:00:00.000Z");
});

test("equal revision may fill a missing field", () => {
  const result = applyMonotonicSourceSnapshot(
    snapshot(equalRevision, { wins: 3 }),
    snapshot(equalRevision, { wins: 99, rank: "A" }),
  );

  assert.deepEqual(result.snapshot.data, { wins: 3, rank: "A" });
});

test("versioned current rejects unversioned incoming", () => {
  const current = snapshot(newerRevision, { wins: 2 });
  const result = applyMonotonicSourceSnapshot(
    current,
    snapshot(null, { wins: 999 }, "2026-08-10T00:00:00.000Z"),
  );

  assert.equal(result.comparison, "unversioned");
  assert.equal(result.accepted, false);
  assert.deepEqual(result.snapshot, current);
});

test("empty current accepts first unversioned snapshot without inventing revision", () => {
  const incoming = snapshot(null, { games: 10 });
  const result = applyMonotonicSourceSnapshot(null, incoming);

  assert.equal(result.accepted, true);
  assert.equal(result.action, "applied");
  assert.equal(result.snapshot.revisionAt, null);
  assert.deepEqual(result.snapshot.data, { games: 10 });
});

test("legacy unversioned current is not erased by another unversioned snapshot", () => {
  const current = snapshot(null, { wins: 7, rank: "A" }, "2026-08-01T00:00:00.000Z");
  const incoming = snapshot(null, { wins: 1, rating: 1800 }, "2026-08-02T00:00:00.000Z");
  const result = applyMonotonicSourceSnapshot(current, incoming);

  assert.equal(result.accepted, true);
  assert.equal(result.action, "merged");
  assert.equal(result.comparison, "unversioned");
  assert.equal(result.snapshot.revisionAt, null);
  assert.deepEqual(result.snapshot.data, { wins: 7, rank: "A", rating: 1800 });
  assert.equal(result.snapshot.observedAt, "2026-08-01T00:00:00.000Z");
});

test("versioned incoming supersedes legacy unversioned current", () => {
  const current = snapshot(null, { wins: 7, legacyOnly: true });
  const incoming = snapshot(newerRevision, { wins: 9, rank: "S" });
  const result = applyMonotonicSourceSnapshot(current, incoming);

  assert.equal(result.accepted, true);
  assert.equal(result.action, "applied");
  assert.equal(result.comparison, "unversioned");
  assert.equal(result.snapshot.revisionAt, normalizeSourceRevision(newerRevision));
  assert.deepEqual(result.snapshot.data, { wins: 9, rank: "S" });
});

test("observedAt newer but revision older is rejected", () => {
  const current = snapshot(newerRevision, { value: "new" }, "2026-08-03T01:00:00.000Z");
  const result = applyMonotonicSourceSnapshot(
    current,
    snapshot(olderRevision, { value: "late" }, "2026-12-31T00:00:00.000Z"),
  );

  assert.equal(result.accepted, false);
  assert.deepEqual(result.snapshot, current);
});

test("observedAt older but revision newer applies", () => {
  const result = applyMonotonicSourceSnapshot(
    snapshot(olderRevision, { value: "old" }, "2026-08-10T00:00:00.000Z"),
    snapshot(newerRevision, { value: "new" }, "2026-01-01T00:00:00.000Z"),
  );

  assert.equal(result.accepted, true);
  assert.deepEqual(result.snapshot.data, { value: "new" });
  assert.equal(result.snapshot.observedAt, "2026-01-01T00:00:00.000Z");
});

test("ewgfProfile and wavuRatings are independent domains", () => {
  const ewgf = applyMonotonicSourceSnapshot(
    snapshot(olderRevision, { latestBattleAt: olderRevision }),
    snapshot(newerRevision, { latestBattleAt: newerRevision }),
  );
  const wavu = applyMonotonicSourceSnapshot(
    snapshot(newerRevision, { latestRankedBattleAt: newerRevision }),
    snapshot(olderRevision, { latestRankedBattleAt: olderRevision }),
  );

  assert.equal(ewgf.accepted, true);
  assert.equal(wavu.accepted, false);
  assert.deepEqual(wavu.snapshot.data, { latestRankedBattleAt: newerRevision });
});

test("latestActivity is independent from ewgfProfile and wavuRatings", () => {
  const latestActivity = applyMonotonicSourceSnapshot(
    snapshot(olderRevision, { at: olderRevision }),
    snapshot(newerRevision, { at: newerRevision }),
  );
  const ewgf = applyMonotonicSourceSnapshot(
    snapshot(newerRevision, { latestBattleAt: newerRevision }),
    snapshot(olderRevision, { latestBattleAt: olderRevision }),
  );

  assert.equal(latestActivity.accepted, true);
  assert.equal(ewgf.accepted, false);
  assert.deepEqual(latestActivity.snapshot.data, { at: newerRevision });
});

test("invalid timestamp does not fall back to Date.now", () => {
  assert.equal(normalizeSourceRevision("not-a-timestamp"), null);
  const result = applyMonotonicSourceSnapshot(null, snapshot("invalid", { value: "unversioned" }));

  assert.equal(result.snapshot.revisionAt, null);
});

test("ISO, epoch seconds, and epoch milliseconds normalize to the same revision", () => {
  const expected = Date.parse("2026-08-02T00:00:00.000Z");

  assert.equal(normalizeSourceRevision("2026-08-02T00:00:00.000Z"), expected);
  assert.equal(normalizeSourceRevision(expected / 1000), expected);
  assert.equal(normalizeSourceRevision(String(expected)), expected);
});

test("same payload replay is deterministic and idempotent", () => {
  const current = snapshot(olderRevision, { wins: 1, losses: 2 });
  const incoming = snapshot(newerRevision, { wins: 3, losses: 2 });
  const first = applyMonotonicSourceSnapshot(current, incoming);
  const second = applyMonotonicSourceSnapshot(current, incoming);
  const replay = applyMonotonicSourceSnapshot(first.snapshot, incoming);

  assert.deepEqual(first, second);
  assert.deepEqual(replay.snapshot, first.snapshot);
});

test("late old payload after new payload leaves logical data unchanged", () => {
  const oldSnapshot = snapshot(olderRevision, { wins: 1, rank: "A" });
  const newSnapshot = snapshot(newerRevision, { wins: 2, rank: "S" });
  const accepted = applyMonotonicSourceSnapshot(oldSnapshot, newSnapshot);
  const late = applyMonotonicSourceSnapshot(accepted.snapshot, oldSnapshot);

  assert.deepEqual(late.snapshot, accepted.snapshot);
  assert.equal(JSON.stringify(late.snapshot), JSON.stringify(accepted.snapshot));
});

test("null and undefined fields do not erase valid equal-revision data", () => {
  const current = snapshot(equalRevision, { wins: 3, rank: "A", active: false, count: 0 });
  const incoming = snapshot(equalRevision, { wins: null, rank: undefined, active: null, count: null });
  const result = applyMonotonicSourceSnapshot(current, incoming);

  assert.deepEqual(result.snapshot.data, current.data);
});
