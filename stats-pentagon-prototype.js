(() => {
  const EWGF_PROFILE_WORKER = 'https://tight-bar-55c1.uracil123.workers.dev';
  const originalFetchEwgfStats = window.fetchEwgfStats;
  const pendingPentagonIds = new Set();
  const attemptedPentagonIds = new Set();
  const inFlightStatsById = new Map();
  const axes = [
    { key:'attack', label:'攻撃', angle:-90 },
    { key:'technique', label:'技術', angle:-18 },
    { key:'appeal', label:'魅力', angle:54 },
    { key:'spirit', label:'精神', angle:126 },
    { key:'defense', label:'防御', angle:198 }
  ];

  function valid(data) {
    return data && axes.every(axis => Number.isFinite(Number(data[axis.key])));
  }

  async function fetchPentagon(gameId) {
    const id = cleanTekkenId(gameId);
    const response = await fetch(
      `${EWGF_PROFILE_WORKER}/?ewgfId=${encodeURIComponent(id)}`,
      { cache:'no-store' }
    );
    const profile = await response.json();
    if (!response.ok || !profile.ok) throw new Error(profile.error || `EWGF HTTP ${response.status}`);
    return valid(profile.statPentagon) ? profile.statPentagon : null;
  }

  window.fetchEwgfStats = function(gameId, forceRefresh = false, memberKey = null, isManual = false, targetName = '') {
    const id = cleanTekkenId(gameId);
    if (!forceRefresh && inFlightStatsById.has(id)) return inFlightStatsById.get(id);

    const request = (async () => {
      const cached = getLocalStats(id);
      const basePromise = originalFetchEwgfStats(gameId, forceRefresh, memberKey, isManual, targetName);
      const pentagonPromise = !forceRefresh && cached && valid(cached.statPentagon)
        ? Promise.resolve(cached.statPentagon)
        : fetchPentagon(id).catch(error => {
            console.warn(`Stat Pentagon fetch failed for ${id}:`, error);
            return cached && valid(cached.statPentagon) ? cached.statPentagon : null;
          });
      const [stats, statPentagon] = await Promise.all([basePromise, pentagonPromise]);
      if (stats && statPentagon) {
        stats.statPentagon = statPentagon;
        setLocalStats(id, stats, memberKey);
      }
      queueRender();
      return stats;
    })();

    if (!forceRefresh) {
      inFlightStatsById.set(id, request);
      request.finally(() => {
        if (inFlightStatsById.get(id) === request) inFlightStatsById.delete(id);
      });
    }
    return request;
  };

  function draw(canvas, data) {
    if (!canvas || !valid(data)) return;
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(150, Math.round(rect.width || 260));
    const height = width;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const modern = document.body.classList.contains('theme-modern');
    const japanese = document.body.classList.contains('theme-japanese');
    const centerX = width / 2;
    const centerY = height / 2 + 2;
    const radius = Math.min(width * .28, height * .34);
    const point = (angle, scale = 1) => {
      const radians = angle * Math.PI / 180;
      return {
        x:centerX + Math.cos(radians) * radius * scale,
        y:centerY + Math.sin(radians) * radius * scale
      };
    };
    const polygon = (points, fill, stroke, lineWidth = 1) => {
      ctx.beginPath();
      points.forEach((item, index) => index
        ? ctx.lineTo(item.x, item.y)
        : ctx.moveTo(item.x, item.y));
      ctx.closePath();
      if (fill) { ctx.fillStyle = fill; ctx.fill(); }
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lineWidth; ctx.stroke(); }
    };

    const grid = modern
      ? 'rgba(196,181,253,.25)'
      : japanese ? 'rgba(79,70,229,.25)' : 'rgba(212,175,55,.28)';
    for (let level = 1; level <= 4; level += 1) {
      polygon(axes.map(axis => point(axis.angle, level / 4)), null, grid);
    }
    ctx.strokeStyle = grid;
    axes.forEach(axis => {
      const outer = point(axis.angle);
      ctx.beginPath();
      ctx.moveTo(centerX, centerY);
      ctx.lineTo(outer.x, outer.y);
      ctx.stroke();
    });

    const values = axes.map(axis =>
      point(axis.angle, Math.max(0, Math.min(100, Number(data[axis.key]))) / 100)
    );
    const fill = modern
      ? 'rgba(129,140,248,.42)'
      : japanese ? 'rgba(99,102,241,.34)' : 'rgba(212,175,55,.34)';
    const stroke = modern ? '#c084fc' : japanese ? '#4f46e5' : '#d4af37';
    ctx.save();
    ctx.shadowColor = modern ? 'rgba(192,132,252,.65)' : 'rgba(212,175,55,.4)';
    ctx.shadowBlur = 8;
    polygon(values, fill, stroke, 2);
    ctx.restore();
    ctx.fillStyle = stroke;
    values.forEach(item => {
      ctx.beginPath();
      ctx.arc(item.x, item.y, 2.8, 0, Math.PI * 2);
      ctx.fill();
    });

    const text = modern ? '#f5f3ff' : japanese ? '#1e1b4b' : '#fff5df';
    ctx.fillStyle = text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    axes.forEach(axis => {
      const label = point(axis.angle, 1.31);
      ctx.font = '700 12px sans-serif';
      ctx.fillText(axis.label, label.x, label.y - 7);
      ctx.font = '800 14px sans-serif';
      ctx.fillText(String(Math.round(Number(data[axis.key]))), label.x, label.y + 9);
    });
  }

  function renderBox(box) {
    const key = box.id.replace('stats_box_', '');
    const member = window.currentMembersData && window.currentMembersData[key];
    if (!member) return;
    const id = cleanTekkenId(member.gameId);
    const stats = getLocalStats(id, member);

    if (stats) {
      const wins = Number(stats.wins);
      const losses = Number(stats.losses);
      const games = Number.isFinite(wins) && Number.isFinite(losses)
        ? wins + losses
        : Number(stats.mainCharGames);
      const gamesElement = box.querySelector('.stats-preview-games');
      if (gamesElement && Number.isFinite(games) && games > 0) {
        const rankedWinRate = Number(stats.rankedWinRate);
        const winRate = stats.rankedDataVerified && Number.isFinite(rankedWinRate)
          ? rankedWinRate
          : (Number.isFinite(wins) && Number.isFinite(losses) ? wins / games * 100 : null);
        const gamesLine = document.createElement('span');
        gamesLine.className = 'stats-preview-games-line stats-preview-game-count';
        gamesLine.textContent = `・${games.toLocaleString()} games`;
        const lines = [gamesLine];
        if (winRate !== null) {
          const winRateLine = document.createElement('span');
          const winRateTone = winRate < 50 ? 'is-below-50' : (winRate > 50 ? 'is-above-50' : 'is-even-50');
          winRateLine.className = 'stats-preview-games-line stats-preview-win-rate ' + winRateTone;
          winRateLine.textContent = `・${winRate.toFixed(1)}% WR`;
          lines.push(winRateLine);
          const winRateNote = document.createElement('span');
          winRateNote.className = 'stats-preview-games-line stats-preview-win-rate-note';
          winRateNote.textContent = '※ All-time Ranked';
          lines.push(winRateNote);
        }
        gamesElement.replaceChildren(...lines);
      }
    }

    let panel = box.nextElementSibling;
    if (!panel || !panel.classList.contains('stat-pentagon-card')) panel = null;

    if (
      stats &&
      !valid(stats.statPentagon) &&
      !pendingPentagonIds.has(id) &&
      !attemptedPentagonIds.has(id)
    ) {
      pendingPentagonIds.add(id);
      attemptedPentagonIds.add(id);
      fetchPentagon(id)
        .then(statPentagon => {
          if (!statPentagon) return;
          stats.statPentagon = statPentagon;
          setLocalStats(id, stats, key);
        })
        .catch(error => console.warn(`Stat Pentagon hydration failed for ${id}:`, error))
        .finally(() => {
          pendingPentagonIds.delete(id);
          queueRender();
        });
    }

    if (!stats || !valid(stats.statPentagon)) {
      if (panel) panel.remove();
      return;
    }
    if (!panel) {
      panel = document.createElement('section');
      panel.className = 'stat-pentagon-card';
      panel.innerHTML = `
        <div class="stat-pentagon-heading">
          <span class="stat-pentagon-kicker">PLAY STYLE</span>
          <span class="stat-pentagon-title">STAT PENTAGON</span>
        </div>
        <canvas class="stat-pentagon-canvas" role="img"></canvas>
      `;
      box.insertAdjacentElement('afterend', panel);
    }
    const summary = axes
      .map(axis => `${axis.label} ${Math.round(Number(stats.statPentagon[axis.key]))}`)
      .join('、');
    const canvas = panel.querySelector('canvas');
    canvas.setAttribute('aria-label', `プレイスタイル五角形グラフ。${summary}`);
    const signature = `${summary}|${document.body.className}|${canvas.clientWidth}`;
    if (canvas.dataset.signature !== signature) {
      canvas.dataset.signature = signature;
      requestAnimationFrame(() => draw(canvas, stats.statPentagon));
    }
  }

  let queued = false;
  function queueRender() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      document.querySelectorAll('.card-stats-container').forEach(renderBox);
    });
  }

  new MutationObserver(queueRender).observe(document.body, { childList:true, subtree:true });
  new MutationObserver(queueRender).observe(document.body, {
    attributes:true,
    attributeFilter:['class']
  });
  window.addEventListener('resize', queueRender, { passive:true });
  window.addEventListener('load', queueRender);
})();

