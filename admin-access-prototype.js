(() => {
  const $ = id => document.getElementById(id);
  const esc = value => {
    const node = document.createElement('span');
    node.textContent = String(value || '');
    return node.innerHTML;
  };
  const isDisposableGuestList = list => {
    if (!list || String(list.name || '').trim() !== 'マイリスト 1') return false;
    return Object.keys(list.members || {}).length === 0;
  };
  const removeRedundantGuestDefaults = async (db, uid) => {
    const target = db.ref(`users/${uid}/lists`);
    const lists = (await target.once('value')).val() || {};
    const entries = Object.entries(lists);
    // Keep the only list: the workspace requires at least one. Once a real list
    // exists, empty defaults created solely for guest startup are redundant.
    if (entries.length <= 1) return;
    const updates = {};
    entries.forEach(([listId, list]) => {
      if (isDisposableGuestList(list)) updates[listId] = null;
    });
    if (Object.keys(updates).length) await target.update(updates);
  };

  window.openGoogleAccountLogin = async function openGoogleAccountLogin() {
    const auth = firebase.auth();
    const db = firebase.database();
    try {
      if (auth.currentUser && !auth.currentUser.isAnonymous) {
        return;
      }
      const provider = new firebase.auth.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      if (auth.currentUser && auth.currentUser.isAnonymous) {
        const anonymousUser = auth.currentUser;
        const guestLists = (await db.ref(`users/${anonymousUser.uid}/lists`).once('value')).val() || null;
        try {
          const result = await anonymousUser.linkWithPopup(provider);
          await removeRedundantGuestDefaults(db, result.user.uid);
        } catch (error) {
          if (!error || !error.credential || ![
            'auth/credential-already-in-use',
            'auth/email-already-in-use',
          ].includes(error.code)) throw error;
          const result = await auth.signInWithCredential(error.credential);
          if (guestLists) {
            const target = db.ref(`users/${result.user.uid}/lists`);
            for (const [listId, list] of Object.entries(guestLists)) {
              if (isDisposableGuestList(list)) continue;
              const exists = await target.child(listId).once('value');
              if (!exists.exists()) await target.child(listId).set(list);
              else await target.push({ ...list, name: `${list.name || 'マイリスト'}（端末から移行）` });
            }
          }
          await removeRedundantGuestDefaults(db, result.user.uid);
        }
      } else {
        const result = await auth.signInWithPopup(provider);
        await removeRedundantGuestDefaults(db, result.user.uid);
      }
    } catch (error) {
      alert(`Googleアカウント連携失敗: ${error.code || error.message}`);
    }
  };
  window.openAdminLogin = window.openGoogleAccountLogin;
  window.startAdminAccessPanel = async function startAdminAccessPanel(user, db, auth) {
    const allowed = await db.ref(`admins/${user.uid}`).once('value');
    if (allowed.val() !== true) {
      sessionStorage.removeItem('t8_admin_mode');
      await auth.signOut();
      throw new Error('このアカウントには管理者権限がありません');
    }

    const normalGate = $('accessGate');
    if (normalGate) normalGate.hidden = true;
    let overlay = $('adminPanelOverlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'adminPanelOverlay';
      overlay.className = 'admin-panel-overlay';
      document.body.appendChild(overlay);
    }
    overlay.innerHTML = `<section class="admin-panel">
      <div class="admin-panel-head"><div><h2>Google連携ユーザー</h2><p>${esc(user.email)}</p></div>
      <div><button id="adminClose">マイリストに戻る</button><button id="adminReload">再読み込み</button><button id="adminLogout">ログアウト</button></div></div>
      <p>Google連携時に記録されたアカウント情報です。個人マイリストの内容は取得・表示しません。</p>
      <section class="admin-automation-panel"><h3>完全自動取得・アワード診断</h3><p>Workerが保存した状態です。各IDの最終同期時刻で、画面アクセスではなくバックグラウンド取得だったことを確認できます。</p><div id="adminAutomation">読み込み中...</div></section>
      <div id="adminUsers">読み込み中...</div>
    </section>`;

    const accountUsersRef = db.ref('accountUsers');
    const render = async () => {
      const [accountSnapshot, automationSnapshot, syncSnapshot, schedulesSnapshot, runsSnapshot] = await Promise.all([
        accountUsersRef.once('value'), db.ref('automationStatus').once('value'), db.ref('backgroundSyncState').once('value'),
        db.ref('awardSchedules').once('value'), db.ref('awardRuns').once('value')
      ]);
      const accountUsers = accountSnapshot.val() || {};
      const ids = Object.keys(accountUsers);
      ids.sort((a, b) => Number(accountUsers[b]?.lastLoginAt || 0) - Number(accountUsers[a]?.lastLoginAt || 0));
      $('adminUsers').innerHTML = ids.length ? ids.map(uid => {
        const profile = accountUsers[uid] || {};
        const when = profile.lastLoginAt ? new Date(profile.lastLoginAt).toLocaleString('ja-JP') : '記録なし';
        return `<article class="admin-user-row" data-uid="${esc(uid)}">
          <div><strong>${esc(profile.displayName || '名前未取得')}</strong><small>${esc(profile.email || 'メール未取得')}</small></div>
          <div><span class="admin-state approved">Google連携済み</span><small>最終ログイン: ${esc(when)}</small><small>UID: ${esc(uid)}</small></div>
        </article>`;
      }).join('') : '<p>Google連携済みユーザーはまだいません。</p>';
      const automation = automationSnapshot.val() || {};
      const syncEntries = Object.values(syncSnapshot.val() || {}).sort((a, b) => Number(b?.lastSyncedAt || 0) - Number(a?.lastSyncedAt || 0));
      const schedules = Object.values(schedulesSnapshot.val() || {}).flatMap(value => Object.values(value || {}));
      const runs = Object.values(runsSnapshot.val() || {}).flatMap(value => Object.values(value || {})).flatMap(value => Object.values(value || {}));
      const localTime = value => Number(value) ? new Date(Number(value)).toLocaleString('ja-JP') : '記録なし';
      const completed = runs.filter(run => run?.status === 'complete').length;
      const started = runs.filter(run => run?.start).length;
      $('adminAutomation').innerHTML = `<div class="admin-auto-summary"><div><small>Worker最終完了</small><strong>${esc(automation.completedAt ? new Date(automation.completedAt).toLocaleString('ja-JP') : '記録なし')}</strong></div><div><small>登録ユニークID</small><strong>${esc(automation.background?.registeredPlayers ?? '—')}</strong></div><div><small>今回の自動更新</small><strong>${esc(automation.background?.processed ?? '—')}</strong></div><div><small>失敗</small><strong>${esc(automation.background?.failures ?? '—')}</strong></div></div><dl class="admin-auto-facts"><div><dt>アワード有効リスト</dt><dd>${schedules.filter(item => item?.enabled).length}件</dd></div><div><dt>月初スナップショット</dt><dd>${started}件 / 確定済み ${completed}件</dd></div><div><dt>現在の月初記録</dt><dd>${esc(automation.awardData?.snapshotMembers ?? '次回Worker実行後に集計')}</dd></div></dl><details><summary>直近の自動同期済みプレイヤー ${syncEntries.length}件</summary><ul class="admin-auto-sync-list">${syncEntries.slice(0, 80).map(entry => `<li><b>${esc(entry.gameId || 'ID不明')}</b><span>${esc(localTime(entry.lastSyncedAt))}</span><small>${esc(entry.targetCount || 1)}リストへ反映</small></li>`).join('') || '<li>まだ同期記録がありません</li>'}</ul></details>`;
    };
    $('adminClose').onclick = () => {
      sessionStorage.removeItem('t8_admin_mode');
      overlay.remove();
    };
    $('adminReload').onclick = async event => {
      const button = event.currentTarget;
      button.disabled = true;
      button.textContent = '再読み込み中...';
      try {
        await render();
      } catch (error) {
        alert(`再読み込み失敗: ${error.code || error.message}`);
      } finally {
        button.disabled = false;
        button.textContent = '再読み込み';
      }
    };
    $('adminLogout').onclick = async () => {
      sessionStorage.removeItem('t8_admin_mode');
      overlay.remove();
      await auth.signOut();
    };
    await render();
  };
})();



