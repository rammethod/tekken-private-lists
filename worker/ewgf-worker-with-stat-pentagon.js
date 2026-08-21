const WORKER_CACHE_TTL_SECONDS = 12 * 60 * 60;
const LATEST_BATTLE_CACHE_TTL_SECONDS = 5 * 60;
const WAVU_RATINGS_CACHE_TTL_SECONDS = 30 * 60;
const FORCE_REFRESH_GUARD_TTL_SECONDS = 30 * 60;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
// The upstream credential is supplied through the Cloudflare Worker secret
// binding. The Worker adds a shared 12-hour cache so clients do not spend the
// EWGF quota separately.

function getEwgfPublicApiKey(env) {
  const apiKey = String(env?.EWGF_PUBLIC_API_KEY || "").trim();
  if (!apiKey) throw new Error("EWGF API credential is not configured");
  return apiKey;
}

function json(data, status = 200, cacheControl = "no-store") {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cacheControl,
    },
  });
}

function withCacheStatus(response, status) {
  const headers = new Headers(response.headers);
  headers.set("X-EWGF-Worker-Cache", status);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// Cloudflare's Cache API can retain an entry beyond the intended freshness
// window. Every JSON response written by this Worker carries workerCachedAt,
// so validate that timestamp explicitly before treating a cache entry as HIT.
async function getFreshCachedJson(cache, key, ttlSeconds) {
  const cached = await cache.match(key);
  if (!cached) return null;
  try {
    const payload = await cached.clone().json();
    const cachedAt = Date.parse(payload?.workerCachedAt || "");
    const age = Date.now() - cachedAt;
    if (!Number.isFinite(cachedAt) || age < 0 || age >= ttlSeconds * 1000) return null;
    return cached;
  } catch (_) {
    return null;
  }
}

async function hasFreshThrottleMarker(cache, key, ttlSeconds) {
  const cached = await cache.match(key);
  if (!cached) return false;
  let createdAt = Number(cached.headers.get("X-Kentomo-Throttle-At") || 0);
  try {
    const marker = await cached.clone().json();
    createdAt = Number(marker?.createdAt || marker?.createdAtMs || createdAt);
  } catch (_) {}
  return Number.isFinite(createdAt)
    && createdAt > 0
    && Date.now() - createdAt >= 0
    && Date.now() - createdAt < ttlSeconds * 1000;
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function getAttribute(tag, name) {
  const pattern = new RegExp(`\\b${name}=["']([^"']*)["']`, "i");
  const match = tag.match(pattern);
  return match ? decodeHtml(match[1]) : "";
}

function parseNumber(value) {
  const normalized = String(value || "").replace(/[^\d]/g, "");
  if (!normalized) return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function extractSpanNumber(rowHtml, className) {
  const pattern = new RegExp(
    `<span\\b[^>]*class=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/span>`,
    "i",
  );
  const match = rowHtml.match(pattern);
  return match ? parseNumber(match[1]) : null;
}

function extractTekkenProwess(html) {
  const pattern =
    /<span\b[^>]*>\s*Tekken\s+Prowess:\s*<\/span>\s*<span\b[^>]*class=["'][^"']*\btext-amber-400\b[^"']*["'][^>]*>\s*([\d,]+)\s*<\/span>/i;
  const match = html.match(pattern);
  return match ? parseNumber(match[1]) : null;
}

function extractHighestRankProfile(html) {
  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0];
    const src = getAttribute(tag, "src");
    const alt = getAttribute(tag, "alt");
    if (!src.includes("/static/rank-icons/") || !/\brank icon$/i.test(alt)) continue;
    const rank = alt.replace(/\s+rank icon$/i, "").trim();
    if (!rank) continue;
    return {
      rank,
      rankIcon: src.startsWith("http") ? src : `https://ewgf.gg${src}`,
    };
  }
  return { rank: "", rankIcon: "" };
}

function platformFromUrl(value) {
  try {
    const hostname = new URL(decodeHtml(value)).hostname.toLowerCase().replace(/^www\./, "");
    if (hostname === "steamcommunity.com") return "steam";
    if (hostname === "psnprofiles.com") return "playstation";
    if (hostname === "xbox.com" || hostname.endsWith(".xbox.com")) return "xbox";
  } catch {}
  return "";
}

function buildPlatformProfile(platform, rawId, rawUrl = "") {
  const id = decodeHtml(rawId)
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64);
  if (!id) return null;

  let profileUrl = "";
  try {
    const parsed = new URL(decodeHtml(rawUrl));
    if (parsed.protocol === "https:" && platformFromUrl(parsed.href) === platform) {
      profileUrl = parsed.href;
    }
  } catch {}
  if (!profileUrl) {
    if (platform === "steam" && /^\d{15,20}$/.test(id)) {
      profileUrl = `https://steamcommunity.com/profiles/${encodeURIComponent(id)}`;
    } else if (platform === "playstation" && /^[A-Za-z0-9_.-]{2,32}$/.test(id)) {
      profileUrl = `https://psnprofiles.com/${encodeURIComponent(id)}`;
    } else if (platform === "xbox" && /^[A-Za-z0-9_. -]{1,32}$/.test(id)) {
      profileUrl = `https://account.xbox.com/en-us/profile?gamertag=${encodeURIComponent(id)}`;
    }
  }
  if (!profileUrl) return null;
  const labels = { steam: "Steam", playstation: "PlayStation", xbox: "Xbox" };
  return { platform, platformLabel: labels[platform], platformId: id, platformProfileUrl: profileUrl };
}

function extractPlatformProfile(html) {
  const source = String(html || "");
  // Prefer EWGF's own external link. This preserves the exact destination if
  // a platform changes its public-profile URL format.
  for (const match of source.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const platform = platformFromUrl(match[1]);
    if (!platform) continue;
    const linkText = decodeHtml(match[2]).replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
    const context = decodeHtml(source.slice(Math.max(0, match.index - 240), match.index))
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const contextMatches = platform === "steam"
      ? /Steam\s*:?\s*$/i.test(context)
      : (platform === "playstation"
        ? /(?:PlayStation|PSN)\s*:?\s*$/i.test(context)
        : /Xbox\s*:?\s*$/i.test(context));
    if (!contextMatches && !linkText) continue;
    const profile = buildPlatformProfile(platform, linkText, match[1]);
    if (profile) return profile;
  }

  // Next.js Flight data contains the same account IDs even when the visible
  // profile row changes markup.
  const keyGroups = [
    ["steam", ["steamId", "steam_id", "steamAccountId", "steam_account_id"]],
    ["playstation", ["psnId", "psn_id", "playstationId", "playstation_id"]],
    ["xbox", ["xboxId", "xbox_id", "xboxLiveId", "xbox_live_id"]],
  ];
  for (const [platform, keys] of keyGroups) {
    for (const key of keys) {
      const escaped = source.match(new RegExp(`\\\\"${key}\\\\"\\s*:\\s*\\\\"([^"\\\\]{1,64})\\\\"`, "i"));
      const plain = source.match(new RegExp(`"${key}"\\s*:\\s*"([^"]{1,64})"`, "i"));
      const profile = buildPlatformProfile(platform, escaped?.[1] || plain?.[1] || "");
      if (profile) return profile;
    }
  }

  // Last fallback: use the rendered label/value text that EWGF exposes as
  // Steam:ID, PlayStation:ID, or Xbox:ID.
  const visibleLines = decodeHtml(
    source
      .replace(/<script\b[\s\S]*?<\/script>/gi, "")
      .replace(/<style\b[\s\S]*?<\/style>/gi, "")
      .replace(/<\/(?:a|div|p|span|li|section|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  for (let index = 0; index < visibleLines.length; index += 1) {
    let match = visibleLines[index].match(/^(Steam|PlayStation|PSN|Xbox)\s*:\s*(.+)$/i);
    if (!match) {
      const labelOnly = visibleLines[index].match(/^(Steam|PlayStation|PSN|Xbox)\s*:?\s*$/i);
      if (labelOnly && visibleLines[index + 1]) match = [visibleLines[index], labelOnly[1], visibleLines[index + 1]];
    }
    if (!match) continue;
    const platform = /^steam$/i.test(match[1])
      ? "steam"
      : (/xbox/i.test(match[1]) ? "xbox" : "playstation");
    const profile = buildPlatformProfile(platform, match[2]);
    if (profile) return profile;
  }
  return null;
}

function cleanPlayerName(value, ewgfId = "") {
  const name = decodeHtml(String(value || ""))
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!name || name.length > 50) return "";
  if (String(name).toLowerCase() === String(ewgfId).toLowerCase()) return "";
  if (/^(?:player|profile|ewgf)$/i.test(name)) return "";
  return name;
}

function extractEwgfPlayerName(html, ewgfId) {
  const escapedId = String(ewgfId || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const jsonKeys = [
    "playerName",
    "player_name",
    "tekkenName",
    "tekken_name",
    "displayName",
    "display_name",
  ];
  for (const key of jsonKeys) {
    const patterns = [
      new RegExp(`\\\\"${key}\\\\"\\s*:\\s*\\\\"([^"\\\\]{1,50})\\\\"`, "i"),
      new RegExp(`"${key}"\\s*:\\s*"([^"]{1,50})"`, "i"),
    ];
    for (const pattern of patterns) {
      const match = html.match(pattern);
      const name = cleanPlayerName(match?.[1], ewgfId);
      if (name) return name;
    }
  }

  // The Next.js payload commonly stores the player's name next to tekken_id.
  const nearbyPatterns = [
    new RegExp(`\\\\"name\\\\"\\s*:\\s*\\\\"([^"\\\\]{1,50})\\\\"[^{}]{0,500}\\\\"tekken_id\\\\"\\s*:\\s*\\\\"${escapedId}\\\\"`, "i"),
    new RegExp(`\\\\"tekken_id\\\\"\\s*:\\s*\\\\"${escapedId}\\\\"[^{}]{0,500}\\\\"name\\\\"\\s*:\\s*\\\\"([^"\\\\]{1,50})\\\\"`, "i"),
    new RegExp(`"name"\\s*:\\s*"([^"]{1,50})"[^{}]{0,500}"tekken_id"\\s*:\\s*"${escapedId}"`, "i"),
    new RegExp(`"tekken_id"\\s*:\\s*"${escapedId}"[^{}]{0,500}"name"\\s*:\\s*"([^"]{1,50})"`, "i"),
  ];
  for (const pattern of nearbyPatterns) {
    const match = html.match(pattern);
    const name = cleanPlayerName(match?.[1], ewgfId);
    if (name) return name;
  }

  const title = decodeHtml(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "");
  return cleanPlayerName(
    title
      .replace(/(?:'|’|&#x27;|&#39;)s\s+Tekken\s*8\s+Profile.*$/i, "")
      .replace(/\s+Tekken\s*8\s+Profile.*$/i, "")
      .replace(/\s*[|·•-]\s*(?:Player\s+Profile\s*[|·•-]\s*)?EWGF.*$/i, "")
      .replace(/\s*[|·•-]\s*EWGF.*$/i, ""),
    ewgfId,
  );
}

function extractPlayerMessage(html) {
  const normalizeMessage = (value) => {
    let message = String(value || "").replace(/\s+/g, " ").trim();
    const quotePairs = [['"', '"'], ['“', '”'], ['「', '」'], ["'", "'"], ['‘', '’']];
    let changed = true;
    while (changed && message.length >= 2) {
      changed = false;
      for (const [open, close] of quotePairs) {
        if (message.startsWith(open) && message.endsWith(close)) {
          message = message.slice(open.length, -close.length).trim();
          changed = true;
          break;
        }
      }
    }
    return message.slice(0, 160);
  };
  const jsonKeys = ["playerMessage", "player_message", "playerMsg", "player_msg"];
  for (const key of jsonKeys) {
    const patterns = [
      new RegExp(`\\\\"${key}\\\\"\\s*:\\s*\\\\"((?:\\\\.|[^"\\\\]){1,300})\\\\"`, "i"),
      new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\]){1,300})"`, "i"),
    ];
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (!match) continue;
      const message = decodeHtml(match[1])
        .replace(/\\"/g, '"')
        .replace(/\\n/g, " ")
        .replace(/\\\\/g, "\\")
        .replace(/\s+/g, " ")
        .trim();
      if (message && !/^(?:null|undefined)$/i.test(message)) return normalizeMessage(message);
    }
  }

  const visibleText = decodeHtml(
    String(html || "")
      .replace(/<script\b[\s\S]*?<\/script>/gi, "")
      .replace(/<style\b[\s\S]*?<\/style>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:div|p|span|section|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const labelIndex = visibleText.findIndex((line) => /^Player\s+Message\s*:?\s*$/i.test(line));
  if (labelIndex < 0) return "";
  const message = String(visibleText[labelIndex + 1] || "").trim();
  if (!message || /^(?:Set Profile|All time highest rank)$/i.test(message)) return "";
  return normalizeMessage(message);
}

function extractCharacters(html) {
  const rowPattern = /<tr\b[^>]*>[\s\S]*?<\/tr>/gi;
  const characters = [];
  const seenCharacters = new Set();

  for (const rowMatch of html.matchAll(rowPattern)) {
    const rowHtml = rowMatch[0];
    if (
      !rowHtml.includes("/character/") ||
      !rowHtml.includes("text-green-500") ||
      !rowHtml.includes("text-red-500")
    ) {
      continue;
    }

    const imageTags = Array.from(
      rowHtml.matchAll(/<img\b[^>]*>/gi),
      (match) => match[0],
    );
    const characterImageTag = imageTags.find((tag) =>
      getAttribute(tag, "src").includes("/static/circular_character_icons/"),
    );
    const rankImageTag = imageTags.find((tag) =>
      getAttribute(tag, "src").includes("/static/rank-icons/"),
    );
    if (!characterImageTag) continue;

    const character = getAttribute(characterImageTag, "alt");
    const characterImagePath = getAttribute(characterImageTag, "src");
    const currentRank = rankImageTag ? getAttribute(rankImageTag, "alt") : "Unranked";
    const rankIconPath = rankImageTag ? getAttribute(rankImageTag, "src") : "";
    const characterCodeMatch = rowHtml.match(
      /href=["']\/character\/([^"'/?#]+)["']/i,
    );
    const characterCode = characterCodeMatch
      ? decodeHtml(characterCodeMatch[1])
      : "";
    const wins = extractSpanNumber(rowHtml, "text-green-500");
    const losses = extractSpanNumber(rowHtml, "text-red-500");
    if (!character || !currentRank || wins === null || losses === null) {
      continue;
    }

    const characterKey = characterCode || character.toUpperCase();
    if (seenCharacters.has(characterKey)) continue;
    seenCharacters.add(characterKey);

    characters.push({
      character,
      characterCode,
      characterImage: characterImagePath.startsWith("http")
        ? characterImagePath
        : `https://ewgf.gg${characterImagePath}`,
      currentRank,
      rankIcon: rankIconPath
        ? (rankIconPath.startsWith("http") ? rankIconPath : `https://ewgf.gg${rankIconPath}`)
        : "",
      wins,
      losses,
      games: wins + losses,
    });
  }

  return characters;
}

/*
 * Extract a balanced JSON object following a key in a Next.js Flight payload.
 * EWGF serializes the payload inside self.__next_f.push(), so property quotes
 * normally appear as \" in the raw HTML.
 */
function extractObjectAfterKey(html, key) {
  const markers = [`\\"${key}\\":`, `"${key}":`];

  for (const marker of markers) {
    const markerIndex = html.indexOf(marker);
    if (markerIndex < 0) continue;

    const objectStart = html.indexOf("{", markerIndex + marker.length);
    if (objectStart < 0) continue;

    let depth = 0;
    for (let index = objectStart; index < html.length; index += 1) {
      if (html[index] === "{") depth += 1;
      if (html[index] === "}") depth -= 1;

      if (depth === 0) {
        return html.slice(objectStart, index + 1);
      }
    }
  }

  return null;
}

function extractArrayAfterKey(html, key) {
  const markers = [`\\"${key}\\":`, `"${key}":`];
  for (const marker of markers) {
    const markerIndex = html.indexOf(marker);
    if (markerIndex < 0) continue;
    const arrayStart = html.indexOf("[", markerIndex + marker.length);
    if (arrayStart < 0) continue;
    let depth = 0;
    for (let index = arrayStart; index < html.length; index += 1) {
      if (html[index] === "[") depth += 1;
      if (html[index] === "]") depth -= 1;
      if (depth === 0) return html.slice(arrayStart, index + 1);
    }
  }
  return null;
}

function isScore(value, maximum) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= maximum
  );
}

function normalizeStatPentagon(value) {
  if (!value || typeof value !== "object") return null;

  const mainKeys = ["attack", "defense", "technique", "spirit", "appeal"];
  if (!mainKeys.every((key) => isScore(value[key], 100))) return null;

  const componentKeys = [
    "attackComponents",
    "defenseComponents",
    "techniqueComponents",
    "spiritComponents",
    "appealComponents",
  ];

  for (const key of componentKeys) {
    const components = value[key];
    if (!components || typeof components !== "object") return null;
    if (!Object.values(components).every((score) => isScore(score, 25))) {
      return null;
    }
  }

  return {
    attack: value.attack,
    defense: value.defense,
    technique: value.technique,
    spirit: value.spirit,
    appeal: value.appeal,
    attackComponents: value.attackComponents,
    defenseComponents: value.defenseComponents,
    techniqueComponents: value.techniqueComponents,
    spiritComponents: value.spiritComponents,
    appealComponents: value.appealComponents,
  };
}

function extractStatPentagon(html) {
  const serialized = extractObjectAfterKey(html, "statPentagonData");
  if (!serialized) return null;

  try {
    // The object contains numeric values and ASCII property names. Unescape the
    // quotes added by the surrounding Next.js JavaScript string.
    const parsed = JSON.parse(serialized.replace(/\\"/g, '"'));
    return normalizeStatPentagon(parsed);
  } catch {
    return null;
  }
}

function normalizeRankedCharacterStats(value) {
  if (!value || typeof value !== "object") return null;
  const wins = Number(value.wins);
  const losses = Number(value.losses);
  const reportedWinRate = Number(value.characterWinrate);
  if (
    !Number.isFinite(wins) ||
    !Number.isFinite(losses)
  ) {
    return null;
  }
  const games = wins + losses;
  const winRate = Number.isFinite(reportedWinRate)
    ? reportedWinRate
    : (games > 0 ? wins / games : 0);
  return {
    wins,
    losses,
    games,
    winRate,
    allTimeHighestRank: String(value.allTimeHighestRank || ""),
  };
}

function extractCharacterModeStatsBatch(html, modeNames) {
  const serialized = extractObjectAfterKey(html, "playedCharacters");
  const result = Object.fromEntries(modeNames.map((modeName) => [modeName, {}]));
  if (!serialized) return result;

  try {
    const playedCharacters = JSON.parse(serialized.replace(/\\"/g, '"'));
    for (const [character, modes] of Object.entries(playedCharacters)) {
      for (const modeName of modeNames) {
        const modeStats = normalizeRankedCharacterStats(modes?.[modeName]);
        if (modeStats) result[modeName][character] = modeStats;
      }
    }
    return result;
  } catch {
    return result;
  }
}

function extractCharacterModeStats(html, modeName) {
  return extractCharacterModeStatsBatch(html, [modeName])[modeName];
}

function extractRankedCharacterStats(html) {
  return extractCharacterModeStats(html, "RANKED_BATTLE");
}

function sumCharacterGames(characterStats) {
  return Object.values(characterStats || {}).reduce(
    (sum, value) => sum + Math.max(0, Number(value?.games || 0)),
    0
  );
}

function normalizeMatchupRecords(value) {
  if (!value || typeof value !== "object") return {};
  const records = {};
  for (const [opponent, record] of Object.entries(value)) {
    const wins = Number(record?.wins);
    const losses = Number(record?.losses);
    const games = Number(record?.totalMatches);
    const winRate = Number(record?.winRate);
    if (!opponent || ![wins, losses, games, winRate].every(Number.isFinite) || games <= 0) continue;
    records[opponent] = { wins, losses, games, winRate };
  }
  return records;
}

function extractRankedCharacterMatchupsResult(html) {
  const serialized = extractObjectAfterKey(html, "playedCharacters");
  if (!serialized) return { parsed: false, matchups: {} };
  try {
    const playedCharacters = JSON.parse(serialized.replace(/\\"/g, '"'));
    const matchups = {};
    for (const [character, modes] of Object.entries(playedCharacters)) {
      const ranked = modes?.RANKED_BATTLE;
      const currentSeason = normalizeMatchupRecords(ranked?.currentSeasonMatchups);
      if (!Object.keys(currentSeason).length) continue;
      matchups[character] = {
        scope: "current-season-ranked",
        records: currentSeason,
        bestMatchup: ranked?.bestMatchup || null,
        worstMatchup: ranked?.worstMatchup || null,
      };
    }
    return { parsed: true, matchups };
  } catch {
    return { parsed: false, matchups: {} };
  }
}

function extractRankedCharacterMatchups(html) {
  return extractRankedCharacterMatchupsResult(html).matchups;
}

const BATTLE_TYPE_MAP = { 1: "Quick Battle", 2: "Ranked Battle", 3: "Group Battle", 4: "Player Battle" };
const CHARACTER_ID_MAP = { 0:"Paul",1:"Law",2:"King",3:"Yoshimitsu",4:"Hwoarang",5:"Xiaoyu",6:"Jin",7:"Bryan",8:"Kazuya",9:"Steve",10:"Jack-8",11:"Asuka",12:"Devil Jin",13:"Feng",14:"Lili",15:"Dragunov",16:"Leo",17:"Lars",18:"Alisa",19:"Claudio",20:"Shaheen",21:"Nina",22:"Lee",23:"Kuma",24:"Panda",28:"Zafina",29:"Leroy",32:"Jun",33:"Reina",34:"Azucena",35:"Victor",36:"Raven",38:"Eddy",39:"Lidia",40:"Heihachi",41:"Clive",42:"Anna",43:"Fahkumram",44:"Armor King" };

function formatBattleType(value) {
  const raw = String(value || "").trim();
  const labels = {
    RANKED_BATTLE: "Ranked Battle",
    QUICK_BATTLE: "Quick Battle",
    GROUP_BATTLE: "Group Battle",
    PLAYER_BATTLE: "Player Battle",
  };
  return labels[raw] || BATTLE_TYPE_MAP[Number(raw)] || raw.replaceAll("_", " ");
}

function extractNextFlightBattles(html) {
  const battles = [];
  const seen = new Set();
  const patterns = [
    /\{\\"battleAt\\":\\"([^"\\]+)\\",\\"battleType\\":\\"([^"\\]*)\\"[^{}]*\}/g,
    /\{"battleAt":"([^"]+)","battleType":"([^"]*)"[^{}]*\}/g,
  ];
  for (const pattern of patterns) {
    for (const match of String(html || "").matchAll(pattern)) {
      if (battles.length >= 500) break;
      try {
        const normalized = match[0].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
        const battle = JSON.parse(normalized);
        const identity = [
          battle.battleAt, battle.p1PolarisId, battle.p2PolarisId,
          battle.p1Char, battle.p2Char,
        ].join("|");
        if (!seen.has(identity)) {
          seen.add(identity);
          battles.push(battle);
        }
      } catch {}
    }
    if (battles.length) break;
  }
  return battles;
}

function extractLatestBattle(html, ewgfId) {
  const latest = extractNextFlightBattles(html)
    .filter((battle) => battle && Number.isFinite(Date.parse(battle.battleAt)))
    .sort((a, b) => Date.parse(b.battleAt) - Date.parse(a.battleAt))[0];
  if (latest) {
    const targetId = String(ewgfId || "").toLowerCase();
    const isPlayerOne = String(latest.p1PolarisId || "").toLowerCase() === targetId;
    const isPlayerTwo = String(latest.p2PolarisId || "").toLowerCase() === targetId;
    return {
      at: latest.battleAt,
      battleType: formatBattleType(latest.battleType),
      character: String(isPlayerOne ? latest.p1Char : (isPlayerTwo ? latest.p2Char : "")),
    };
  }
  // A timestamp-only fallback keeps existing activity display working when
  // EWGF changes the serialized battles payload.
  const patterns = [/\\"battleAt\\":\\"([^"\\]+)\\"/g, /"battleAt":"([^"]+)"/g];
  let latestTimestamp = 0;
  let latestBattleAt = null;
  for (const pattern of patterns) for (const match of html.matchAll(pattern)) {
    const timestamp = Date.parse(match[1]);
    if (Number.isFinite(timestamp) && timestamp > latestTimestamp) { latestTimestamp = timestamp; latestBattleAt = match[1]; }
  }
  return latestBattleAt ? { at: latestBattleAt, battleType: "", character: "" } : null;
}

async function fetchOfficialLatestBattle(env, ewgfId) {
  const apiKey = getEwgfPublicApiKey(env);
  const response = await fetch(
    `https://api.ewgf.gg/external/battles/${encodeURIComponent(ewgfId)}`,
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
    },
  );
  if (!response.ok) throw new Error(`EWGF battles API ${response.status}`);
  const payload = await response.json();
  const battles = Array.isArray(payload) ? payload : (Array.isArray(payload?.data) ? payload.data : []);
  const latest = battles
    .filter((battle) => battle && Number.isFinite(Date.parse(battle.battle_at)))
    .sort((a, b) => Date.parse(b.battle_at) - Date.parse(a.battle_at))[0];
  if (!latest) return null;
  const playerOne = String(latest.p1_tekken_id || "").toLowerCase() === String(ewgfId).toLowerCase();
  const rawType = String(latest.battle_type || "");
  const typeLabels = {
    RANKED_BATTLE: "Ranked Battle",
    QUICK_BATTLE: "Quick Battle",
    GROUP_BATTLE: "Group Battle",
    PLAYER_BATTLE: "Player Battle",
  };
  const playerName = cleanPlayerName(playerOne
    ? (latest.p1_name || latest.p1_player_name || latest.p1_tekken_name || latest.player1_name)
    : (latest.p2_name || latest.p2_player_name || latest.p2_tekken_name || latest.player2_name), ewgfId);
  return {
    at: latest.battle_at,
    battleType: typeLabels[rawType] || rawType.replaceAll("_", " "),
    character: String(playerOne ? latest.p1_char : latest.p2_char || ""),
    playerName,
  };
}

async function fetchProfileHtmlLatestBattle(ewgfId) {
  const response = await fetch(`https://ewgf.gg/player/${encodeURIComponent(ewgfId)}`, {
    method: "GET",
    redirect: "follow",
    headers: {
      Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
      "User-Agent": "Mozilla/5.0 compatible EWGF latest battle checker",
    },
  });
  if (!response.ok) throw new Error(`EWGF profile fallback ${response.status}`);
  const html = await response.text();
  return {
    ...extractLatestBattle(html, ewgfId),
    playerName: extractEwgfPlayerName(html, ewgfId),
  };
}

async function fetchWavuLatestRankedBattle(ewgfId) {
  const response = await fetch(`https://wank.wavu.wiki/player/${encodeURIComponent(ewgfId)}`, {
    headers: {
      Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
      "User-Agent": "Mozilla/5.0 compatible Wavu latest battle checker",
    },
  });
  if (!response.ok) throw new Error(`Wavu profile ${response.status}`);
  const html = await response.text();
  const title = decodeHtml(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "");
  const playerName = title.replace(/\s*[•·]\s*Wavu Wank\s*$/i, "").trim();
  const ratingPattern = /<div class="rating">[\s\S]*?<div class="char">([^<]+)<\/div>[\s\S]*?<div class="last-seen">[\s\S]*?printDate\((\d+)\)/g;
  let latest = null;
  for (const match of html.matchAll(ratingPattern)) {
    const epochSeconds = Number(match[2]);
    if (!Number.isFinite(epochSeconds)) continue;
    if (!latest || epochSeconds > latest.epochSeconds) {
      latest = {
        epochSeconds,
        character: match[1].replace(/&amp;/g, "&").trim(),
      };
    }
  }
  if (!latest) {
    const fallback = html.match(/"battle_at":(\d+)/);
    if (!fallback) return null;
    latest = { epochSeconds: Number(fallback[1]), character: "" };
  }
  return {
    at: new Date(latest.epochSeconds * 1000).toISOString(),
    battleType: "Ranked Battle",
    character: latest.character,
    playerName: playerName && !/^Wavu Wank$/i.test(playerName) ? playerName.slice(0, 50) : "",
  };
}

function selectLatestBattle(candidates) {
  const sorted = candidates
    .filter((candidate) => candidate?.battle && Number.isFinite(Date.parse(candidate.battle.at)))
    .sort((a, b) => Date.parse(b.battle.at) - Date.parse(a.battle.at));
  const selected = sorted[0];
  if (!selected) return null;
  const selectedTime = Date.parse(selected.battle.at);
  const hasUsefulBattleType = (value) =>
    Boolean(value) && !/^(?:種別不明|unknown)$/i.test(String(value).trim());
  const sameBattleWithDetails = sorted.find((candidate) =>
    Math.abs(Date.parse(candidate.battle.at) - selectedTime) <= 1000
    && (hasUsefulBattleType(candidate.battle.battleType) || candidate.battle.character)
  );
  if (!sameBattleWithDetails || sameBattleWithDetails === selected) return selected;
  return {
    ...selected,
    battle: {
      ...selected.battle,
      battleType: hasUsefulBattleType(selected.battle.battleType)
        ? selected.battle.battleType
        : (sameBattleWithDetails.battle.battleType || ""),
      character: selected.battle.character || sameBattleWithDetails.battle.character || "",
    },
  };
}

function extractWavuRatings(html, ewgfId) {
  const charGamesMap = {};
  const charRatingMap = {};
  const charSigmaMap = {};
  const qualifiedCharGamesMap = {};
  const qualifiedCharRatingMap = {};
  const groups = String(html || "").split(/<div\s+class=["']rating-group["']\s*>/i).slice(1);
  for (const group of groups) {
    const label = decodeHtml(group.match(/<div\s+class=["']label["']\s*>([\s\S]*?)<\/div>/i)?.[1] || "");
    const isLeaderboard = /Leaderboard/i.test(label);
    const ratingPattern = /<div\s+class=["']rating["']\s*>\s*<div\s+class=["']char["']\s*>([\s\S]*?)<\/div>\s*<div\s+class=["']mu["']\s*>\s*μ\s*([\d,]+)\s*<\/div>\s*<div\s+class=["']sigma["']\s*>[\s\S]*?σ²\s*([\d,]+)[\s\S]*?<\/div>\s*<div\s+class=["']games["']\s*>\s*([\d,]+)\s*games?/gi;
    for (const match of group.matchAll(ratingPattern)) {
      const character = decodeHtml(match[1]);
      const rating = parseNumber(match[2]);
      const sigma = parseNumber(match[3]);
      const games = parseNumber(match[4]);
      if (!character || rating === null || games === null) continue;
      charRatingMap[character] = rating;
      charGamesMap[character] = games;
      if (sigma !== null) charSigmaMap[character] = sigma;
      // Trust the page's current group membership. The displayed integer can
      // round to 75 even though the underlying value is just below the cutoff.
      if (isLeaderboard) {
        qualifiedCharRatingMap[character] = rating;
        qualifiedCharGamesMap[character] = games;
      }
    }
  }
  const qualified = Object.entries(qualifiedCharRatingMap)
    .map(([character, ratingMu]) => ({
      character,
      ratingMu,
      games: qualifiedCharGamesMap[character] || 0,
      sigma: charSigmaMap[character] ?? null,
    }))
    .sort((a, b) => b.ratingMu - a.ratingMu || b.games - a.games);
  let recentRankedBattles = [];
  const battleDataMatch = String(html || "").match(/const\s+data\s*=\s*(\[[\s\S]*?["']?battle_at["']?[\s\S]*?\]);/i);
  if (battleDataMatch) {
    try {
      const parsedBattles = JSON.parse(battleDataMatch[1]);
      if (Array.isArray(parsedBattles)) {
        recentRankedBattles = parsedBattles.filter((battle) =>
          battle && Number.isFinite(Number(battle.battle_at))
        );
      }
    } catch {}
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  const sevenDaysAgo = nowSeconds - 7 * 24 * 60 * 60;
  const thirtyDaysAgo = nowSeconds - 30 * 24 * 60 * 60;
  const recentRankedGames7d = recentRankedBattles.filter((battle) =>
    Number(battle.battle_at) >= sevenDaysAgo
  ).length;
  const recentRankedGames30d = recentRankedBattles.filter((battle) =>
    Number(battle.battle_at) >= thirtyDaysAgo
  ).length;
  const latestRankedEpoch = recentRankedBattles.reduce((latest, battle) =>
    Math.max(latest, Number(battle.battle_at) || 0), 0
  );
  return {
    charGamesMap,
    charRatingMap,
    charSigmaMap,
    qualifiedCharGamesMap,
    qualifiedCharRatingMap,
    mainChar: qualified[0]?.character || null,
    mainCharGames: qualified[0]?.games || null,
    ratingMu: qualified[0]?.ratingMu ?? null,
    selectionSource: qualified.length ? "wavu-leaderboard-highest-mu" : "no-qualified-character",
    recentRankedGames7d,
    recentRankedGames30d,
    recentRankedSampleSize: recentRankedBattles.length,
    latestRankedBattleAt: latestRankedEpoch
      ? new Date(latestRankedEpoch * 1000).toISOString()
      : null,
  };
}

async function fetchWavuRatings(ewgfId) {
  const response = await fetch(`https://wank.wavu.wiki/player/${encodeURIComponent(ewgfId)}`, {
    headers: {
      Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
      "User-Agent": "Mozilla/5.0 compatible Wavu ratings checker",
    },
  });
  if (!response.ok) throw new Error(`Wavu ratings page ${response.status}`);
  const parsed = extractWavuRatings(await response.text(), ewgfId);
  if (!Object.keys(parsed.charRatingMap).length) throw new Error("Wavu ratings were not detected");
  return parsed;
}

// Monthly awards are deliberately server-side. FIREBASE_SERVICE_ACCOUNT_JSON is
// a Cloudflare Worker secret, never a browser value or repository setting.
const FIREBASE_AWARD_SCOPE = "https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email";
const AWARD_MAX_LISTS_PER_TICK = 1;
const AWARD_MAX_MEMBERS_PER_LIST = 50;
const AWARD_SNAPSHOT_MEMBERS_PER_TICK = 1;
const BACKGROUND_SYNC_INTERVAL_MS = 12 * 60 * 60 * 1000;
const BACKGROUND_SYNC_PER_TICK = 1;
const BACKGROUND_SYNC_FAILURE_BACKOFF_MS = [15 * 60 * 1000, 60 * 60 * 1000, 6 * 60 * 60 * 1000, 12 * 60 * 60 * 1000];
const BACKGROUND_SYNC_SCHEMA = "20260801-all-match-totals";
const WORKER_BUILD = "20260820-background-latest-and-queue-guard";

function base64Url(bytes) {
  let binary = "";
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function textBase64Url(value) {
  return base64Url(new TextEncoder().encode(value));
}

function pemToArrayBuffer(pem) {
  const body = String(pem || "").replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function getFirebaseAccessToken(env) {
  if (!env.FIREBASE_SERVICE_ACCOUNT_JSON) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON secret is not configured");
  const account = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);
  if (!account.client_email || !account.private_key) throw new Error("Firebase service account secret is incomplete");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${textBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${textBase64Url(JSON.stringify({
    iss: account.client_email,
    scope: FIREBASE_AWARD_SCOPE,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3300,
  }))}`;
  const key = await crypto.subtle.importKey("pkcs8", pemToArrayBuffer(account.private_key), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${base64Url(signature)}` }),
  });
  if (!tokenResponse.ok) throw new Error(`Firebase OAuth ${tokenResponse.status}`);
  const token = await tokenResponse.json();
  if (!token.access_token) throw new Error("Firebase OAuth did not return an access token");
  return token.access_token;
}

function firebaseDatabaseUrl(env) {
  return String(env.FIREBASE_DATABASE_URL || "https://tekken-private-lists-default-rtdb.asia-southeast1.firebasedatabase.app").replace(/\/$/, "");
}

async function firebaseRequest(env, token, path, options = {}) {
  const safePath = String(path || "").split("/").filter(Boolean).map(encodeURIComponent).join("/");
  const response = await fetch(`${firebaseDatabaseUrl(env)}/${safePath}.json`, {
    method: options.method || "GET",
    headers: { Authorization: `Bearer ${token}`, ...(options.body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  if (!response.ok) throw new Error(`Firebase RTDB ${options.method || "GET"} ${response.status} at ${path}`);
  return response.status === 204 ? null : response.json();
}

function jstDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
}

function awardPeriodKey(parts) {
  return `${parts.year}-${String(parts.month).padStart(2, "0")}`;
}

function jstDayKey(parts = jstDateParts()) {
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function lastJstDay(parts) {
  return new Date(Date.UTC(parts.year, parts.month, 0)).getUTCDate();
}

async function fetchAwardSnapshot(env, gameId) {
  const [profileResult, wavuResult] = await Promise.allSettled([
    fetch(`https://ewgf.gg/player/${encodeURIComponent(gameId)}`, { headers: { Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8", "User-Agent": "Mozilla/5.0 compatible Kentomo awards collector" } }),
    fetchWavuRatings(gameId),
  ]);
  if (profileResult.status !== "fulfilled" || !profileResult.value.ok) throw new Error("EWGF profile could not be collected");
  const html = await profileResult.value.text();
  const characters = extractCharacters(html);
  if (!characters.length) throw new Error("EWGF character table was not detected");
  let latestBattle = extractLatestBattle(html, gameId);
  if (!latestBattle) {
    try { latestBattle = await fetchOfficialLatestBattle(env, gameId); }
    catch (error) { console.warn("Kentomo background latest battle fallback failed", gameId, error instanceof Error ? error.message : String(error)); }
  }
  const modeStats = extractCharacterModeStatsBatch(html, ["RANKED_BATTLE", "PLAYER_BATTLE", "QUICK_BATTLE", "GROUP_BATTLE"]);
  const rankedCharacterStats = modeStats.RANKED_BATTLE;
  const playerCharacterStats = modeStats.PLAYER_BATTLE;
  const quickCharacterStats = modeStats.QUICK_BATTLE;
  const groupCharacterStats = modeStats.GROUP_BATTLE;
  const characterRanks = Object.fromEntries(characters.map((character) => [character.character, {
    rank: character.currentRank || "",
    rankIcon: character.rankIcon || "",
    characterImage: character.characterImage || "",
  }]));
  const wavu = wavuResult.status === "fulfilled" ? wavuResult.value : null;
  return {
    gameId,
    capturedAt: new Date().toISOString(),
    playerName: extractEwgfPlayerName(html, gameId),
    tekkenProwess: extractTekkenProwess(html),
    highestRank: extractHighestRankProfile(html).rank || null,
    rankedCharacterStats,
    totalRankedGames: sumCharacterGames(rankedCharacterStats),
    totalPlayerMatchGames: sumCharacterGames(playerCharacterStats),
    totalQuickMatchGames: sumCharacterGames(quickCharacterStats),
    totalGroupMatchGames: sumCharacterGames(groupCharacterStats),
    characterRanks,
    ratingMu: wavu?.ratingMu ?? null,
    recentRankedGames30d: wavu?.recentRankedGames30d ?? null,
    latestRankedBattleAt: wavu?.latestRankedBattleAt ?? null,
    latestBattleAt: latestBattle?.at || null,
    latestBattleCharacter: latestBattle?.character || "",
    latestBattleType: latestBattle?.battleType || "",
    source: wavu ? "ewgf-profile+wavu" : "ewgf-profile",
  };
}

function normalizeCharacterKey(value) {
  return String(value || "").normalize("NFKD").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function rankedTotals(snapshot) {
  return Object.values(snapshot?.rankedCharacterStats || {}).reduce((total, stats) => ({
    wins: total.wins + Math.max(0, Number(stats?.wins) || 0),
    losses: total.losses + Math.max(0, Number(stats?.losses) || 0),
  }), { wins: 0, losses: 0 });
}

const RANK_ORDER = ["Beginner", "1st Dan", "2nd Dan", "3rd Dan", "4th Dan", "5th Dan", "6th Dan", "7th Dan", "8th Dan", "9th Dan", "10th Dan", "Initiate", "Disciple", "Brawler", "Ranger", "Cavalry", "Warrior", "Assailant", "Dominator", "Vanquisher", "Destroyer", "Eliminator", "Garyu", "Shinryu", "Tenryu", "Mighty Ruler", "Flame Ruler", "Battle Ruler", "Fujin", "Raijin", "Kishin", "Bushin", "Tekken King", "Tekken Emperor", "Tekken God", "Tekken God Supreme", "God of Destruction"].map((rank, index) => [rank.toLowerCase(), index]);
const RANK_ORDER_MAP = new Map(RANK_ORDER);
const rankOrder = value => RANK_ORDER_MAP.get(String(value || "").trim().toLowerCase()) ?? null;

function bestPromotion(before, after) {
  const beforeRanks = before?.characterRanks || {};
  const afterRanks = after?.characterRanks || {};
  let best = null;
  for (const [afterCharacter, afterRank] of Object.entries(afterRanks)) {
    const beforeEntry = Object.entries(beforeRanks).find(([character]) => normalizeCharacterKey(character) === normalizeCharacterKey(afterCharacter))?.[1];
    const delta = rankOrder(afterRank?.rank) - rankOrder(beforeEntry?.rank);
    if (!beforeEntry || !Number.isFinite(delta) || delta <= 0 || (best && delta <= best.delta)) continue;
    best = { character: afterCharacter, delta, fromRank: beforeEntry.rank, fromRankIcon: beforeEntry.rankIcon || "", toRank: afterRank.rank, toRankIcon: afterRank.rankIcon || "" };
  }
  return best;
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function captureAwardSnapshotChunk(env, list, previous = {}) {
  const members = Object.entries(list?.members || {}).slice(0, AWARD_MAX_MEMBERS_PER_LIST);
  const pending = members.filter(([memberId]) => !Object.prototype.hasOwnProperty.call(previous || {}, memberId));
  if (!pending.length) return { snapshot: previous || {}, complete: true, captured: 0, total: members.length };
  const captured = await mapWithConcurrency(pending.slice(0, AWARD_SNAPSHOT_MEMBERS_PER_TICK), 1, async ([memberId, member]) => {
    const gameId = String(member?.gameId || "").trim();
    if (!/^[A-Za-z0-9_-]{3,64}$/.test(gameId)) return [memberId, { error: "Invalid Tekken ID", capturedAt: new Date().toISOString() }];
    try {
      return [memberId, await fetchAwardSnapshot(env, gameId)];
    } catch (error) {
      return [memberId, { gameId, error: error instanceof Error ? error.message : String(error), capturedAt: new Date().toISOString() }];
    }
  });
  const snapshot = { ...(previous || {}), ...Object.fromEntries(captured) };
  return { snapshot, complete: pending.length <= AWARD_SNAPSHOT_MEMBERS_PER_TICK, captured: captured.length, total: members.length };
}

function makeAwardResults(start, end) {
  const candidates = Object.keys(end || {}).map((memberId) => {
    const before = start?.[memberId]; const after = end?.[memberId];
    if (!before || !after || before.error || after.error) return null;
    const beforeTotals = rankedTotals(before); const afterTotals = rankedTotals(after);
    const rankedGameDelta = Math.max(0, (afterTotals.wins + afterTotals.losses) - (beforeTotals.wins + beforeTotals.losses));
    return { memberId, name: after.playerName || before.playerName || after.gameId, rankedGameDelta, prowessDelta: Number(after.tekkenProwess || 0) - Number(before.tekkenProwess || 0), ratingDelta: Number.isFinite(after.ratingMu) && Number.isFinite(before.ratingMu) ? after.ratingMu - before.ratingMu : null, promotion: bestPromotion(before, after) };
  }).filter(Boolean);
  const winner = (key, predicate = () => true) => candidates.filter(predicate).sort((a, b) => Number(b[key]) - Number(a[key]) || a.name.localeCompare(b.name, "ja"))[0] || null;
  const category = (key, title, winnerEntry, value, suffix) => winnerEntry && Number.isFinite(value(winnerEntry)) && value(winnerEntry) > 0 ? { key, title, memberId: winnerEntry.memberId, name: winnerEntry.name, value: value(winnerEntry), suffix } : null;
  return {
    generatedAt: new Date().toISOString(),
    eligiblePlayers: candidates.length,
    categories: [
      category("most_ranked_matches", "最多ランクマ", winner("rankedGameDelta"), (entry) => entry.rankedGameDelta, "試合"),
      ...(() => { const entry = candidates.filter(candidate => candidate.promotion).sort((a, b) => b.promotion.delta - a.promotion.delta)[0]; return entry ? [{ key: "promotion", title: "昇段", memberId: entry.memberId, name: entry.name, value: entry.promotion.delta, suffix: "段", promotion: entry.promotion }] : []; })(),
      category("prowess_growth", "鉄拳力アップ", winner("prowessDelta"), (entry) => entry.prowessDelta, ""),
      category("rating_growth", "レートアップ", winner("ratingDelta", (entry) => entry.ratingDelta !== null), (entry) => entry.ratingDelta, ""),
    ].filter(Boolean),
  };
}

function makeBackgroundStats(snapshot) {
  const rankedEntries = Object.entries(snapshot.rankedCharacterStats || {}).sort(([, a], [, b]) => Number(b.games || 0) - Number(a.games || 0));
  const [mainChar, ranked] = rankedEntries[0] || ["", {}];
  const totalRankedGames = Math.max(0, Number(snapshot.totalRankedGames || 0));
  const totalPlayerMatchGames = Math.max(0, Number(snapshot.totalPlayerMatchGames || 0));
  const totalQuickMatchGames = Math.max(0, Number(snapshot.totalQuickMatchGames || 0));
  const totalGroupMatchGames = Math.max(0, Number(snapshot.totalGroupMatchGames || 0));
  const totalRecordedGames = totalRankedGames + totalPlayerMatchGames + totalQuickMatchGames + totalGroupMatchGames;
  const characterSelectionTop = rankedEntries.slice(0, 2).map(([character, value]) => ({ character, characterImage: snapshot.characterRanks?.[character]?.characterImage || "", lifetimeGames: Number(value.games || 0), selectionSource: "ewgf-ranked-games" }));
  const rank = Object.entries(snapshot.characterRanks || {}).find(([character]) => normalizeCharacterKey(character) === normalizeCharacterKey(mainChar))?.[1] || {};
  const updatedAt = Date.now();
  const latestBattleTimestamp = Date.parse(snapshot.latestBattleAt || "");
  const latestActivity = Number.isFinite(latestBattleTimestamp) ? {
    lastSeenTimestamp: latestBattleTimestamp,
    latestBattleCharacter: snapshot.latestBattleCharacter || "",
    latestBattleType: snapshot.latestBattleType || "",
    latestBattleCheckedAt: updatedAt,
    latestBattleRevisionAt: updatedAt,
  } : {};
  return { gameId: snapshot.gameId, mainChar, mainCharGames: Number(ranked.games || 0), totalRankedGames, totalPlayerMatchGames, totalQuickMatchGames, totalGroupMatchGames, totalRankedAndPlayerGames: totalRankedGames + totalPlayerMatchGames, totalRecordedGames, wins: Number(ranked.wins || 0), losses: Number(ranked.losses || 0), rankedWinRate: ranked.games ? Number(ranked.wins || 0) / Number(ranked.games) : 0, rankedDataVerified: true, danRank: rank.rank || "-", rankIcon: rank.rankIcon || "", tekkenPower: Number(snapshot.tekkenProwess || 0), ratingMu: snapshot.ratingMu ?? null, characterSelectionTop, recentRankedGames30d: Number(snapshot.recentRankedGames30d || 0), latestRankedBattleAt: snapshot.latestRankedBattleAt || "", playerName: snapshot.playerName || "", ...latestActivity, updatedAt, statsSource: "20260801-server-background-sync", fetchMeta: { state: "completed", completedAt: updatedAt, fetchedBy: "worker-background-12h", schema: "20260801-server-background-sync" }, isError: false };
}

function normalizedFirebaseGameId(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizedFirebaseShareId(value) {
  const shareId = String(value || "").trim();
  return /^[A-Za-z0-9_-]{16,64}$/.test(shareId) ? shareId : "";
}

async function collectFirebasePlayerTargets(env, token, gameId) {
  const normalizedId = normalizedFirebaseGameId(gameId);
  if (!normalizedId) return [];
  const users = await firebaseRequest(env, token, "users") || {};
  const targets = [];
  const shareOwners = new Map();
  for (const [uid, user] of Object.entries(users)) {
    for (const [listId, list] of Object.entries(user?.lists || {})) {
      const shareId = normalizedFirebaseShareId(list?.shareId);
      if (shareId) {
        const owners = shareOwners.get(shareId) || new Set();
        owners.add(`${uid}/${listId}`);
        shareOwners.set(shareId, owners);
      }
      for (const [memberId, member] of Object.entries(list?.members || {})) {
        if (normalizedFirebaseGameId(member?.gameId) !== normalizedId) continue;
        targets.push({
          uid,
          listId,
          memberId,
          shareId,
        });
      }
    }
  }
  const ambiguousShareIds = new Set([...shareOwners.entries()]
    .filter(([, owners]) => owners.size > 1)
    .map(([shareId]) => shareId));
  targets.forEach(target => {
    if (ambiguousShareIds.has(target.shareId)) target.shareId = "";
  });
  return targets;
}

function profileFirebasePatch(profile, ewgfId, fetchedAt, fetchedBy) {
  const characters = Array.isArray(profile?.characters) ? profile.characters : [];
  const rankedEntries = Object.entries(profile?.rankedCharacterStats || {})
    .sort(([, a], [, b]) => Number(b?.games || 0) - Number(a?.games || 0));
  const firstCharacter = characters[0] || {};
  const [rankedMainChar, rankedMain] = rankedEntries[0] || ["", {}];
  const mainChar = String(profile?.mainCharacter || rankedMainChar || firstCharacter.character || "");
  const mainCharacter = characters.find(character => normalizeCharacterKey(character?.character) === normalizeCharacterKey(mainChar)) || firstCharacter;
  const patch = {
    gameId: String(profile?.ewgfId || ewgfId),
    mainChar,
    mainCharGames: Number(profile?.games ?? rankedMain?.games ?? 0),
    wins: Number(profile?.wins ?? rankedMain?.wins ?? 0),
    losses: Number(profile?.losses ?? rankedMain?.losses ?? 0),
    rankedWinRate: Number(rankedMain?.winRate || 0),
    rankedDataVerified: true,
    danRank: String(profile?.currentRank || mainCharacter?.currentRank || profile?.highestRank || "-"),
    rankIcon: String(profile?.rankIcon || mainCharacter?.rankIcon || ""),
    tekkenPower: Number(profile?.tekkenProwess || 0),
    totalRankedGames: Number(profile?.totalRankedGames || 0),
    totalPlayerMatchGames: Number(profile?.totalPlayerMatchGames || 0),
    totalQuickMatchGames: Number(profile?.totalQuickMatchGames || 0),
    totalGroupMatchGames: Number(profile?.totalGroupMatchGames || 0),
    totalRecordedGames: Number(profile?.totalRecordedGames || 0),
    lastSeenTimestamp: Date.parse(profile?.latestBattleAt || "") || null,
    updatedAt: fetchedAt,
    statsSource: fetchedBy,
    fetchMeta: {
      state: "ready",
      completedAt: fetchedAt,
      fetchedBy,
      schema: "20260815-page-open-firebase-sync",
    },
    isError: false,
  };
  const characterSelectionTop = rankedEntries.slice(0, 2).map(([character, value]) => {
    const row = characters.find(item => normalizeCharacterKey(item?.character) === normalizeCharacterKey(character));
    return {
      position: character === rankedMainChar ? 1 : 2,
      character,
      characterImage: row?.characterImage || "",
      selectionSource: "ewgf-ranked-games",
      lifetimeGames: Number(value?.games || 0),
      wins: Number(value?.wins || 0),
      losses: Number(value?.losses || 0),
    };
  });
  if (characterSelectionTop.length) patch.characterSelectionTop = characterSelectionTop;
  if (profile?.statPentagon && typeof profile.statPentagon === "object") patch.statPentagon = profile.statPentagon;
  if (String(profile?.playerMessage || "").trim()) patch.playerMessage = String(profile.playerMessage).slice(0, 500);
  if (profile?.platformProfile && typeof profile.platformProfile === "object") {
    const platform = profile.platformProfile;
    if (platform.platform) patch.platform = String(platform.platform);
    if (platform.platformId) patch.platformId = String(platform.platformId);
    if (platform.platformProfileUrl) patch.platformProfileUrl = String(platform.platformProfileUrl);
  }
  if (profile?.latestBattle && typeof profile.latestBattle === "object") {
    if (profile.latestBattle.character) patch.latestBattleCharacter = String(profile.latestBattle.character);
    if (profile.latestBattle.battleType) patch.latestBattleType = String(profile.latestBattle.battleType);
  }
  return patch;
}

function wavuFirebasePatch(ratings, fetchedAt, fetchedBy) {
  const patch = { updatedAt: fetchedAt, statsSource: fetchedBy };
  if (ratings?.mainChar) {
    patch.mainChar = String(ratings.mainChar);
    if (ratings.mainCharGames !== null && ratings.mainCharGames !== undefined) patch.mainCharGames = Number(ratings.mainCharGames);
    patch.ratingCharacter = String(ratings.mainChar);
    if (ratings.selectionSource) patch.mainSelectionSource = String(ratings.selectionSource);
  }
  if (ratings?.ratingMu !== null && ratings?.ratingMu !== undefined) patch.ratingMu = Number(ratings.ratingMu);
  if (ratings?.charGamesMap && Object.keys(ratings.charGamesMap).length) patch.charGamesMap = ratings.charGamesMap;
  if (ratings?.charRatingMap && Object.keys(ratings.charRatingMap).length) patch.charRatingMap = ratings.charRatingMap;
  if (ratings?.qualifiedCharRatingMap && Object.keys(ratings.qualifiedCharRatingMap).length) patch.qualifiedCharRatingMap = ratings.qualifiedCharRatingMap;
  if (ratings?.recentRankedGames7d !== undefined) patch.recentRankedGames7d = Number(ratings.recentRankedGames7d || 0);
  if (ratings?.recentRankedGames30d !== undefined) patch.recentRankedGames30d = Number(ratings.recentRankedGames30d || 0);
  if (ratings?.recentRankedSampleSize !== undefined) patch.recentRankedSampleSize = Number(ratings.recentRankedSampleSize || 0);
  if (ratings?.latestRankedBattleAt) patch.latestRankedBattleAt = String(ratings.latestRankedBattleAt);
  return patch;
}

function appendFirebaseStatsUpdates(updates, basePath, patch) {
  Object.entries(patch || {}).forEach(([field, value]) => {
    if (value !== undefined) updates[`${basePath}/${field}`] = value;
  });
}

async function publishFirebasePlayerPatch(env, gameId, patch) {
  if (!env.FIREBASE_SERVICE_ACCOUNT_JSON || !patch || !Object.keys(patch).length) return { targets: 0, shared: 0, skipped: "secret-missing-or-empty" };
  const token = await getFirebaseAccessToken(env);
  const targets = await collectFirebasePlayerTargets(env, token, gameId);
  if (!targets.length) return { targets: 0, shared: 0 };
  const updates = {};
  const sharedIds = new Set();
  targets.forEach(target => {
    appendFirebaseStatsUpdates(
      updates,
      `users/${target.uid}/lists/${target.listId}/members/${target.memberId}/fetchedStats`,
      patch,
    );
    if (target.shareId) {
      appendFirebaseStatsUpdates(
        updates,
        `sharedLists/${target.shareId}/members/${target.memberId}/fetchedStats`,
        patch,
      );
      sharedIds.add(target.shareId);
    }
  });
  sharedIds.forEach(shareId => {
    updates[`sharedLists/${shareId}/updatedAt`] = Date.now();
  });
  await firebaseRequest(env, token, "", { method: "PATCH", body: updates });
  return { targets: targets.length, shared: sharedIds.size };
}

function scheduleFirebasePlayerPatch(env, ctx, gameId, patch) {
  const task = publishFirebasePlayerPatch(env, gameId, patch)
    .catch(error => {
      console.warn("Kentomo Firebase player publish failed", gameId, error instanceof Error ? error.message : String(error));
      return { targets: 0, shared: 0, error: error instanceof Error ? error.message : String(error) };
    });
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(task);
  return task;
}

async function runBackgroundSync(env) {
  if (!env.FIREBASE_SERVICE_ACCOUNT_JSON) return { processed: 0, skipped: "secret-missing" };
  const token = await getFirebaseAccessToken(env);
  const users = await firebaseRequest(env, token, "users");
  const locations = new Map();
  const shareOwners = new Map();
  for (const [uid, user] of Object.entries(users || {})) for (const [listId, list] of Object.entries(user?.lists || {})) {
    const shareId = normalizedFirebaseShareId(list?.shareId);
    if (shareId) {
      const owners = shareOwners.get(shareId) || new Set();
      owners.add(`${uid}/${listId}`);
      shareOwners.set(shareId, owners);
    }
    for (const [memberId, member] of Object.entries(list?.members || {})) {
      const gameId = String(member?.gameId || "").trim(); if (!/^[A-Za-z0-9_-]{3,64}$/.test(gameId)) continue;
      const key = gameId.toUpperCase(); const entries = locations.get(key) || { gameId, targets: [] }; entries.targets.push({ uid, listId, memberId, shareId }); locations.set(key, entries);
    }
  }
  const ambiguousShareIds = new Set([...shareOwners.entries()]
    .filter(([, owners]) => owners.size > 1)
    .map(([shareId]) => shareId));
  locations.forEach(entry => entry.targets.forEach(target => {
    if (ambiguousShareIds.has(target.shareId)) target.shareId = "";
  }));
  const state = await firebaseRequest(env, token, "backgroundSyncState") || {};
  const now = Date.now();
  const due = [...locations.entries()].filter(([key]) => {
    const syncState = state?.[key] || {};
    const retryAt = Number(syncState.nextRetryAt || 0);
    return retryAt <= now
      && (syncState.schema !== BACKGROUND_SYNC_SCHEMA || now - Number(syncState.lastSyncedAt || 0) >= BACKGROUND_SYNC_INTERVAL_MS);
  }).sort(([a], [b]) => Number(state?.[a]?.lastSyncedAt || 0) - Number(state?.[b]?.lastSyncedAt || 0)).slice(0, BACKGROUND_SYNC_PER_TICK);
  let processed = 0; let failures = 0;
  for (const [key, entry] of due) {
    try {
      const stats = makeBackgroundStats(await fetchAwardSnapshot(env, entry.gameId));
      const sharedIds = new Set();
      await Promise.all(entry.targets.map(target => {
        if (target.shareId) sharedIds.add(target.shareId);
        return firebaseRequest(env, token, `users/${target.uid}/lists/${target.listId}/members/${target.memberId}/fetchedStats`, { method: "PATCH", body: stats });
      }));
      const sharedUpdates = {};
      entry.targets.forEach(target => {
        if (!target.shareId) return;
        appendFirebaseStatsUpdates(
          sharedUpdates,
          `sharedLists/${target.shareId}/members/${target.memberId}/fetchedStats`,
          stats,
        );
      });
      sharedIds.forEach(shareId => { sharedUpdates[`sharedLists/${shareId}/updatedAt`] = now; });
      if (Object.keys(sharedUpdates).length) await firebaseRequest(env, token, "", { method: "PATCH", body: sharedUpdates });
      await firebaseRequest(env, token, `backgroundSyncState/${key}`, { method: "PUT", body: { lastSyncedAt: now, lastAttemptAt: now, nextRetryAt: 0, failureCount: 0, lastError: "", gameId: entry.gameId, targetCount: entry.targets.length, schema: BACKGROUND_SYNC_SCHEMA } });
      processed += 1;
    } catch (error) {
      failures += 1;
      const previous = state?.[key] || {};
      const failureCount = Math.min(Number(previous.failureCount || 0) + 1, BACKGROUND_SYNC_FAILURE_BACKOFF_MS.length);
      const retryAfter = BACKGROUND_SYNC_FAILURE_BACKOFF_MS[failureCount - 1];
      const message = error instanceof Error ? error.message : String(error);
      await firebaseRequest(env, token, `backgroundSyncState/${key}`, {
        method: "PUT",
        body: {
          lastSyncedAt: Number(previous.lastSyncedAt || 0),
          lastAttemptAt: now,
          nextRetryAt: now + retryAfter,
          failureCount,
          lastError: message.slice(0, 240),
          gameId: entry.gameId,
          targetCount: entry.targets.length,
          schema: BACKGROUND_SYNC_SCHEMA,
        },
      }).catch(statusError => console.warn("Kentomo background sync failure state write failed", statusError));
      console.warn("Kentomo background sync failed", entry.gameId, message);
    }
  }
  return { processed, failures, due: due.length, registeredPlayers: locations.size };
}

async function runAwardAutomation(env) {
  if (!env.FIREBASE_SERVICE_ACCOUNT_JSON) return { processed: 0, skipped: "secret-missing" };
  const token = await getFirebaseAccessToken(env);
  const schedules = await firebaseRequest(env, token, "awardSchedules");
  const now = new Date(); const parts = jstDateParts(now); const period = awardPeriodKey(parts);
  const isOpeningWindow = parts.day <= 2;
  const isClosingWindow = parts.day === lastJstDay(parts);
  let processed = 0;
  for (const [uid, userSchedules] of Object.entries(schedules || {})) {
    for (const [listId, schedule] of Object.entries(userSchedules || {})) {
      if (processed >= AWARD_MAX_LISTS_PER_TICK) return { processed };
      if (schedule?.resetRequestedAt) {
        await firebaseRequest(env, token, `awardRuns/${uid}/${listId}/${period}`, { method: "DELETE" });
        await firebaseRequest(env, token, `awardSchedules/${uid}/${listId}`, { method: "PATCH", body: { enabled: false, updatedAt: Date.now(), resetRequestedAt: null } });
        processed += 1;
        continue;
      }
      if (schedule?.enabled !== true) continue;
      const runPath = `awardRuns/${uid}/${listId}/${period}`;
      const run = await firebaseRequest(env, token, runPath) || {};
      const needsStart = isOpeningWindow && (!run.start || run.status === "collecting" || run.status === "collecting-start");
      const needsEnd = isClosingWindow && run.start && (!run.end || run.status === "collecting-end");
      if (!needsStart && !needsEnd) continue;
      const list = await firebaseRequest(env, token, `users/${uid}/lists/${listId}`);
      if (!list?.awardEnabled) continue;
      if (needsStart) {
        const chunk = await captureAwardSnapshotChunk(env, list, run.start);
        await firebaseRequest(env, token, runPath, { method: "PATCH", body: { period, startedAt: run.startedAt || now.toISOString(), start: chunk.snapshot, status: chunk.complete ? "started" : "collecting-start" } });
      } else {
        const chunk = await captureAwardSnapshotChunk(env, list, run.end);
        if (!chunk.complete) {
          await firebaseRequest(env, token, runPath, { method: "PATCH", body: { end: chunk.snapshot, status: "collecting-end" } });
          processed += 1;
          continue;
        }
        const results = makeAwardResults(run.start, chunk.snapshot);
        await firebaseRequest(env, token, runPath, { method: "PATCH", body: { endedAt: now.toISOString(), end: chunk.snapshot, results, status: "complete" } });
        const shareId = String(list.shareId || "");
        if (/^[A-Za-z0-9_-]{16,64}$/.test(shareId)) {
          await firebaseRequest(env, token, `sharedLists/${shareId}/awardResult`, { method: "PUT", body: { period, completedAt: now.toISOString(), results } });
        }
      }
      processed += 1;
    }
  }
  return { processed };
}

async function awardDiagnostics(env, token) {
  const schedules = await firebaseRequest(env, token, "awardSchedules") || {};
  const runs = await firebaseRequest(env, token, "awardRuns") || {};
  const period = awardPeriodKey(jstDateParts());
  const result = { period, totalSchedules: 0, enabledSchedules: 0, startCaptured: 0, complete: 0, snapshotMembers: 0, snapshotErrors: 0 };
  for (const [uid, lists] of Object.entries(schedules)) for (const [listId, schedule] of Object.entries(lists || {})) {
    result.totalSchedules += 1;
    if (schedule?.enabled !== true) continue;
    result.enabledSchedules += 1;
    const run = runs?.[uid]?.[listId]?.[period];
    if (!run) continue;
    if (run.start) {
      result.startCaptured += 1;
      for (const player of Object.values(run.start || {})) {
        result.snapshotMembers += 1;
        if (player?.error) result.snapshotErrors += 1;
      }
    }
    if (run.status === "complete") result.complete += 1;
  }
  return result;
}

async function hashAccessVisitor(shareId, visitor) {
  const bytes = new TextEncoder().encode(`${shareId}:${visitor}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function recordSharedListAccess(env, shareId, visitor) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(shareId) || !/^[A-Za-z0-9_-]{16,160}$/.test(visitor)) throw new Error("Invalid access parameters");
  const token = await getFirebaseAccessToken(env);
  const shared = await firebaseRequest(env, token, `sharedLists/${shareId}`);
  if (!shared?.ownerUid) throw new Error("Shared list was not found");
  const day = jstDayKey();
  const visitorHash = await hashAccessVisitor(shareId, visitor);
  await firebaseRequest(env, token, `sharedListAccess/${shareId}/days/${day}/${visitorHash}`, { method: "PUT", body: { seenAt: Date.now() } });
  return { day };
}

async function sharedListAccessSummary(env, shareId) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(shareId)) throw new Error("Invalid shareId");
  const token = await getFirebaseAccessToken(env);
  const access = await firebaseRequest(env, token, `sharedListAccess/${shareId}/days`) || {};
  const dates = Object.keys(access).sort();
  const today = jstDayKey();
  const weekStart = new Date(); weekStart.setUTCDate(weekStart.getUTCDate() - 6);
  const weekKeys = new Set(Array.from({ length: 7 }, (_, index) => jstDayKey(jstDateParts(new Date(Date.now() - index * 86400000)))));
  const cumulative = new Set(); let views = 0; let todayViews = 0; let weekViews = 0;
  for (const [day, visitors] of Object.entries(access)) {
    const ids = Object.keys(visitors || {}); views += ids.length; ids.forEach((id) => cumulative.add(id));
    if (day === today) todayViews += ids.length;
    if (weekKeys.has(day)) weekViews += ids.length;
  }
  return { views, uniqueVisitors: cumulative.size, today: todayViews, last7Days: weekViews, daysTracked: dates.length };
}

async function runScheduledAutomation(env) {
  const startedAt = new Date().toISOString();
  try {
    // A schema migration affects visible player cards immediately, so it takes
    // priority over the monthly award backfill.  Keep one external profile
    // collection per invocation to stay below the Workers Free CPU limit.
    const background = await runBackgroundSync(env);
    const awards = background.processed > 0
      ? { processed: 0, skipped: "background-migration-priority" }
      : await runAwardAutomation(env);
    const token = await getFirebaseAccessToken(env);
    const awardData = await awardDiagnostics(env, token);
    const backgroundOk = Number(background.failures || 0) === 0;
    await firebaseRequest(env, token, "automationStatus", { method: "PUT", body: { ok: backgroundOk, workerBuild: WORKER_BUILD, lastRunAt: startedAt, completedAt: new Date().toISOString(), error: backgroundOk ? "" : `${background.failures} background sync item(s) failed; retry state recorded`, awards, awardData, background } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Kentomo scheduled work failed", message);
    try {
      const token = await getFirebaseAccessToken(env);
      await firebaseRequest(env, token, "automationStatus", { method: "PATCH", body: { ok: false, workerBuild: WORKER_BUILD, lastAttemptAt: startedAt, failedAt: new Date().toISOString(), error: message } });
    } catch (statusError) {
      console.error("Kentomo status write failed", statusError instanceof Error ? statusError.message : String(statusError));
    }
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== "GET") {
      return json({ error: "GET only" }, 405);
    }

    const requestUrl = new URL(request.url);
    if (requestUrl.searchParams.get("mode") === "automation-status") {
      try {
        const token = await getFirebaseAccessToken(env);
        const automation = await firebaseRequest(env, token, "automationStatus") || {};
        const awardData = await awardDiagnostics(env, token);
        return json({ ok: true, workerBuild: WORKER_BUILD, automation: { ...automation, awardData } }, 200, "no-store");
      }
      catch { return json({ ok: false, error: "Automation status is unavailable" }, 503, "no-store"); }
    }
    if (requestUrl.searchParams.get("mode") === "track-shared-access") {
      try { return json({ ok: true, ...(await recordSharedListAccess(env, requestUrl.searchParams.get("shareId") || "", requestUrl.searchParams.get("visitor") || "")) }, 200, "no-store"); }
      catch (error) { return json({ ok: false, error: error instanceof Error ? error.message : "Access tracking unavailable" }, 400, "no-store"); }
    }
    if (requestUrl.searchParams.get("mode") === "shared-access-summary") {
      try { return json({ ok: true, ...(await sharedListAccessSummary(env, requestUrl.searchParams.get("shareId") || "")) }, 200, "no-store"); }
      catch (error) { return json({ ok: false, error: error instanceof Error ? error.message : "Access summary unavailable" }, 400, "no-store"); }
    }
    if (requestUrl.searchParams.get("mode") === "wavu-ratings") {
      const gameId = requestUrl.searchParams.get("gameId")?.trim();
      if (!gameId || !/^[A-Za-z0-9_-]{3,64}$/.test(gameId)) {
        return json({ error: "Valid gameId is required" }, 400);
      }
      let forceRefresh = requestUrl.searchParams.get("force") === "1";
      const pageOpenRequested = forceRefresh && requestUrl.searchParams.get("pageOpen") === "1";
      const cache = caches.default;
      const canonicalUrl = new URL(requestUrl.origin + requestUrl.pathname);
      canonicalUrl.searchParams.set("mode", "wavu-ratings");
      canonicalUrl.searchParams.set("gameId", gameId);
      canonicalUrl.searchParams.set("schema", "wavu-ratings-v4-recent-ranked");
      const cacheKey = new Request(canonicalUrl.toString(), { method: "GET" });
      let forceGuardThrottleKey = null;
      // Page-open and administrator requests share one per-player guard. The
      // cache lock is written only after a successful upstream refresh.
      if (forceRefresh && (requestUrl.searchParams.get("pageOpen") === "1" || requestUrl.searchParams.get("manualRefresh") === "1")) {
        const throttleUrl = new URL(requestUrl.origin + requestUrl.pathname);
        throttleUrl.searchParams.set("mode", "force-refresh-throttle");
        throttleUrl.searchParams.set("source", "wavu-v2");
        throttleUrl.searchParams.set("gameId", gameId);
        const throttleKey = new Request(throttleUrl.toString(), { method: "GET" });
        if (await hasFreshThrottleMarker(cache, throttleKey, FORCE_REFRESH_GUARD_TTL_SECONDS)) {
          forceRefresh = false;
        } else {
          forceGuardThrottleKey = throttleKey;
        }
      }
      if (!forceRefresh) {
        const cached = await getFreshCachedJson(cache, cacheKey, WAVU_RATINGS_CACHE_TTL_SECONDS);
        if (cached) return withCacheStatus(cached, "HIT");
      }
      try {
        const ratings = await fetchWavuRatings(gameId);
        const response = json({
          ok: true,
          gameId,
          ...ratings,
          workerCachedAt: new Date().toISOString(),
          workerCacheTtlSeconds: WAVU_RATINGS_CACHE_TTL_SECONDS,
        }, 200, `public, max-age=0, s-maxage=${WAVU_RATINGS_CACHE_TTL_SECONDS}`);
        const cacheWrite = cache.put(cacheKey, response.clone());
        if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(cacheWrite);
        else await cacheWrite;
        if (forceGuardThrottleKey) {
          const throttleWrite = cache.put(forceGuardThrottleKey, new Response(JSON.stringify({ createdAt: Date.now() }), {
            headers: {
              "Cache-Control": "public, max-age=0, s-maxage=1800",
              "X-Kentomo-Throttle-At": String(Date.now()),
            },
          }));
          if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(throttleWrite);
          else await throttleWrite;
        }
        if (pageOpenRequested) {
          scheduleFirebasePlayerPatch(
            env,
            ctx,
            gameId,
            wavuFirebasePatch(ratings, Date.now(), "worker-page-open-wavu-sync"),
          );
        }
        return withCacheStatus(response, forceRefresh ? "REFRESH" : "MISS");
      } catch (error) {
        return json({
          error: "Wavu ratings fetch failed",
          message: error instanceof Error ? error.message : String(error),
        }, 502);
      }
    }
    const imageUrl = requestUrl.searchParams.get("imageUrl")?.trim();
    if (imageUrl) {
      let imageTarget;
      try {
        imageTarget = new URL(imageUrl);
      } catch {
        return json({ error: "Invalid imageUrl" }, 400);
      }
      // This endpoint is deliberately limited to EWGF static assets.  It is
      // only a CORS bridge for card export, not an open proxy.
      if (imageTarget.protocol !== "https:" || imageTarget.hostname !== "ewgf.gg" || !imageTarget.pathname.startsWith("/static/")) {
        return json({ error: "Only https://ewgf.gg/static/ images are allowed" }, 400);
      }
      try {
        const imageCache = caches.default;
        const canonicalImageUrl = new URL(requestUrl.origin + requestUrl.pathname);
        canonicalImageUrl.searchParams.set("imageUrl", imageTarget.toString());
        canonicalImageUrl.searchParams.set("schema", "ewgf-static-image-v2");
        const imageCacheKey = new Request(canonicalImageUrl.toString(), { method: "GET" });
        const cachedImage = await imageCache.match(imageCacheKey);
        if (cachedImage) return withCacheStatus(cachedImage, "HIT");
        const imageResponse = await fetch(imageTarget.toString(), {
          headers: { Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8" },
        });
        if (!imageResponse.ok) return json({ error: "EWGF image request failed", ewgfStatus: imageResponse.status }, 502);
        const headers = new Headers(CORS_HEADERS);
        headers.set("Content-Type", imageResponse.headers.get("Content-Type") || "image/png");
        headers.set("Cache-Control", "public, max-age=604800, s-maxage=2592000, immutable");
        const response = new Response(imageResponse.body, { status: 200, headers });
        const cacheWrite = imageCache.put(imageCacheKey, response.clone());
        if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(cacheWrite);
        else await cacheWrite;
        return withCacheStatus(response, "MISS");
      } catch (error) {
        return json({ error: "EWGF image fetch failed", message: error instanceof Error ? error.message : String(error) }, 502);
      }
    }
    const ewgfId = requestUrl.searchParams.get("ewgfId")?.trim();
    if (!ewgfId) {
      return json(
        { error: "ewgfId is required", example: "?ewgfId=5RQTNdfqR4GT" },
        400,
      );
    }
    if (!/^[A-Za-z0-9_-]{3,64}$/.test(ewgfId)) {
      return json({ error: "Invalid ewgfId" }, 400);
    }

    let forceRefresh = requestUrl.searchParams.get("force") === "1";
    const pageOpenRequested = forceRefresh && requestUrl.searchParams.get("pageOpen") === "1";
    const cache = caches.default;
    if (requestUrl.searchParams.get("mode") === "matchups") {
      // Matchup data contains every played character's opponent table and is
      // substantially larger than a card profile. Keep it off the normal
      // profile route and collect it only when the details dialog is opened.
      const matchupCanonicalUrl = new URL(requestUrl.origin + requestUrl.pathname);
      matchupCanonicalUrl.searchParams.set("mode", "matchups");
      matchupCanonicalUrl.searchParams.set("ewgfId", ewgfId);
      matchupCanonicalUrl.searchParams.set("schema", "matchups-20260802-retry-parse-guard-v2");
      const matchupCacheKey = new Request(matchupCanonicalUrl.toString(), { method: "GET" });
      const cachedMatchups = await getFreshCachedJson(cache, matchupCacheKey, WORKER_CACHE_TTL_SECONDS);
      if (cachedMatchups) return withCacheStatus(cachedMatchups, "HIT");
      const profileUrl = `https://ewgf.gg/player/${encodeURIComponent(ewgfId)}`;
      try {
        const response = await fetch(profileUrl, {
          method: "GET",
          redirect: "follow",
          headers: {
            Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
            "User-Agent": "Mozilla/5.0 compatible EWGF matchup checker",
          },
        });
        const html = await response.text();
        if (!response.ok) {
          return json({ error: "EWGF matchup request failed", ewgfStatus: response.status }, 502);
        }
        const matchupExtraction = extractRankedCharacterMatchupsResult(html);
        // An empty, correctly parsed table is valid for a player who has not
        // built current-season ranked matchup history. A parser failure is
        // different: returning an empty success would mislead the UI.
        if (!matchupExtraction.parsed) {
          return json({ error: "EWGF matchup data format could not be parsed" }, 502);
        }
        const matchupResponse = json({
          ok: true,
          ewgfId,
          scope: "current-season-ranked-all-played-characters",
          characterMatchups: matchupExtraction.matchups,
          workerCachedAt: new Date().toISOString(),
          workerCacheTtlSeconds: WORKER_CACHE_TTL_SECONDS,
        }, 200, `public, max-age=0, s-maxage=${WORKER_CACHE_TTL_SECONDS}`);
        const cacheWrite = cache.put(matchupCacheKey, matchupResponse.clone());
        if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(cacheWrite);
        else await cacheWrite;
        return withCacheStatus(matchupResponse, "MISS");
      } catch (error) {
        return json({ error: "Matchup fetch failed", message: error instanceof Error ? error.message : String(error) }, 502);
      }
    }
    if (requestUrl.searchParams.get("mode") === "latest") {
      const latestCanonicalUrl = new URL(requestUrl.origin + requestUrl.pathname);
      latestCanonicalUrl.searchParams.set("ewgfId", ewgfId);
      latestCanonicalUrl.searchParams.set("mode", "latest");
      latestCanonicalUrl.searchParams.set("schema", "latest-20260728-html-primary-v2");
      const latestCacheKey = new Request(latestCanonicalUrl.toString(), { method: "GET" });
      if (!forceRefresh) {
        const latestCachedResponse = await getFreshCachedJson(cache, latestCacheKey, LATEST_BATTLE_CACHE_TTL_SECONDS);
        if (latestCachedResponse) return withCacheStatus(latestCachedResponse, "HIT");
      }
      try {
        const [profileHtmlResult, wavuResult] = await Promise.allSettled([
          fetchProfileHtmlLatestBattle(ewgfId),
          fetchWavuLatestRankedBattle(ewgfId),
        ]);
        const profileHtmlLatest = profileHtmlResult.status === "fulfilled" ? profileHtmlResult.value : null;
        const wavuLatest = wavuResult.status === "fulfilled" ? wavuResult.value : null;
        // The complete profile HTML includes all battle types. Only spend an
        // official API request when that HTML route itself is unavailable.
        let officialLatest = null;
        if (!profileHtmlLatest) {
          try {
            officialLatest = await fetchOfficialLatestBattle(env, ewgfId);
          } catch (error) {
            console.warn("EWGF official fallback failed", error);
          }
        }
        const candidates = [
          { battle: officialLatest, source: "ewgf-official-battles-api", scope: "all-battle-types" },
          { battle: profileHtmlLatest, source: "ewgf-profile-recent-battles", scope: "all-battle-types" },
          { battle: wavuLatest, source: "wavu-latest-ranked-fallback", scope: "ranked-only-fallback" },
        ].filter((candidate) => candidate.battle && Number.isFinite(Date.parse(candidate.battle.at)));
        const selectedLatest = selectLatestBattle(candidates);
        if (!selectedLatest) throw new Error("No valid latest battle was returned by EWGF or Wavu");
        const latestBattle = selectedLatest.battle;
        const latestSource = selectedLatest.source;
        const latestResponse = json({
          ok: true,
          ewgfId,
          latestBattleAt: latestBattle?.at || null,
          latestBattle,
          latestSource,
          latestScope: selectedLatest.scope,
          playerName: profileHtmlLatest?.playerName || officialLatest?.playerName || wavuLatest?.playerName || "",
          playerNameSource: profileHtmlLatest?.playerName
            ? "ewgf-profile"
            : (officialLatest?.playerName ? "ewgf-official-battles-api" : (wavuLatest?.playerName ? "wavu-profile" : "")),
          latestCandidates: candidates
            .sort((a, b) => Date.parse(b.battle.at) - Date.parse(a.battle.at))
            .map((candidate) => ({
              source: candidate.source,
              scope: candidate.scope,
              at: candidate.battle.at,
              battleType: candidate.battle.battleType || "",
              character: candidate.battle.character || "",
            })),
          workerCachedAt: new Date().toISOString(),
          workerCacheTtlSeconds: LATEST_BATTLE_CACHE_TTL_SECONDS,
        }, 200, `public, max-age=0, s-maxage=${LATEST_BATTLE_CACHE_TTL_SECONDS}`);
        const latestCacheWrite = cache.put(latestCacheKey, latestResponse.clone());
        if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(latestCacheWrite);
        else await latestCacheWrite;
        return withCacheStatus(latestResponse, forceRefresh ? "REFRESH" : "MISS");
      } catch (error) {
        return json({
          error: "Latest battle fetch failed",
          message: error instanceof Error ? error.message : String(error),
        }, 502);
      }
    }
    const canonicalUrl = new URL(requestUrl.origin + requestUrl.pathname);
    canonicalUrl.searchParams.set("ewgfId", ewgfId);
    // Invalidate pre-detail cache entries after a Worker deployment.
    // This response deliberately excludes all-character matchup tables.
    // Bump the key so an older 12-hour profile body cannot keep serving them.
    canonicalUrl.searchParams.set("schema", "profile-20260802-lazy-matchups-v1");
    const cacheKey = new Request(canonicalUrl.toString(), { method: "GET" });

    let forceGuardThrottleKey = null;
    // See the matching Wavu guard above. Page-open and manual requests share
    // one per-player guard, and failed upstream calls never create that lock.
    if (forceRefresh && (requestUrl.searchParams.get("pageOpen") === "1" || requestUrl.searchParams.get("manualRefresh") === "1")) {
      const throttleUrl = new URL(requestUrl.origin + requestUrl.pathname);
      throttleUrl.searchParams.set("mode", "force-refresh-throttle");
      throttleUrl.searchParams.set("source", "profile-v2");
      throttleUrl.searchParams.set("ewgfId", ewgfId);
      const throttleKey = new Request(throttleUrl.toString(), { method: "GET" });
      if (await hasFreshThrottleMarker(cache, throttleKey, FORCE_REFRESH_GUARD_TTL_SECONDS)) {
        forceRefresh = false;
      } else {
        forceGuardThrottleKey = throttleKey;
      }
    }

    if (!forceRefresh) {
      const cachedResponse = await getFreshCachedJson(cache, cacheKey, WORKER_CACHE_TTL_SECONDS);
      if (cachedResponse) return withCacheStatus(cachedResponse, "HIT");
    }
    const profileUrl = `https://ewgf.gg/player/${encodeURIComponent(ewgfId)}`;

    try {
      const response = await fetch(profileUrl, {
        method: "GET",
        redirect: "follow",
        headers: {
          Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
          "User-Agent": "Mozilla/5.0 compatible EWGF profile checker",
        },
      });
      const html = await response.text();

      if (!response.ok) {
        return json(
          {
            error: "EWGF request failed",
            ewgfStatus: response.status,
            ewgfStatusText: response.statusText,
            profileUrl,
            responsePreview: html.slice(0, 1000),
          },
          502,
        );
      }

      const characters = extractCharacters(html);
      const tekkenProwess = extractTekkenProwess(html);
      const highestRankProfile = extractHighestRankProfile(html);
      const statPentagon = extractStatPentagon(html);
      const modeStats = extractCharacterModeStatsBatch(html, ["RANKED_BATTLE", "PLAYER_BATTLE", "QUICK_BATTLE", "GROUP_BATTLE"]);
      const rankedCharacterStats = modeStats.RANKED_BATTLE;
      const totalRankedGames = sumCharacterGames(rankedCharacterStats);
      const totalPlayerMatchGames = sumCharacterGames(modeStats.PLAYER_BATTLE);
      const totalQuickMatchGames = sumCharacterGames(modeStats.QUICK_BATTLE);
      const totalGroupMatchGames = sumCharacterGames(modeStats.GROUP_BATTLE);
      const totalRecordedGames = totalRankedGames + totalPlayerMatchGames + totalQuickMatchGames + totalGroupMatchGames;
      const playerMessage = extractPlayerMessage(html);
      const platformProfile = extractPlatformProfile(html);
      const htmlLatestBattle = extractLatestBattle(html, ewgfId);
      let officialLatestBattle = null;
      if (!htmlLatestBattle) {
        try {
          officialLatestBattle = await fetchOfficialLatestBattle(env, ewgfId);
        } catch (error) {
          console.warn("EWGF official latest battle fallback failed", error);
        }
      }
      const selectedLatest = selectLatestBattle([
        { battle: htmlLatestBattle, source: "ewgf-profile-recent-battles", scope: "all-battle-types" },
        { battle: officialLatestBattle, source: "ewgf-official-battles-api", scope: "all-battle-types" },
      ]);
      const latestBattle = selectedLatest?.battle || null;

      if (characters.length === 0) {
        return json(
          {
            error: "Characters table was not detected",
            ewgfId,
            profileUrl,
            htmlLength: html.length,
            tekkenProwess,
            highestRank: highestRankProfile.rank,
            highestRankIcon: highestRankProfile.rankIcon,
            statPentagonDetected: statPentagon !== null,
          },
          422,
        );
      }

      const firstCharacter = characters[0];
      const workerCachedAt = new Date().toISOString();
      const profileSnapshot = {
          ok: true,
          ewgfId,
        profileUrl,
        tekkenProwess,
        highestRank: highestRankProfile.rank,
        highestRankIcon: highestRankProfile.rankIcon,
        mainCharacter: firstCharacter.character,
        mainCharacterCode: firstCharacter.characterCode,
        characterImage: firstCharacter.characterImage,
        currentRank: firstCharacter.currentRank,
        rankIcon: firstCharacter.rankIcon,
        wins: firstCharacter.wins,
        losses: firstCharacter.losses,
        games: firstCharacter.games,
        characters,
        characterCount: characters.length,
        statPentagon,
        rankedCharacterStats,
        totalRankedGames,
        totalPlayerMatchGames,
        totalQuickMatchGames,
        totalGroupMatchGames,
        totalRecordedGames,
        playerMessage,
        platformProfile,
        latestBattleAt: latestBattle?.at || null,
        latestBattle,
        latestSource: selectedLatest?.source || null,
        latestScope: selectedLatest?.scope || null,
          source: "ewgf-profile-html",
          workerCachedAt,
          workerCacheTtlSeconds: WORKER_CACHE_TTL_SECONDS,
      };
      const successResponse = json(profileSnapshot, 200, `public, max-age=0, s-maxage=${WORKER_CACHE_TTL_SECONDS}`);
      const cacheWrite = cache.put(cacheKey, successResponse.clone());
      if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(cacheWrite);
      else await cacheWrite;
      if (forceGuardThrottleKey) {
        const throttleWrite = cache.put(forceGuardThrottleKey, new Response(JSON.stringify({ createdAt: Date.now() }), {
          headers: {
            "Cache-Control": "public, max-age=0, s-maxage=1800",
            "X-Kentomo-Throttle-At": String(Date.now()),
          },
        }));
        if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(throttleWrite);
          else await throttleWrite;
      }
      if (pageOpenRequested) {
        scheduleFirebasePlayerPatch(
          env,
          ctx,
          ewgfId,
          profileFirebasePatch(profileSnapshot, ewgfId, Date.now(), "worker-page-open-profile-sync"),
        );
      }
      return withCacheStatus(successResponse, forceRefresh ? "REFRESH" : "MISS");
    } catch (error) {
      return json(
        {
          error: "Worker fetch failed",
          message: error instanceof Error ? error.message : String(error),
          profileUrl,
        },
        502,
      );
    }
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runScheduledAutomation(env));
  },
};
