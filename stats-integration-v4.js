(() => {
  const EWGF_PROFILE_WORKER = 'https://tight-bar-55c1.uracil123.workers.dev';
  const WAVU_WORKER = 'https://cold-cherry-2333.uracil123.workers.dev';

  const normalizeCharacter = value => String(value || '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g, '');
  const selectWavuLeaderboardMain = data => {
    const gamesMap = (data && data.qualifiedCharGamesMap) || {};
    const entries = Object.entries(gamesMap).filter(([, games]) => Number.isFinite(Number(games)));
    const selected = entries.sort((a, b) => Number(b[1]) - Number(a[1]))[0];
    const character = selected ? selected[0] : (data && data.mainChar ? data.mainChar : null);
    const ratingMaps = [(data && data.qualifiedCharRatingMap) || {}, (data && data.charRatingMap) || {}];
    let ratingMu = null;
    for (const map of ratingMaps) {
      const match = Object.entries(map).find(([name]) => normalizeCharacter(name) === normalizeCharacter(character));
      if (match && Number.isFinite(Number(match[1]))) { ratingMu = Number(match[1]); break; }
    }
    return { character, ratingMu, leaderboardGames: selected ? Number(selected[1]) : null };
  };
  const findEwgfCharacter = (profile, character) => ((profile && profile.characters) || [])
    .find(item => normalizeCharacter(item.character) === normalizeCharacter(character)) || null;
  const findRankedCharacterStats = (profile, character) => Object.entries((profile && profile.rankedCharacterStats) || {})
    .find(([name]) => normalizeCharacter(name) === normalizeCharacter(character))?.[1] || null;

  fetchEwgfStats = async function(gameId, forceRefresh = false, memberKey = null, isManual = false, targetName = '') {
    const id = cleanTekkenId(gameId);
    const cached = getLocalStats(id);
    // 同じ統合仕様(v9)の正常データは1時間再利用する。旧仕様のキャッシュはsource不一致で自動更新する。
    if (!forceRefresh && cached && cached.statsSource === 'wavu-leaderboard-main+ewgf-profile-v9'
      && Date.now() - (cached.cachedAt || 0) < CACHE_TTL_MS && !cached.isError) {
      return cached;
    }
    recordLastUpdateLog(isManual ? 'manual' : 'auto', targetName);
    try {
      const profileUrl = `${EWGF_PROFILE_WORKER}/?ewgfId=${encodeURIComponent(id)}`;
      const wavuUrl = `${WAVU_WORKER}/?gameId=${encodeURIComponent(id)}`;
      const [profile, wavu] = await Promise.all([
        fetch(profileUrl, { cache: 'no-store' }).then(async r => { const d = await r.json(); if (!r.ok || !d.ok) throw new Error(d.error || `EWGF HTTP ${r.status}`); return d; }),
        fetch(wavuUrl, { cache: 'no-store' }).then(async r => { const d = await r.json(); if (!r.ok) throw new Error(d.error || `Wavu HTTP ${r.status}`); return d; })
      ]);
      const selected = selectWavuLeaderboardMain(wavu);
      const ewgfCharacter = findEwgfCharacter(profile, selected.character);
      if (!selected.character) throw new Error('Wavu Leaderboard main character not found');
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
        mainCharGames:Number(ranked.games) || 0, wins:Number(ranked.wins) || 0, losses:Number(ranked.losses) || 0, rankedWinRate:Number(ranked.winRate), rankedDataVerified:true, leaderboardGames:selected.leaderboardGames,
        danRank:rankIsAllTimeHighest ? allTimeHighestRank : (ewgfCharacter.currentRank || '-'),
        rankIcon:rankIsAllTimeHighest ? historicalRankIcon : currentRankIcon,
        rankIsAllTimeHighest,
        ratingMu:selected.ratingMu !== null ? selected.ratingMu : (cached ? cached.ratingMu : null), ratingCharacter:selected.character,
        tekkenPower:Number(profile.tekkenProwess) || (cached ? cached.tekkenPower : 0) || 0,
        lastSeenTimestamp:ewgfTime || wavuTime || (cached ? cached.lastSeenTimestamp : null),
        totalBattlesFetched:0, statsSource:'wavu-leaderboard-main+ewgf-profile-v9', isError:false, updatedAt:Date.now()
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
    if (stats.statsSource !== 'wavu-leaderboard-main+ewgf-profile-v9' && !pendingIds.has(id)) {
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
