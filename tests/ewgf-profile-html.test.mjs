import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const workerSource = readFileSync(new URL("../worker/ewgf-worker-with-stat-pentagon.js", import.meta.url), "utf8");
const toPlain = value => JSON.parse(JSON.stringify(value));

function loadExtractors() {
  const parserStart = workerSource.indexOf("function decodeHtml");
  const parserEnd = workerSource.indexOf("\nasync function fetchOfficialLatestBattle", parserStart);
  const normalizeStart = workerSource.indexOf("\nfunction normalizeCharacterKey");
  const normalizeEnd = workerSource.indexOf("\nfunction rankedTotals", normalizeStart);
  assert.ok(parserStart >= 0 && parserEnd > parserStart, "parser helpers must remain discoverable");
  assert.ok(normalizeStart >= 0 && normalizeEnd > normalizeStart, "character normalizer must remain discoverable");

  return runInNewContext(`(() => {
    ${workerSource.slice(parserStart, parserEnd)}
    ${workerSource.slice(normalizeStart, normalizeEnd)}
    return {
      extractCharacters,
      extractTekkenProwess,
      extractHighestRankProfile,
      extractStatPentagon,
      extractCharacterModeStatsBatch,
      extractPlayerMessage,
      extractPlatformProfile,
      extractLatestBattle,
    };
  })()`, { URL, console, encodeURIComponent });
}

const statPentagonData = {
  attack: 80,
  defense: 70,
  technique: 60,
  spirit: 50,
  appeal: 40,
  attackComponents: { heavyDamage: 20, aggressiveness: 20, dominance: 20, attackFrequency: 20 },
  defenseComponents: { composure: 20, block: 20, evasion: 20, throwEscape: 20 },
  techniqueComponents: { judgement: 20, stageUse: 20, retaliation: 20, accuracy: 20 },
  spiritComponents: { closeBattles: 20, concentration: 20, fightingSpirit: 20, comeback: 20 },
  appealComponents: { fairness: 20, ambition: 20, versatility: 20, respect: 20 },
};

const playedCharacters = {
  Kazuya: {
    RANKED_BATTLE: {
      allTimeHighestRank: "Tekken God",
      characterWinrate: 0.5833,
      currentSeasonRank: "Fujin",
      wins: 7,
      losses: 5,
    },
    PLAYER_BATTLE: { wins: 2, losses: 1, characterWinrate: 0.6667 },
    QUICK_BATTLE: { wins: 1, losses: 0, characterWinrate: 1 },
  },
  Jin: {
    RANKED_BATTLE: {
      allTimeHighestRank: "",
      characterWinrate: 0,
      currentSeasonRank: null,
      wins: 0,
      losses: 0,
    },
  },
};

function syntheticProfileHtml({ includeLatestBattle = true, recentActivityDate = "2026-09-01T12:00:00.000Z" } = {}) {
  const playerMetadata = {
    tekkenPower: 345678,
    profileComment: "fixture message",
    platform: "STEAM",
    platformUsername: "12345678901234567",
  };
  if (includeLatestBattle) playerMetadata.latestBattle = "2026-08-30T12:00:00.000Z";

  const data = {
    playedCharacters,
    statPentagonData,
    playerMetadata,
    polarisProfile: { onlineId: "12345678901234567", platform: "STEAM", myComment: "fixture message" },
    recentActivity: [{ date: recentActivityDate, type: "RANKED_BATTLE", wins: 1, losses: 0 }],
  };
  const flightString = JSON.stringify(JSON.stringify(data)).slice(1, -1);
  return `<main>
    <div class="relative flex items-center gap-2.5 px-3 py-2.5">
      <a href="/character/KAZUYA" class="relative flex-shrink-0 rounded-full"><img src="/static/circular_character_icons/kazuya.webp" alt="Kazuya"></a>
      <div><a href="/character/KAZUYA">KAZUYA</a><img src="/static/rank-icons/FujinT8.webp" alt="Fujin"></div>
    </div>
    <div class="relative flex items-center gap-2.5 px-3 py-2.5">
      <a href="/character/JIN" class="relative flex-shrink-0 rounded-full"><img src="/static/circular_character_icons/jin.webp" alt="Jin"></a>
      <div><a href="/character/JIN">JIN</a><span>UNRANKED</span></div>
    </div>
    <div class="flex flex-col items-center gap-1"><img src="/static/rank-icons/TekkenGodT8.webp" alt="Tekken God rank icon"><span>All time highest rank</span></div>
    <p>Tekken Prowess</p><p>345,678</p>
    <span>Steam:</span><span>12345678901234567</span>
    <span>Player Message: "fixture message"</span>
  </main>
  <script>self.__next_f.push([1,"${flightString}"])</script>`;
}

