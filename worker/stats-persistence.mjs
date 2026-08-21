import {
  applyMonotonicSourceSnapshot,
  normalizeSourceRevision,
} from "./stats-freshness.mjs";

export const STATS_SCHEMA = "20260821-source-snapshots-v1";
export const SOURCE_DOMAINS = ["ewgfProfile", "wavuRatings", "latestActivity"];

const PROFILE_FIELDS = [
  "gameId",
  "mainChar",
  "mainCharGames",
  "wins",
  "losses",
  "rankedWinRate",
  "rankedDataVerified",
  "danRank",
  "rankIcon",
  "tekkenPower",
  "totalRankedGames",
  "totalPlayerMatchGames",
  "totalQuickMatchGames",
  "totalGroupMatchGames",
  "totalRankedAndPlayerGames",
  "totalRecordedGames",
  "characterSelectionTop",
  "statPentagon",
  "playerMessage",
  "platform",
  "platformId",
  "platformProfileUrl",
  "isError",
];

const ACTIVITY_FIELDS = [
  "lastSeenTimestamp",
  "latestBattleAt",
  "latestBattleCharacter",
  "latestBattleType",
  "latestBattleSource",
  "latestBattleScope",
  "latestBattleCheckedAt",
  "latestBattleRevisionAt",
];

const WAVU_FIELDS = [
  "mainChar",
  "mainCharGames",
  "ratingCharacter",
  "mainSelectionSource",
  "ratingMu",
  "charGamesMap",
  "charRatingMap",
  "qualifiedCharRatingMap",
  "recentRankedGames7d",
  "recentRankedGames30d",
  "recentRankedSampleSize",
  "latestRankedBattleAt",
];

const EWGF_FIELDS = PROFILE_FIELDS.filter((field) => !WAVU_FIELDS.includes(field));

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (value instanceof Date) return new Date(value.getTime());
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneValue(child)]));
  }
  return value;
}

function hasValue(value) {
  return value !== null && value !== undefined;
}

function hasMeaningfulValue(value) {
  return hasValue(value) && (typeof value !== "string" || value.trim() !== "");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeDefined(target, source) {
  const result = isRecord(target) ? cloneValue(target) : {};
  if (!isRecord(source)) return result;
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) result[key] = cloneValue(value);
  }
  return result;
}

function pickFields(source, fields) {
  const result = {};
  for (const field of fields) {
    if (source && source[field] !== undefined) result[field] = cloneValue(source[field]);
  }
  return result;
}

function rankedEntries(profile) {
  return Object.entries(profile?.rankedCharacterStats || {})
    .sort(([leftCharacter, left], [rightCharacter, right]) =>
      Number(right?.games || 0) - Number(left?.games || 0)
      || String(leftCharacter).localeCompare(String(rightCharacter))
    );
}

function normalizeObservedAt(value) {
  return hasValue(value) ? cloneValue(value) : null;
}

function latestBattleFrom(value) {
  if (value?.battle && typeof value.battle === "object") return value.battle;
  if (value?.latestBattle && typeof value.latestBattle === "object") return value.latestBattle;
  if (value && typeof value === "object") return value;
  return {};
}

function sourceSnapshot(revisionAt, observedAt, data) {
  return {
    revisionAt: normalizeSourceRevision(revisionAt),
    observedAt: normalizeObservedAt(observedAt),
    data: cloneValue(data || {}),
  };
}

