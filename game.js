/* ============================================================
 * 诸暨麻将 —— 阶段五：胡牌判定与结算交互
 * 依赖：mahjong-core.js（先加载，提供全局 MJCore）
 * 职责：
 *   1. 摸牌 / 点击出牌 / 逆时针回合流转（阶段三）；
 *   2. 碰 / 明杠 / 暗杠 / 补杠 鸣牌交互（阶段四+补杠）；
 *   3. 胡牌（玩家与 AI 共用 MJCore.evaluateHu）：
 *      - 自摸（含天胡、杠开）：摸牌后判定，玩家弹【胡】可选择胡或继续打；
 *      - 点炮 / 抢杠胡：鸣牌窗口按 胡 > 杠 > 碰 优先级裁决（多家按截胡顺序）；
 *      - 禁胡（刻顺混杂+财神+0台）引擎返回 banned=true，不弹胡、AI 不胡；
 *   4. 胡牌弹窗：展示胡牌方式、牌型、台数、unit 与四家收支；
 *   5. 杠（明/暗/补）后自动补摸；补杠进入抢杠窗口；牌墙摸完荒庄。
 * ============================================================ */
(function () {
  'use strict';

  var C = window.MJCore;
  if (!C) {
    console.error('[game.js] 未检测到 MJCore，请先加载 mahjong-core.js');
    return;
  }

  // ---- 音效挂接：包装核心动作函数，玩家与 AI 的同名动作都会触发 ----
  function A(name) { if (window.GameAudio) window.GameAudio.sfx(name); }
  function wrapMethod(obj, name, sfxName) {
    var orig = obj[name];
    if (typeof orig !== 'function') return;
    obj[name] = function () {
      var r = orig.apply(this, arguments);
      if (r) A(sfxName);
      return r;
    };
  }
  wrapMethod(C, 'discardTile', 'discard');
  wrapMethod(C, 'doPeng', 'peng');
  wrapMethod(C, 'doChi', 'chi');
  wrapMethod(C, 'doMingGang', 'gang');
  wrapMethod(C, 'doAnGang', 'gang');
  wrapMethod(C, 'doBuGang', 'gang');

  // 屏幕座位映射（与 mahjong-core 的座位编号一致）：
  //   0 东家 -> 左侧（上家）  1 南家 -> 底部（玩家）
  //   2 西家 -> 右侧（下家）  3 北家 -> 顶部（对家）
  // 出牌顺序：(seat + 1) % 4，即东 -> 南 -> 西 -> 北（逆时针）。
  var HUMAN_SEAT = 1;
  var SEAT_LABELS = ['东家', '南家（你）', '西家', '北家'];

  // 当前对局数据（MJCore.newGame 的返回值），未开局为 null
  var game = null;
  var aiTimer = null;    // 电脑行动定时器
  var aiDelay = 700;     // 电脑行动间隔（毫秒），测试可通过 setAiDelay(0) 加速
  var humanPassed = false; // 当前鸣牌窗口玩家是否已点【过】（点过后改由电脑结算）

  // ---- 回合倒计时：每家出牌 / 选择是否吃碰杠胡限时 10 秒 ----
  var TURN_LIMIT = 10000;
  var turnTimer = null;  // 超时动作定时器
  var turnTick = null;   // 进度条刷新定时器
  var turnDeadline = 0;  // 本轮截止时间戳
  var turnCtx = null;    // { seat, mode } mode: 'discard'(玩家出牌) | 'claim'(玩家鸣牌窗口) | 'ai' | 'aiwait'

  // ---- 跨局会话状态（阶段6：连庄 / 累计积分，重开局时保留）----
  var scores = [0, 0, 0, 0];  // 四家累计积分（正=赢分，负=输分）
  var bankerStreak = 0;       // 庄家连庄把数：庄胡 +1，闲家胡清零，流局不变；>=2 全局积分翻倍
  var nextBankerSeat = null;  // 下一局庄家座位（null=首局随机）

  // ---- 玩法模式（累计模式 / 带分模式）----
  var playMode = 'cumulate';  // 'cumulate' 累计模式：从 0 逐局累计；'bankroll' 带分模式：初始积分 + 余额封顶
  var initialScore = 100;     // 带分模式初始积分（四家相同，余额 = initialScore + scores[s]）
  var modeChosen = false;     // 是否已选定玩法（首局开始前先弹玩法选择弹窗）
  var sessionBusted = false;  // 带分模式：本场是否已有积分清零（整场结束，重开恢复初始积分）

  // ---- 结算后准备/开始状态 ----
  var readySeats = {};        // {seat: true} 已点准备的座位
  var settleWinner = null;    // 本局胡牌者座位（流局时为庄家），即下局庄家

  function $(id) { return document.getElementById(id); }

  // ---------------- 牌面 DOM（传统图案：万=蓝数字+红萬 / 筒=同心圆 / 条=竹节棒+幺鸡 / 字牌书法） ----------------

  var NUM_CHARS = ['一','二','三','四','五','六','七','八','九'];
  var WIND_CHARS_FULL = ['東','南','西','北'];

  // 一筒：彩色大饼（外绿齿环 + 蓝环 + 红圆心）
  var SVG_BIG_BING =
    '<svg class="face-svg big-bing" viewBox="0 0 40 40" preserveAspectRatio="xMidYMid meet">' +
      '<circle cx="20" cy="20" r="18" fill="#2f9e44"/>' +
      '<circle cx="20" cy="20" r="15" fill="#fffdf7"/>' +
      '<circle cx="20" cy="20" r="15" fill="none" stroke="#1e7a33" stroke-width="1.2" stroke-dasharray="2.2 1.7"/>' +
      '<circle cx="20" cy="20" r="11.5" fill="none" stroke="#263fb0" stroke-width="2.4"/>' +
      '<circle cx="20" cy="20" r="7.6" fill="#d4322a"/>' +
      '<circle cx="20" cy="20" r="3.2" fill="#fffdf7"/>' +
      '<circle cx="20" cy="20" r="1.5" fill="#2f9e44"/>' +
    '</svg>';

  // 一条：幺鸡（蓝身红冠绿尾）
  var SVG_BIRD =
    '<svg class="face-svg bird" viewBox="0 0 40 52" preserveAspectRatio="xMidYMid meet">' +
      '<path d="M21 33 C28 37 33 43 31 50" fill="none" stroke="#2f9e44" stroke-width="3" stroke-linecap="round"/>' +
      '<path d="M23 32 C30 36 35 41 34 48" fill="none" stroke="#2f9e44" stroke-width="3" stroke-linecap="round"/>' +
      '<path d="M19 35 C25 41 27 47 24 51" fill="none" stroke="#2f9e44" stroke-width="3" stroke-linecap="round"/>' +
      '<path d="M15 19 C22 13 29 20 26 30 C24 38 15 40 11 33 C8 27 10 23 15 19 Z" fill="#2b5fd9" stroke="#1c3fa8" stroke-width="1"/>' +
      '<path d="M15 27 C19 24 23 27 22 32 C19 30 16 30 14 32 Z" fill="#1c3fa8"/>' +
      '<circle cx="12" cy="15" r="6" fill="#2b5fd9" stroke="#1c3fa8" stroke-width="1"/>' +
      '<path d="M8 10 L9 6 L11 9.5 L13 5.5 L14.5 10 Z" fill="#d4322a"/>' +
      '<path d="M6.5 14 L2 12.5 L6 17 Z" fill="#e8a13a"/>' +
      '<circle cx="10.8" cy="13.8" r="1.3" fill="#fff"/>' +
    '</svg>';

  // 筒子二~七：
  //   cells 元素格式一（经典grid）：[行:int, 列:int, 颜色:str]
  //   cells 元素格式二（绝对中心定位，用于精细调整间距/斜飘）：[[xPct,yPct], 颜色:str, extraClass(可选)]
  var TONG_CELLS = {
    2: [[1,2,'b'],[3,2,'g']],
    3: [[1,1,'b'],[2,2,'r'],[3,3,'g']],
    4: [[1,1,'g'],[1,3,'b'],[3,1,'b'],[3,3,'g']],
    5: [[1,1,'g'],[1,3,'b'],[2,2,'r'],[3,1,'b'],[3,3,'g']],
    // 六筒：上2绿 / 中下4红（2×2方块），列距 35%W（左x=32.5右x=67.5）；
    //       三行 y=20/50/80，中间行居中，上下等距拉开使牌面更饱满
    6: [[[32.5,20],'g'],[[67.5,20],'g'],
        [[32.5,50],'r'],[[67.5,50],'r'],
        [[32.5,80],'r'],[[67.5,80],'r']],
    // 七筒：上3绿从左到右依次下降的斜线（y 24→32→40，左最高右最低）；下4红 2×2 方块整体下移（行 y=60/79，列 x=37/65），牌面顶部与红绿之间留空
    7: [[[29,24],'g',' d-sm'],[[52,32],'g',' d-sm'],[[75,40],'g',' d-sm'],
        [[37,60],'r',' d-lg'],[[65,60],'r',' d-lg'],
        [[37,79],'r',' d-lg'],[[65,79],'r',' d-lg']]
  };
  // 筒子八：2列x4行自动流（全蓝）；筒子九：3x3 行优先（上蓝/中红/下绿）
  var TONG_AUTO = {
    8: { cls: 'tong-8', colors: ['b','b','b','b','b','b','b','b'] },
    9: { cls: '',        colors: ['b','b','b','r','r','r','g','g','g'] }
  };

  // 条子布局：cells=显式定位；auto=网格自动流颜色序列；cls=网格变体
  var TIAO_LAYOUT = {
    2: { cls: '',        cells: [[1,2,'g'],[3,2,'g']] },
    3: { cls: 'tiao-3',  cells: [[1,2,'g'],[2,1,'g'],[2,3,'g']] },
    4: { cls: 'tiao-4',  auto: ['g','g','g','g'] },
    5: { cls: '',        cells: [[1,1,'g'],[1,3,'g'],[2,2,'r'],[3,1,'g'],[3,3,'g']] },
    // 六条：3 列 × 2 行全绿
    6: { cls: 'tiao-6',  auto: ['g','g','g','g','g','g'] },
    // 七条：最顶单独 1 根红棒居中；下面两行每行 3 根（绿-深蓝-绿）
    7: { cls: '',        cells: [[1,2,'r'],
                                 [2,1,'g'],[2,2,'b'],[2,3,'g'],
                                 [3,1,'g'],[3,2,'b'],[3,3,'g']] },
    // 八条：链式双 M/W —— 最外 4 根竖直竹棒（左右两列 x=27/78、上下两组 y=29/73）；
    //       内 4 根斜棒：上组 ∧ 外端接竖棒【下端】、中缝汇峰；下组 ∨ 外端接竖棒【上端】、中缝汇谷
    //       （rod-ccw = "\" 逆时针 / rod-cw = "/" 顺时针；棒长 40cqw、倾角 34°，端点锚定竖棒端部与中缝峰/谷）
    8: { cls: 'tiao-8', rods: [
      [[27,29],'g',' rod-v'],            [[78,29],'g',' rod-v'],
      [[41,31.5],'g',' rod-d rod-cw'],   [[63,31.5],'g',' rod-d rod-ccw'],
      [[27,73],'g',' rod-v'],            [[78,73],'g',' rod-v'],
      [[41,71.5],'g',' rod-d rod-ccw'],  [[63,71.5],'g',' rod-d rod-cw']
    ] },
    // 九条：3x3 按列自动流（grid-auto-flow:column）-> 左列绿/中列红/右列绿
    9: { cls: 'tiao-9',  auto: ['g','g','g','r','r','r','g','g','g'] }
  };

  function dotHTML(r, c, color, extraClass, centerPct) {
    // centerPct = [leftPct, topPct] 时使用 flex 绝对中心定位（.dot-center），绕过 grid；
    // 否则走 grid-area 经典定位 (r,c)。
    if (Array.isArray(r) && r.length === 2 && !c) {
      // 变形调用：dotHTML([x%,y%], null, color, extra)
      return '<i class="dot dot-center dot-' + color + (extraClass || '') + '" style="left:' + r[0] + '%;top:' + r[1] + '%"></i>';
    }
    return '<i class="dot dot-' + color + (extraClass || '') + '" style="grid-area:' + r + '/' + c + '"></i>';
  }
  function rodHTML(posOrColor, colorOrArea, extra) {
    // 绝对中心定位：rodHTML([xPct,yPct], color, extraClass) —— 八条竖棒/斜棒精确定位（.rod-center）
    if (Array.isArray(posOrColor)) {
      return '<i class="rod rod-center rod-' + colorOrArea + (extra || '') +
             '" style="left:' + posOrColor[0] + '%;top:' + posOrColor[1] + '%"></i>';
    }
    var st = colorOrArea ? ' style="grid-area:' + colorOrArea + '"' : '';
    return '<i class="rod rod-' + posOrColor + '"' + st + '></i>';
  }

  // 生成一张明牌的内部 HTML
  function tileFaceHTML(code) {
    var suitKey = code.charAt(0);
    var rank = parseInt(code.slice(1), 10);

    // 万子：蓝色中文数字 + 红色繁体「萬」
    if (suitKey === 'w') {
      return '<span class="tile-face face-wan" data-code="' + code + '">' +
             '<span class="wan-num">' + NUM_CHARS[rank - 1] + '</span>' +
             '<span class="wan-char">萬</span></span>';
    }
    // 风牌：深蓝繁体书法字
    if (suitKey === 'f') {
      return '<span class="tile-face face-zi zi-wind" data-code="' + code + '">' +
             WIND_CHARS_FULL[rank - 1] + '</span>';
    }
    if (suitKey === 'j') {
      if (rank === 3) {   // 白板：蓝色双线框
        return '<span class="tile-face" data-code="' + code + '"><span class="bai-box"></span></span>';
      }
      if (rank === 1) {   // 红中
        return '<span class="tile-face face-zi zi-zhong" data-code="' + code + '">中</span>';
      }
      // 发财：绿色繁体「發」
      return '<span class="tile-face face-zi zi-fa" data-code="' + code + '">發</span>';
    }
    // 筒子：同心圆图案（逐张加修饰类 tong-N 以便 CSS 精细控制点径与布局）
    if (suitKey === 'o') {
      if (rank === 1) {
        return '<span class="tile-face face-tong tong-1" data-code="' + code + '">' + SVG_BIG_BING + '</span>';
      }
      var classes = ['face-tong', 'tong-' + rank];
      var content;
      if (TONG_CELLS[rank]) {
        content = TONG_CELLS[rank].map(function (cell) {
          // cell 格式一：[行:int, 列:int, 颜色[:str], extra[:str]]
          // cell 格式二：[[xPct,yPct], 颜色[:str], extra[:str]]
          var pos = cell[0], color = cell[1], extra = cell[2] || '';
          if (Array.isArray(pos)) {
            // 格式二：[[x,y], color, extra?]
            // rank===7 但 cell 已带 d-sm/d-lg 的 extra 时不覆盖
            if (rank === 7 && TONG_AUTO /* dead ref */) {}
            return dotHTML(pos, null, color, extra);
          } else {
            // 格式一：[row, col, color, extra?]；七筒兼容旧时补 extra（若 cell[2] 未带）
            // 对老七筒若缺少 d-sm/d-lg，按位置自动补；但新 cells 格式二已在 cell[2] 携带，故此分支仅用于 2~5 筒等
            var rInt = pos, cInt = color, colStr = cell[2] || '', extra2 = cell[3] || '';
            if (rank === 7 && !extra2.match(/d-(sm|lg)/)) extra2 = (TONG_CELLS[rank].indexOf(cell) < 3 ? ' d-sm' : ' d-lg');
            // 注意：对 2~5 筒等老格式 cell 长度是 3 → [r,c,颜色]，无 extra；此时 colStr 是颜色字段，extra2 是空
            if (cell.length === 3 && !extra2) {
              // 老三参 [r,c,color]
              return dotHTML(rInt, cInt, colStr, '');
            } else {
              // 四参 [r,c,color,extra]
              return dotHTML(rInt, cInt, colStr, extra2);
            }
          }
        }).join('');
      } else {
        var a = TONG_AUTO[rank];
        classes.push(a.cls);
        if (rank === 7) {
          // 七筒：前 3 个（上排绿）= d-sm 小圈；后 4 个（红）= d-lg 大圈
          content = a.colors.map(function (color, i) {
            return '<i class="dot dot-' + color + ' ' + (i < 3 ? 'd-sm' : 'd-lg') + '"></i>';
          }).join('');
        } else {
          content = a.colors.map(function (color) { return '<i class="dot dot-' + color + '"></i>'; }).join('');
        }
      }
      return '<span class="tile-face ' + classes.join(' ') + '" data-code="' + code + '">' + content + '</span>';
    }
    // 条子：竹节棒图案
    if (rank === 1) {
      return '<span class="tile-face face-tiao" data-code="' + code + '">' + SVG_BIRD + '</span>';
    }
    var lay = TIAO_LAYOUT[rank];
    var h = '<span class="tile-face face-tiao ' + lay.cls + '" data-code="' + code + '">';
    if (lay.cells) {
      h += lay.cells.map(function (cell) {
        return rodHTML(cell[2], cell[0] + '/' + cell[1]);
      }).join('');
    }
    if (lay.rods) {
      h += lay.rods.map(function (cell) {
        return rodHTML(cell[0], cell[1], cell[2]);
      }).join('');
    }
    if (lay.auto) {
      h += lay.auto.map(function (color) { return rodHTML(color); }).join('');
    }
    return h + '</span>';
  }

  // 创建一张牌 DOM
  //   opts.faceDown=true -> 牌背；opts.small=true -> 小尺寸（电脑牌/弃牌/鸣牌组）
  function makeTile(code, opts) {
    opts = opts || {};
    var el = document.createElement('div');
    var cls = 'tile';
    if (opts.small) cls += ' tile-sm';
    if (opts.faceDown) {
      cls += ' tile-back';
    } else {
      if (game && C.isWild(game, code)) cls += ' tile-wild';
      el.innerHTML = tileFaceHTML(code);
    }
    el.className = cls;
    return el;
  }

  // ---------------- 牌墙 / 骰子 / 开局动画 ----------------

  // 牌桌上的牌背小砖（摞里的一张）
  function makeWallBack() {
    var d = document.createElement('div');
    d.className = 'wall-back';
    return d;
  }

  // 渲染桌面牌墙：四家面前各 17 摞，每摞两张叠放；已摸走的摞消失；
  // 财神（基准牌）亮在未摸牌墙的最后一摞上。
  //   reveal：开局发牌动画期间传入「已摸走的全局牌位数」(0~54)；对局中传 null。
  function renderWall(reveal) {
    if (!game || !game.wall) return;
    var snap = C.wallSnapshot(game, reveal);
    if (!snap) return;
    var showIndicator = (reveal == null) || reveal >= 54;
    var rows = { 3: $('wall-seat-3'), 2: $('wall-seat-2'), 1: $('wall-seat-1'), 0: $('wall-seat-0') };
    Object.keys(rows).forEach(function (key) {
      var seat = +key;
      var box = rows[seat];
      if (!box) return;
      box.innerHTML = '';
      snap.filter(function (st) { return st.seat === seat; })
          .sort(function (a, b) { return a.idx - b.idx; })
          .forEach(function (st) {
            if (st.topTaken && st.botTaken && !(st.indicator && showIndicator)) return;  // 空摞不占位
            var stk = document.createElement('div');
            stk.className = 'wall-stack';
            // 下张（偏移在外）后插、上张（靠近摞顶）先插在上层
            if (!st.botTaken) stk.appendChild(makeWallBack());
            if (!st.topTaken) {
              var top = makeWallBack();
              top.classList.add('wall-back-top');
              stk.appendChild(top);
            }
            if (st.indicator && showIndicator && game.indicator) {
              var ind = makeTile(game.indicator.code, { small: true });
              ind.classList.add('wall-indicator', 'wall-ind-seat-' + seat);
              stk.appendChild(ind);
            }
            box.appendChild(stk);
          });
    });
  }

  // ---------------- 骰子（开局掷到桌面中央 → 落定 → 缩小飞入左上角 HUD 常驻） ----------------

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

  // 骰子归位 HUD（测试加速 / 中途重开兜底）：无动画、小号常驻
  function settleDiceImmediate() {
    var box = $('dice-box'), hud = $('hud-dice');
    if (box && hud && box.parentNode !== hud) hud.appendChild(box);
    if (box) {
      box.classList.remove('dice-rolling', 'dice-landed', 'dice-fly');
      box.classList.add('dice-settled');
      box.style.transition = '';
      box.style.transform = '';
    }
  }

  // 开局掷骰：骰子移到桌面中央舞台，放大并开始翻滚动画
  function diceToStage() {
    var box = $('dice-box'), stage = $('dice-stage');
    if (!box || !stage) return;
    box.classList.remove('dice-settled', 'dice-landed', 'dice-fly');
    box.style.transition = '';
    box.style.transform = '';
    if (box.parentNode !== stage) stage.appendChild(box);
    void box.offsetWidth;   // 强制回流后再挂滚动类，保证动画从头播放
    box.classList.add('dice-rolling');
  }

  // 骰子落定：停翻滚、显示最终点数、砸桌回弹
  function diceLand(a, b) {
    var box = $('dice-box');
    renderDice(a, b);
    if (box) {
      box.classList.remove('dice-rolling');
      box.classList.add('dice-landed');
    }
  }

  // FLIP 动画：把桌面中央的大骰子缩小、平移飞入左上角 HUD（余牌/财神之后）
  function flyDiceToHud(onDone) {
    var box = $('dice-box'), hud = $('hud-dice');
    if (!box || !hud) { if (onDone) onDone(); return; }
    var first = box.getBoundingClientRect();
    // 第一帧：实际迁移到 HUD 并换成小号布局
    box.classList.remove('dice-landed', 'dice-rolling', 'dice-fly');
    box.style.transition = '';
    box.style.transform = '';
    hud.appendChild(box);
    box.classList.add('dice-settled');
    void box.offsetWidth;
    var last = box.getBoundingClientRect();
    // 反演：先用 transform 把小骰子伪装回桌面中央的大骰子位置/尺寸
    var dx = (first.left + first.width / 2) - (last.left + last.width / 2);
    var dy = (first.top + first.height / 2) - (last.top + last.height / 2);
    var sx = first.width / last.width;
    var sy = first.height / last.height;
    box.style.transform = 'translate(' + dx + 'px,' + dy + 'px) scale(' + sx + ',' + sy + ')';
    var finished = false;
    function finish() {
      if (finished) return;
      finished = true;
      box.removeEventListener('transitionend', finish);
      box.classList.remove('dice-fly');
      box.style.transition = '';
      box.style.transform = '';
      if (onDone) onDone();
    }
    box.addEventListener('transitionend', finish);
    setTimeout(finish, 520);   // 兜底：transitionend 丢失也不卡流程
    // 下一帧：加过渡并清除反演 transform → 缩小飞回 HUD
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        box.classList.add('dice-fly');
        box.style.transform = 'translate(0,0) scale(1,1)';
      });
    });
  }

  // 财神揭示：仅在牌桌中心以正常牌大小展示翻出的那张基准牌 0.5 秒，
  // 然后缩小飞入左上角 HUD 的翻基准槽位（FLIP 动画）；
  // 双财神直接以小牌放入 HUD 财神槽位，不参与中心展示与动画。
  function revealWildsAtCenter(onDone) {
    var compass = $('compass');
    if (!compass || !game) { if (onDone) onDone(); return; }

    // 中心舞台：只放翻出的基准牌一张
    var stage = document.createElement('div');
    stage.style.cssText = 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);' +
                          'display:flex;gap:6px;z-index:10;pointer-events:none;';
    var indEl = makeTile(game.indicator.code, {});
    stage.appendChild(indEl);
    compass.appendChild(stage);

    preTimeout(function () {
      var indSlot = $('indicator-slot');
      var wildSlot = $('wild-slot');
      // 双财神直接放入 HUD 财神槽（小牌，无动画）
      if (wildSlot) {
        wildSlot.innerHTML = '';
        game.wilds.forEach(function (code) {
          wildSlot.appendChild(makeTile(code, { small: true }));
        });
      }
      if (indSlot) indSlot.innerHTML = '';

      // 基准牌从中心飞入翻基准槽
      var first = indEl.getBoundingClientRect();
      if (indSlot) indSlot.appendChild(indEl);
      indEl.classList.add('tile-sm');
      var last = indEl.getBoundingClientRect();
      var dx = (first.left + first.width / 2) - (last.left + last.width / 2);
      var dy = (first.top + first.height / 2) - (last.top + last.height / 2);
      var sx = first.width / last.width;
      var sy = first.height / last.height;
      indEl.style.transition = '';
      indEl.style.transform = 'translate(' + dx + 'px,' + dy + 'px) scale(' + sx + ',' + sy + ')';
      var finished = false;
      function finish() {
        if (finished) return;
        finished = true;
        indEl.removeEventListener('transitionend', finish);
        indEl.style.transition = '';
        indEl.style.transform = '';
        if (stage.parentNode) stage.parentNode.removeChild(stage);
        if (onDone) onDone();
      }
      indEl.addEventListener('transitionend', finish);
      setTimeout(finish, 520);
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          indEl.style.transition = 'transform .45s cubic-bezier(.4,0,.2,1)';
          indEl.style.transform = 'translate(0,0) scale(1,1)';
        });
      });
    }, 500);
  }

  // ---------------- 开局流程（掷骰 → 发牌 → 亮财神） ----------------

  var prePhase = 'idle';    // 'idle' | 'wait'（等庄家点开始）| 'dice' | 'deal' | 'play'
  var dealReveal = 0;       // 发牌动画进度：已摸走的全局牌位数（0~54）
  var preTimers = [];       // 开局动画定时器

  function clearPreTimers() {
    preTimers.forEach(function (t) { clearTimeout(t); });
    preTimers = [];
    stopTurnTimer();
  }
  function preTimeout(fn, ms) {
    var t = setTimeout(function () {
      preTimers = preTimers.filter(function (x) { return x !== t; });
      fn();
    }, ms);
    preTimers.push(t);
    return t;
  }

  // 发牌接收规则（与 mahjong-core.dealNewGame 一致）：从庄家起顺时针
  function dealtCountToSeat(bankerSeat, seat, reveal) {
    var n = 0;
    for (var k = 0; k < reveal && k <= 52; k++) {
      var r;
      if (k < 48) r = (bankerSeat - (Math.floor(k / 4) % 4) + 8) % 4;
      else if (k === 52) r = bankerSeat;
      else r = (bankerSeat - (k - 48) + 8) % 4;
      if (r === seat) n++;
    }
    return n;
  }

  // 开局动画期间的渲染：牌墙按 reveal 消减、各家牌背逐张到位、中央骰子滚动
  function renderPreplay() {
    if (!game) return;
    var bankerSeat = game.bankerSeat;
    var reveal = dealReveal;

    // 牌墙
    renderWall(reveal);

    // HUD
    $('wall-count').textContent = String(game.deck.length);
    var indSlot = $('indicator-slot');
    var wildSlot = $('wild-slot');
    if (reveal >= 54) {
      indSlot.innerHTML = '';
      indSlot.appendChild(makeTile(game.indicator.code, { small: true }));
      wildSlot.innerHTML = '';
      game.wilds.forEach(function (code) { wildSlot.appendChild(makeTile(code, { small: true })); });
    } else {
      indSlot.innerHTML = '<span class="placeholder">发牌中</span>';
      wildSlot.innerHTML = '<span class="placeholder">发牌中</span>';
    }

    // 四家：牌数 / 庄家红灯 / 牌背逐张到位
    for (var s = 0; s < 4; s++) {
      var n = dealtCountToSeat(bankerSeat, s, reveal);
      $('count-seat-' + s).textContent = n + ' 张';
      var lamp = $('lamp-' + s);
      if (lamp) lamp.classList.toggle('on', s === bankerSeat);
      var seatEl = document.querySelector('.seat[data-seat="' + s + '"]');
      if (seatEl) seatEl.classList.remove('active');
      var scoreEl = $('score-seat-' + s);
      if (scoreEl) renderSeatScore(scoreEl, s);
      // 清空弃牌区/副露
      var discEl = $('discard-seat-' + s);
      if (discEl) discEl.innerHTML = '';
      var setsEl = $('sets-seat-' + s);
      if (setsEl) setsEl.innerHTML = '';
      if (s === HUMAN_SEAT) {
        var handEl = $('hand-seat-' + s);
        handEl.innerHTML = '';
        handEl.classList.remove('can-play');
        for (var i = 0; i < n; i++) handEl.appendChild(makeTile(null, { faceDown: true }));
      } else {
        var backsEl = $('backs-seat-' + s);
        backsEl.innerHTML = '';
        for (var j = 0; j < n; j++) backsEl.appendChild(makeTile(null, { faceDown: true, small: true }));
      }
    }

    // 听牌条隐藏
    var bar = $('tenpai-bar');
    if (bar) { bar.classList.add('hidden'); bar.innerHTML = ''; }
    var si = $('streak-info');
    if (si) { si.textContent = ''; si.classList.add('hidden'); }
    // 连庄次数小方块：跨局保留显示
    var streakText = bankerStreak > 0 ? String(bankerStreak) : '00';
    [0, 1, 2, 3].forEach(function (s) {
      var el = $('streak-box-' + s);
      if (el) {
        el.textContent = streakText;
        el.classList.toggle('active', bankerStreak >= 1);
      }
    });
  }

  // 座位分数显示：累计模式显示输赢累计（+X/-X）；带分模式显示当前余额（初始 + 累计）
  function renderSeatScore(el, s) {
    if (playMode === 'bankroll' && modeChosen) {
      var bal = Math.max(0, initialScore + scores[s]);
      el.textContent = bal + ' 分';
      el.className = 'seat-score' + (bal > initialScore ? ' score-up' : bal < initialScore ? ' score-down' : '');
    } else {
      var v = scores[s];
      el.textContent = (v > 0 ? '+' : '') + v + ' 分';
      el.className = 'seat-score' + (v > 0 ? ' score-up' : v < 0 ? ' score-down' : '');
    }
  }

  // 开局：建局 → 掷骰动画 → 发牌动画 → 进入对局
  function beginRound() {
    clearPreTimers();
    clearTimeout(aiTimer);
    humanPassed = false;
    hideActions();
    var modal = $('win-modal');
    if (modal) modal.classList.add('hidden');

    // 庄家：首局随机；之后按连庄/断庄/流局结果轮转
    if (nextBankerSeat == null) nextBankerSeat = Math.floor(Math.random() * 4);
    var dice = C.rollDice();
    game = C.newGame(nextBankerSeat, { dice: dice });

    // 开局后隐藏罗盘下方的「开始」按钮
    var btn = $('btn-start');
    if (btn) { btn.classList.add('hidden'); btn.classList.remove('pulse'); }

    var streakText = '';
    if (bankerStreak >= 2) streakText = '（连庄 ×2 翻倍中，庄家连胡 ' + bankerStreak + ' 把）';
    else if (bankerStreak === 1) streakText = '（庄家连庄 1 把）';

    // 测试加速（aiDelay=0）：跳过动画，一次性到位
    if (aiDelay === 0) {
      prePhase = 'play';
      dealReveal = 54;
      settleDiceImmediate();
      renderDice(dice[0], dice[1]);
      setStatus('开局！庄家：' + SEAT_LABELS[game.bankerSeat] +
                '；掷骰 ' + dice[0] + '、' + dice[1] + ' 点；本局双财神：【' + C.tileName(game.wilds[0]) +
                '】、【' + C.tileName(game.wilds[1]) + '】。' + streakText);
      render();
      advance();
      return;
    }

    // 正式动画流程
    prePhase = 'dice';
    dealReveal = 0;
    renderPreplay();
    setStatus('庄家掷骰…');
    diceToStage();   // 两颗立体骰子上到桌面中央，开始翻滚
    A('dice');

    // ① 骰子翻滚（约 0.9 秒，点数快速变换）
    var ticks = 0;
    var rollTimer = setInterval(function () {
      ticks++;
      renderDice(1 + Math.floor(Math.random() * 6), 1 + Math.floor(Math.random() * 6));
      if (ticks >= 10) {
        clearInterval(rollTimer);
        // 落定：停翻滚、显示最终点数、砸桌回弹
        diceLand(dice[0], dice[1]);
        preTimeout(function () {
          // ② 骰子缩小飞入左上角 HUD（与发牌并行）
          flyDiceToHud();
          // ③ 发牌：每次 4 张（每家一摞两摞），共 13 轮，再补尾张+亮财神
          prePhase = 'deal';
          setStatus('开牌！从' + SEAT_LABELS[game.wall.wallSeat] + '面前牌墙起牌…');
          dealReveal = 0;
          var dealTimer = setInterval(function () {
            dealReveal = Math.min(54, dealReveal + 4);
            renderPreplay();
            if (dealReveal >= 54) {
              clearInterval(dealTimer);
              preTimeout(function () {
                // ③ 财神在牌桌中心展示 0.5 秒后缩小飞入左上角 HUD，再进入对局
                revealWildsAtCenter(function () {
                  prePhase = 'play';
                  setStatus('开局！庄家：' + SEAT_LABELS[game.bankerSeat] +
                            '；掷骰 ' + dice[0] + '、' + dice[1] + ' 点；本局双财神：【' + C.tileName(game.wilds[0]) +
                            '】、【' + C.tileName(game.wilds[1]) + '】。' + streakText);
                  render();
                  advance();
                });
              }, 350);
            }
          }, 90);
          preTimers.push(dealTimer);
        }, 450);
      }
    }, 90);
    // 让 rollTimer 也能被清理
    preTimers.push(rollTimer);
  }

  // ---------------- 渲染 ----------------

  function render() {
    if (!game) { positionSouthDiscard(); return; }
    stopTurnTimer();   // 每次状态重渲染即终止上一回合倒计时，后续等待分支会重新开启
    selectedDiscardId = null;   // 手牌 DOM 将重建，两次点击选中的突出状态同步清空

    // 左上角 HUD：牌墙剩余张数
    $('wall-count').textContent = String(game.deck.length);

    // 左上角 HUD：翻基准牌（小牌）
    var indSlot = $('indicator-slot');
    indSlot.innerHTML = '';
    indSlot.appendChild(makeTile(game.indicator.code, { small: true }));

    // 左上角 HUD：本局双财神（金色高亮，小牌）
    var wildSlot = $('wild-slot');
    wildSlot.innerHTML = '';
    game.wilds.forEach(function (code) {
      wildSlot.appendChild(makeTile(code, { small: true }));
    });

    var turn = game.turn;
    var activeSeat = (turn && turn.phase !== 'over') ? turn.currentSeat : -1;

    // 牌桌牌墙（68 摞，随摸牌消减；财神亮在末尾摞上）
    renderWall(null);

    // 左上角 HUD：本局骰子点数（常驻小骰子）
    if (game.wall) renderDice(game.wall.dice[0], game.wall.dice[1]);

    // 四家
    for (var s = 0; s < 4; s++) {
      var p = game.players[s];
      $('count-seat-' + s).textContent = p.hand.length + ' 张';
      // 庄家指示：中央罗盘对应风位旁的小圆灯亮红（不再显示“庄”字）
      var lamp = $('lamp-' + s);
      if (lamp) lamp.classList.toggle('on', !!p.isBanker);

      // 累计积分（跨局）：累计模式显示输赢累计；带分模式显示当前余额
      var scoreEl = $('score-seat-' + s);
      if (scoreEl) renderSeatScore(scoreEl, s);

      // 当前行动座位高亮（座位区 + 边缘信息条）
      var seatEl = document.querySelector('.seat[data-seat="' + s + '"]');
      if (seatEl) seatEl.classList.toggle('active', s === activeSeat);
      var infoEl = document.querySelector('.seat-info[data-seat="' + s + '"]');
      if (infoEl) infoEl.classList.toggle('active', s === activeSeat);

      // 弃牌区：明牌，按打出顺序排列（新增牌带弹入动画）
      // 鸣牌窗口中待响应的牌以"浮动大牌"形式显示在出牌者与圆心之间，
      // 不在弃牌堆渲染；确认无人鸣牌后再缩小飞入弃牌堆末尾。
      var discEl = $('discard-seat-' + s);
      discEl.innerHTML = '';
      var prevDisc = game._uiDisc ? game._uiDisc[s] : 0;
      var pdTile = (turn && turn.phase === 'claim' && turn.pendingDiscard &&
                    !turn.pendingDiscard.gang) ? turn.pendingDiscard : null;
      p.discards.forEach(function (t, i) {
        // 鸣牌窗口中待响应的牌：跳过，由浮动出牌展示
        if (pdTile && s === pdTile.seat && t.id === pdTile.tile.id) return;
        var el = makeTile(t.code, { small: true });
        el.dataset.tileId = t.id;
        if (i >= prevDisc) el.classList.add('tile-pop');
        discEl.appendChild(el);
      });
      game._uiDisc = game._uiDisc || [0, 0, 0, 0];
      game._uiDisc[s] = p.discards.length;

      // 公开鸣牌区：碰（3 明）/ 明杠（4 明）/ 暗杠（明-背-背-明）
      renderSets(s);

      if (s === HUMAN_SEAT) {
        // 玩家：明牌。展示顺序：财神统一置于最左，其余按 万->条->筒->风->箭 排序；
        // 刚摸到的牌抽出、留一点间隔置于最右侧，方便一眼看到摸进的牌。
        p.hand = C.sortHand(p.hand);
        var handEl = $('hand-seat-' + s);
        handEl.innerHTML = '';
        var isMyDiscard = !!(turn && turn.phase === 'discard' && turn.currentSeat === s);
        var drawnId = isMyDiscard ? turn.drawnTileId : null;
        var wildTiles = [], normalTiles = [], drawnTile = null;
        p.hand.forEach(function (t) {
          if (drawnId != null && t.id === drawnId) { drawnTile = t; return; }
          if (C.isWild(game, t.code)) wildTiles.push(t);
          else normalTiles.push(t);
        });
        function addHandTile(t, drawn) {
          var el = makeTile(t.code);
          el.dataset.tileId = t.id;
          if (drawn) el.classList.add('tile-drawn');
          handEl.appendChild(el);
        }
        wildTiles.forEach(function (t) { addHandTile(t, false); });
        normalTiles.forEach(function (t) { addHandTile(t, false); });
        if (drawnTile) {
          var gap = document.createElement('span');
          gap.className = 'tile-gap';
          handEl.appendChild(gap);
          addHandTile(drawnTile, true);
        }
        // 仅轮到玩家出牌时手牌可点击
        handEl.classList.toggle('can-play', isMyDiscard);
      } else {
        // 电脑：对局中只显示牌背；对局结束（胡牌/流局）则翻面亮明牌，供四家核对
        var backsEl = $('backs-seat-' + s);
        backsEl.innerHTML = '';
        if (turn && turn.phase === 'over') {
          // 亮牌同序：财神最左，其余按花色点数
          var revealed = C.sortHand(p.hand.slice());
          var rWild = revealed.filter(function (t) { return C.isWild(game, t.code); });
          var rNorm = revealed.filter(function (t) { return !C.isWild(game, t.code); });
          rWild.concat(rNorm).forEach(function (t) {
            backsEl.appendChild(makeTile(t.code, { small: true }));
          });
        } else {
          for (var i = 0; i < p.hand.length; i++) {
            backsEl.appendChild(makeTile(null, { faceDown: true, small: true }));
          }
        }
      }
    }

    // 连庄状态指示（中央面板）
    var si = $('streak-info');
    if (si) {
      if (bankerStreak >= 2) {
        si.textContent = '连庄翻倍 ×2 生效中（庄家连胡 ' + bankerStreak + ' 把）';
      } else if (bankerStreak === 1) {
        si.textContent = '庄家连庄 1 把（再胡 1 把全局翻倍）';
      } else {
        si.textContent = '';
      }
      si.classList.toggle('hidden', !si.textContent);
    }
    // 连庄次数小方块：数字=连续坐庄次数-1（首次坐庄显示00，第2次显示1，第3次显示2...）；连庄(≥2把)高亮
    var streakText = bankerStreak > 0 ? String(bankerStreak) : '00';
    [0, 1, 2, 3].forEach(function (s) {
      var el = $('streak-box-' + s);
      if (el) {
        el.textContent = streakText;
        el.classList.toggle('active', bankerStreak >= 1);
      }
    });

    // 听牌提示：玩家处于等待胡牌状态（13 张）时，列出可胡的牌
    renderTenpai();
    positionSouthDiscard();

    // 鸣牌窗口：待响应牌以浮动大牌显示在出牌者与圆心之间
    var turn = game.turn;
    if (turn && turn.phase === 'claim' && turn.pendingDiscard && !turn.pendingDiscard.gang) {
      showFloatingDiscard(turn.pendingDiscard.tile.code, turn.pendingDiscard.seat);
    } else {
      hideFloatingDiscard();
    }
  }

  // 听牌提示条：枚举玩家可胡牌张并展示（财神张加金边）
  function renderTenpai() {
    var bar = $('tenpai-bar');
    if (!bar) return;
    if (!game || game.turn.phase === 'over') {
      bar.classList.add('hidden');
      bar.innerHTML = '';
      return;
    }
    var waits = C.getTenpaiCodes(game, HUMAN_SEAT);
    if (!waits.length) {
      bar.classList.add('hidden');
      bar.innerHTML = '';
      return;
    }
    bar.innerHTML = '';
    var label = document.createElement('span');
    label.className = 'tenpai-label';
    label.textContent = '听牌 ' + waits.length + ' 张';
    bar.appendChild(label);
    waits.forEach(function (code) {
      bar.appendChild(makeTile(code, { small: true }));
    });
    bar.classList.remove('hidden');
    positionTenpai();
  }

  // 牌桌内容整体缩放比例（由可用空间 / 设计尺寸 计算，范围 0.35 ~ 1）
  var tableScale = 1;
  var DESIGN_W = 1150, DESIGN_H = 680;
  function updateTableScale() {
    var tableEl = document.querySelector('.table');
    if (!tableEl) return;
    // 可用空间 = 牌桌内容区（扣除 10px 边框）
    var availW = tableEl.clientWidth;
    var availH = tableEl.clientHeight;
    var s = Math.min(availW / DESIGN_W, availH / DESIGN_H);
    s = Math.max(0.35, Math.min(1, s));   // 只缩小不放大，且不低于 0.35
    tableScale = s;
    tableEl.style.setProperty('--table-scale', s.toFixed(4));
  }

  // 听牌条定位：紧凑小条浮在玩家手牌最右侧一张的上方（随手牌长度自动贴合）
  function positionTenpai() {
    var bar = $('tenpai-bar');
    if (!bar || bar.classList.contains('hidden')) return;
    var hand = $('hand-seat-' + HUMAN_SEAT);
    var inner = document.querySelector('.table-inner');
    if (!hand || !inner) return;
    var tiles = hand.querySelectorAll('.tile');
    var anchor = tiles[tiles.length - 1];
    if (!anchor) return;
    var innerRect = inner.getBoundingClientRect();
    var tr = anchor.getBoundingClientRect();
    var br = bar.getBoundingClientRect();
    // .table-inner 经过 scale 变换，屏幕坐标需除以缩放比换算为内层局部坐标
    var leftAbs = tr.left + tr.width / 2 - br.width / 2;
    leftAbs = Math.max(6, Math.min(window.innerWidth - br.width - 6, leftAbs));
    var topAbs = tr.top - br.height - 6;
    topAbs = Math.max(6, topAbs);
    bar.style.left = ((leftAbs - innerRect.left) / tableScale) + 'px';
    bar.style.top = ((topAbs - innerRect.top) / tableScale) + 'px';
  }

  // 动作栏定位：浮在玩家手牌最右侧一张的上方，右边缘与手牌最右对齐
  function positionActionBar() {
    var bar = $('action-bar');
    if (!bar || bar.classList.contains('hidden')) return;
    var hand = $('hand-seat-' + HUMAN_SEAT);
    if (!hand) return;
    var tiles = hand.querySelectorAll('.tile');
    if (!tiles.length) return;
    var last = tiles[tiles.length - 1].getBoundingClientRect();
    var leftAbs = last.right - bar.offsetWidth;
    leftAbs = Math.max(6, Math.min(window.innerWidth - bar.offsetWidth - 6, leftAbs));
    var bottomAbs = window.innerHeight - last.top + 10;
    bottomAbs = Math.max(6, bottomAbs);
    bar.style.left = leftAbs + 'px';
    bar.style.bottom = bottomAbs + 'px';
  }

  // 南家牌河定位：紧贴罗盘下方，与东西北三家保持一致的 9px 间距
  function positionSouthDiscard() {
    var discard = $('discard-seat-1');
    if (!discard) return;
    // 南家牌河紧贴罗盘下方，与东西北三家间距一致（9px）
    discard.style.marginTop = '9px';
  }

  // ---------------- 浮动出牌动画 ----------------
  // 打出的牌先以"手牌大小"显示在出牌者与罗盘圆心之间的中点，
  // 鸣牌窗口确认无人吃/碰/胡后，等 0.5 秒再缩小飞入弃牌堆末尾。
  var floatingDiscardEl = null;
  function getFloatingDiscardEl() {
    if (floatingDiscardEl) return floatingDiscardEl;
    var inner = document.querySelector('.table-inner');
    if (!inner) return null;
    floatingDiscardEl = document.createElement('div');
    floatingDiscardEl.id = 'floating-discard';
    floatingDiscardEl.className = 'floating-discard hidden';
    inner.appendChild(floatingDiscardEl);
    return floatingDiscardEl;
  }

  // 将浮动出牌定位到出牌者手牌区与罗盘圆心之间的中点
  // 出牌者座位对应的旋转角度，使牌头朝向牌桌中心
  //   seat 1 南(下)→0°、3 北(上)→180°、0 東(左)→90°、2 西(右)→-90°
  function seatRotation(seat) {
    switch (seat) {
      case 3: return 180;
      case 0: return 90;
      case 2: return -90;
      default: return 0;
    }
  }

  function positionFloatingDiscard(seat) {
    var el = getFloatingDiscardEl();
    if (!el) return;
    var compass = $('compass');
    var hand = $('hand-seat-' + seat) || $('backs-seat-' + seat);
    if (!compass || !hand) return;
    var cr = compass.getBoundingClientRect();
    var hr = hand.getBoundingClientRect();
    var mx = (cr.left + cr.right + hr.left + hr.right) / 4;
    var my = (cr.top + cr.bottom + hr.top + hr.bottom) / 4;
    var inner = document.querySelector('.table-inner');
    var ir = inner.getBoundingClientRect();
    // 浮动出牌位于缩放层内，屏幕坐标除以缩放比换算为内层局部坐标
    el.style.left = ((mx - ir.left) / tableScale - el.offsetWidth / 2) + 'px';
    el.style.top = ((my - ir.top) / tableScale - el.offsetHeight / 2) + 'px';
  }

  // 显示浮动出牌（鸣牌窗口期间常驻中点，牌头朝向中心）
  function showFloatingDiscard(code, seat) {
    var el = getFloatingDiscardEl();
    if (!el) return;
    el.innerHTML = '';
    el.appendChild(makeTile(code));   // 手牌大小
    el.classList.remove('hidden', 'flying');
    el.style.transition = '';
    el.style.transform = 'rotate(' + seatRotation(seat) + 'deg)';
    positionFloatingDiscard(seat);
  }

  function hideFloatingDiscard() {
    var el = getFloatingDiscardEl();
    if (el) el.classList.add('hidden');
  }

  // 浮动出牌直接缩小飞入弃牌堆末尾：从当前手牌大小平移+缩放到弃牌堆小牌
  //   seat: 出牌者座位；done: 动画结束回调
  function flyFloatingToDiscard(seat, done) {
    var el = getFloatingDiscardEl();
    if (!el || el.classList.contains('hidden')) { done && done(); return; }
    var discEl = $('discard-seat-' + seat);
    if (!discEl) { hideFloatingDiscard(); done && done(); return; }

    var rot = seatRotation(seat);

    // 起点：当前浮动大牌的视觉矩形中心（旋转不改变中心）与布局尺寸
    var first = el.getBoundingClientRect();
    var fcx = first.left + first.width / 2;
    var fcy = first.top + first.height / 2;
    var fw = el.offsetWidth;
    var fh = el.offsetHeight;

    // 在弃牌堆末尾临时占位，测得终态位置后移除
    var slot = document.createElement('div');
    slot.className = 'tile tile-sm tile-placeholder';
    slot.style.visibility = 'hidden';
    discEl.appendChild(slot);
    var last = slot.getBoundingClientRect();
    var lcx = last.left + last.width / 2;
    var lcy = last.top + last.height / 2;
    var lw = slot.offsetWidth;
    var lh = slot.offsetHeight;
    discEl.removeChild(slot);

    // 从手牌中心平移到弃牌堆中心，并按小牌布局尺寸等比缩小；保持牌头朝向中心的旋转
    var dx = lcx - fcx;
    var dy = lcy - fcy;
    var sx = lw / fw;
    var sy = lh / fh;

    el.classList.remove('flying');
    el.style.transition = '';
    // 起点变换：仅旋转（无位移、无缩放）
    el.style.transform = 'translate(0px,0px) scale(1,1) rotate(' + rot + 'deg)';

    var finished = false;
    function finish() {
      if (finished) return;
      finished = true;
      el.removeEventListener('transitionend', finish);
      el.classList.remove('flying');
      el.style.transition = '';
      el.style.transform = '';
      el.classList.add('hidden');
      done && done();
    }
    el.addEventListener('transitionend', finish);
    setTimeout(finish, 520);   // 兜底

    // 双 rAF 后播放：平移到弃牌堆 + 缩小到小牌尺寸
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        el.classList.add('flying');
        el.style.transform = 'translate(' + dx + 'px,' + dy + 'px) scale(' + sx + ',' + sy + ') rotate(' + rot + 'deg)';
      });
    });
  }

  // 渲染某座位公开区的碰/杠组合
  function renderSets(seat) {
    var box = $('sets-seat-' + seat);
    if (!box) return;
    box.innerHTML = '';
    var p = game.players[seat];

    var prevSets = game._uiSets ? game._uiSets[seat] : 0;
    var groupIdx = 0;
    function addGroup(group) {
      var g = document.createElement('div');
      g.className = 'set-group set-' + group.type + (group.cai ? ' set-cai' : '');
      if (groupIdx >= prevSets) g.classList.add('set-pop');
      groupIdx++;
      if (group.type === 'peng' || group.type === 'chi') {
        // 碰/吃：3 张明牌（财碰/财吃中财神位显示财神牌面）
        group.tiles.forEach(function (t) { g.appendChild(makeTile(t.code, { small: true })); });
      } else if (group.type === 'mingang') {
        // 明杠：4 张明牌
        group.tiles.forEach(function (t) { g.appendChild(makeTile(t.code, { small: true })); });
      } else {
        // 暗杠：明 - 背 - 背 - 明
        g.appendChild(makeTile(group.tiles[0].code, { small: true }));
        g.appendChild(makeTile(null, { faceDown: true, small: true }));
        g.appendChild(makeTile(null, { faceDown: true, small: true }));
        g.appendChild(makeTile(group.tiles[3].code, { small: true }));
      }
      box.appendChild(g);
    }

    p.peng.forEach(addGroup);
    p.gang.forEach(addGroup);
    game._uiSets = game._uiSets || [0, 0, 0, 0];
    game._uiSets[seat] = p.peng.length + p.gang.length;
  }

  function setStatus(text) {
    var el = $('status-log');
    if (el) el.textContent = text;
  }

  // ---------------- 回合倒计时（10 秒，圆心仅显示数字） ----------------

  function stopTurnTimer() {
    if (turnTimer) { clearTimeout(turnTimer); turnTimer = null; }
    if (turnTick) { clearInterval(turnTick); turnTick = null; }
    turnCtx = null;
    var box = $('center-timer');
    if (box) {
      box.classList.remove('warn');
      // 圆圈始终显示；仅对局结束时隐藏；无倒计时时数字显示「00」
      if (game && game.turn && game.turn.phase === 'over') {
        box.classList.add('hidden');
      } else {
        box.textContent = '00';
        box.classList.remove('hidden');
      }
    }
  }

  // seat：行动座位；mode：'discard' 玩家出牌 / 'claim' 玩家鸣牌选择 /
  //       'ai' 电脑出牌中（仅显示）/ 'aiwait' 电脑鸣牌判定中（仅显示）
  function startTurnTimer(seat, mode) {
    stopTurnTimer();
    // 测试加速模式（aiDelay=0）下不挂倒计时，避免干扰自动化测试
    if (aiDelay === 0) return;
    if (prePhase !== 'play' || !game || game.turn.phase === 'over') return;
    var box = $('center-timer');
    if (!box) return;
    turnCtx = { seat: seat, mode: mode };
    turnDeadline = Date.now() + TURN_LIMIT;
    box.classList.remove('hidden', 'warn');
    updateTurnTimer();
    turnTick = setInterval(updateTurnTimer, 120);
    turnTimer = setTimeout(onTurnTimeout, TURN_LIMIT);
  }

  function updateTurnTimer() {
    if (!turnCtx) return;
    var remain = Math.max(0, turnDeadline - Date.now());
    var sec = Math.ceil(remain / 1000);
    var box = $('center-timer');
    if (box) {
      box.textContent = (sec < 10 ? '0' : '') + sec;
      box.classList.toggle('warn', sec <= 3);
    }
  }

  // 超时兜底：仅对玩家待操作状态生效（玩家出牌超时 -> 自动打；鸣牌窗口超时 -> 自动过）
  function onTurnTimeout() {
    if (turnTick) { clearInterval(turnTick); turnTick = null; }
    turnTimer = null;
    if (!turnCtx || !game || game.turn.phase === 'over' || prePhase !== 'play') {
      stopTurnTimer();
      return;
    }
    var ctx = turnCtx;
    turnCtx = null;
    var box = $('center-timer');
    if (box) { box.textContent = '00'; box.classList.remove('hidden'); }
    var turn = game.turn;

    if (ctx.mode === 'discard' && turn.phase === 'discard' &&
        turn.currentSeat === HUMAN_SEAT) {
      // 自动打出：优先刚摸到的牌；庄家首张（无摸牌）则智能选张
      var pick = null;
      if (turn.drawnTileId != null) {
        pick = game.players[HUMAN_SEAT].hand.filter(function (t) {
          return t.id === turn.drawnTileId;
        })[0];
      }
      if (!pick) pick = C.pickSmartDiscard(game, HUMAN_SEAT) ||
                     C.pickRandomDiscard(game, HUMAN_SEAT);
      if (pick) {
        var out = C.discardTile(game, HUMAN_SEAT, pick.id);
        if (out) {
          humanPassed = false;
          setStatus('超时自动打出 ' + C.tileName(out.code) + '。');
          render();
          advance();
        }
      }
    } else if (ctx.mode === 'claim' && turn.phase === 'claim') {
      // 鸣牌窗口超时：自动【过】
      onPass();
    }
  }

  // ---------------- 鸣牌动作栏 ----------------

  // 按可见性刷新动作栏按钮
  //   opts: { hu, gang, peng, chi, bugang, angang, pass } -> true 显示 / false 隐藏
  //   opts.caiPeng / opts.caiChi -> 按钮文案改为"财碰"/"财吃"
  function refreshActions(opts) {
    opts = opts || {};
    var map = {
      'btn-hu': !!opts.hu,
      'btn-gang': !!opts.gang,
      'btn-peng': !!opts.peng,
      'btn-chi': !!opts.chi,
      'btn-bugang': !!opts.bugang,
      'btn-angang': !!opts.angang,
      'btn-pass': !!opts.pass
    };
    var anyVisible = false;
    Object.keys(map).forEach(function (id) {
      var el = $(id);
      if (!el) return;
      el.classList.toggle('hidden', !map[id]);
      if (map[id]) anyVisible = true;
    });
    // 碰/吃按钮统一只显示动作名称（财神参与情况通过组合画面中财神高亮体现，不再用文字"财碰/财吃"）
    var bp = $('btn-peng'); if (bp) bp.textContent = '碰';
    var bc = $('btn-chi');  if (bc) bc.textContent = '吃';
    if (!opts.chi) hideChiPicker();
    var bar = $('action-bar');
    if (bar) {
      bar.classList.toggle('hidden', !anyVisible);
      if (anyVisible) { lastActionOpts = opts; positionActionBar(); }
    }
  }

  function hideActions() { refreshActions(); }

  // 多种吃法的选择：每个组合直接用三张麻将牌画面展示；
  //   op.take[i] === null          → 鸣来的牌位，显示 op.codes[i]
  //   op.take[i].wild === true     → 财神补位，显示财神牌（自动带金色高亮）
  //   op.take[i].wild === false    → 手牌真牌，显示 take[i].code
  var pendingChiOptions = null;
  function hideChiPicker() {
    var p = $('chi-picker');
    if (p) { p.classList.add('hidden'); p.innerHTML = ''; }
    var bar = $('action-bar');
    if (bar) bar.classList.remove('chi-picking');
  }
  // 进入吃牌形式选择：隐藏其余动作按钮，只展示各吃法组合 + 返回按钮
  function showChiPicker(options) {
    var p = $('chi-picker');
    if (!p) return;
    p.innerHTML = '';
    var wildCode = (game && game.wilds && game.wilds[0]) ? game.wilds[0] : null;
    options.forEach(function (op) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'action-btn btn-chi-opt';
      for (var i = 0; i < 3; i++) {
        var tk = op.take[i];
        var code;
        if (tk === null) code = op.codes[i];
        else if (tk.wild) code = wildCode;
        else code = tk.code;
        var t = makeTile(code, { small: true });
        b.appendChild(t);
      }
      b.addEventListener('click', function () { onChi(op); });
      p.appendChild(b);
    });
    // 返回按钮：放弃本次吃牌形式选择，回到主动作栏（可改选碰/过等）
    var back = document.createElement('button');
    back.type = 'button';
    back.className = 'action-btn btn-pass btn-chi-back';
    back.textContent = '返回';
    back.addEventListener('click', function () {
      hideChiPicker();
      refreshActions(lastActionOpts || {});
    });
    p.appendChild(back);
    p.classList.remove('hidden');
    var bar = $('action-bar');
    if (bar) bar.classList.add('chi-picking');
    positionActionBar();
  }
  // 缓存最近一次动作栏参数，供"返回"时恢复主按钮显隐
  var lastActionOpts = {};

  // ---------------- 回合流转 ----------------

  // 推进回合：
  //   phase='draw'    -> 自动摸牌（玩家/电脑都自动摸）；牌墙摸完则荒庄结束
  //   phase='claim'   -> 鸣牌窗口：胡 > 杠 > 碰，玩家可鸣则弹按钮等待，否则电脑自动结算
  //   phase='discard' -> 自摸判定；玩家等待点击（含暗杠/补杠/胡按钮）；电脑延时后自动行动
  function advance() {
    if (!game) return;
    var turn = game.turn;
    if (turn.phase === 'over') { render(); hideActions(); return; }

    if (turn.phase === 'draw') {
      var seat = turn.currentSeat;
      var drawn = C.drawTile(game);
      if (!drawn) {
        // drawTile 返回 null：牌墙已空 -> 荒庄
        render();
        hideActions();
        showOver();
        return;
      }
      if (seat === HUMAN_SEAT) {
        setStatus('你摸起 ' + C.tileName(drawn.code) + '，点击手牌打出。');
      }
      render();
    }

    if (turn.phase === 'claim') {
      handleClaim();
      return;
    }

    if (turn.phase !== 'discard') { render(); return; }

    var actingSeat = turn.currentSeat;

    // 自摸判定（玩家与 AI 共用规则引擎；含天胡/杠开；banned 禁胡不触发）
    var selfEv = C.evaluateHu(game, actingSeat, null);
    var selfWin = !!(selfEv.win && !selfEv.banned);

    if (actingSeat === HUMAN_SEAT) {
      // 玩家出牌阶段：可暗杠 / 补杠；自摸时额外弹【胡】（也可放弃胡继续打）
      var anCodes = C.findAnGangCodes(game, HUMAN_SEAT);
      var buCodes = C.findBuGangCodes(game, HUMAN_SEAT);
      refreshActions({ hu: selfWin, angang: anCodes.length > 0, bugang: buCodes.length > 0 });
      if (selfWin) {
        var wayName = selfEv.tianhu ? '天胡' : (selfEv.gangkai ? '杠开' : '自摸');
        setStatus('你【' + wayName + '】啦！点【胡】胡牌，或继续打出一张牌。');
      }
      startTurnTimer(HUMAN_SEAT, 'discard');   // 玩家出牌 10 秒倒计时
    } else {
      // 电脑自摸直接胡牌
      if (selfWin) { doWin(selfEv); return; }
      hideActions();
      scheduleAi(actingSeat);
    }
  }

  // 计算鸣牌窗口中可胡牌的座位列表（按截胡顺序：打出者下家起轮转）。
  // 抢杠窗口（pd.gang）引擎自动判为抢杠胡；禁胡（banned）不计入。
  // 返回 [{ seat, ev }]
  function getWinSeats() {
    var turn = game.turn;
    var pd = turn.pendingDiscard;
    var wins = [];
    if (!pd) return wins;
    for (var i = 1; i <= 3; i++) {
      var s = (pd.seat + i) % 4;
      var ev = C.evaluateHu(game, s, pd.tile.code);
      if (ev.win && !ev.banned) wins.push({ seat: s, ev: ev });
    }
    return wins;
  }

  // 鸣牌窗口处理（优先级：胡 > 杠 > 碰）：
  //   玩家可胡 -> 弹【胡】（可胡时仍允许选择碰/杠/过）；
  //   玩家可碰/杠 -> 弹【杠】【碰】【过】；
  //   否则 -> 电脑自动结算（AI 胡优先，截胡取轮转最前者）。
  function handleClaim() {
    var turn = game.turn;
    var pd = turn.pendingDiscard;
    var fromName = SEAT_LABELS[pd.seat];
    var tileName = C.tileName(pd.tile.code);

    // ① 胡牌判定
    var winSeats = getWinSeats();
    var humanWin = null;
    for (var i = 0; i < winSeats.length; i++) {
      if (winSeats[i].seat === HUMAN_SEAT) { humanWin = winSeats[i]; break; }
    }

    // ② 碰/杠/吃选项（抢杠窗口引擎返回空，仅可胡）
    var opts = C.getClaimOptions(game);
    var humanCanGang = opts.gang.indexOf(HUMAN_SEAT) !== -1;
    var humanCanPeng = opts.peng.indexOf(HUMAN_SEAT) !== -1;
    var humanCaiPengOnly = !humanCanPeng && opts.caipeng.indexOf(HUMAN_SEAT) !== -1;
    var humanShuangCaiPengOnly = !humanCanPeng && !humanCaiPengOnly &&
                                 opts.shuangcaipeng.indexOf(HUMAN_SEAT) !== -1;
    // 碰类动作：正碰 / 财碰 / 双财碰 共用【碰】按钮
    var humanCanPengOrCai = humanCanPeng || humanCaiPengOnly || humanShuangCaiPengOnly;
    // 吃：仅下家；提取玩家的吃法组合
    pendingChiOptions = null;
    (opts.chi || []).forEach(function (c) {
      if (c.seat === HUMAN_SEAT) pendingChiOptions = c.options;
    });
    var humanCanChi = !!pendingChiOptions && pendingChiOptions.length > 0;
    var humanZhengChi = humanCanChi &&
                        pendingChiOptions.some(function (o) { return o.wildUsed === 0; });
    var humanCaiChiOnly = humanCanChi && !humanZhengChi;   // 所有吃法均需财神补位

    // ③ 优先级裁决（胡 > 杠 > 正碰 > 正吃 > 财碰 > 财吃 > 双财碰）：
    //    电脑有更高优先级鸣牌时，玩家不再弹按钮，直接按优先级结算；
    //    玩家优先级不低于电脑（同优先级玩家优先）时，弹按钮等待玩家选择。
    function claimTierOf(seat) {   // 某座位除胡外的最高优先级（Infinity = 无可鸣）
      var t = Infinity;
      if (opts.gang.indexOf(seat) !== -1) t = Math.min(t, 2);
      if (opts.peng.indexOf(seat) !== -1) t = Math.min(t, 3);
      (opts.chi || []).forEach(function (c) {
        if (c.seat !== seat) return;
        var zheng = c.options.some(function (o) { return o.wildUsed === 0; });
        if (zheng) t = Math.min(t, 4);
        else if (c.options.length) t = Math.min(t, 6);
      });
      if (opts.caipeng.indexOf(seat) !== -1) t = Math.min(t, 5);
      if (opts.shuangcaipeng.indexOf(seat) !== -1) t = Math.min(t, 7);
      return t;
    }
    var humanTier = Infinity;
    if (!humanPassed) {
      if (humanWin) humanTier = 1;
      humanTier = Math.min(humanTier, claimTierOf(HUMAN_SEAT));
    }
    var aiBestTier = Infinity;
    if (winSeats.some(function (w) { return w.seat !== HUMAN_SEAT; })) aiBestTier = 1;
    for (var s = 0; s < 4; s++) {
      if (s === HUMAN_SEAT) continue;
      aiBestTier = Math.min(aiBestTier, claimTierOf(s));
    }

    if (humanTier < Infinity && humanTier <= aiBestTier) {
      // 玩家优先级不低于电脑：弹按钮，等待操作
      var tips = [];
      if (humanWin) tips.push('胡');
      if (humanCanGang) tips.push('杠');
      if (humanCanPeng) tips.push('碰');
      if (humanCaiPengOnly) tips.push('财碰');
      if (humanShuangCaiPengOnly) tips.push('双财碰');
      if (humanCanChi) tips.push(humanCaiChiOnly ? '财吃' : '吃');
      var act = pd.gang ? ' 补杠 ' : ' 打出 ';
      setStatus(fromName + act + tileName + '：你可以【' + tips.join('】【') + '】！');
      refreshActions({ hu: humanWin, gang: humanCanGang,
                       peng: humanCanPengOrCai, caiPeng: humanCaiPengOnly || humanShuangCaiPengOnly,
                       chi: humanCanChi, caiChi: humanCaiChiOnly, pass: true });
      startTurnTimer(HUMAN_SEAT, 'claim');   // 玩家鸣牌选择 10 秒倒计时
      return;
    }

    // 电脑优先级更高（或玩家无选项/已点过）：直接按优先级结算
    pendingChiOptions = null;
    hideActions();
    scheduleClaimAi(opts, winSeats);
  }

  // 电脑鸣牌结算（优先级：胡 > 杠 > 正碰 > 正吃 > 财碰 > 财吃 > 双财碰；玩家走按钮流程）
  //   AI 门禁：财吃需「吃了可听牌/做清一色」；双财碰需「财神>4 张且碰东风」
  function scheduleClaimAi(opts, winSeats) {
    clearTimeout(aiTimer);
    aiTimer = setTimeout(function () {
      if (!game || game.turn.phase !== 'claim') return;

      // 胡牌最优先（仅电脑；玩家胡走按钮流程，点【过】后自然排除）
      var wins = winSeats || getWinSeats();
      var aiWins = wins.filter(function (w) { return w.seat !== HUMAN_SEAT; });
      if (aiWins.length) {
        doWin(aiWins[0].ev);
        return;
      }

      var o = opts || C.getClaimOptions(game);
      var pd = game.turn.pendingDiscard;
      var pdCode = pd ? pd.tile.code : null;

      // 吃选项（仅下家；排除玩家，玩家吃走按钮流程）
      var chiEntry = null;
      (o.chi || []).forEach(function (c) { if (c.seat !== HUMAN_SEAT) chiEntry = c; });
      var zhengChiOpt = null, caiChiOpt = null;
      if (chiEntry) {
        chiEntry.options.forEach(function (op) {
          if ((op.wildUsed || 0) === 0 && !zhengChiOpt) zhengChiOpt = op;
          else if ((op.wildUsed || 0) > 0 && !caiChiOpt) caiChiOpt = op;
        });
      }
      // 非玩家座位取最前者（同优先级按座位顺序）
      function pick(arr) {
        for (var i = 0; i < arr.length; i++) if (arr[i] !== HUMAN_SEAT) return arr[i];
        return -1;
      }
      var gangSeat = pick(o.gang), pengSeat = pick(o.peng),
          caiPengSeat = pick(o.caipeng), shuangSeat = pick(o.shuangcaipeng);

      var seat, group = null;
      if (gangSeat >= 0) {
        // 杠优先（多家可杠时按座位顺序取最靠前）
        seat = gangSeat;
        group = C.doMingGang(game, seat);
        if (group) setStatus(SEAT_LABELS[seat] + ' 明杠 ' + C.tileName(group.tiles[0].code) + '，补摸一张。');
      } else if (pengSeat >= 0) {
        seat = pengSeat;
        group = C.doPeng(game, seat);
        if (group) setStatus(SEAT_LABELS[seat] + ' 碰 ' + C.tileName(group.code) + '。');
      } else if (chiEntry && zhengChiOpt) {
        seat = chiEntry.seat;
        group = C.doChi(game, seat, zhengChiOpt);
        if (group) setStatus(SEAT_LABELS[seat] + ' 吃 ' + C.tileName(pdCode) + ' 组成顺子。');
      } else if (caiPengSeat >= 0) {
        seat = caiPengSeat;
        group = C.doPeng(game, seat);
        if (group) setStatus(SEAT_LABELS[seat] + ' 财碰 ' + C.tileName(group.code) + '。');
      } else if (chiEntry && caiChiOpt && C.caiChiWorth(game, chiEntry.seat, caiChiOpt)) {
        // 财吃门禁：财神尽量不吃 —— 仅「吃了可听牌」或「做清一色」才吃
        seat = chiEntry.seat;
        group = C.doChi(game, seat, caiChiOpt);
        if (group) setStatus(SEAT_LABELS[seat] + ' 财吃 ' + C.tileName(pdCode) + ' 组成顺子。');
      } else if (shuangSeat >= 0 && C.shuangCaiPengWorth(game, shuangSeat, pdCode)) {
        // 双财碰门禁：财神 > 4 张才碰，且尽量选东风（其余大张放过）
        seat = shuangSeat;
        group = C.doPeng(game, seat);
        if (group) setStatus(SEAT_LABELS[seat] + ' 双财碰 ' + C.tileName(group.code) + '。');
      } else {
        // 无人鸣牌：过牌（普通窗口牌入弃牌区轮转；抢杠窗口杠者补摸）
        C.passClaim(game);
      }
      humanPassed = false;

      // 无人鸣牌时：浮动大牌停留 0.5 秒后缩小飞入弃牌堆，再继续；
      // 有人鸣牌时：牌已转入副露，直接隐藏浮动牌并重渲染。
      var claimed = !!group;
      if (!claimed && pd && !pd.gang && aiDelay > 0) {
        setTimeout(function () {
          flyFloatingToDiscard(pd.seat, function () {
            render();
            advance();
          });
        }, 500);
      } else {
        hideFloatingDiscard();
        render();
        advance();
      }
    }, aiDelay);
    startTurnTimer(-1, 'aiwait');   // 电脑鸣牌判定中（仅显示倒计时）
  }

  // 电脑座位行动（出牌阶段）：
  //   有 4 张同码真牌 -> 暗杠补摸；否则随机选 1 张打出，随后进入鸣牌窗口
  function scheduleAi(seat) {
    clearTimeout(aiTimer);
    aiTimer = setTimeout(function () {
      if (!game || game.turn.phase === 'over') return;
      if (game.turn.currentSeat !== seat || game.turn.phase !== 'discard') return;

      // 电脑暗杠（手牌 4 张同码真牌）
      var anCodes = C.findAnGangCodes(game, seat);
      if (anCodes.length) {
        var g = C.doAnGang(game, seat, anCodes[0]);
        if (g) {
          setStatus(SEAT_LABELS[seat] + ' 暗杠，补摸一张。');
          render();
          advance();   // 进入补摸（draw）
          return;
        }
      }

      // 电脑补杠（碰过的牌又摸到第 4 张）-> 进入抢杠胡窗口（别家可胡）
      var buCodes = C.findBuGangCodes(game, seat);
      if (buCodes.length) {
        var bg = C.doBuGang(game, seat, buCodes[0]);
        if (bg) {
          setStatus(SEAT_LABELS[seat] + ' 补杠 ' + C.tileName(buCodes[0]) + '。');
          render();
          advance();   // 抢杠胡窗口
          return;
        }
      }

      // 智能出牌：孤张先打、保留搭子/对子/刻子、不打财神（随机为兜底）
      var pick = C.pickSmartDiscard(game, seat) || C.pickRandomDiscard(game, seat);
      // 最终守卫：财神是百搭，AI 永不主动打出。若误选到财神，
      // 强制改选手牌中第一张非财神真牌（全财神极端无解时才允许打出）。
      if (pick && game.wilds.indexOf(pick.code) !== -1) {
        var safe = game.players[seat].hand.filter(function (t) {
          return game.wilds.indexOf(t.code) === -1;
        })[0];
        if (safe) pick = safe;
      }
      if (!pick) return;
      var out = C.discardTile(game, seat, pick.id);
      if (out) {
        setStatus(SEAT_LABELS[seat] + ' 打出 ' + C.tileName(out.code) + '。');
      }
      render();
      advance();
    }, aiDelay);
    startTurnTimer(seat, 'ai');   // 电脑出牌中（仅显示倒计时）
  }

  // ---------------- 玩家操作 ----------------

  // 两次点击出牌：第一次点击选中的牌 id（该牌向牌桌中心突出半张牌）
  var selectedDiscardId = null;

  // 清除手牌中的突出选中状态（DOM 重建 / 换选 / 出牌后调用）
  function clearLiftSelection() {
    selectedDiscardId = null;
    var hand = $('hand-seat-' + HUMAN_SEAT);
    if (!hand) return;
    var lifted = hand.querySelectorAll('.tile-lift');
    for (var i = 0; i < lifted.length; i++) lifted[i].classList.remove('tile-lift');
  }

  // 玩家点击手牌：两次点击出牌（第一下选中突出，第二下打出；点其他牌换选）
  function onHandClick(e) {
    var el = (e.target && e.target.closest) ? e.target.closest('.tile') : null;
    if (!el) return;
    if (!game || game.turn.phase === 'over') return;
    if (prePhase !== 'play') return;   // 掷骰/发牌动画期间锁定操作
    if (game.turn.currentSeat !== HUMAN_SEAT || game.turn.phase !== 'discard') return;

    var tileId = parseInt(el.dataset.tileId, 10);
    if (isNaN(tileId)) return;

    // 第一次点击（或换选另一张）：突出显示，不出牌
    if (selectedDiscardId !== tileId) {
      clearLiftSelection();
      selectedDiscardId = tileId;
      el.classList.add('tile-lift');
      return;
    }

    // 第二次点击同一张：打出
    var out = C.discardTile(game, HUMAN_SEAT, tileId);
    if (!out) { clearLiftSelection(); return; }   // 非法点击，清除选中忽略

    selectedDiscardId = null;
    humanPassed = false;
    setStatus('你打出 ' + C.tileName(out.code) + '。');
    render();
    advance();
  }

  // 碰（含财碰：1 真牌+1 财神；双财碰：2 财神+鸣来的大张）
  function onPeng() {
    if (!game || game.turn.phase !== 'claim') return;
    var group = C.doPeng(game, HUMAN_SEAT);
    if (!group) return;
    clearTimeout(aiTimer);
    pendingChiOptions = null;
    var act = group.shuang ? '双财碰' : (group.cai ? '财碰' : '碰');
    setStatus('你' + act + '了 ' + C.tileName(group.code) + '，请出牌。');
    hideChiPicker();
    render();
    advance();
  }

  // 吃按钮：单组合直接执行；多组合展开选择条
  function onChiClick() {
    if (!game || game.turn.phase !== 'claim') return;
    if (!pendingChiOptions || !pendingChiOptions.length) return;
    if (pendingChiOptions.length === 1) {
      onChi(pendingChiOptions[0]);
    } else {
      showChiPicker(pendingChiOptions);
    }
  }

  // 吃（含财吃：财神补缺张）
  function onChi(opt) {
    if (!game || game.turn.phase !== 'claim') return;
    var group = C.doChi(game, HUMAN_SEAT, opt);
    if (!group) return;
    clearTimeout(aiTimer);
    pendingChiOptions = null;
    var seq = opt.codes.map(function (c) { return C.tileName(c); }).join('');
    setStatus('你' + (group.cai ? '财吃' : '吃') + '了 ' + seq + '，请出牌。');
    hideChiPicker();
    render();
    advance();
  }

  // 明杠（杠别家打出的牌），杠后自动补摸
  function onMingGang() {
    if (!game || game.turn.phase !== 'claim') return;
    var code = game.turn.pendingDiscard ? game.turn.pendingDiscard.tile.code : null;
    var group = C.doMingGang(game, HUMAN_SEAT);
    if (!group) return;
    clearTimeout(aiTimer);
    render();
    advance();   // 自动补摸（draw）
    // 补摸后状态提示（advance 中摸牌提示会被此覆盖）
    var drawn = findDrawnTile();
    setStatus('你明杠 ' + (code ? C.tileName(code) : '') + '，补摸 ' +
              (drawn ? C.tileName(drawn.code) : '一张') + '，请出牌。');
    render();
  }

  // 暗杠（自家出牌阶段），杠后自动补摸
  function onAnGang() {
    if (!game || game.turn.phase !== 'discard' || game.turn.currentSeat !== HUMAN_SEAT) return;
    var codes = C.findAnGangCodes(game, HUMAN_SEAT);
    if (!codes.length) return;
    var group = C.doAnGang(game, HUMAN_SEAT, codes[0]);
    if (!group) return;
    clearTimeout(aiTimer);
    render();
    advance();   // 自动补摸（draw）
    var drawn = findDrawnTile();
    setStatus('你暗杠 ' + C.tileName(group.tiles[0].code) + '，补摸 ' +
              (drawn ? C.tileName(drawn.code) : '一张') + '，请出牌。');
    render();
  }

  // 胡（玩家点击【胡】）：
  //   出牌阶段 -> 自摸（含天胡/杠开）；鸣牌窗口 -> 点炮/抢杠胡。
  //   禁胡（banned）引擎不会弹出【胡】，此处再兜底校验一次。
  function onHu() {
    if (!game || game.turn.phase === 'over') return;
    var turn = game.turn;
    var ev = null;
    if (turn.phase === 'discard' && turn.currentSeat === HUMAN_SEAT) {
      ev = C.evaluateHu(game, HUMAN_SEAT, null);          // 自摸
    } else if (turn.phase === 'claim' && turn.pendingDiscard) {
      ev = C.evaluateHu(game, HUMAN_SEAT, turn.pendingDiscard.tile.code);  // 点炮/抢杠
    }
    if (ev && ev.win && !ev.banned) {
      humanPassed = false;
      doWin(ev);
    }
  }

  // 补杠（玩家出牌阶段点击【补杠】）：碰组补第 4 张，随后进入抢杠胡窗口
  function onBuGang() {
    if (!game || game.turn.phase !== 'discard' || game.turn.currentSeat !== HUMAN_SEAT) return;
    var codes = C.findBuGangCodes(game, HUMAN_SEAT);
    if (!codes.length) return;
    var group = C.doBuGang(game, HUMAN_SEAT, codes[0]);
    if (!group) return;
    clearTimeout(aiTimer);
    humanPassed = false;
    setStatus('你补杠 ' + C.tileName(codes[0]) + '，等待别家响应（可被抢杠胡）。');
    render();
    advance();   // 进入抢杠胡窗口
  }

  // 过（放弃鸣牌）：本张牌交由电脑结算/落定轮转
  function onPass() {
    if (!game || game.turn.phase !== 'claim') return;
    humanPassed = true;
    pendingChiOptions = null;
    setStatus('你选择过牌。');
    hideActions();
    handleClaimAfterPass();
  }

  // 玩家过牌后：用排除玩家的选项让电脑结算
  function handleClaimAfterPass() {
    if (!game || game.turn.phase !== 'claim') return;
    var opts = C.getClaimOptions(game);
    scheduleClaimAi(opts);
  }

  // 查找玩家刚摸到的牌实例
  function findDrawnTile() {
    if (!game || !game.turn || game.turn.drawnTileId == null) return null;
    var hand = game.players[HUMAN_SEAT].hand;
    for (var i = 0; i < hand.length; i++) {
      if (hand[i].id === game.turn.drawnTileId) return hand[i];
    }
    return null;
  }

  function showOver() {
    if (game.turn.endReason === 'wallEmpty') {
      clearTimeout(aiTimer);
      hideActions();
      setStatus('牌墙已摸完，本局荒庄（流局），庄家连坐。点击「重新开局」再来一局。');
      render();
      showDrawModal();
    } else {
      setStatus('对局结束。');
    }
  }

  // ---------------- 胡牌结算 / 弹窗 ----------------

  // 胡牌生效（玩家与 AI 共用）：整理牌张归属 -> 结束对局 -> 积分结算 -> 弹窗。
  function doWin(ev) {
    if (!game || game.turn.phase === 'over') return;
    var turn = game.turn;
    var winner = ev.winnerSeat;
    A(winner === HUMAN_SEAT ? 'win' : 'hu');
    var pd = turn.pendingDiscard;
    var winTileCode = null;
    var fromName = null;

    if (pd && (ev.winType === 'dianpao' || ev.winType === 'qianggang')) {
      // 鸣牌窗口中的牌归胡家所有
      winTileCode = pd.tile.code;
      fromName = SEAT_LABELS[pd.seat];

      if (ev.winType === 'qianggang') {
        // 抢杠胡：补杠者的杠组退化为碰组（第 4 张被胡家拿走）
        var bp = game.players[pd.seat];
        for (var i = bp.gang.length - 1; i >= 0; i--) {
          var g = bp.gang[i];
          if (g.type === 'bugang' && g.tiles.length === 4 &&
              g.tiles.some(function (t) { return t === pd.tile; })) {
            bp.gang.splice(i, 1);
            bp.peng.push({ type: 'peng', tiles: g.tiles.slice(0, 3), fromSeat: g.fromSeat });
            break;
          }
        }
      } else {
        // 点炮：被胡的牌在 discardTile 时已落入放冲者弃牌区，取回交给胡家
        C.takeFromDiscards(game, pd.seat, pd.tile);
      }
      game.players[winner].hand.push(pd.tile);
      game.players[winner].hand = C.sortHand(game.players[winner].hand);
      turn.pendingDiscard = null;
    }

    // ---- 连庄 / 断庄判定（结算前确定全局翻倍）----
    // 进入本局时的连庄状态决定本局是否翻倍：连胡 2 把起，本局任何玩家胡牌都 ×2；
    // 闲家胡牌在本局双倍结算之后再断庄（下局起取消翻倍）。
    var winnerIsBanker = !!game.players[winner].isBanker;
    var streakActive = bankerStreak >= 2;    // 本局是否处于连庄翻倍状态
    var mult = 1;
    var streakNote = '';
    if (winnerIsBanker) {
      bankerStreak++;                       // 庄胡连庄
      nextBankerSeat = winner;              // 庄家继续坐庄
      if (bankerStreak >= 2) {
        if (ev.top) {
          mult = 1;                         // 通杀牌型固定金额，不参与连庄翻倍
          streakNote = '庄家连胡 ' + bankerStreak + ' 把（通杀牌型不参与翻倍）';
        } else {
          mult = 2;                         // 连胡 2 把起全局积分翻倍
          streakNote = '庄家连胡 ' + bankerStreak + ' 把，本局积分 ×2';
        }
      } else {
        streakNote = '庄家连庄 ' + bankerStreak + ' 把（再胡 1 把翻倍）';
      }
    } else {
      // 闲家胡：本局仍按进入时的连庄状态结算（翻倍中则本局 ×2），随后断庄清零
      if (streakActive) {
        if (ev.top) {
          mult = 1;                         // 通杀牌型固定金额，不参与翻倍
          streakNote = '闲家胡牌，断庄（本局通杀牌型不参与翻倍，下局起取消连庄）';
        } else {
          mult = 2;                         // 本局连庄翻倍照常生效
          streakNote = '闲家胡牌，断庄：本局连庄 ×2 结算，下局起取消翻倍';
        }
      } else {
        streakNote = '闲家胡牌，断庄（连庄计数清零）';
      }
      bankerStreak = 0;                     // 断庄：连庄计数清零
      nextBankerSeat = winner;              // 谁胡牌谁做庄（胡牌者接庄）
    }

    turn.phase = 'over';
    turn.endReason = 'hu';
    turn.drawnTileId = null;
    clearTimeout(aiTimer);
    hideActions();

    var score = C.calcScore(ev, game, { mult: mult });

    // ---- 累计积分：胡家收入，付家支出（带分模式按余额封顶，只输到清零）----
    var actualPay = score.pay, actualIncome = score.income, bustNote = '';
    if (playMode === 'bankroll' && modeChosen) {
      var balances = [0, 1, 2, 3].map(function (b) { return Math.max(0, initialScore + scores[b]); });
      var capped = C.capPayByBalance(score, balances, winner);
      actualPay = capped.pay;
      actualIncome = capped.income;
      var capNames = [];
      for (var ck = 0; ck < 4; ck++) if (capped.capped[ck]) capNames.push(SEAT_LABELS[ck]);
      if (capNames.length) {
        bustNote = capNames.join('、') + ' 积分不足，仅支付至清零';
      }
    }
    scores[winner] += actualIncome;
    for (var k = 0; k < 4; k++) scores[k] -= actualPay[k];

    // 带分模式：任意一家余额归零 → 本场结束（重开新场恢复初始积分）
    sessionBusted = false;
    if (playMode === 'bankroll' && modeChosen) {
      var bustNames = [];
      for (var bk = 0; bk < 4; bk++) {
        if (initialScore + scores[bk] <= 0) bustNames.push(SEAT_LABELS[bk]);
      }
      if (bustNames.length) {
        sessionBusted = true;
        bustNote += (bustNote ? '<br>' : '') + '<b>' + bustNames.join('、') +
                    ' 积分清零，本场结束！</b>重开新场后各家恢复初始积分 ' + initialScore + ' 分';
      }
    }

    render();

    // 胡牌方式文案
    var wayText;
    var topName = ev.top ? (ev.patterns.filter(function (p) { return p.top; })[0] || {}).name : null;
    if (ev.winType === 'zimo') {
      wayText = topName ? topName + '（自摸通杀）' : '自摸胡牌';
    } else if (ev.winType === 'qianggang') {
      wayText = '抢杠胡：抢 ' + fromName + ' 补杠的 ' + C.tileName(winTileCode);
    } else {
      wayText = topName
        ? topName + '（点炮通杀）：' + fromName + ' 打出 ' + C.tileName(winTileCode)
        : '点炮胡：' + fromName + ' 打出 ' + C.tileName(winTileCode);
    }

    var winnerName = SEAT_LABELS[winner];
    var tailText = ev.top ? '三枪毙通杀！' : (ev.tai + ' 台');
    setStatus(winnerName + (winner === HUMAN_SEAT ? ' 胡牌啦！' : ' 胡牌，本局结束。') +
              '（' + wayText + '，' + tailText + '）');
    // 展示口径：unit/mult 用理论值，pay/income 用封顶后的实际收支
    showWinModal(ev, { unit: score.unit, mult: score.mult, top: score.top,
                       pay: actualPay, income: actualIncome }, wayText, streakNote, bustNote);
  }

  // 弹窗内渲染本局财神（两张小牌）
  function renderModalWilds() {
    var el = $('win-wilds');
    if (!el || !game) return;
    el.innerHTML = '';
    var label = document.createElement('span');
    label.className = 'modal-label';
    label.textContent = '本局财神：';
    el.appendChild(label);
    game.wilds.forEach(function (code) {
      el.appendChild(makeTile(code, { small: true }));
    });
  }

  // 渲染四家分数行：本局变化 + 累计总分
  function renderScoreRows(winnerSeat, score) {
    var scEl = $('win-score');
    scEl.innerHTML = '';
    for (var s = 0; s < 4; s++) {
      var row = document.createElement('div');
      var isWinner = (s === winnerSeat);
      row.className = 'score-row' + (isWinner ? ' row-winner' : '');
      var label = SEAT_LABELS[s] + (isWinner ? '（胡）' : '');
      var delta, deltaCls = '';
      if (winnerSeat == null) {
        delta = '0';
      } else if (isWinner) {
        delta = '+' + score.income;
        deltaCls = ' txt-up';
      } else {
        delta = score.pay[s] ? ('-' + score.pay[s]) : '0';
        if (score.pay[s]) deltaCls = ' txt-down';
      }
      var total = scores[s];
      var totalText, totalCls;
      if (playMode === 'bankroll' && modeChosen) {
        // 带分模式：「累计」列显示当前余额（初始 + 输赢累计，不为负）
        var bal = Math.max(0, initialScore + total);
        totalText = String(bal);
        totalCls = bal > initialScore ? 'txt-up' : bal < initialScore ? 'txt-down' : '';
      } else {
        totalText = (total > 0 ? '+' : '') + total;
        totalCls = total > 0 ? 'txt-up' : total < 0 ? 'txt-down' : '';
      }
      row.innerHTML = '<span>' + label + '</span><span>本局 <b class="' + deltaCls + '">' + delta +
                      '</b>　' + (playMode === 'bankroll' && modeChosen ? '余额' : '累计') +
                      ' <b class="' + totalCls + '">' + totalText + '</b></span>';
      scEl.appendChild(row);
    }
  }

  // 渲染胡牌结算弹窗：财神 / 方式 / 连庄 / 牌型标签 / 台数 / unit / 四家收支与累计
  function showWinModal(ev, score, wayText, streakNote, bustNote) {
    $('win-title').textContent = SEAT_LABELS[ev.winnerSeat] + ' 胡牌';
    $('win-way').textContent = wayText;
    renderModalWilds();

    var stEl = $('win-streak');
    if (stEl) {
      stEl.textContent = streakNote || '';
      stEl.classList.toggle('hidden', !streakNote);
    }

    // 带分模式：截断 / 本场结束提示
    var bustEl = $('win-bust');
    if (bustEl) {
      bustEl.innerHTML = bustNote || '';
      bustEl.classList.toggle('hidden', !bustNote);
    }

    var patEl = $('win-patterns');
    patEl.innerHTML = '';
    ev.patterns.forEach(function (p) {
      var chip = document.createElement('span');
      var isTop = !!p.top || ev.top;
      chip.className = 'pattern-chip' + (isTop ? ' chip-top' : '');
      chip.textContent = isTop ? (p.name + '（通杀）') : (p.name + ' ' + p.tai + ' 台');
      patEl.appendChild(chip);
    });

    var multText = (score.mult && score.mult > 1) ? '　<font class="txt-up">连庄 ×' + score.mult + '</font>' : '';
    // 台数明细算式：普通胡「东风刻 2 + 全碰 1 + 无财 1 = 4 台」；
    //   顶级牌型（字一色/天胡/地胡）「三枪毙通杀：三家各付 128 分」
    var detail;
    if (ev.top) {
      var topPat = ev.patterns.filter(function (p) { return p.top; })[0] || ev.patterns[0];
      detail = (topPat ? topPat.name : '通杀') + ' · <b>三枪毙通杀</b>，三家各付 ' +
               score.unit + ' 分（不按台数、不翻倍）';
      $('win-tai').innerHTML = detail;
    } else if (ev.patterns.length) {
      detail = ev.patterns.map(function (p) { return p.name + ' ' + p.tai; }).join(' + ') +
               ' = <b>' + ev.tai + '</b> 台';
      $('win-tai').innerHTML = detail + '　·　unit = 2^' + ev.tai + ' = ' + score.unit + ' 分' + multText;
    } else {
      detail = '总台数 <b>' + ev.tai + '</b> 台';
      $('win-tai').innerHTML = detail + '　·　unit = 2^' + ev.tai + ' = ' + score.unit + ' 分' + multText;
    }

    renderScoreRows(ev.winnerSeat, score);
    $('win-modal').classList.remove('hidden');
    setupSettleButtons(ev.winnerSeat);
  }

  // 流局弹窗（牌墙摸完荒庄：庄家连坐、连庄计数保留、本局不计分）
  function showDrawModal() {
    if (!game) return;
    nextBankerSeat = game.bankerSeat;   // 荒庄连庄：庄家继续坐庄
    $('win-title').textContent = '流局（荒庄）';
    $('win-way').textContent = '牌墙已摸完，四家无人胡牌，本局平局';
    renderModalWilds();

    var stEl = $('win-streak');
    if (stEl) {
      stEl.textContent = bankerStreak >= 1
        ? '流局不清零：庄家继续坐庄，连庄计数保留（' + bankerStreak + ' 把）'
        : '流局不清零：庄家继续坐庄';
      stEl.classList.remove('hidden');
    }

    var patEl = $('win-patterns');
    patEl.innerHTML = '<span class="pattern-chip">无牌型（平局）</span>';
    $('win-tai').textContent = '本局不计台数、不计积分';
    var bustElD = $('win-bust');
    if (bustElD) bustElD.classList.add('hidden');
    renderScoreRows(null, { income: 0, pay: [0, 0, 0, 0] });
    $('win-modal').classList.remove('hidden');
    setupSettleButtons(game.bankerSeat);   // 流局：庄家继续坐庄，赢家=庄家
  }

  // ---------------- 结算后准备/开始流程 ----------------
  // winnerSeat：本局胡牌者（流局时为庄家），也是下局庄家
  function setupSettleButtons(winnerSeat) {
    settleWinner = winnerSeat;
    readySeats = {};

    var btnReady = $('btn-ready');
    var btnStart = $('btn-start-next');
    var btnAgain = $('btn-again');
    var btnChange = $('btn-change-mode');
    btnReady.classList.add('hidden');
    btnReady.disabled = false;
    btnReady.textContent = '准备';
    btnStart.classList.add('hidden');
    btnStart.disabled = true;
    if (btnAgain) btnAgain.classList.add('hidden');
    if (btnChange) btnChange.classList.add('hidden');

    // 带分模式整场结束（任意一家清零）：不走准备流程，玩家直接重开新场或更换玩法
    if (sessionBusted) {
      if (btnAgain) btnAgain.classList.remove('hidden');
      if (btnChange) btnChange.classList.remove('hidden');
      return;
    }

    readySeats[winnerSeat] = true;   // 赢家默认已"准备"（只需等其他三家）

    if (winnerSeat === HUMAN_SEAT) {
      // 玩家是赢家：显示「开始」按钮（置灰），等 AI 三家准备完毕后点亮
      btnStart.classList.remove('hidden');
      btnStart.disabled = true;
      aiAutoReady(winnerSeat);
    } else {
      // 玩家不是赢家：显示「准备」按钮
      btnReady.classList.remove('hidden');
      // AI 赢家与另外两家自动准备
      aiAutoReady(winnerSeat);
    }
  }

  // AI 玩家（除 human 外）自动点「准备」
  function aiAutoReady(winnerSeat) {
    for (var s = 0; s < 4; s++) {
      if (s === HUMAN_SEAT) continue;
      (function (seat) {
        var delay = aiDelay === 0 ? 0 : (400 + Math.random() * 600);
        preTimeout(function () {
          if (settleWinner !== winnerSeat) return;   // 已开新局，忽略
          markReady(seat);
        }, delay);
      })(s);
    }
  }

  // 标记某家已准备，检查是否全部就绪
  function markReady(seat) {
    if (readySeats[seat]) return;
    readySeats[seat] = true;
    checkAllReady();
  }

  // 三家非赢家全部准备后：玩家是赢家则点亮「开始」，AI 是赢家则自动开局
  function checkAllReady() {
    var allReady = true;
    for (var s = 0; s < 4; s++) {
      if (!readySeats[s]) { allReady = false; break; }
    }
    if (!allReady) return;

    var btnStart = $('btn-start-next');
    if (settleWinner === HUMAN_SEAT) {
      // 玩家是赢家：点亮「开始」按钮
      if (btnStart) btnStart.disabled = false;
    } else {
      // AI 是赢家：自动掷骰开局
      var delay = aiDelay === 0 ? 0 : 600;
      preTimeout(function () {
        if (settleWinner == null) return;
        startNextRound();
      }, delay);
    }
  }

  // 玩家点「准备」
  function onReady() {
    var btnReady = $('btn-ready');
    if (btnReady) { btnReady.disabled = true; btnReady.textContent = '已准备'; }
    markReady(HUMAN_SEAT);
  }

  // 玩家（赢家）点「开始」→ 立即掷骰开新局
  function onStartNext() {
    var btnStart = $('btn-start-next');
    if (btnStart && btnStart.disabled) return;
    startNextRound();
  }

  // 关闭结算弹窗并开始下一局
  function startNextRound() {
    var modal = $('win-modal');
    if (modal) modal.classList.add('hidden');
    // 重置准备状态
    settleWinner = null;
    readySeats = {};
    var btnReady = $('btn-ready');
    var btnStart = $('btn-start-next');
    if (btnReady) { btnReady.classList.add('hidden'); btnReady.disabled = false; btnReady.textContent = '准备'; }
    if (btnStart) { btnStart.classList.add('hidden'); btnStart.disabled = true; }

    clearPreTimers();
    clearTimeout(aiTimer);
    game = null;
    prePhase = 'wait';
    var btn = $('btn-start');
    if (btn) btn.classList.remove('pulse');
    // 立即开始掷骰
    beginRound();
  }

  // ---------------- 开局 / 测试注入 ----------------

  // 【开始游戏】按钮：首局前先弹玩法选择弹窗；已选定则庄家点击后掷骰开新一局
  function startGame() {
    if (prePhase === 'dice' || prePhase === 'deal') return;   // 动画进行中忽略连点
    if (!modeChosen) { openModeModal(); return; }
    beginRound();
  }

  // ---------------- 玩法选择弹窗（累计模式 / 带分模式） ----------------

  var modeSel = { mode: 'cumulate', score: 100 };   // 弹窗内的当前选择（未确认）

  function openModeModal() {
    var box = $('mode-modal');
    if (!box) return;   // DOM 未就绪（如测试页注入前的空文档）时不弹
    // 弹窗 UI 同步当前选择状态
    selectModeOption(modeSel.mode);
    applyScorePreset(modeSel.score);
    box.classList.remove('hidden');
  }

  function selectModeOption(mode) {
    modeSel.mode = mode;
    ['mode-cumulate', 'mode-bankroll'].forEach(function (id) {
      var el = $(id);
      if (el) el.classList.toggle('selected', el.getAttribute('data-mode') === mode);
    });
    var cfg = $('bankroll-config');
    if (cfg) cfg.classList.toggle('hidden', mode !== 'bankroll');
  }

  // 设定初始积分（预设或自定义统一入口）：最小 10 分，同步预设高亮与输入框
  function applyScorePreset(score) {
    score = Math.max(10, Math.floor(Number(score) || 100));
    modeSel.score = score;
    var presets = document.querySelectorAll('.score-preset');
    for (var i = 0; i < presets.length; i++) {
      presets[i].classList.toggle('selected', parseInt(presets[i].getAttribute('data-score'), 10) === score);
    }
    var input = $('score-input');
    if (input && document.activeElement !== input) input.value = score;
  }

  // 弹窗确认：锁定玩法，关闭弹窗——不自动开局，回到桌面等玩家点「开始」
  function onModeStart() {
    playMode = modeSel.mode;
    initialScore = modeSel.score;
    modeChosen = true;
    sessionBusted = false;
    $('mode-modal').classList.add('hidden');
    render();   // HUD 分数列刷新为所选口径
  }

  // 带分模式整场结束 → 重开新场：积分恢复初始值、连庄清零、重新随机庄家
  function resetForNewMatch() {
    scores = [0, 0, 0, 0];
    bankerStreak = 0;
    nextBankerSeat = null;
    sessionBusted = false;
    settleWinner = null;
    readySeats = {};
    clearPreTimers();
    clearTimeout(aiTimer);
    var modal = $('win-modal');
    if (modal) modal.classList.add('hidden');
    var btnReady = $('btn-ready');
    var btnStart = $('btn-start-next');
    if (btnReady) { btnReady.classList.add('hidden'); btnReady.disabled = false; btnReady.textContent = '准备'; }
    if (btnStart) { btnStart.classList.add('hidden'); btnStart.disabled = true; }
  }

  // 「再来一场」：同玩法同初始积分，直接重开新场
  function onAgain() {
    resetForNewMatch();
    beginRound();
  }

  // 「更换玩法」：重置后回到玩法选择弹窗
  function onChangeMode() {
    resetForNewMatch();
    modeChosen = false;
    openModeModal();
  }

  // 测试/调试接口：注入一个造好的牌局并立即驱动
  function loadGame(g) {
    clearTimeout(aiTimer);
    clearPreTimers();
    humanPassed = false;
    hideActions();
    var modal = $('win-modal');
    if (modal) modal.classList.add('hidden');
    game = g;
    prePhase = 'play';
    var btn = $('btn-start');
    if (btn) { btn.classList.add('hidden'); btn.classList.remove('pulse'); }
    render();
    advance();
  }

  // ---------------- 初始化 ----------------

  function init() {
    var btn = $('btn-start');
    if (btn) btn.addEventListener('click', startGame);
    var handEl = $('hand-seat-' + HUMAN_SEAT);
    if (handEl) handEl.addEventListener('click', onHandClick);
    updateTableScale();
    window.addEventListener('resize', function () {
      updateTableScale();
      positionTenpai(); positionActionBar(); positionSouthDiscard();
      positionFloatingDiscard(game && game.turn && game.turn.pendingDiscard ? game.turn.pendingDiscard.seat : HUMAN_SEAT);
    });
    var bp = $('btn-peng');   if (bp) bp.addEventListener('click', onPeng);
    var bc = $('btn-chi');    if (bc) bc.addEventListener('click', onChiClick);
    var bg = $('btn-gang');   if (bg) bg.addEventListener('click', onMingGang);
    var ba = $('btn-angang'); if (ba) ba.addEventListener('click', onAnGang);
    var bps = $('btn-pass');  if (bps) bps.addEventListener('click', onPass);
    var bhu = $('btn-hu');     if (bhu) bhu.addEventListener('click', onHu);
    var bbu = $('btn-bugang'); if (bbu) bbu.addEventListener('click', onBuGang);
    var brdy = $('btn-ready');       if (brdy) brdy.addEventListener('click', onReady);
    var bsn = $('btn-start-next');   if (bsn) bsn.addEventListener('click', onStartNext);
    // 玩法选择弹窗：玩法卡片 / 初始积分预设与自定义 / 开始
    var moC = $('mode-cumulate');   if (moC) moC.addEventListener('click', function () { selectModeOption('cumulate'); });
    var moB = $('mode-bankroll');   if (moB) moB.addEventListener('click', function () { selectModeOption('bankroll'); });
    var presets = document.querySelectorAll('.score-preset');
    for (var pi = 0; pi < presets.length; pi++) {
      (function (btn) {
        btn.addEventListener('click', function () { applyScorePreset(parseInt(btn.getAttribute('data-score'), 10)); });
      })(presets[pi]);
    }
    var sIn = $('score-input');
    if (sIn) sIn.addEventListener('change', function () { applyScorePreset(sIn.value); });
    var bms = $('btn-mode-start');  if (bms) bms.addEventListener('click', onModeStart);
    var bag = $('btn-again');       if (bag) bag.addEventListener('click', onAgain);
    var bcm = $('btn-change-mode'); if (bcm) bcm.addEventListener('click', onChangeMode);
    positionSouthDiscard();
    // 进游戏先选玩法：未选定过模式时直接弹出玩法选择（确认后再点「开始」开局）
    if (!modeChosen) openModeModal();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // 测试/调试接口
  window.MJUI = {
    startGame: startGame,
    loadGame: loadGame,
    init: init,   // 测试钩子：DOM 被替换后重新绑定事件
    faceHTML: tileFaceHTML,   // 测试钩子：牌面图案 HTML
    getGame: function () { return game; },
    setAiDelay: function (ms) { aiDelay = ms; },
    // 跨局会话状态（连庄 / 累计积分 / 下局庄家 / 玩法模式）
    getSession: function () {
      return { scores: scores.slice(), bankerStreak: bankerStreak, nextBankerSeat: nextBankerSeat,
               playMode: playMode, initialScore: initialScore, modeChosen: modeChosen,
               sessionBusted: sessionBusted };
    },
    // 测试用：显式设置会话状态
    setSession: function (o) {
      if (o.scores) scores = o.scores.slice();
      if (o.bankerStreak != null) bankerStreak = o.bankerStreak;
      if (o.nextBankerSeat !== undefined) nextBankerSeat = o.nextBankerSeat;
      if (o.playMode) playMode = o.playMode;
      if (o.initialScore != null) initialScore = o.initialScore;
      if (o.modeChosen != null) modeChosen = o.modeChosen;
      if (o.sessionBusted != null) sessionBusted = o.sessionBusted;
    },
    // 测试钩子：直接设定玩法（不弹弹窗，等同弹窗确认的选择结果）
    chooseMode: function (mode, init) {
      playMode = (mode === 'bankroll') ? 'bankroll' : 'cumulate';
      initialScore = Math.max(10, Math.floor(Number(init) || 100));
      modeChosen = true;
      sessionBusted = false;
    },
    // 测试钩子：带分模式整场结束后的重开重置（积分恢复初始值）
    resetForNewMatch: resetForNewMatch
  };
})();
