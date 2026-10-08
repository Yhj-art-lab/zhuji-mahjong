/**
 * game-engine.js —— 联机后端【房间对局引擎】（阶段6：补杠/抢杠胡/安全序列化）
 *
 * 每个房间独立持有一份 MJCore 游戏实例（room.gameData），房间之间完全隔离。
 * 全套诸暨财神麻将权威规则都在本文件执行：
 *   牌库 / 翻基准牌生成双财神 / 洗牌发牌 / 手牌 / 吃碰杠 / 财神百搭 /
 *   混杂刻顺带财神零台禁胡 / 顶级牌型（字一色/天胡/地胡）三枪毙通杀 /
 *   台数计算 / 打胡放炮减半向上取整·自摸全额 / 连庄翻倍 / 流局 / 再来一局
 *
 * 回合机：
 *   discard（当前家待出牌） ──出牌──▶ claim（鸣牌窗口：三家可 胡/杠/碰/过）
 *        ▲                                   │
 *        └──── 下家摸牌成功（drawTile）◀──────┘
 *                    牌墙空 → settleDraw 流局（连庄不清零）
 */
'use strict';

const { EventEmitter } = require('events');
const MJCore = require('../mahjong-core.js');

// 房间事件总线：定时器（超时自动过/自动出牌）改完状态后经它通知 server 广播
const events = new EventEmitter();
function notifyChanged(room) {
  events.emit('roomChanged', room);
}

const CLAIM_TIMEOUT_MS = process.env.CLAIM_TIMEOUT_MS
  ? Number(process.env.CLAIM_TIMEOUT_MS) : 10000;    // 鸣牌窗口超时：未应=过
const DISCARD_TIMEOUT_MS = process.env.DISCARD_TIMEOUT_MS
  ? Number(process.env.DISCARD_TIMEOUT_MS) : 20000;  // 出牌超时：自动打非财神张

/* ================================================================
 *  对局生命周期
 * ================================================================ */

// 本局活动玩家数（2/3/4，默认4）
function playerCountOf(room) {
  const n = room.options && room.options.playerCount;
  return (n === 2 || n === 3) ? n : 4;
}

// 为房间创建新对局实例：翻财神/洗牌/发牌，随后进入庄家出牌阶段
function createGameForRoom(room) {
  const pc = playerCountOf(room);
  if (room.bankerSeat === undefined || room.bankerSeat === null || room.bankerSeat >= pc) {
    room.bankerSeat = Math.floor(Math.random() * pc);
  }
  const dice = MJCore.rollDice();
  const game = MJCore.newGame(room.bankerSeat, { dice });

  // 2/3 人局：物理发牌仍按 4 座完成，未启用座位（pc..3）的手牌退回牌墙，
  // 这些牌与牌墙一样随机可摸；牌桌只显示/轮转 0..pc-1。
  if (pc < 4) {
    game.playerCount = pc;
    for (let s = pc; s < 4; s++) {
      for (const t of game.players[s].hand) game.deck.push(t);
      game.players[s].hand = [];
    }
  }

  room.gameData = game;
  room.claim = null;
  room.round = null;
  room.timers = room.timers || {};
  clearRoomTimers(room);

  enterDiscardPhase(room);   // 开局庄家 14 张待出牌（可能天胡）
  return game;
}

// 进入"当前家出牌阶段"：仅启动出牌超时定时器；动作合法性在序列化时实时计算
function enterDiscardPhase(room) {
  const game = room.gameData;
  if (!game || game.turn.phase !== 'discard') return;
  clearRoomTimers(room);
  room.timers.discard = setTimeout(() => expireDiscardTurn(room), DISCARD_TIMEOUT_MS);
}

/* ================================================================
 *  出牌 → 鸣牌窗口
 * ================================================================ */