export function buildEwgfProfileSourceSnapshot(profile, observedAt) {
  const entries = rankedEntries(profile);
  const characters = Array.isArray(profile?.characters)
    ? profile.characters
    : Object.entries(profile?.characterRanks || {}).map(([character, value]) => ({ character, ...value }));
  const firstCharacter = characters[0] || {};
  const [rankedMainChar, rankedMain] = entries[0] || ["", {}];
  const mainChar = String(profile?.mainCharacter || profile?.mainChar || rankedMainChar || firstCharacter.character || "");
  const mainCharacter = characters
    .find((character) => String(character?.character || "").toLowerCase() === mainChar.toLowerCase()) || firstCharacter;
  const rankedGames = Number(rankedMain?.games || profile?.mainCharGames || 0);
  const rankedWins = Number(rankedMain?.wins ?? profile?.wins ?? 0);
  const totalRankedGames = Number(profile?.totalRankedGames || 0);
  const totalPlayerMatchGames = Number(profile?.totalPlayerMatchGames || 0);
  const totalQuickMatchGames = Number(profile?.totalQuickMatchGames || 0);
  const totalGroupMatchGames = Number(profile?.totalGroupMatchGames || 0);
  const data = {
    gameId: String(profile?.ewgfId || profile?.gameId || ""),
    mainChar,
    mainCharGames: Number(profile?.games ?? profile?.mainCharGames ?? rankedMain?.games ?? 0),
    wins: rankedWins,
    losses: Number(profile?.losses ?? rankedMain?.losses ?? 0),
    rankedWinRate: Number(rankedMain?.winRate ?? profile?.rankedWinRate ?? (rankedGames ? rankedWins / rankedGames : 0)),
    rankedDataVerified: true,
    danRank: String(profile?.currentRank || mainCharacter?.currentRank || mainCharacter?.rank || profile?.highestRank || profile?.danRank || "-"),
    rankIcon: String(profile?.rankIcon || mainCharacter?.rankIcon || ""),
    tekkenPower: Number(profile?.tekkenProwess ?? profile?.tekkenPower ?? 0),
    totalRankedGames,
    totalPlayerMatchGames,
    totalQuickMatchGames,
    totalGroupMatchGames,
    totalRecordedGames: Number(profile?.totalRecordedGames || (totalRankedGames + totalPlayerMatchGames + totalQuickMatchGames + totalGroupMatchGames)),
    isError: Boolean(profile?.isError),
  };

  if (data.totalRankedGames || data.totalPlayerMatchGames) {
    data.totalRankedAndPlayerGames = data.totalRankedGames + data.totalPlayerMatchGames;
  }
  const characterSelectionTop = entries.slice(0, 2).map(([character, value], index) => {
    const row = characters
      .find((item) => String(item?.character || "").toLowerCase() === String(character).toLowerCase());
    return {
      position: index + 1,
      character,
      characterImage: row?.characterImage || "",
      selectionSource: "ewgf-ranked-games",
      lifetimeGames: Number(value?.games || 0),
      wins: Number(value?.wins || 0),
      losses: Number(value?.losses || 0),
    };
  });
  if (characterSelectionTop.length) data.characterSelectionTop = characterSelectionTop;
  else if (Array.isArray(profile?.characterSelectionTop)) data.characterSelectionTop = cloneValue(profile.characterSelectionTop);
  if (profile?.statPentagon && typeof profile.statPentagon === "object") data.statPentagon = cloneValue(profile.statPentagon);
  if (String(profile?.playerMessage || "").trim()) data.playerMessage = String(profile.playerMessage).slice(0, 500);
  if (profile?.platformProfile && typeof profile.platformProfile === "object") {
    if (profile.platformProfile.platform) data.platform = String(profile.platformProfile.platform);
    if (profile.platformProfile.platformId) data.platformId = String(profile.platformProfile.platformId);
    if (profile.platformProfile.platformProfileUrl) data.platformProfileUrl = String(profile.platformProfile.platformProfileUrl);
  }

  return sourceSnapshot(profile?.latestBattleAt || profile?.latestBattle?.at, observedAt, data);
}

