(() => {
  const EWGF_PROFILE_WORKER = 'https://tight-bar-55c1.uracil123.workers.dev';
  const WAVU_WORKER = 'https://cold-cherry-2333.uracil123.workers.dev';

  const normalizeCharacter = value => String(value || '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g, '');
  const findMapValue = (map, character) => {
    const match = Object.entries(map || {}).find(([name]) => normalizeCharacter(name) === normalizeCharacter(character));
    return match && Number.isFinite(Number(match[1])) ? Number(match[1]) : null;
  };
  const selectMainCharacter = (wavu, profile) => {
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
      return { ...ratedCandidates[0], selectionSource: 'wavu-qualified-highest-mu' };
    }

    const lifetimeMain = [...((profile && profile.characters) || [])]
      .filter(character => character && Number.isFinite(Number(character.games)))
      .sort((a, b) => Number(b.games) - Number(a.games))[0] || null;
    return {
      character: lifetimeMain ? lifetimeMain.character : null,
      ratingMu: null,
      leaderboardGames: null,
      selectionSource: lifetimeMain ? 'ewgf-most-lifetime-games' : 'unavailable'
    };
  };
  const findEwgfCharacter = (profile, character) => ((profile && profile.characters) || [])
    .find(item => normalizeCharacter(item.character) === normalizeCharacter(character)) || null;
  const findRankedCharacterStats = (profile, character) => Object.entries((profile && profile.rankedCharacterStats) || {})
    .find(([name]) => normalizeCharacter(name) === normalizeCharacter(character))?.[1] || null;

  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const fetchJsonWithRetry = async (url, { attempts = 1, requireOk = false, label = 'Request' } = {}) => {
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const separator = url.includes('?') ? '&' : '?';
        const response = await fetch(`${url}${separator}attempt=${attempt + 1}&ts=${Date.now()}`, { cache: 'no-store' });
        const text = await response.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch {}
        if (!response.ok || (requireOk && !data?.ok)) {
          const error = new Error(data?.error || `${label} HTTP ${response.status}`);
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
        await wait(700 * (attempt + 1) + Math.floor(Math.random() * 350));
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
  const withEwgfSlot = task => new Promise((resolve, reject) => {
    ewgfRequestQueue.push({ task, resolve, reject });
    drainEwgfQueue();
  });
  fetchEwgfStats = async function(gameId, forceRefresh = false, memberKey = null, isManual = false, targetName = '') {
    const id = cleanTekkenId(gameId);
    const cached = getLocalStats(id);
    // 同じ統合仕様(v12)の正常データは12時間再利用する。旧仕様のキャッシュはsource不一致で自動更新する。
    if (!forceRefresh && cached && cached.statsSource === 'wavu-first-highest-qualified-mu+ewgf-profile-v12'
      && Date.now() - (cached.cachedAt || 0) < CACHE_TTL_MS && !cached.isError) {
      return cached;
    }
    recordLastUpdateLog(isManual ? 'manual' : 'auto', targetName);
    try {
      const profileUrl = `${EWGF_PROFILE_WORKER}/?ewgfId=${encodeURIComponent(id)}${forceRefresh ? '&force=1' : ''}`;
      const wavuUrl = `${WAVU_WORKER}/?gameId=${encodeURIComponent(id)}`;
      const wavu = await fetchJsonWithRetry(wavuUrl, { attempts: 2, label: 'Wavu' });
      const qualifiedSelection = selectMainCharacter(wavu, null);
      const profile = await withEwgfSlot(() => fetchJsonWithRetry(profileUrl, {
        attempts: 3,
        requireOk: true,
        label: 'EWGF'
      }));
      const selected = qualifiedSelection.selectionSource === 'wavu-qualified-highest-mu'
        ? qualifiedSelection
        : selectMainCharacter(wavu, profile);
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
      const allTimeHighestRank = ranked.allTimeHighestRank || profile.highestRank || '';
      const profileHighestMatches = normalizeCharacter(profile.highestRank) === normalizeCharacter(allTimeHighestRank);
      const historicalRankIcon = profileHighestMatches ? (profile.highestRankIcon || '') : '';
      const rankIsAllTimeHighest = !currentRankIcon && Boolean(allTimeHighestRank && historicalRankIcon);
      const rawWavuTime = wavu.latestBattle && wavu.latestBattle.battle_at ? Number(wavu.latestBattle.battle_at) : Number(wavu.latestBattleAt || 0);
      const wavuTime = rawWavuTime ? (rawWavuTime < 1e11 ? rawWavuTime * 1000 : rawWavuTime) : null;
      const parsedEwgfTime = Date.parse(profile.latestBattleAt || '');
      const ewgfTime = Number.isFinite(parsedEwgfTime) ? parsedEwgfTime : null;
      const stats = {
        gameId:id, mainChar:selected.character, mainCharCode:ewgfCharacter.characterCode || '', mainCharImage:ewgfCharacter.characterImage || '',
        mainCharGames:Number(ranked.games) || 0, wins:Number(ranked.wins) || 0, losses:Number(ranked.losses) || 0, rankedWinRate:Number(ranked.winRate), rankedDataVerified:true, leaderboardGames:selected.leaderboardGames, mainSelectionSource:selected.selectionSource,
        danRank:rankIsAllTimeHighest ? allTimeHighestRank : (ewgfCharacter.currentRank || '-'),
        rankIcon:rankIsAllTimeHighest ? historicalRankIcon : currentRankIcon,
        rankIsAllTimeHighest,
        ratingMu:displayedRatingMu, ratingCharacter:selected.character, ratingIsHistorical,
        tekkenPower:Number(profile.tekkenProwess) || (cached ? cached.tekkenPower : 0) || 0,
        lastSeenTimestamp:ewgfTime || wavuTime || (cached ? cached.lastSeenTimestamp : null),
        totalBattlesFetched:0, statsSource:'wavu-first-highest-qualified-mu+ewgf-profile-v12', isError:false, updatedAt:Date.now()
      };
      setLocalStats(id, stats, memberKey);
      queueEnhance();
      return stats;
    } catch (error) {
      console.warn(`Integrated stats fetch failed for ${id}:`, error);
      if (cached) return cached;
      return { gameId:id, mainChar:'取得失敗', mainCharGames:0, danRank:'-', ratingMu:null, tekkenPower:0, lastSeenTimestamp:null, isError:true, updatedAt:Date.now() };
    }
  };

  const pendingIds = new Set();
  function enhanceBox(box) {
    const key = box.id.replace('stats_box_', '');
    const member = window.currentMembersData && window.currentMembersData[key];
    if (!member) return;
    const id = cleanTekkenId(member.gameId);
    const stats = getLocalStats(id, member);
    if (!stats) return;
    box.classList.toggle('is-historical-player', Boolean(stats.rankIsAllTimeHighest || stats.ratingIsHistorical));
    if (stats.statsSource !== 'wavu-first-highest-qualified-mu+ewgf-profile-v12' && !pendingIds.has(id)) {
      pendingIds.add(id);
      fetchEwgfStats(id, false, key, false, member.name || '').finally(() => pendingIds.delete(id));
    }
    const main = box.querySelector('.stats-preview-main');
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
      image.src = stats.mainCharImage || '';
      image.alt = stats.mainChar ? `${stats.mainChar} icon` : '';
      image.hidden = !stats.mainCharImage;
      const name = main.querySelector('.val-main-char'); if (name && name.textContent !== (stats.mainChar || 'Unknown')) name.textContent = stats.mainChar || 'Unknown';
      const games = main.querySelector('.stats-preview-games'); if (games) games.textContent = stats.mainCharGames ? `· ${stats.mainCharGames.toLocaleString()} games` : '';
    }
    const rankValue = box.querySelector('.stats-preview-metric-rank .stats-preview-value');
    if (rankValue) {
      rankValue.classList.add('stats-preview-rank');
      let image = rankValue.querySelector('.stats-preview-rank-icon');
      if (!image) { image = document.createElement('img'); image.className = 'stats-preview-rank-icon'; rankValue.prepend(image); }
      image.src = stats.rankIcon || '';
      image.alt = stats.danRank ? `${stats.danRank} rank icon` : '';
      image.hidden = !stats.rankIcon;
      image.classList.toggle('is-all-time-highest', Boolean(stats.rankIsAllTimeHighest));
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
      ratingValue.classList.toggle('is-historical-rating', Boolean(stats.ratingIsHistorical));
      const numericRating = Number(stats.ratingMu);
      const hasRating = Number.isFinite(numericRating);
      ratingValue.classList.toggle('is-rating-low', hasRating && numericRating < 1500);
      ratingValue.classList.toggle('is-rating-mid', hasRating && numericRating >= 1500 && numericRating < 2000);
      ratingValue.classList.toggle('is-rating-elite', hasRating && numericRating >= 2000);
      ratingValue.title = stats.ratingIsHistorical
        ? (stats.ratingCharacter || stats.mainChar || 'Main character') + '：Leaderboard資格外の過去参考レート'
        : '';
    }
    const card = box.closest('.poster-card');
    const avatarFrame = card && card.querySelector('.avatar-frame');
    if (avatarFrame && !member.photoData && stats.mainCharImage) {
      let fallbackImage = avatarFrame.querySelector('.avatar-main-character-fallback');
      if (!fallbackImage) {
        fallbackImage = document.createElement('img');
        fallbackImage.className = 'avatar-main-character-fallback';
        avatarFrame.prepend(fallbackImage);
      }
      fallbackImage.src = stats.mainCharImage;
      fallbackImage.alt = (stats.mainChar || 'Main character') + ' image';
      avatarFrame.classList.add('uses-main-character-fallback');
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
})();
