/**
 * gameClient.js —— 联机对局客户端（阶段6：全排序/补杠/动画/AI 标识）
 *
 * 本文件【不运行任何麻将业务规则】：不判胡、不判碰杠、不排牌型、不看台数。
 * 只做两件事：
 *   1. 凭 sessionStorage 里的身份 token 重连入房；
 *   2. 收到后端 gameStateUpdate 后把状态渲染成牌桌 UI（动作按钮的显隐
 *      完全以后端下发的 myActions 为准）。
 * 所有点击只负责把 socket 指令发到后端，牌数据绝不本地修改。
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  /* ---------------- 身份读取 ---------------- */
  var session = null;
  try { session = JSON.parse(sessionStorage.getItem('mj_session') || 'null'); } catch (e) {}
  if (!session || !session.token) {
    bootError('未找到对局身份，请从首页创建或加入房间');
    return;
  }
  var mySeat = session.seat;
  var state = null;
  var discardBusy = false;   // 出牌指令已发、等待后端新状态期间锁定
  var actionBusy = false;    // 鸣牌/暗杠指令已发锁定

  var SEAT_LABELS = ['东家', '南家', '西家', '北家'];

  /* ---------------- 视角映射 ----------------
     核心座位 0东 1南 2西 3北（顺时针）。
     任意核心座位的玩家都坐在屏幕底部：
       slot 0=左 1=底 2=右 3=顶 */
  function coreToSlot(coreSeat) {
    return (coreSeat - mySeat + 5) % 4;
  }
  function slotToCore(slot) {
    return (mySeat + slot - 1 + 4) % 4;
  }

  // 2/3 人局：切换某物理槽位（非活动座位）全部相关 DOM 的隐藏状态
  function setSlotHidden(slot, hidden) {
    var boxSelectors = [
      '.seat-info[data-slot="' + slot + '"]',
      '.seat[data-slot="' + slot + '"]'
    ];
    boxSelectors.forEach(function (sel) {
      var el = document.querySelector(sel);
      if (el) el.classList.toggle('slot-hidden', hidden);
    });
    ['wall-slot-', 'sets-slot-', 'discard-slot-',
     'wind-', 'lamp-', 'streak-box-'].forEach(function (prefix) {
      var el = $(prefix + slot);
      if (el) el.classList.toggle('slot-hidden', hidden);
    });
  }

  /* ---------------- Socket ---------------- */
  // APP 内（WebView）默认连接公网服务器（任何网络均可联机）；
  // 原生桥保存的地址仅作高级覆盖。浏览器内为 undefined → 同源
  var PUBLIC_SERVER = 'https://zhuji-mahjong.onrender.com';
  var SERVER_URL = window.NativeApp
    ? (window.NativeApp.getServerUrl() || PUBLIC_SERVER) : '';
  var socket = io(SERVER_URL || undefined, { transports: ['websocket', 'polling'] });

  socket.on('connect', function () {
    socket.emit('rejoinRoom', { token: session.token }, function (res) {
      if (!res || !res.ok) {
        try { sessionStorage.removeItem('mj_session'); } catch (e) {}
        bootError((res && res.error) || '重连被拒绝');
      }
    });
  });

  // 唯一数据源：后端推送完整状态，差分检测音效后渲染
  socket.on('gameStateUpdate', function (s) {
    detectSfx(state, s);
    state = s;
    discardBusy = false;
    actionBusy = false;
    render();
  });

  // ---------------- 音效：相邻状态差分（任何座位动作统一经此） ----------------
  function groupKey(g) {
    return g.type + ':' + g.tiles.map(function (t) { return t.id; })
      .sort(function (a, b) { return a - b; }).join('_');
  }
  function groupsOf(s, seat) {
    return s.players[seat].peng.concat(s.players[seat].gang);
  }

  function detectSfx(prev, s) {
    var GA = window.GameAudio;
    if (!GA || !s) return;
    var pc = s.playerCount || 4;
    if (!prev) return;

    // 新出牌（补杠暴露窗口 pd.gang 不重复响，杠组差分会响 gang）
    var a = prev.turn.pendingDiscard, b = s.turn.pendingDiscard;
    if (b && !b.gang && (!a || a.tile.id !== b.tile.id)) GA.sfx('discard');

    // 副露组新增（碰 / 吃 / 杠，含 AI 座位）
    for (var seat = 0; seat < pc; seat++) {
      var oldKeys = prev.players[seat]
        ? groupsOf(prev, seat).map(groupKey) : [];
      groupsOf(s, seat).forEach(function (g) {
        if (oldKeys.indexOf(groupKey(g)) === -1) {
          GA.sfx(g.type === 'peng' ? 'peng'
                 : g.type === 'chi' ? 'chi' : 'gang');
        }
      });
    }

    // 结算弹窗出现：本人胡=胜利曲，他家胡=胡牌琶音
    if (!prev.round && s.round) {
      var w = s.round.settlement && s.round.settlement.winnerSeat;
      GA.sfx(w === mySeat ? 'win' : 'hu');
    }

    // 新一局掷骰：结算消失，或骰子点数变化
    var diceChanged = prev.dice && s.dice &&
      (prev.dice[0] !== s.dice[0] || prev.dice[1] !== s.dice[1]);
    if ((prev.round && !s.round) || diceChanged) GA.sfx('dice');
  }

  /* ---------------- 出牌：点击手牌 → playCard ---------------- */
  $('hand-slot-1').addEventListener('click', function (e) {
    var tileEl = e.target.closest('.tile');
    if (!tileEl || !tileEl.dataset.tileId) return;
    if (!canDiscard() || discardBusy) return;
    discardBusy = true;
    $('hand-slot-1').classList.remove('can-play');
    socket.emit('playCard', { tileId: tileEl.dataset.tileId }, function (res) {
      if (res && !res.ok) {
        discardBusy = false;
        if (state && canDiscard()) $('hand-slot-1').classList.add('can-play');
      }
    });
  });

  function canDiscard() {
    return !!state && state.turn.phase === 'discard' &&
           state.turn.currentSeat === mySeat;
  }

  /* ---------------- 鸣牌/胡/暗杠 指令 ---------------- */

  function sendClaim(action) {
    if (actionBusy) return;
    actionBusy = true;
    socket.emit(action, {}, function (res) {
      if (res && !res.ok) actionBusy = false;
    });
  }
  function sendAnGang(code) {
    if (actionBusy) return;
    actionBusy = true;
    socket.emit('angang', { code: code }, function (res) {
      if (res && !res.ok) actionBusy = false;
    });
  }
  function sendBuGang(code) {
    if (actionBusy) return;
    actionBusy = true;
    socket.emit('bugang', { code: code }, function (res) {
      if (res && !res.ok) actionBusy = false;
    });
  }

  // 退出对局
  $('btn-exit').addEventListener('click', function () {
    socket.emit('leaveRoom');
    try { sessionStorage.removeItem('mj_session'); } catch (e) {}
    setTimeout(function () {
      window.location.href = window.NativeApp ? 'index.html' : '/';
    }, 100);
  });

  // 再来一局
  $('btn-next-round').addEventListener('click', function () {
    if (actionBusy) return;
    actionBusy = true;
    socket.emit('nextRound', {}, function (res) {
      if (res && !res.ok) actionBusy = false;
    });
  });

  // 已做过入场动画的副露组（新组 pop 一次即可，避免重渲染反复播放）
  var seenGroupKeys = new Set();

  /* ---------------- 渲染入口 ---------------- */
  function render() {
    if (!state) return;

    // 新开局首帧：重置副露动画记录
    if (!state.round && state.turn.phase === 'discard' &&
        state.turn.discardCount === 0 && !state.turn.pendingDiscard) {
      seenGroupKeys.clear();
    }

    // HUD：余牌 / 翻基准 / 双财神
    $('wall-count').textContent = String(state.wallCount);

    var indSlot = $('indicator-slot');
    indSlot.innerHTML = '';
    indSlot.appendChild(TileView.makeTile(state.indicator.code,
      { small: true, wildCodes: state.wilds }));

    var wildSlot = $('wild-slot');
    wildSlot.innerHTML = '';
    state.wilds.forEach(function (code) {
      wildSlot.appendChild(TileView.makeTile(code, { small: true, wildCodes: state.wilds }));
    });

    renderDice(state.dice[0], state.dice[1]);
    renderWall();

    var isOver = state.turn.phase === 'over';
    var activeCore = state.turn.currentSeat;
    var activeSlot = isOver ? -1 : coreToSlot(activeCore);
    var pc = state.playerCount || 4;
    var isBankroll = state.mode === 'bankroll';

    for (var slot = 0; slot < 4; slot++) {
      var core = slotToCore(slot);
      var slotInactive = core >= pc;
      setSlotHidden(slot, slotInactive);
      if (slotInactive) continue;

      var p = state.players[core];
      var isMe = core === mySeat;

      // 信息条：昵称 / 张数 / 累计积分或余额
      var nameTag = isMe ? '（你）'
        : (p.aiTakeover ? '（电脑接管）'
           : (p.isAI ? '（电脑）' : ''));
      $('name-slot-' + slot).textContent = p.name + nameTag;
      $('count-slot-' + slot).textContent = p.handCount + ' 张';
      if (isBankroll) {
        $('score-slot-' + slot).textContent = '余 ' + state.balances[core] + ' 分';
      } else {
        var totalScore = state.scores[core] || 0;
        $('score-slot-' + slot).textContent =
          (totalScore > 0 ? '+' : '') + totalScore + ' 分';
      }

      // 庄家红灯
      var lamp = $('lamp-' + slot);
      if (lamp) lamp.classList.toggle('on', !!p.isBanker);

      // 当前行动座位高亮
      var seatEl = document.querySelector('.seat[data-slot="' + slot + '"]');
      if (seatEl) seatEl.classList.toggle('active', slot === activeSlot);
      var infoEl = document.querySelector('.seat-info[data-slot="' + slot + '"]');
      if (infoEl) {
        infoEl.classList.toggle('active', slot === activeSlot);
        // 断线但 AI 已接管不算离线灰态
        infoEl.classList.toggle('offline', p.online === false && !p.aiTakeover);
      }

      // 弃牌区：最近打出的一张高亮（以后端 lastDiscard 为准）
      var discEl = $('discard-slot-' + slot);
      discEl.innerHTML = '';
      p.discards.forEach(function (t) {
        var el = TileView.makeTile(t.code, { small: true, wildCodes: state.wilds });
        if (state.turn.lastDiscard && core === state.turn.lastDiscard.seat &&
            t.id === state.turn.lastDiscard.tileId) {
          el.classList.add('last-discard');
        }
        discEl.appendChild(el);
      });

      // 副露：碰/吃/杠
      renderSets(slot, p);

      if (slot === 1) {
        renderMyHand(p);
      } else {
        // 安全：任何阶段他人手牌都只渲染为牌背（数量与后端 handCount 一致）
        var backsEl = $('backs-slot-' + slot);
        backsEl.innerHTML = '';
        for (var i = 0; i < p.handCount; i++) {
          backsEl.appendChild(TileView.makeTile(null, { faceDown: true, small: true }));
        }
      }
    }

    // 连庄小方块：数字=连胡把数（首局 00），连庄高亮
    var streakText = state.bankerStreak > 0 ? String(state.bankerStreak) : '00';
    for (var s2 = 0; s2 < 4; s2++) {
      var box = $('streak-box-' + s2);
      if (box) {
        box.textContent = streakText;
        box.classList.toggle('active', state.bankerStreak >= 1);
      }
    }

    // 连庄状态说明（HUD 大字）
    var streakInfo = $('streak-info');
    if (streakInfo) {
      var n = state.bankerStreak;
      if (n <= 0) {
        streakInfo.textContent = '首局 · 无连庄';
        streakInfo.className = 'hud-line';
      } else if (n === 1) {
        streakInfo.textContent = '连庄 1 把（再胡 1 把积分翻倍）';
        streakInfo.className = 'hud-line streak-warn';
      } else {
        streakInfo.textContent = '连庄 ' + n + ' 把 · 本局胡牌 ×2';
        streakInfo.className = 'hud-line streak-hot';
      }
    }

    // 听牌提示条：客户端不做牌型计算，保持隐藏
    var tenpai = $('tenpai-bar');
    if (tenpai) { tenpai.classList.add('hidden'); tenpai.innerHTML = ''; }

    // 动作栏（鸣牌/自摸/暗杠）
    renderActionBar();

    // 结算弹窗（胡牌/流局）
    renderSettleModal();

    updateTableScale();
  }

  /* ---------------- 动作栏 ---------------- */
  function renderActionBar() {
    var bar = $('online-action-bar');
    var a = state.myActions;
    bar.innerHTML = '';

    if (!a || a.window === 'settle') { bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');

    if (a.window === 'claim') {
      if (a.responded) {
        addBarLabel(bar, '已选择，等待其他玩家…');
        return;
      }
      if (a.gangClaim) addBarLabel(bar, '抢杠胡窗口：');
      if (a.hu) addBarBtn(bar, '胡', 'btn-hu', function () { sendClaim('hu'); });
      if (a.gang) addBarBtn(bar, '杠', 'btn-gang', function () { sendClaim('gang'); });
      if (a.peng) addBarBtn(bar, '碰', 'btn-peng', function () { sendClaim('peng'); });
      addBarBtn(bar, '过', 'btn-pass', function () { sendClaim('pass'); });
    } else if (a.window === 'self') {
      if (a.hu) addBarBtn(bar, '胡', 'btn-hu', function () { sendClaim('hu'); });
      (a.angang || []).forEach(function (code) {
        addBarBtn(bar, '暗杠·' + TileView.tileName(code), 'btn-angang-online',
          function () { sendAnGang(code); });
      });
      (a.bugang || []).forEach(function (code) {
        addBarBtn(bar, '补杠·' + TileView.tileName(code), 'btn-bugang-online',
          function () { sendBuGang(code); });
      });
    }
  }

  function addBarBtn(bar, text, extraCls, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'action-btn' + (extraCls ? ' ' + extraCls : '');
    b.textContent = text;
    b.addEventListener('click', onClick);
    bar.appendChild(b);
  }
  function addBarLabel(bar, text) {
    var s = document.createElement('span');
    s.className = 'action-bar-label';
    s.textContent = text;
    bar.appendChild(s);
  }

  /* ---------------- 结算弹窗 ---------------- */
  function renderSettleModal() {
    var mask = $('settle-modal');
    if (!state.round) { mask.classList.add('hidden'); return; }

    var st = state.round.settlement;

    if (state.round.result === 'hu' && st) {
      $('settle-title').textContent = SEAT_LABELS[st.winnerSeat] + ' 胡牌';
      $('settle-way').textContent = st.wayText;
      $('settle-streak').textContent = st.streakNote || '';
      $('settle-streak').classList.toggle('hidden', !st.streakNote);

      // 财神
      var wEl = $('settle-wilds');
      wEl.innerHTML = '';
      var wLabel = document.createElement('span');
      wLabel.className = 'modal-label';
      wLabel.textContent = '本局财神：';
      wEl.appendChild(wLabel);
      state.wilds.forEach(function (code) {
        wEl.appendChild(TileView.makeTile(code,
          { small: true, wildCodes: state.wilds }));
      });

      // 牌型 chips
      var pEl = $('settle-patterns');
      pEl.innerHTML = '';
      st.patterns.forEach(function (p) {
        var chip = document.createElement('span');
        chip.className = 'pattern-chip' + (st.top ? ' chip-top' : '');
        chip.textContent = st.top ? (p.name + '（通杀）') : (p.name + ' ' + p.tai + ' 台');
        pEl.appendChild(chip);
      });

      // 台数明细
      var taiEl = $('settle-tai');
      if (st.top) {
        taiEl.innerHTML = '<b>三枪毙通杀</b>，三家各付 ' + st.unit +
          ' 分（不按台数、不翻倍）';
      } else {
        var formula = st.patterns.map(function (p) { return p.name + ' ' + p.tai; }).join(' + ');
        taiEl.innerHTML = formula + ' = <b>' + st.tai + '</b> 台　·　unit = 2^' +
          st.tai + ' = ' + st.unit + ' 分' +
          (st.mult > 1 ? '　<font class="txt-up">连庄 ×' + st.mult + '</font>' : '');
      }

      // 带分模式：封顶/清零提示
      var bankEl = $('settle-bank');
      if (st.mode === 'bankroll') {
        bankEl.textContent = st.bankNote || '';
        bankEl.classList.toggle('hidden', !st.bankNote);
      } else {
        bankEl.textContent = '';
        bankEl.classList.add('hidden');
      }

      // 各家收支 + 累计/余额
      renderSettleScoreRows(st);
    } else {
      // 流局
      $('settle-title').textContent = '流局（荒庄）';
      $('settle-way').textContent = '牌墙已摸完，四家无人胡牌，本局平局';

      var wEl2 = $('settle-wilds');
      wEl2.innerHTML = '';
      var wLabel2 = document.createElement('span');
      wLabel2.className = 'modal-label';
      wLabel2.textContent = '本局财神：';
      wEl2.appendChild(wLabel2);
      state.wilds.forEach(function (code) {
        wEl2.appendChild(TileView.makeTile(code,
          { small: true, wildCodes: state.wilds }));
      });

      $('settle-streak').textContent = state.bankerStreak >= 1
        ? '流局不清零：庄家继续坐庄，连庄计数保留（' + state.bankerStreak + ' 把）'
        : '流局不清零：庄家继续坐庄';
      $('settle-streak').classList.remove('hidden');

      var pEl2 = $('settle-patterns');
      pEl2.innerHTML = '<span class="pattern-chip">无牌型（平局）</span>';
      $('settle-tai').textContent = '本局不计台数、不计积分';

      var bankEl2 = $('settle-bank');
      bankEl2.textContent = ''; bankEl2.classList.add('hidden');
      renderSettleScoreRows(null);
    }

    // 再来一局按钮状态（确认数仅统计在场座位）
    var pcN = state.playerCount || 4;
    var confirms = 0;
    for (var cs = 0; cs < pcN; cs++) {
      if (state.round.confirms[cs]) confirms++;
    }
    $('settle-confirms').textContent = '已确认 ' + confirms + '/' + pcN;
    var btn = $('btn-next-round');
    var myConfirmed = !!state.round.confirms[mySeat];
    if (myConfirmed) {
      btn.textContent = '已确认，等待其他玩家';
    } else {
      btn.textContent = state.sessionBusted ? '重开新场' : '再来一局';
    }
    btn.disabled = myConfirmed;

    mask.classList.remove('hidden');
  }

  // 分数行（仅在场座位）：胡牌结算 st / 流局 null；带分模式显示余额
  function renderSettleScoreRows(st) {
    var scEl = $('settle-score');
    scEl.innerHTML = '';
    var pcRows = state.playerCount || 4;
    var bankMode = st ? st.mode === 'bankroll' : state.mode === 'bankroll';
    for (var s = 0; s < pcRows; s++) {
      var row = document.createElement('div');
      var isWinner = st && s === st.winnerSeat;
      row.className = 'score-row' + (isWinner ? ' row-winner' : '');

      var delta, deltaCls = '';
      if (!st) {
        delta = '0';
      } else if (isWinner) {
        delta = '+' + st.income;
        deltaCls = ' txt-up';
      } else {
        delta = st.pay[s] ? ('-' + st.pay[s]) : '0';
        if (st.pay[s]) deltaCls = ' txt-down';
      }

      var total = bankMode
        ? (st ? st.balances[s] : state.balances[s])
        : (st ? st.scoresAfter[s] : state.scores[s]);
      var totalCls = total > 0 ? 'txt-up' : total < 0 ? 'txt-down' : '';
      var colName = bankMode ? '余额' : '累计';
      row.innerHTML = '<span>' + SEAT_LABELS[s] + (isWinner ? '（胡）' : '') + '</span>' +
        '<span>本局 <b class="' + deltaCls + '">' + delta + '</b>　' + colName +
        ' <b class="' + totalCls + '">' + (total > 0 ? '+' : '') + total + '</b></span>';
      scEl.appendChild(row);
    }
  }

  /* ---------------- 我的手牌 ---------------- */
  function renderMyHand(p) {
    var handEl = $('hand-slot-1');
    handEl.innerHTML = '';

    var tiles = (p.hand || []).slice();
    var myDiscard = canDiscard();
    var drawnId = myDiscard ? state.turn.drawnTileId : null;

    // 全部手牌自动排序（含财神，按统一牌序；摸到的待出牌留在末尾单独标识）
    var drawnTile = null;
    var sorted = tiles.filter(function (t) {
      if (drawnId != null && t.id === drawnId) { drawnTile = t; return false; }
      return true;
    });
    sorted.sort(function (a, b) { return TileView.compareCodes(a.code, b.code); });

    function add(t, drawn) {
      var el = TileView.makeTile(t.code, { wildCodes: state.wilds });
      el.dataset.tileId = t.id;
      if (drawn) el.classList.add('tile-drawn');
      handEl.appendChild(el);
    }
    sorted.forEach(function (t) { add(t, false); });
    if (drawnTile) {
      var gap = document.createElement('span');
      gap.className = 'tile-gap';
      handEl.appendChild(gap);
      add(drawnTile, true);
    }
    handEl.classList.toggle('can-play', myDiscard);
  }

  /* ---------------- 副露组 ---------------- */
  function renderSets(slot, p) {
    var box = $('sets-slot-' + slot);
    box.innerHTML = '';
    var groups = p.peng.concat(p.gang);
    groups.forEach(function (group, gi) {
      // 新副露组：播放一次入场过渡
      var gkey = slot + '|' + group.type + '|' + (group.tiles[0] ? group.tiles[0].id : gi);
      var isNew = !seenGroupKeys.has(gkey);
      seenGroupKeys.add(gkey);

      var g = document.createElement('div');
      g.className = 'set-group set-' + group.type + (group.cai ? ' set-cai' : '') +
        (isNew ? ' set-pop' : '');
      if (group.type === 'angang') {
        g.appendChild(TileView.makeTile(group.tiles[0].code,
          { small: true, wildCodes: state.wilds }));
        g.appendChild(TileView.makeTile(null, { faceDown: true, small: true }));
        g.appendChild(TileView.makeTile(null, { faceDown: true, small: true }));
        g.appendChild(TileView.makeTile(group.tiles[3].code,
          { small: true, wildCodes: state.wilds }));
      } else {
        group.tiles.forEach(function (t) {
          g.appendChild(TileView.makeTile(t.code,
            { small: true, wildCodes: state.wilds }));
        });
      }
      box.appendChild(g);
    });
  }

  /* ---------------- 牌墙 ---------------- */
  function makeWallBack() {
    var d = document.createElement('div');
    d.className = 'wall-back';
    return d;
  }

  function renderWall() {
    for (var slot = 0; slot < 4; slot++) $('wall-slot-' + slot).innerHTML = '';
    state.wallStacks.forEach(function (st) {
      var slot = coreToSlot(st.seat);
      var box = $('wall-slot-' + slot);

      if (st.topTaken && st.botTaken && !st.indicator) return;
      var stk = document.createElement('div');
      stk.className = 'wall-stack';
      if (!st.botTaken) stk.appendChild(makeWallBack());
      if (!st.topTaken) {
        var top = makeWallBack();
        top.classList.add('wall-back-top');
        stk.appendChild(top);
      }
      if (st.indicator) {
        var ind = TileView.makeTile(state.indicator.code,
          { small: true, wildCodes: state.wilds });
        ind.classList.add('wall-indicator', 'wall-ind-seat-' + slot);
        stk.appendChild(ind);
      }
      box.appendChild(stk);
    });
  }

  /* ---------------- 骰子 ---------------- */
  var DICE_PIPS = {
    1: ['c'],
    2: ['tl', 'br'],
    3: ['tl', 'c', 'br'],
    4: ['tl', 'tr', 'bl', 'br'],
    5: ['tl', 'tr', 'c', 'bl', 'br'],
    6: ['tl', 'ml', 'bl', 'tr', 'mr', 'br']
  };
  function setDie(el, n) {
    if (!el) return;
    el.className = 'die' + (n ? '' : ' die-idle');
    el.innerHTML = '';
    if (!n) return;
    DICE_PIPS[n].forEach(function (pos) {
      var pip = document.createElement('span');
      pip.className = 'pip pip-' + pos;
      el.appendChild(pip);
    });
  }
  function renderDice(a, b) {
    setDie($('die-1'), a || 0);
    setDie($('die-2'), b || 0);
  }

  /* ---------------- 牌桌缩放 ---------------- */
  var DESIGN_W = 1150, DESIGN_H = 680;
  function updateTableScale() {
    var tableEl = document.querySelector('.table');
    if (!tableEl) return;
    var s = Math.min(tableEl.clientWidth / DESIGN_W, tableEl.clientHeight / DESIGN_H);
    s = Math.max(0.35, Math.min(1, s));
    tableEl.style.setProperty('--table-scale', s.toFixed(4));
  }
  window.addEventListener('resize', updateTableScale);
  window.addEventListener('orientationchange', function () {
    setTimeout(updateTableScale, 200);
  });

  function bootError(text) {
    $('boot-error-text').textContent = text;
    $('boot-error').classList.add('show');
  }
})();