export function buildWavuSourceSnapshot(ratings, observedAt) {
  const data = {};
  if (ratings?.mainChar) {
    data.mainChar = String(ratings.mainChar);
    if (ratings.mainCharGames !== null && ratings.mainCharGames !== undefined) data.mainCharGames = Number(ratings.mainCharGames);
    data.ratingCharacter = String(ratings.mainChar);
    if (ratings.selectionSource) data.mainSelectionSource = String(ratings.selectionSource);
  }
  if (ratings?.ratingMu !== null && ratings?.ratingMu !== undefined) data.ratingMu = Number(ratings.ratingMu);
  for (const field of ["charGamesMap", "charRatingMap", "qualifiedCharRatingMap"]) {
    if (ratings?.[field] && Object.keys(ratings[field]).length) data[field] = cloneValue(ratings[field]);
  }
  for (const field of ["recentRankedGames7d", "recentRankedGames30d", "recentRankedSampleSize"]) {
    if (ratings?.[field] !== undefined) data[field] = Number(ratings[field] || 0);
  }
  if (ratings?.latestRankedBattleAt) data.latestRankedBattleAt = String(ratings.latestRankedBattleAt);
  return sourceSnapshot(ratings?.latestRankedBattleAt, observedAt, data);
}

export function buildLatestActivitySourceSnapshot(selectedLatest, observedAt) {
  const battle = latestBattleFrom(selectedLatest);
  const at = battle?.at || selectedLatest?.latestBattleAt || null;
  const revisionAt = normalizeSourceRevision(at);
  const data = {};
  if (hasValue(at)) data.latestBattleAt = String(at);
  if (revisionAt !== null) {
    data.lastSeenTimestamp = revisionAt;
    data.latestBattleRevisionAt = revisionAt;
  }
  if (battle?.character !== undefined && battle.character !== null) data.latestBattleCharacter = String(battle.character);
  if (battle?.battleType !== undefined && battle.battleType !== null) data.latestBattleType = String(battle.battleType);
  if (selectedLatest?.source) data.latestBattleSource = String(selectedLatest.source);
  if (selectedLatest?.scope) data.latestBattleScope = String(selectedLatest.scope);
  return sourceSnapshot(at, observedAt, data);
}

export function buildBackgroundSourceSnapshots(snapshot, observedAt) {
  return {
    ewgfProfile: buildEwgfProfileSourceSnapshot(snapshot, observedAt),
    wavuRatings: buildWavuSourceSnapshot(snapshot?.wavuRatings || snapshot, observedAt),
    latestActivity: buildLatestActivitySourceSnapshot({
      battle: snapshot?.latestBattleAt
        ? {
            at: snapshot.latestBattleAt,
            character: snapshot.latestBattleCharacter,
            battleType: snapshot.latestBattleType,
          }
        : null,
      source: snapshot?.latestBattleSource,
      scope: snapshot?.latestBattleScope,
    }, observedAt),
  };
}

function legacyViews(current) {
  const split = isRecord(current?.["20260729-split-fetched-stats"])
    ? current["20260729-split-fetched-stats"]
    : {};
  const profileStats = mergeDefined(
    mergeDefined(pickFields(current, PROFILE_FIELDS), split.profileStats),
    current?.profileStats,
  );
  const activityStats = mergeDefined(
    mergeDefined(pickFields(current, ACTIVITY_FIELDS), split.activityStats),
    current?.activityStats,
  );
  return { profileStats: cloneValue(profileStats || {}), activityStats: cloneValue(activityStats || {}) };
}

function orderedSourceSnapshots(sourceSnapshots) {
  const result = {};
  for (const domain of SOURCE_DOMAINS) {
    if (sourceSnapshots?.[domain] !== undefined) result[domain] = cloneValue(sourceSnapshots[domain]);
  }
  for (const [domain, snapshot] of Object.entries(sourceSnapshots || {})) {
    if (result[domain] === undefined) result[domain] = cloneValue(snapshot);
  }
  return result;
}

function clearFields(target, fields) {
  for (const field of fields) delete target[field];
  return target;
}

