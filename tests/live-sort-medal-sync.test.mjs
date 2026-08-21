import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const source = readFileSync(`${repoRoot}/user-lists-prototype.js`, "utf8");
const index = readFileSync(`${repoRoot}/index.html`, "utf8");

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
  assert.match(index, /user-lists-prototype\.js\?v=20260821-live-sort-medal-sync/);
});