// 权威出牌：手牌→自家弃牌区，随后打开鸣牌窗口（不再立即轮转）
function applyPlayCard(room, seat, tileId) {
  const game = room.gameData;
  if (!game) return { ok: false, error: '对局不存在' };
  if (room.round) return { ok: false, error: '对局已结束' };
  const turn = game.turn;
  if (turn.phase === 'over') return { ok: false, error: '对局已结束' };
  if (turn.phase !== 'discard') return { ok: false, error: '当前不是出牌阶段' };
  if (turn.currentSeat !== seat) return { ok: false, error: '还没轮到你出牌' };
  if (tileId === undefined || tileId === null) return { ok: false, error: '缺少出牌信息' };

  const tile = MJCore.discardTile(game, seat, tileId);
  if (!tile) return { ok: false, error: '出牌不合法' };

  game.turn.lastDiscard = { seat, tileId: tile.id };
  openClaimWindow(room);
  return { ok: true, discarded: { id: tile.id, code: tile.code } };
}

// 打开鸣牌窗口：等待三家响应
function openClaimWindow(room) {
  clearRoomTimers(room);
  room.claim = { responses: {} };
  room.timers.claim = setTimeout(() => expireClaimWindow(room), CLAIM_TIMEOUT_MS);
}

/* ---------- 鸣牌窗口的实时事实（胡牌座位 / 碰杠选项） ---------- */

// 鸣牌窗口的全部响应座位（打出者之外的活动座位，按截胡顺序）
function responderSeats(room) {
  const n = playerCountOf(room);
  const pdSeat = room.gameData.turn.pendingDiscard.seat;
  const out = [];
  for (let i = 1; i < n; i++) out.push((pdSeat + i) % n);
  return out;
}

// 可胡牌座位（按截胡顺序：打出者下家起轮转），抢杠窗口引擎自动判抢杠胡；禁胡不计入
function winSeatsOf(room) {
  const game = room.gameData;
  const pd = game.turn.pendingDiscard;
  const wins = [];
  if (!pd) return wins;
  const n = playerCountOf(room);
  for (let i = 1; i < n; i++) {
    const s = (pd.seat + i) % n;
    const ev = MJCore.evaluateHu(game, s, pd.tile.code);
    if (ev.win && !ev.banned) wins.push({ seat: s, ev, dist: i });
  }
  return wins;
}

// 碰/杠/吃实时选项
function claimOptionsOf(room) {
  return MJCore.getClaimOptions(room.gameData);
}

// 某座位在鸣牌窗口的动作资格：{ hu, gang, peng }
function claimEligibility(room, seat) {
  const game = room.gameData;
  const pd = game.turn.pendingDiscard;
  if (!pd || pd.seat === seat) return { hu: false, gang: false, peng: false };
  const winSeats = winSeatsOf(room);
  const opts = claimOptionsOf(room);
  return {
    hu: winSeats.some(w => w.seat === seat),
    gang: opts.gang.indexOf(seat) !== -1,
    peng: opts.peng.indexOf(seat) !== -1 ||
          opts.caipeng.indexOf(seat) !== -1 ||
          opts.shuangcaipeng.indexOf(seat) !== -1
  };
}

// 某座位自家出牌阶段的动作事实：自摸胡 / 暗杠候选码 / 补杠候选码
function selfEligibility(room, seat) {
  const game = room.gameData;
  const ev = MJCore.evaluateHu(game, seat, null);
  return {
    hu: !!(ev.win && !ev.banned),
    angang: MJCore.findAnGangCodes(game, seat),
    bugang: MJCore.findBuGangCodes(game, seat)
  };
}

/* ---------- 响应鸣牌 ---------- */