export function materializeFetchedStats({ current = {}, sourceSnapshots = {}, fetchMeta, cachedAt, updatedAt } = {}) {
  const node = cloneValue(isRecord(current) ? current : {});
  const legacy = legacyViews(node);
  const effectiveSnapshots = orderedSourceSnapshots({
    ...(isRecord(node.sourceSnapshots) ? node.sourceSnapshots : {}),
    ...(isRecord(sourceSnapshots) ? sourceSnapshots : {}),
  });
  const ewgfSnapshot = effectiveSnapshots.ewgfProfile;
  const wavuSnapshot = effectiveSnapshots.wavuRatings;
  const activitySnapshot = effectiveSnapshots.latestActivity;
  const hasEwgfAuthority = isRecord(ewgfSnapshot);
  const hasWavuAuthority = isRecord(wavuSnapshot);
  const hasActivityAuthority = isRecord(activitySnapshot);
  const ewgfData = ewgfSnapshot?.data;
  const wavuData = wavuSnapshot?.data;
  const activityData = activitySnapshot?.data;
  const wavuHasQualifiedMain = hasMeaningfulValue(wavuData?.mainChar);
  const wavuFieldsToClear = hasWavuAuthority && !wavuHasQualifiedMain && !hasEwgfAuthority
    ? WAVU_FIELDS.filter((field) => field !== "mainChar" && field !== "mainCharGames")
    : WAVU_FIELDS;

  let profileStats = cloneValue(legacy.profileStats);
  if (hasEwgfAuthority) {
    clearFields(profileStats, EWGF_FIELDS);
    profileStats = mergeDefined(profileStats, ewgfData);
  }
  if (hasWavuAuthority) {
    clearFields(profileStats, wavuFieldsToClear);
    profileStats = mergeDefined(profileStats, wavuData);
    if (!wavuHasQualifiedMain && hasEwgfAuthority) {
      if (hasValue(ewgfData?.mainChar)) profileStats.mainChar = cloneValue(ewgfData.mainChar);
      if (hasValue(ewgfData?.mainCharGames)) profileStats.mainCharGames = cloneValue(ewgfData.mainCharGames);
    }
  }

  let activityStats = cloneValue(legacy.activityStats);
  if (hasActivityAuthority) {
    clearFields(activityStats, ACTIVITY_FIELDS);
    activityStats = mergeDefined(activityStats, activityData);
    const latestObservedAt = activitySnapshot.observedAt;
    if (hasValue(latestObservedAt)) activityStats.latestBattleCheckedAt = cloneValue(latestObservedAt);
  }

  const authoritativeRootFields = [];
  if (hasEwgfAuthority) authoritativeRootFields.push(...EWGF_FIELDS);
  if (hasWavuAuthority) authoritativeRootFields.push(...wavuFieldsToClear);
  if (hasActivityAuthority) authoritativeRootFields.push(...ACTIVITY_FIELDS);
  clearFields(node, [...new Set(authoritativeRootFields)]);

  node.schema = STATS_SCHEMA;
  node.sourceSnapshots = effectiveSnapshots;
  node.profileStats = profileStats;
  node.activityStats = activityStats;
  Object.assign(node, profileStats, activityStats);
  if (fetchMeta !== undefined) node.fetchMeta = cloneValue(fetchMeta);
  if (cachedAt !== undefined) node.cachedAt = cloneValue(cachedAt);
  if (updatedAt !== undefined) node.updatedAt = cloneValue(updatedAt);
  return node;
}

function sourceContent(snapshot) {
  if (!snapshot) return null;
  return { revisionAt: snapshot.revisionAt ?? null, data: snapshot.data ?? {} };
}

function sameSourceContent(left, right) {
  return JSON.stringify(sourceContent(left)) === JSON.stringify(sourceContent(right));
}

function needsMaterializedMigration(current) {
  return current?.schema !== STATS_SCHEMA
    || !isRecord(current?.sourceSnapshots)
    || !isRecord(current?.profileStats)
    || !isRecord(current?.activityStats);
}

function isCanonicalStatsNode(value) {
  return isRecord(value)
    && value.schema === STATS_SCHEMA
    && isRecord(value.sourceSnapshots);
}

