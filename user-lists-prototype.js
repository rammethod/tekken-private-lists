(() => {
  let auth = null;
  let activeUser = null;
  let activeListId = null;
  let listsRef = null;
  let listListenerRef = null;
  let settingsLogRef = null;
  let memberSortRef = null;
  let currentMemberSortMode = 'manual';
  let currentMemberSortDirection = 'desc';
  let excludeHistoricalFromSkillSort = false;
  let currentListEntries = [];
  let listOrderDraft = [];
  let listMenuSignature = '';
  let memberRenderSignature = '';
  let vsModeActive = false;
  let vsSelectedKeys = [];

  const createListMenuSignature = entries => JSON.stringify(entries.map(([id, list]) => [
    id,
    String(list.name || ''),
    Number(list.order || 0),
    Number(list.createdAt || 0)
  ]));

  const createMemberRenderSignature = members => JSON.stringify(
    Object.entries(members || {}).sort(([a], [b]) => a.localeCompare(b)).map(([key, member]) => [
      key,
      Object.entries(member || {})
        .filter(([field]) => field !== 'fetchedStats')
        .sort(([a], [b]) => a.localeCompare(b))
    ])
  );

  function updateVsModeView() {
    const button = byId('vsModeToggleBtn');
    if (button) {
      button.classList.toggle('is-active', vsModeActive);
      button.textContent = vsModeActive
        ? (vsSelectedKeys.length >= 2 ? '⚔ VS比較中' : `⚔ 対戦相手を選択 ${vsSelectedKeys.length}/2`)
        : '⚔ VSモード β';
      button.setAttribute('aria-pressed', String(vsModeActive));
    }
    document.body.classList.toggle('vs-mode-active', vsModeActive);
    document.body.classList.toggle('vs-pair-ready', vsModeActive && vsSelectedKeys.length === 2);
    document.querySelectorAll('#posterGrid > .poster-card').forEach(card => {
      const selectionIndex = vsSelectedKeys.indexOf(memberKeyFromCard(card));
      const selected = selectionIndex >= 0;
      card.classList.toggle('vs-selected', vsModeActive && selected);
      card.classList.toggle('vs-dimmed', vsModeActive && vsSelectedKeys.length === 2 && !selected);
      card.setAttribute('aria-pressed', String(vsModeActive && selected));
      let marker = card.querySelector(':scope > .vs-selection-marker');
      if (!marker) {
        marker = document.createElement('span');
        marker.className = 'vs-selection-marker';
        marker.setAttribute('aria-hidden', 'true');
        card.appendChild(marker);
      }
      marker.textContent = selected ? `VS ${selectionIndex + 1}` : '';
      marker.hidden = !(vsModeActive && selected);
    });
  }

  function cleanVsClone(clone) {
    clone.querySelectorAll('[id]').forEach(element => element.removeAttribute('id'));
    clone.removeAttribute('id');
    clone.querySelectorAll('button, a, input, select, textarea').forEach(element => {
      element.tabIndex = -1;
      element.setAttribute('aria-hidden', 'true');
    });
    clone.querySelectorAll('.card-reorder-handle, .card-admin-bar, .list-card-actions').forEach(element => element.remove());
  }

  async function closeVsComparison({ reset = true, animate = true } = {}) {
    const stage = byId('vsComparisonStage');
    if (stage) {
      const clones = [...stage.querySelectorAll('.vs-comparison-card')];
      if (animate && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        await Promise.all(clones.map(clone => {
          const key = clone.dataset.memberKey;
          const source = document.querySelector(`#posterGrid > .poster-card[data-member-key="${CSS.escape(key)}"]`);
          if (!source) return Promise.resolve();
          const from = clone.getBoundingClientRect();
          const to = source.getBoundingClientRect();
          return clone.animate([
            { transform: 'translate3d(0,0,0) scale(1)', opacity: 1 },
            { transform: `translate3d(${to.left - from.left}px,${to.top - from.top}px,0) scale(${to.width / Math.max(from.width, 1)})`, opacity: .25 }
          ], { duration: 360, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' }).finished.catch(() => {});
        }));
      }
      stage.remove();
    }
    document.querySelectorAll('#posterGrid > .poster-card.vs-source-hidden').forEach(card => card.classList.remove('vs-source-hidden'));
    if (reset) {
      vsModeActive = false;
      vsSelectedKeys = [];
      updateVsModeView();
      showToast('VSモードを終了しました');
      const button = byId('vsModeToggleBtn');
      if (button) button.focus();
    }
  }

  function openVsComparison() {
    if (byId('vsComparisonStage') || vsSelectedKeys.length !== 2) return;
    const sources = vsSelectedKeys.map(key => document.querySelector(`#posterGrid > .poster-card[data-member-key="${CSS.escape(key)}"]`));
    if (sources.some(source => !source)) return;
    const sourceRects = sources.map(source => source.getBoundingClientRect());
    const stage = document.createElement('div');
    stage.id = 'vsComparisonStage';
    stage.className = 'vs-comparison-stage';
    stage.setAttribute('role', 'dialog');
    stage.setAttribute('aria-modal', 'true');
    stage.setAttribute('aria-label', '選択した2人のプレイヤーカード比較');
    stage.innerHTML = '<div class="vs-comparison-heading"><strong>⚔ VS COMPARISON <span>β</span></strong><button type="button" class="vs-comparison-close" aria-label="VS比較を終了">×</button></div><div class="vs-comparison-scroll"><div class="vs-comparison-cards"></div></div>';
    const cardsHost = stage.querySelector('.vs-comparison-cards');
    const clones = sources.map((source, index) => {
      const clone = source.cloneNode(true);
      cleanVsClone(clone);
      clone.classList.remove('vs-dimmed', 'vs-source-hidden');
      clone.classList.add('vs-comparison-card', 'vs-selected');
      clone.dataset.memberKey = vsSelectedKeys[index];
      clone.style.setProperty('--rand-deg', '0deg');
      const marker = clone.querySelector('.vs-selection-marker');
      if (marker) { marker.hidden = false; marker.textContent = `VS ${index + 1}`; }
      cardsHost.appendChild(clone);
      const sourceCanvases = source.querySelectorAll('canvas');
      clone.querySelectorAll('canvas').forEach((canvas, canvasIndex) => {
        const sourceCanvas = sourceCanvases[canvasIndex];
        if (!sourceCanvas) return;
        try {
          canvas.width = sourceCanvas.width;
          canvas.height = sourceCanvas.height;
          canvas.getContext('2d').drawImage(sourceCanvas, 0, 0);
        } catch (_) {}
      });
      return clone;
    });
    document.body.appendChild(stage);
    sources.forEach(source => source.classList.add('vs-source-hidden'));
    stage.querySelector('.vs-comparison-close').onclick = () => closeVsComparison();
    stage.addEventListener('click', event => { if (event.target === stage) closeVsComparison(); });
    requestAnimationFrame(() => requestAnimationFrame(() => {
      clones.forEach((clone, index) => {
        const to = clone.getBoundingClientRect();
        const from = sourceRects[index];
        clone.animate([
          { transform: `translate3d(${from.left - to.left}px,${from.top - to.top}px,0) scale(${from.width / Math.max(to.width, 1)})`, opacity: .25 },
          { transform: 'translate3d(0,0,0) scale(1)', opacity: 1 }
        ], { duration: 480, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'both' });
      });
      stage.classList.add('is-visible');
      stage.querySelector('.vs-comparison-close').focus();
    }));
  }

  function toggleVsMode() {
    if (vsModeActive) {
      closeVsComparison();
      return;
    }
    vsModeActive = true;
    vsSelectedKeys = [];
    updateVsModeView();
    showToast('比較したいプレイヤーカードを2枚選んでください');
  }

  function selectVsCard(key) {
    if (!vsModeActive || !key || byId('vsComparisonStage')) return;
    const existingIndex = vsSelectedKeys.indexOf(key);
    if (existingIndex >= 0) vsSelectedKeys.splice(existingIndex, 1);
    else if (vsSelectedKeys.length < 2) vsSelectedKeys.push(key);
    else { vsSelectedKeys.shift(); vsSelectedKeys.push(key); }
    updateVsModeView();
    if (vsSelectedKeys.length === 2) {
      showToast('選択した2枚を中央へ移動します');
      setTimeout(openVsComparison, 120);
    }
  }

  function resetVsMode() {
    closeVsComparison({ reset: false, animate: false });
    vsModeActive = false;
    vsSelectedKeys = [];
    updateVsModeView();
  }

  function beginCardReorder() {
    window.cardReorderInProgress = true;
    window.hasDeferredPosterRender = false;
    delete window.deferredPosterRenderData;
  }

  function endCardReorder() {
    window.cardReorderInProgress = false;
    if (!window.hasDeferredPosterRender) return;
    const latestData = window.deferredPosterRenderData;
    window.hasDeferredPosterRender = false;
    delete window.deferredPosterRenderData;
    renderPosters(latestData);
    setTimeout(addPerCardListActions, 0);
  }
  const byId = id => document.getElementById(id);
  const safeName = value => String(value || '').trim().slice(0, 40);
  const applyActiveListName = name => {
    const safe = safeName(name) || 'マイリスト';
    if (byId('titleText')) byId('titleText').textContent = safe;
    document.title = `${safe} | TEKKEN 8`;
    const select = byId('myListSelect');
    if (select && activeListId) {
      const option = [...select.options].find(item => item.value === activeListId);
      if (option) option.textContent = safe;
    }
  };  const gate = (title, text, mode = 'login') => {
    let root = byId('accessGate');
    if (!root) {
      root = document.createElement('div');
      root.id = 'accessGate';
      root.className = 'access-gate';
      document.body.appendChild(root);
    }
    root.hidden = false;
    const uid = activeUser ? activeUser.uid : '';
    root.innerHTML = `<section class="access-panel">
      <h2>${title}</h2><p>${text}</p>
      ${mode === 'pending' ? `<p class="uid">${uid}</p><p><button class="access-action secondary" id="copyUid">UIDをコピー</button></p>` : ''}
      <button class="access-action" id="gateAction">${mode === 'login' ? 'Googleでログイン' : 'ログアウト'}</button>
      ${mode === 'login' ? '<button class="access-action secondary" id="adminGateAction">Googleで管理者ログイン</button>' : ''}
    </section>`;
    byId('gateAction').onclick = mode === 'login' ? signIn : () => auth.signOut();
    if (byId('adminGateAction')) byId('adminGateAction').onclick = () => window.openAdminLogin();
    if (byId('copyUid')) byId('copyUid').onclick = () => navigator.clipboard.writeText(uid).then(() => showToast('UIDをコピーしました'));
  };

  function hideGate() {
    const root = byId('accessGate');
    if (root) root.hidden = true;
  }

  async function signIn() {
    sessionStorage.removeItem('t8_admin_mode');
    if (!/^https?:$/.test(location.protocol)) {
      gate('HTTPで開いてください', 'Googleログインはファイルの直接表示では利用できません。同じフォルダーの start-user-lists-prototype.cmd から起動してください。', 'login');
      return;
    }
    try {
      await auth.signInWithPopup(new firebase.auth.GoogleAuthProvider());
    } catch (error) {
      if (error && error.code === 'auth/configuration-not-found') {
        gate('Firebase Authenticationの設定が必要です', 'Firebase Consoleで Authentication を開始し、ログイン方法の Google を有効化して保存してください。設定後、このページを再読み込みします。', 'login');
        return;
      }
      if (error && error.code === 'auth/unauthorized-domain') {
        gate('localhostの許可が必要です', 'Firebase Authentication の承認済みドメインへ localhost を追加してください。', 'login');
        return;
      }
      gate('ログインできませんでした', error.message, 'login');
    }
  }

  // Tekken 8 rank order (Season 1 base + Season 2 destruction ranks).
  // References: https://tekken.fandom.com/wiki/Tekken_8/Ranking_List
  // Official S2 names: https://en.bandainamcoent.eu/tekken/news/tekken-8-patch-20
  const MEMBER_SORT_RANKS = ['Beginner','1st Dan','2nd Dan','Fighter','Strategist','Combatant','Brawler','Ranger','Cavalry','Warrior','Assailant','Dominator','Vanquisher','Destroyer','Eliminator','Garyu','Shinryu','Tenryu','Mighty Ruler','Flame Ruler','Battle Ruler','Fujin','Raijin','Kishin','Bushin','Tekken King','Tekken Emperor','Tekken God','Tekken God Supreme','God of Destruction','God of Destruction I','God of Destruction II','God of Destruction III','God of Destruction IV','God of Destruction V','God of Destruction VI','God of Destruction VII','God of Destruction Infinity'];
  const normalizedRankIndex = value => {
    const raw = String(value || '').trim();
    const normalized = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (normalized === 'tekkenlordsupreme') return 28;
    if (normalized === 'tekkenlord') return 27;
    const destructionMatch = normalized.match(/(?:god|lord)ofdestruction(?:(infinity|ouroboros)|([1-7])|(vii|vi|iv|v|iii|ii|i))?$/);
    if (destructionMatch) {
      if (raw.includes('∞') || destructionMatch[1]) return 37;
      const suffix = destructionMatch[2] || destructionMatch[3] || '';
      const destructionLevel = { '': 0, '1': 1, i: 1, '2': 2, ii: 2, '3': 3, iii: 3, '4': 4, iv: 4, '5': 5, v: 5, '6': 6, vi: 6, '7': 7, vii: 7 }[suffix];
      return destructionLevel === undefined ? -1 : 29 + destructionLevel;
    }
    return MEMBER_SORT_RANKS.slice(0, 29).findIndex(rank => rank.toLowerCase().replace(/[^a-z0-9]/g, '') === normalized);
  };
  function memberStats(member) {
    const id = typeof cleanTekkenId === 'function' ? cleanTekkenId(member && member.gameId) : String(member && member.gameId || '');
    if (typeof getLocalStats === 'function') return getLocalStats(id, member) || member.fetchedStats || {};
    return member.fetchedStats || {};
  }
  window.sortMemberEntries = entries => {
    window.memberSkillRanks = {};
    window.memberSkillRankValues = {};
    if (currentMemberSortMode === 'manual') return entries;
    const direction = currentMemberSortDirection === 'asc' ? 1 : -1;
    const collator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });
    const metric = member => {
      const stats = memberStats(member || {});
      const isHistorical = Boolean(stats.rankIsAllTimeHighest || stats.ratingIsHistorical);
      if (excludeHistoricalFromSkillSort && isHistorical && ['rank','games','rating','winrate','power','pentagon_attack','pentagon_technique','pentagon_appeal','pentagon_spirit','pentagon_defense'].includes(currentMemberSortMode)) return null;
      if (currentMemberSortMode === 'name') return String(member && member.name || '');
      if (currentMemberSortMode === 'rank') return normalizedRankIndex(stats.danRank);
      if (currentMemberSortMode === 'games') return stats.mainCharGames === null || stats.mainCharGames === undefined ? null : Number(stats.mainCharGames);
      if (currentMemberSortMode === 'winrate') return stats.rankedWinRate === null || stats.rankedWinRate === undefined ? null : Number(stats.rankedWinRate);
      if (currentMemberSortMode === 'rating') return stats.ratingMu === null || stats.ratingMu === undefined ? null : Number(stats.ratingMu);
      if (currentMemberSortMode === 'power') return stats.tekkenPower === null || stats.tekkenPower === undefined ? null : Number(stats.tekkenPower);
      const pentagonKey = currentMemberSortMode.startsWith('pentagon_') ? currentMemberSortMode.slice('pentagon_'.length) : '';
      if (pentagonKey) {
        const value = stats.statPentagon && stats.statPentagon[pentagonKey];
        return value === null || value === undefined ? null : Number(value);
      }
      return null;
    };
    const decorated = entries.map((entry, index) => ({ entry, index, value: metric(entry[1]) }));
    const isMissing = item => item.value === null || item.value === '' || (typeof item.value === 'number' && (!Number.isFinite(item.value) || item.value < 0));
    const skillModes = ['rank','games','rating','winrate','power','pentagon_attack','pentagon_technique','pentagon_appeal','pentagon_spirit','pentagon_defense'];
    if (skillModes.includes(currentMemberSortMode)) {
      decorated.filter(item => !isMissing(item)).sort((a, b) => Number(b.value) - Number(a.value) || a.index - b.index).slice(0, 3).forEach((item, index) => {
        window.memberSkillRanks[item.entry[0]] = index + 1;
        window.memberSkillRankValues[item.entry[0]] = item.value;
      });
    }
    return decorated.sort((a, b) => {
      const aMissing = isMissing(a);
      const bMissing = isMissing(b);
      if (aMissing !== bMissing) return aMissing ? 1 : -1;
      const compared = typeof a.value === 'string' ? collator.compare(a.value, b.value) : Number(a.value) - Number(b.value);
      return compared ? compared * direction : a.index - b.index;
    }).map(item => item.entry);
  };
  function formatSkillRankValue(mode, value, member) {
    if (value === null || value === undefined || value === '') return '-';
    const numeric = Number(value);
    if (mode === 'rank') return String(memberStats(member || {}).danRank || '-');
    if (mode === 'games') return Number.isFinite(numeric) ? numeric.toLocaleString() + ' games' : '-';
    if (mode === 'rating') return Number.isFinite(numeric) ? 'μ ' + numeric : '-';
    if (mode === 'winrate') return Number.isFinite(numeric) ? numeric.toFixed(1) + '%' : '-';
    if (mode === 'power') return Number.isFinite(numeric) ? numeric.toLocaleString() : '-';
    if (mode.startsWith('pentagon_')) return Number.isFinite(numeric) ? String(Math.round(numeric)) : '-';
    return String(value);
  }
  const memberSortStorageKey = () => activeUser && activeListId
    ? `t8_member_sort_${activeUser.uid}_${activeListId}`
    : '';
  function readLocalMemberSort() {
    try {
      const raw = localStorage.getItem(memberSortStorageKey());
      return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
  }
  function writeLocalMemberSort(mode, direction) {
    try { localStorage.setItem(memberSortStorageKey(), JSON.stringify({ mode, direction, excludeHistorical: excludeHistoricalFromSkillSort })); } catch (_) {}
  }
  async function persistMemberSortSetting(mode, direction) {
    writeLocalMemberSort(mode, direction);
    if (!settingsRef) return;
    try {
      await settingsRef.child('memberSort').set({ mode, direction, excludeHistorical: excludeHistoricalFromSkillSort });
    } catch (error) {
      console.warn('Firebase memberSort sync unavailable; using list-local setting:', error);
    }
  }

  function updateCardReorderHandles() {
    const isManual = currentMemberSortMode === 'manual';
    document.querySelectorAll('.card-reorder-handle').forEach(handle => {
      handle.hidden = !isManual;
      handle.disabled = !isManual;
      handle.setAttribute('aria-hidden', String(!isManual));
      handle.tabIndex = isManual ? 0 : -1;
    });
  }

  const MEMBER_SORT_SHORT_LABELS = {
    manual: '手動', name: '名前', rank: '段位', games: '試合数',
    rating: 'レート', winrate: '勝率', power: '鉄拳力',
    pentagon_attack: '攻撃', pentagon_technique: '技術', pentagon_appeal: '魅力',
    pentagon_spirit: '精神', pentagon_defense: '防御'
  };

  function updateMemberSortControls() {
    const mode = byId('memberSortMode');
    const direction = byId('memberSortDirection');
    const excludeHistorical = byId('memberSortExcludeHistorical');
    if (mode) mode.value = currentMemberSortMode;
    const summaryLabel = byId('memberSortSummaryLabel');
    if (summaryLabel) summaryLabel.textContent = MEMBER_SORT_SHORT_LABELS[currentMemberSortMode] || '手動';
    const listSummary = byId('listActionsSummary');
    if (listSummary) listSummary.setAttribute('aria-label', 'リスト設定メニュー。現在の並べ替え：' + (MEMBER_SORT_SHORT_LABELS[currentMemberSortMode] || '手動'));
    if (excludeHistorical) excludeHistorical.checked = excludeHistoricalFromSkillSort;
    if (direction) {
      direction.disabled = currentMemberSortMode === 'manual';
      direction.textContent = currentMemberSortDirection === 'asc' ? '昇順 ↑' : '降順 ↓';
    }
    updateCardReorderHandles();
  }
  async function saveMemberSort(mode, direction = currentMemberSortDirection) {
    currentMemberSortMode = mode || 'manual';
    currentMemberSortDirection = direction === 'asc' ? 'asc' : 'desc';
    window.memberAutoSortActive = currentMemberSortMode !== 'manual';
    updateMemberSortControls();
    if (window.currentMembersData) { renderPosters(window.currentMembersData); setTimeout(addPerCardListActions, 0); }
    await persistMemberSortSetting(currentMemberSortMode, currentMemberSortDirection);
  }
  function disableAutoSortForManualReorder() {
    if (currentMemberSortMode === 'manual') return;
    currentMemberSortMode = 'manual';
    window.memberAutoSortActive = false;
    updateMemberSortControls();
    persistMemberSortSetting('manual', currentMemberSortDirection);
    showToast('ドラッグ操作のため手動順へ切り替えました');
  }

  const GRID_COLUMNS_AUTO = 'auto';
  const gridStorageKey = () => window.matchMedia('(max-width: 700px)').matches
    ? 't8_grid_columns_mobile'
    : 't8_grid_columns_desktop';
  function syncMobileCardScale() {
    const grid = byId('posterGrid');
    if (!grid) return;
    if (window.mobileCardResizeObserver) window.mobileCardResizeObserver.disconnect();
    const scale = Number(grid.style.getPropertyValue('--mobile-card-scale'));
    const active = Boolean(grid.dataset.mobileFitColumns) && Number.isFinite(scale) && scale > 0 && scale < 1;
    grid.querySelectorAll(':scope > .poster-card').forEach(card => {
      if (!active) {
        card.style.removeProperty('--mobile-card-height-offset');
        return;
      }
      const unscaledHeight = card.offsetHeight;
      card.style.setProperty('--mobile-card-height-offset', `${-Math.max(0, unscaledHeight * (1 - scale))}px`);
    });
    if (!active || typeof ResizeObserver !== 'function') return;
    window.mobileCardResizeObserver = new ResizeObserver(entries => {
      const currentScale = Number(grid.style.getPropertyValue('--mobile-card-scale'));
      if (!Number.isFinite(currentScale) || currentScale <= 0 || currentScale >= 1) return;
      entries.forEach(entry => {
        const card = entry.target;
        card.style.setProperty('--mobile-card-height-offset', `${-Math.max(0, card.offsetHeight * (1 - currentScale))}px`);
      });
    });
    grid.querySelectorAll(':scope > .poster-card').forEach(card => window.mobileCardResizeObserver.observe(card));
  }
  function applyGridColumns(value) {
    const grid = byId('posterGrid');
    if (!grid) return;
    const app = grid.closest('.app-container');
    const normalized = /^[1-5]$/.test(String(value)) ? String(value) : GRID_COLUMNS_AUTO;
    grid.style.zoom = '';
    grid.style.width = '';
    grid.style.marginInline = '';
    grid.style.removeProperty('--mobile-card-scale');
    grid.style.removeProperty('--mobile-card-base-width');
    grid.dataset.mobileFitColumns = '';
    if (normalized === GRID_COLUMNS_AUTO) {
      grid.style.gridTemplateColumns = '';
      grid.style.justifyContent = '';
      if (app) { app.style.width = ''; app.style.maxWidth = ''; }
    } else {
      const columns = Number(normalized);
      const mobileLayout = window.matchMedia('(max-width: 640px)').matches;
      if (mobileLayout) {
        const gap = 8;
        const availableWidth = Math.max(260, window.innerWidth - 28);
        const trackWidth = (availableWidth - Math.max(0, columns - 1) * gap) / columns;
        const cardWidth = columns === 1 ? Math.min(300, trackWidth) : 165;
        const cardScale = Math.min(1, (trackWidth / cardWidth) * (columns >= 3 ? 0.94 : 0.98));
        grid.style.gridTemplateColumns = `repeat(${columns}, ${trackWidth}px)`;
        grid.style.justifyContent = 'start';
        grid.style.width = `${availableWidth}px`;
        grid.style.marginInline = 'auto';
        grid.style.setProperty('--mobile-card-scale', String(cardScale));
        grid.style.setProperty('--mobile-card-base-width', `${cardWidth}px`);
        grid.dataset.mobileFitColumns = normalized;
        if (app) {
          app.style.width = `${Math.max(280, window.innerWidth - 12)}px`;
          app.style.maxWidth = 'calc(100vw - 12px)';
        }
      } else {
        const cardWidth = 300;
        const gap = 28;
        const boardChrome = 84;
        const naturalWidth = columns * cardWidth + Math.max(0, columns - 1) * gap + boardChrome;
        const viewportFloor = Math.min(1080, Math.max(280, window.innerWidth - 40));
        grid.style.gridTemplateColumns = `repeat(${columns}, ${cardWidth}px)`;
        grid.style.justifyContent = 'center';
        if (app) {
          app.style.width = `${Math.max(naturalWidth, viewportFloor)}px`;
          app.style.maxWidth = 'none';
        }
      }
    }
    requestAnimationFrame(syncMobileCardScale);
    const select = byId('gridColumnSelect');
    if (select && select.value !== normalized) select.value = normalized;
  }
  function restoreGridColumns() {
    let saved = GRID_COLUMNS_AUTO;
    try { saved = localStorage.getItem(gridStorageKey()) || GRID_COLUMNS_AUTO; } catch (_) {}
    applyGridColumns(saved);
  }
  function saveGridColumns(value) {
    try { localStorage.setItem(gridStorageKey(), value); } catch (_) {}
    applyGridColumns(value);
  }

  function injectWorkspace() {
    if (byId('listWorkspace')) return;
    const bar = document.createElement('nav');
    bar.id = 'listWorkspace';
    bar.className = 'list-workspace';
    bar.setAttribute('aria-label', 'マイリスト管理');
    bar.innerHTML = `
      <div class="workspace-primary">
        <select id="myListSelect" aria-label="表示するマイリスト"></select>
        <button id="workspaceAddMemberBtn" class="workspace-primary-action" title="メンバーを追加">＋ <span>メンバー追加</span></button>
<div class="workspace-refresh-control">
          <button id="workspaceRefreshBtn" title="EWGF・Wavuから全員の最新データを取得">
            <span aria-hidden="true">↻</span><span>全員のデータ更新</span>
          </button>
          <small>EWGF・Wavuから取得／登録人数分の通信あり</small>
        </div>
      </div>
      <details class="workspace-dropdown" id="listActionsMenu">
        <summary id="listActionsSummary" aria-label="リスト設定メニュー。現在の並べ替え：手動" title="リスト設定"><span class="workspace-menu-settings-icon" aria-hidden="true">⚙</span><span class="workspace-menu-title"><span class="workspace-menu-title-full">リスト設定</span><span class="workspace-menu-title-short">設定</span></span><span class="workspace-sort-separator">/</span><span id="memberSortSummaryLabel">手動</span></summary>
        <div class="workspace-menu" role="menu">
          <button id="newListBtn" role="menuitem">＋ 新しいリスト</button>
          <button id="renameListBtn" role="menuitem">リスト名を変更</button>
          <button id="reorderListsBtn" role="menuitem">↕ リストの並び替え</button>
          <button id="shareListBtn" role="menuitem">このリストを共有</button>
          <button id="importListBtn" role="menuitem">共有・バックアップ取込</button>
          <button id="exportListBtn" role="menuitem">全バックアップ</button>
          <span class="workspace-menu-label">メンバー自動並べ替え</span>
          <div class="member-sort-setting">
            <select id="memberSortMode" aria-label="メンバーの並べ替え基準">
              <option value="manual">手動順</option><option value="name">あいうえお順</option>
              <option value="rank">メインキャラ段位順</option><option value="games">メインキャラ試合数順</option>
              <option value="rating">レート順</option><option value="winrate">メインキャラ勝率順</option><option value="power">鉄拳力順</option>
              <option value="pentagon_attack">ペンタゴン・攻撃順</option><option value="pentagon_technique">ペンタゴン・技術順</option>
              <option value="pentagon_appeal">ペンタゴン・魅力順</option><option value="pentagon_spirit">ペンタゴン・精神順</option><option value="pentagon_defense">ペンタゴン・防御順</option>
            </select>
            <button type="button" id="memberSortDirection">降順 ↓</button>
          </div>
          <label class="member-sort-option"><input type="checkbox" id="memberSortExcludeHistorical"> 最近対戦のない選手を試合数・腕前・ペンタゴン順から除外</label>
          <button id="deleteListBtn" class="menu-danger" role="menuitem">リストを削除</button>
        </div>
      </details>
      <input id="importListFile" type="file" accept="application/json" hidden>
      <dialog class="list-order-dialog" id="listOrderDialog">
        <div class="list-order-panel">
          <div class="list-order-heading">
            <div><strong>マイリストの並び替え</strong><small>PCはドラッグ、スマホは矢印で移動</small></div>
            <button type="button" id="closeListOrderBtn" aria-label="閉じる">×</button>
          </div>
          <ol class="list-order-items" id="listOrderItems"></ol>
          <div class="list-order-footer">
            <button type="button" id="cancelListOrderBtn">キャンセル</button>
            <button type="button" id="saveListOrderBtn" class="workspace-primary-action">並び順を保存</button>
          </div>
        </div>
      </dialog>
      <dialog class="main-character-logic-dialog" id="mainCharacterLogicDialog" aria-labelledby="mainCharacterLogicTitle">
        <div class="main-character-logic-panel">
          <div class="main-character-logic-heading">
            <div><strong id="mainCharacterLogicTitle">メインキャラはどう決まる？</strong><small>強さを優先し、信頼できるデータがない場合はやり込み量で判定します</small></div>
            <button type="button" id="closeMainCharacterLogicBtn" aria-label="閉じる">×</button>
          </div>
          <ol class="main-character-logic-steps">
            <li><span>1</span><div><strong>Wavuの信頼できる候補に絞る</strong><p>Leaderboardの <b>σ² &lt; 75</b> に入っているキャラを候補にします。σ²はレーティングの不確かさで、小さいほど判定材料が十分にある状態です。</p></div></li>
            <li><span>2</span><div><strong>μが最も高いキャラを選ぶ</strong><p>候補の中で、Wavuの推定レーティング <b>μ</b> が一番高いキャラをメインと判定します。別キャラの試合数が多くても、μの高さを優先します。</p></div></li>
            <li><span>3</span><div><strong>μが同じなら試合数で決める</strong><p>最高μが同率の場合だけ、Leaderboard内の試合数が多いキャラを優先します。</p></div></li>
            <li><span>4</span><div><strong>候補がいなければ生涯データへ</strong><p>σ² &lt; 75 の候補がいない場合は、EWGFで生涯試合数が最も多いキャラをメインと判定します。</p></div></li>
          </ol>
          <div class="main-character-logic-note"><strong>表示データについて</strong><p>メインキャラ決定後、そのキャラの段位・All-time Ranked試合数・勝率・画像をEWGFから取得します。Leaderboard資格外のμは「※」付きの過去参考値として表示します。自動更新は12時間ごとで、必要なときは「全員のデータ更新」から手動更新できます。</p></div>
          <div class="main-character-logic-footer"><button type="button" id="dismissMainCharacterLogicBtn" class="workspace-primary-action">閉じる</button></div>
        </div>
      </dialog>
      <details class="workspace-dropdown workspace-account" id="accountMenu">
        <summary><span class="user-chip" id="userChip"></span><span aria-hidden="true">▾</span></summary>
        <div class="workspace-menu" role="menu">
          <span class="workspace-menu-label">表示テーマ</span>
          <div class="theme-menu-row">
            <button type="button" data-theme-choice="wanted" title="WANTED">酒場</button>
            <button type="button" data-theme-choice="modern" title="MODERN">ネオン</button>
            <button type="button" data-theme-choice="japanese" title="JAPANESE">和風</button>
          </div>
          <span class="workspace-menu-label">カード列数</span>
          <div class="grid-column-setting">
            <select id="gridColumnSelect" aria-label="カードの表示列数">
              <option value="auto">自動（おすすめ）</option>
              <option value="1">1列</option><option value="2">2列</option><option value="3">3列</option>
              <option value="4">4列</option><option value="5">5列</option>
            </select>
            <small>PCは幅を維持／スマホは画面内へ縮小</small>
          </div>
          <button id="mainCharacterLogicBtn" role="menuitem">？ メインキャラ判定について</button>
          <button id="adminPanelBtn" role="menuitem" hidden>ユーザー承認</button>
          <button id="logoutBtn" role="menuitem">ログアウト</button>
        </div>
      </details>`;
    document.querySelector('.board-container').prepend(bar);
    document.body.classList.add('workspace-ui-active');
    byId('userChip').textContent = activeUser.displayName || activeUser.email || 'Google User';
    const closeWorkspaceMenus = () => bar.querySelectorAll('details[open]').forEach(menu => menu.removeAttribute('open'));
    const positionWorkspaceMenu = details => {
      const menu = details && details.querySelector('.workspace-menu');
      if (!menu) return;
      if (!window.matchMedia('(max-width: 700px)').matches) {
        menu.style.top = ''; menu.style.bottom = ''; menu.style.maxHeight = '';
        return;
      }
      const trigger = details.querySelector('summary');
      const rect = trigger.getBoundingClientRect();
      const top = Math.min(rect.bottom + 7, window.innerHeight - 56);
      menu.style.top = `${Math.max(8, top)}px`;
      menu.style.bottom = 'auto';
      menu.style.maxHeight = `${Math.max(48, window.innerHeight - Math.max(8, top) - 8)}px`;
    };
    const repositionOpenWorkspaceMenus = () => bar.querySelectorAll('.workspace-dropdown[open]').forEach(positionWorkspaceMenu);
    bar.querySelectorAll('.workspace-dropdown').forEach(details => details.addEventListener('toggle', () => {
      if (!details.open) return;
      bar.querySelectorAll('.workspace-dropdown[open]').forEach(other => {
        if (other !== details) other.removeAttribute('open');
      });
      requestAnimationFrame(() => positionWorkspaceMenu(details));
    }));
    if (window.workspaceMenuPositionHandler) {
      window.removeEventListener('resize', window.workspaceMenuPositionHandler);
      window.removeEventListener('scroll', window.workspaceMenuPositionHandler);
    }
    window.workspaceMenuPositionHandler = repositionOpenWorkspaceMenus;
    window.addEventListener('resize', repositionOpenWorkspaceMenus, { passive: true });
    window.addEventListener('scroll', repositionOpenWorkspaceMenus, { passive: true });
    byId('myListSelect').onchange = event => activateList(event.target.value);
    byId('gridColumnSelect').onchange = event => saveGridColumns(event.target.value);
    restoreGridColumns();
    if (window.workspaceGridResizeHandler) window.removeEventListener('resize', window.workspaceGridResizeHandler);
    let lastGridViewportWidth = window.innerWidth;
    window.workspaceGridResizeHandler = () => {
      const nextWidth = window.innerWidth;
      if (Math.abs(nextWidth - lastGridViewportWidth) < 2) return;
      lastGridViewportWidth = nextWidth;
      restoreGridColumns();
    };
    window.addEventListener('resize', window.workspaceGridResizeHandler, { passive: true });
    byId('workspaceAddMemberBtn').onclick = () => openAddModal();
    byId('workspaceRefreshBtn').onclick = async event => {
      const button = event.currentTarget;
      if (button.disabled) return;
      button.disabled = true;
      try {
        await refreshAllWavuStats();
      } finally {
        button.disabled = false;
      }
    };
    byId('newListBtn').onclick = () => { closeWorkspaceMenus(); createList(); };
    byId('renameListBtn').onclick = () => { closeWorkspaceMenus(); renameList(); };
    byId('reorderListsBtn').onclick = () => { closeWorkspaceMenus(); openListOrderDialog(); };
    byId('deleteListBtn').onclick = () => { closeWorkspaceMenus(); deleteList(); };
    byId('shareListBtn').onclick = () => { closeWorkspaceMenus(); exportSharedList(); };
    byId('exportListBtn').onclick = () => { closeWorkspaceMenus(); exportList(); };
    byId('importListBtn').onclick = () => { closeWorkspaceMenus(); byId('importListFile').click(); };
    byId('importListFile').onchange = importList;
    const vsButton = byId('vsModeToggleBtn');
    if (vsButton) vsButton.onclick = toggleVsMode;
    const posterGrid = byId('posterGrid');
    if (posterGrid && !posterGrid.dataset.vsDelegated) {
      posterGrid.dataset.vsDelegated = 'true';
      posterGrid.addEventListener('click', event => {
        if (!vsModeActive || byId('vsComparisonStage') || event.target.closest('button, a, input, select, textarea, label, .id-box')) return;
        const card = event.target.closest('.poster-card');
        if (card && card.parentElement === posterGrid) selectVsCard(memberKeyFromCard(card));
      });
    }
    if (!document.body.dataset.vsEscapeBound) {
      document.body.dataset.vsEscapeBound = 'true';
      document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && (vsModeActive || byId('vsComparisonStage'))) closeVsComparison();
      });
    }
    byId('memberSortMode').onchange = event => saveMemberSort(event.target.value);
    byId('memberSortDirection').onclick = () => saveMemberSort(currentMemberSortMode, currentMemberSortDirection === 'asc' ? 'desc' : 'asc');
    byId('memberSortExcludeHistorical').onchange = event => { excludeHistoricalFromSkillSort = event.target.checked; saveMemberSort(currentMemberSortMode, currentMemberSortDirection); };
    updateMemberSortControls();
    byId('closeListOrderBtn').onclick = closeListOrderDialog;
    byId('cancelListOrderBtn').onclick = closeListOrderDialog;
    byId('saveListOrderBtn').onclick = saveListOrder;
    byId('listOrderDialog').addEventListener('click', event => {
      if (event.target === byId('listOrderDialog')) closeListOrderDialog();
    });
    byId('mainCharacterLogicBtn').onclick = () => {
      closeWorkspaceMenus();
      byId('mainCharacterLogicDialog').showModal();
    };
    const closeMainCharacterLogic = () => byId('mainCharacterLogicDialog').close();
    byId('closeMainCharacterLogicBtn').onclick = closeMainCharacterLogic;
    byId('dismissMainCharacterLogicBtn').onclick = closeMainCharacterLogic;
    byId('mainCharacterLogicDialog').addEventListener('click', event => {
      if (event.target === byId('mainCharacterLogicDialog')) closeMainCharacterLogic();
    });
    byId('listOrderItems').addEventListener('click', event => {
      const button = event.target.closest('[data-list-move]');
      if (!button) return;
      moveListOrder(button.closest('[data-list-id]').dataset.listId, Number(button.dataset.listMove));
    });
    byId('listOrderItems').addEventListener('dragstart', event => {
      const row = event.target.closest('[data-list-id]');
      if (!row) return;
      row.classList.add('is-dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', row.dataset.listId);
    });
    byId('listOrderItems').addEventListener('dragend', event => {
      event.target.closest('[data-list-id]')?.classList.remove('is-dragging');
    });
    byId('listOrderItems').addEventListener('dragover', event => {
      if (event.target.closest('[data-list-id]')) event.preventDefault();
    });
    byId('listOrderItems').addEventListener('drop', event => {
      const target = event.target.closest('[data-list-id]');
      const sourceId = event.dataTransfer.getData('text/plain');
      if (!target || !sourceId || sourceId === target.dataset.listId) return;
      event.preventDefault();
      moveListOrderTo(sourceId, target.dataset.listId, event.clientY > target.getBoundingClientRect().top + target.offsetHeight / 2);
    });
    bar.querySelectorAll('[data-theme-choice]').forEach(button => {
      button.onclick = () => {
        const theme = button.dataset.themeChoice;
        byId('themeSelectDropdown').value = theme;
        selectTheme(theme);
        closeWorkspaceMenus();
      };
    });
    byId('logoutBtn').onclick = () => { closeWorkspaceMenus(); auth.signOut(); };
    if (window.workspaceOutsideClickHandler) {
      document.removeEventListener('click', window.workspaceOutsideClickHandler);
    }
    window.workspaceOutsideClickHandler = event => {
      if (!bar.contains(event.target)) closeWorkspaceMenus();
    };
    document.addEventListener('click', window.workspaceOutsideClickHandler);
  }

  function bindSharedStatus() {
    db.ref('.info/connected').on('value', snap => {
      byId('statusDot').classList.toggle('offline', snap.val() !== true);
      byId('statusText').textContent = snap.val() === true ? 'PRIVATE ONLINE' : 'OFFLINE';
    });
    updateLastUpdateLogBadge();
  }

  function renderListOrderItems() {
    const root = byId('listOrderItems');
    if (!root) return;
    root.innerHTML = listOrderDraft.map((item, index) => `
      <li draggable="true" data-list-id="${item.id}" class="${item.id === activeListId ? 'is-active' : ''}">
        <span class="list-order-grip" aria-hidden="true">⠿</span>
        <span class="list-order-name">${escapeHtml(item.name || '名称未設定')}</span>
        <span class="list-order-current">${item.id === activeListId ? '表示中' : ''}</span>
        <button type="button" data-list-move="-1" aria-label="上へ" ${index === 0 ? 'disabled' : ''}>↑</button>
        <button type="button" data-list-move="1" aria-label="下へ" ${index === listOrderDraft.length - 1 ? 'disabled' : ''}>↓</button>
      </li>`).join('');
  }

  function openListOrderDialog() {
    listOrderDraft = currentListEntries.map(item => ({ ...item }));
    renderListOrderItems();
    byId('listOrderDialog').showModal();
  }

  function closeListOrderDialog() {
    byId('listOrderDialog')?.close();
  }

  function moveListOrder(listId, direction) {
    const from = listOrderDraft.findIndex(item => item.id === listId);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= listOrderDraft.length) return;
    const [item] = listOrderDraft.splice(from, 1);
    listOrderDraft.splice(to, 0, item);
    renderListOrderItems();
  }

  function moveListOrderTo(sourceId, targetId, after) {
    const from = listOrderDraft.findIndex(item => item.id === sourceId);
    if (from < 0) return;
    const [item] = listOrderDraft.splice(from, 1);
    let to = listOrderDraft.findIndex(entry => entry.id === targetId);
    if (to < 0) return;
    if (after) to += 1;
    listOrderDraft.splice(to, 0, item);
    renderListOrderItems();
  }

  async function saveListOrder() {
    const button = byId('saveListOrderBtn');
    button.disabled = true;
    try {
      const updates = {};
      listOrderDraft.forEach((item, index) => { updates[`${item.id}/order`] = (index + 1) * 1000; });
      await listsRef.update(updates);
      closeListOrderDialog();
      showToast('マイリストの並び順を保存しました');
    } catch (error) {
      showToast(`並び順の保存に失敗しました: ${error.message}`);
    } finally {
      button.disabled = false;
    }
  }
  function subscribeLists() {
    listsRef.on('value', async snapshot => {
      const lists = snapshot.val() || {};
      const entries = Object.entries(lists).sort((a, b) => (a[1].order || 0) - (b[1].order || 0));
      currentListEntries = entries.map(([id, list]) => ({ id, name: list.name || '名称未設定' }));
      const nextListMenuSignature = createListMenuSignature(entries);
      if (nextListMenuSignature === listMenuSignature) return;
      listMenuSignature = nextListMenuSignature;
      if (!entries.length) {
        const ref = listsRef.push();
        await ref.set({ name: 'マイリスト 1', order: Date.now(), createdAt: firebase.database.ServerValue.TIMESTAMP });
        return;
      }
      const select = byId('myListSelect');
      select.innerHTML = entries.map(([id, list]) => `<option value="${id}">${escapeHtml(list.name || '名称未設定')}</option>`).join('');
      let desiredListId = lists[activeListId]
        ? activeListId
        : (localStorage.getItem(`active_list_${activeUser.uid}`) || entries[0][0]);
      if (!lists[desiredListId]) desiredListId = entries[0][0];
      select.value = desiredListId;
      if (activeListId === desiredListId) applyActiveListName(lists[desiredListId].name);
      activateList(desiredListId);
    });
  }

  function activateList(listId) {
    if (!listId) return;
    const nextMembersRef = listsRef.child(listId).child('members');
    const sameSubscription = activeListId === listId
      && listListenerRef
      && listListenerRef.toString() === nextMembersRef.toString();
    if (sameSubscription) return;

    if (listListenerRef) listListenerRef.off();
    if (settingsLogRef) settingsLogRef.off();
    if (memberSortRef) memberSortRef.off();
    resetVsMode();
    activeListId = listId;
    localStorage.setItem(`active_list_${activeUser.uid}`, listId);
    membersRef = nextMembersRef;
    settingsRef = listsRef.child(listId);
    listListenerRef = nextMembersRef;
    settingsLogRef = settingsRef.child('last_update_log');
    memberSortRef = settingsRef.child('memberSort');
    window.privateListStorageScope = `${activeUser.uid}_${listId}`;

    window.currentMembersData = null;
    memberRenderSignature = '';
    updateLastUpdateLogBadge();
    settingsLogRef.on('value', snapshot => {
      if (activeListId !== listId) return;
      updateLastUpdateLogBadge(snapshot.val());
    });
    memberSortRef.on('value', snapshot => {
      if (activeListId !== listId) return;
      const remoteSetting = snapshot.val();
      const setting = readLocalMemberSort() || remoteSetting || {};
      currentMemberSortMode = ['manual','name','rank','games','rating','winrate','power','pentagon_attack','pentagon_technique','pentagon_appeal','pentagon_spirit','pentagon_defense'].includes(setting.mode) ? setting.mode : 'manual';
      currentMemberSortDirection = setting.direction === 'asc' ? 'asc' : 'desc';
      excludeHistoricalFromSkillSort = setting.excludeHistorical === true;
      if (remoteSetting) writeLocalMemberSort(currentMemberSortMode, currentMemberSortDirection);
      window.memberAutoSortActive = currentMemberSortMode !== 'manual';
      updateMemberSortControls();
      if (window.currentMembersData && !window.cardReorderInProgress) { renderPosters(window.currentMembersData); setTimeout(addPerCardListActions, 0); }
    });
    renderPosters(null);
    byId('loadingState').style.display = '';

    const subscribedListId = listId;
    settingsRef.child('name').once('value').then(snapshot => {
      if (activeListId !== subscribedListId) return;
      const name = snapshot.val() || 'マイリスト';
      byId('titleText').textContent = name;
      document.title = `${name} | TEKKEN 8`;
    });
    nextMembersRef.on('value', snapshot => {
      if (activeListId !== subscribedListId || listListenerRef !== nextMembersRef) return;
      const members = snapshot.val();
      const nextMemberRenderSignature = createMemberRenderSignature(members);
      const isStatsOnlyUpdate = Boolean(memberRenderSignature)
        && nextMemberRenderSignature === memberRenderSignature
        && !window.memberAutoSortActive;
      byId('loadingState').style.display = 'none';
      window.currentMembersData = members;
      if (isStatsOnlyUpdate) {
        if (typeof window.refreshVisibleStats === 'function') window.refreshVisibleStats();
        return;
      }
      memberRenderSignature = nextMemberRenderSignature;
      renderPosters(members);
      setTimeout(() => {
        if (activeListId === subscribedListId) addPerCardListActions();
      }, 0);
    });
  }
  async function createList() {
    const name = safeName(prompt('新しいリスト名', '新しいマイリスト'));
    if (!name) return;
    const ref = listsRef.push();
    await ref.set({ name, order: Date.now(), createdAt: firebase.database.ServerValue.TIMESTAMP });
    activateList(ref.key);
    showToast(`${name} を作成しました`);
  }

  async function renameList() {
    if (!activeListId) return;
    const current = byId('myListSelect').selectedOptions[0]?.textContent || '';
    const name = safeName(prompt('リスト名を変更', current));
    if (!name) return;
    await listsRef.child(activeListId).child('name').set(name);
    applyActiveListName(name);
    showToast('リスト名を変更しました');
  }

  async function deleteList() {
    const select = byId('myListSelect');
    if (select.options.length <= 1) return showToast('最後の1件は削除できません');
    const name = select.selectedOptions[0]?.textContent || 'このリスト';
    if (!confirm(`${name} を削除しますか？`)) return;
    await listsRef.child(activeListId).remove();
    activeListId = null;
    showToast('リストを削除しました');
  }

  async function exportList() {
    const snapshot = await listsRef.once('value');
    const payload = { version: 1, exportedAt: new Date().toISOString(), lists: snapshot.val() || {} };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `tekken8-mylists-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function downloadJson(payload, filename) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function sanitizeSharedMembers(members) {
    const allowed = ['name', 'gameId', 'subtitle', 'xUrl', 'photoData', 'color', 'order'];
    return Object.fromEntries(Object.entries(members || {}).map(([id, member]) => {
      const clean = {};
      for (const key of allowed) if (member[key] !== undefined) clean[key] = member[key];
      clean.updatedAt = Date.now();
      return [id, clean];
    }));
  }

  async function exportSharedList() {
    if (!activeListId) return;
    const snapshot = await listsRef.child(activeListId).once('value');
    const source = snapshot.val();
    if (!source) return showToast('共有するリストがありません');
    const listName = safeName(source.name) || 'マイリスト';
    const payload = {
      format: 'tekken8-shared-list', version: 1, exportedAt: new Date().toISOString(),
      list: { name: listName, members: sanitizeSharedMembers(source.members) }
    };
    const filename = `${listName.replace(/[\\/:*?"<>|]/g, '_')}-tekken8-list.json`;
    downloadJson(payload, filename);
    showToast('共有ファイルを出力しました');
  }
  async function importList(event) {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data.format === 'tekken8-shared-list' && data.version === 1 && data.list) {
        const listName = safeName(data.list.name) || '共有リスト';
        const members = sanitizeSharedMembers(data.list.members);
        const memberCount = Object.keys(members).length;
        if (!confirm(`「${listName}」を新しいリストとして取り込みますか？\n登録人数: ${memberCount}人`)) return;
        const ref = listsRef.push();
        await ref.set({
          name: `${listName} (共有)`, order: Date.now(),
          createdAt: firebase.database.ServerValue.TIMESTAMP, members
        });
        activateList(ref.key);
        showToast('共有リストを取り込みました');
        return;
      }

      const backupLists = Object.values(data.lists || {});
      if (!backupLists.length) throw new Error('対応しているリストデータがありません');
      if (!confirm(`バックアップから${backupLists.length}件のリストを追加しますか？`)) return;
      for (const list of backupLists) {
        const ref = listsRef.push();
        await ref.set({ ...list, name: `${safeName(list.name) || 'インポート'} (取込)`, order: Date.now() });
      }
      showToast('バックアップをインポートしました');
    } catch (error) {
      showToast(`取込エラー: ${error.message}`);
    }
  }
  function memberKeyFromCard(card) {
    if (card.dataset.memberKey) return card.dataset.memberKey;
    const edit = card.querySelector('[onclick^="openEditModal"]');
    return edit?.getAttribute('onclick')?.match(/'([^']+)'/)?.[1] || '';
  }

  async function persistCardOrder(grid) {
    const updates = {};
    [...grid.querySelectorAll(':scope > .poster-card')].forEach((card, index) => {
      const key = memberKeyFromCard(card);
      if (key) updates[`${key}/order`] = (index + 1) * 1000;
    });
    if (!Object.keys(updates).length) return;
    try {
      await membersRef.update(updates);
      showToast('メンバーの並び順を保存しました');
    } catch (error) {
      showToast(`並び順の保存に失敗しました: ${error.message}`);
      const snapshot = await membersRef.once('value');
      renderPosters(snapshot.val());
      setTimeout(addPerCardListActions, 0);
    }
  }

  function bindCardReorder(handle, card) {
    const grid = card.parentElement;
    let pointerId = null;
    let moved = false;
    let slot = null;
    let originRect = null;
    let grabOffsetX = 0;
    let grabOffsetY = 0;
    let dragX = 0;
    let dragY = 0;
    let lastPointerX = 0;
    let lastPointerY = 0;
    let committedPointerX = null;
    let committedPointerY = null;
    let pendingGap = null;
    let pendingGapTimer = null;
    const shiftAnimations = new WeakMap();

    const clearPendingGap = () => {
      if (pendingGapTimer) clearTimeout(pendingGapTimer);
      pendingGapTimer = null;
      pendingGap = null;
    };

    const animateGridShift = before => {
      [...grid.querySelectorAll(':scope > .poster-card')].forEach(item => {
        const first = before.get(item);
        if (!first) return;
        const last = item.getBoundingClientRect();
        const dx = first.left - last.left;
        const dy = first.top - last.top;
        if (!dx && !dy) return;
        const previous = shiftAnimations.get(item);
        if (previous) previous.cancel();
        const animation = item.animate(
          [{ translate: `${dx}px ${dy}px` }, { translate: '0 0' }],
          { duration: 340, easing: 'cubic-bezier(.16,.82,.22,1)' }
        );
        shiftAnimations.set(item, animation);
        animation.finished.finally(() => {
          if (shiftAnimations.get(item) === animation) shiftAnimations.delete(item);
        }).catch(() => {});
      });
    };

    const clearFloatingStyles = () => {
      for (const property of ['position','left','top','width','height','margin','zIndex','pointerEvents','transform','transition']) {
        card.style[property] = '';
      }
      card.classList.remove('card-reordering');
    };

    const updateDropSlot = (clientX, clientY, force = false) => {
      if (!slot) return false;
      const probeX = clientX - grabOffsetX + originRect.width / 2;
      const probeY = clientY - grabOffsetY + originRect.height / 2;
      const slotRect = slot.getBoundingClientRect();
      const pointerInsideSlot =
        probeX >= slotRect.left && probeX <= slotRect.right &&
        probeY >= slotRect.top && probeY <= slotRect.bottom;
      if (pointerInsideSlot) {
        clearPendingGap();
        return false;
      }
      const cards = [...grid.querySelectorAll(':scope > .poster-card')];
      if (!cards.length) return false;
      const measured = cards.map(item => ({ item, rect: item.getBoundingClientRect() }));
      const nearest = measured.reduce((best, candidate) => {
        const centerX = candidate.rect.left + candidate.rect.width / 2;
        const centerY = candidate.rect.top + candidate.rect.height / 2;
        const dx = (probeX - centerX) / Math.max(candidate.rect.width, 1);
        const dy = (probeY - centerY) / Math.max(candidate.rect.height, 1);
        const distance = dx * dx + dy * dy;
        return !best || distance < best.distance ? { ...candidate, distance } : best;
      }, null);
      const targetIndex = cards.indexOf(nearest.item);
      const centerX = nearest.rect.left + nearest.rect.width / 2;
      const centerY = nearest.rect.top + nearest.rect.height / 2;
      const columnCount = getComputedStyle(grid).gridTemplateColumns
        .split(/\s+/)
        .filter(Boolean).length;
      const insertBefore = columnCount > 1 ? probeX < centerX : probeY < centerY;
      const firstRect = measured[0].rect;
      const lastRect = measured[measured.length - 1].rect;
      const beforeFirstZone = probeY <= firstRect.bottom && probeX <= firstRect.left + firstRect.width * 0.35;
      const afterLastZone =
        probeY > lastRect.bottom + lastRect.height * 0.2 ||
        (probeY >= lastRect.top - lastRect.height * 0.35 && probeX >= lastRect.left + lastRect.width * 0.35);
      const desiredGap = beforeFirstZone
        ? 0
        : afterLastZone
          ? cards.length
          : targetIndex + (insertBefore ? 0 : 1);
      const isWideBoundaryZone = beforeFirstZone || afterLastZone;
      const children = [...grid.children];
      const slotPosition = children.indexOf(slot);
      const currentGap = children.slice(0, slotPosition)
        .filter(item => item.classList.contains('poster-card')).length;
      if (desiredGap === currentGap) {
        clearPendingGap();
        return false;
      }
      if (!force && !isWideBoundaryZone) {
        lastPointerX = clientX;
        lastPointerY = clientY;
        if (committedPointerX !== null) {
          const movedSinceCommit = Math.hypot(
            clientX - committedPointerX,
            clientY - committedPointerY
          );
          if (movedSinceCommit < 28) {
            clearPendingGap();
            return false;
          }
        }
        if (pendingGap !== desiredGap) {
          clearPendingGap();
          pendingGap = desiredGap;
          pendingGapTimer = setTimeout(() => {
            if (pointerId !== null && pendingGap === desiredGap) {
              updateDropSlot(lastPointerX, lastPointerY, true);
            }
          }, 100);
        }
        return false;
      }
      clearPendingGap();

      const before = new Map(measured.map(({ item, rect }) => [item, rect]));
      if (desiredGap >= cards.length) grid.appendChild(slot);
      else grid.insertBefore(slot, cards[desiredGap]);
      committedPointerX = clientX;
      committedPointerY = clientY;
      animateGridShift(before);
      moved = true;
      return true;
    };
    const finish = async event => {
      if (pointerId === null || (event.pointerId !== undefined && event.pointerId !== pointerId)) return;
      const finalPlacementChanged = event.type === 'pointerup'
        ? updateDropSlot(event.clientX, event.clientY, true)
        : false;
      try { handle.releasePointerCapture(pointerId); } catch (e) {}
      pointerId = null;
      grid.classList.remove('card-reorder-active');
      if (finalPlacementChanged) await new Promise(resolve => setTimeout(resolve, 120));

      if (slot && originRect) {
        const destination = slot.getBoundingClientRect();
        const targetX = destination.left - originRect.left;
        const targetY = destination.top - originRect.top;
        const animation = card.animate(
          [
            { transform: `translate3d(${dragX}px,${dragY}px,0) scale(1.035)` },
            { transform: `translate3d(${targetX}px,${targetY}px,0) scale(1)` }
          ],
          { duration: 210, easing: 'cubic-bezier(.2,.85,.25,1)', fill: 'forwards' }
        );
        await animation.finished.catch(() => {});
        slot.replaceWith(card);
        slot = null;
        clearFloatingStyles();
      }
      if (moved) await persistCardOrder(grid);
      moved = false;
      endCardReorder();
    };

    handle.addEventListener('pointerdown', event => {
      if (currentMemberSortMode !== 'manual') return;
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      pointerId = event.pointerId;
      moved = false;
      originRect = card.getBoundingClientRect();
      grabOffsetX = event.clientX - originRect.left;
      grabOffsetY = event.clientY - originRect.top;
      dragX = 0;
      dragY = 0;
      lastPointerX = event.clientX;
      lastPointerY = event.clientY;
      committedPointerX = null;
      committedPointerY = null;
      clearPendingGap();
      beginCardReorder();

      slot = document.createElement('div');
      slot.className = 'card-drop-slot';
      slot.style.height = `${originRect.height}px`;
      card.before(slot);
      Object.assign(card.style, {
        position: 'fixed', left: `${originRect.left}px`, top: `${originRect.top}px`,
        width: `${originRect.width}px`, height: `${originRect.height}px`, margin: '0',
        zIndex: '20000', pointerEvents: 'none', transform: 'translate3d(0,0,0) scale(1.035)',
        transition: 'none'
      });
      document.body.appendChild(card);
      handle.setPointerCapture(pointerId);
      card.classList.add('card-reordering');
      grid.classList.add('card-reorder-active');
    });
    handle.addEventListener('pointermove', event => {
      if (event.pointerId !== pointerId || !slot) return;
      event.preventDefault();
      dragX = event.clientX - originRect.left - grabOffsetX;
      dragY = event.clientY - originRect.top - grabOffsetY;
      card.style.transform = `translate3d(${dragX}px,${dragY}px,0) scale(1.035)`;

      if (event.clientY < 72) window.scrollBy(0, -12);
      else if (event.clientY > window.innerHeight - 72) window.scrollBy(0, 12);

      lastPointerX = event.clientX;
      lastPointerY = event.clientY;
      updateDropSlot(lastPointerX, lastPointerY);
    });
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
    handle.addEventListener('keydown', async event => {
      if (currentMemberSortMode !== 'manual') return;
      if (!['ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      const previous = card.previousElementSibling;
      const next = card.nextElementSibling;
      if ((event.key === 'ArrowUp' || event.key === 'ArrowLeft') && previous?.classList.contains('poster-card')) {
        previous.before(card);
      } else if ((event.key === 'ArrowDown' || event.key === 'ArrowRight') && next?.classList.contains('poster-card')) {
        next.after(card);
      } else {
        return;
      }
      await persistCardOrder(grid);
    });
  }
  function addPerCardListActions() {
    document.querySelectorAll('.poster-card').forEach(card => {
      const key = memberKeyFromCard(card);
      if (!key) return;
      card.dataset.memberKey = key;

      if (!card.querySelector('.card-reorder-handle')) {
        const handle = document.createElement('button');
        handle.type = 'button';
        handle.className = 'card-reorder-handle';
        handle.textContent = '⠿';
        handle.title = 'ドラッグまたはスワイプして並べ替え';
        handle.setAttribute('aria-label', 'メンバーの位置を並べ替え');
        card.prepend(handle);
        bindCardReorder(handle, card);
      }
      const reorderHandle = card.querySelector('.card-reorder-handle');
      if (reorderHandle) {
        const isManual = currentMemberSortMode === 'manual';
        reorderHandle.hidden = !isManual;
        reorderHandle.disabled = !isManual;
        reorderHandle.setAttribute('aria-hidden', String(!isManual));
        reorderHandle.tabIndex = isManual ? 0 : -1;
      }
      let skillRankBadge = card.querySelector('.member-skill-rank-badge');
      const skillRank = window.memberSkillRanks && window.memberSkillRanks[key];
      if (skillRank && !skillRankBadge) {
        skillRankBadge = document.createElement('span');
        skillRankBadge.className = 'member-skill-rank-badge';
        skillRankBadge.setAttribute('aria-label', 'ランキング ' + skillRank + '位');
        card.appendChild(skillRankBadge);
      }
      if (skillRankBadge) {
        skillRankBadge.hidden = !skillRank;
        skillRankBadge.dataset.rank = skillRank || '';
        const rankLabel = MEMBER_SORT_SHORT_LABELS[currentMemberSortMode] || '';
        const rankValue = formatSkillRankValue(currentMemberSortMode, window.memberSkillRankValues && window.memberSkillRankValues[key], window.currentMembersData && window.currentMembersData[key]);
        skillRankBadge.setAttribute('aria-label', rankLabel + ' ' + (skillRank || '') + '位、' + rankValue);
        skillRankBadge.replaceChildren();
        if (skillRank) {
          const heading = document.createElement('span');
          heading.className = 'member-skill-rank-heading';
          const number = document.createElement('strong');
          number.textContent = String(skillRank);
          const label = document.createElement('small');
          label.textContent = rankLabel;
          heading.append(number, label);
          const valueLine = document.createElement('em');
          valueLine.textContent = rankValue;
          skillRankBadge.append(heading, valueLine);
        }
      }
      updateVsModeView();
      if (card.querySelector('.list-card-actions')) return;
      const actions = document.createElement('div');
      actions.className = 'list-card-actions';
      actions.innerHTML = '<button type="button">別リストへ移動</button><button type="button">別リストへ複製</button>';
      actions.children[0].onclick = () => transferMember(key, true);
      actions.children[1].onclick = () => transferMember(key, false);
      (card.querySelector('.card-admin-actions') || card).appendChild(actions);
    });
    requestAnimationFrame(syncMobileCardScale);
  }

  async function transferMember(key, move) {
    const options = [...byId('myListSelect').options].filter(o => o.value !== activeListId);
    if (!options.length) return showToast('移動先のリストを先に作成してください');
    const menu = options.map((o, i) => `${i + 1}: ${o.textContent}`).join('\n');
    const index = Number(prompt(`${move ? '移動' : '複製'}先を番号で選択\n${menu}`)) - 1;
    if (!options[index]) return;
    const source = await membersRef.child(key).once('value');
    if (!source.exists()) return;
    const sourceMember = source.val();
    const destinationMembersRef = listsRef.child(options[index].value).child('members');
    const destinationSnapshot = await destinationMembersRef.once('value');
    const normalizedSourceId = cleanTekkenId(sourceMember && sourceMember.gameId).toUpperCase();
    const duplicate = Object.values(destinationSnapshot.val() || {}).find(member =>
      cleanTekkenId(member && member.gameId).toUpperCase() === normalizedSourceId
    );
    if (duplicate) {
      const destinationName = options[index].textContent;
      const duplicateName = duplicate.name || '登録済みプレイヤー';
      alert(move
        ? `「${destinationName}」には「${duplicateName}」が既にいるため、このメンバーを移動できません。\n移動先で同じTEKKEN 8 IDが重複する操作はできません。`
        : `「${destinationName}」には「${duplicateName}」が既にいるため、このメンバーを複製できません。\n複製先で同じTEKKEN 8 IDが重複する操作はできません。`);
      showToast(`別リストへの${move ? '移動' : '複製'}を中止しました`);
      return;
    }
    await destinationMembersRef.push(sourceMember);
    if (move) await membersRef.child(key).remove();
    showToast(`別リストへ${move ? '移動' : '複製'}しました`);
  }

  async function startUserWorkspace(user) {
    activeUser = user;
    const access = await db.ref(`access/${user.uid}`).once('value');
    if (access.val() !== true) {
      await db.ref(`pendingAccess/${user.uid}`).update({
        displayName: user.displayName || '', email: user.email || '',
        requestedAt: firebase.database.ServerValue.TIMESTAMP
      });
      gate('管理者の承認待ちです', 'ログインは完了しています。管理者がUIDを承認すると利用できます。', 'pending');
      return;
    }
    hideGate();
    await db.ref(`users/${user.uid}/profile`).update({
      displayName: user.displayName || '', email: user.email || '',
      photoURL: user.photoURL || '', lastLoginAt: firebase.database.ServerValue.TIMESTAMP
    });
    listsRef = db.ref(`users/${user.uid}/lists`);
    injectWorkspace();
    const adminSnapshot = await db.ref(`admins/${user.uid}`).once('value');
    if (adminSnapshot.val() === true && byId('adminPanelBtn')) {
      byId('adminPanelBtn').hidden = false;
      byId('adminPanelBtn').onclick = () => window.startAdminAccessPanel(user, db, auth);
    }
    bindSharedStatus();
    subscribeLists();
    setupDragAndDrop();
  }

  window.init = function initPrivateListsPrototype() {
    const savedTheme = localStorage.getItem('preferred_theme');
    if (['wanted', 'modern', 'japanese'].includes(savedTheme)) currentTheme = savedTheme;
    byId('themeSelectDropdown').value = currentTheme;
    applyTheme(currentTheme);
    if (!/^https?:$/.test(location.protocol)) {
      gate('起動方法を変更してください', 'このページは file:// ではGoogleログインを利用できません。同じフォルダーの start-user-lists-prototype.cmd を実行してください。', 'login');
      return;
    }
    if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
    db = firebase.database();
    auth = firebase.auth();
    gate('拳トモくん（仮） / BBF-kun（β）', 'Googleログイン後、管理者に承認されたユーザーだけが利用できます。', 'login');
    auth.onAuthStateChanged(user => {
      if (!user) {
        if (listsRef) listsRef.off();
        if (listListenerRef) listListenerRef.off();
        if (settingsLogRef) settingsLogRef.off();
        if (memberSortRef) memberSortRef.off();
        if (window.mobileCardResizeObserver) {
          window.mobileCardResizeObserver.disconnect();
          window.mobileCardResizeObserver = null;
        }
        if (window.workspaceGridResizeHandler) {
          window.removeEventListener('resize', window.workspaceGridResizeHandler);
          window.workspaceGridResizeHandler = null;
        }
        if (window.workspaceMenuPositionHandler) {
          window.removeEventListener('resize', window.workspaceMenuPositionHandler);
          window.removeEventListener('scroll', window.workspaceMenuPositionHandler);
          window.workspaceMenuPositionHandler = null;
        }
        if (window.workspaceOutsideClickHandler) {
          document.removeEventListener('click', window.workspaceOutsideClickHandler);
          window.workspaceOutsideClickHandler = null;
        }
        byId('listWorkspace')?.remove();
        document.body.classList.remove('workspace-ui-active');
        activeUser = null;
        activeListId = null;
        listsRef = null;
        window.privateListStorageScope = '';
        listListenerRef = null;
        settingsLogRef = null;
        gate('拳トモくん（仮） / BBF-kun（β）', 'Googleログイン後、管理者に承認されたユーザーだけが利用できます。', 'login');
        return;
      }
      if (sessionStorage.getItem('t8_admin_mode') === '1') {
        startUserWorkspace(user)
          .then(() => window.startAdminAccessPanel(user, db, auth))
          .catch(error => gate('管理者ログインエラー', error.message, 'login'));
        return;
      }
      startUserWorkspace(user).catch(error => gate('接続エラー', error.message, 'pending'));
    });
  };

  const closeLastSeenScopeTips = except => {
    document.querySelectorAll('.last-seen-badge.scope-open').forEach(badge => {
      if (badge !== except) badge.classList.remove('scope-open');
    });
  };

  document.addEventListener('pointerdown', event => {
    if (event.target.closest('.last-seen-badge[data-last-seen-scope]')) event.stopPropagation();
  });

  document.addEventListener('click', event => {
    const badge = event.target.closest('.last-seen-badge[data-last-seen-scope]');
    const isTouchLayout = window.matchMedia('(hover: none), (pointer: coarse)').matches;
    if (!badge || !isTouchLayout) {
      closeLastSeenScopeTips();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const shouldOpen = !badge.classList.contains('scope-open');
    closeLastSeenScopeTips(badge);
    badge.classList.toggle('scope-open', shouldOpen);
  });

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeLastSeenScopeTips();
  });
  const originalSaveTitle = window.saveTitle;
  window.saveTitle = function saveActiveListTitle() {
    const input = byId('titleInput');
    const name = safeName(input.value);
    const previousName = byId('titleText').textContent;
    const editedListId = activeListId;
    input.onblur = null;
    input.style.display = 'none';
    byId('pageTitle').style.display = '';
    if (name && settingsRef) {
      applyActiveListName(name);
      settingsRef.child('name').set(name)
        .then(() => {
          if (activeListId === editedListId) applyActiveListName(name);
          showToast('リスト名を変更しました');
        })
        .catch(error => {
          if (activeListId === editedListId) applyActiveListName(previousName);
          showToast(`名前変更に失敗しました: ${error.message}`);
        });
    } else if (originalSaveTitle) originalSaveTitle();
  };
})();





