test("new-layout structured characters normalize ranked and unranked cards", () => {
  const extractors = loadExtractors();
  const characters = extractors.extractCharacters(syntheticProfileHtml());

  assert.equal(characters.length, 2);
  assert.deepEqual(toPlain(characters.map((character) => character.characterCode)), ["KAZUYA", "JIN"]);
  assert.deepEqual(toPlain(characters[0]), {
    character: "Kazuya",
    characterCode: "KAZUYA",
    characterImage: "https://ewgf.gg/static/circular_character_icons/kazuya.webp",
    currentRank: "Fujin",
    rankIcon: "https://ewgf.gg/static/rank-icons/FujinT8.webp",
    wins: 7,
    losses: 5,
    games: 12,
  });
  assert.equal(characters[1].character, "Jin");
  assert.equal(characters[1].currentRank, "Unranked");
  assert.equal(characters[1].rankIcon, "");
  assert.equal(characters[1].games, 0);
});

test("legacy table remains a fallback and malformed structured HTML fails closed", () => {
  const extractors = loadExtractors();
  const legacy = `<table><tr><td><a href="/character/KAZUYA"><img src="/static/circular_character_icons/kazuya.webp" alt="Kazuya"></a></td><td><img src="/static/rank-icons/FujinT8.webp" alt="Fujin"></td><td><span class="text-green-500">7</span><span class="text-red-500">5</span></td></tr></table>`;
  const malformed = `<script>self.__next_f.push([1,"{\\"playedCharacters\\":{\\"Kazuya\\":}"])</script>`;

  assert.equal(extractors.extractCharacters(legacy)[0].currentRank, "Fujin");
  assert.equal(extractors.extractCharacters(legacy)[0].games, 12);
  assert.deepEqual(toPlain(extractors.extractCharacters(malformed)), []);
});

test("current structured fields remain individually parseable", () => {
  const extractors = loadExtractors();
  const html = syntheticProfileHtml();
  const modes = extractors.extractCharacterModeStatsBatch(html, ["RANKED_BATTLE", "PLAYER_BATTLE", "QUICK_BATTLE"]);
  const highest = extractors.extractHighestRankProfile(html);
  const platform = extractors.extractPlatformProfile(html);
  const message = extractors.extractPlayerMessage(html);
  const latest = extractors.extractLatestBattle(html, "fixture-target");

  assert.equal(extractors.extractTekkenProwess(html), 345678);
  assert.equal(extractors.extractStatPentagon(html).attack, 80);
  assert.equal(Object.keys(modes.RANKED_BATTLE).length, 2);
  assert.equal(Object.keys(modes.PLAYER_BATTLE).length, 1);
  assert.equal(Object.keys(modes.QUICK_BATTLE).length, 1);
  assert.equal(highest.rank, "Tekken God");
  assert.match(highest.rankIcon, /\/static\/rank-icons\/TekkenGodT8\.webp$/);
  assert.deepEqual(toPlain(platform), {
    platform: "steam",
    platformLabel: "Steam",
    platformId: "12345678901234567",
    platformProfileUrl: "https://steamcommunity.com/profiles/12345678901234567",
  });
  assert.equal(message, "fixture message");
  assert.deepEqual(toPlain(latest), { at: "2026-08-30T12:00:00.000Z", battleType: "", character: "" });
});

test("EWGF latest authority excludes recentActivity dates and paid fallback", () => {
  const extractors = loadExtractors();
  const latest = extractors.extractLatestBattle(syntheticProfileHtml(), "fixture-target");
  assert.ok(latest, "HTTP-200 new-layout profile must provide a source timestamp");
  assert.equal(latest.at, "2026-08-30T12:00:00.000Z");
  assert.doesNotMatch(workerSource, /extractStructuredArray\(html,\s*"recentActivity"\)/);

  const activityOnly = extractors.extractLatestBattle(
    syntheticProfileHtml({ includeLatestBattle: false }),
    "fixture-target",
  );
  assert.equal(activityOnly, null, "recentActivity alone must not generate an EWGF latest source");

  const definitionStart = workerSource.indexOf("async function fetchOfficialLatestBattle");
  const definitionEnd = workerSource.indexOf("async function fetchProfileHtmlLatestBattle", definitionStart);
  assert.ok(definitionStart >= 0 && definitionEnd > definitionStart, "official helper boundary must remain discoverable");
  const callSiteSource = workerSource.slice(0, definitionStart) + workerSource.slice(definitionEnd);
  assert.doesNotMatch(callSiteSource, /fetchOfficialLatestBattle\s*\(/);
  assert.match(workerSource, /let officialLatest = null/);
  assert.match(workerSource, /let officialLatestBattle = null/);
});