function respondClaim(room, seat, action) {
  const game = room.gameData;
  if (!game || !room.claim) return { ok: false, error: '当前不在鸣牌窗口' };
  const pd = game.turn.pendingDiscard;
  if (!pd) return { ok: false, error: '待响应牌不存在' };
  if (pd.seat === seat) return { ok: false, error: '出牌者不能鸣自己的牌' };
  if (responderSeats(room).indexOf(seat) === -1)
    return { ok: false, error: '你不在本局座位中' };
  if (room.claim.responses[seat]) return { ok: false, error: '你已经做出选择' };

  const elig = claimEligibility(room, seat);

  if (action === 'hu') {
    if (!elig.hu) return { ok: false, error: '你不满足胡牌条件' };
    const winSeats = winSeatsOf(room);
    const rec = winSeats.find(w => w.seat === seat);
    settleHu(room, seat, rec.ev);
    return { ok: true, resolved: 'hu' };
  }
  if (action === 'gang') {
    if (!elig.gang) return { ok: false, error: '你不满足明杠条件' };
  } else if (action === 'peng') {
    if (!elig.peng) return { ok: false, error: '你不满足碰牌条件' };
  } else if (action !== 'pass') {
    return { ok: false, error: '未知动作' };
  }

  room.claim.responses[seat] = action;

  // 活动座位全部响应 → 仲裁
  const all = responderSeats(room);
  if (all.every(s => room.claim.responses[s])) {
    resolveClaim(room);
  }
  return { ok: true, action };
}

// 鸣牌窗口超时：未响应者按"过"处理，随后仲裁，并通知广播
function expireClaimWindow(room) {
  if (!room.claim) return;
  if (room.gameData.turn.pendingDiscard) {
    for (const s of responderSeats(room)) {
      if (!room.claim.responses[s]) room.claim.responses[s] = 'pass';
    }
  }
  resolveClaim(room);
  notifyChanged(room);
}

// 仲裁（胡>杠>碰，同档按截胡顺序）：胡在响应时已即时结算，这里处理超时出现的胡
function resolveClaim(room) {
  const game = room.gameData;
  const pd = game.turn.pendingDiscard;
  if (!pd) { room.claim = null; return; }

  const responses = room.claim.responses;

  // ① 胡（超时窗口中可能存在）：按截胡顺序取最前者
  const winSeats = winSeatsOf(room);
  for (const w of winSeats) {
    if (responses[w.seat] === 'hu') {
      settleHu(room, w.seat, w.ev);
      return;
    }
  }

  // ② 杠（至多一家）
  const opts = claimOptionsOf(room);
  for (const s of responderSeats(room)) {
    if (responses[s] === 'gang' && opts.gang.indexOf(s) !== -1) {
      executeGangFromClaim(room, s);
      return;
    }
  }

  // ③ 碰（正碰/财碰/双财碰），按截胡顺序
  for (const s2 of responderSeats(room)) {
    if (responses[s2] !== 'peng') continue;
    if (opts.peng.indexOf(s2) !== -1 || opts.caipeng.indexOf(s2) !== -1 ||
        opts.shuangcaipeng.indexOf(s2) !== -1) {
      executePengFromClaim(room, s2);
      return;
    }
  }

  // ④ 全员过：轮转下家摸牌
  drawAfterPass(room);
}

// 明杠成立：core 执行后杠者补摸一张，随后进入杠者出牌阶段（可能杠开）
function executeGangFromClaim(room, seat) {
  const game = room.gameData;
  room.claim = null;
  clearRoomTimers(room);

  const group = MJCore.doMingGang(game, seat);
  if (!group) { drawAfterPass(room); return; }   // 兜底：异常退回轮转
  const drawn = MJCore.drawTile(game);          // 杠后补摸（doMingGang 已保证牌墙非空）
  if (!drawn) { settleDraw(room); return; }
  enterDiscardPhase(room);
}

// 碰成立：core 执行后轮到碰者出牌
function executePengFromClaim(room, seat) {
  const game = room.gameData;
  room.claim = null;
  clearRoomTimers(room);

  const group = MJCore.doPeng(game, seat);
  if (!group) { drawAfterPass(room); return; }
  enterDiscardPhase(room);
}

// 全员过：轮转下家 → 摸牌；牌墙空则流局
function drawAfterPass(room) {
  const game = room.gameData;
  room.claim = null;
  clearRoomTimers(room);

  MJCore.passClaim(game);
  const drawn = MJCore.drawTile(game);
  if (!drawn) { settleDraw(room); return; }
  enterDiscardPhase(room);
}

/* ================================================================
 *  自摸胡 / 暗杠（自家出牌阶段的自主动作）
 * ================================================================ */

