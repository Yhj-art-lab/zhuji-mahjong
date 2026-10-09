/**
 * 诸暨麻将 · 联机对战后端
 * 阶段 1：骨架 + createRoom / joinRoom / leaveRoom 基础通信
 * 阶段 2：toggleReady 准备机制，4 人全准备 gameStart
 * 阶段 3：玩家 token 身份 + rejoinRoom 断线重连（页面跳转/刷新不丢座）；
 *         4 人全准备后后端创建权威对局（翻财神/洗牌/发牌），gameStateUpdate 下发
 *
 * 所有麻将权威规则由 mahjong-core.js + game-engine.js 在后端执行。
 */
const path = require('path');
const http = require('http');
const crypto = require('crypto');
// 依赖可选：缺少 express/socket.io（如纯规则测试环境）时模块仍可被 require，
// 仅网络服务不启动；房间纯逻辑函数通过 module.exports 供测试调用。
function tryRequire(name) {
  try { return require(name); } catch (e) { return null; }
}
const express = tryRequire('express');
const socketio = tryRequire('socket.io');
const Server = socketio ? socketio.Server : null;
const SOCKET_READY = !!(express && Server);

const Engine = require('./game-engine.js');
const AIPlayer = require('./ai-player.js');

const PORT = process.env.PORT || 3000;
const ROOM_SIZE = 4;
const REJOIN_GRACE_MS = process.env.REJOIN_GRACE_MS
  ? Number(process.env.REJOIN_GRACE_MS)
  : 20000;   // 等待大厅断线保留座位 20 秒
// 对局中真人全部离线后，闲置房间多久回收（默认 30 分钟；AI 会继续把牌打完）
const IDLE_ROOM_TTL_MS = process.env.IDLE_ROOM_TTL_MS
  ? Number(process.env.IDLE_ROOM_TTL_MS) : 30 * 60 * 1000;
const GC_INTERVAL_MS = 60 * 1000;

let app = null;
let server = null;
let io = null;
if (SOCKET_READY) {
  app = express();
  server = http.createServer(app);
  io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] }
  });

  // 联机前端静态资源
  // server.js 既可能在 backend/ 子目录（本地开发），也可能在仓库根目录（Render 上散放），自动适配
  const serverDirName = path.basename(__dirname);
  const repoRoot = serverDirName === 'backend' ? path.join(__dirname, '..') : __dirname;
  app.use(express.static(path.join(repoRoot, 'client')));

  // 单机模式：仅暴露原单机版 5 个文件（白名单），单机模式完整保留
  const singleRoot = repoRoot;
  const SINGLE_FILES = new Set(['index.html', 'game.js', 'mahjong-core.js', 'style.css', 'audio-manager.js']);
  app.get('/single/:file', (req, res) => {
    if (!SINGLE_FILES.has(req.params.file)) return res.status(404).end();
    res.sendFile(path.join(singleRoot, req.params.file));
  });
}

/* ---------------- 房间 / 身份数据 ---------------- */
// roomId(4位) -> { id, phase:'waiting'|'playing', bankerSeat, gameData,
//                  players: Map<seat,{seat,name,socketId,ready,online,token}>,
//                  cleanupTimers: { [seat]: Timeout } }
const rooms = new Map();

// 玩家身份凭证：token -> { roomId, seat }（页面跳转新 socket 靠它认回原座位）
const tokenIndex = new Map();

const SEAT_NAMES = ['东家', '南家', '西家', '北家'];

function genRoomId() {
  let id;
  do { id = String(1000 + Math.floor(Math.random() * 9000)); }
  while (rooms.has(id));
  return id;
}
function genToken() {
  let t;
  do { t = crypto.randomBytes(8).toString('hex'); }
  while (tokenIndex.has(t));
  return t;
}

// 房间等待大厅状态（配置与座位在线状态一并下发）
function roomState(room) {
  const pc = roomPlayerCount(room);
  return {
    roomId: room.id,
    phase: room.phase,
    options: {
      aiFill: !!(room.options && room.options.aiFill),
      playerCount: pc,
      mode: room.options && room.options.mode === 'bankroll' ? 'bankroll' : 'cumulate',
      initialScore: (room.options && room.options.initialScore) || 100
    },
    players: [0, 1, 2, 3].map(seat => {
      const p = room.players.get(seat);
      return p ? {
        seat, name: p.name, ready: p.ready, online: p.online,
        isAI: !!p.isAI
      } : null;
    })
  };
}

