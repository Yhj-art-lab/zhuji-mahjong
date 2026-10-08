/**
 * ai-player.js —— 联机后端【AI 驱动模块】（阶段6）
 *
 * 职责：驱动房间里所有"AI 接管座位"行动，决策完全复用单机 AI 构建块
 * （mahjong-core.js 的 pickSmartDiscard / findAnGangCodes / findBuGangCodes）：
 *   · 出牌阶段：暗杠 → 补杠（进入抢杠胡窗口）→ 智能出牌（孤张先打、永不打财神）
 *   · 鸣牌窗口：按 胡 > 杠 > 碰 > 过 自动响应（与单机电脑一致）
 *   · 结算阶段：自动点【再来一局】确认，避免堵住流程
 *
 * AI 座位判定：player.isAI（房间配置自动补座）或 player.aiTakeover（真人断线接管）。
 * 本模块不改规则，所有动作都通过 game-engine.js 的权威入口执行。
 */
'use strict';

const { EventEmitter } = require('events');
const MJCore = require('../mahjong-core.js');
const Engine = require('./game-engine.js');

const AI_THINK_MS = process.env.AI_THINK_MS
  ? Number(process.env.AI_THINK_MS) : 700;   // AI 思考间隔（节奏同单机）

const events = new EventEmitter();

// 该座位当前是否由 AI 驾驶
function isAiDriven(room, seat) {
  const p = room.players && room.players.get(seat);
  return !!(p && (p.isAI || p.aiTakeover));
}

function clearAiTimer(room) {
  if (room.aiTimer) { clearTimeout(room.aiTimer); room.aiTimer = null; }
}

// 入口：观察房间，若存在待行动的 AI 座位 → 延时执行
function pump(room) {
  if (!room || room.phase !== 'playing' || !room.gameData) return;
  clearAiTimer(room);
  room.aiTimer = setTimeout(() => tick(room), AI_THINK_MS);
}

function stop(room) {
  clearAiTimer(room);
}

function tick(room) {
  room.aiTimer = null;
  if (room.phase !== 'playing') return;
  const game = room.gameData;
  if (!game) return;

  const pc = game.playerCount || 4;

  // ① 结算阶段：AI 座位自动确认下一局（仅在场座位）
  if (room.round) {
    for (let seat = 0; seat < pc; seat++) {
      if (isAiDriven(room, seat) && !room.round.confirms[seat]) {
        acted(Engine.confirmNextRound(room, seat), room);
        return;
      }
    }
    return;
  }

  if (game.turn.phase === 'over') return;

  // ② 出牌阶段：当前座位是 AI → 自主行动
  if (game.turn.phase === 'discard') {
    const seat = game.turn.currentSeat;
    if (isAiDriven(room, seat)) { aiSelfTurn(room, seat); }
    return;
  }

  // ③ 鸣牌窗口：找到第一个待响应的 AI 座位（一次一个，节奏自然）
  if (game.turn.phase === 'claim') {
    const pd = game.turn.pendingDiscard;
    if (!pd) return;
    for (let i = 1; i < pc; i++) {
      const s = (pd.seat + i) % pc;
      if (isAiDriven(room, s) && room.claim && !room.claim.responses[s]) {
        aiClaimRespond(room, s);
        return;
      }
    }
  }
}

// AI 自家出牌阶段（顺序：自摸胡 > 暗杠 > 补杠 > 智能出牌）
function aiSelfTurn(room, seat) {
  const game = room.gameData;

  // 自摸胡最优先（含天胡/杠开）
  const ev = MJCore.evaluateHu(game, seat, null);
  if (ev.win && !ev.banned) {
    acted(Engine.declareHu(room, seat), room);
    return;
  }

  // 暗杠优先
  const anCodes = MJCore.findAnGangCodes(game, seat);
  if (anCodes.length) {
    acted(Engine.applyAnGang(room, seat, anCodes[0]), room);
    return;
  }

  // 其次补杠（碰组摸到第 4 张 → 抢杠胡窗口）
  const buCodes = MJCore.findBuGangCodes(game, seat);
  if (buCodes.length) {
    acted(Engine.applyBuGang(room, seat, buCodes[0]), room);
    return;
  }

  // 智能出牌（孤张先打、保留搭子/对子/刻子）；兜底随机；永不打财神
  let pick = MJCore.pickSmartDiscard(game, seat) ||
             MJCore.pickRandomDiscard(game, seat);
  if (pick && game.wilds.indexOf(pick.code) !== -1) {
    const safe = game.players[seat].hand
      .filter(t => game.wilds.indexOf(t.code) === -1)[0];
    if (safe) pick = safe;
  }
  if (!pick) return;

  acted(Engine.applyPlayCard(room, seat, pick.id), room);
}

// AI 鸣牌窗口响应：胡 > 杠 > 碰 > 过
function aiClaimRespond(room, seat) {
  const elig = Engine.claimEligibility(room, seat);
  let action = 'pass';
  if (elig.hu) action = 'hu';
  else if (elig.gang) action = 'gang';
  else if (elig.peng) action = 'peng';
  acted(Engine.respondClaim(room, seat, action), room);
}

// 动作执行成功 → 通知 server 广播 + 继续驱动下一拍
function acted(result, room) {
  if (result && result.ok) events.emit('acted', room);
}

module.exports = {
  pump,
  stop,
  isAiDriven,
  events,
  AI_THINK_MS
};
