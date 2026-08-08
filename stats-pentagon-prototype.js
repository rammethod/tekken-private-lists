(() => {
  const EWGF_PROFILE_WORKER = 'https://tight-bar-55c1.uracil123.workers.dev';
  const originalFetchEwgfStats = window.fetchEwgfStats;
  const pendingPentagonIds = new Set();
  const attemptedPentagonIds = new Set();
  const inFlightStatsById = new Map();
  const COMPLETION_AXIS_THRESHOLD = 97;
  const axes = [
    { key:'attack', label:'攻撃', angle:-90 },
    { key:'technique', label:'技術', angle:-18 },
    { key:'appeal', label:'魅力', angle:54 },
    { key:'spirit', label:'精神', angle:126 },
    { key:'defense', label:'防御', angle:198 }
  ];
  const componentGroups = [
    { key:'attackComponents', label:'攻撃', total:'attack', items:[['attackFrequency','手数'],['heavyDamage','大ダメージ'],['aggressiveness','積極性'],['dominance','圧倒']] },
    { key:'defenseComponents', label:'守備', total:'defense', items:[['block','ガード'],['evasion','回避'],['throwEscape','投げ抜け'],['composure','冷静']] },
    { key:'techniqueComponents', label:'技術', total:'technique', items:[['accuracy','精度'],['judgement','判断力'],['retaliation','切り返し'],['stageUse','ステージ活用']] },
    { key:'spiritComponents', label:'精神', total:'spirit', items:[['closeBattles','接戦'],['comeback','逆境'],['fightingSpirit','闘志'],['concentration','集中力']] },
    { key:'appealComponents', label:'魅力', total:'appeal', items:[['respect','敬意'],['ambition','向上心'],['fairness','正々堂々'],['versatility','多彩']] }
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
      const stats = await originalFetchEwgfStats(gameId, forceRefresh, memberKey, isManual, targetName);
      const statPentagon = valid(stats && stats.statPentagon)
        ? stats.statPentagon
        : (cached && valid(cached.statPentagon) ? cached.statPentagon : await fetchPentagon(id).catch(error => {
            console.warn(`Stat Pentagon fetch failed for ${id}:`, error);
            return cached && valid(cached.statPentagon) ? cached.statPentagon : null;
          }));
      if (stats && statPentagon && !valid(stats.statPentagon)) {
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

  function draw(canvas, data, options = {}) {
    if (!canvas || !valid(data)) return;
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(150, Math.round(Number(options.width) || rect.width || 260));
    const height = width;
    const dpr = Math.max(1, Number(options.pixelRatio)
      || Math.min(window.devicePixelRatio || 1, 2));
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const modern = options.theme === 'modern' || document.body.classList.contains('theme-modern');
    const japanese = document.body.classList.contains('theme-japanese');
    const wanted = !modern && !japanese;
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
      const axisFont = wanted ? '"Shippori Mincho", serif' : 'sans-serif';
      ctx.font = `700 12px ${axisFont}`;
      ctx.fillText(axis.label, label.x, label.y - 7);
      ctx.font = `800 14px ${axisFont}`;
      ctx.fillText(String(Math.round(Number(data[axis.key]))), label.x, label.y + 9);
    });
  }
  window.drawStatPentagonCanvas = draw;

  function componentEntries(data) {
    return componentGroups.flatMap(group => group.items.map(([key, label]) => ({
      key, label, group:group.label, value:Number(data?.[group.key]?.[key])
    }))).filter(item => Number.isFinite(item.value));
  }

  function analyzeSpiritComponents(map) {
    const closeBattles = Number(map.closeBattles);
    const comeback = Number(map.comeback);
    const fightingSpirit = Number(map.fightingSpirit);
    const concentration = Number(map.concentration);
    if ([closeBattles, comeback].every(value => value >= 20)) {
      return ' 接戦と逆境がともに高く、競った終盤や先行された展開でも勝負を残しやすい傾向がうかがえます。';
    }
    if ([fightingSpirit, concentration].every(value => value >= 20)) {
      return ' 闘志と集中力がともに高く、苦しい状況でも勝負を手放さず、終盤まで判断を保ちやすい傾向がうかがえます。';
    }
    if ([closeBattles, concentration].every(value => value >= 20)) {
      return ' 接戦と集中力が高く、ラウンド終盤の細かな読み合いでも動きを崩しにくい傾向がうかがえます。';
    }
    if ([comeback, fightingSpirit].every(value => value >= 20)) {
      return ' 逆境と闘志が高く、ビハインドから自分の攻めを作り直す粘りが表れています。';
    }
    if (closeBattles >= 20) {
      return ' 接戦が高く、体力差の小さい競ったラウンドで持ち味が出やすい傾向です。';
    }
    if (comeback >= 20) {
      return ' 逆境が高く、先行された展開から勝負を立て直す力が表れています。';
    }
    if (fightingSpirit >= 20) {
      return ' 闘志が高く、苦しい状況でも攻め返して勝負を続ける姿勢が表れています。';
    }
    if (concentration >= 20) {
      return ' 集中力が高く、試合終盤まで判断やリソース運用を崩しにくい傾向がうかがえます。';
    }
    return '';
  }

  function collectPentagonImprovements(map) {
    const improvements = [];
    const lowAggressiveness = Number(map.aggressiveness) <= 10;
    const lowDominance = Number(map.dominance) <= 10;
    const lowCloseBattles = Number(map.closeBattles) <= 12;
    const lowFightingSpirit = Number(map.fightingSpirit) <= 10;

    if (lowAggressiveness && lowDominance) {
      improvements.push({
        key: 'pressure',
        label: '攻めの成立と継続',
        priority: 88,
        action: '攻撃を有効打へ結び付ける場面と、有利を取った後に押し切る場面を一つずつ増やす',
        detail: '積極性と圧倒は伸ばせるポイントです。攻撃をヒットやカウンターへ結び付ける場面と、有利な流れをそのまま押し切る場面を増やすと、攻めの成果が安定しそうです。'
      });
    } else if (lowAggressiveness) {
      improvements.push({
        key: 'aggressiveness',
        label: '攻めの有効打',
        priority: 78,
        action: '有利な状況や相手が動くタイミングを、ヒットやカウンターへ結び付ける',
        detail: '積極性は伸ばせるポイントです。攻撃を出す回数だけでなく、有利な状況や相手が動くタイミングに技を重ね、ヒットやカウンターへ結び付ける機会を増やすと、攻めの成果が伸びそうです。'
      });
    } else if (lowDominance) {
      improvements.push({
        key: 'dominance',
        label: '攻めの継続',
        priority: 74,
        action: '有利を取った後に攻めを継続し、ラウンドを押し切る場面を増やす',
        detail: '圧倒は伸ばせるポイントです。攻め始める力はありますが、有利を取った後も攻めを継続し、ラウンドを押し切る選択を増やすと持ち味がさらに生きそうです。'
      });
    }

    const throwEscape = Number(map.throwEscape);
    if (throwEscape <= 8) {
      const isVeryLowThrowEscape = throwEscape <= 5;
      improvements.push({
        key: 'throwEscape',
        label: '投げ抜け',
        priority: isVeryLowThrowEscape ? 100 : 88,
        action: '主要な投げと抜け入力を整理する',
        detail: isVeryLowThrowEscape
          ? '投げ抜けは明確な改善ポイントです。相手キャラの主要な投げと抜け入力を整理し、投げモーションを見て反応する練習を取り入れると守りが安定しそうです。'
          : '投げ抜けは伸ばせるポイントです。よく使われる投げと抜け入力を少しずつ整理し、投げモーションへの反応を練習すると守りがさらに安定しそうです。'
      });
    }

    if (Number(map.judgement) <= 12) {
      improvements.push({
        key: 'judgement',
        label: '確定反撃',
        priority: 95,
        action: '主要な10F・12F・15F確反と距離別の反撃候補を確認する',
        detail: '判断力は伸ばせるポイントです。相手の技をガードして確定反撃が入る場面で、反撃を見逃したり、距離や硬直差に合わない技を選んでいる可能性があります。使用キャラの主要な10F・12F・15F確反と、距離が離れる技への反撃候補を整理すると、守りから得られるリターンを増やせそうです。'
      });
    }

    if (lowCloseBattles && lowFightingSpirit) {
      improvements.push({
        key: 'spiritFinish',
        label: '接戦の勝ち切りと劣勢時の攻め返し',
        priority: 84,
        action: '残り時間・体力差・残りリソースを確認して終盤を組み立てる',
        detail: '接戦と闘志は伸ばせるポイントです。体力差の小さい終盤を勝ち切れず、低体力や劣勢時に攻め返す前にラウンドを落としている可能性があります。残り時間と体力差を確認し、ヒートやレイジなどのリソースを抱えたまま終えないよう、勝負所で使い切る意識を持つと改善につながりそうです。'
      });
    } else if (lowCloseBattles) {
      improvements.push({
        key: 'closeBattles',
        label: '接戦の勝ち切り',
        priority: 70,
        action: '残り時間と体力差を見ながら、勝ち急がず最後の読み合いを組み立てる',
        detail: '接戦は伸ばせるポイントです。体力差の小さい終盤で、競ったラウンドを落としている傾向が出ている可能性があります。残り時間と体力差を見ながら、勝ち急がず最後の読み合いを組み立てると改善につながりそうです。'
      });
    } else if (lowFightingSpirit) {
      improvements.push({
        key: 'fightingSpirit',
        label: '劣勢時の攻め返し',
        priority: 76,
        action: '残ったヒートやレイジから、一度は自分の攻めを作る',
        detail: '闘志は伸ばせるポイントです。低体力や劣勢時に攻め返す機会を作れず、ヒートやレイジなどのリソースを使い切る前にラウンドを落としている可能性があります。苦しい場面でも、残ったリソースから一度は自分の攻めを作る意識が改善につながりそうです。'
      });
    }

    if (Number(map.stageUse) <= 10) {
      improvements.push({
        key: 'stageUse',
        label: 'ステージ活用',
        priority: 45,
        action: '壁位置を確認し、狙える場面だけ床・壁ギミックを拾う',
        detail: 'ステージ活用はまだ伸ばせそうです。壁位置を意識し、バルコニーブレイクやフロアブレイクを狙える場面を少し拾うと、同じ攻撃から得られるリターンを増やせそうです。'
      });
    }
    return improvements;
  }

  function renderPentagonImprovements(improvements, context = {}) {
    if (!improvements.length) return '';
    const sorted = [...improvements].sort((a, b) => b.priority - a.priority);
    if (sorted.length <= 2) {
      return ` ${sorted.map(item => item.detail).join(' ')}`;
    }
    const primary = sorted.slice(0, 2);
    const later = sorted.slice(2);
    const primaryLabels = primary.map(item => `「${item.label}」`).join('と');
    const laterLabels = later.map(item => `「${item.label}」`).join('・');
    const mainCharGames = Number(context.mainCharGames);
    const introduction = Number.isFinite(mainCharGames) && mainCharGames >= 0 && mainCharGames < 500
      ? 'このキャラでのランクマッチ経験がまだ積み上がる途中では、複数の伸びしろが同時に見えるのは自然です。'
      : '複数の伸びしろが同時に見えますが、';
    return ` ${introduction}すべてを一度に直す必要はありません。まずは${primaryLabels}を優先しましょう。${primary[0].action}ことと、${primary[1].action}ことから始めると、対戦中の変化を確認しやすそうです。次の段階で${laterLabels}を整えると、プレイ全体がまとまりやすくなります。`;
  }

  const componentTendencyText = {
    attackFrequency: '攻撃を出す頻度が高く、自分から触りにいく回数を確保する傾向があります。',
    heavyDamage: '一度の好機を大きなダメージへ結び付ける傾向があります。',
    aggressiveness: '攻撃を実際のヒットやカウンターヒットへ結び付ける傾向があります。',
    dominance: '優勢な流れを維持し、そのままラウンドを押し切る傾向があります。',
    block: '相手の攻めをガードで受け止める力が表れています。',
    evasion: '移動やしゃがみで相手の技をスカさせる傾向があります。',
    throwEscape: '投げに対する対応力が表れています。',
    composure: '守勢でも慌てず、動きを崩しにくい傾向があります。',
    accuracy: '自分の技をスカにしにくく、的確に当てる傾向があります。',
    judgement: '相手の隙に対し、状況や距離に合った確定反撃を選ぶ傾向があります。',
    retaliation: '守りから反撃へつなげ、自分のターンを作る傾向があります。',
    stageUse: '壁や床ギミックを活用してリターンを伸ばす傾向があります。',
    versatility: '多彩な技と二択で相手の対応を散らす傾向があります。'
  };

  function balancedSubtypeText(data) {
    const combatAxes = [
      { key: 'attack', label: '攻撃', value: Number(data?.attack) },
      { key: 'defense', label: '防御', value: Number(data?.defense) },
      { key: 'technique', label: '技術', value: Number(data?.technique) },
      { key: 'spirit', label: '精神', value: Number(data?.spirit) }
    ].filter(axis => Number.isFinite(axis.value)).sort((a, b) => b.value - a.value);
    if (combatAxes.length < 4) return '';
    const top = combatAxes[0];
    const second = combatAxes[1];
    const spread = top.value - combatAxes[combatAxes.length - 1].value;
    if (spread <= 5) {
      return '戦闘四指標の差も小さく、万能型の中でも特定の方向へ寄りすぎない均衡タイプです。';
    }
    const singleAxisTypes = {
      attack: '攻めを軸に試合を組み立てるタイプ',
      defense: '守備を軸に相手の攻めを受け止めるタイプ',
      technique: '精度と状況対応を軸にするタイプ',
      spirit: '接戦や逆境での勝負強さを軸にするタイプ'
    };
    const pairTypes = {
      'attack|defense': '攻守の切り替えで試合を組み立てるタイプ',
      'attack|spirit': '攻めと勝負所の粘りを両立するタイプ',
      'attack|technique': '技術を軸に攻めのリターンを伸ばすタイプ',
      'defense|spirit': '受けの安定感と粘りを軸にするタイプ',
      'defense|technique': '守りと状況対応を軸にするタイプ',
      'spirit|technique': '技術と勝負強さを軸にするタイプ'
    };
    const tripleTypes = {
      'attack|defense|spirit': '攻守と勝負所の強さを兼ね備えるタイプ',
      'attack|defense|technique': '攻め・守り・状況対応が高水準で噛み合うタイプ',
      'attack|spirit|technique': '技術を土台に攻めと勝負強さを両立するタイプ',
      'defense|spirit|technique': '守り・状況対応・勝負強さを高水準で備えるタイプ'
    };
    const nearTop = combatAxes.filter(axis => top.value - axis.value <= 5);
    const nearTopKey = nearTop.map(axis => axis.key).sort().join('|');
    const nearTopType = nearTop.length >= 3
      ? tripleTypes[nearTopKey]
      : pairTypes[nearTopKey];
    if (top.value >= COMPLETION_AXIS_THRESHOLD) {
      const supportingAxes = nearTop.slice(1);
      if (supportingAxes.length) {
        return `その中でも${top.label}指標は完成域に達し、${supportingAxes.map(axis => axis.label).join('・')}も同時に高水準です。${nearTopType || singleAxisTypes[top.key]}です。`;
      }
      return `その中でも${top.label}指標は完成域に達し、万能型の中では${singleAxisTypes[top.key]}です。`;
    }
    if (nearTop.length >= 3 && nearTopType) {
      return `その中でも${nearTop.map(axis => axis.label).join('・')}が高く、万能型の中では${nearTopType}です。`;
    }
    const attackAxis = combatAxes.find(axis => axis.key === 'attack');
    const techniqueAxis = combatAxes.find(axis => axis.key === 'technique');
    if (attackAxis?.value >= 80 && techniqueAxis?.value >= 80) {
      return 'その中でも攻撃・技術がともに高く、万能型の中では技術を攻めのリターンへ結び付けるタイプです。';
    }
    let subtype = singleAxisTypes[top.key];
    if (top.value - second.value <= 5) {
      const pairKey = [top.key, second.key].sort().join('|');
      subtype = pairTypes[pairKey] || subtype;
      return `その中でも${top.label}と${second.label}が高く、万能型の中では${subtype}です。`;
    }
    return `その中でも${top.label}が最も高く、万能型の中では${subtype}です。`;
  }

  function attackTechniqueArchetypeText(data) {
    const attack = Number(data?.attack);
    const technique = Number(data?.technique);
    const defense = Number(data?.defense);
    if (![attack, technique].every(Number.isFinite) || attack < 80 || technique < 80) return '';
    if (Number.isFinite(defense) && defense > attack) {
      return '攻撃・技術も高水準で、守備を軸にしながら精度や状況対応を十分なリターンへ結び付ける総合力があります。';
    }
    const lead = attack >= COMPLETION_AXIS_THRESHOLD
      ? '技術指標も高く、完成域の攻めを精度と状況対応で支える攻撃・技術型です。'
      : '攻撃・技術の両指標がともに高く、精度や状況対応を攻めのリターンへ結び付ける攻撃・技術型です。';
    if (!Number.isFinite(defense)) return lead;
    if (attack - defense >= 25 && technique - defense >= 25) {
      return defense >= 50
        ? `${lead} 防御にも一定の対応力は見えますが、攻撃・技術に比べると差があり、全体の配分は明確に攻めへ寄っています。`
        : `${lead} 攻撃・技術に比べて守備面には差があり、守りに回った場面には伸びしろがあります。`;
    }
    if (defense >= 80) {
      return `${lead} 防御も高水準で、攻め一辺倒ではない対応力があります。`;
    }
    return lead;
  }

  function analyzePentagon(data, context = {}) {
    const combatAxisValues = ['attack', 'defense', 'technique', 'spirit'].map(key => Number(data?.[key]));
    const hasAllCombatAxes = combatAxisValues.every(Number.isFinite);
    const attack = Number(data?.attack);
    const defense = Number(data?.defense);
    const technique = Number(data?.technique);
    const eliteBalanced = hasAllCombatAxes && combatAxisValues.every(value => value >= 85);
    const universalBalanced = hasAllCombatAxes && combatAxisValues.every(value => value >= 75);
    const attackTechniqueHigh = [attack, technique].every(Number.isFinite)
      && attack >= 80
      && technique >= 80;
    const defenseLeadsAttack = Number.isFinite(defense)
      && Number.isFinite(attack)
      && defense > attack;
    const attackAllIn = Number.isFinite(attack)
      && Number.isFinite(defense)
      && attack >= 78
      && defense <= 52;
    const attackHeavy = Number.isFinite(attack)
      && Number.isFinite(defense)
      && attack - defense >= 35;
    let summary = '';
    if (eliteBalanced) {
      summary = '攻撃・防御・技術・精神の戦闘四指標すべてが極めて高水準で、攻守と勝負強さに隙がほとんどない、完璧に近い総合力を備えたプレイヤーです。';
    } else if (universalBalanced) {
      summary = '攻撃・防御・技術・精神の戦闘四指標すべてが高水準。攻守と判断の穴が少ない、全方位型のプレイヤーです。';
    } else if (defenseLeadsAttack) {
      // Relative balance takes priority over the absolute defense value.
      // This prevents a defense-led profile from also receiving a low-defense archetype.
    } else if (attackTechniqueHigh) {
      // The combined attack/technique archetype is rendered below. Keep this
      // branch ahead of attack-heavy summaries so the same profile is not
      // reduced to a generic attack type.
    } else if (Number.isFinite(attack) && attack >= COMPLETION_AXIS_THRESHOLD) {
      // Attack 100 is an exceptional positive signal. A large attack-defense
      // gap here must not be rephrased as weak defense.
    } else if (attackAllIn) {
      summary = '高い攻撃力で試合を動かす、攻撃全振り型。勢いが最大の武器ですが、守りに回った場面には伸びしろがあります。';
    } else if (attackHeavy) {
      summary = defense >= 50
        ? '攻撃が防御を大きく上回る、攻撃全振り型に近いバランスです。防御にも対応力は見えますが、全体の配分は明確に攻めへ寄っています。'
        : '攻撃が防御を大きく上回る攻撃偏重型です。先に流れを握る強さがある一方、守りに回った場面には伸びしろがあります。';
    } else if (Number.isFinite(defense) && defense <= 50) {
      summary = '攻めの持ち味が先に表れるタイプ。守りの選択肢も少しずつ整えると、試合運びにさらに安定感が増しそうです。';
    }
    const mainCharGames = Number(context.mainCharGames);
    const mainChar = String(context.mainChar || '').trim();
    const experienceSummary = Number.isFinite(mainCharGames) && mainCharGames > 10000
      ? `非常に豊富な生涯ランクマッチ経験は特筆すべき積み重ねで、${mainChar ? `メインキャラとして${mainChar}への練度・愛着` : 'メインキャラとしての練度・愛着'}は相当に深いものと予想されます。`
      : '';
    const ratingMu = Number(context.ratingMu);
    const qualifiedRatingMap = context.qualifiedCharRatingMap && typeof context.qualifiedCharRatingMap === 'object'
      ? context.qualifiedCharRatingMap
      : {};
    const allRatingMap = context.charRatingMap && typeof context.charRatingMap === 'object'
      ? context.charRatingMap
      : {};
    const multiHighRatingCharacters = Object.entries(
      Object.keys(qualifiedRatingMap).length ? qualifiedRatingMap : allRatingMap
    ).filter(([, value]) => Number(value) >= 2000)
      .sort((a, b) => Number(b[1]) - Number(a[1]) || a[0].localeCompare(b[0]));
    const normalizeRatingCharacter = value =>
      String(value || '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g, '');
    const otherHighRatingCharacters = multiHighRatingCharacters
      .map(([character]) => String(character || '').trim())
      .filter(character => character && normalizeRatingCharacter(character) !== normalizeRatingCharacter(mainChar));
    const highRatingCharacterCount = multiHighRatingCharacters.length;
    const compactOtherHighRatingText = otherHighRatingCharacters.length > 3
      ? `${otherHighRatingCharacters.slice(0, 3).join('、')}など計${highRatingCharacterCount}キャラで`
      : `${otherHighRatingCharacters.join('、')}でも`;
    const allHighRatingNames = multiHighRatingCharacters.map(([character]) => String(character || '').trim()).filter(Boolean);
    const compactAllHighRatingText = allHighRatingNames.length > 4
      ? `${allHighRatingNames.slice(0, 4).join('、')}など計${allHighRatingNames.length}キャラで`
      : `${allHighRatingNames.join('、')}といった複数キャラで`;
    const highRatingSummary = Number.isFinite(ratingMu) && ratingMu >= 2000
      ? (otherHighRatingCharacters.length
        ? `${mainChar ? `${mainChar}だけでなく、${compactOtherHighRatingText}` : compactAllHighRatingText}Wavu μレート2000以上を達成しています。複数キャラで強い相手にも結果を重ねており、個別キャラの練度に加えて、鉄拳8への総合的な理解度の高さがうかがえます。`
        : `${mainChar ? `${mainChar}の` : 'このキャラの'}Wavu μレート2000以上は、高い対戦力を示す強力な判断材料です。キャラ別のGlicko-2評価で、強い相手にも結果を重ねている高水準のプレイヤーだと考えられます。`)
      : (multiHighRatingCharacters.length >= 2
        ? `${compactAllHighRatingText}Wavu μレート2000以上を達成しており、鉄拳8への総合的な理解度の高さがうかがえます。`
        : '');
    const perfectAxisMessages = [
      ['attack', '攻撃指標が完成域。手数・大ダメージ・積極性・圧倒を総合した攻めが際立っています。自分から試合を動かし、得た流れを大きなリターンへつなげる力が最大の武器です。'],
      ['defense', '防御指標が完成域。ガード・回避・投げ抜け・冷静さを総合した守りが際立っています。相手の攻めを受け止めながら崩れず、反撃の機会を作る力が際立っています。'],
      ['technique', '技術指標が完成域。精度・判断力・切り返し・ステージ活用を総合した技術が際立っています。状況に合った選択を高い精度で通し、ステージまで含めてリターンを伸ばせるプレイヤーです。'],
      ['spirit', '精神指標が完成域。接戦・逆境・闘志・集中力を総合した勝負強さが際立っています。苦しい展開でも集中を切らさず、終盤まで勝機を残す力が際立っています。']
    ];
    const perfectCombatAxes = perfectAxisMessages
      .filter(([key]) => Number(data?.[key]) >= COMPLETION_AXIS_THRESHOLD);
    const perfectCombatKeys = new Set(perfectCombatAxes.map(([key]) => key));
    const appeal = Number(data?.appeal);
    const appealSummary = Number.isFinite(appeal) && appeal >= COMPLETION_AXIS_THRESHOLD
      ? (appeal >= 100
        ? '魅力指標が完成域にあり、対戦相手への礼儀と敬意を強く感じさせる、極めて礼儀正しいプレイヤーだと考えられます。'
        : '魅力指標が完成域にあり、対戦相手への礼儀と敬意を感じさせる、相当に礼儀正しいプレイヤーだと考えられます。')
      : '';
    const perfectAxisNames = perfectCombatAxes
      .map(([, message]) => message.match(/^(攻撃|防御|技術|精神)/)?.[1])
      .filter(Boolean);
    // 複数の完成域は各軸の長文を連結せず、一つの賞賛として要約する。
    // 3軸以上の優れた選手ほど寸評が冗長になる逆転現象を防ぐ。
    const perfectCombatSummaryBase = perfectCombatAxes.length >= 2
      ? `${perfectAxisNames.join('・')}の${perfectCombatAxes.length}指標が完成域です。${perfectCombatAxes.length >= 3 ? '攻め・守り・技術（または勝負強さ）の複数面で、非常に高い完成度を示しています。' : '異なる強みを高水準で同時に備えた、総合力の高いプレイヤーです。'}`
      : (perfectCombatAxes[0]?.[1] || '');
    // 万能型などの総評の直後は、完成域の軸名をもう一度列挙せず
    // 「そのうちN指標」で受ける。単独の完成域だけは軸名を残す。
    const perfectCombatSummary = summary && perfectCombatSummaryBase
      ? (perfectCombatAxes.length >= 2
        ? `そのうち${perfectCombatAxes.length}指標が完成域に達しており、${perfectCombatAxes.length >= 3 ? '攻め・守り・技術（または勝負強さ）の複数面で、非常に高い完成度を示しています。' : '異なる強みを高水準で同時に備えた、総合力の高いプレイヤーです。'}`
        : `その中でも、${perfectCombatSummaryBase}`)
      : perfectCombatSummaryBase;
    const tactical = componentEntries(data).filter(item => !['respect', 'ambition', 'fairness'].includes(item.key));
    if (tactical.length < 17) return [summary, perfectCombatSummary, experienceSummary, highRatingSummary, appealSummary].filter(Boolean).join(' ')
      || '詳細内訳を取得できると、ここにプレイヤー傾向を表示します。';
    const map = Object.fromEntries(tactical.map(item => [item.key, item.value]));
    const defenseLed = !universalBalanced && defenseLeadsAttack;
    const focusItems = defenseLed ? tactical.filter(item => item.group === '守備') : tactical;
    const top = [...focusItems].sort((a, b) => b.value - a.value).slice(0, 3);
    const focusValues = focusItems.map(item => item.value);
    const hasStandout = top[0].value >= 18
      && top[0].value - Math.min(...focusValues) >= 3;
    let style = summary ? `${summary} ` : '';
    if (universalBalanced && !eliteBalanced && !perfectCombatAxes.length) {
      style += `${balancedSubtypeText(data)} `;
    }
    if (defenseLed && !perfectCombatKeys.has('defense')) {
      style += '守備指標が攻撃指標を上回っており、やや防御型のプレイヤーと言えそうです。相手の攻めを受け止め、切り返しから試合を組み立てる力が持ち味です。 ';
    }
    if (perfectCombatSummary) style += `${perfectCombatSummary} `;
    if (attackTechniqueHigh && !universalBalanced && perfectCombatAxes.length < 2) {
      style += `${attackTechniqueArchetypeText(data)} `;
    }
    if (eliteBalanced || universalBalanced || perfectCombatAxes.length || attackTechniqueHigh) {
      // The elite-balanced or perfect-attack message above is the final archetype;
      // Balanced and attack/technique profiles already receive one integrated subtype sentence.
      // Avoid repeating them as a separate attack/defense archetype.
    } else {
      style += hasStandout
        ? `${top.map(item => item.label).join('・')}が目立つプレイヤー。`
        : '各内訳の偏りが比較的小さいプレイヤー。';
      if (defenseLed) {
        style += hasStandout
          ? ' 守備の内訳を中心に見ると、この3項目がプレイスタイルを支えています。'
          : ' 守備の各要素を大きく偏らせず、受け止めて切り返す形を支えています。';
      } else if (summary) {
        // The summary has already established the overall archetype. Keep the
        // standout components as evidence without classifying the same player
        // as another attack/defense type a second time.
      } else if (map.attackFrequency >= 20 && map.aggressiveness >= 20) {
        style += ' 手数を確保しながら、攻撃を有効打やカウンターへ結び付けて主導権を握る攻撃型です。';
      } else if (map.aggressiveness >= 20 && map.dominance >= 20) {
        style += ' 攻撃を有効打へ結び付け、有利な流れをそのまま押し切る力に特徴があります。';
      } else if (map.attackFrequency >= 20 && map.heavyDamage >= 20) {
        style += ' 手数を確保しながら、大きなリターンへつなげる攻撃型です。';
      } else if (map.block >= 20 && map.composure >= 20) {
        style += ' ガードと冷静の数値が高く、守勢でも慌てずに攻めを受け止める傾向があります。';
      } else if (map.block >= 20 && map.throwEscape >= 20) {
        style += ' ガードと投げ抜けが高く、相手の攻めに対する守りの選択肢が整っています。';
      } else if (map.block >= 20 && map.judgement >= 20) {
        style += ' ガード後に、状況や距離に合った確定反撃を選ぶ力が高い迎撃型です。';
      } else if (map.block >= 20 && map.retaliation >= 20) {
        style += ' ガード後の隙を逃さず、反撃から自分のターンへつなげる迎撃型です。';
      } else if (map.evasion >= 20 && map.accuracy >= 20) {
        style += ' 相手の技をスカさせつつ、自分の技は的確に当てる傾向があります。';
      } else if (map.judgement >= 20 && map.retaliation >= 20) {
        style += ' 確定反撃の技選択と、守りから反撃へ移る動きの両方が整っています。';
      } else if (map.stageUse >= 20 && map.heavyDamage >= 20) {
        style += ' 壁や床のある局面を、大きなリターンへ結び付ける傾向があります。';
      } else if (map.versatility >= 20) {
        style += ' 多彩な技と二択で相手の対応を散らす傾向があります。';
      } else {
        style += hasStandout
          ? ` とくに${top[0].label}の数値が高く、${top[0].group}面に個性が出ています。${componentTendencyText[top[0].key] ? ` ${componentTendencyText[top[0].key]}` : ''}`
          : ' ひとつの要素だけに寄らず、複数の選択肢を組み合わせる傾向です。';
      }
    }
    if (!eliteBalanced) {
      style += analyzeSpiritComponents(map);
    }
    if (!eliteBalanced && map.stageUse >= 20 && !(map.stageUse >= 20 && map.heavyDamage >= 20)) {
      style += ' ステージ活用も高く、壁や床のある局面で持ち味が出そうです。';
    }
    if (!eliteBalanced) {
      style += renderPentagonImprovements(collectPentagonImprovements(map), context);
    }
    if (experienceSummary) style += ` ${experienceSummary}`;
    if (highRatingSummary) style += ` ${highRatingSummary}`;
    if (appealSummary) style += ` ${appealSummary}`;
    return style;
  }

  function notifyPentagonExport(message) {
    if (typeof showToast === 'function') {
      showToast(message);
    } else {
      console.info(message);
    }
  }

  function safePentagonFilenamePart(value, fallback) {
    const normalized = String(value || '')
      .normalize('NFKC')
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60);
    return normalized || fallback;
  }

  async function exportPentagonDetail(modal) {
    const dialog = modal?.querySelector('.stat-detail-dialog');
    const captureButton = modal?.querySelector('.stat-detail-capture');
    if (!dialog || typeof window.html2canvas !== 'function') {
      notifyPentagonExport('画像保存機能を読み込めませんでした。再読み込みしてください');
      return;
    }

    const capturedAt = new Date();
    const exportRoot = document.createElement('div');
    exportRoot.className = 'stat-detail-export-root';
    const clone = dialog.cloneNode(true);
    clone.classList.add('stat-detail-export-capture');
    clone.querySelectorAll('.stat-detail-close,.stat-detail-actions').forEach(element => element.remove());

    const timestamp = document.createElement('div');
    timestamp.className = 'stat-detail-export-timestamp';
    const capturedLabel = new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).format(capturedAt).replace(/-/g, '/');
    timestamp.textContent = `撮影日時 ${capturedLabel} JST`;
    clone.appendChild(timestamp);

    const dialogWidth = Math.max(1, Math.ceil(dialog.getBoundingClientRect().width));
    exportRoot.style.width = `${dialogWidth}px`;
    clone.style.width = `${dialogWidth}px`;
    clone.style.maxHeight = 'none';
    clone.style.height = 'auto';
    clone.style.overflow = 'visible';
    exportRoot.appendChild(clone);
    document.body.appendChild(exportRoot);
    // cloneNode() does not copy a canvas bitmap. Repaint the graph for the PNG
    // capture after the clone has joined the document and acquired its size.
    try {
      const pentagonData = JSON.parse(modal.dataset.statPentagon || 'null');
      const exportChart = clone.querySelector('.stat-detail-pentagon-canvas');
      if (valid(pentagonData) && exportChart) {
        draw(exportChart, pentagonData, { width: 520, pixelRatio: 3, theme: 'modern' });
      }
    } catch (error) {
      console.warn('Pentagon export chart repaint failed', error);
    }

    if (captureButton) {
      captureButton.disabled = true;
      captureButton.setAttribute('aria-busy', 'true');
    }
    notifyPentagonExport('ペンタゴン分析画像を作成しています…');

    try {
      if (document.fonts?.ready) await document.fonts.ready;
      const exportScale = Math.min(3, Math.max(2, window.devicePixelRatio || 1));
      const canvas = await window.html2canvas(clone, {
        backgroundColor: null,
        scale: exportScale,
        useCORS: true,
        allowTaint: false,
        logging: false,
        scrollX: 0,
        scrollY: 0
      });
      const pngDataUrl = canvas.toDataURL('image/png');
      if (!pngDataUrl || pngDataUrl === 'data:,') throw new Error('PNGを作成できませんでした');

      const date = new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Asia/Tokyo',
        year: 'numeric', month: '2-digit', day: '2-digit'
      }).format(capturedAt);
      const playerName = safePentagonFilenamePart(modal.dataset.memberName, 'player');
      const gameId = safePentagonFilenamePart(modal.dataset.memberGameId, 'no-id');
      const link = document.createElement('a');
      link.href = pngDataUrl;
      link.download = `拳トモくん-ペンタゴン分析-${playerName}-${gameId}-${date}.png`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      notifyPentagonExport('ペンタゴン分析をPNGで保存しました');
    } catch (error) {
      console.error('Pentagon detail export failed', error);
      notifyPentagonExport(`画像保存に失敗しました: ${error.message}`);
    } finally {
      exportRoot.remove();
      if (captureButton) {
        captureButton.disabled = false;
        captureButton.removeAttribute('aria-busy');
      }
    }
  }

  let pentagonDetailReturnHandler = null;
  function ensureDetailModal() {
    let modal = document.getElementById('statPentagonDetailModal');
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'statPentagonDetailModal';
    modal.className = 'stat-detail-modal';
    modal.hidden = true;
    modal.innerHTML = `
      <div class="stat-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="statDetailTitle">
        <button class="stat-detail-close" type="button" aria-label="閉じる">×</button>
        <div class="stat-detail-kicker">PLAY STYLE DETAIL</div>
        <h2 id="statDetailTitle"></h2>
        <div class="stat-detail-layout"><div class="stat-detail-left"><div class="stat-detail-chart"><canvas class="stat-detail-pentagon-canvas" role="img"></canvas></div><p class="stat-detail-memo"></p></div><div class="stat-detail-side"><div class="stat-detail-groups"></div></div></div>
        <small class="stat-detail-note">各項目は最大25。正式名称から直接読み取れる意味と複数のコミュニティ検証を優先した傾向分析です。公式な算出定義は公開されておらず、特に魅力の内訳は具体行動へ断定せず慎重に扱っています。</small>
        <div class="stat-detail-actions">
          <button class="stat-detail-capture" type="button" aria-label="ペンタゴン分析を画像保存" title="ペンタゴン分析をPNG画像として保存">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M8.4 5.5 9.7 3.8h4.6l1.3 1.7H19A2.5 2.5 0 0 1 21.5 8v9A2.5 2.5 0 0 1 19 19.5H5A2.5 2.5 0 0 1 2.5 17V8A2.5 2.5 0 0 1 5 5.5h3.4ZM12 8a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9Zm0 2a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Z"/>
            </svg>
          </button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    const close = (fromHistory = false) => {
      const returnToPreviousView = pentagonDetailReturnHandler;
      pentagonDetailReturnHandler = null;
      modal.hidden = true;
      document.body.classList.remove('stat-detail-open');
      if (!fromHistory && history.state?.kentomoOverlay === modal.id) history.back();
      // A compact landscape player detail yields its layer while the
      // pentagon is shown. Restore it after Back as well as ×/Escape.
      if (typeof returnToPreviousView === 'function') {
        requestAnimationFrame(returnToPreviousView);
      }
    };
    modal.querySelector('.stat-detail-close').addEventListener('click', close);
    modal.querySelector('.stat-detail-capture').addEventListener('click', () => exportPentagonDetail(modal));
    modal.addEventListener('click', event => { if (event.target === modal) close(); });
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && !modal.hidden) close(); });
    window.addEventListener('popstate', () => { if (!modal.hidden) close(true); });
    return modal;
  }

  function openPentagonDetail(member, data, stats = {}, options = {}) {
    const modal = ensureDetailModal();
    pentagonDetailReturnHandler = typeof options.onClose === 'function' ? options.onClose : null;
    modal.dataset.memberName = String(member.name || '');
    modal.dataset.memberGameId = String(member.gameId || '');
    modal.dataset.statPentagon = JSON.stringify(data || {});
    modal.querySelector('h2').textContent = `${String(member.name || member.gameId || 'PLAYER')}の詳細`;
    modal.querySelector('.stat-detail-memo').textContent = analyzePentagon(data, {
      mainCharGames: stats.mainCharGames,
      mainChar: stats.mainChar,
      ratingMu: stats.ratingMu,
      charRatingMap: stats.charRatingMap,
      qualifiedCharRatingMap: stats.qualifiedCharRatingMap
    });
    const chart = modal.querySelector('.stat-detail-pentagon-canvas');
    const chartSummary = axes.map(axis => `${axis.label} ${Math.round(Number(data[axis.key]))}`).join('、');
    chart.setAttribute('aria-label', `プレイスタイル五角形グラフ。${chartSummary}`);
    const host = modal.querySelector('.stat-detail-groups');
    host.replaceChildren();
    componentGroups.forEach(group => {
      const section = document.createElement('section');
      const total = Math.round(Number(data[group.total]));
      const heading = document.createElement('h3');
      heading.innerHTML = `<span>${group.label}</span><b>${total}</b>`;
      section.appendChild(heading);
      group.items.forEach(([key, label]) => {
        const value = Number(data?.[group.key]?.[key]);
        const row = document.createElement('div');
        row.className = 'stat-detail-row';
        const safeValue = Number.isFinite(value) ? Math.max(0, Math.min(25, value)) : 0;
        row.innerHTML = `<span>${label}</span><i><em style="width:${safeValue / 25 * 100}%"></em></i><b>${Number.isFinite(value) ? Math.round(value) : '–'}</b>`;
        section.appendChild(row);
      });
      host.appendChild(section);
    });
    modal.hidden = false;
    if (history.state?.kentomoOverlay !== modal.id) {
      history.pushState({ ...(history.state || {}), kentomoOverlay: modal.id }, '');
    }
    document.body.classList.add('stat-detail-open');
    requestAnimationFrame(() => {
      draw(chart, data, {
        width: Math.min(520, Math.max(250, chart.getBoundingClientRect().width || 360)),
        pixelRatio: Math.min(window.devicePixelRatio || 1, 3),
        // Detail is an analysis surface, not a skin preview. Keep its graph
        // colors identical across tavern, modern, and Japanese skins.
        theme: 'modern'
      });
    });
    modal.querySelector('.stat-detail-close').focus();
  }
  window.openStatPentagonDetail = openPentagonDetail;

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
          const winRateTone = winRate >= 65 ? 'is-elite-65' : (winRate >= 55 ? 'is-above-50' : 'is-below-50');
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
    canvas.dataset.pentagonValues = JSON.stringify(stats.statPentagon);
    const signature = `${summary}|${document.body.className}|${canvas.clientWidth}`;
    if (canvas.dataset.signature !== signature) {
      canvas.dataset.signature = signature;
      requestAnimationFrame(() => draw(canvas, stats.statPentagon));
    }
    panel.tabIndex = 0;
    panel.setAttribute('role', 'button');
    panel.setAttribute('aria-label', `${member.name || member.gameId}のペンタゴン詳細を開く。${summary}`);
    panel.onclick = event => {
      event.stopPropagation();
      openPentagonDetail(member, stats.statPentagon, stats);
    };
    panel.onkeydown = event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      event.stopPropagation();
      openPentagonDetail(member, stats.statPentagon, stats);
    };
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