function broadcastRoom(room) {
  io.to(room.id).emit('roomState', roomState(room));
}

// 向房间所有在线客户端推送其各自视角的完整对局状态；随后驱动 AI
function pushGameState(room) {
  let humanOnline = false;
  for (const p of room.players.values()) {
    if (!p.isAI && p.online && !p.aiTakeover) humanOnline = true;
    if (!p.online || !p.socketId) continue;
    const state = Engine.serializeFor(room, p.seat);
    io.to(p.socketId).emit('gameStateUpdate', state);
  }
  if (humanOnline) room.lastHumanAt = Date.now();
  AIPlayer.pump(room);
}

// 引擎定时器（超时自动过/自动出牌）改完状态 → 立即广播
Engine.events.on('roomChanged', room => pushGameState(room));
// AI 动作完成 → 广播 + 继续驱动
AIPlayer.events.on('acted', room => pushGameState(room));

function ts() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

/* ---------------- Socket ---------------- */
if (SOCKET_READY) io.on('connection', (socket) => {
  socket.data = {};
  console.log(`[${ts()}] [连接] 客户端接入: ${socket.id}`);

  // 创建房间：创建者坐 0 号位
  socket.on('createRoom', (payload, ack) => {
    if (socket.data.roomId) {
      if (ack) ack({ ok: false, error: '你已在房间中' });
      return;
    }
    const name = cleanName(payload && payload.name);
    const optsIn = (payload && payload.options) || {};
    const aiFill = !!optsIn.aiFill;
    // 组局人数 2/3/4（默认4）
    let playerCount = Number(optsIn.playerCount);
    if (playerCount !== 2 && playerCount !== 3) playerCount = 4;
    // 模式：cumulate 累计 / bankroll 带分
    const mode = optsIn.mode === 'bankroll' ? 'bankroll' : 'cumulate';
    // 带分初始积分：整数 ≥10（默认100）
    let initialScore = Math.floor(Number(optsIn.initialScore));
    if (!isFinite(initialScore) || initialScore < 10) initialScore = 100;

    const roomId = genRoomId();
    const token = genToken();
    const players = new Map();
    players.set(0, { seat: 0, name, socketId: socket.id, ready: false, online: true, token });
    rooms.set(roomId, {
      id: roomId, phase: 'waiting', bankerSeat: null, gameData: null,
      bankerStreak: 0, scores: [0, 0, 0, 0],
      options: { aiFill, playerCount, mode, initialScore },
      lastHumanAt: Date.now(),
      claim: null, round: null, timers: {},
      players, cleanupTimers: {}, aiTimer: null, sessionBusted: false
    });
    tokenIndex.set(token, { roomId, seat: 0 });

    socket.data = { roomId, seat: 0, name, token };
    socket.join(roomId);

    console.log(`[${ts()}] [创建] ${name} 创建房间 ${roomId}（${playerCount}人 · ${mode === 'bankroll' ? '带分' + initialScore : '累计'}），座位 东家`);
    if (ack) ack({ ok: true, roomId, seat: 0, token });
    broadcastRoom(rooms.get(roomId));
  });

  // 加入房间：自动分配最小空座位
  socket.on('joinRoom', (payload, ack) => {
    if (socket.data.roomId) {
      if (ack) ack({ ok: false, error: '你已在房间中' });
      return;
    }
    const roomId = String((payload && payload.roomId) || '').trim();
    const room = rooms.get(roomId);
    if (!room) {
      if (ack) ack({ ok: false, error: '房间不存在' });
      return;
    }
    if (room.phase === 'playing') {
      if (ack) ack({ ok: false, error: '对局已开始，无法中途加入' });
      return;
    }
    const pc = roomPlayerCount(room);
    let seat = -1;
    for (let s = 0; s < pc; s++) {
      if (!room.players.has(s)) { seat = s; break; }
    }
    if (seat === -1) {
      if (ack) ack({ ok: false, error: '房间已满（' + pc + ' 人局）' });
      return;
    }
    const name = cleanName(payload && payload.name);
    const token = genToken();
    room.players.set(seat, { seat, name, socketId: socket.id, ready: false, online: true, token });
    tokenIndex.set(token, { roomId, seat });

    socket.data = { roomId, seat, name, token };
    socket.join(roomId);

    console.log(`[${ts()}] [加入] ${name} 加入房间 ${roomId}，座位 ${SEAT_NAMES[seat]}（当前 ${room.players.size}/${pc}）`);
    if (ack) ack({ ok: true, roomId, seat, token });
    broadcastRoom(room);
  });

  // 重连入房：页面跳转 / 刷新产生新 socket，凭 token 认回原座位（取消断线清理）
  socket.on('rejoinRoom', (payload, ack) => {
    const token = String((payload && payload.token) || '');
    const rec = tokenIndex.get(token);
    if (!rec) {
      if (ack) ack({ ok: false, error: '身份已失效，请重新创建/加入房间' });
      return;
    }
    const room = rooms.get(rec.roomId);
    const player = room ? room.players.get(rec.seat) : null;
    if (!player || player.token !== token) {
      if (ack) ack({ ok: false, error: '座位已不存在' });
      return;
    }
    if (socket.data.roomId) {
      if (ack) ack({ ok: false, error: '连接状态异常' });
      return;
    }

    // 取消该座位的断线清理
    if (room.cleanupTimers[rec.seat]) {
      clearTimeout(room.cleanupTimers[rec.seat]);
      delete room.cleanupTimers[rec.seat];
    }

    player.socketId = socket.id;
    player.online = true;
    player.aiTakeover = false;   // 真人回来，收回 AI 接管权
    socket.data = { roomId: room.id, seat: rec.seat, name: player.name, token };
    socket.join(room.id);

    console.log(`[${ts()}] [重连] ${player.name} 凭身份回到房间 ${room.id}，座位 ${SEAT_NAMES[rec.seat]}`);
    if (ack) ack({ ok: true, roomId: room.id, seat: rec.seat });
    broadcastRoom(room);

    // 已有对局 → 立即给该连接推送其视角的完整状态
    if (room.gameData) {
      socket.emit('gameStateUpdate', Engine.serializeFor(room, rec.seat));
    }
  });

  // 房间配置开关（仅房主、等待阶段）：空位是否由 AI 自动补位
  socket.on('setRoomOptions', (payload, ack) => {
    const room = getRoomOf(socket);
    const player = getPlayerOf(socket, room);
    if (!player) {
      if (ack) ack({ ok: false, error: '你不在房间中' });
      return;
    }
    if (room.phase !== 'waiting' || player.seat !== 0) {
      if (ack) ack({ ok: false, error: '只有房主在等待阶段可修改配置' });
      return;
    }
    const aiFill = !!(payload && payload.aiFill);
    room.options.aiFill = aiFill;
    // 条件变化，所有人重新准备
    for (const p of room.players.values()) p.ready = false;
    if (ack) ack({ ok: true, options: roomState(room).options });
    broadcastRoom(room);
  });

  // 准备 / 取消准备
  socket.on('toggleReady', (_payload, ack) => {
    const room = getRoomOf(socket);
    const player = getPlayerOf(socket, room);
    if (!player) {
      if (ack) ack({ ok: false, error: '你不在房间中' });
      return;
    }
    if (room.phase !== 'waiting') {
      if (ack) ack({ ok: false, error: '对局已开始' });
      return;
    }
    player.ready = !player.ready;
    console.log(`[${ts()}] [准备] ${player.name} ${player.ready ? '已准备' : '取消准备'}（房间 ${room.id}）`);
    if (ack) ack({ ok: true, ready: player.ready });

    // 开局条件：
    //   aiFill 开启 → 在场真人全部准备即可（空位由 AI 补，至少 1 名真人）
    //   否则 → 必须 4 人到齐全准备
    if (canStart(room)) {
      if (room.options.aiFill) fillAiSeats(room);
      room.phase = 'playing';
      Engine.createGameForRoom(room);
      const aiN = roomPlayerCount(room) - humanCount(room);
      console.log(`[${ts()}] [开局] 房间 ${room.id} 开局（${roomPlayerCount(room)}人局：真人 ${humanCount(room)} 位 + AI ${aiN} 位），翻财神/洗牌/发牌完成`);
      broadcastRoom(room);
      io.to(room.id).emit('gameStart', { roomId: room.id });
      // 新连接理论尚未产生（客户端收到 gameStart 才跳转），这里也补推一次状态兜底
      pushGameState(room);
    } else {
      broadcastRoom(room);
    }
  });

  // 出牌（阶段4）：客户端只发 playCard，所有权威判定与回合轮转在后端完成
  socket.on('playCard', (payload, ack) => {
    const room = getRoomOf(socket);
    const player = getPlayerOf(socket, room);
    if (!player || !room.gameData) {
      if (ack) ack({ ok: false, error: '你不在对局中' });
      return;
    }
    const tileId = payload ? payload.tileId : null;
    const result = Engine.applyPlayCard(room, player.seat, tileId);
    if (ack) ack(result);
    if (!result.ok) {
      console.log(`[${ts()}] [出牌拒绝] ${player.name}：${result.error}`);
      return;
    }
    console.log(`[${ts()}] [出牌] ${player.name} 打出 ${result.discarded.code}，鸣牌窗口开启`);
    // 广播房间全部在线玩家其各自视角的最新状态（含各自动作资格）
    pushGameState(room);
  });

  /* ---------- 阶段5：鸣牌（胡/杠/碰/过）、暗杠 ---------- */

  // 胡牌：鸣牌窗口点胡 / 自家出牌阶段自摸（天胡、杠开）统一由引擎分流
  socket.on('hu', (_payload, ack) => {
    const room = getRoomOf(socket);
    const player = getPlayerOf(socket, room);
    if (!player || !room.gameData) {
      if (ack) ack({ ok: false, error: '你不在对局中' });
      return;
    }
    const result = Engine.declareHu(room, player.seat);
    if (ack) ack(result);
    if (!result.ok) {
      console.log(`[${ts()}] [胡牌拒绝] ${player.name}：${result.error}`);
      return;
    }
    const r = room.round && room.round.settlement;
    console.log(`[${ts()}] [胡牌] ${player.name} ${r ? r.wayText : ''} 本局台数 ${r ? r.tai : '-'}，收入 ${r ? r.income : '-'}`);
    pushGameState(room);
  });

  // 明杠（鸣下别家打出的牌）
  socket.on('gang', (_payload, ack) => {
    handleClaim(socket, 'gang', ack);
  });

  // 碰（正碰/财碰/双财碰）
  socket.on('peng', (_payload, ack) => {
    handleClaim(socket, 'peng', ack);
  });

  // 过（放弃鸣牌）
  socket.on('pass', (_payload, ack) => {
    handleClaim(socket, 'pass', ack);
  });

  // 暗杠：payload.code 指定杠哪一码
  socket.on('angang', (payload, ack) => {
    const room = getRoomOf(socket);
    const player = getPlayerOf(socket, room);
    if (!player || !room.gameData) {
      if (ack) ack({ ok: false, error: '你不在对局中' });
      return;
    }
    const code = payload ? payload.code : null;
    const result = Engine.applyAnGang(room, player.seat, code);
    if (ack) ack(result);
    if (!result.ok) {
      console.log(`[${ts()}] [暗杠拒绝] ${player.name}：${result.error}`);
      return;
    }
    if (result.resolved === 'draw') {
      console.log(`[${ts()}] [暗杠] ${player.name} 暗杠 ${code} 后牌墙摸完，流局`);
    } else {
      console.log(`[${ts()}] [暗杠] ${player.name} 暗杠 ${code}，补摸一张继续出牌`);
    }
    pushGameState(room);
  });

  // 补杠（阶段6）：碰组补第 4 张，进入抢杠胡窗口
  socket.on('bugang', (payload, ack) => {
    const room = getRoomOf(socket);
    const player = getPlayerOf(socket, room);
    if (!player || !room.gameData) {
      if (ack) ack({ ok: false, error: '你不在对局中' });
      return;
    }
    const code = payload ? payload.code : null;
    const result = Engine.applyBuGang(room, player.seat, code);
    if (ack) ack(result);
    if (!result.ok) {
      console.log(`[${ts()}] [补杠拒绝] ${player.name}：${result.error}`);
      return;
    }
    console.log(`[${ts()}] [补杠] ${player.name} 补杠 ${code}，等待别家响应（可被抢杠胡）`);
    pushGameState(room);
  });

  /* ---------- 阶段5：结算 → 再来一局 ---------- */

  // 再来一局确认：四家全部确认后，后端重新翻财神/洗牌开局
  socket.on('nextRound', (_payload, ack) => {
    const room = getRoomOf(socket);
    const player = getPlayerOf(socket, room);
    if (!player || !room.gameData) {
      if (ack) ack({ ok: false, error: '你不在对局中' });
      return;
    }
    const result = Engine.confirmNextRound(room, player.seat);
    if (ack) ack(result);
    if (!result.ok) {
      console.log(`[${ts()}] [再来一局拒绝] ${player.name}：${result.error}`);
      return;
    }
    console.log(`[${ts()}] [再来一局] ${player.name} 已确认（${result.confirmed}/4）`);
    if (result.confirmed === 4) {
      console.log(`[${ts()}] [新局] 房间 ${room.id} 四人确认完毕，重新翻财神/洗牌开局`);
    }
    pushGameState(room);
  });

  // 主动离开：
  //   等待阶段 → 立即移除座位；
  //   对局阶段 → 注销身份，座位交给 AI 永久顶替打完（房间不销毁）。
  socket.on('leaveRoom', () => {
    const room = getRoomOf(socket);
    if (!room) return;
    const player = getPlayerOf(socket, room);
    if (player) tokenIndex.delete(player.token);

    if (room.phase === 'waiting') {
      removeSeat(room, socket.data.seat, false);
    } else if (player && !player.isAI) {
      player.isAI = true;            // 永久 AI 顶替
      player.aiTakeover = false;
      player.online = true;          // UI 显示为在场电脑
      player.socketId = null;
      console.log(`[${ts()}] [离席] ${player.name} 对局中离开，座位交 AI 打完本局`);
      pushGameState(room);
    }
    socket.data = {};
  });

  // 断线（浏览器关闭/网络断开）：
  //   等待阶段 → 离线保留座位进入宽限期，期满清座（页面刷新可凭 token 回来）；
  //   对局阶段 → 不销毁房间、不清座位，立即交 AI 接管，真人可随时凭 token 回来收回。
  socket.on('disconnect', () => {
    const room = getRoomOf(socket);
    if (!room) {
      console.log(`[${ts()}] [断开] 客户端离开: ${socket.id}`);
      return;
    }
    const player = getPlayerOf(socket, room);

    if (room.phase === 'playing' && player && !player.isAI) {
      player.online = false;
      player.socketId = null;
      player.aiTakeover = true;      // AI 立即接管打完本局（token 保留，随时可回）
      console.log(`[${ts()}] [断开] ${player.name} 对局中断线，座位已交 AI 接管，可凭身份随时回来`);
      broadcastRoom(room);
      pushGameState(room);
      return;
    }

    console.log(`[${ts()}] [断开] ${player ? player.name : socket.id} 断线，座位保留 ${REJOIN_GRACE_MS / 1000} 秒等待重连`);
    if (player) {
      player.online = false;
      player.socketId = null;
      broadcastRoom(room);

      const seat = socket.data.seat;
      const token = player.token;
      if (room.cleanupTimers[seat]) clearTimeout(room.cleanupTimers[seat]);
      room.cleanupTimers[seat] = setTimeout(() => {
        delete room.cleanupTimers[seat];
        // 宽限期满仍未重连 → 彻底清空座位
        tokenIndex.delete(token);
        console.log(`[${ts()}] [移除] 座位 ${SEAT_NAMES[seat]} 重连超时，清空座位`);
        removeSeat(room, seat, true);
      }, REJOIN_GRACE_MS);
    }
  });
});

