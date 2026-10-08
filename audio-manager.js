/**
 * audio-manager.js —— 诸暨麻将统一音频管理（单机 / 联机通用）
 *
 * 不依赖任何外部音频文件：背景音乐与全部音效均用 WebAudio 实时合成。
 *   · BGM：五声音阶（宫商角徵羽）弹拨风格循环旋律 + 低音 + 轻打击
 *   · SFX：出牌（竹牌敲击）、碰 / 吃 / 杠、胡牌琶音、胜利曲、骰子、按钮
 *
 * 对外接口：window.GameAudio
 *   sfx(name)                 播放音效（discard/peng/chi/gang/hu/win/dice/click）
 *   setBgmVolume(0~1)         设置背景音乐音量
 *   setSfxVolume(0~1)         设置音效音量
 *   getConfig()               { bgm, sfx }
 *
 * 音量设置保存在 localStorage；页面自动注入右上角「设置」按钮与面板。
 * 浏览器自动播放策略：首次触摸/按键后解锁并开始 BGM。
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'mj_audio_cfg_v1';
  var cfg = { bgm: 0.45, sfx: 0.6 };

  try {
    var saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (saved) {
      if (isNum(saved.bgm)) cfg.bgm = clamp01(saved.bgm);
      if (isNum(saved.sfx)) cfg.sfx = clamp01(saved.sfx);
    }
  } catch (e) {}

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function persist() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg)); } catch (e) {}
  }

  /* ---------------- AudioContext ---------------- */

  var AC = window.AudioContext || window.webkitAudioContext;
  var ctx = null, bgmGain = null, sfxGain = null, noiseBuf = null;
  var unlocked = false;

  function ensureContext() {
    if (!AC) return null;
    if (!ctx) {
      ctx = new AC();
      bgmGain = ctx.createGain();
      sfxGain = ctx.createGain();
      bgmGain.gain.value = cfg.bgm;
      sfxGain.gain.value = cfg.sfx;
      bgmGain.connect(ctx.destination);
      sfxGain.connect(ctx.destination);
      noiseBuf = makeNoise(ctx);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function makeNoise(c) {
    var len = c.sampleRate, buf = c.createBuffer(1, len, c.sampleRate),
        d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  /* ---------------- BGM：五声音阶循环 ---------------- */

  // 五声音阶相对十二平均律半音：宫0 商2 角4 徵7 羽9
  var DEG_SEMI = [0, 2, 4, 7, 9];
  var BASE_F = 261.63; // C4 宫
  var STEP = 0.27;     // 每步时长（秒）

  // 两条 16 步旋律：值 = 音级(0~4)；>=5 表示高八度(值-5)；-1 休止
  var PHRASES = [
    // 中音区
    [2, -1, 4, -1, 2, 3, 4, -1, 3, 2, 0, -1, 1, 2, -1, -1],
    // 高八度区（值 = 音级 + 5）
    [9, -1, 8, 9, -1, 7, 8, -1, 9, -1, 7, -1, 6, 5, -1, -1]
  ];
  // 低音：每句第 0、8 步（半音偏移相对 C4）
  var BASS_SEMI = [-12, -5];

  var schedTimer = null, stepIdx = 0, phraseIdx = 0, nextTime = 0;

  function noteFreq(semi) { return BASE_F * Math.pow(2, semi / 12); }

  // 弹拨音色：三角波基音 + 正弦八度泛音，快速起音、指数衰减
  function pluck(time, freq, peak, dur) {
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(peak, time + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, time + dur);
    g.connect(bgmGain);

    var o1 = ctx.createOscillator();
    o1.type = 'triangle';
    o1.frequency.value = freq;
    var g1 = ctx.createGain();
    g1.gain.value = 1;
    o1.connect(g1); g1.connect(g);

    var o2 = ctx.createOscillator();
    o2.type = 'sine';
    o2.frequency.value = freq * 2;
    var g2 = ctx.createGain();
    g2.gain.value = 0.28;
    o2.connect(g2); g2.connect(g);

    o1.start(time); o2.start(time);
    o1.stop(time + dur + 0.05); o2.stop(time + dur + 0.05);
  }

  // 轻打击：极弱的高频噪声点
  function softTick(time) {
    var s = ctx.createBufferSource();
    s.buffer = noiseBuf;
    var f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 5000;
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.018, time);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);
    s.connect(f); f.connect(g); g.connect(bgmGain);
    s.start(time);
    s.stop(time + 0.08);
  }

  function scheduleStep(pIdx, st, time) {
    if (cfg.bgm > 0.001) {
      var v = PHRASES[pIdx][st];
      if (v !== -1) {
        var oct = v >= 5 ? 1 : 0;
        var deg = v >= 5 ? v - 5 : v;
        pluck(time, noteFreq(oct * 12 + DEG_SEMI[deg]), 0.16, STEP * 2.4);
      }
      if (st === 0 || st === 8) {
        pluck(time, noteFreq(BASS_SEMI[pIdx]), 0.12, STEP * 6);
      }
      if (st === 6 || st === 14) softTick(time);
    }
  }

  function schedulerTick() {
    if (!ctx || !unlocked) return;
    while (nextTime < ctx.currentTime + 0.35) {
      scheduleStep(phraseIdx, stepIdx, nextTime);
      nextTime += STEP;
      stepIdx++;
      if (stepIdx === 16) { stepIdx = 0; phraseIdx ^= 1; }
    }
  }

  function startBgm() {
    if (!ensureContext()) return;
    if (schedTimer === null) {
      stepIdx = 0; phraseIdx = 0;
      nextTime = ctx.currentTime + 0.08;
      schedTimer = setInterval(schedulerTick, 110);
    }
  }

  /* ---------------- 音效合成 ---------------- */

  // 麻将牌敲击：噪声「啪」+ 正弦「托」
  function clack(time, freq, peak) {
    var s = ctx.createBufferSource();
    s.buffer = noiseBuf;
    var bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq * 2.6;
    bp.Q.value = 0.8;
    var gn = ctx.createGain();
    gn.gain.setValueAtTime(peak * 0.9, time);
    gn.gain.exponentialRampToValueAtTime(0.0001, time + 0.045);
    s.connect(bp); bp.connect(gn); gn.connect(sfxGain);
    s.start(time); s.stop(time + 0.06);

    var o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(freq, time);
    o.frequency.exponentialRampToValueAtTime(freq * 0.72, time + 0.07);
    var go = ctx.createGain();
    go.gain.setValueAtTime(peak, time);
    go.gain.exponentialRampToValueAtTime(0.0001, time + 0.085);
    o.connect(go); go.connect(sfxGain);
    o.start(time); o.stop(time + 0.1);
  }

  // 音效通道内的弹拨（胡牌/胜利琶音用）
  function sfxPluck(time, semi, peak, dur) {
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(peak, time + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, time + dur);
    g.connect(sfxGain);
    var o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = noteFreq(semi);
    o.connect(g);
    o.start(time); o.stop(time + dur + 0.05);
  }

  var SFX = {
    discard: function (t) { clack(t, 640, 0.5); },
    peng: function (t) { clack(t, 540, 0.5); clack(t + 0.075, 480, 0.45); },
    chi: function (t) { clack(t, 460, 0.32); },
    gang: function (t) {
      clack(t, 400, 0.5);
      clack(t + 0.085, 360, 0.45);
      clack(t + 0.17, 320, 0.42);
    },
    // 胡牌：五声上行琶音
    hu: function (t) {
      [0, 4, 7, 12, 16].forEach(function (semi, i) {
        sfxPluck(t + i * 0.07, semi, 0.4, 0.5);
      });
    },
    // 胜利：八音欢快旋律，尾音高扬
    win: function (t) {
      var seq = [[0, 0], [4, 1], [7, 2], [12, 3], [16, 4],
                 [12, 5], [16, 6], [24, 7]];
      seq.forEach(function (n) {
        sfxPluck(t + n[1] * 0.095, n[0], 0.42, 0.65);
      });
    },
    // 骰子：一串短促碎响
    dice: function (t) {
      for (var i = 0; i < 7; i++) {
        (function (i) {
          var tt = t + i * 0.05 + Math.random() * 0.02;
          var s = ctx.createBufferSource();
          s.buffer = noiseBuf;
          var bp = ctx.createBiquadFilter();
          bp.type = 'bandpass';
          bp.frequency.value = 1800 + Math.random() * 1200;
          var g = ctx.createGain();
          g.gain.setValueAtTime(0.28, tt);
          g.gain.exponentialRampToValueAtTime(0.0001, tt + 0.04);
          s.connect(bp); bp.connect(g); g.connect(sfxGain);
          s.start(tt); s.stop(tt + 0.06);
        })(i);
      }
    },
    click: function (t) {
      var o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = 820;
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.18, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
      o.connect(g); g.connect(sfxGain);
      o.start(t); o.stop(t + 0.08);
    }
  };

  function sfx(name) {
    if (!unlocked || !SFX[name]) return;
    if (!ensureContext()) return;
    try { SFX[name](ctx.currentTime + 0.01); } catch (e) {}
  }

  /* ---------------- 设置按钮与面板（自动注入） ---------------- */

  function buildSettingsUi() {
    var css =
      '.mj-aud-btn{position:fixed;top:10px;right:10px;width:40px;height:40px;' +
      'z-index:99999;border-radius:50%;border:1px solid rgba(255,255,255,.35);' +
      'background:rgba(20,40,32,.62);cursor:pointer;display:flex;' +
      'align-items:center;justify-content:center;padding:0;-webkit-tap-highlight-color:transparent}' +
      '.mj-aud-btn svg{width:22px;height:22px;fill:#eaf5ee}' +
      '.mj-aud-panel{position:fixed;top:58px;right:10px;width:238px;z-index:99999;' +
      'background:rgba(18,38,30,.96);border:1px solid rgba(255,255,255,.22);' +
      'border-radius:12px;padding:14px 14px 12px;color:#eaf5ee;' +
      'font:14px/1.5 system-ui,-apple-system,"Microsoft YaHei",sans-serif;' +
      'box-shadow:0 8px 28px rgba(0,0,0,.45)}' +
      '.mj-aud-panel h3{margin:0 0 10px;font-size:15px} ' +
      '.mj-aud-row{margin:9px 0} ' +
      '.mj-aud-row .lab{display:flex;justify-content:space-between;' +
      'font-size:13px;margin-bottom:4px} ' +
      '.mj-aud-row .val{color:#f5c542} ' +
      '.mj-aud-row input[type=range]{width:100%;accent-color:#f5c542;height:22px} ' +
      '.mj-aud-close{margin-top:10px;width:100%;padding:7px 0;border-radius:8px;' +
      'border:1px solid rgba(255,255,255,.3);background:rgba(255,255,255,.1);' +
      'color:#fff;font-size:13px;cursor:pointer}';
    var styleEl = document.createElement('style');
    styleEl.textContent = css;
    document.head.appendChild(styleEl);

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mj-aud-btn';
    btn.title = '声音设置';
    btn.innerHTML =
      '<svg viewBox="0 0 24 24"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>';
    document.body.appendChild(btn);

    var panel = document.createElement('div');
    panel.className = 'mj-aud-panel';
    panel.style.display = 'none';
    panel.innerHTML =
      '<h3>声音设置</h3>' +
      '<div class="mj-aud-row"><div class="lab"><span>背景音乐</span>' +
      '<span class="val" id="mj-aud-bgm-val"></span></div>' +
      '<input type="range" min="0" max="100" step="1" id="mj-aud-bgm"></div>' +
      '<div class="mj-aud-row"><div class="lab"><span>出牌音效</span>' +
      '<span class="val" id="mj-aud-sfx-val"></span></div>' +
      '<input type="range" min="0" max="100" step="1" id="mj-aud-sfx"></div>' +
      '<button type="button" class="mj-aud-close" id="mj-aud-close">关 闭</button>';
    document.body.appendChild(panel);

    var bgmRange = panel.querySelector('#mj-aud-bgm');
    var sfxRange = panel.querySelector('#mj-aud-sfx');
    var bgmVal = panel.querySelector('#mj-aud-bgm-val');
    var sfxVal = panel.querySelector('#mj-aud-sfx-val');

    function refresh() {
      bgmRange.value = Math.round(cfg.bgm * 100);
      sfxRange.value = Math.round(cfg.sfx * 100);
      bgmVal.textContent = bgmRange.value + '%';
      sfxVal.textContent = sfxRange.value + '%';
    }
    refresh();

    bgmRange.addEventListener('input', function () {
      setBgmVolume(bgmRange.value / 100);
      refresh();
    });
    sfxRange.addEventListener('input', function () {
      setSfxVolume(sfxRange.value / 100);
      refresh();
      if (cfg.sfx > 0.01) sfx('click');
    });

    btn.addEventListener('click', function () {
      panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    });
    panel.querySelector('#mj-aud-close').addEventListener('click', function () {
      panel.style.display = 'none';
    });
  }

  /* ---------------- 音量接口 ---------------- */

  function setBgmVolume(v) {
    cfg.bgm = clamp01(v);
    if (bgmGain && ctx) bgmGain.gain.setTargetAtTime(cfg.bgm, ctx.currentTime, 0.02);
    persist();
  }

  function setSfxVolume(v) {
    cfg.sfx = clamp01(v);
    if (sfxGain && ctx) sfxGain.gain.setTargetAtTime(cfg.sfx, ctx.currentTime, 0.02);
    persist();
  }

  /* ---------------- 首次手势解锁 ---------------- */

  function unlock() {
    if (unlocked) return;
    unlocked = true;
    ensureContext();
    startBgm();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildSettingsUi);
  } else {
    buildSettingsUi();
  }
  ['pointerdown', 'touchstart', 'keydown'].forEach(function (ev) {
    window.addEventListener(ev, unlock, { passive: true });
  });

  /* ---------------- 导出 ---------------- */

  window.GameAudio = {
    sfx: sfx,
    startBgm: startBgm,
    setBgmVolume: setBgmVolume,
    setSfxVolume: setSfxVolume,
    getConfig: function () { return { bgm: cfg.bgm, sfx: cfg.sfx }; },
    unlock: unlock
  };
})();
