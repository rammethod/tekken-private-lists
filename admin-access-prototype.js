(() => {
  const $ = id => document.getElementById(id);
  const esc = value => {
    const node = document.createElement('span');
    node.textContent = String(value || '');
    return node.innerHTML;
  };

  window.openAdminLogin = async function openAdminLogin() {
    const auth = firebase.auth();
    const db = firebase.database();
    sessionStorage.setItem('t8_admin_mode', '1');
    try {
      if (auth.currentUser) {
        await window.startAdminAccessPanel(auth.currentUser, db, auth);
        return;
      }
      const provider = new firebase.auth.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      await auth.signInWithPopup(provider);
    } catch (error) {
      sessionStorage.removeItem('t8_admin_mode');
      alert(`管理者ログイン失敗: ${error.code || error.message}`);
    }
  };
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
      <div class="admin-panel-head"><div><h2>ユーザー承認管理</h2><p>${esc(user.email)}</p></div>
      <div><button id="adminClose">マイリストに戻る</button><button id="adminReload">再読み込み</button><button id="adminLogout">ログアウト</button></div></div>
      <p>個人マイリストの内容はこの画面では取得・表示しません。</p>
      <div id="adminUsers">読み込み中...</div>
    </section>`;

    const pendingRef = db.ref('pendingAccess');
    const accessRef = db.ref('access');
    const render = async () => {
      const [pendingSnap, accessSnap] = await Promise.all([pendingRef.once('value'), accessRef.once('value')]);
      const pending = pendingSnap.val() || {};
      const access = accessSnap.val() || {};
      const ids = [...new Set([...Object.keys(pending), ...Object.keys(access)])];
      ids.sort((a, b) => Number(pending[b]?.requestedAt || 0) - Number(pending[a]?.requestedAt || 0));
      $('adminUsers').innerHTML = ids.length ? ids.map(uid => {
        const profile = pending[uid] || {};
        const approved = access[uid] === true;
        const when = profile.requestedAt ? new Date(profile.requestedAt).toLocaleString('ja-JP') : '記録なし';
        return `<article class="admin-user-row" data-uid="${esc(uid)}">
          <div><strong>${esc(profile.displayName || '名前未取得')}</strong><small>${esc(profile.email || 'メール未取得')}</small></div>
          <div><span class="admin-state ${approved ? 'approved' : 'pending'}">${approved ? '利用許可中' : '承認待ち'}</span><small>申請: ${esc(when)}</small><small>UID: ${esc(uid)}</small></div>
          <div>${approved
            ? '<button class="danger" data-action="revoke">利用停止</button>'
            : '<button data-action="approve">承認する</button><button class="danger" data-action="reject">申請削除</button>'}</div>
        </article>`;
      }).join('') : '<p>承認待ち・登録済みユーザーはいません。</p>';

      $('adminUsers').querySelectorAll('[data-action]').forEach(button => {
        button.onclick = async () => {
          const uid = button.closest('[data-uid]').dataset.uid;
          const action = button.dataset.action;
          if (action === 'approve') await accessRef.child(uid).set(true);
          if (action === 'revoke' && confirm('このユーザーの利用を停止しますか？')) await accessRef.child(uid).remove();
          if (action === 'reject' && confirm('この申請を削除しますか？')) await pendingRef.child(uid).remove();
          await render();
        };
      });
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



