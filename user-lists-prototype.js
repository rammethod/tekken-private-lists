(() => {
  let auth = null;
  let activeUser = null;
  let activeListId = null;
  let listsRef = null;
  let listListenerRef = null;
  let settingsLogRef = null;

  const byId = id => document.getElementById(id);
  const safeName = value => String(value || '').trim().slice(0, 40);
  const gate = (title, text, mode = 'login') => {
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
      <select id="myListSelect" aria-label="表示するマイリスト"></select>
      <button id="newListBtn">＋ 新規</button><button id="renameListBtn">名前変更</button>
      <button id="deleteListBtn">削除</button><button id="shareListBtn">このリストを共有</button>
      <button id="exportListBtn">全バックアップ</button>
      <button id="importListBtn">共有・バックアップ取込</button><input id="importListFile" type="file" accept="application/json" hidden>
      <span class="user-chip" id="userChip"></span><button id="adminPanelBtn" hidden>ユーザー承認</button><button id="logoutBtn">ログアウト</button>`;
    document.querySelector('.board-container').prepend(bar);
    byId('userChip').textContent = activeUser.displayName || activeUser.email || 'Google User';
    byId('myListSelect').onchange = event => activateList(event.target.value);
    byId('newListBtn').onclick = createList;
    byId('renameListBtn').onclick = renameList;
    byId('deleteListBtn').onclick = deleteList;
    byId('shareListBtn').onclick = exportSharedList;
    byId('exportListBtn').onclick = exportList;
    byId('importListBtn').onclick = () => byId('importListFile').click();
    byId('importListFile').onchange = importList;
    byId('logoutBtn').onclick = () => auth.signOut();
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
    const edit = card.querySelector('[onclick^="openEditModal"]');
    return edit?.getAttribute('onclick')?.match(/'([^']+)'/)?.[1] || '';
  }

  function addPerCardListActions() {
    document.querySelectorAll('.poster-card').forEach(card => {
      if (card.querySelector('.list-card-actions')) return;
      const key = memberKeyFromCard(card);
      if (!key) return;
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
        activeUser = null;
        activeListId = null;
        window.privateListStorageScope = '';
        if (listListenerRef) listListenerRef.off();
        if (settingsLogRef) settingsLogRef.off();
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

  const originalSaveTitle = window.saveTitle;
  window.saveTitle = function saveActiveListTitle() {
    const input = byId('titleInput');
    const name = safeName(input.value);
    input.onblur = null;
    input.style.display = 'none';
    byId('pageTitle').style.display = '';
    if (name && settingsRef) settingsRef.child('name').set(name).then(() => showToast('リスト名を変更しました'));
    else if (originalSaveTitle) originalSaveTitle();
  };
})();











