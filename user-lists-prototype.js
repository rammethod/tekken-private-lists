(() => {
  let auth = null;
  let activeUser = null;
  let activeListId = null;
  let listsRef = null;
  let listListenerRef = null;
  let settingsLogRef = null;

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
        <summary aria-label="リスト操作メニュー" title="リスト操作">•••</summary>
        <div class="workspace-menu" role="menu">
          <button id="newListBtn" role="menuitem">＋ 新しいリスト</button>
          <button id="renameListBtn" role="menuitem">リスト名を変更</button>
          <button id="shareListBtn" role="menuitem">このリストを共有</button>
          <button id="importListBtn" role="menuitem">共有・バックアップ取込</button>
          <button id="exportListBtn" role="menuitem">全バックアップ</button>
          <button id="deleteListBtn" class="menu-danger" role="menuitem">リストを削除</button>
        </div>
      </details>
      <input id="importListFile" type="file" accept="application/json" hidden>
      <details class="workspace-dropdown workspace-account" id="accountMenu">
        <summary><span class="user-chip" id="userChip"></span><span aria-hidden="true">▾</span></summary>
        <div class="workspace-menu" role="menu">
          <span class="workspace-menu-label">表示テーマ</span>
          <div class="theme-menu-row">
            <button type="button" data-theme-choice="wanted" title="WANTED">酒場</button>
            <button type="button" data-theme-choice="modern" title="MODERN">ネオン</button>
            <button type="button" data-theme-choice="japanese" title="JAPANESE">和風</button>
          </div>
          <button id="adminPanelBtn" role="menuitem" hidden>ユーザー承認</button>
          <button id="logoutBtn" role="menuitem">ログアウト</button>
        </div>
      </details>`;
    document.querySelector('.board-container').prepend(bar);
    document.body.classList.add('workspace-ui-active');
    byId('userChip').textContent = activeUser.displayName || activeUser.email || 'Google User';
    const closeWorkspaceMenus = () => bar.querySelectorAll('details[open]').forEach(menu => menu.removeAttribute('open'));
    byId('myListSelect').onchange = event => activateList(event.target.value);
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
    byId('deleteListBtn').onclick = () => { closeWorkspaceMenus(); deleteList(); };
    byId('shareListBtn').onclick = () => { closeWorkspaceMenus(); exportSharedList(); };
    byId('exportListBtn').onclick = () => { closeWorkspaceMenus(); exportList(); };
    byId('importListBtn').onclick = () => { closeWorkspaceMenus(); byId('importListFile').click(); };
    byId('importListFile').onchange = importList;
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

  function subscribeLists() {
    listsRef.on('value', async snapshot => {
      const lists = snapshot.val() || {};
      const entries = Object.entries(lists).sort((a, b) => (a[1].order || 0) - (b[1].order || 0));
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
    activeListId = listId;
    localStorage.setItem(`active_list_${activeUser.uid}`, listId);
    membersRef = nextMembersRef;
    settingsRef = listsRef.child(listId);
    listListenerRef = nextMembersRef;
    settingsLogRef = settingsRef.child('last_update_log');
    window.privateListStorageScope = `${activeUser.uid}_${listId}`;

    window.currentMembersData = null;
    updateLastUpdateLogBadge();
    settingsLogRef.on('value', snapshot => {
      if (activeListId !== listId) return;
      updateLastUpdateLogBadge(snapshot.val());
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
      byId('loadingState').style.display = 'none';
      window.currentMembersData = members;
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
      const slotRect = slot.getBoundingClientRect();
      const pointerInsideSlot =
        clientX >= slotRect.left && clientX <= slotRect.right &&
        clientY >= slotRect.top && clientY <= slotRect.bottom;
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
        const dx = (clientX - centerX) / Math.max(candidate.rect.width, 1);
        const dy = (clientY - centerY) / Math.max(candidate.rect.height, 1);
        const distance = dx * dx + dy * dy;
        return !best || distance < best.distance ? { ...candidate, distance } : best;
      }, null);
      const targetIndex = cards.indexOf(nearest.item);
      const centerX = nearest.rect.left + nearest.rect.width / 2;
      const centerY = nearest.rect.top + nearest.rect.height / 2;
      const columnCount = getComputedStyle(grid).gridTemplateColumns
        .split(/\s+/)
        .filter(Boolean).length;
      const insertBefore = columnCount > 1 ? clientX < centerX : clientY < centerY;
      const desiredGap = targetIndex + (insertBefore ? 0 : 1);
      const children = [...grid.children];
      const slotPosition = children.indexOf(slot);
      const currentGap = children.slice(0, slotPosition)
        .filter(item => item.classList.contains('poster-card')).length;
      if (desiredGap === currentGap) {
        clearPendingGap();
        return false;
      }
      if (!force) {
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
      if (card.querySelector('.list-card-actions')) return;
      const actions = document.createElement('div');
      actions.className = 'list-card-actions';
      actions.innerHTML = '<button type="button">別リストへ移動</button><button type="button">別リストへ複製</button>';
      actions.children[0].onclick = () => transferMember(key, true);
      actions.children[1].onclick = () => transferMember(key, false);
      (card.querySelector('.card-admin-actions') || card).appendChild(actions);
    });
  }

  async function transferMember(key, move) {
    const options = [...byId('myListSelect').options].filter(o => o.value !== activeListId);
    if (!options.length) return showToast('移動先のリストを先に作成してください');
    const menu = options.map((o, i) => `${i + 1}: ${o.textContent}`).join('\n');
    const index = Number(prompt(`${move ? '移動' : '複製'}先を番号で選択\n${menu}`)) - 1;
    if (!options[index]) return;
    const source = await membersRef.child(key).once('value');
    if (!source.exists()) return;
    await listsRef.child(options[index].value).child('members').push(source.val());
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
    gate('TEKKEN 8 PRIVATE LISTS', 'Googleログイン後、管理者に承認されたユーザーだけが利用できます。', 'login');
    auth.onAuthStateChanged(user => {
      if (!user) {
        if (listsRef) listsRef.off();
        if (listListenerRef) listListenerRef.off();
        if (settingsLogRef) settingsLogRef.off();
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
        gate('TEKKEN 8 PRIVATE LISTS', 'Googleログイン後、管理者に承認されたユーザーだけが利用できます。', 'login');
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





