function mergeLegacyCompatibilityNode(canonical, legacy) {
  if (!isRecord(legacy)) return isRecord(canonical) ? cloneValue(canonical) : {};
  if (!isRecord(canonical) || !isCanonicalStatsNode(canonical)) return cloneValue(legacy);
  return {
    ...cloneValue(legacy),
    ...cloneValue(canonical),
    profileStats: mergeDefined(legacy.profileStats, canonical.profileStats),
    activityStats: mergeDefined(legacy.activityStats, canonical.activityStats),
  };
}

function mergeLegacyNodes(left, right) {
  if (!isRecord(left)) return isRecord(right) ? cloneValue(right) : {};
  if (!isRecord(right)) return cloneValue(left);
  if (isCanonicalStatsNode(left)) return mergeLegacyCompatibilityNode(left, right);
  if (isCanonicalStatsNode(right)) return mergeLegacyCompatibilityNode(right, left);
  return {
    ...cloneValue(left),
    ...cloneValue(right),
    profileStats: mergeDefined(left.profileStats, right.profileStats),
    activityStats: mergeDefined(left.activityStats, right.activityStats),
  };
}

function stripBrowserOwnedReturnTracking(node) {
  const result = cloneValue(node);
  delete result.returnTracking;
  if (isRecord(result.profileStats)) delete result.profileStats.returnTracking;
  if (isRecord(result.activityStats)) delete result.activityStats.returnTracking;
  return result;
}

export function applySourceSnapshotsToFetchedStats(current, incomingSnapshots, metadata = {}) {
  const currentNode = isRecord(current) ? cloneValue(current) : {};
  const currentSnapshots = isRecord(currentNode.sourceSnapshots) ? currentNode.sourceSnapshots : {};
  const nextSnapshots = orderedSourceSnapshots(currentSnapshots);
  const decisions = {};
  let sourceChanged = false;

  for (const domain of SOURCE_DOMAINS) {
    if (!Object.prototype.hasOwnProperty.call(incomingSnapshots || {}, domain)) continue;
    const decision = applyMonotonicSourceSnapshot(currentSnapshots[domain] || null, incomingSnapshots[domain]);
    decisions[domain] = decision;
    if (!sameSourceContent(currentSnapshots[domain], decision.snapshot)) {
      nextSnapshots[domain] = cloneValue(decision.snapshot);
      sourceChanged = true;
    } else if (currentSnapshots[domain] !== undefined) {
      nextSnapshots[domain] = cloneValue(currentSnapshots[domain]);
    }
  }

  const changed = sourceChanged || needsMaterializedMigration(currentNode);
  if (!changed) {
    return { changed: false, node: currentNode, decisions };
  }

  return {
    changed: true,
    node: materializeFetchedStats({ current: currentNode, sourceSnapshots: nextSnapshots, ...metadata }),
    decisions,
  };
}

function encodeFirebasePath(path) {
  return String(path || "").split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

export function createFirebaseStatsTransport({ databaseUrl, token, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  const baseUrl = String(databaseUrl || "").replace(/\/$/, "");
  const urlFor = (path) => `${baseUrl}/${encodeFirebasePath(path)}.json`;

  return {
    async read(path) {
      const response = await fetchImpl(urlFor(path), {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Firebase-ETag": "true",
        },
      });
      if (!response.ok) throw new Error(`Firebase stats GET ${response.status} at ${path}`);
      return {
        value: response.status === 204 ? null : await response.json(),
        etag: response.headers.get("ETag"),
      };
    },
    async write(path, value, etag) {
      if (!etag) throw new Error(`Firebase stats ETag missing at ${path}`);
      const response = await fetchImpl(urlFor(path), {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "If-Match": etag,
        },
        body: JSON.stringify(value),
      });
      if (response.status === 412) return { ok: false, conflict: true, status: 412 };
      if (!response.ok) throw new Error(`Firebase stats PUT ${response.status} at ${path}`);
      return { ok: true, status: response.status };
    },
  };
}