/**
 * 彻底移除座位（仅等待阶段使用）
 * 其余玩家准备全部重置（人数条件变化，须重新准备）；最后一人离开 → 销毁房间
 */
function removeSeat(room, seat, fromTimeout) {
  if (!room.players.has(seat)) return;
  room.players.delete(seat);

  if (room.players.size === 0) {
    destroyRoom(room);
    console.log(`[${ts()}] [销毁] 房间 ${room.id} 已无人，自动销毁`);
    return;
  }
  for (const p of room.players.values()) p.ready = false;
  broadcastRoom(room);
}

/* ---------------- AI 补座 / 开局条件 ---------------- */

const AI_NAME_CHARS = ['东', '南', '西', '北'];

// 真人（非 AI）座位数
function humanCount(room) {
  let n = 0;
  for (const p of room.players.values()) if (!p.isAI) n++;
  return n;
}

// 房间配置人数（2/3/4，默认4）
function roomPlayerCount(room) {
  const n = room.options && room.options.playerCount;
  return (n === 2 || n === 3) ? n : ROOM_SIZE;
}

// 空位补 AI（开局前调用，只补到配置人数）
function fillAiSeats(room) {
  const pc = roomPlayerCount(room);
  for (let s = 0; s < pc; s++) {
    if (room.players.has(s)) continue;
    room.players.set(s, {
      seat: s,
      name: '电脑' + AI_NAME_CHARS[s],
      socketId: null, ready: true, online: true, token: null,
      isAI: true, aiTakeover: false
    });
  }
}

