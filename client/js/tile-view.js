/**
 * tile-view.js —— 联机客户端【纯牌面展示模块】
 * 只负责把牌编码渲染成传统图案 DOM，不含任何麻将业务规则、不做任何判定。
 * 牌型/台数/胡牌等全部由后端 server.js 计算，本文件是"哑渲染器"。
 */
(function (global) {
  'use strict';

  var NUM_CHARS = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
  var WIND_CHARS_FULL = ['東', '南', '西', '北'];
  var DRAGON_CHARS = ['中', '發', '白'];
  var SUIT_ORDER = { w: 0, t: 1, o: 2, f: 3, j: 4 };

  // 牌编码 -> 展示用中文名（纯展示，如听牌列表、结算文案）
  function tileName(code) {
    var suitKey = code.charAt(0);
    var rank = parseInt(code.slice(1), 10);
    if (suitKey === 'f') return WIND_CHARS_FULL[rank - 1];
    if (suitKey === 'j') return DRAGON_CHARS[rank - 1];
    var suitName = { w: '万', t: '条', o: '筒' }[suitKey];
    return NUM_CHARS[rank - 1] + suitName;
  }

  // 牌码排序比较（万->条->筒->风->箭，同花色按点数），仅用于展示排序
  function compareCodes(a, b) {
    var sa = SUIT_ORDER[a.charAt(0)], sb = SUIT_ORDER[b.charAt(0)];
    if (sa !== sb) return sa - sb;
    return parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10);
  }

  /* ---------------- 牌面常量（与单机 UI 完全一致） ---------------- */

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

  var TONG_CELLS = {
    2: [[1, 2, 'b'], [3, 2, 'g']],
    3: [[1, 1, 'b'], [2, 2, 'r'], [3, 3, 'g']],
    4: [[1, 1, 'g'], [1, 3, 'b'], [3, 1, 'b'], [3, 3, 'g']],
    5: [[1, 1, 'g'], [1, 3, 'b'], [2, 2, 'r'], [3, 1, 'b'], [3, 3, 'g']],
    6: [[[32.5, 20], 'g'], [[67.5, 20], 'g'],
        [[32.5, 50], 'r'], [[67.5, 50], 'r'],
        [[32.5, 80], 'r'], [[67.5, 80], 'r']],
    7: [[[29, 24], 'g', ' d-sm'], [[52, 32], 'g', ' d-sm'], [[75, 40], 'g', ' d-sm'],
        [[37, 60], 'r', ' d-lg'], [[65, 60], 'r', ' d-lg'],
        [[37, 79], 'r', ' d-lg'], [[65, 79], 'r', ' d-lg']]
  };

  var TONG_AUTO = {
    8: { cls: 'tong-8', colors: ['b', 'b', 'b', 'b', 'b', 'b', 'b', 'b'] },
    9: { cls: '', colors: ['b', 'b', 'b', 'r', 'r', 'r', 'g', 'g', 'g'] }
  };

  var TIAO_LAYOUT = {
    2: { cls: '', cells: [[1, 2, 'g'], [3, 2, 'g']] },
    3: { cls: 'tiao-3', cells: [[1, 2, 'g'], [2, 1, 'g'], [2, 3, 'g']] },
    4: { cls: 'tiao-4', auto: ['g', 'g', 'g', 'g'] },
    5: { cls: '', cells: [[1, 1, 'g'], [1, 3, 'g'], [2, 2, 'r'], [3, 1, 'g'], [3, 3, 'g']] },
    6: { cls: 'tiao-6', auto: ['g', 'g', 'g', 'g', 'g', 'g'] },
    7: { cls: '', cells: [[1, 2, 'r'],
                          [2, 1, 'g'], [2, 2, 'b'], [2, 3, 'g'],
                          [3, 1, 'g'], [3, 2, 'b'], [3, 3, 'g']] },
    8: { cls: 'tiao-8', rods: [
      [[27, 29], 'g', ' rod-v'], [[78, 29], 'g', ' rod-v'],
      [[41, 31.5], 'g', ' rod-d rod-cw'], [[63, 31.5], 'g', ' rod-d rod-ccw'],
      [[27, 73], 'g', ' rod-v'], [[78, 73], 'g', ' rod-v'],
      [[41, 71.5], 'g', ' rod-d rod-ccw'], [[63, 71.5], 'g', ' rod-d rod-cw']
    ] },
    9: { cls: 'tiao-9', auto: ['g', 'g', 'g', 'r', 'r', 'r', 'g', 'g', 'g'] }
  };

  function dotHTML(r, c, color, extraClass) {
    if (Array.isArray(r) && r.length === 2 && !c) {
      return '<i class="dot dot-center dot-' + color + (extraClass || '') +
             '" style="left:' + r[0] + '%;top:' + r[1] + '%"></i>';
    }
    return '<i class="dot dot-' + color + (extraClass || '') +
           '" style="grid-area:' + r + '/' + c + '"></i>';
  }

  function rodHTML(posOrColor, colorOrArea, extra) {
    if (Array.isArray(posOrColor)) {
      return '<i class="rod rod-center rod-' + colorOrArea + (extra || '') +
             '" style="left:' + posOrColor[0] + '%;top:' + posOrColor[1] + '%"></i>';
    }
    var st = colorOrArea ? ' style="grid-area:' + colorOrArea + '"' : '';
    return '<i class="rod rod-' + posOrColor + '"' + st + '></i>';
  }

  // 一张明牌的牌面内部 HTML（纯图案）
  function tileFaceHTML(code) {
    var suitKey = code.charAt(0);
    var rank = parseInt(code.slice(1), 10);

    if (suitKey === 'w') {
      return '<span class="tile-face face-wan" data-code="' + code + '">' +
             '<span class="wan-num">' + NUM_CHARS[rank - 1] + '</span>' +
             '<span class="wan-char">萬</span></span>';
    }
    if (suitKey === 'f') {
      return '<span class="tile-face face-zi zi-wind" data-code="' + code + '">' +
             WIND_CHARS_FULL[rank - 1] + '</span>';
    }
    if (suitKey === 'j') {
      if (rank === 3) {
        return '<span class="tile-face" data-code="' + code + '"><span class="bai-box"></span></span>';
      }
      if (rank === 1) {
        return '<span class="tile-face face-zi zi-zhong" data-code="' + code + '">中</span>';
      }
      return '<span class="tile-face face-zi zi-fa" data-code="' + code + '">發</span>';
    }
    if (suitKey === 'o') {
      if (rank === 1) {
        return '<span class="tile-face face-tong tong-1" data-code="' + code + '">' + SVG_BIG_BING + '</span>';
      }
      var classes = ['face-tong', 'tong-' + rank];
      var content;
      if (TONG_CELLS[rank]) {
        content = TONG_CELLS[rank].map(function (cell) {
          var pos = cell[0], color = cell[1], extra = cell[2] || '';
          if (Array.isArray(pos)) return dotHTML(pos, null, color, extra);
          var rInt = pos, cInt = color, colStr = cell[2] || '', extra2 = cell[3] || '';
          if (cell.length === 3 && !extra2) return dotHTML(rInt, cInt, colStr, '');
          return dotHTML(rInt, cInt, colStr, extra2);
        }).join('');
      } else {
        var a = TONG_AUTO[rank];
        classes.push(a.cls);
        content = a.colors.map(function (color) {
          return '<i class="dot dot-' + color + '"></i>';
        }).join('');
      }
      return '<span class="tile-face ' + classes.join(' ') + '" data-code="' + code + '">' + content + '</span>';
    }
    // 条子
    if (suitKey === 't' && rank === 1) {
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

  /**
   * 创建一张牌 DOM
   * opts: { small:小牌, faceDown:牌背, wildCodes:[本局财神码...] }
   */
  function makeTile(code, opts) {
    opts = opts || {};
    var el = document.createElement('div');
    var cls = 'tile';
    if (opts.small) cls += ' tile-sm';
    if (opts.faceDown) {
      cls += ' tile-back';
    } else {
      if (opts.wildCodes && opts.wildCodes.indexOf(code) !== -1) cls += ' tile-wild';
      el.innerHTML = tileFaceHTML(code);
    }
    el.className = cls;
    return el;
  }

  global.TileView = {
    tileName: tileName,
    compareCodes: compareCodes,
    tileFaceHTML: tileFaceHTML,
    makeTile: makeTile
  };
})(window);
