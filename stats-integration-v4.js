(() => {
  const EWGF_PROFILE_WORKER = 'https://tight-bar-55c1.uracil123.workers.dev';
  const PLATFORM_UI = {
    steam: { label: 'Steam', icon: 'assets/platform/steam.svg', hosts: ['steamcommunity.com'] },
    playstation: { label: 'PlayStation', icon: 'assets/platform/playstation.svg', hosts: ['psnprofiles.com'] },
    xbox: { label: 'Xbox', icon: 'assets/platform/xbox.svg', hosts: ['xbox.com'] }
  };

  const normalizeCharacter = value => String(value || '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g, '');
  const hasRecentRankedActivity = stats => (
    Number(stats?.recentRankedGames7d || 0) >= 3
    || Number(stats?.recentRankedGames30d || 0) >= 10
  );
  const isDormantStats = stats => (
    Boolean(stats?.rankIsAllTimeHighest || stats?.ratingIsHistorical)
    && !hasRecentRankedActivity(stats)
  );
  window.hasRecentRankedActivity = hasRecentRankedActivity;
  window.isDormantStats = isDormantStats;
  const getSafePlatformProfile = stats => {
    const platform = String(stats?.platform || '').toLowerCase();
    const config = PLATFORM_UI[platform];
    if (!config || !stats?.platformProfileUrl) return null;
    try {
      const url = new URL(stats.platformProfileUrl);
      const hostname = url.hostname.toLowerCase().replace(/^www\./, '');
      const allowed = url.protocol === 'https:' && config.hosts.some(host =>
        hostname === host || hostname.endsWith(`.${host}`)
      );
      if (!allowed) return null;
      return {
        platform,
        label: config.label,
        icon: config.icon,
        url: url.href,
        id: String(stats.platformId || '').trim()
      };
    } catch {
      return null;
    }
  };
  const findMapValue = (map, character) => {
    const match = Object.entries(map || {}).find(([name]) => normalizeCharacter(name) === normalizeCharacter(character));
    return match && Number.isFinite(Number(match[1])) ? Number(match[1]) : null;
  };
  const findMapObject = (map, character) => {
    const match = Object.entries(map || {}).find(([name]) => normalizeCharacter(name) === normalizeCharacter(character));
    return match && match[1] && typeof match[1] === 'object' ? match[1] : null;
  };
  const setImageSourceIfChanged = (image, source) => {
    const next = String(source || '');
    if (!next) {
      if (image.hasAttribute('src')) image.removeAttribute('src');
      return;
    }
    if (image.getAttribute('src') !== next) image.setAttribute('src', next);
  };
  const selectCharacterCandidates = (wavu, profile) => {
    const qualifiedRatings = (wavu && wavu.qualifiedCharRatingMap) || {};
    const qualifiedGames = (wavu && wavu.qualifiedCharGamesMap) || {};
    const ratedCandidates = Object.entries(qualifiedRatings)
      .filter(([, rating]) => Number.isFinite(Number(rating)))
      .map(([character, rating]) => ({
        character,
        ratingMu: Number(rating),
        leaderboardGames: findMapValue(qualifiedGames, character)
      }))
      .sort((a, b) => b.ratingMu - a.ratingMu
        || Number(b.leaderboardGames || 0) - Number(a.leaderboardGames || 0)
        || a.character.localeCompare(b.character));
    if (ratedCandidates.length) {
      return ratedCandidates.map(candidate => ({
        ...candidate,
        selectionSource: 'wavu-qualified-highest-mu'
      }));
    }

    return [...((profile && profile.characters) || [])]
      .filter(character => character && Number.isFinite(Number(character.games)))
      .sort((a, b) => Number(b.games) - Number(a.games)
        || String(a.character || '').localeCompare(String(b.character || '')))
      .map(character => ({
      character: character.character,
      ratingMu: null,
      leaderboardGames: null,
      lifetimeGames: Number(character.games) || 0,
      selectionSource: 'ewgf-most-lifetime-games'
    }));
  };
  const selectMainCharacter = (wavu, profile) => selectCharacterCandidates(wavu, profile)[0] || {
    character: null, ratingMu: null, leaderboardGames: null, lifetimeGames: null, selectionSource: 'unavailable'
  };
  const findEwgfCharacter = (profile, character) => ((profile && profile.characters) || [])
    .find(item => normalizeCharacter(item.character) === normalizeCharacter(character)) || null;
  const findRankedCharacterStats = (profile, character) => Object.entries((profile && profile.rankedCharacterStats) || {})
    .find(([name]) => normalizeCharacter(name) === normalizeCharacter(character))?.[1] || null;

  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const fetchJsonWithRetry = async (url, {
    attempts = 1,
    requireOk = false,
    label = 'Request',
    timeoutMs = 10000
  } = {}) => {
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const separator = url.includes('?') ? '&' : '?';
        const response = await fetch(`${url}${separator}attempt=${attempt + 1}&ts=${Date.now()}`, {
          cache: 'no-store',
          signal: controller.signal
        });
        const text = await response.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch {}
        if (!response.ok || (requireOk && !data?.ok)) {
          const detail = data?.message || data?.error || `${label} HTTP ${response.status}`;
          const error = new Error(detail);
          error.status = response.status;
          error.label = label;
          error.retryAfter = response.headers.get('Retry-After') || '';
          error.retryable = [429, 500, 502, 503, 504, 522, 524].includes(response.status);
          throw error;
        }
        if (!data) {
          const error = new Error(`${label} returned invalid JSON`);
          error.retryable = true;
          throw error;
        }
        return data;
      } catch (error) {
        lastError = error;
        if (attempt >= attempts - 1 || error.retryable === false) throw error;
        // 429を同じ一括処理内で何度も叩かない。次の選手や共有キャッシュへ早く移る。
        if (error.status === 429) throw error;
        await wait(450 * (attempt + 1) + Math.floor(Math.random() * 250));
      } finally {
        clearTimeout(timeoutId);
      }
    }
    throw lastError || new Error(`${label} failed`);
  };

  const EWGF_MAX_CONCURRENT = 3;
  let activeEwgfRequests = 0;
  const ewgfRequestQueue = [];
  const drainEwgfQueue = () => {
    while (activeEwgfRequests < EWGF_MAX_CONCURRENT && ewgfRequestQueue.length) {
      const { task, resolve, reject } = ewgfRequestQueue.shift();
      activeEwgfRequests += 1;
      Promise.resolve().then(task).then(resolve, reject).finally(() => {
        activeEwgfRequests -= 1;
        drainEwgfQueue();
      });
    }
  };
  const withEwgfSlot = (task, priority = false) => new Promise((resolve, reject) => {
    const queued = { task, resolve, reject };
    if (priority) ewgfRequestQueue.unshift(queued);
    else ewgfRequestQueue.push(queued);
    drainEwgfQueue();
  });
  const reportFetchProgress = (memberKey, gameId, stage, extra = {}) => {
    if (!memberKey) return;
    window.dispatchEvent(new CustomEvent('kentomo:fetch-progress', {
      detail: {
        memberKey,
        gameId: cleanTekkenId(gameId),
        stage,
        at: Date.now(),
        ...extra
      }
    }));
  };
  fetchEwgfStats = async function(gameId, forceRefresh = false, memberKey = null, isManual = false, targetName = '') {
    const id = cleanTekkenId(gameId);
    const cached = getLocalStats(id);
    const fetchStartedAt = Date.now();
    const memberForPriority = memberKey && window.currentMembersData
      ? window.currentMembersData[memberKey]
      : null;
    const prioritizeInitialFetch = Boolean(
      memberForPriority
      && (memberForPriority.initialFetchPending || memberForPriority.fetchedStats?.initialFetchPending)
    );
    // A normal page open/reload must honor the 12-hour profile cache without
    // schema/optional-field repair exceptions. Those exceptions previously
    // caused every PC visit to write Firebase again and made another open
    // mobile session repaint. Missing optional details are repaired only after
    // TTL expiry or by an explicit manual refresh.
    if (!forceRefresh && cached
      && Date.now() - Number(cached.cachedAt || cached.updatedAt || 0) < CACHE_TTL_MS
      && !cached.isError
      && !cached.refreshFailed) {
      reportFetchProgress(memberKey, id, 'cached', { stats: cached });
      return cached;
    }
    reportFetchProgress(memberKey, id, 'sources', {
      message: 'EWGF・Wavuへ接続しています'
    });
    const pageOpenRefresh = Boolean(window.kentomoPageOpenProfileRefresh && forceRefresh);
    // Do not overwrite the list's last-update status once per member as a
    // manual or 12-hour background update during an access-time sweep.
    if (!pageOpenRefresh) recordLastUpdateLog(isManual ? 'manual' : 'auto', targetName);
    try {
      // Manual bulk refresh also uses the Worker's shared cache. This prevents
      // concentrated EWGF requests from blanking rank and image data.
      // `/profile-v2` is deliberately a distinct Worker cache path. The
      // former root path may retain the pre-20260802 12-hour profile body
      // that bundled every character matchup table.
      const profileBaseUrl = `${EWGF_PROFILE_WORKER}/profile-v2?ewgfId=${encodeURIComponent(id)}`;
      const wavuBaseUrl = `${EWGF_PROFILE_WORKER}/?mode=wavu-ratings&gameId=${encodeURIComponent(id)}`;
      // The admin flag is global for compatibility with the existing UI, so
      // require an explicit manual request as well. Background requests that
      // overlap an admin click must never inherit force=1.
      // A list-open sweep is deliberately separate from an administrator
      // refresh. It is throttled in both the browser and Worker, then asks the
      // Worker for a fresh shared snapshot without exposing an unbounded force
      // path to ordinary card rendering.
      const forceSuffix = window.forceAdminProfileRefresh && isManual
        ? '&force=1&manualRefresh=1'
        : (pageOpenRefresh ? '&force=1&pageOpen=1' : '');
      let refreshUsedSharedCache = false;
      const sourceTimingsMs = {};
      const sourceErrors = {};
      const loadWavu = async () => {
        const startedAt = Date.now();
        try {
          return await withEwgfSlot(() => fetchJsonWithRetry(`${wavuBaseUrl}${forceSuffix}`, {
            attempts: forceSuffix ? 1 : 2,
            label: 'Wavu',
            timeoutMs: 15000
          }), prioritizeInitialFetch);
        } catch (error) {
          if (!forceSuffix) throw error;
          refreshUsedSharedCache = true;
          console.warn(`Forced Wavu refresh failed for ${id}; using shared cache`, error);
          return withEwgfSlot(() => fetchJsonWithRetry(wavuBaseUrl, {
            attempts: 1,
            label: 'Wavu shared cache',
            timeoutMs: 15000
          }), prioritizeInitialFetch);
        } finally {
          sourceTimingsMs.wavu = Date.now() - startedAt;
        }
      };
      const loadProfile = async () => {
        const startedAt = Date.now();
        try {
          return await withEwgfSlot(() => fetchJsonWithRetry(`${profileBaseUrl}${forceSuffix}`, {
            attempts: forceSuffix ? 1 : 2,
            requireOk: true,
            label: 'EWGF',
            timeoutMs: 45000
          }), prioritizeInitialFetch);
        } catch (error) {
          if (!forceSuffix) throw error;
          refreshUsedSharedCache = true;
          console.warn(`Forced EWGF refresh failed for ${id}; using shared cache`, error);
          return withEwgfSlot(() => fetchJsonWithRetry(profileBaseUrl, {
            attempts: 1,
            requireOk: true,
            label: 'EWGF shared cache',
            timeoutMs: 45000
          }), prioritizeInitialFetch);
        } finally {
          sourceTimingsMs.ewgf = Date.now() - startedAt;
        }
      };
      // These sources are independent. Waiting for them in parallel changes
      // initial-card latency from their sum to roughly the slower request.
      const [wavuResult, profileResult] = await Promise.allSettled([loadWavu(), loadProfile()]);
      reportFetchProgress(memberKey, id, 'analyzing', {
        sources: {
          ewgf: profileResult.status === 'fulfilled' ? 'ready' : 'error',
          wavu: wavuResult.status === 'fulfilled' ? 'ready' : 'error'
        },
        sourceTimingsMs
      });
      // EWGF contains the lifetime character/rank rows needed to build a usable
      // card. Wavu adds recent-main/rating detail, but a missing Wavu player or
      // a temporary Wavu failure must not leave a newly added card in "準備中".
      if (profileResult.status === 'rejected') throw profileResult.reason;
      const profile = profileResult.value;
      const wavu = wavuResult.status === 'fulfilled' ? wavuResult.value : null;
      if (wavuResult.status === 'rejected') {
        sourceErrors.wavu = wavuResult.reason?.message || String(wavuResult.reason);
        console.warn(`Wavu unavailable for ${id}; rendering EWGF profile fallback`, wavuResult.reason);
      }
      const qualifiedSelection = selectMainCharacter(wavu, null);
      const selected = qualifiedSelection.selectionSource === 'wavu-qualified-highest-mu'
        ? qualifiedSelection
        : selectMainCharacter(wavu, profile);
      const qualifiedCandidates = selected.selectionSource === 'wavu-qualified-highest-mu'
        ? selectCharacterCandidates(wavu, null)
        : [];
      const lifetimeCandidates = selectCharacterCandidates(null, profile);
      const secondaryCandidate = qualifiedCandidates
        .find(candidate => normalizeCharacter(candidate.character) !== normalizeCharacter(selected.character))
        || lifetimeCandidates.find(candidate => normalizeCharacter(candidate.character) !== normalizeCharacter(selected.character))
        || null;
      const characterCandidates = [selected, secondaryCandidate].filter(Boolean);
      const fallbackRatingMu = selected.selectionSource === 'ewgf-most-lifetime-games'
        ? findMapValue(wavu && wavu.charRatingMap, selected.character)
        : null;
      const ratingIsHistorical = selected.ratingMu === null && fallbackRatingMu !== null;
      const displayedRatingMu = ratingIsHistorical ? fallbackRatingMu : selected.ratingMu;
      const ewgfCharacter = findEwgfCharacter(profile, selected.character);
      if (!selected.character) throw new Error('Main character candidate not found');
      if (!ewgfCharacter) throw new Error('EWGF character row not found: ' + selected.character);
      const ranked = findRankedCharacterStats(profile, selected.character);
      if (!ranked) throw new Error('EWGF ranked character stats not found: ' + selected.character);
      const currentRankIcon = ewgfCharacter.rankIcon || '';
      const allTimeHighestRank = profile.highestRank || ranked.allTimeHighestRank || '';
      const historicalRankIcon = profile.highestRankIcon || '';
      const rankIsAllTimeHighest = !currentRankIcon && Boolean(allTimeHighestRank && historicalRankIcon);
      const sameCachedCharacter = cached && normalizeCharacter(cached.mainChar) === normalizeCharacter(selected.character);
      const resolvedMainCharImage = ewgfCharacter.characterImage
        || (sameCachedCharacter ? cached.mainCharImage : '') || '';
      const resolvedRankIcon = (rankIsAllTimeHighest ? historicalRankIcon : currentRankIcon)
        || (sameCachedCharacter ? cached.rankIcon : '') || '';
      const rawWavuTime = wavu.latestBattle && wavu.latestBattle.battle_at ? Number(wavu.latestBattle.battle_at) : Number(wavu.latestBattleAt || 0);
      const wavuTime = rawWavuTime ? (rawWavuTime < 1e11 ? rawWavuTime * 1000 : rawWavuTime) : null;
      const parsedEwgfTime = Date.parse(profile.latestBattleAt || '');
      const ewgfTime = Number.isFinite(parsedEwgfTime) ? parsedEwgfTime : null;
      const resolvedLastSeenTimestamp = Math.max(
        Number(ewgfTime || 0),
        Number(wavuTime || 0),
        Number(cached?.lastSeenTimestamp || 0)
      ) || null;
      const cachedBattleIsNewest = Number(cached?.lastSeenTimestamp || 0) > Math.max(Number(ewgfTime || 0), Number(wavuTime || 0));
      const platformProfile = profile?.platformProfile || {};
      const characterSelectionTop = characterCandidates.slice(0, 2).map((candidate, index) => {
        const characterRow = findEwgfCharacter(profile, candidate.character);
        const rankedRow = findRankedCharacterStats(profile, candidate.character);
        return {
          position: index + 1,
          character: candidate.character || '',
          characterImage: characterRow?.characterImage || '',
          selectionSource: candidate.selectionSource,
          ratingMu: candidate.ratingMu !== null && candidate.ratingMu !== undefined && Number.isFinite(Number(candidate.ratingMu))
            ? Number(candidate.ratingMu) : null,
          leaderboardGames: candidate.leaderboardGames !== null && candidate.leaderboardGames !== undefined && Number.isFinite(Number(candidate.leaderboardGames))
            ? Number(candidate.leaderboardGames) : null,
          lifetimeGames: Number(rankedRow?.games || candidate.lifetimeGames || 0),
          wins: Number(rankedRow?.wins || 0),
          losses: Number(rankedRow?.losses || 0)
        };
      });
      const stats = {
        gameId:id, mainChar:selected.character, mainCharCode:ewgfCharacter.characterCode || '', mainCharImage:resolvedMainCharImage,
        mainCharGames:Number(ranked.games) || 0, wins:Number(ranked.wins) || 0, losses:Number(ranked.losses) || 0, rankedWinRate:Number(ranked.winRate), rankedDataVerified:true, leaderboardGames:selected.leaderboardGames, mainSelectionSource:selected.selectionSource,
        danRank:rankIsAllTimeHighest ? allTimeHighestRank : (ewgfCharacter.currentRank || '-'),
        rankIcon:resolvedRankIcon,
        rankIsAllTimeHighest,
        historicalRankRepairAttempted:true,
        ratingMu:displayedRatingMu, ratingCharacter:selected.character, ratingIsHistorical,
        charRatingMap:{...(wavu?.charRatingMap || {})},
        qualifiedCharRatingMap:{...(wavu?.qualifiedCharRatingMap || {})},
        characterSelectionTop,
        secondaryCandidateResolved:true,
        recentRankedGames7d:Number(wavu?.recentRankedGames7d || 0),
        recentRankedGames30d:Number(wavu?.recentRankedGames30d || 0),
        recentRankedSampleSize:Number(wavu?.recentRankedSampleSize || 0),
        latestRankedBattleAt:wavu?.latestRankedBattleAt || '',
        tekkenPower:Number(profile.tekkenProwess) || (cached ? cached.tekkenPower : 0) || 0,
        lastSeenTimestamp:resolvedLastSeenTimestamp,
        latestBattleCharacter:cachedBattleIsNewest
          ? (cached?.latestBattleCharacter || '')
          : (profile.latestBattle?.character || cached?.latestBattleCharacter || ''),
        latestBattleType:cachedBattleIsNewest
          ? (cached?.latestBattleType || '')
          : (profile.latestBattle?.battleType || cached?.latestBattleType || ''),
        statPentagon:profile.statPentagon || (cached ? cached.statPentagon : null) || null,
        playerName:String(profile.playerName || '').trim().slice(0, 50),
        playerMessage:normalizePlayerMessage(profile.playerMessage),
        platform:platformProfile.platform || cached?.platform || '',
        platformId:platformProfile.platformId || cached?.platformId || '',
        platformProfileUrl:platformProfile.platformProfileUrl || cached?.platformProfileUrl || '',
        totalRankedGames:Number.isFinite(Number(profile.totalRankedGames))
          ? Math.max(0, Number(profile.totalRankedGames)) : cached?.totalRankedGames,
        totalPlayerMatchGames:Number.isFinite(Number(profile.totalPlayerMatchGames))
          ? Math.max(0, Number(profile.totalPlayerMatchGames)) : cached?.totalPlayerMatchGames,
        totalQuickMatchGames:Number.isFinite(Number(profile.totalQuickMatchGames))
          ? Math.max(0, Number(profile.totalQuickMatchGames)) : cached?.totalQuickMatchGames,
        totalGroupMatchGames:Number.isFinite(Number(profile.totalGroupMatchGames))
          ? Math.max(0, Number(profile.totalGroupMatchGames)) : cached?.totalGroupMatchGames,
        totalRecordedGames:Number.isFinite(Number(profile.totalRecordedGames))
          ? Math.max(0, Number(profile.totalRecordedGames)) : cached?.totalRecordedGames,
        refreshUsedSharedCache,
        fetchMeta:{
          state:'ready',
          startedAt:fetchStartedAt,
          completedAt:Date.now(),
          durationMs:Date.now() - fetchStartedAt,
          sourceTimingsMs,
          sourceErrors,
          schema:'20260729-acquisition-pipeline'
        },
        totalBattlesFetched:0, statsSource:'20260729-main-character-reasons', isError:false, updatedAt:Date.now()
      };
      // This is Kentomo-owned notification state. EWGF/Wavu provide the
      // ranked-activity facts; the app remembers one return per dormant
      // episode so an occasional single ranked game cannot re-notify weekly.
      if (typeof window.resolveDormantReturnTracking === 'function') {
        const returnTracking = window.resolveDormantReturnTracking(cached, stats);
        if (returnTracking) stats.returnTracking = returnTracking;
      }
      reportFetchProgress(memberKey, id, 'saving', { stats });
      setLocalStats(id, stats, memberKey);
      reportFetchProgress(memberKey, id, sourceErrors.wavu ? 'partial' : 'ready', { stats });
      queueEnhance();
      return stats;
    } catch (error) {
      console.warn(`Integrated stats fetch failed for ${id}:`, error);
      // Wavu/EWGFのURLはTEKKEN 8 IDの大小文字を区別する。登録時の
      // 補完が一時的に失敗していた既存カードは、正式IDを検索して一度だけ再試行する。
      if (
        memberKey &&
        /^[A-Za-z0-9]{12}$/.test(id) &&
        typeof window.resolveCanonicalTekkenId === 'function'
      ) {
        try {
          const resolvedPlayer = await window.resolveCanonicalTekkenId(id);
          if (resolvedPlayer.status === 'corrected') {
            const correctedStats = await fetchEwgfStats(
              resolvedPlayer.gameId,
              forceRefresh,
              memberKey,
              isManual,
              targetName
            );
            if (typeof window.persistCanonicalTekkenId === 'function') {
              await window.persistCanonicalTekkenId(memberKey, id, resolvedPlayer);
            }
            return correctedStats;
          }
        } catch (repairError) {
          console.warn(`Canonical ID recovery failed for ${id}:`, repairError);
        }
      }
      const refreshErrorMessage = error && error.message ? error.message : String(error);
      const refreshErrorStatus = Number(error && error.status) || null;
      reportFetchProgress(memberKey, id, 'error', {
        errorMessage: refreshErrorMessage,
        errorStatus: refreshErrorStatus
      });
      if (memberKey && typeof window.persistMemberFetchFailureMeta === 'function') {
        window.persistMemberFetchFailureMeta(memberKey, id, {
          startedAt: fetchStartedAt,
          errorMessage: refreshErrorMessage,
          errorStatus: refreshErrorStatus
        });
      }
      if (cached) return {
        ...cached,
        refreshFailed:true,
        refreshErrorMessage,
        refreshErrorStatus,
        fetchMeta:{
          state:'error',
          startedAt:fetchStartedAt,
          completedAt:Date.now(),
          durationMs:Date.now() - fetchStartedAt,
          errorStatus:refreshErrorStatus,
          errorMessage:refreshErrorMessage,
          schema:'20260729-acquisition-pipeline'
        }
      };
      return {
        gameId:id, mainChar:'取得失敗', mainCharGames:0, danRank:'-', ratingMu:null,
        tekkenPower:0, lastSeenTimestamp:null, isError:true, refreshFailed:true,
        refreshErrorMessage, refreshErrorStatus,
        fetchMeta:{
          state:'error',
          startedAt:fetchStartedAt,
          completedAt:Date.now(),
          durationMs:Date.now() - fetchStartedAt,
          errorStatus:refreshErrorStatus,
          errorMessage:refreshErrorMessage,
          schema:'20260729-acquisition-pipeline'
        },
        updatedAt:Date.now()
      };
    }
  };

  // renderPosters and the enhancement observer can discover the same uncached
  // card at nearly the same time. Share that request instead of sending two
  // Wavu + EWGF pairs for one TEKKEN ID.
  const inFlightStatsRequests = new Map();
  const statsFailureBackoff = new Map();
  const statsBackoffTimers = new Map();
  const BACKOFF_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000];
  const statsBackoffKey = id => `t8_stats_backoff_${String(id || '').toUpperCase()}`;
  const readStatsBackoff = id => {
    if (statsFailureBackoff.has(id)) return statsFailureBackoff.get(id);
    try {
      const stored = JSON.parse(sessionStorage.getItem(statsBackoffKey(id)) || 'null');
      if (stored && Number.isFinite(Number(stored.nextRetryAt))) {
        statsFailureBackoff.set(id, stored);
        return stored;
      }
    } catch {}
    return null;
  };
  const clearStatsBackoff = id => {
    statsFailureBackoff.delete(id);
    try { sessionStorage.removeItem(statsBackoffKey(id)); } catch {}
    clearTimeout(statsBackoffTimers.get(id));
    statsBackoffTimers.delete(id);
  };
  const recordStatsFailure = id => {
    const previous = readStatsBackoff(id);
    const failures = Math.min(Number(previous?.failures || 0) + 1, BACKOFF_DELAYS_MS.length);
    const delay = BACKOFF_DELAYS_MS[failures - 1];
    const record = { failures, nextRetryAt: Date.now() + delay };
    statsFailureBackoff.set(id, record);
    try { sessionStorage.setItem(statsBackoffKey(id), JSON.stringify(record)); } catch {}
    clearTimeout(statsBackoffTimers.get(id));
    statsBackoffTimers.set(id, setTimeout(() => {
      statsBackoffTimers.delete(id);
      queueEnhance();
    }, delay + 250));
  };
  const fetchEwgfStatsWithoutCoalescing = fetchEwgfStats;
  fetchEwgfStats = function(gameId, forceRefresh = false, memberKey = null, isManual = false, targetName = '') {
    const id = cleanTekkenId(gameId);
    const normalizedId = id.toUpperCase();
    const member = memberKey && window.currentMembersData
      ? window.currentMembersData[memberKey]
      : null;
    const isInitialPending = Boolean(
      member && (member.initialFetchPending || member.fetchedStats?.initialFetchPending)
    );
    // A first request can time out just before the Worker finishes warming its
    // shared cache. Never let the ordinary one-minute failure backoff strand a
    // brand-new card after that cache has become available.
    const backoff = !forceRefresh && !isManual && !isInitialPending
      ? readStatsBackoff(normalizedId)
      : null;
    if (backoff && backoff.nextRetryAt > Date.now()) {
      const cached = getLocalStats(id);
      return Promise.resolve(cached || {
        gameId:id, mainChar:'取得待機中', mainCharGames:0, danRank:'-', ratingMu:null,
        tekkenPower:0, lastSeenTimestamp:null, isError:true, refreshFailed:true,
        refreshErrorMessage:'外部サービスの混雑を避けるため再試行を待機しています',
        updatedAt:Date.now()
      });
    }
    const adminForce = Boolean(window.forceAdminProfileRefresh && isManual);
    const pageOpenForce = Boolean(window.kentomoPageOpenProfileRefresh && forceRefresh);
    // TEKKEN IDs are case-sensitive. Keep the submitted casing in the
    // coalescing key so canonical-case recovery can start the corrected
    // request instead of accidentally awaiting the original request itself.
    const requestKey = `${id}:${adminForce ? 'admin-force' : (pageOpenForce ? 'page-open-force' : 'shared')}`;
    const existing = inFlightStatsRequests.get(requestKey);
    if (existing) {
      reportFetchProgress(memberKey, id, 'queued', {
        message: '同じプレイヤーの取得処理を待っています'
      });
      return existing;
    }
    const request = Promise.resolve().then(() =>
      fetchEwgfStatsWithoutCoalescing(gameId, forceRefresh, memberKey, isManual, targetName)
    ).then(result => {
      if (result && !result.isError && !result.refreshFailed) clearStatsBackoff(normalizedId);
      else recordStatsFailure(normalizedId);
      return result;
    }, error => {
      recordStatsFailure(normalizedId);
      throw error;
    });
    inFlightStatsRequests.set(requestKey, request);
    return request.finally(() => {
      if (inFlightStatsRequests.get(requestKey) === request) {
        inFlightStatsRequests.delete(requestKey);
      }
    });
  };

  const pendingIds = new Set();
  const enhancementRepairAttemptedIds = new Set();
  let matchupReturnHandler = null;
  function ensureMatchupModal() {
    let modal = document.getElementById('characterMatchupModal');
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'characterMatchupModal';
    modal.className = 'character-matchup-modal';
    modal.hidden = true;
    modal.innerHTML = `<div class="character-matchup-dialog" role="dialog" aria-modal="true" aria-labelledby="characterMatchupTitle">
      <button class="character-matchup-close" type="button" aria-label="閉じる">×</button>
      <div class="character-matchup-kicker">ALL-CHARACTER MATCHUP ANALYSIS</div>
      <h2 id="characterMatchupTitle"></h2>
      <p class="character-matchup-lead"></p>
      <section><h3>得意な相手 <small>TOP 3</small></h3><div class="character-matchup-list is-best"></div></section>
      <section><h3>苦手な相手 <small>BOTTOM 3</small></h3><div class="character-matchup-list is-worst"></div></section>
      <small class="character-matchup-note">EWGF Character Matchup Analysisの「現在シーズン・ランクマッチ」を、使用した全キャラ分で合算しています。少数戦の数値は大きく変動します。</small>
    </div>`;
    document.body.appendChild(modal);
    const close = (fromHistory = false) => {
      const returnToPreviousView = matchupReturnHandler;
      matchupReturnHandler = null;
      modal.hidden = true;
      document.body.classList.remove('character-matchup-open');
      if (!fromHistory && history.state?.kentomoOverlay === modal.id) history.back();
      // Compact landscape details deliberately yield their layer while this
      // modal is open. Restore that exact detail view after either ×, outside
      // click, Escape, or browser-back rather than leaving the user at the list.
      if (typeof returnToPreviousView === 'function') {
        requestAnimationFrame(returnToPreviousView);
      }
    };
    modal.querySelector('.character-matchup-close').addEventListener('click', close);
    modal.addEventListener('click', event => { if (event.target === modal) close(); });
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && !modal.hidden) close(); });
    window.addEventListener('popstate', () => { if (!modal.hidden) close(true); });
    return modal;
  }
  // Build the modal while the browser is idle so the first user tap only has
  // to reveal an existing lightweight layer.
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(() => ensureMatchupModal(), { timeout: 1500 });
  } else {
    setTimeout(() => ensureMatchupModal(), 500);
  }
  function renderMatchupList(host, records) {
    host.replaceChildren();
    if (!records.length) {
      const empty = document.createElement('p');
      empty.className = 'character-matchup-empty';
      empty.textContent = '比較できる対戦履歴がありません';
      host.appendChild(empty);
      return;
    }
    records.forEach(record => {
      const item = document.createElement('article');
      item.innerHTML = `<span class="character-matchup-avatar"><span aria-hidden="true">?</span><img alt=""></span><strong></strong><b></b><small></small>`;
      // EWGF keeps spaces as underscores (devil_jin, armor_king, miary_zo)
      // while canonical hyphens such as jack-8 remain hyphens.
      const slug = record.character.normalize('NFKD').toLowerCase()
        .replace(/\s+/g, '_')
        .replace(/[^a-z0-9_-]+/g, '');
      const image = item.querySelector('.character-matchup-avatar img');
      const source = `https://ewgf.gg/static/circular_character_icons/${slug}.webp`;
      image.src = `${EWGF_PROFILE_WORKER}/?imageUrl=${encodeURIComponent(source)}`;
      image.alt = `${record.character} icon`;
      image.addEventListener('load', () => image.classList.add('is-loaded'), { once: true });
      image.addEventListener('error', () => image.remove(), { once: true });
      item.querySelector('strong').textContent = record.character;
      item.querySelector('b').textContent = `${record.winRate.toFixed(1)}%`;
      item.querySelector('small').textContent = `${record.games}戦`;
      host.appendChild(item);
    });
  }
  const lazyMatchupCache = new Map();
  const lazyMatchupRequests = new Map();
  const MATCHUP_LOCAL_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
  const matchupLocalStorageKey = ewgfId => `kentomo_matchup_aggregate_v1_${String(ewgfId || '').toUpperCase()}`;
  function readPersistedMatchupCache(ewgfId) {
    try {
      const saved = JSON.parse(localStorage.getItem(matchupLocalStorageKey(ewgfId)) || 'null');
      if (!saved || Date.now() - Number(saved.savedAt || 0) >= MATCHUP_LOCAL_CACHE_TTL_MS) return null;
      if (!saved.data || typeof saved.data.records !== 'object') return null;
      return saved.data;
    } catch (_) {
      return null;
    }
  }
  function writePersistedMatchupCache(ewgfId, data) {
    try {
      localStorage.setItem(matchupLocalStorageKey(ewgfId), JSON.stringify({ savedAt: Date.now(), data }));
    } catch (_) {
      // Storage may be unavailable or full; the Worker cache remains the
      // fallback and gameplay data must not be blocked by this optimization.
    }
  }
  function aggregateAllCharacterMatchups(characterMatchups) {
    const merged = {};
    let characterCount = 0;
    for (const group of Object.values(characterMatchups || {})) {
      const records = group?.records || {};
      if (!Object.keys(records).length) continue;
      characterCount += 1;
      for (const [opponent, record] of Object.entries(records)) {
        const games = Number(record?.games);
        const wins = Number(record?.wins);
        const losses = Number(record?.losses);
        if (!opponent || !Number.isFinite(games) || games <= 0 || !Number.isFinite(wins) || !Number.isFinite(losses)) continue;
        const current = merged[opponent] || { wins: 0, losses: 0, games: 0 };
        current.wins += wins;
        current.losses += losses;
        current.games += games;
        merged[opponent] = current;
      }
    }
    const records = Object.fromEntries(Object.entries(merged).map(([opponent, record]) => [opponent, {
      ...record,
      winRate: record.games ? (record.wins / record.games) * 100 : 0
    }]));
    const totalGames = Object.values(records).reduce((sum, record) => sum + Number(record.games || 0), 0);
    return { records, characterCount, totalGames };
  }
  async function fetchLazyCharacterMatchups(gameId) {
    const ewgfId = cleanTekkenId(gameId);
    if (!ewgfId) throw new Error('プレイヤーIDが未設定です');
    const cacheKey = ewgfId.toUpperCase();
    if (lazyMatchupCache.has(cacheKey)) return lazyMatchupCache.get(cacheKey);
    const persisted = readPersistedMatchupCache(ewgfId);
    if (persisted) {
      lazyMatchupCache.set(cacheKey, persisted);
      return persisted;
    }
    if (lazyMatchupRequests.has(cacheKey)) return lazyMatchupRequests.get(cacheKey);
    const request = (async () => {
      // Matchups share the same client queue and retry policy as a profile.
      // A transient 5xx gets one delayed retry; 429 remains a hard stop in
      // fetchJsonWithRetry so a dialog cannot amplify upstream pressure.
      const data = await withEwgfSlot(() => {
        const url = `${EWGF_PROFILE_WORKER}/?mode=matchups&ewgfId=${encodeURIComponent(ewgfId)}`;
        return fetchJsonWithRetry(url, {
          attempts: 2,
          requireOk: true,
          label: '相性データ',
          timeoutMs: 45000
        });
      });
      const aggregate = aggregateAllCharacterMatchups(data.characterMatchups);
      lazyMatchupCache.set(cacheKey, aggregate);
      writePersistedMatchupCache(ewgfId, aggregate);
      return aggregate;
    })();
    lazyMatchupRequests.set(cacheKey, request);
    try {
      return await request;
    } finally {
      lazyMatchupRequests.delete(cacheKey);
    }
  }
  function showMatchupModal(modal) {
    modal.hidden = false;
    if (history.state?.kentomoOverlay !== modal.id) {
      history.pushState({ ...(history.state || {}), kentomoOverlay: modal.id }, '');
    }
    document.body.classList.add('character-matchup-open');
    modal.querySelector('.character-matchup-close').focus();
  }
  function showMatchupRetry(modal, member, stats, options = {}) {
    const lead = modal.querySelector('.character-matchup-lead');
    lead.replaceChildren('相性データを読み込めませんでした。');
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'character-matchup-retry';
    retry.textContent = 'もう一度試す';
    retry.addEventListener('click', () => {
      retry.disabled = true;
      openMatchupModal(member, stats, options);
    }, { once: true });
    lead.append(' ', retry);
    modal.querySelector('.is-best').innerHTML = '<p class="character-matchup-empty">一時的な通信失敗の可能性があります。</p>';
    modal.querySelector('.is-worst').innerHTML = '<p class="character-matchup-empty">再試行しても続く場合は、少し時間を置いてください。</p>';
  }
  async function openMatchupModal(member, stats, options = {}) {
    const modal = ensureMatchupModal();
    matchupReturnHandler = typeof options.onClose === 'function' ? options.onClose : null;
    modal.querySelector('h2').textContent = `${member.name || member.gameId || 'PLAYER'} の対戦傾向`;
    modal.querySelector('.character-matchup-lead').innerHTML = '<span class="character-matchup-loading-dot" aria-hidden="true"></span>保存済みデータを確認中です。初回のみ数秒かかる場合があります（再タップ不要）';
    modal.querySelector('.is-best').innerHTML = '<p class="character-matchup-empty is-loading">取得中…</p>';
    modal.querySelector('.is-worst').innerHTML = '<p class="character-matchup-empty is-loading">取得中…</p>';
    showMatchupModal(modal);
    let matchupData;
    try {
      matchupData = await fetchLazyCharacterMatchups(member.gameId);
    } catch (error) {
      console.warn('Character matchup fetch failed:', error);
      showMatchupRetry(modal, member, stats, options);
      return;
    }
    if (modal.hidden) return;
    const matchupRecords = matchupData.records || {};
    const records = Object.entries(matchupRecords).map(([character, value]) => ({
      character,
      games: Number(value?.games) || 0,
      winRate: Number(value?.winRate)
    })).filter(item => item.games > 0 && Number.isFinite(item.winRate));
    const reliable = records.filter(item => item.games >= 3);
    const pool = reliable.length >= 2 ? reliable : records;
    const best = [...pool].sort((a, b) => b.winRate - a.winRate || b.games - a.games).slice(0, 3);
    const worst = [...pool].sort((a, b) => a.winRate - b.winRate || b.games - a.games).slice(0, 3);
    modal.querySelector('.character-matchup-lead').textContent = `使用${matchupData.characterCount}キャラ・合計${matchupData.totalGames.toLocaleString()}戦を集計（${pool.length}キャラとの対戦傾向）`;
    renderMatchupList(modal.querySelector('.is-best'), best);
    renderMatchupList(modal.querySelector('.is-worst'), worst);
  }
  window.openCharacterMatchupDetails = openMatchupModal;
  function openMatchupFromPanel(panel, event) {
    const card = panel.closest('.poster-card');
    const key = card?.dataset.memberKey;
    const member = key && window.currentMembersData?.[key];
    const stats = member ? getLocalStats(cleanTekkenId(member.gameId), member) : null;
    if (!member || !stats?.mainChar) return;
    event.preventDefault();
    event.stopPropagation();
    openMatchupModal(member, stats);
  }
  let matchupTouchStart = null;
  let matchupTouchOpenedAt = 0;
  document.addEventListener('pointerdown', event => {
    const panel = event.target.closest('.stats-preview-head');
    if (!panel || event.target.closest('a,button,input,select,textarea')) {
      matchupTouchStart = null;
      return;
    }
    matchupTouchStart = {
      panel,
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY
    };
  }, { capture: true, passive: true });
  document.addEventListener('pointerup', event => {
    const start = matchupTouchStart;
    matchupTouchStart = null;
    if (!start || start.pointerId !== event.pointerId || !start.panel.isConnected) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 12) return;
    matchupTouchOpenedAt = Date.now();
    openMatchupFromPanel(start.panel, event);
  }, { capture: true });
  // Delegation makes the very first tap work even before MutationObserver's
  // enhancement pass has attached per-card affordances.
  document.addEventListener('click', event => {
    if (Date.now() - matchupTouchOpenedAt < 700) return;
    const panel = event.target.closest('.stats-preview-head');
    if (!panel || event.target.closest('a,button,input,select,textarea')) return;
    openMatchupFromPanel(panel, event);
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const panel = event.target.closest('.stats-preview-head');
    if (!panel) return;
    openMatchupFromPanel(panel, event);
  });
  function enhanceBox(box) {
    const key = box.id.replace('stats_box_', '');
    const member = window.currentMembersData && window.currentMembersData[key];
    if (!member) return;
    const id = cleanTekkenId(member.gameId);
    const stats = getLocalStats(id, member);
    if (!stats) return;
    if (typeof window.updateCardAcquisitionStatus === 'function') {
      window.updateCardAcquisitionStatus(key, stats);
    }
    const card = box.closest('.poster-card');
    const recentRankedActive = hasRecentRankedActivity(stats);
    const dormant = isDormantStats(stats);
    box.classList.toggle('is-historical-player', dormant);
    // Opening a list is display-only. Data acquisition is intentionally
    // limited to a newly added player and the Worker's background scheduler.
    const main = box.querySelector('.stats-preview-main');
    const playerMessage = card && card.querySelector('.player-message');
    if (playerMessage) {
      const normalizedMessage = normalizePlayerMessage(stats.playerMessage);
      playerMessage.textContent = normalizedMessage || '\u00a0';
      playerMessage.classList.toggle('is-empty', !normalizedMessage);
    }
    if (main) {
      let image = main.querySelector('.stats-preview-character-icon');
      if (!image) { image = document.createElement('img'); image.className = 'stats-preview-character-icon'; main.prepend(image); }
      let mainCopy = main.querySelector('.stats-preview-main-copy');
      if (!mainCopy) {
        mainCopy = document.createElement('div');
        mainCopy.className = 'stats-preview-main-copy';
        const existingName = main.querySelector('.val-main-char');
        const existingGames = main.querySelector('.stats-preview-games');
        if (existingName) mainCopy.append(existingName);
        if (existingGames) mainCopy.append(existingGames);
        main.append(mainCopy);
      }
      setImageSourceIfChanged(image, stats.mainCharImage);
      image.alt = stats.mainChar ? `${stats.mainChar} icon` : '';
      image.hidden = false;
      image.classList.toggle('is-image-missing', !stats.mainCharImage);
      const name = main.querySelector('.val-main-char'); if (name && name.textContent !== (stats.mainChar || 'Unknown')) name.textContent = stats.mainChar || 'Unknown';
      const games = main.querySelector('.stats-preview-games'); if (games) games.textContent = stats.mainCharGames ? `· ${stats.mainCharGames.toLocaleString()} games` : '';
    }
    const rankValue = box.querySelector('.stats-preview-metric-rank .stats-preview-value');
    if (rankValue) {
      rankValue.classList.add('stats-preview-rank');
      let image = rankValue.querySelector('.stats-preview-rank-icon');
      if (!image) { image = document.createElement('img'); image.className = 'stats-preview-rank-icon'; rankValue.prepend(image); }
      setImageSourceIfChanged(image, stats.rankIcon);
      image.alt = stats.danRank ? `${stats.danRank} rank icon` : '';
      image.hidden = false;
      image.classList.toggle('is-image-missing', !stats.rankIcon);
      image.classList.toggle('is-all-time-highest', dormant);
      image.title = stats.rankIsAllTimeHighest ? `All time highest rank: ${stats.danRank}` : '';
      let name = rankValue.querySelector('.val-rank');
      if (!name) { name = document.createElement('span'); name.className = 'stats-preview-rank-name val-rank'; rankValue.append(name); }
      for (const node of [...rankValue.childNodes]) if (node.nodeType === Node.TEXT_NODE) node.remove();
      if (name.textContent !== (stats.danRank || '-')) name.textContent = stats.danRank || '-';
    }
    const ratingValue = box.querySelector('.val-rating');
    if (ratingValue) {
      const ratingText = stats.ratingMu !== null ? 'μ ' + stats.ratingMu : '-';
      if (ratingValue.textContent !== ratingText) ratingValue.textContent = ratingText;
      const showHistoricalRating = Boolean(stats.ratingIsHistorical && dormant);
      ratingValue.classList.toggle('is-historical-rating', showHistoricalRating);
      const numericRating = Number(stats.ratingMu);
      const hasRating = Number.isFinite(numericRating);
      ratingValue.classList.toggle('is-rating-low', hasRating && numericRating < 1700);
      ratingValue.classList.toggle('is-rating-mid', hasRating && numericRating >= 1700 && numericRating < 2000);
      ratingValue.classList.toggle('is-rating-elite', hasRating && numericRating >= 2000);
      ratingValue.title = showHistoricalRating
        ? (stats.ratingCharacter || stats.mainChar || 'Main character') + '：Leaderboard資格外の過去参考レート'
        : '';
    }
    const avatarFrame = card && card.querySelector('.avatar-frame');
    const platformProfile = getSafePlatformProfile(stats);
    let platformBadge = avatarFrame && avatarFrame.querySelector('.player-platform-badge');
    if (avatarFrame && platformProfile) {
      if (!platformBadge) {
        platformBadge = document.createElement('a');
        platformBadge.className = 'player-platform-badge';
        platformBadge.target = '_blank';
        platformBadge.rel = 'noopener noreferrer';
        platformBadge.addEventListener('click', event => event.stopPropagation());
        const platformIcon = document.createElement('img');
        platformIcon.alt = '';
        platformIcon.setAttribute('aria-hidden', 'true');
        platformBadge.append(platformIcon);
        avatarFrame.append(platformBadge);
      }
      platformBadge.className = `player-platform-badge is-${platformProfile.platform}`;
      platformBadge.href = platformProfile.url;
      platformBadge.title = `${platformProfile.label}${platformProfile.id ? `：${platformProfile.id}` : ''} のプロフィールを開く`;
      platformBadge.setAttribute('aria-label', platformBadge.title);
      setImageSourceIfChanged(platformBadge.querySelector('img'), platformProfile.icon);
    } else if (platformBadge) {
      platformBadge.remove();
      platformBadge = null;
    }
    if (avatarFrame) {
      avatarFrame.removeAttribute('tabindex');
      avatarFrame.removeAttribute('role');
      avatarFrame.removeAttribute('aria-label');
      avatarFrame.classList.remove('has-character-matchups');
      avatarFrame.onclick = null;
      avatarFrame.onkeydown = null;
    }
    if (avatarFrame && stats.mainChar && typeof window.openMainCharacterDetails === 'function') {
      let characterReasonButton = avatarFrame.querySelector('.main-character-reason-button');
      if (!characterReasonButton) {
        characterReasonButton = document.createElement('button');
        characterReasonButton.type = 'button';
        characterReasonButton.className = 'main-character-reason-button';
        characterReasonButton.innerHTML = '<img alt=""><span>MAIN CHARACTER</span>';
        avatarFrame.append(characterReasonButton);
      }
      setImageSourceIfChanged(characterReasonButton.querySelector('img'), stats.mainCharImage);
      characterReasonButton.querySelector('img').alt = stats.mainChar ? `${stats.mainChar} icon` : '';
      characterReasonButton.classList.toggle('is-over-player-photo', Boolean(member.photoData));
      characterReasonButton.title = `${stats.mainChar}がメインキャラと判定された根拠を表示`;
      characterReasonButton.setAttribute('aria-label', characterReasonButton.title);
      characterReasonButton.onclick = event => {
        event.preventDefault();
        event.stopPropagation();
        window.openMainCharacterDetails(member, stats);
      };
    }
    const recentMainPanel = box.querySelector('.stats-preview-head');
    if (recentMainPanel) {
      recentMainPanel.removeAttribute('tabindex');
      recentMainPanel.removeAttribute('role');
      recentMainPanel.removeAttribute('aria-label');
      recentMainPanel.classList.remove('has-character-matchups');
      recentMainPanel.onclick = null;
      recentMainPanel.onkeydown = null;
    }
    if (recentMainPanel && stats.mainChar) {
      recentMainPanel.tabIndex = 0;
      recentMainPanel.setAttribute('role', 'button');
      recentMainPanel.setAttribute('aria-label', `${member.name || member.gameId}のキャラ相性を開く`);
      recentMainPanel.classList.add('has-character-matchups');
    }
    if (card) {
      const returnTracking = typeof window.ensureDormantReturnTracking === 'function'
        ? window.ensureDormantReturnTracking(key, member, stats)
        : stats.returnTracking;
      const showReturnBadge = Boolean(
        typeof window.isDormantReturnVisible === 'function'
        && window.isDormantReturnVisible(returnTracking)
      );
      const isLandscapeCard = Boolean(card.closest('.poster-grid.card-layout-landscape'));
      let dormantBadge = card.querySelector('.dormant-player-badge');
      if (dormant && !dormantBadge) {
        dormantBadge = document.createElement('button');
        dormantBadge.type = 'button';
        dormantBadge.className = 'dormant-player-badge';
        dormantBadge.innerHTML = '<span aria-hidden="true">💤</span><small>休眠</small>';
        dormantBadge.title = '休眠判定の活動実績と理由を表示';
      }
      if (dormantBadge && avatarFrame && dormantBadge.parentElement !== avatarFrame) avatarFrame.appendChild(dormantBadge);
      if (dormantBadge) {
        dormantBadge.hidden = !dormant || showReturnBadge;
        dormantBadge.setAttribute('aria-label', `${member.name || member.gameId || 'プレイヤー'}の休眠判定理由を表示`);
        dormantBadge.onclick = event => {
          event.preventDefault();
          event.stopPropagation();
          if (typeof window.openDormantPlayerDetails === 'function') window.openDormantPlayerDetails(member, stats);
        };
      }
      let returnBadge = card.querySelector('.return-player-badge');
      if (showReturnBadge && !isLandscapeCard && !returnBadge) {
        returnBadge = document.createElement('button');
        returnBadge.type = 'button';
        returnBadge.className = 'return-player-badge';
        returnBadge.innerHTML = '<b>おかえり！</b><span></span>';
        returnBadge.title = '復帰を確認した対戦の詳細を表示';
      }
      if (returnBadge && avatarFrame && returnBadge.parentElement !== avatarFrame) avatarFrame.appendChild(returnBadge);
      if (returnBadge) {
        returnBadge.hidden = !showReturnBadge || isLandscapeCard;
        const elapsedDays = typeof window.getDormantReturnElapsedDays === 'function'
          ? window.getDormantReturnElapsedDays(returnTracking) : 0;
        const copy = returnBadge.querySelector('span');
        if (copy) copy.textContent = elapsedDays ? `${elapsedDays}日ぶりに復帰` : 'ランクマッチへ復帰';
        returnBadge.setAttribute('aria-label', `${member.name || member.gameId || 'プレイヤー'}の復帰詳細を表示`);
        returnBadge.onclick = event => {
          event.preventDefault();
          event.stopPropagation();
          if (typeof window.openDormantReturnDetails === 'function') window.openDormantReturnDetails(member, stats);
        };
      }
      card.classList.toggle('is-dormant-player-card', dormant);
      card.classList.toggle('has-recent-ranked-activity', recentRankedActive);
    }
    if (avatarFrame && !member.photoData && stats.mainCharImage) {
      let fallbackImage = avatarFrame.querySelector('.avatar-main-character-fallback');
      if (!fallbackImage) {
        fallbackImage = document.createElement('img');
        fallbackImage.className = 'avatar-main-character-fallback';
        avatarFrame.prepend(fallbackImage);
      }
      setImageSourceIfChanged(fallbackImage, stats.mainCharImage);
      fallbackImage.alt = (stats.mainChar || 'Main character') + ' image';
      avatarFrame.classList.add('uses-main-character-fallback');
      // プロフィール画像未設定時は、現役プレイヤーならキャラクター本来の色を使う。
      // 既存の段位/μが過去参考値扱いの選手だけを、休眠中として落ち着いた暗色にする。
      avatarFrame.classList.toggle('is-dormant-main-character', dormant);
      const initials = avatarFrame.querySelector('.avatar-initials');
      if (initials) initials.hidden = true;
    }
  }
  let queued = false;
  function queueEnhance() { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; document.querySelectorAll('.card-stats-container').forEach(enhanceBox); }); }
  window.refreshVisibleStats = queueEnhance;
  new MutationObserver(queueEnhance).observe(document.body, { childList:true, subtree:true });
  document.addEventListener('pointermove', event => {
    if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    const card = event.target.closest('.poster-card');
    if (!card || !document.body.classList.contains('theme-japanese')) return;
    const rect = card.getBoundingClientRect();
    card.style.setProperty('--t8-foil-x', `${event.clientX - rect.left}px`);
    card.style.setProperty('--t8-foil-y', `${event.clientY - rect.top}px`);
  }, { passive: true });

  let foilTimer = null;
  document.addEventListener('click', event => {
    if (!window.matchMedia('(hover: none), (pointer: coarse)').matches) return;
    const card = event.target.closest('.poster-card');
    if (!card || !document.body.classList.contains('theme-japanese')) return;
    if (event.target.closest('a, button, input, select, textarea, [onclick]')) return;
    const rect = card.getBoundingClientRect();
    card.style.setProperty('--t8-foil-x', `${event.clientX - rect.left}px`);
    card.style.setProperty('--t8-foil-y', `${event.clientY - rect.top}px`);
    document.querySelectorAll('.poster-card.t8-foil-active').forEach(item => item.classList.remove('t8-foil-active'));
    card.classList.add('t8-foil-active');
    clearTimeout(foilTimer);
    foilTimer = setTimeout(() => card.classList.remove('t8-foil-active'), 1800);
  });
  document.addEventListener('click', event => {
    if (!window.matchMedia('(hover: none), (pointer: coarse)').matches) return;
    const card = event.target.closest('.poster-card');
    if (!card || !document.body.classList.contains('theme-modern')) return;
    if (event.target.closest('a, button, input, select, textarea, [onclick]')) return;
    const willActivate = !card.classList.contains('t8-neon-active');
    document.querySelectorAll('.poster-card.t8-neon-active').forEach(item => item.classList.remove('t8-neon-active'));
    if (willActivate) card.classList.add('t8-neon-active');
  });
  window.addEventListener('load', queueEnhance);
  queueEnhance();
  // index.html waits for this before it starts background profile work. This
  // prevents the old inline fetcher from winning a startup race and leaving a
  // card's acquisition state disconnected from the current pipeline.
  window.kentomoStatsIntegrationReady = true;
  window.dispatchEvent(new Event('kentomo:stats-integration-ready'));
})();