// 开局条件
function canStart(room) {
  if (humanCount(room) === 0) return false;
  const humansReady = [...room.players.values()]
    .filter(p => !p.isAI).every(p => p.ready);
  if (!humansReady) return false;
  const pc = roomPlayerCount(room);
  // 统计在场真人是否已坐满配置座位（AI 补位开关决定空位是否允许留空）
  const seatedHumans = [...room.players.values()].filter(p => !p.isAI).length;
  if (room.options.aiFill) return true;
  return seatedHumans === pc;
}

/* ---------------- 闲置房间回收 ---------------- */

// 清理房间全部定时器并从房间表移除
function destroyRoom(room) {
  AIPlayer.stop(room);
  if (room.aiTimer) { clearTimeout(room.aiTimer); room.aiTimer = null; }
  if (room.timers) {
    clearTimeout(room.timers.claim);
    clearTimeout(room.timers.discard);
  }
  Object.values(room.cleanupTimers || {}).forEach(clearTimeout);
  rooms.delete(room.id);
}

// 周期清扫：对局房间真人全部离线超过 IDLE_ROOM_TTL_MS → 回收内存
function sweepIdleRooms() {
  const now = Date.now();
  for (const room of [...rooms.values()]) {
    const humanOnline = [...room.players.values()]
      .some(p => !p.isAI && p.online && !p.aiTakeover);
    if (humanOnline) { room.lastHumanAt = now; continue; }
    if (!room.lastHumanAt) room.lastHumanAt = now;
    if (now - room.lastHumanAt >= IDLE_ROOM_TTL_MS) {
      console.log(`[${ts()}] [回收] 房间 ${room.id} 真人全部离线超时，回收闲置房间`);
      destroyRoom(room);
    }
  }
}
const gcTimer = setInterval(sweepIdleRooms, GC_INTERVAL_MS);
if (typeof gcTimer.unref === 'function') gcTimer.unref();