// 宣告胡牌：鸣牌窗口响应胡 / 自摸（含天胡·杠开）统一入口，由调用上下文分流
function declareHu(room, seat) {
  const game = room.gameData;
  if (!game || room.round) return { ok: false, error: '对局已结束' };
  const turn = game.turn;
  if (turn.phase === 'claim' && turn.pendingDiscard && turn.pendingDiscard.seat !== seat) {
    return respondClaim(room, seat, 'hu');
  }
  if (turn.phase === 'discard' && turn.currentSeat === seat) {
    const ev = MJCore.evaluateHu(game, seat, null);
    if (!ev.win) return { ok: false, error: '当前不构成胡牌' };
    if (ev.banned) return { ok: false, error: '零台杂牌禁止胡牌' };
    settleHu(room, seat, ev);
    return { ok: true, resolved: 'zimo' };
  }
  return { ok: false, error: '当前不能宣告胡牌' };
}

// 暗杠：core 执行后自动补摸一张，再进入出牌阶段（可能杠开）
function applyAnGang(room, seat, code) {
  const game = room.gameData;
  if (!game || room.round) return { ok: false, error: '对局已结束' };
  const turn = game.turn;
  if (turn.phase !== 'discard' || turn.currentSeat !== seat) {
    return { ok: false, error: '只有轮到你出牌时才能暗杠' };
  }
  const codes = MJCore.findAnGangCodes(game, seat);
  if (codes.indexOf(code) === -1) return { ok: false, error: '暗杠不合法' };

  clearRoomTimers(room);
  const group = MJCore.doAnGang(game, seat, code);
  if (!group) return { ok: false, error: '暗杠执行失败' };

  const drawn = MJCore.drawTile(game);   // 杠后补摸
  if (!drawn) { settleDraw(room); return { ok: true, resolved: 'draw' }; }
  enterDiscardPhase(room);
  return { ok: true, resolved: 'angang' };
}

// 补杠（加杠）：自家出牌阶段把碰组补成杠，随后进入抢杠胡窗口
//   core.doBuGang 已切 phase='claim' / pendingDiscard.gang=true；
//   别家可胡（抢杠胡，积分同点炮：杠者全额、其余减半）；三家皆过则杠者补摸。
function applyBuGang(room, seat, code) {
  const game = room.gameData;
  if (!game || room.round) return { ok: false, error: '对局已结束' };
  const turn = game.turn;
  if (turn.phase !== 'discard' || turn.currentSeat !== seat) {
    return { ok: false, error: '只有轮到你出牌时才能补杠' };
  }
  const codes = MJCore.findBuGangCodes(game, seat);
  if (codes.indexOf(code) === -1) return { ok: false, error: '补杠不合法' };

  const group = MJCore.doBuGang(game, seat, code);
  if (!group) return { ok: false, error: '补杠执行失败' };

  openClaimWindow(room);   // 启动抢杠胡响应窗口（room.claim + 超时）
  return { ok: true, resolved: 'bugang' };
}

/* ================================================================
 *  胡牌结算（判定顺序：禁胡已在引擎层拦截 → 顶级通杀 → 台数 → 积分）
 * ================================================================ */

