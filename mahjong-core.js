// ============================================================
// 诸暨麻将 -- 单机阶段1：底层数据模型（纯 JS 逻辑，无 UI）
//
// 内容：
//   1. 完整牌库：万/筒/条 1~9、东南西北、中发白，共 34 种 x 4 = 136 张
//   2. 开局翻 1 张基准牌，按花色组内闭环循环算出本局 2 张财神
//      （九万->一万、北风->东风、白板->红中）
//   3. 洗牌、发牌：庄家 14 张，闲家每人 13 张
//   4. 玩家数据结构：手牌 hand、碰牌列表 peng、杠牌列表 gang、弃牌列表 discards
//   5. 控制台打印：本局财神、四家手牌；校验牌数量、无重复牌
//
// 运行：node mahjong-core.js（自动演示）；浏览器引入后调用 MJCore.runDemo()
// ============================================================

(function () {
  'use strict';

  var root = (typeof window !== 'undefined') ? window
           : (typeof globalThis !== 'undefined') ? globalThis
           : this;

  // ---------------- 1. 牌库定义 ----------------

  // 花色组（组内闭环循环）：
  //   w 万 1~9 / t 条 1~9 / o 筒 1~9 / f 风 东南西北 1~4 / j 箭 中发白 1~3
  var SUITS = {
    w: { name: '万', rankCount: 9, order: 0 },
    t: { name: '条', rankCount: 9, order: 1 },
    o: { name: '筒', rankCount: 9, order: 2 },
    f: { name: '风', rankCount: 4, order: 3 },
    j: { name: '箭', rankCount: 3, order: 4 }
  };

  var NUMBER_CHARS = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
  var WIND_CHARS   = ['东', '南', '西', '北'];
  var DRAGON_CHARS = ['中', '发', '白'];

  // 牌编码：花色 key + 点数，如 w9=九万、f4=北风、j3=白板
  // 牌实例：{ id: 全局唯一编号, code: 牌编码 }

  // 生成完整牌库：34 种牌各 4 张，共 136 张
  function createDeck() {
    var deck = [];
    var id = 0;
    var suitKeys = Object.keys(SUITS);
    for (var si = 0; si < suitKeys.length; si++) {
      var suit = SUITS[suitKeys[si]];
      for (var rank = 1; rank <= suit.rankCount; rank++) {
        for (var k = 0; k < 4; k++) {
          deck.push({ id: id++, code: suitKeys[si] + rank });
        }
      }
    }
    return deck;
  }

  // 牌编码 -> 中文名，如 w9 -> 九万，f1 -> 东，j3 -> 白
  function tileName(code) {
    var suitKey = code.charAt(0);
    var rank = parseInt(code.slice(1), 10);
    if (suitKey === 'f') return WIND_CHARS[rank - 1];
    if (suitKey === 'j') return DRAGON_CHARS[rank - 1];
    return NUMBER_CHARS[rank - 1] + SUITS[suitKey].name;
  }

  // ---------------- 2. 洗牌 / 财神 ----------------

  // Fisher-Yates 洗牌（原地打乱并返回）
  function shuffle(deck) {
    for (var i = deck.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = deck[i];
      deck[i] = deck[j];
      deck[j] = tmp;
    }
    return deck;
  }

  // 双财神核心规则：基准牌在本花色组内的下一张（闭环循环）
  //   万/条/筒：9 的下一张是 1（九万->一万）
  //   风：北 f4 的下一张是 东 f1
  //   箭：白 j3 的下一张是 中 j1
  function nextWildCode(code) {
    var suit = SUITS[code.charAt(0)];
    var rank = parseInt(code.slice(1), 10);
    var nextRank = (rank % suit.rankCount) + 1;
    return code.charAt(0) + nextRank;
  }

  // ---------------- 3. 玩家数据结构 ----------------

  var SEAT_NAMES = ['东家', '南家', '西家', '北家'];

  // 创建玩家：
  //   hand     手牌（牌实例数组）
  //   peng     碰牌列表：每组 3 张，如 [[t,t,t], ...]
  //   gang     杠牌列表：每组 4 张，如 [[t,t,t,t], ...]
  //   discards 已打出弃牌列表：[t, t, ...]
  function createPlayer(seat, isBanker) {
    return {
      seat: seat,
      name: SEAT_NAMES[seat] + (isBanker ? '(庄家)' : ''),
      isBanker: !!isBanker,
      hand: [],
      peng: [],
      gang: [],
      discards: []
    };
  }

  // 手牌排序：万 -> 条 -> 筒 -> 风 -> 箭，组内按点数升序
  function sortHand(tiles) {
    return tiles.slice().sort(function (a, b) {
      var d = SUITS[a.code.charAt(0)].order - SUITS[b.code.charAt(0)].order;
      if (d !== 0) return d;
      return parseInt(a.code.slice(1), 10) - parseInt(b.code.slice(1), 10);
    });
  }

  // ---------------- 4. 开局发牌（牌墙 / 骰子 / 顺时针发牌） ----------------

  // 牌墙排列（顺时针绕桌的牌墙遍历序）：
  //   遍历序 0~16  = 北家面前牌墙（屏幕左→右）
  //   遍历序 17~33 = 西家面前牌墙（屏幕上→下）
  //   遍历序 34~50 = 南家面前牌墙（屏幕右→左）
  //   遍历序 51~67 = 东家面前牌墙（屏幕下→上）
  // 每摞 2 张（上张/下张），共 68 摞 136 张。
  var WALL_SEGMENT_BASE = { 3: 0, 2: 17, 1: 34, 0: 51 };

  // 掷两颗骰子，返回 [a, b]（1~6）
  function rollDice() {
    return [1 + Math.floor(Math.random() * 6), 1 + Math.floor(Math.random() * 6)];
  }

  // 骰子定摸牌起始摞：
  //   ① 以庄家为 1 逆时针数到「点数和」，数到谁家就从谁家面前牌墙开摸；
  //   ② 再以该家面向牌桌的方向为基，从其右向左数到「较小点数 + 1」摞，即起始摞。
  // 遍历序每段段首是该家的最「左」摞（面向牌桌），从右数第 min+1 摞 = 段内 (16-min)。
  // 返回 { wallSeat, startStack(遍历序), dice, min }
  function diceStart(bankerSeat, dice) {
    var sum = dice[0] + dice[1];
    var wallSeat = (bankerSeat + (sum - 1)) % 4;     // 逆时针（座位号 +1 方向）
    var min = Math.min(dice[0], dice[1]);
    var startStack = WALL_SEGMENT_BASE[wallSeat] + (16 - min);
    return { wallSeat: wallSeat, startStack: startStack, dice: dice, min: min };
  }

  // 开新一局
  //   bankerSeat 庄家座位 0~3（默认 0=东家）
  //   opts.dice  可选指定骰子 [a,b]（测试/调试用），缺省随机
  // 返回：
  //   deck      剩余可摸牌（deck.pop() 为下一张应摸牌，共 82 张）
  //   indicator 翻出的基准牌实例（亮出，不再参与摸牌）
  //   wilds     本局 2 张财神的牌编码 [基准牌, 基准牌下一张]
  //   players   四家玩家数据（庄 14 / 闲 13）
  //   wall      牌墙信息 { dice, startStack, wallSeat, indicatorStack }
  function dealNewGame(bankerSeat, opts) {
    if (bankerSeat === undefined || bankerSeat === null) bankerSeat = 0;
    opts = opts || {};
    var tiles = shuffle(createDeck());           // tiles[k] = 全局第 k 摸牌位的牌
    // 全局位 k：从起始摞起，每摞先上张后下张，沿牌墙顺时针推进。

    var dice = opts.dice || rollDice();
    var start = diceStart(bankerSeat, dice);
    var startStack = start.startStack;

    // 全局位 k 所在的牌墙遍历序摞号
    function stackOfSlot(k) { return (startStack + (k >> 1)) % 68; }

    // 发牌接收顺序：从庄家起顺时针（屏幕顺时针 = 座位号 -1 方向）。
    // 每家每次拿 2 摞（4 张），共 3 轮（位 0~47）；
    // 第 4 轮每家 1 张（先拿摞的上张、下家拿下张，位 48~51）；
    // 庄家最后再拿 1 张（位 52，庄 14 / 闲 13）。
    function receiverSeat(k) {
      if (k < 48) { var j = Math.floor(k / 4) % 4; return (bankerSeat - j + 8) % 4; }
      if (k === 52) return bankerSeat;
      var j2 = k - 48;
      return (bankerSeat - j2 + 8) % 4;
    }

    var players = [];
    for (var s = 0; s < 4; s++) {
      players.push(createPlayer(s, s === bankerSeat));
    }
    for (var k = 0; k <= 52; k++) {
      players[receiverSeat(k)].hand.push(tiles[k]);
    }
    for (var p = 0; p < 4; p++) {
      players[p].hand = sortHand(players[p].hand);
    }

    // 位 53 = 发牌后「后面那张」，翻为基准财神牌，亮出不再可摸
    var indicator = tiles[53];
    var wilds = [indicator.code, nextWildCode(indicator.code)];

    // 可摸牌：位 54~135（共 82 张）；deck.pop() 取位 54 起
    var deck = [];
    for (var k2 = 135; k2 >= 54; k2--) deck.push(tiles[k2]);

    // 财神牌亮在未摸牌墙的最后一摞上（摸牌顺序的最后一摞）
    var indicatorStack = stackOfSlot(134);   // 位 134/135 所在摞

    return {
      deck: deck,
      indicator: indicator,
      wilds: wilds,
      players: players,
      bankerSeat: bankerSeat,
      wall: {
        dice: dice,
        startStack: startStack,
        wallSeat: start.wallSeat,
        indicatorStack: indicatorStack
      }
    };
  }

  // 牌墙当前快照（供 UI 渲染）：68 摞，每摞给出所属座、段内序号、上/下张是否已被拿。
  //   revealTiles：开局发牌动画期间，视为已摸走的牌位数（动画完成为 53+1）。
  function wallSnapshot(game, revealTiles) {
    var w = game.wall;
    if (!w) return null;
    var startStack = w.startStack;
    // 已摸张数：发牌动画进度；正常对局 = 53 发牌 + 1 财神 + (82 - 剩余deck) 已摸
    var baseTaken = (revealTiles != null) ? revealTiles : (54 + (82 - game.deck.length));
    function slotTaken(slot) { return slot < baseTaken; }
    function seatOfStack(ti) { return ti < 17 ? 3 : ti < 34 ? 2 : ti < 51 ? 1 : 0; }

    var stacks = [];
    for (var ti = 0; ti < 68; ti++) {
      // 遍历序 ti 对应的全局起始位 g0
      var rel = (ti - startStack + 68) % 68;
      var g0 = rel * 2;
      stacks.push({
        seat: seatOfStack(ti),
        idx: ti - WALL_SEGMENT_BASE[seatOfStack(ti)],
        topTaken: slotTaken(g0),
        botTaken: slotTaken(g0 + 1),
        indicator: ti === w.indicatorStack
      });
    }
    return stacks;
  }

  // ---------------- 4b. 回合流程（阶段3：摸牌/出牌/轮转，无碰杠胡） ----------------

  // 开新局（含回合状态）：
  //   庄家 14 张，开局即处于 discard（出牌）阶段；
  //   闲家 13 张，轮到时先进入 draw（摸牌）阶段。
  // 回合状态 game.turn：
  //   currentSeat     当前行动座位（0~3，出牌顺序 (seat+1)%4，即逆时针）
  //   phase           'draw' 待摸牌 | 'discard' 待出牌
  //                   | 'claim' 鸣牌窗口（某家刚打出，等待碰/杠响应）
  //                   | 'over' 对局结束
  //   drawnTileId     本回合刚摸到的牌 id（出牌后清空）
  //   pendingDiscard  鸣牌窗口中待响应的打出牌 { seat: 打出者, tile: 牌实例 }
  //   endReason       结束原因，目前仅 'wallEmpty'（牌墙摸完，荒庄）
  function newGame(bankerSeat, opts) {
    var game = dealNewGame(bankerSeat, opts);
    game.turn = {
      currentSeat: game.bankerSeat,
      phase: 'discard',       // 庄家起手 14 张，直接出牌
      drawnTileId: null,
      pendingDiscard: null,
      endReason: null,
      // 阶段5：胡牌判定所需的局内计数
      drawCounts: [0, 0, 0, 0],  // 各家摸牌次数（地胡判定）
      discardCount: 0,           // 全场已打出并落定的牌数（天/地胡第一轮判定）
      gangDraw: false,           // 本次摸牌是否为杠后补摸（杠开判定）
      pendingGangDraw: false     // 下一次摸牌应为杠补摸（内部标记）
    };
    return game;
  }

  // 当前座位从牌墙摸 1 张牌（仅 phase='draw' 可摸）。
  // 牌墙摸完则对局结束（荒庄），返回 null。
  function drawTile(game) {
    var turn = game.turn;
    if (!turn || turn.phase === 'over') return null;
    if (turn.phase !== 'draw') return null;
    if (game.deck.length === 0) {
      turn.phase = 'over';
      turn.endReason = 'wallEmpty';
      turn.drawnTileId = null;
      return null;
    }
    var tile = game.deck.pop();
    var player = game.players[turn.currentSeat];
    player.hand.push(tile);
    player.hand = sortHand(player.hand);
    turn.drawnTileId = tile.id;
    turn.drawCounts[turn.currentSeat]++;
    turn.gangDraw = !!turn.pendingGangDraw;   // 杠后补摸标记（杠开判定）
    turn.pendingGangDraw = false;
    turn.phase = 'discard';
    return tile;
  }

  // 指定座位打出指定 id 的手牌（仅当前座位、phase='discard' 可打）。
  // 打出后进入鸣牌窗口（phase='claim'）：牌立即落入自家弃牌区展示，
  // 待碰/杠/吃 响应后再从弃牌区转移到鸣牌者副露（见 takeFromDiscards）；
  // 无人鸣牌则留在弃牌区（见 passClaim）。
  // 返回打出的牌实例；非法操作返回 null。
  function discardTile(game, seat, tileId) {
    var turn = game.turn;
    if (!turn || turn.phase === 'over') return null;
    if (turn.phase !== 'discard') return null;
    if (turn.currentSeat !== seat) return null;

    var player = game.players[seat];
    var idx = -1;
    for (var i = 0; i < player.hand.length; i++) {
      if (player.hand[i].id === tileId) { idx = i; break; }
    }
    if (idx === -1) return null;

    var tile = player.hand.splice(idx, 1)[0];

    // 先落入自家弃牌区（鸣牌窗口期间即可见），落定/被鸣再视情况转移
    player.discards.push(tile);

    turn.phase = 'claim';                // 鸣牌窗口：等待别家碰/杠/胡
    turn.pendingDiscard = { seat: seat, tile: tile, gang: false };
    turn.drawnTileId = null;
    turn.gangDraw = false;
    turn.discardCount++;                 // 打出即计数（落定与否不影响第一轮判定）
    return tile;
  }

  // 从某座位弃牌区取回指定牌实例（碰/吃/杠/点炮胡把牌转移走时使用）。
  // 返回 true 表示取到；牌本就不在弃牌区（如测试构造的悬空待响应牌）返回 false。
  function takeFromDiscards(game, seat, tile) {
    var d = game.players[seat].discards;
    for (var i = 0; i < d.length; i++) {
      if (d[i].id === tile.id) { d.splice(i, 1); return true; }
    }
    return false;
  }

  // 电脑 AI（阶段3 最简策略 / 阶段6 兜底）：从该座位手牌中随机选 1 张返回（不修改状态）。
  // 铁律：财神是百搭，AI 永不主动打出——仅从非财神真牌中随机；
  // 仅当手牌全为财神（极端无解场景）时才退回全随机。
  function pickRandomDiscard(game, seat) {
    var player = game.players[seat];
    if (!player || !player.hand.length) return null;
    var nonWild = player.hand.filter(function (t) { return !isWild(game, t.code); });
    var pool = nonWild.length ? nonWild : player.hand;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  // ---------------- 4c. 碰 / 杠 / 吃（阶段4：鸣牌，暂不结算） ----------------
  //
  // 鸣牌规则：
  //   碰 peng    ：别家打出某牌，手中 2 张同码真牌 -> 正碰；1 真 + 1 财神 -> 财碰；
  //                打出大张（东风/红中/发财/白板）时，0 真 + 2 财神 -> 双财碰
  //   吃 chi     ：仅打出者下家可吃；顺子缺张可用财神补位（财吃）
  //   明杠/暗杠  ：碰杠必须为真牌（财神不参与）
  //   财神限制   ：打出的财神是绝对安全张，不可吃/碰/杠/胡
  //   回头限制   ：自家弃牌堆/副露中已有的牌码，不能再被财神顶替来组新的吃/碰
  //   多方鸣牌优先级：胡 > 杠 > 正碰 > 正吃 > 财碰 > 财吃 > 双财碰
  //
  // 鸣牌组结构（player.peng / player.gang 数组元素）：
  //   { type: 'peng'|'chi'|'mingang'|'angang', tiles: [牌实例...],
  //     code: 真码（碰组；双财碰组 tiles[0] 为财神，必须依赖 code）,
  //     fromSeat: 来源座位(暗杠为null), cai: 财神参与, shuang: 双财碰 }

  // 统计手牌中某码牌的张数
  function countCode(hand, code) {
    var n = 0;
    for (var i = 0; i < hand.length; i++) if (hand[i].code === code) n++;
    return n;
  }

  // 大张：东风 f1 与箭牌 j1红中 / j2发财 / j3白板（可双财碰的字牌）
  function isDazhangCode(code) {
    return code === 'f1' || /^j[123]$/.test(code);
  }

  // 回头限制：自家弃牌堆、自家吃/碰/杠副露中已出现过的牌码集合。
  // 财吃/财碰/双财碰中财神顶替的牌码若在集合内，则该鸣牌不合法
  // （吃/碰/打出的牌不能再用来组吃/碰）。
  function blockedClaimCodes(game, seat) {
    var p = game.players[seat];
    var set = {};
    (p.discards || []).forEach(function (d) { set[d.code] = true; });
    (p.peng || []).forEach(function (g) {
      if (g.type === 'chi') (g.chiCodes || []).forEach(function (c) { set[c] = true; });
      else if (g.code) set[g.code] = true;
      else if (g.tiles && g.tiles[0]) set[g.tiles[0].code] = true;
    });
    (p.gang || []).forEach(function (g) {
      if (g.code) set[g.code] = true;
      else if (g.tiles && g.tiles[0]) set[g.tiles[0].code] = true;
    });
    return set;
  }

  // 鸣牌窗口：查询三家可碰/可杠/可吃/可双财碰的座位
  // 返回 {
  //   gang:    [可明杠座位...],                  手中 >=3 张同码真牌
  //   peng:    [可正碰座位...],                  手中 >=2 张同码真牌
  //   caipeng: [可财碰座位...],                  1 张真牌 + >=1 财神；且该码不在自家弃牌/副露中
  //   shuangcaipeng: [可双财碰座位...],          打出大张且手中 0 真牌 + >=2 财神；且该码不在自家弃牌/副露中
  //   chi:     [{ seat, options: [吃法...] }]    仅打出者下家；财吃补位码不可为自家已弃/已副露的码
  // }
  //   打出财神时返回空（财神不可碰杠吃，绝对安全张）
  function getClaimOptions(game) {
    var res = { gang: [], peng: [], caipeng: [], shuangcaipeng: [], chi: [] };
    var turn = game.turn;
    if (!turn || turn.phase !== 'claim' || !turn.pendingDiscard) return res;
    if (turn.pendingDiscard.gang) return res;    // 抢杠胡窗口：只可胡，不可碰/杠/吃
    var code = turn.pendingDiscard.tile.code;
    if (isWild(game, code)) return res;          // 财神不可鸣（绝对安全张）
    var canGang = !game.deck || game.deck.length > 0;  // 杠后必须补摸：牌墙已空则禁止明杠
    var from = turn.pendingDiscard.seat;
    for (var s = 0; s < 4; s++) {
      if (s === from) continue;
      var hand = game.players[s].hand;
      var n = countCode(hand, code);
      var w = countWild(game, hand);
      if (n >= 3 && canGang) res.gang.push(s);
      if (n >= 2) res.peng.push(s);               // 碰后直接出牌，无需补牌
      else if (n === 1 && w >= 1) {
        // 财碰：1 真 + 1 财神；回头限制：该码不可为自家已打出/已副露的牌码
        if (!blockedClaimCodes(game, s)[code]) res.caipeng.push(s);
      } else if (n === 0 && w >= 2 && isDazhangCode(code)) {
        // 双财碰：仅大张（东风/红中/发财/白板），2 财神 + 鸣来的大张凑刻；
        // 回头限制：大张码不可为自家已打出/已副露的牌码
        if (!blockedClaimCodes(game, s)[code]) res.shuangcaipeng.push(s);
      }
    }
    // 吃：仅下家（逆时针轮转 (from+1)%4），仅万/条/筒数牌
    var chiSeat = (from + 1) % 4;
    var chiOptions = getChiOptions(game, chiSeat, code);
    if (chiOptions.length) res.chi.push({ seat: chiSeat, options: chiOptions });
    return res;
  }

  // 统计手牌中财神张数
  function countWild(game, hand) {
    var n = 0;
    for (var i = 0; i < hand.length; i++) if (isWild(game, hand[i].code)) n++;
    return n;
  }

  // 从手牌中取出 n 张财神（返回取出的牌数组）
  function takeWildTiles(game, hand, n) {
    var out = [];
    for (var i = hand.length - 1; i >= 0 && out.length < n; i--) {
      if (isWild(game, hand[i].code)) out.push(hand.splice(i, 1)[0]);
    }
    return out;
  }

  // 查询某座位吃某牌的所有组合（含财吃）。
  // 返回 [{ codes:[顺码3], take:[3项，null=鸣牌位/{code,wild:false}真牌/{code,wild:true}财神], wildUsed }]
  //   回头限制：财神补位的牌码若为自家已打出（弃牌堆）/已副露的牌码，该吃法不合法。
  function getChiOptions(game, seat, code) {
    var suit = code.charAt(0);
    if (suit !== 'w' && suit !== 't' && suit !== 'o') return [];  // 字牌不可吃
    var r = parseInt(code.slice(1), 10);
    var hand = game.players[seat].hand;
    var wildN = countWild(game, hand);
    var blocked = blockedClaimCodes(game, seat);   // 自家已打出/已副露的牌码
    function has(c) { return countCode(hand, c) > 0; }
    var opts = [];
    // 三种含 r 的顺子：[r-2,r-1,r] / [r-1,r,r+1] / [r,r+1,r+2]
    var ranges = [[r - 2, r - 1, r], [r - 1, r, r + 1], [r, r + 1, r + 2]];
    ranges.forEach(function (rg) {
      if (rg[0] < 1 || rg[2] > 9) return;
      var codes = rg.map(function (n) { return suit + n; });
      var take = [], need = 0, legal = true;
      for (var i = 0; i < 3; i++) {
        if (rg[i] === r) { take.push(null); continue; }       // 鸣来的牌位
        if (has(codes[i])) take.push({ code: codes[i], wild: false });
        else {
          // 缺张用财神补：补位码不可为自家已打出/已副露的牌码（回头限制）
          if (blocked[codes[i]]) { legal = false; break; }
          need++;
          take.push({ code: codes[i], wild: true });
        }
      }
      if (legal && need <= wildN) opts.push({ codes: codes, take: take, wildUsed: need });
    });
    return opts;
  }

  // 过（放弃鸣牌/抢杠）：
  //   普通窗口 -> 待响应牌落入打出者弃牌区，轮转下家摸牌；
  //   抢杠窗口 -> 补杠成立，杠者补摸（牌不入弃牌区、不轮转）。
  // 返回该牌；非法返回 null。
  function passClaim(game) {
    var turn = game.turn;
    if (!turn || turn.phase !== 'claim' || !turn.pendingDiscard) return null;
    var pd = turn.pendingDiscard;
    turn.pendingDiscard = null;
    turn.drawnTileId = null;
    if (pd.gang) {
      // 无人抢杠：杠者补摸
      turn.currentSeat = pd.seat;
      turn.phase = 'draw';
      turn.pendingGangDraw = true;
    } else {
      // 牌在 discardTile 时已落入打出者弃牌区；此处兜底兼容未走 discardTile
      // 的构造场景（悬空待响应牌），避免落定后遗漏
      if (game.players[pd.seat].discards.indexOf(pd.tile) === -1) {
        game.players[pd.seat].discards.push(pd.tile);
      }
      turn.currentSeat = (pd.seat + 1) % (game.playerCount || 4);   // 逆时针轮转（2/3人局按N）
      turn.phase = 'draw';
    }
    return pd.tile;
  }

  // 从手牌中取出 n 张指定码的牌（返回取出的牌数组）
  function takeTiles(hand, code, n) {
    var out = [];
    for (var i = hand.length - 1; i >= 0 && out.length < n; i--) {
      if (hand[i].code === code) out.push(hand.splice(i, 1)[0]);
    }
    return out;
  }

  // 碰：鸣下当前待响应牌。
  //   正碰：手中 >=2 张同码真牌；财碰：1 张真牌 + 1 张财神；
  //   双财碰：打出大张（东风/红中/发财/白板）且手中 0 张真牌 + 2 张财神。
  //   回头限制：财碰/双财碰财神顶替的码不可为自家已打出/已副露的牌码。
  // 成功后轮到碰牌者出牌（phase='discard'）。返回鸣牌组；非法返回 null。
  function doPeng(game, seat) {
    var turn = game.turn;
    if (!turn || turn.phase !== 'claim' || !turn.pendingDiscard) return null;
    var pd = turn.pendingDiscard;
    if (pd.seat === seat) return null;
    var code = pd.tile.code;
    if (isWild(game, code)) return null;
    var player = game.players[seat];
    var n = countCode(player.hand, code);
    var blocked = null;   // 惰性计算：仅财碰/双财碰需要回头校验
    function blockedHasCode() {
      if (!blocked) blocked = blockedClaimCodes(game, seat);
      return !!blocked[code];
    }

    var mine;
    var shuang = false;
    if (n >= 2) {
      mine = takeTiles(player.hand, code, 2);
    } else if (n === 1) {
      // 财碰：1 张真牌 + 1 张财神；该码不可为自家已打出/已副露的牌码
      if (blockedHasCode()) return null;
      var wilds = takeWildTiles(game, player.hand, 1);
      if (!wilds.length) return null;
      mine = takeTiles(player.hand, code, 1).concat(wilds);
    } else if (n === 0 && isDazhangCode(code)) {
      // 双财碰：2 张财神 + 鸣来的大张凑刻；大张码不可为自家已打出/已副露的牌码
      if (blockedHasCode()) return null;
      var wilds2 = takeWildTiles(game, player.hand, 2);
      if (wilds2.length < 2) return null;
      mine = wilds2;
      shuang = true;
    } else {
      return null;
    }
    if (mine.length !== 2) return null;

    // 被碰的牌从打出者弃牌区取回，转入碰牌组
    takeFromDiscards(game, pd.seat, pd.tile);

    // code 为碰组真码（双财碰组 tiles[0] 是财神，胡牌判定依赖 code 计大张刻）
    var group = { type: 'peng', tiles: mine.concat([pd.tile]), code: code,
                  fromSeat: pd.seat, cai: n < 2, shuang: shuang };
    player.peng.push(group);
    player.hand = sortHand(player.hand);

    turn.pendingDiscard = null;
    turn.currentSeat = seat;    // 碰牌者获得出牌权
    turn.phase = 'discard';
    turn.drawnTileId = null;
    return group;
  }

  // 吃：下家鸣下上家打出的牌组成顺子（万/条/筒）；缺张可用财神补（财吃）。
  //   opt 来自 getChiOptions：{ codes:[3顺码], take:[3项], wildUsed }
  // 成功后轮到吃牌者出牌（phase='discard'）。返回吃牌组；非法返回 null。
  function doChi(game, seat, opt) {
    var turn = game.turn;
    if (!turn || turn.phase !== 'claim' || !turn.pendingDiscard) return null;
    var pd = turn.pendingDiscard;
    if (pd.gang) return null;
    if (pd.seat === seat) return null;
    if ((pd.seat + 1) % 4 !== seat) return null;     // 仅下家可吃
    if (!opt || !opt.codes || !opt.take) return null;
    var code = pd.tile.code;
    if (isWild(game, code)) return null;
    if (opt.codes.indexOf(code) === -1) return null;  // 组合必须含鸣来的牌
    var player = game.players[seat];
    var blocked = blockedClaimCodes(game, seat);   // 自家已打出/已副露的牌码

    var tiles = [null, null, null];
    for (var i = 0; i < 3; i++) {
      var tk = opt.take[i];
      if (tk === null) {
        if (opt.codes[i] !== code) return null;
        tiles[i] = pd.tile;
      } else if (tk.wild) {
        // 回头限制：财神补位的码不可为自家已打出/已副露的牌码
        if (blocked[opt.codes[i]]) return null;
        var w = takeWildTiles(game, player.hand, 1);
        if (!w.length) return null;
        tiles[i] = w[0];
      } else {
        var got = takeTiles(player.hand, tk.code, 1);
        if (!got.length) return null;
        tiles[i] = got[0];
      }
    }

    // 被吃的牌从打出者弃牌区取回，转入吃牌组
    takeFromDiscards(game, pd.seat, pd.tile);

    var group = { type: 'chi', tiles: tiles, fromSeat: pd.seat,
                  chiCodes: opt.codes.slice(), cai: (opt.wildUsed || 0) > 0 };
    player.peng.push(group);
    player.hand = sortHand(player.hand);

    turn.pendingDiscard = null;
    turn.currentSeat = seat;    // 吃牌者获得出牌权
    turn.phase = 'discard';
    turn.drawnTileId = null;
    return group;
  }

  // 明杠（大明杠）：鸣下当前待响应牌（须手中 >=3 张同码真牌）。
  // 成功后进入摸牌阶段由杠牌者补摸（phase='draw'，drawTile 通用）。返回鸣牌组；非法返回 null。
  function doMingGang(game, seat) {
    var turn = game.turn;
    if (!turn || turn.phase !== 'claim' || !turn.pendingDiscard) return null;
    var pd = turn.pendingDiscard;
    if (pd.seat === seat) return null;
    var code = pd.tile.code;
    if (isWild(game, code)) return null;
    if (game.deck && game.deck.length === 0) return null;   // 牌墙已空：杠后无牌可补，禁止
    var player = game.players[seat];
    if (countCode(player.hand, code) < 3) return null;

    var mine = takeTiles(player.hand, code, 3);

    // 被杠的牌从打出者弃牌区取回，转入明杠组
    takeFromDiscards(game, pd.seat, pd.tile);

    var group = { type: 'mingang', tiles: mine.concat([pd.tile]), fromSeat: pd.seat };
    player.gang.push(group);
    player.hand = sortHand(player.hand);

    turn.pendingDiscard = null;
    turn.currentSeat = seat;    // 杠牌者补摸
    turn.phase = 'draw';
    turn.drawnTileId = null;
    turn.pendingGangDraw = true;
    return group;
  }

  // 暗杠候选：自家出牌阶段，手牌中 >=4 张同码且非财神的牌编码列表。
  function findAnGangCodes(game, seat) {
    var player = game.players[seat];
    var counts = {};
    var codes = [];
    if (!player) return codes;
    if (game.deck && game.deck.length === 0) return codes;   // 牌墙已空：暗杠后无牌可补
    player.hand.forEach(function (t) { counts[t.code] = (counts[t.code] || 0) + 1; });
    Object.keys(counts).forEach(function (code) {
      if (counts[code] >= 4 && !isWild(game, code)) codes.push(code);
    });
    return codes;
  }

  // 暗杠：自家出牌阶段（phase='discard' 且 currentSeat===seat），
  // 把手牌中 4 张同码真牌杠出，随后进入补摸阶段（phase='draw'）。
  // 返回鸣牌组；非法返回 null。
  function doAnGang(game, seat, code) {
    var turn = game.turn;
    if (!turn || turn.phase !== 'discard' || turn.currentSeat !== seat) return null;
    if (isWild(game, code)) return null;
    if (game.deck && game.deck.length === 0) return null;    // 牌墙已空：暗杠后无牌可补
    var player = game.players[seat];
    if (countCode(player.hand, code) < 4) return null;

    var tiles = takeTiles(player.hand, code, 4);
    player.hand = sortHand(player.hand);
    var group = { type: 'angang', tiles: tiles, fromSeat: null };
    player.gang.push(group);

    turn.phase = 'draw';        // 杠后补摸（行动者仍为本人）
    turn.drawnTileId = null;
    turn.pendingGangDraw = true;
    return group;
  }

  // 补杠（加杠）候选：自家出牌阶段，自己【碰】过的牌，手牌中又摸到第 4 张（非财神）。
  // 注意：吃组（type='chi'，与碰组同存于 player.peng）不可补杠，必须排除。
  // 返回可补杠的牌编码列表。
  function findBuGangCodes(game, seat) {
    var turn = game.turn;
    var codes = [];
    if (!turn || turn.phase !== 'discard' || turn.currentSeat !== seat) return codes;
    if (game.deck && game.deck.length === 0) return codes;   // 牌墙已空：补杠后无牌可补
    var player = game.players[seat];
    if (!player) return codes;
    player.peng.forEach(function (g) {
      if (g.type !== 'peng') return;   // 仅碰组可补杠；吃组跳过
      var code = g.tiles[0].code;
      if (isWild(game, code)) return;
      if (countCode(player.hand, code) >= 1 && codes.indexOf(code) === -1) codes.push(code);
    });
    return codes;
  }

  // 补杠（加杠）：自家出牌阶段，把手牌中 1 张与碰组同码的牌补成杠。
  // 补杠后进入抢杠胡窗口（phase='claim'，pendingDiscard.gang=true）：
  //   别家可胡这张牌（抢杠胡）；无人胡则 passClaim 后杠者补摸。
  // 返回杠组；非法返回 null。
  function doBuGang(game, seat, code) {
    var turn = game.turn;
    if (!turn || turn.phase !== 'discard' || turn.currentSeat !== seat) return null;
    if (isWild(game, code)) return null;
    if (game.deck && game.deck.length === 0) return null;    // 牌墙已空：补杠（含抢杠窗口）后无牌可补
    var player = game.players[seat];

    var pengIdx = -1;
    for (var i = 0; i < player.peng.length; i++) {
      if (player.peng[i].type === 'peng' &&
          player.peng[i].tiles[0].code === code) { pengIdx = i; break; }
    }
    if (pengIdx === -1) return null;   // 吃组不可补杠
    var mine = takeTiles(player.hand, code, 1);
    if (mine.length < 1) return null;

    var pengGroup = player.peng.splice(pengIdx, 1)[0];
    var group = { type: 'bugang', tiles: pengGroup.tiles.concat(mine), fromSeat: pengGroup.fromSeat };
    player.gang.push(group);
    player.hand = sortHand(player.hand);

    turn.phase = 'claim';
    turn.pendingDiscard = { seat: seat, tile: mine[0], gang: true };
    turn.drawnTileId = null;
    turn.gangDraw = false;
    turn.pendingGangDraw = true;   // 无人抢杠时补摸
    return group;
  }

  // ---------------- 4d. 胡牌规则引擎（阶段5） ----------------
  //
  // 【台数规则表】（诸暨麻将，调试试用例见文件末尾 rulesSelfTest）
  //   大张刻子（碰出 / 杠出 / 手牌暗刻，每组独立累加；南风北风西风不算大张）：
  //     东风刻 每组 2 台；红中刻 / 发财刻 / 白板刻 每组 1 台
  //   基础牌型（每项各 1 台，可全部叠加）：
  //     无财（胡牌结构与吃/碰/杠副露中均无财神牌；财神用于财吃/财碰也算有财）1 台
  //     全碰（碰碰胡：4 组刻子，含碰/杠副露）1 台
  //     全顺（4 组顺子成型，含吃副露；将牌不限）1 台
  //     混一色（仅 1 种数牌花色 + 字牌）1 台
  //     杠开（杠后补摸即胡）1 台；抢杠胡（胡别家补杠的牌）1 台
  //   进阶牌型：
  //     清一色（仅 1 种数牌花色、无字牌）固定 3 台，可与全碰/全顺/无财/杠开/抢杠叠加；
  //     清一色覆盖混一色，二者不叠加。
  //   顶级牌型（三枪毙通杀）：字一色 / 天胡 / 地胡
  //     不计台数、不按 2^台数 结算、不参与翻倍、不受禁胡限制；
  //     三家各付固定 TOP_PAY = 128 分，胡牌者通杀全场。
  //
  // 【禁胡】（诸暨特色"零台杂牌不许胡"）：
  //   胡牌结构中刻子与顺子混杂 且 使用了财神 且 总台数为 0 -> 禁止胡牌；
  //   豁免场景：全刻（全碰）、全顺结构、无财神（无财）、
  //             混一色/清一色/字一色、杠开/抢杠/天胡/地胡（台数均不为 0）。
  //
  // 【积分】总台数 = 大张刻子台数 + 基础牌型台数 + 进阶牌型台数；unit = 2^总台数：
  //   自摸（含杠开）：其余三家各付 unit（全额）；
  //   点炮/抢杠胡：放炮者付 unit（全额），其余两家各付 unit/2（减半）；
  //   无庄闲翻倍；连庄状态（庄家连胡 2 把起）opts.mult=2，所有付费统一翻倍
  //   （通杀牌型不翻倍）。
  //
  // 【判定顺序】① 张数与结构合法性（isWin/DFS 拆牌）
  //             ② 顶级牌型（天胡 > 地胡 > 字一色，直接通杀）
  //             ③ 普通牌型累加台数 calcTai，再做禁胡拦截。

  var TOP_TAI = 13;   // 旧版封顶台数（已弃用，保留导出兼容）
  var TOP_PAY = 128;  // 顶级牌型（字一色/天胡/地胡）三枪毙通杀：每家固定支付

  function isHonorCode(code) {
    var s = code.charAt(0);
    return s === 'f' || s === 'j';
  }
  function isNumberCode(code) {
    var s = code.charAt(0);
    return s === 'w' || s === 't' || s === 'o';
  }
  function codeCmp(a, b) {
    var d = SUITS[a.charAt(0)].order - SUITS[b.charAt(0)].order;
    if (d !== 0) return d;
    return parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10);
  }
  function positiveKeys(counts) {
    return Object.keys(counts).filter(function (c) { return counts[c] > 0; }).sort(codeCmp);
  }

  // 面子递归拆解：counts 为真牌计数（已剔除财神），wild 为财神张数。
  // 把 left 个面子拆完，成功返回 true（结果追加到 out）。
  // mode：'ke' 刻子优先（混合允许）；'shun' 顺子优先（混合允许）；
  //       'keOnly' 仅允许刻子（用于碰碰胡判定）；'shunOnly' 仅允许顺子（用于平胡判定）。
  // 每个面子记 { t:'ke'|'shun', code:主牌码(3财神组为null), wild:耗用财神数 }
  function dfsGroups(counts, wild, left, out, mode) {
    if (left === 0) {
      return positiveKeys(counts).length === 0 && wild === 0;
    }
    var allowKe = mode !== 'shunOnly';
    var allowShun = mode !== 'keOnly';
    var c = positiveKeys(counts)[0];
    if (!c) {
      // 无真牌：3 张财神凑 1 个面子（严格顺模式记为顺，否则记为刻）
      if (wild >= 3) {
        out.push({ t: (mode === 'shunOnly' ? 'shun' : 'ke'), code: null, wild: 3 });
        if (dfsGroups(counts, wild - 3, left - 1, out, mode)) return true;
        out.pop();
      }
      return false;
    }

    // 刻子：主牌 c 用真牌 min(n,3)，缺额财神补
    function tryKe() {
      var n = counts[c];
      var useReal = Math.min(n, 3);
      var need = 3 - useReal;
      if (wild < need) return false;
      var rest = n - useReal;
      if (rest > 0) counts[c] = rest; else delete counts[c];
      out.push({ t: 'ke', code: c, wild: need });
      if (dfsGroups(counts, wild - need, left - 1, out, mode)) return true;
      out.pop();
      counts[c] = n;
      return false;
    }

    // 顺子：c 必为万条筒数牌。枚举 c 在顺子中的三个位置（底/中/顶），
    //   各位置缺额财神补 —— 财神可补前段（如 8万9万+财=789万、财+56饼=456饼）、
    //   中段（嵌张）与后段，与"财吃补任意缺张"规则一致。
    function tryShun() {
      if (!isNumberCode(c)) return false;
      var suit = c.charAt(0);
      var r = parseInt(c.slice(1), 10);
      for (var off = 0; off <= 2; off++) {        // off=0 c 为底；off=1 c 为中；off=2 c 为顶
        var br = r - off;                          // 顺子底牌点数
        if (br < 1 || br > 7) continue;
        var b0 = suit + br, b1 = suit + (br + 1), b2 = suit + (br + 2);
        var m0 = counts[b0] || 0, m1 = counts[b1] || 0, m2 = counts[b2] || 0;
        var need = (m0 ? 0 : 1) + (m1 ? 0 : 1) + (m2 ? 0 : 1);
        if (wild < need) continue;
        if (m0) { counts[b0] = m0 - 1; if (counts[b0] <= 0) delete counts[b0]; }
        if (m1) { counts[b1] = m1 - 1; if (counts[b1] <= 0) delete counts[b1]; }
        if (m2) { counts[b2] = m2 - 1; if (counts[b2] <= 0) delete counts[b2]; }
        out.push({ t: 'shun', code: b0, wild: need });
        if (dfsGroups(counts, wild - need, left - 1, out, mode)) return true;
        out.pop();
        if (m0) counts[b0] = m0; else delete counts[b0];
        if (m1) counts[b1] = m1; else delete counts[b1];
        if (m2) counts[b2] = m2; else delete counts[b2];
      }
      return false;
    }

    if (mode === 'shun' || mode === 'shunOnly') {
      if (allowShun && tryShun()) return true;
      if (allowKe && tryKe()) return true;
    } else {
      if (allowKe && tryKe()) return true;
      if (allowShun && tryShun()) return true;
    }
    // 3 张财神凑任意面子（兜底；严格顺模式记为顺）
    if (wild >= 3 && (allowKe || allowShun)) {
      out.push({ t: (allowShun ? 'shun' : 'ke'), code: null, wild: 3 });
      if (dfsGroups(counts, wild - 3, left - 1, out, mode)) return true;
      out.pop();
    }
    return false;
  }

  // 完整拆解：枚举将牌（真对/1真1财神/2财神）+ 拆 groupsLeft 个面子。
  // 返回 { pair:将牌码(null=财神将), groups:[...] } 或 null。
  function decompose(counts0, wild0, groupsLeft, prefer) {
    var pairCands = [];
    positiveKeys(counts0).forEach(function (c) {
      if (counts0[c] >= 2) pairCands.push({ code: c, take: 2, w: 0 });
      if (wild0 >= 1) pairCands.push({ code: c, take: 1, w: 1 });
    });
    if (wild0 >= 2) pairCands.push({ code: null, take: 0, w: 2 });

    for (var pi = 0; pi < pairCands.length; pi++) {
      var pc = pairCands[pi];
      var counts = {};
      for (var k in counts0) counts[k] = counts0[k];
      if (pc.take > 0) {
        counts[pc.code] -= pc.take;
        if (counts[pc.code] <= 0) delete counts[pc.code];
      }
      var groups = [];
      if (dfsGroups(counts, wild0 - pc.w, groupsLeft, groups, prefer)) {
        return { pair: pc.code, groups: groups };
      }
    }
    return null;
  }

  function totalMelds(game) {
    var n = 0;
    game.players.forEach(function (p) { n += p.peng.length + p.gang.length; });
    return n;
  }

  // 胡牌判定主入口（玩家与 AI 共用同一套规则）。
  //   seat    胡牌者座位
  //   winCode 点炮/抢杠胡的牌编码（不在手牌中）；自摸传 null
  //   ctx     可选覆盖 { winType, fromSeat, gangDraw, tianhu, dihu }
  // 返回：
  //   { win, banned, patterns:[{key,name,tai}], tai, top,
  //     winType:'zimo'|'dianpao'|'qianggang', fromSeat, winnerSeat, reason }
  function evaluateHu(game, seat, winCode, ctx) {
    ctx = ctx || {};
    var player = game.players[seat];
    var turn = game.turn || {};

    function fail(reason) {
      return { win: false, banned: false, patterns: [], tai: 0, top: false,
               winType: null, fromSeat: null, winnerSeat: seat, reason: reason };
    }
    if (!player) return fail('no-player');

    // 规则：打出的财神是绝对安全张，不能用来吃/碰/胡。
    // 此处拦截点炮/抢杠胡/听牌枚举等以 winCode 传入财神的判定；
    // 自摸路径 winCode 为 null（财神已入手牌），不受影响。
    if (winCode && isWild(game, winCode)) return fail('wild-safe');

    // ---- ① 收集结构牌与副露 ----
    var allCodes = player.hand.map(function (t) { return t.code; });
    if (winCode) allCodes.push(winCode);

    var melds = [];
    player.peng.forEach(function (g) {
      if (g.type === 'chi') {
        // 吃组：顺子 3 张（财神位以 chiCodes 还原的顺码计花色）
        melds.push({ type: 'chi', codes: g.chiCodes.slice() });
      } else {
        // 碰组：真码优先取 g.code（双财碰组 tiles[0] 是财神）
        melds.push({ type: 'peng', code: g.code || g.tiles[0].code });
      }
    });
    player.gang.forEach(function (g) { melds.push({ type: g.type, code: g.tiles[0].code }); });
    var groupsLeft = 4 - player.peng.length - player.gang.length;
    if (groupsLeft < 0) return fail('too-many-melds');
    if (allCodes.length !== groupsLeft * 3 + 2) return fail('bad-count:' + allCodes.length);

    var wildCount = 0;
    var counts = {};
    allCodes.forEach(function (code) {
      if (isWild(game, code)) wildCount++;
      else counts[code] = (counts[code] || 0) + 1;
    });
    // 财神总计：手牌（含胡牌那张）+ 吃/碰/杠副露中的财神。
    // 规则：财神用于财吃/财碰（含补杠转入的碰组）也算"有财"，不能算无财。
    var wildTotal = wildCount;
    player.peng.concat(player.gang).forEach(function (g) {
      (g.tiles || []).forEach(function (t) {
        if (isWild(game, t.code)) wildTotal++;
      });
    });

    // ---- ① 结构合法性：刻子优先 / 顺子优先 各拆一次 ----
    var keDec = decompose(counts, wildCount, groupsLeft, 'ke');
    var shunDec = decompose(counts, wildCount, groupsLeft, 'shun');
    if (!keDec && !shunDec) return fail('no-structure');
    // 严格模式：是否"存在"全刻拆解 / 全顺拆解（牌型判定不能依赖单次混合拆解）。
    // 副露面子同样计入：碰/杠组算刻，吃组算顺。
    var meldHasKe = melds.some(function (m) { return m.type !== 'chi'; });
    var meldHasShun = melds.some(function (m) { return m.type === 'chi'; });
    var keOnlyDec = decompose(counts, wildCount, groupsLeft, 'keOnly');
    var shunOnlyDec = decompose(counts, wildCount, groupsLeft, 'shunOnly');
    var canAllKe = !!keOnlyDec && !meldHasShun;   // 全刻（含碰/杠副露，不得含吃）
    var canAllShun = !!shunOnlyDec && !meldHasKe; // 全顺（含吃副露，不得含碰/杠）

    // ---- 胡牌方式推断 ----
    var winType = ctx.winType || null;
    var fromSeat = (ctx.fromSeat != null) ? ctx.fromSeat : null;
    if (!winType) {
      if (winCode) {
        var gangWindow = !!(turn.phase === 'claim' && turn.pendingDiscard && turn.pendingDiscard.gang);
        winType = gangWindow ? 'qianggang' : 'dianpao';
        if (turn.pendingDiscard) fromSeat = turn.pendingDiscard.seat;
      } else {
        winType = 'zimo';
      }
    }
    var gangkai = winType === 'zimo' &&
      (ctx.gangDraw != null ? ctx.gangDraw : !!turn.gangDraw);

    // ---- 花色统计（财神为百搭，不计其本花色）----
    var numSuits = {}, hasHonor = false, nonWild = 0;
    function collectCode(code) {
      if (isWild(game, code)) return;
      nonWild++;
      if (isHonorCode(code)) hasHonor = true;
      else numSuits[code.charAt(0)] = true;
    }
    allCodes.forEach(collectCode);
    melds.forEach(function (m) {
      if (m.type === 'chi') m.codes.forEach(collectCode);
      else collectCode(m.code);
    });
    var suitN = Object.keys(numSuits).length;

    // ---- ② 顶级牌型（天胡 > 地胡 > 字一色，三枪毙通杀，不计台数）----
    var patterns = [];
    function addPat(key, name, tai, isTop) {
      patterns.push({ key: key, name: name, tai: tai, top: !!isTop });
    }

    var drawSum = (turn.drawCounts || [0, 0, 0, 0]).reduce(function (a, b) { return a + b; }, 0);
    var tianhu = ctx.tianhu != null ? !!ctx.tianhu
      : !!(player.isBanker && (turn.discardCount || 0) === 0 && drawSum === 0 &&
           totalMelds(game) === 0 && !winCode);
    var dihu = ctx.dihu != null ? !!ctx.dihu
      : !!( !player.isBanker && totalMelds(game) === 0 &&
            (turn.discardCount || 0) === 1 && !!winCode );   // 闲家胡庄家首张打出的牌
    var ziyise = nonWild > 0 && suitN === 0 && hasHonor;

    var top = false, tai = 0;
    if (tianhu) { addPat('tianhu', '天胡', 0, true); top = true; }
    else if (dihu) { addPat('dihu', '地胡', 0, true); top = true; }
    else if (ziyise) { addPat('ziyise', '字一色', 0, true); top = true; }

    // ---- ③ 普通台数累加 ----
    // 大张定义：东风 f1 每组 2 台；红中 j1 / 发财 j2 / 白板 j3 每组 1 台；
    //           南风 f2 / 西风 f3 / 北风 f4 不算大张（碰/杠/暗刻均不计台）。
    var DAZHANG_TAI = { 'f1': 2, 'j1': 1, 'j2': 1, 'j3': 1 };
    var DAZHANG_NAME = { 'f1': '东风', 'j1': '红中', 'j2': '发财', 'j3': '白板' };
    function dazhangValue(code) {
      if (!code || isWild(game, code)) return 0;
      return DAZHANG_TAI[code] || 0;
    }

    if (!top) {
      // 大张刻子：副露碰/杠组 + 手牌拆解中的暗刻，每组独立累加
      melds.forEach(function (m) {
        if (m.type === 'chi') return;   // 吃组为数牌顺子，不构成大张
        var v = dazhangValue(m.code);
        if (v) addPat('dazhang', DAZHANG_NAME[m.code] + '刻', v);
      });
      (keDec ? keDec.groups : []).forEach(function (g) {
        if (g.t === 'ke') {
          var v = dazhangValue(g.code);
          if (v) addPat('dazhang', DAZHANG_NAME[g.code] + '刻', v);
        }
      });

      // 基础牌型（每项 1 台，可叠加）
      // 无财：手牌与吃/碰/杠副露中均无财神（财神用于财吃/财碰也算有财）
      if (wildTotal === 0) addPat('wucai', '无财', 1);
      if (canAllKe) addPat('quanpeng', '全碰', 1);        // 碰碰胡：4 组刻子（含碰/杠）
      if (canAllShun) addPat('quanshun', '全顺', 1);      // 顺子成型（含吃副露，将牌不限）
      // 进阶牌型：清一色 3 台且覆盖混一色（互斥，不叠加）
      if (suitN === 1 && hasHonor) addPat('hunyise', '混一色', 1);
      if (suitN === 1 && !hasHonor) addPat('qingyise', '清一色', 3);
      if (gangkai) addPat('gangkai', '杠开', 1);
      if (winType === 'qianggang') addPat('qianggang', '抢杠胡', 1);

      tai = patterns.reduce(function (s, p) { return s + p.tai; }, 0);

      // ---- 禁胡拦截：刻顺混杂 + 用了财神（含财吃/财碰）+ 0 台 ----
      //   全刻（碰碰胡）或全顺（含吃牌副露）均不算混杂；仅当同时存在刻与顺时拦截。
      var mixed = !canAllKe && !canAllShun;
      if (mixed && wildTotal > 0 && tai === 0) {
        return { win: true, banned: true, patterns: patterns, tai: 0, top: false,
                 winType: winType, fromSeat: fromSeat, winnerSeat: seat,
                 reason: 'zero-tai-mixed' };
      }
    }

    return { win: true, banned: false, patterns: patterns, tai: tai, top: top,
             winType: winType, fromSeat: fromSeat, winnerSeat: seat,
             tianhu: tianhu, dihu: dihu, ziyise: ziyise, gangkai: gangkai };
  }

  // 简易包装：仅判断能否胡牌（不关心牌型），供听牌/AI 快速判断
  function canHuTile(game, seat, winCode) {
    var ev = evaluateHu(game, seat, winCode || null);
    return ev.win && !ev.banned;
  }

  // 全部 34 种牌编码（万 1-9 / 条 1-9 / 筒 1-9 / 风 1-4 / 箭 1-3）
  var ALL_CODES = (function () {
    var a = [];
    Object.keys(SUITS).forEach(function (sk) {
      for (var r = 1; r <= SUITS[sk].rankCount; r++) a.push(sk + r);
    });
    return a;
  })();

  // 听牌枚举：某座位处于"等待胡牌"状态（手牌+副露=13 张）时，
  // 逐一检测摸到/吃到哪张牌可胡，返回可胡牌编码数组（财神码除外：
  // 打出的财神是绝对安全张不能胡，故不列入听牌提示）。
  // 非听牌状态（出牌阶段 14 张、对局结束等）返回空数组。
  function getTenpaiCodes(game, seat) {
    var player = game.players[seat];
    if (!player) return [];
    if (game.turn && game.turn.phase === 'over') return [];
    var meldN = player.peng.length + player.gang.length;
    var waitLen = (4 - meldN) * 3 + 1;
    if (player.hand.length !== waitLen) return [];
    var out = [];
    for (var i = 0; i < ALL_CODES.length; i++) {
      var code = ALL_CODES[i];
      // 以点炮方式评估（仅取能否胡；听牌列表不关心胡牌方式/台型加成）
      var ev = evaluateHu(game, seat, code, { winType: 'dianpao' });
      if (ev.win && !ev.banned) out.push(code);
    }
    return out;
  }

  // ============ AI 智能出牌（阶段8：向听数 / 进张 / 台数潜力 动态平衡） ============
  //
  // 对每张候选弃牌（非财神真牌），模拟打出后的 13 张手牌，综合 4 维评分取最高：
  //   ① 向听数（主导）：离胡牌的步数，越少越好 —— "快速胡牌"的底座；
  //   ② 进张：可降向听/胡牌的摸牌种类与剩余张数（逐张精确模拟，无粗估高估）；
  //   ③ 台数潜力（做大牌）：清一色/混一色、大张对子/暗刻、全碰方向的结构分；
  //   ④ 安全度（残局防守）：牌墙残时优先打弃牌河已见牌，降低点炮风险。
  // 权重四六分（胡牌 4 : 做大牌 6，全程恒定）：
  //   台数潜力（清一色/大张刻/全碰）与向听按 6:4 换算，AI 整体倾向做大牌；
  //   已听牌：台数权重保底（听牌型直接决定胡牌收益，多面听 vs 高台单钓可换算）。
  // 铁律不变：财神是百搭，永不出现在候选中。
  //
  // 34 索引：0-8 万 / 9-17 条 / 18-26 筒 / 27-30 风 / 31-33 箭
  function codeToIndex(code) {
    var s = code.charAt(0), r = parseInt(code.slice(1), 10);
    if (s === 'w') return r - 1;
    if (s === 't') return 8 + r;
    if (s === 'o') return 17 + r;
    if (s === 'f') return 26 + r;
    return 30 + r;
  }
  function indexToCode(i) {
    if (i < 9) return 'w' + (i + 1);
    if (i < 18) return 't' + (i - 8);
    if (i < 27) return 'o' + (i - 17);
    if (i < 31) return 'f' + (i - 26);
    return 'j' + (i - 30);
  }

  // 手牌 → 34 位真牌计数数组（打出 1 张 exceptCode；财神不计入）
  function handCount34ExceptOne(game, player, exceptCode) {
    var counts = new Array(34);
    for (var i = 0; i < 34; i++) counts[i] = 0;
    var skipped = false;
    player.hand.forEach(function (t) {
      if (isWild(game, t.code)) return;
      if (!skipped && t.code === exceptCode) { skipped = true; return; }
      counts[codeToIndex(t.code)]++;
    });
    return counts;
  }
  function countWildInHand(game, player) {
    var w = 0;
    player.hand.forEach(function (t) { if (isWild(game, t.code)) w++; });
    return w;
  }

  // 标准型向听数（4 面子 1 将）：递归枚举 刻子/顺子/搭子/将/弃置 的最优组合。
  //   counts   真牌计数（34 位）
  //   meldsLeft 还需凑的面子数（4 - 副露组数，吃/碰/杠均算）
  // 返回未含财神修正的 plain 向听数（-1 表示该牌型本身已成胡）。
  // 剪枝：乐观界（剩余全组成面子也无法优于当前最优则回溯）。
  function stdShanten(counts, meldsLeft) {
    var exposed = 4 - meldsLeft;
    var best = 8;
    function walk(i, m, p, pair) {
      // 乐观界剪枝：已得增益 + 剩余牌数/槽位约束下的最大可能增益 也无法严格优于 best 则回溯
      //   剩余张数 rem（每 +1 增益至少耗 1 张）；未分配槽可 +2、搭子槽可 +1、缺将可 +1
      var rem = 0;
      for (var k = i; k < 34; k++) rem += counts[k];
      var maxGain = Math.min(rem, 2 * (meldsLeft - m - p) + p + (pair ? 0 : 1));
      if (8 - (2 * (exposed + m) + p + pair + maxGain) >= best) return;
      while (i < 34 && !counts[i]) i++;
      if (i >= 34) {
        var sh = 8 - 2 * (exposed + m) - p - pair;
        if (sh < best) best = sh;
        return;
      }
      var c = counts[i];
      var suit = (i / 9) | 0, r = i % 9;
      // 1) 刻子 / 顺子（面子额度未满）
      if (m < meldsLeft) {
        if (c >= 3) {
          counts[i] -= 3; walk(i, m + 1, p, pair); counts[i] += 3;
        }
        if (suit < 3 && r <= 6 && counts[i + 1] && counts[i + 2]) {
          counts[i]--; counts[i + 1]--; counts[i + 2]--;
          walk(i, m + 1, p, pair);
          counts[i]++; counts[i + 1]++; counts[i + 2]++;
        }
      }
      // 2) 搭子（对搭/两面/嵌张，额度 meldsLeft - m）
      if (m + p < meldsLeft) {
        if (c >= 2) { counts[i] -= 2; walk(i, m, p + 1, pair); counts[i] += 2; }
        if (suit < 3 && r <= 7 && counts[i + 1]) {
          counts[i]--; counts[i + 1]--; walk(i, m, p + 1, pair); counts[i]++; counts[i + 1]++;
        }
        if (suit < 3 && r <= 6 && counts[i + 2]) {
          counts[i]--; counts[i + 2]--; walk(i, m, p + 1, pair); counts[i]++; counts[i + 2]++;
        }
      }
      // 3) 将（对子作雀头，不占面子额度）
      if (!pair && c >= 2) { counts[i] -= 2; walk(i, m, p, 1); counts[i] += 2; }
      // 4) 该位置剩余牌全部弃置
      counts[i] = 0; walk(i + 1, m, p, pair); counts[i] = c;
    }
    walk(0, 0, 0, 0);
    return best;
  }

  // 财神修正：每张财神最多降 1 向听（13 张手下限 0，摸牌后下限 -1 表胡）。
  function shantenEff(std, wild, floor) {
    return Math.max(floor, std - wild);
  }

  // 全局可见牌（34 位）：四家弃牌河 + 四家副露真牌（不含各人手牌）。
  function buildVisible(game) {
    var v = new Array(34);
    for (var i = 0; i < 34; i++) v[i] = 0;
    game.players.forEach(function (p) {
      (p.discards || []).forEach(function (t) {
        if (!isWild(game, t.code)) v[codeToIndex(t.code)]++;
      });
      (p.peng || []).concat(p.gang || []).forEach(function (g) {
        (g.tiles || []).forEach(function (t) {
          if (!isWild(game, t.code)) v[codeToIndex(t.code)]++;
        });
      });
    });
    return v;
  }

  // 牌墙中财神剩余张数估计：8 张（两种各 4）扣除自己手里 + 全局可见（含翻出的基准牌）
  function wildLeftCount(game, player) {
    var seen = 0;
    game.players.forEach(function (p) {
      (p.discards || []).forEach(function (t) { if (isWild(game, t.code)) seen++; });
      (p.peng || []).concat(p.gang || []).forEach(function (g) {
        (g.tiles || []).forEach(function (t) { if (isWild(game, t.code)) seen++; });
      });
    });
    player.hand.forEach(function (t) { if (isWild(game, t.code)) seen++; });
    if (game.indicator && isWild(game, game.indicator.code)) seen++;
    return Math.max(0, 8 - seen);
  }

  // 精确进张（统一口径）：枚举手牌相关牌（非零码 ±2）与财神的逐张摸入模拟，
  //   摸入后 14 张向听严格下降（std' - wild < eSh）即为进张；听牌候选（eSh=0）
  //   即"摸入成胡"。进张 = 搭子/对子完成牌 + 可凑将/刻的同码牌，逐张重算无高估。
  //   exceptIdx：打出候选牌的 34 索引 —— 该牌尚未落入弃牌河，剩余张数需按
  //   "自己手里还持有 1 张" 计（否则会高估该码的可摸张数）。
  //   财神进张：eSh ≥ 0 时摸 1 张财神必使有效向听 -1，恒为进张（仅剩张数受 wildLeft 限制）。
  function preciseUkeire(game, counts, wild, meldsLeft, eSh, visible, wildLeft, exceptIdx) {
    var kinds = 0, tiles = 0;
    if (wildLeft > 0) { kinds++; tiles += wildLeft; }
    var seen = {};
    function tryDraw(i) {
      if (i < 0 || i >= 34 || seen[i]) return;
      var code = indexToCode(i);
      if (isWild(game, code)) return;            // 财神已单独估算
      seen[i] = 1;
      counts[i]++;
      var s2 = stdShanten(counts, meldsLeft);
      counts[i]--;
      if (s2 - wild < eSh) {                     // 摸此牌 → 向听严格下降（听牌即胡）
        kinds++;
        var left = 4 - (visible[i] || 0) - counts[i] - (i === exceptIdx ? 1 : 0);
        if (left > 0) tiles += left;
      }
    }
    for (var i = 0; i < 34; i++) {
      if (!counts[i]) continue;
      var suit = (i / 9) | 0, r = i % 9;
      tryDraw(i);
      if (suit < 3) {
        if (r >= 1) tryDraw(i - 1);
        if (r <= 7) tryDraw(i + 1);
        if (r >= 2) tryDraw(i - 2);
        if (r <= 6) tryDraw(i + 2);
      }
    }
    return { kinds: kinds, tiles: tiles };
  }

  // 台数潜力（做大牌方向分，非精确台数）：
  //   ① 副露大张刻子（已锁定） ② 手牌大张暗刻/对子 ③ 清一色/混一色集中度 ④ 全碰潜力。
  // 大张台数同 evaluateHu：东风 2 / 红中·发财·白板 1（模块级副本，AI 评估用）。
  var AI_DZ_TAI = { 'f1': 2, 'j1': 1, 'j2': 1, 'j3': 1 };
  function taiPotential(game, seat, counts) {
    var player = game.players[seat];
    var melds = (player.peng || []).concat(player.gang || []);
    var pot = 0;

    // ① 副露大张刻子台数
    melds.forEach(function (m) {
      if (m.type !== 'chi') pot += AI_DZ_TAI[m.code] || 0;
    });

    // ② 手牌大张结构：暗刻全额 / 对子四成 / 单张摸对期望（孤张按 taiW=60 等比缩放）
    ['f1', 'j1', 'j2', 'j3'].forEach(function (code) {
      var n = counts[codeToIndex(code)] || 0;
      var v = AI_DZ_TAI[code];
      if (n >= 3) pot += v;
      else if (n === 2) pot += v * 0.4;
      else if (n === 1) pot += 0.05;
    });

    // ③ 花色集中度（手牌 + 副露真牌）：主花色 7 张起按纯度给清/混一色潜力分
    var suitN = [0, 0, 0], honorN = 0;
    for (var i = 0; i < 34; i++) {
      if (!counts[i]) continue;
      if (i < 27) suitN[(i / 9) | 0] += counts[i];
      else honorN += counts[i];
    }
    melds.forEach(function (m) {
      (m.tiles || []).forEach(function (t) {
        if (isWild(game, t.code)) return;
        var idx = codeToIndex(t.code);
        if (idx < 27) suitN[(idx / 9) | 0]++;
        else honorN++;
      });
    });
    var srt = suitN.slice().sort(function (a, b) { return b - a; });
    var main = srt[0], off = srt[1] + srt[2], total = main + off + honorN;
    if (main >= 7 && total >= 9) {
      if (off === 0 && honorN === 0) pot += 3;          // 清一色在望（纯一门数牌）
      else if (off === 0 && main >= 8) pot += 1.2;      // 混一色在望（一门数牌 + 字牌）
      else if (off <= 2 && main >= 8) pot += 0.7;       // 接近清一色
      else if (off <= 4 && main >= 7) pot += 0.3;       // 有集中苗头
    }

    // ④ 全碰潜力：无吃组且手牌对子+暗刻足以撑满剩余面子
    var hasChi = melds.some(function (m) { return m.type === 'chi'; });
    if (!hasChi) {
      var ke = 0, pr = 0;
      for (var j = 0; j < 34; j++) {
        if (counts[j] >= 3) ke++;
        else if (counts[j] === 2) pr++;
      }
      if (ke + pr >= 4 - melds.length && pr >= 1) pot += 0.8;
    }
    return pot;
  }

  // AI 财吃价值判断：财神尽量不用来吃 —— 仅当「吃了可听牌」或「做清一色」才值得。
  //   op 为 getChiOptions 返回的吃法（codes/take/wildUsed）。
  //   ① 听牌可达：模拟吃牌（手牌移除 take 中真牌与财神，财神按实际财神码移除），
  //      新吃组占一面子，再枚举打出任意一张手牌后的有效向听，存在 0（听牌）即通过；
  //   ② 清一色方向：吃后整体真牌（手牌 + 新吃组 + 已有副露，财神不计花色）
  //      主花色 ≥ 8 张且零杂色零字牌，或主花色 ≥ 10 张且杂色+字牌 ≤ 2 张。
  function caiChiWorth(game, seat, op) {
    var player = game.players[seat];
    var counts = [];
    for (var i = 0; i < 34; i++) counts.push(0);
    player.hand.forEach(function (t) { counts[codeToIndex(t.code)]++; });
    var wildN = countWild(game, player.hand);

    // 模拟吃牌：从手牌移除 take 的两张（真牌按码、财神按实际财神码）
    var ok = true;
    op.take.forEach(function (tk) {
      if (!tk) return;                                  // 鸣牌位（打来的牌）
      if (!tk.wild) { counts[codeToIndex(tk.code)]--; return; }
      for (var w = 0; w < 34; w++) {
        if (counts[w] > 0 && isWild(game, indexToCode(w))) { counts[w]--; return; }
      }
      ok = false;                                       // 手牌无财神可移除（异常防御）
    });
    if (!ok) return false;
    var melds = (player.peng || []).length + (player.gang || []).length;
    var meldsLeft = Math.max(0, 4 - melds - 1);         // 新吃组占一
    var wildAfter = wildN - (op.wildUsed || 0);

    // ① 吃了可听牌：枚举打出一张后的最小有效向听
    for (var d = 0; d < 34; d++) {
      if (!counts[d]) continue;
      counts[d]--;
      var eff = shantenEff(stdShanten(counts, meldsLeft), wildAfter, 0);
      counts[d]++;
      if (eff === 0) return true;
    }

    // ② 清一色方向：吃后整体真牌花色分布
    var suitN = [0, 0, 0], honorN = 0;
    function addCode(c) {
      var idx = codeToIndex(c);
      if (idx < 27) suitN[(idx / 9) | 0]++;
      else honorN++;
    }
    for (var s = 0; s < 34; s++) {
      if (!counts[s] || isWild(game, indexToCode(s))) continue;
      if (s < 27) suitN[(s / 9) | 0] += counts[s];
      else honorN += counts[s];
    }
    op.codes.forEach(function (c, k) {                  // 新吃组真牌（鸣牌位与真牌位）
      if (op.take[k] && !op.take[k].wild) addCode(c);
    });
    addCode(op.codes[op.take.indexOf(null)]);           // 打来的牌（吃必为数牌）
    (player.peng || []).concat(player.gang || []).forEach(function (m) {
      (m.tiles || []).forEach(function (t) {
        if (!isWild(game, t.code)) addCode(t.code);
      });
    });
    var srt = suitN.slice().sort(function (a, b) { return b - a; });
    var main = srt[0], off = srt[1] + srt[2];
    if (off === 0 && honorN === 0 && main >= 8) return true;        // 清一色在望
    if (main >= 10 && off + honorN <= 2) return true;               // 重仓单门冲清一色
    return false;
  }

  // AI 双财碰价值判断：双财碰一次烧掉 2 张财神，尽量不做 ——
  //   仅当手中财神 > 4 张（财多到花不完）才考虑，且尽量选择碰东风（其余大张一律放过）。
  function shuangCaiPengWorth(game, seat, pdCode) {
    var wildN = countWild(game, game.players[seat].hand);
    return wildN > 4 && pdCode === 'f1';
  }

  // AI 出牌主入口：返回应打出的牌实例（不修改状态）；无牌可打返回 null。
  function pickSmartDiscard(game, seat) {
    var player = game.players[seat];
    if (!player || !player.hand.length) return null;

    // 候选：非财神真牌（按码去重）
    var cand = {};
    player.hand.forEach(function (t) {
      if (!isWild(game, t.code)) cand[t.code] = (cand[t.code] || 0) + 1;
    });
    var codes = Object.keys(cand);
    if (!codes.length) return player.hand[0];          // 手牌全是财神（极端兜底）

    var exposed = (player.peng || []).length + (player.gang || []).length;
    var meldsLeft = Math.max(0, 4 - exposed);
    var wild = countWildInHand(game, player);
    var visible = buildVisible(game);
    var wildLeft = wildLeftCount(game, player);

    // 局进程（牌墙 82 → 0）：残局防守分参考用
    // 权重四六分：胡牌倾向 4 成 / 做大牌倾向 6 成，全程恒定 ——
    //   台数潜力（清一色/大张刻/全碰）与向听按 6:4 换算，AI 整体偏做大牌
    var wallLeft = (game.deck && game.deck.length) || 0;
    var progress = Math.max(0, Math.min(1, wallLeft / 82));
    var shW = 40;
    var taiW = 60;

    // 第一轮：各候选打出后的向听数
    var evals = [];
    var minSh = 9;
    codes.forEach(function (code) {
      var counts = handCount34ExceptOne(game, player, code);
      var std = stdShanten(counts, meldsLeft);
      var sh = shantenEff(std, wild, 0);
      evals.push({ code: code, counts: counts, std: std, sh: sh });
      if (sh < minSh) minSh = sh;
    });

    // 第二轮：层内进张归一 + 台数潜力 + 残局安全度 → 总分（差 2 向听以上直接淘汰）
    //   进张分仅在相同向听层内比较：高向听层的进张种类/张数天然更多（所有单张
    //   凑对作将都算进张），跨层直接相加会侵蚀向听主导权 —— 旧版"宁可停在
    //   一向听也不听牌"问题的根因。跨层取舍由 -sh*shW + taiPot*taiW 主导
    //   （早期台数权重高，值得为清一色/大刻多扛 1 向听；晚期严格快胡）。
    var entries = [];
    evals.forEach(function (e) {
      if (e.sh > minSh + 1) return;
      var uk = preciseUkeire(game, e.counts, wild, meldsLeft, e.sh, visible, wildLeft, codeToIndex(e.code));
      entries.push({ e: e, ukRaw: uk.kinds * 8 + uk.tiles * 2.5,
                     taiPot: taiPotential(game, seat, e.counts) });
    });
    var maxUkBySh = {};
    entries.forEach(function (en) {
      var k = en.e.sh;
      if (maxUkBySh[k] == null || en.ukRaw > maxUkBySh[k]) maxUkBySh[k] = en.ukRaw;
    });
    var best = null, bestScore = -1e9;
    entries.forEach(function (en) {
      var e = en.e;
      // 听牌时台数直接决定胡牌收益，权重保底
      var w2 = (e.sh === 0) ? Math.max(taiW, 26) : taiW;
      var eIdx = codeToIndex(e.code);
      var score = -e.sh * shW + (en.ukRaw - maxUkBySh[e.sh]) + en.taiPot * w2;
      // 字牌孤张先溜：字牌无顺子潜力（只能碰/凑对），同等结构下优先处理
      if (eIdx >= 27 && !e.counts[eIdx]) score += 6;
      // 残局防守：非听牌且牌墙 < 30% 时，弃牌河已见越多的牌越安全
      if (e.sh >= 2 && progress < 0.3) {
        score += (visible[eIdx] || 0) * 3;
      }
      score += Math.random() * 0.5;                    // 微扰：避免行为完全可预测
      if (score > bestScore) { bestScore = score; best = e; }
    });
    if (!best) best = evals[0];

    for (var i = 0; i < player.hand.length; i++) {
      if (player.hand[i].code === best.code) return player.hand[i];
    }
    return player.hand[0];
  }

  // 手牌向听数（供测试/调试）：当前手牌（含财神修正，不含打出模拟）。
  function handShanten(game, seat) {
    var player = game.players[seat];
    if (!player) return null;
    var exposed = (player.peng || []).length + (player.gang || []).length;
    var meldsLeft = Math.max(0, 4 - exposed);
    var wild = countWildInHand(game, player);
    var counts = handCount34ExceptOne(game, player, null);
    return shantenEff(stdShanten(counts, meldsLeft), wild, 0);
  }

  // 积分结算（阶段6 完整规则 / 台数规则修订版）：
  //   普通胡：unit = 2^总台数；
  //     自摸：其余三家各付 unit（全额）；
  //     点炮/抢杠：放炮者付 unit（全额），其余两家各付 unit/2（减半）；
  //     无庄闲翻倍；连庄状态 opts.mult=2 时所有付费统一翻倍。
  //   顶级牌型（字一色/天胡/地胡）：三枪毙通杀，三家各付固定 TOP_PAY，
  //     不按台数、不参与翻倍。
  // 返回 { unit, pay:[四家支出], income:胡家总收入, winnerSeat, mult, top }
  function calcScore(ev, game, opts) {
    opts = opts || {};
    var mult = opts.mult || 1;
    var pc = (game && game.playerCount) || 4;   // 2/3 人局：非活动座位不参与收支
    var pay = [0, 0, 0, 0];
    var winner = ev.winnerSeat;
    var unit;

    if (ev.top) {
      // 三枪毙通杀：固定金额，在场各家全包，不翻倍
      unit = TOP_PAY;
      for (var t = 0; t < pc; t++) {
        if (t !== winner) pay[t] = TOP_PAY;
      }
      mult = 1;
    } else {
      unit = Math.pow(2, ev.tai || 0);
      if (ev.winType === 'dianpao' || ev.winType === 'qianggang') {
        var from = ev.fromSeat;
        if (from != null) pay[from] = unit * mult;              // 放炮者全额
        for (var s = 0; s < pc; s++) {
          if (s === winner || s === from) continue;
          pay[s] = Math.ceil(unit / 2) * mult;                  // 其余在场各家减半
        }
      } else {
        for (var k = 0; k < pc; k++) {
          if (k === winner) continue;
          pay[k] = unit * mult;                                 // 自摸在场各家全额
        }
      }
    }

    var income = pay[0] + pay[1] + pay[2] + pay[3];
    return { unit: unit, pay: pay, income: income, winnerSeat: winner,
             mult: mult, top: !!ev.top };
  }

  // 带分模式（玩法2）支付封顶：付家余额不足时只付到清零，胡家从该家只收实付额。
  //   例：南家仅剩 1 分，应付 16 分 → 只付 1 分（清零），胡家从南家只收 1 分；
  //   其余余额充足的家照常足额支付。胡家收入 = 四家实付合计。
  //   score: calcScore 返回值（理论支付）；balances: 四家当前余额（非负数组）；
  //   winnerSeat: 胡家座位（收入侧不封顶）。
  // 返回 { pay: 实际支付数组, income: 实际收入, capped: 各家是否被余额截断 }
  function capPayByBalance(score, balances, winnerSeat) {
    var pay = [0, 0, 0, 0], income = 0, capped = [false, false, false, false];
    for (var s = 0; s < 4; s++) {
      if (s === winnerSeat) continue;
      var owe = (score && score.pay && score.pay[s]) || 0;
      var bal = Math.max(0, balances[s] || 0);
      var real = Math.min(owe, bal);
      pay[s] = real;
      if (real < owe) capped[s] = true;
      income += real;
    }
    return { pay: pay, income: income, capped: capped };
  }

  // ---------------- 5. 校验 / 打印 ----------------

  // 判断某牌编码是否为本局财神
  function isWild(game, code) {
    return game.wilds.indexOf(code) !== -1;
  }

  // 校验一局数据：
  //   - 全部 136 张牌不重不漏（牌墙 + 基准牌 + 四家手牌/碰/杠/弃牌）
  //   - 庄家 14 张、闲家各 13 张；开局碰/杠/弃牌列表为空
  //   - 财神为 [基准牌, 基准牌同组下一张]
  // 返回错误信息数组（空数组表示全部通过）
  function validateGame(game) {
    var errors = [];

    // 收集本局全部牌实例
    var all = [game.indicator].concat(game.deck);
    game.players.forEach(function (p) {
      all = all.concat(p.hand);
      p.peng.forEach(function (g) { all = all.concat(g.tiles); });
      p.gang.forEach(function (g) { all = all.concat(g.tiles); });
      all = all.concat(p.discards);
    });

    if (all.length !== 136) {
      errors.push('总牌数应为 136，实际 ' + all.length);
    }
    var idSet = {};
    var dup = 0;
    all.forEach(function (t) {
      if (idSet[t.id]) dup++;
      idSet[t.id] = true;
    });
    if (dup > 0) errors.push('存在 ' + dup + ' 张重复牌实例');
    if (Object.keys(idSet).length !== 136) {
      errors.push('唯一牌 id 数应为 136，实际 ' + Object.keys(idSet).length);
    }

    // 手牌数量 & 空列表
    game.players.forEach(function (p) {
      var expect = p.isBanker ? 14 : 13;
      if (p.hand.length !== expect) {
        errors.push(p.name + ' 手牌应为 ' + expect + ' 张，实际 ' + p.hand.length + ' 张');
      }
      if (p.peng.length !== 0)     errors.push(p.name + ' 碰牌列表开局应为空');
      if (p.gang.length !== 0)     errors.push(p.name + ' 杠牌列表开局应为空');
      if (p.discards.length !== 0) errors.push(p.name + ' 弃牌列表开局应为空');
    });

    // 财神
    if (game.wilds.length !== 2) {
      errors.push('财神应为 2 张，实际 ' + game.wilds.length);
    } else {
      if (game.wilds[0] !== game.indicator.code) {
        errors.push('第一张财神应为基准牌本身 ' + game.indicator.code + '，实际 ' + game.wilds[0]);
      }
      if (game.wilds[1] !== nextWildCode(game.wilds[0])) {
        errors.push('第二张财神应为同组下一张 ' + nextWildCode(game.wilds[0]) + '，实际 ' + game.wilds[1]);
      }
    }

    return errors;
  }

  // 控制台打印：本局财神、四家手牌、校验结果
  function printGame(game) {
    console.log('==================== 诸暨麻将 · 开局 ====================');
    console.log('翻基准牌：' + tileName(game.indicator.code) + '（' + game.indicator.code + '）');
    console.log('本局双财神：【' + tileName(game.wilds[0]) + '】、【' + tileName(game.wilds[1]) + '】');
    console.log('牌墙剩余：' + game.deck.length + ' 张');
    console.log('--------------------------------------------------------------');

    game.players.forEach(function (p) {
      var wildCount = p.hand.filter(function (t) { return isWild(game, t.code); }).length;
      var handStr = p.hand.map(function (t) { return tileName(t.code); }).join(' ');
      console.log(p.name + '（' + p.hand.length + ' 张，含财神 ' + wildCount + ' 张）');
      console.log('  ' + handStr);
      console.log('  碰：' + (p.peng.length ? p.peng.length + ' 组' : '无') +
                  '  杠：' + (p.gang.length ? p.gang.length + ' 组' : '无') +
                  '  弃牌：' + (p.discards.length ? p.discards.length + ' 张' : '无'));
      p.peng.forEach(function (g) {
        console.log('    [碰] ' + g.tiles.map(function (t) { return tileName(t.code); }).join(' '));
      });
      p.gang.forEach(function (g) {
        console.log('    [' + (g.type === 'angang' ? '暗杠' : '明杠') + '] ' +
                    g.tiles.map(function (t) { return tileName(t.code); }).join(' '));
      });
    });

    console.log('--------------------------------------------------------------');
    var errors = validateGame(game);
    if (errors.length === 0) {
      console.log('校验通过：四家手牌数量正确（庄14/闲13），全部 136 张牌无重复、无遗漏。');
    } else {
      console.log('校验失败：');
      errors.forEach(function (e) { console.log('  [x] ' + e); });
    }
    console.log('==============================================================');
    return errors;
  }

  // 闭环循环规则自检（规则示例全覆盖）
  function ruleSelfTest() {
    var cases = [
      ['w9', 'w1', '九万->一万'], ['w1', 'w2', '一万->二万'],
      ['t9', 't1', '九条->一条'], ['o9', 'o1', '九筒->一筒'],
      ['f4', 'f1', '北风->东风'], ['f1', 'f2', '东风->南风'],
      ['j3', 'j1', '白板->红中'], ['j1', 'j2', '红中->发财'], ['j2', 'j3', '发财->白板']
    ];
    var fails = [];
    cases.forEach(function (c) {
      var from = c[0], to = c[1], desc = c[2];
      var got = nextWildCode(from);
      if (got !== to) fails.push(desc + '：期望 ' + to + '，实际 ' + got);
    });
    if (createDeck().length !== 136) fails.push('牌库应为 136 张');
    return fails;
  }

  // 演示入口：连续开 3 局并逐局打印，返回校验结果
  function runDemo() {
    var ruleFails = ruleSelfTest();
    if (ruleFails.length) {
      console.log('闭环规则自检失败：');
      ruleFails.forEach(function (f) { console.log('  [x] ' + f); });
      return { ok: false, errors: ruleFails };
    }
    console.log('闭环规则自检通过：九万->一万、北风->东风、白板->红中 等 9 组用例全部正确。');
    console.log('');

    var allOk = true;
    for (var i = 0; i < 3; i++) {
      var game = dealNewGame(i % 4); // 轮流坐庄
      var errors = printGame(game);
      if (errors.length) allOk = false;
    }
    console.log(allOk ? '连续 3 局发牌校验全部通过。' : '存在校验失败局，请检查上方日志。');
    return { ok: allOk };
  }

  // 规则引擎自检（阶段5）：浏览器控制台执行 MJCore.rulesSelfTest()，
  // 返回错误描述数组（空数组 = 全部通过）。
  //
  // ┌─ 调试用例（evaluateHu 入参速查，hand 为手牌码、winCode 为点炮牌）──┐
  // │ ① 全顺+无财=2台（自摸）：                                        │
  // │    wilds=['o8','o9']; hand=一万~九万+一二三条+一对一筒           │
  // │    -> ev.win=true，patterns 含 quanshun/wucai，tai=2             │
  // │ ② 禁胡（刻顺混杂+财神+0台）：                                    │
  // │    wilds=['w8','w9']; hand=一万刻/三四五万/一二三条/             │
  // │    财神w9顶二筒组二三四筒/对七筒 -> win=true 但 banned=true      │
  // │ ③ 字一色=通杀：东南西风刻+红中刻+发财将（全字牌）-> ev.top       │
  // │ ④ 天胡=通杀：庄家起手 14 张即胡（discardCount=0 且无人摸过牌）   │
  // │ ⑤ 地胡=通杀：闲家第一轮胡庄家首张（winCode 点炮, discardCount=1）│
  // │ ⑥ 杠开+1台：gangDraw=true（杠后补摸）时自摸                      │
  // │ ⑦ 抢杠胡+1台：补杠窗口(pendingDiscard.gang=true)胡别家补杠的牌   │
  // │ ⑧ 全碰=1台：4 组刻子+将（财神可替牌凑刻）                        │
  // │ ⑨ 清一色=3台：全万子、无字牌                                     │
  // │ ⑩ 积分：1 台自摸 unit=2（三家各付 2，总收入 6，无庄闲翻倍）；    │
  // │    2 台点炮：放炮者付 4、其余两家各付 2，总收入 8                │
  // │ ⑫ 大张叠加：东风碰 2 + 红中碰 1 = 大张 3 台；南风碰不计         │
  // │ ⑬ 通杀积分：字一色三家各付 128、总收入 384，连庄 mult 不生效     │
  // └──────────────────────────────────────────────────────────────────┘
  function rulesSelfTest() {
    var fails = [];
    var uid = 800000;
    function T(code) { return { id: uid++, code: code }; }
    function hasPat(ev, key) {
      return ev.patterns.some(function (p) { return p.key === key; });
    }
    // 构造最小对局：wilds 财神码；banker 庄家座；seat 被检测者座；
    //   hand 手牌码；peng 碰组码；gang [{code,type:'mingang'|'angang'}]；
    //   winCode 点炮/抢杠牌；fromSeat 出牌者；gangWindow 抢杠窗口；
    //   discardCount/drawCounts/gangDraw 局内计数。
    function mk(o) {
      o = o || {};
      var banker = (o.banker == null) ? 0 : o.banker;
      var seat = (o.seat == null) ? 1 : o.seat;
      var players = [];
      for (var s = 0; s < 4; s++) {
        players.push({ seat: s, name: 'p' + s, isBanker: s === banker,
                       hand: [], peng: [], gang: [], discards: [] });
      }
      var g = {
        wilds: o.wilds || ['w8', 'w9'],
        players: players,
        bankerSeat: banker,
        turn: {
          currentSeat: o.winCode ? ((o.fromSeat == null) ? 0 : o.fromSeat) : seat,
          phase: o.winCode ? 'claim' : 'discard',
          drawnTileId: null, pendingDiscard: null, endReason: null,
          drawCounts: o.drawCounts || [0, 0, 0, 0],
          discardCount: (o.discardCount == null) ? 9 : o.discardCount,
          gangDraw: !!o.gangDraw, pendingGangDraw: false
        }
      };
      var p = players[seat];
      (o.hand || []).forEach(function (c) { p.hand.push(T(c)); });
      (o.peng || []).forEach(function (code) {
        p.peng.push({ type: 'peng', tiles: [T(code), T(code), T(code)], fromSeat: (seat + 1) % 4 });
      });
      (o.gang || []).forEach(function (gx) {
        p.gang.push({ type: gx.type || 'mingang',
          tiles: [T(gx.code), T(gx.code), T(gx.code), T(gx.code)],
          fromSeat: gx.type === 'angang' ? null : (seat + 1) % 4 });
      });
      if (o.winCode) {
        g.turn.pendingDiscard = { seat: (o.fromSeat == null) ? 0 : o.fromSeat,
                                  tile: T(o.winCode), gang: !!o.gangWindow };
      }
      return g;
    }
    function ev(o) {
      var g = mk(o);
      var seat = (o.seat == null) ? 1 : o.seat;
      return evaluateHu(g, seat, o.winCode || null, o.ctx || null);
    }
    function check(cond, msg) { if (!cond) fails.push(msg); }

    // ① 全顺+无财=2台（财神码 o8/o9 不在手牌中）
    var e1 = ev({ wilds: ['o8','o9'],
      hand: ['w1','w2','w3','w4','w5','w6','w7','w8','w9','t1','t2','t3','o1','o1'] });
    check(e1.win && !e1.banned && hasPat(e1, 'quanshun') && hasPat(e1, 'wucai') && e1.tai === 2,
          '① 全顺+无财应为 2 台');
    // ② 禁胡：刻顺混杂+财神+0台
    var e2 = ev({ wilds: ['w8','w9'],
      hand: ['w1','w1','w1','w3','w4','w5','t1','t2','t3','w9','o3','o4','o7','o7'] });
    check(e2.win && e2.banned && e2.tai === 0, '② 刻顺混杂+财神+0台应禁胡');
    // ③ 字一色=通杀
    var e3 = ev({ hand: ['f1','f1','f1','f2','f2','f2','f3','f3','f3','j1','j1','j1','j2','j2'] });
    check(e3.win && e3.top && hasPat(e3, 'ziyise') && e3.tai === 0, '③ 字一色应为通杀牌型');
    // ④ 天胡=通杀
    var e4 = ev({ banker: 1, seat: 1, discardCount: 0, drawCounts: [0,0,0,0],
      hand: ['w1','w1','w1','w2','w3','w4','w5','w6','w7','t1','t2','t3','o1','o1'] });
    check(e4.win && e4.top && hasPat(e4, 'tianhu'), '④ 庄家起手胡应为天胡（通杀）');
    // ⑤ 地胡=通杀
    var e5 = ev({ banker: 0, seat: 1, discardCount: 1, fromSeat: 0, winCode: 'o1',
      hand: ['w1','w1','w1','w2','w3','w4','w5','w6','w7','t1','t2','t3','o1'] });
    check(e5.win && e5.top && hasPat(e5, 'dihu'), '⑤ 闲家第一轮点炮应为地胡（通杀）');
    // ⑥ 杠开+1台
    var e6 = ev({ gangDraw: true,
      hand: ['w1','w1','w1','w2','w3','w4','w5','w6','w7','t1','t2','t3','o1','o1'] });
    check(e6.win && hasPat(e6, 'gangkai'), '⑥ 杠后补摸自摸应计杠开');
    // ⑦ 抢杠胡+1台
    var e7 = ev({ gangWindow: true, fromSeat: 2, winCode: 'o1',
      hand: ['w1','w1','w1','w2','w3','w4','w5','w6','w7','t1','t2','t3','o1'] });
    check(e7.win && e7.winType === 'qianggang' && hasPat(e7, 'qianggang'), '⑦ 补杠窗口胡牌应为抢杠胡');
    // ⑧ 全碰=1台（财神凑刻）
    var e8 = ev({ wilds: ['w8','w9'],
      hand: ['w1','w1','w9','w3','w3','w3','t5','t5','t5','o7','o7','o7','o9','o9'] });
    check(e8.win && !e8.banned && hasPat(e8, 'quanpeng') && e8.tai === 1, '⑧ 全碰应为 1 台');
    // ⑨ 清一色=3台（万子碰+万子顺子手牌：全碰/全顺/混一色均不成立；无财神另 +1）
    var g9 = mk({ wilds: ['o8','o9'], peng: ['w1'],
      hand: ['w2','w2','w2','w3','w3','w4','w4','w5','w6','w7','w8'] });
    var e9 = evaluateHu(g9, 1, null);
    var qy9 = e9.patterns.filter(function (p) { return p.key === 'qingyise'; })[0];
    check(e9.win && qy9 && qy9.tai === 3 && !hasPat(e9, 'hunyise') &&
          !hasPat(e9, 'quanpeng') && !hasPat(e9, 'quanshun') && e9.tai === 4,
          '⑨ 清一色应为 3 台（另加无财 1，总台 4），不叠加混一色/全碰/全顺');
    // ⑨b 清一色可叠加全顺：全万子顺子牌型 = 清一色3 + 全顺1 + 无财1 = 5 台
    var e9b = ev({ wilds: ['o8','o9'],
      hand: ['w1','w2','w3','w4','w5','w6','w7','w8','w9','w2','w3','w4','w5','w5'] });
    check(e9b.win && hasPat(e9b, 'qingyise') && hasPat(e9b, 'quanshun') &&
          hasPat(e9b, 'wucai') && e9b.tai === 5,
          '⑨b 清一色+全顺+无财应叠加为 5 台');
    // ⑩ 积分：1台自摸 unit=2，三家各付 2（无庄闲翻倍），总收入 6
    var g10 = mk({ wilds: ['w8','w9'],
      hand: ['w1','w2','w3','w4','w5','w6','w7','w8','w9','t1','t2','t3','w9','w9'] });
    var e10 = evaluateHu(g10, 1, null);
    var sc10 = calcScore(e10, g10);
    check(e10.tai === 1 && sc10.unit === 2 && sc10.pay[0] === 2 && sc10.pay[2] === 2 &&
          sc10.pay[3] === 2 && sc10.income === 6, '⑩ 1台自摸：unit=2，三家各付2，总收入6');
    // ⑪ 积分：2台点炮，放炮者付 4、其余两家各付 2，总收入 8
    var g11 = mk({ winCode: 'o9', fromSeat: 2,
      hand: ['w1','w1','w1','w3','w3','w3','t5','t5','t5','o7','o7','o7','o9'] });
    var e11 = evaluateHu(g11, 1, 'o9');
    var sc11 = calcScore(e11, g11);
    check(e11.winType === 'dianpao' && sc11.unit === 4 && sc11.pay[2] === 4 &&
          sc11.pay[0] === 2 && sc11.pay[3] === 2 && sc11.income === 8,
          '⑪ 2台点炮：放炮者付4，其余两家各付2，总收入8');
    // ⑫ 大张叠加：东风碰 2 + 红中碰 1 + 无财 1 = 4 台；南风碰不计台
    var g12 = mk({ peng: ['f1','j1'],
      hand: ['w1','w2','w3','w4','w5','w6','o7','o7'] });
    var e12 = evaluateHu(g12, 1, null);
    var dz12 = e12.patterns.filter(function (p) { return p.key === 'dazhang'; });
    var dzSum12 = dz12.reduce(function (s, p) { return s + p.tai; }, 0);
    var dzNames12 = dz12.map(function (p) { return p.name; }).join('/');
    check(e12.win && dzSum12 === 3 && dzNames12 === '东风刻/红中刻' && e12.tai === 4,
          '⑫ 东风碰+红中碰：大张应合计 3 台（东风2+红中1），总台 4；实际 ' + dzSum12 + '/' + e12.tai);
    var g12b = mk({ peng: ['f2','j1'],
      hand: ['w1','w2','w3','w4','w5','w6','o7','o7'] });
    var e12b = evaluateHu(g12b, 1, null);
    var dzSum12b = e12b.patterns.filter(function (p) { return p.key === 'dazhang'; })
                               .reduce(function (s, p) { return s + p.tai; }, 0);
    check(dzSum12b === 1, '⑫b 南风碰不应计大张台（仅红中 1 台）；实际 ' + dzSum12b);
    // ⑬ 通杀积分：字一色三家各付 128、总收入 384；连庄 mult 不生效
    var g13 = mk({ hand: ['f1','f1','f1','f2','f2','f2','f3','f3','f3','j1','j1','j1','j2','j2'] });
    var e13 = evaluateHu(g13, 1, null);
    var sc13 = calcScore(e13, g13, { mult: 2 });
    check(sc13.top && sc13.unit === TOP_PAY && sc13.pay[0] === TOP_PAY && sc13.pay[2] === TOP_PAY &&
          sc13.pay[3] === TOP_PAY && sc13.income === TOP_PAY * 3 && sc13.mult === 1,
          '⑬ 通杀：三家各付 128、总收入 384、不参与翻倍');
    // ⑭ 吃组不可补杠：吃了 t1t2t3，手牌又摸到 t1，不得出现补杠候选
    var g14 = mk({ hand: ['w1','w2','w3','w4','w5','w6','w7','w8','w9','t1','o1','o1'] });
    g14.players[1].peng.push({ type: 'chi', chiCodes: ['t1','t2','t3'],
      tiles: [T('t1'), T('t2'), T('t3')], fromSeat: 0 });
    check(findBuGangCodes(g14, 1).length === 0 && doBuGang(g14, 1, 't1') === null,
          '⑭ 吃组不可补杠（吃来的牌摸到第 4 张也不能杠）');
    // ⑮ 碰组可补杠：碰过 w1，手牌又摸到 w1 -> 可补杠
    var g15 = mk({ peng: ['w1'], hand: ['w1','w2','w3','w4','w5','w6','w7','w8','w9','o1','o1'] });
    var bu15 = findBuGangCodes(g15, 1);
    var bg15 = doBuGang(g15, 1, 'w1');
    check(bu15.length === 1 && bu15[0] === 'w1' && bg15 && bg15.type === 'bugang',
          '⑮ 碰组摸到第 4 张应可补杠');
    // ⑯ 散牌不胡
    check(!ev({ hand: ['w1','w2','w4','w5','w7','w8','t2','t4','t6','o1','o3','o5','f1','f2'] }).win,
          '⑯ 散牌不应判胡');
    return fails;
  }

  // ---------------- 导出 / 自动运行 ----------------

  var API = {
    SUITS: SUITS,
    createDeck: createDeck,
    tileName: tileName,
    shuffle: shuffle,
    nextWildCode: nextWildCode,
    createPlayer: createPlayer,
    sortHand: sortHand,
    dealNewGame: dealNewGame,
    rollDice: rollDice,
    diceStart: diceStart,
    wallSnapshot: wallSnapshot,
    newGame: newGame,
    drawTile: drawTile,
    discardTile: discardTile,
    pickRandomDiscard: pickRandomDiscard,
    pickSmartDiscard: pickSmartDiscard,
    handShanten: handShanten,
    caiChiWorth: caiChiWorth,
    shuangCaiPengWorth: shuangCaiPengWorth,
    getClaimOptions: getClaimOptions,
    passClaim: passClaim,
    takeFromDiscards: takeFromDiscards,
    doPeng: doPeng,
    doChi: doChi,
    getChiOptions: getChiOptions,
    doMingGang: doMingGang,
    findAnGangCodes: findAnGangCodes,
    doAnGang: doAnGang,
    isWild: isWild,
    // 阶段5：胡牌规则引擎
    TOP_TAI: TOP_TAI,
    TOP_PAY: TOP_PAY,
    evaluateHu: evaluateHu,
    canHuTile: canHuTile,
    getTenpaiCodes: getTenpaiCodes,
    calcScore: calcScore,
    capPayByBalance: capPayByBalance,
    findBuGangCodes: findBuGangCodes,
    doBuGang: doBuGang,
    rulesSelfTest: rulesSelfTest,
    validateGame: validateGame,
    printGame: printGame,
    ruleSelfTest: ruleSelfTest,
    runDemo: runDemo
  };

  root.MJCore = API;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = API;
    // node 直接运行本文件时自动演示
    if (require.main === module) {
      runDemo();
    }
  } else if (root.window && root.window.document) {
    // 浏览器中直接引入本脚本时自动演示一次
    runDemo();
  }
})();