// 鸣牌响应统一处理：gang / peng / pass（hu 走独立入口以支持自摸分流）
function handleClaim(socket, action, ack) {
  const room = getRoomOf(socket);
  const player = getPlayerOf(socket, room);
  if (!player || !room.gameData) {
    if (ack) ack({ ok: false, error: '你不在对局中' });
    return;
  }
  const result = Engine.respondClaim(room, player.seat, action);
  if (ack) ack(result);
  if (!result.ok) {
    console.log(`[${ts()}] [鸣牌拒绝] ${player.name}：${result.error}`);
    return;
  }
  const labelMap = { gang: '明杠', peng: '碰', pass: '过' };
  console.log(`[${ts()}] [鸣牌] ${player.name} 选择${labelMap[action] || action}`);
  pushGameState(room);
}

function getRoomOf(socket) {
  const roomId = socket.data && socket.data.roomId;
  return roomId ? rooms.get(roomId) : null;
}
function getPlayerOf(socket, room) {
  if (!room) return null;
  return room.players.get(socket.data.seat);
}

function cleanName(raw) {
  const n = String(raw || '').trim().slice(0, 8);
  return n || '玩家';
}

// 仅在直接运行（node server.js）时监听端口；被测试文件 require 时不启动网络服务
if (server && require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log('诸暨麻将服务已启动：');
    console.log('  本机访问: http://localhost:' + PORT);
  });
}

/* ---------------- 供测试调用的纯逻辑导出 ---------------- */
module.exports = {
  SOCKET_READY,
  rooms,
  canStart,
  fillAiSeats,
  humanCount,
  roomPlayerCount,
  destroyRoom,
  sweepIdleRooms,
  IDLE_ROOM_TTL_MS,
  GC_INTERVAL_MS
};