function settleHu(room, seat, ev) {
  const game = room.gameData;
  const winner = seat;
  const winnerIsBanker = !!game.players[winner].isBanker;
  const streakActive = room.bankerStreak >= 2;   // 进入本局时的连庄翻倍状态
  let mult = 1;
  let streakNote = '';
  let nextBankerSeat;

  if (winnerIsBanker) {
    room.bankerStreak++;
    nextBankerSeat = winner;
    if (room.bankerStreak >= 2) {
      if (ev.top) {
        mult = 1;
        streakNote = '庄家连胡 ' + room.bankerStreak + ' 把（通杀牌型不参与翻倍）';
      } else {
        mult = 2;
        streakNote = '庄家连胡 ' + room.bankerStreak + ' 把，本局积分 ×2';
      }
    } else {
      streakNote = '庄家连庄 ' + room.bankerStreak + ' 把（再胡 1 把翻倍）';
    }
  } else {
    if (streakActive) {
      if (ev.top) {
        mult = 1;
        streakNote = '闲家胡牌，断庄（本局通杀牌型不参与翻倍，下局起取消连庄）';
      } else {
        mult = 2;
        streakNote = '闲家胡牌，断庄：本局连庄 ×2 结算，下局起取消翻倍';
      }
    } else {
      streakNote = '闲家胡牌，断庄（连庄计数清零）';
    }
    room.bankerStreak = 0;
    nextBankerSeat = winner;
  }

  game.turn.phase = 'over';
  game.turn.endReason = 'hu';
  game.turn.drawnTileId = null;
  room.claim = null;
  clearRoomTimers(room);

  // 台数 → 积分（打胡放炮全额/其余减半向上取整；自摸在场各家全额；顶级 128 通杀）
  const score = MJCore.calcScore(ev, game, { mult });

  // 模式：累计（从0累计）/ 带分（各家初始积分相同，余额=初始+累计，支付封顶到清零）
  const mode = room.options && room.options.mode === 'bankroll' ? 'bankroll' : 'cumulate';
  const initialScore = (room.options && room.options.initialScore) || 100;
  let actualPay = score.pay;
  let actualIncome = score.income;
  let cappedFlags = [false, false, false, false];
  let bankNote = '';

  if (mode === 'bankroll') {
    const balances = [0, 1, 2, 3].map(b => Math.max(0, initialScore + room.scores[b]));
    const capped = MJCore.capPayByBalance(score, balances, winner);
    actualPay = capped.pay;
    actualIncome = capped.income;
    cappedFlags = capped.capped;
    const capNames = [];
    for (let ck = 0; ck < 4; ck++) if (capped.capped[ck]) capNames.push(SEAT_LABELS[ck]);
    if (capNames.length) bankNote = capNames.join('、') + ' 积分不足，仅支付至清零';
  }

  room.scores[winner] += actualIncome;
  for (let k = 0; k < 4; k++) room.scores[k] -= actualPay[k];

  // 带分模式：任意在场家余额归零 → 本场结束（全部确认后重开新场恢复初始积分）
  let bustedSeats = [];
  if (mode === 'bankroll') {
    for (let bk = 0; bk < playerCountOf(room); bk++) {
      if (initialScore + room.scores[bk] <= 0) bustedSeats.push(bk);
    }
    if (bustedSeats.length) {
      room.sessionBusted = true;
      bankNote += (bankNote ? '\n' : '') +
        bustedSeats.map(b => SEAT_LABELS[b]).join('、') +
        ' 积分清零，本场结束！确认后重开新场，各家恢复初始积分 ' + initialScore + ' 分';
    }
  }

  room.bankerSeat = nextBankerSeat;   // 下局庄家（谁胡谁坐庄；庄胡连坐）

  const wayText = wayTextOf(ev);

  room.round = {
    result: 'hu',
    confirms: [false, false, false, false],
    settlement: {
      winnerSeat: winner,
      winType: ev.winType,
      fromSeat: ev.fromSeat,
      top: !!ev.top,
      tai: ev.tai,
      unit: score.unit,
      mult: score.mult,
      patterns: ev.patterns.map(p => ({ key: p.key, name: p.name, tai: p.tai, top: !!p.top })),
      pay: actualPay.slice(),
      income: actualIncome,
      capped: cappedFlags.slice(),
      mode,
      initialScore,
      balances: mode === 'bankroll'
        ? [0, 1, 2, 3].map(b => Math.max(0, initialScore + room.scores[b]))
        : null,
      bustedSeats: bustedSeats.slice(),
      bankNote,
      wayText: wayText,
      streakNote: streakNote,
      scoresAfter: room.scores.slice()
    }
  };
}