export async function persistStatsWithCas({ transport, path, legacyPath = "", legacyPaths = [], incomingSnapshots, metadata, maxAttempts = 3, omitReturnTracking = false } = {}) {
  if (!transport || typeof transport.read !== "function" || typeof transport.write !== "function") {
    throw new TypeError("stats transport must provide read and write functions");
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new RangeError("maxAttempts must be a positive integer");

  const compatibilityPaths = [...new Set([
    legacyPath,
    ...(Array.isArray(legacyPaths) ? legacyPaths : []),
  ].map(value => String(value || "").trim()).filter(Boolean))];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const remote = await transport.read(path);
    const legacyValues = !isCanonicalStatsNode(remote?.value) && compatibilityPaths.length
      ? await Promise.all(compatibilityPaths.map(compatibilityPath => transport.read(compatibilityPath)))
      : [];
    const legacy = legacyValues.reduce((merged, value) => mergeLegacyNodes(merged, value?.value), null);
    const current = mergeLegacyCompatibilityNode(remote?.value, legacy);
    const applied = applySourceSnapshotsToFetchedStats(current, incomingSnapshots, metadata);
    const compatibilitySeedRequired = !isCanonicalStatsNode(remote?.value) && isCanonicalStatsNode(current);
    const nextNodeCandidate = applied.changed
      ? applied.node
      : materializeFetchedStats({ current, sourceSnapshots: current.sourceSnapshots, ...metadata });
    const nextNode = omitReturnTracking
      ? stripBrowserOwnedReturnTracking(nextNodeCandidate)
      : nextNodeCandidate;
    const compatibilityChanged = JSON.stringify(nextNode) !== JSON.stringify(nextNodeCandidate);
    if (!applied.changed && !compatibilitySeedRequired && !compatibilityChanged) {
      return { status: "noop", attempts: attempt, node: applied.node, decisions: applied.decisions };
    }

    const writeResult = await transport.write(path, nextNode, remote?.etag);
    if (writeResult?.conflict === true || writeResult?.status === 412) {
      if (attempt === maxAttempts) return { status: "conflict", attempts: attempt, node: remote?.value, decisions: applied.decisions };
      continue;
    }
    if (writeResult?.ok !== true) throw new Error(`Firebase stats CAS write failed at ${path}`);
    return { status: "written", attempts: attempt, node: nextNode, decisions: applied.decisions };
  }

  return { status: "conflict", attempts: maxAttempts };
}

export async function persistCanonicalStatsAndViews({
  transport,
  canonicalPath,
  compatibilityPaths = [],
  targetPaths = [],
  incomingSnapshots,
  metadata,
  maxAttempts = 3,
} = {}) {
  const canonical = await persistStatsWithCas({
    transport,
    path: canonicalPath,
    legacyPaths: compatibilityPaths,
    incomingSnapshots,
    metadata,
    maxAttempts,
    omitReturnTracking: true,
  });
  if (canonical.status === "conflict") return { status: "conflict", canonical, targets: [] };

  const canonicalSnapshots = isRecord(canonical.node?.sourceSnapshots)
    ? canonical.node.sourceSnapshots
    : incomingSnapshots;
  const targets = await Promise.all((targetPaths || []).map(target => persistStatsWithCas({
    transport,
    path: target.path,
    legacyPath: target.legacyPath,
    incomingSnapshots: canonicalSnapshots,
    metadata,
    maxAttempts,
  })));
  return { status: "complete", canonical, targets };
}

export function dedupeStatsTargetPaths(targets = []) {
  const entries = new Map();
  for (const target of targets) {
    const path = String(target?.path || "").trim();
    if (!path) continue;
    const entry = entries.get(path) || {
      path,
      shareIds: [],
      ...(target?.legacyPath ? { legacyPath: String(target.legacyPath) } : {}),
    };
    if (!entry.legacyPath && target?.legacyPath) entry.legacyPath = String(target.legacyPath);
    if (target?.shareId && !entry.shareIds.includes(target.shareId)) entry.shareIds.push(target.shareId);
    entries.set(path, entry);
  }
  return [...entries.values()]
    .map(entry => entry.legacyPath ? entry : { path: entry.path, shareIds: entry.shareIds })
    .sort((left, right) => left.path.localeCompare(right.path));
}