// 胡牌方式文案
function wayTextOf(ev) {
  if (ev.winType === 'zimo') {
    if (ev.tianhu) return '天胡（自摸通杀）';
    if (ev.ziyise) return '字一色（自摸通杀）';
    if (ev.gangkai) return '杠上开花（自摸）';
    return '自摸胡牌';
  }
  const fromName = seatName(ev.fromSeat);
  if (ev.winType === 'qianggang') return '抢杠胡：抢 ' + fromName + ' 的补杠';
  if (ev.dihu) return '地胡（点炮通杀）：' + fromName + ' 首张点炮';
  if (ev.ziyise) return '字一色（点炮通杀）：' + fromName + ' 点炮';
  return '点炮胡：' + fromName + ' 打出牌点炮';
}

/* ================================================================
 *  流局（牌墙摸完：连庄不清零、庄家继续坐、本局不计分）
 * ================================================================ */

function settleDraw(room) {
  const game = room.gameData;
  game.turn.phase = 'over';
  game.turn.endReason = 'wallEmpty';
  game.turn.drawnTileId = null;
  room.claim = null;
  clearRoomTimers(room);
  // room.bankerSeat 不变；room.bankerStreak 不清零

  room.round = {
    result: 'draw',
    confirms: [false, false, false, false],
    settlement: null
  };
}

/* ================================================================
 *  再来一局：四家全部确认 → 重新翻财神/洗牌发牌
 * ================================================================ */

function confirmNextRound(room, seat) {
  if (!room.round) return { ok: false, error: '当前不在结算阶段' };
  room.round.confirms[seat] = true;
  // 仅统计在场活动座位
  const pc = playerCountOf(room);
  let n = 0;
  for (let s = 0; s < pc; s++) if (room.round.confirms[s]) n++;
  if (n === pc) {
    beginNextRound(room);
  }
  return { ok: true, confirmed: n };
}

function beginNextRound(room) {
  // 带分模式且本场有人清零：确认后重开新场，各家积分清零、连庄清零、随机庄家
  if (room.sessionBusted) {
    room.scores = [0, 0, 0, 0];
    room.bankerStreak = 0;
    room.bankerSeat = Math.floor(Math.random() * playerCountOf(room));
    room.sessionBusted = false;
  }
  room.round = null;
  room.claim = null;
  createGameForRoom(room);   // 重新翻财神、洗牌、发牌（累计模式积分保留）
}

/* ================================================================
 *  出牌超时自动打（永不打财神）
 * ================================================================ */

function expireDiscardTurn(room) {
  const game = room.gameData;
  if (!game || room.round || game.turn.phase !== 'discard') return;
  const seat = game.turn.currentSeat;
  const pick = MJCore.pickRandomDiscard(game, seat);   // 铁律：非财神真牌优先
  if (!pick) return;
  const tile = MJCore.discardTile(game, seat, pick.id);
  if (!tile) return;
  game.turn.lastDiscard = { seat, tileId: tile.id };
  openClaimWindow(room);
  notifyChanged(room);
}

/* ================================================================
 *  视角化序列化（他人手牌正常不下发；结算阶段全员亮牌核对）
 * ================================================================ */

function groupJSON(group) {
  return {
    type: group.type,
    cai: !!group.cai,
    fromSeat: group.fromSeat,
    tiles: group.tiles.map(t => ({ id: t.id, code: t.code }))
  };
}

function serializeFor(room, viewerSeat) {
  const game = room.gameData;
  if (!game) return null;
  const isOver = game.turn.phase === 'over';

  const players = game.players.map((corePlayer, seat) => {
    const seatInfo = room.players.get(seat);
    const base = {
      seat,
      name: seatInfo ? seatInfo.name : '玩家',
      online: seatInfo ? seatInfo.online : false,
      isAI: seatInfo ? !!seatInfo.isAI : false,
      aiTakeover: seatInfo ? !!seatInfo.aiTakeover : false,
      isBanker: !!corePlayer.isBanker,
      handCount: corePlayer.hand.length,
      peng: corePlayer.peng.map(groupJSON),
      gang: corePlayer.gang.map(groupJSON),
      discards: corePlayer.discards.map(t => ({ id: t.id, code: t.code })),
      claimResp: room.claim && room.claim.responses[seat] ? room.claim.responses[seat] : null,
      hand: null
    };
    // 安全铁律：任何阶段都只下发【本人】手牌明文；他人手牌只给 handCount
    if (seat === viewerSeat) {
      base.hand = corePlayer.hand.map(t => ({ id: t.id, code: t.code }));
    }
    return base;
  });

  // 观察者视角的可用动作（前端绝不自行判定）
  let myActions = null;
  if (!isOver) {
    if (game.turn.phase === 'claim' && game.turn.pendingDiscard &&
        game.turn.pendingDiscard.seat !== viewerSeat) {
      const elig = claimEligibility(room, viewerSeat);
      myActions = {
        window: 'claim',
        gangClaim: !!game.turn.pendingDiscard.gang,   // 抢杠胡窗口：仅可胡/过
        hu: elig.hu, gang: elig.gang, peng: elig.peng,
        responded: !!room.claim.responses[viewerSeat]
      };
    } else if (game.turn.phase === 'discard' && game.turn.currentSeat === viewerSeat) {
      const self = selfEligibility(room, viewerSeat);
      myActions = {
        window: 'self', hu: self.hu,
        angang: self.angang.slice(), bugang: self.bugang.slice()
      };
    }
  } else if (room.round) {
    myActions = {
      window: 'settle',
      confirmed: room.round.confirms[viewerSeat]
    };
  }

  const pc = playerCountOf(room);
  const mode = room.options && room.options.mode === 'bankroll' ? 'bankroll' : 'cumulate';
  const initialScore = (room.options && room.options.initialScore) || 100;

  return {
    roomId: room.id,
    phase: 'playing',
    playerCount: pc,
    mode,
    initialScore,
    balances: mode === 'bankroll'
      ? [0, 1, 2, 3].map(s => Math.max(0, initialScore + room.scores[s]))
      : null,
    sessionBusted: !!room.sessionBusted,
    bankerSeat: room.bankerSeat,        // 结算时=下局庄家；开局新局后与 game.bankerSeat 一致
    roundBankerSeat: game.bankerSeat,   // 本局庄家（结算阶段展示用）
    bankerStreak: room.bankerStreak,
    scores: room.scores.slice(),
    dice: game.wall.dice.slice(),
    indicator: { id: game.indicator.id, code: game.indicator.code },
    wilds: game.wilds.slice(),
    wallCount: game.deck.length,
    wallStacks: MJCore.wallSnapshot(game),
    turn: {
      currentSeat: game.turn.currentSeat,
      phase: game.turn.phase,
      drawnTileId: game.turn.drawnTileId,
      endReason: game.turn.endReason,
      lastDiscard: game.turn.lastDiscard || null
    },
    claim: room.claim ? {
      fromSeat: game.turn.pendingDiscard.seat,
      gangClaim: !!game.turn.pendingDiscard.gang,
      tile: { code: game.turn.pendingDiscard.tile.code },
      responses: responderSeats(room).map(s => ({
        seat: s, action: room.claim.responses[s] || null
      }))
    } : null,
    round: room.round ? {
      result: room.round.result,
      confirms: room.round.confirms.slice(),
      settlement: room.round.settlement
    } : null,
    myActions,
    players
  };
}

/* ---------------- 工具 ---------------- */

function clearRoomTimers(room) {
  if (!room.timers) { room.timers = {}; return; }
  if (room.timers.claim) { clearTimeout(room.timers.claim); delete room.timers.claim; }
  if (room.timers.discard) { clearTimeout(room.timers.discard); delete room.timers.discard; }
}

const SEAT_LABELS = ['东家', '南家', '西家', '北家'];
function seatName(seat) {
  return SEAT_LABELS[seat] || '';
}

module.exports = {
  events,
  createGameForRoom,
  serializeFor,
  applyPlayCard,
  respondClaim,
  declareHu,   // AI 自摸胡统一入口
  applyAnGang,
  applyBuGang,
  confirmNextRound,
  expireClaimWindow,
  expireDiscardTurn,
  // 供测试直接调用的内部事实/流程
  claimEligibility,
  selfEligibility,
  winSeatsOf,
  claimOptionsOf,
  settleDraw,
  drawAfterPass
};
