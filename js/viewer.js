/*
 * viewer.js —— 自研交互式甘特渲染器 v3（纯本地、无外部依赖）
 *
 * 能力：
 *  1) 解析 gantt.md 的 mermaid gantt 子集语法（js/parser.js）
 *  2) 自绘 SVG：今日红色竖线随打开当天自动定位（无需定时任务）
 *  3) 轨道压缩布局：任务按时间不重叠贪心分配轨道，多任务可同一行 → 总行数大幅减少
 *  4) 任务条/里程碑文字：按条宽分级显示「任务名(8.1至8.25)」；点击条/节点/左侧名均弹详情
 *  5) 点击左侧事件名 → 弹详情抽屉 + 自动滚动定位到事件日期并闪烁高亮
 *  6) 工具条：上一/下一学年、上一/下一月、回到今天、放大/缩小（以视口中心日期为锚点）
 *  7) 左侧事件索引列与顶部说明栏均可折叠（默认折叠）
 *  8) 手机横屏（窄屏 landscape）：时间图向右旋转 90° 供横屏浏览（时间纵向流动），
 *     触屏纵向滑动 / 滚轮 映射为时间滚动；桌面保持常规横向视图
 *
 * 用法：GanttViewer.mount(containerEl, ganttCode, eventsData)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GanttViewer = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DAY = 86400000;
  /* 工厂函数体内取全局对象必须走 globalThis（闭包拿不到外层 IIFE 的 root） */
  var G = (typeof globalThis !== 'undefined') ? globalThis
    : (typeof self !== 'undefined' ? self : this);
  var Parser = (typeof module === 'object' && module.exports)
    ? require('./parser.js')
    : (G.GanttParser || {});

  var CSS = String.raw `
.gv-root{--gv-blue:#2563eb;--gv-ink:#1f2937;--gv-sub:#6b7280;--gv-line:#e5e7eb;
  font-family:"Microsoft YaHei","PingFang SC",system-ui,sans-serif;color:var(--gv-ink);
  --gv-rowh:30px}
.gv-root *{box-sizing:border-box}
.gv-toolbar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;background:#fff;border:1px solid var(--gv-line);
  border-radius:10px;padding:8px;margin:10px 0 6px;position:sticky;top:0;z-index:30;box-shadow:0 2px 6px rgba(15,23,42,.06)}
.gv-tbtn{appearance:none;border:1px solid #dbe3ef;background:#fff;color:#1e3a5f;border-radius:8px;
  padding:5px 9px;font-size:13px;line-height:1.2;cursor:pointer;display:inline-flex;align-items:center;gap:3px;touch-action:manipulation}
.gv-tbtn:hover{background:#eff6ff;border-color:#93c5fd}
.gv-tbtn:active{transform:translateY(1px)}
.gv-tbtn.primary{background:linear-gradient(135deg,#1d4ed8,#3b82f6);color:#fff;border-color:#1d4ed8;font-weight:600}
.gv-tbtn.primary:hover{background:linear-gradient(135deg,#1e40af,#2563eb)}
.gv-range{font-size:12px;color:var(--gv-sub);background:#f1f5f9;border-radius:6px;padding:4px 9px;white-space:nowrap}
.gv-range b{color:#0f4c9c}
.gv-legend{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:11.5px;color:var(--gv-sub);margin:2px 2px 6px}
.gv-legend i{display:inline-block;width:20px;height:3px;border-radius:2px;margin-right:4px;vertical-align:middle}
.gv-legend i.dia{width:8px;height:8px;transform:rotate(45deg);border-radius:1px}
.gv-legend i.today{width:2px;height:11px;background:#ef4444;margin-right:5px}
.gv-body{display:flex;align-items:stretch;background:#fff;border:1px solid var(--gv-line);border-radius:10px;overflow:hidden}
/* ---- 左侧事件索引列（与轨道行解耦，可折叠） ---- */
.gv-labels{flex:0 0 auto;width:176px;border-right:2px solid #dbe3ef;background:#fff;position:relative;z-index:5;
  display:flex;flex-direction:column;min-height:140px}
.gv-labels.collapsed{width:34px;min-height:0}
.gv-labels.collapsed .gv-lhead{flex-direction:column;gap:8px;padding:8px 2px;background:linear-gradient(180deg,#eef2ff,#f8faff)}
.gv-labels.collapsed .gv-lhead .gv-lttl{display:none}
.gv-labels.collapsed .gv-lbox{display:none}
.gv-lhead{flex:0 0 auto;display:flex;align-items:center;gap:6px;padding:6px 8px;font-size:12px;font-weight:700;
  color:#0f3b8f;background:linear-gradient(90deg,#e3ebff,#f2f6ff);border-bottom:1px solid #dbe3ef}
.gv-lhead .cnt{color:#64748b;font-weight:600;font-size:11px;background:#fff;border:1px solid #dbe3ef;border-radius:999px;padding:0 7px}
.gv-lttl{white-space:nowrap}
.gv-chev{flex:0 0 auto;border:1px solid #c7d2fe;background:#fff;color:#3730a3;border-radius:7px;cursor:pointer;
  font-size:12px;line-height:1;padding:4px 7px}
.gv-chev:hover{background:#eef2ff}
.gv-lbox{flex:1 1 auto;overflow-y:auto;overscroll-behavior:contain;padding-bottom:4px}
.gv-lsec{position:sticky;top:0;background:linear-gradient(90deg,#dfe9ff,#f2f6ff);color:#0f3b8f;font-weight:700;font-size:11px;
  padding:4px 8px;z-index:2;border-bottom:1px solid #dbe3ef}
.gv-lname{display:flex;align-items:flex-start;gap:5px;padding:5px 8px;cursor:pointer;font-size:11.5px;color:#374151;
  border-bottom:1px solid #f4f6fa;line-height:1.5}
.gv-lname:hover{background:#eaf2ff}
.gv-lname.active{background:#dbeafe;color:#1e3a8a}
.gv-lname .dot{flex:0 0 auto;font-size:10px;line-height:1.6}
.gv-lname .nm{flex:1 1 auto;min-width:0}
.gv-lname .nm b{display:block;font-weight:600;color:#1f2937;font-size:11.5px;white-space:normal;word-break:break-all}
.gv-lname .nm .dt{display:block;font-size:10px;color:#6b7280;font-weight:400;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* ---- 右侧滚动时间图 ---- */
.gv-scroll{flex:1 1 auto;overflow-x:auto;overflow-y:hidden;-webkit-overflow-scrolling:touch;overscroll-behavior-x:contain;min-width:0}
.gv-scroll svg{display:block}
.gv-err{color:#991b1b;background:#fee2e2;border:1px solid #fca5a5;border-radius:10px;padding:12px 14px;font-size:12.5px;margin:10px 0 0;white-space:pre-wrap}
.gv-warn{color:#92400e;background:#fef3c7;border:1px solid #fcd34d;border-radius:10px;padding:10px 14px;font-size:12.5px;margin:10px 0 0;white-space:pre-wrap}
.gv-bar{cursor:pointer}
.gv-flash{animation:gvFlash 1.2s ease-in-out 2}
@keyframes gvFlash{0%,100%{opacity:1}50%{opacity:.3}}
/* 详情抽屉 */
.gv-mask{position:fixed;inset:0;background:rgba(15,23,42,.45);z-index:60;opacity:0;transition:opacity .18s;pointer-events:none}
.gv-mask.on{opacity:1;pointer-events:auto}
.gv-drawer{position:fixed;left:0;right:0;bottom:0;max-height:84vh;overflow-y:auto;background:#fff;z-index:61;
  border-radius:16px 16px 0 0;padding:14px 18px calc(18px + env(safe-area-inset-bottom));
  transform:translateY(102%);transition:transform .22s cubic-bezier(.2,.8,.25,1);box-shadow:0 -8px 30px rgba(15,23,42,.2)}
.gv-drawer.on{transform:translateY(0)}
.gv-drawer .grab{width:44px;height:4px;border-radius:2px;background:#d1d5db;margin:0 auto 12px}
.gv-dhead{font-size:17px;font-weight:700;color:#0f172a;margin:2px 0;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.gv-dsub{font-size:12px;color:var(--gv-sub);margin-bottom:12px}
.gv-chip{display:inline-block;font-size:11px;border-radius:999px;padding:2px 9px;font-weight:600;margin:0 5px 4px 0}
.gv-chip.c1{background:#fef3c7;color:#92400e}.gv-chip.c2{background:#dcfce7;color:#166534}
.gv-chip.c3{background:#fee2e2;color:#991b1b}.gv-chip.c4{background:#e0e7ff;color:#3730a3}
.gv-drow{display:flex;gap:10px;padding:8px 0;border-top:1px solid #f1f5f9;font-size:13px}
.gv-drow .k{flex:0 0 80px;color:var(--gv-sub);font-size:12px;padding-top:2px}
.gv-drow .v{flex:1 1 auto;color:#111827;line-height:1.65;word-break:break-word}
.gv-steps{margin:2px 0;padding:0;list-style:none}
.gv-steps li{padding:2px 0 2px 18px;position:relative}
.gv-steps li::before{content:"";position:absolute;left:3px;top:11px;width:6px;height:6px;border-radius:50%;background:#3b82f6}
.gv-owner{display:inline-block;background:#eef2ff;border:1px solid #c7d2fe;color:#3730a3;border-radius:999px;
  font-size:11.5px;padding:2px 9px;margin:2px 4px 0 0}
.gv-close{position:sticky;top:0;float:right;border:none;background:#f3f4f6;width:30px;height:30px;border-radius:50%;
  cursor:pointer;font-size:15px;color:#4b5563}
.gv-close:hover{background:#e5e7eb}
/* ---- 手机横屏（landscape）：时间图向右旋转 90°，时间纵向流动 ---- */
.gv-land .gv-toolbar{position:static}
.gv-land .gv-body{position:relative;overflow:hidden}
.gv-land .gv-labels{max-height:calc(100vh - 6px)}
.gv-land .gv-labels.collapsed{width:34px}
.gv-land .gv-scroll{
  transform:rotate(90deg) translateY(-100%);
  transform-origin:top left;
}
@media (max-width:560px){
  .gv-labels{width:150px}.gv-lhead{font-size:11px;padding:5px 6px}
  .gv-lname{padding:4px 6px;font-size:11px}
  .gv-lname .nm b{font-size:11px}
}
`;

  /* ---------- 基础工具 ---------- */
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function dateOnly(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function addDays(d, n) { var x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function addMonths(d, n) { return new Date(d.getFullYear(), d.getMonth() + n, 1); }
  function diffDays(a, b) { return Math.round((b - a) / DAY); }
  function fmtMD(d) { return (d.getMonth() + 1) + '.' + d.getDate(); }
  function fmtYMD(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function fmtCN(d) { return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日'; }
  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function truncateText(txt, maxLen) {
    txt = String(txt);
    if (txt.length <= maxLen) return txt;
    return txt.slice(0, Math.max(3, maxLen - 1)) + '…';
  }
  /* 状态色 */
  function statusOf(task, today) {
    if (!task.start || !task.end) return 'future';
    var end = dateOnly(task.end);
    if (end < today) return 'finish';
    var start = dateOnly(task.start);
    if (start <= today && today <= end) return 'going';
    return 'future';
  }
  /* 「8.1至8.25」/ 当日点「9.5」 */
  function rangeCN(t) {
    if (!t.start) return '';
    var s = fmtMD(t.start);
    if (t.point || t.milestone) return s;
    return s + '至' + fmtMD(t.end);
  }
  /* 任务显示名：gantt.md 的任务名已内嵌「(8.1至8.25)」等日期时直接使用，
     未内嵌时自动补「（8.1至8.25）」 */
  function displayName(t) {
    var n = t.name || '';
    if (/\)\s*$/.test(n)) return n;
    return n + '（' + rangeCN(t) + '）';
  }
  /* 左列副行：完整 Y-M-D 便于核对年份 */
  function ymdRange(t) {
    if (!t.start) return '';
    if (t.point || t.milestone) return fmtYMD(t.start);
    return fmtYMD(t.start) + ' → ' + fmtYMD(t.end);
  }

  /* ---------- 主挂载 ---------- */
  function mount(container, ganttCode, eventsData) {
    if (!container) return null;
    eventsData = eventsData || {};

    var model = Parser.parse ? Parser.parse(ganttCode) : null;
    if (!model || !model.range) {
      container.innerHTML = '';
      var errEl = el('div', 'gv-err');
      errEl.textContent = '⚠ 未能解析出有效甘特图数据。\n请检查代码是否以 "gantt" 开头、任务是否含有效日期 YYYY-MM-DD。\n\n' +
        ((model && model.warnings) ? model.warnings.join('\n') : '');
      container.appendChild(errEl);
      return null;
    }

    var styleEl = el('style'); styleEl.textContent = CSS;
    var root = el('div', 'gv-root');
    container.appendChild(styleEl);
    container.appendChild(root);

    /* ---- 今日（本地日期：今日线随打开当天自动更新） ---- */
    var today = dateOnly(new Date());

    var minDate = dateOnly(model.range.start);
    var maxDate = dateOnly(model.range.end);
    var totalDays = diffDays(minDate, maxDate) + 1;
    var hasTodayInRange = (today >= minDate && today <= maxDate);

    /* 全部任务 */
    var tasksAll = model.all;

    /* ---- 骨架 ---- */
    root.innerHTML =
      '<div class="gv-toolbar">' +
      '  <button class="gv-tbtn" data-act="zoomout" title="缩小">－ 缩小</button>' +
      '  <button class="gv-tbtn" data-act="zoomin" title="放大">＋ 放大</button>' +
      '  <span style="width:2px;height:16px;background:#e5e7eb;display:inline-block"></span>' +
      '  <button class="gv-tbtn" data-act="prevYear" title="上一学年">‹‹ 上年</button>' +
      '  <button class="gv-tbtn" data-act="prevMonth" title="上一月">‹ 上月</button>' +
      '  <span class="gv-range"><b id="gv-cen">—</b></span>' +
      '  <button class="gv-tbtn" data-act="nextMonth" title="下一月">下月 ›</button>' +
      '  <button class="gv-tbtn" data-act="nextYear" title="下一学年">下年 ››</button>' +
      '  <span style="width:2px;height:16px;background:#e5e7eb;display:inline-block"></span>' +
      '  <button class="gv-tbtn primary" data-act="today" title="回到今天">📍 回到今天</button>' +
      '</div>' +
      '<div class="gv-legend" id="gv-legend"></div>' +
      '<div class="gv-body" id="gv-body">' +
      '  <div class="gv-labels" id="gv-labels">' +
      '    <div class="gv-lhead">' +
      '      <button class="gv-chev" id="gv-ltoggle" title="展开事件列表">☰</button>' +
      '      <span class="gv-lttl">事件列表</span><span class="cnt" id="gv-lcnt"></span>' +
      '      <span style="flex:1"></span>' +
      '    </div>' +
      '    <div class="gv-lbox" id="gv-lbox"></div>' +
      '  </div>' +
      '  <div class="gv-scroll" id="gv-scroll"><svg id="gv-svg"></svg></div>' +
      '</div>';

    var toolbar = root.querySelector('.gv-toolbar');
    var rangeEl = root.querySelector('#gv-cen');
    var bodyEl = root.querySelector('#gv-body');
    var labelsEl = root.querySelector('#gv-labels');
    var lboxEl = root.querySelector('#gv-lbox');
    var ltoggleEl = root.querySelector('#gv-ltoggle');
    var lcntEl = root.querySelector('#gv-lcnt');
    var scrollEl = root.querySelector('#gv-scroll');
    var svgEl = root.querySelector('#gv-svg');
    var legendEl = root.querySelector('#gv-legend');

    /* 解析告警 */
    if (model.warnings && model.warnings.length) {
      var warnEl = el('div', 'gv-warn', '⚠ 解析提示（不阻塞渲染，可忽略或修正语法）：\n' + esc(model.warnings.slice(0, 6).join('\n')));
      root.insertBefore(warnEl, toolbar.nextSibling || null);
    }

    /* ---- 图例 ---- */
    legendEl.innerHTML =
      '<span><i class="today"></i>今日线(随打开日期自动更新)</span>' +
      '<span><i style="background:#cbd5e1"></i>已完成</span>' +
      '<span><i style="background:#2563eb"></i>进行中/已到</span>' +
      '<span><i style="background:#93c5fd"></i>未来任务</span>' +
      '<span><i style="background:#fca5a5"></i>关键节点(crit)</span>' +
      '<span><i class="dia" style="background:#8b5cf6"></i>里程碑/当日</span>' +
      '<span class="hint">🖱 点任务条或左侧名称 → 看班务详情</span>';

    /* ---- 左侧事件索引（每任务一项；点击=详情+定位高亮） ---- */
    var secOfTask = {};
    model.sections.forEach(function (sec) {
      sec.tasks.forEach(function (t) { secOfTask[t.id] = sec; });
    });
    var labelRowByTask = {};
    function buildLabelList() {
      lboxEl.innerHTML = '';
      labelRowByTask = {};
      model.sections.forEach(function (sec) {
        var secHead = el('div', 'gv-lsec', esc(sec.name) + '（' + sec.tasks.length + '）');
        lboxEl.appendChild(secHead);
        sec.tasks.forEach(function (t) {
          var dot = '';
          if (eventsData[t.id]) dot = '<span class="dot">📌</span>';
          else if (t.milestone || t.point) dot = '<span class="dot">◆</span>';
          var cell = el('div', 'gv-lname',
            dot +
            '<span class="nm"><b>' + esc(t.name) + '</b>' +
            '<span class="dt">' + esc(ymdRange(t)) + '</span></span>');
          cell.addEventListener('click', function () { openDetail(t, true); });
          lboxEl.appendChild(cell);
          labelRowByTask[t.id] = cell;
        });
      });
      lcntEl.textContent = tasksAll.length;
    }
    buildLabelList();

    /* 左列折叠（默认折叠） */
    function setLabelsCollapsed(collapsed) {
      labelsEl.classList.toggle('collapsed', collapsed);
      ltoggleEl.textContent = collapsed ? '☰' : '◀';
      ltoggleEl.title = collapsed ? '展开事件列表' : '折叠事件列表';
    }
    ltoggleEl.addEventListener('click', function () {
      setLabelsCollapsed(!labelsEl.classList.contains('collapsed'));
    });
    setLabelsCollapsed(true);

    /* ---- 视图状态 ---- */
    var LEFT_PAD = 12, RIGHT_PAD = 30;
    var AXIS_H = 26;
    var isMobile = window.innerWidth <= 700;
    var isLand = window.innerWidth > window.innerHeight && window.innerWidth <= 1024 && window.innerHeight <= 760;
    var viewDays = isLand ? 90 : (isMobile ? 80 : 110); // 视口覆盖天数
    var MIN_VIEW = 10, MAX_VIEW = Math.max(totalDays * 1.02, 400);

    function pw() { return Math.max(scrollEl.clientWidth, 200); }
    function pxPerDay() { return pw() / viewDays; }

    /* 每帧轨道分配：按像素区间贪心，重叠者落到下一轨道（多任务可同一行） */
    function computeTracks() {
      var px = pxPerDay();
      var sorted = tasksAll.slice().sort(function (a, b) { return a.start - b.start || a.end - b.end; });
      var ends = [];
      var trackOf = {};
      sorted.forEach(function (t) {
        var x1 = LEFT_PAD + diffDays(minDate, t.start) * px;
        var x2 = LEFT_PAD + diffDays(minDate, t.end) * px + px;
        var placed = -1;
        for (var k = 0; k < ends.length; k++) {
          if (ends[k] <= x1 - 2) { placed = k; break; }
        }
        if (placed < 0) { placed = ends.length; ends.push(0); }
        ends[placed] = Math.max(ends[placed], x2);
        trackOf[t.id] = placed;
      });
      return { trackOf: trackOf, trackCount: Math.max(ends.length, 1) };
    }

    function computeRowH(trackCount) {
      var cap;
      if (isLand) {
        /* 旋转后行方向变视觉横向：一屏尽量放下所有轨道 */
        cap = Math.max(window.innerHeight - 30, 150);
        return clamp(Math.floor((cap - AXIS_H) / trackCount), 12, 60);
      }
      if (isMobile) {
        /* 竖屏手机：行数少则行高放大，让图尽量占满屏高（9:16 沉浸式） */
        cap = Math.max(window.innerHeight * 0.6, 400);
        return clamp(Math.floor((cap - AXIS_H) / trackCount), 20, 68);
      }
      /* 桌面：总高趋于稳定，行数与行高成反比 */
      cap = Math.min(window.innerHeight * 0.62, 720);
      return clamp(Math.floor((cap - AXIS_H) / trackCount), 20, 46);
    }

    /* ---- 绘制 ---- */
    var flashId = null;
    function redraw(centerDate) {
      var px = pxPerDay();
      var layout = computeTracks();
      var rowH = computeRowH(layout.trackCount);
      var worldW = Math.max(LEFT_PAD + totalDays * px + RIGHT_PAD, pw());
      var totalH = AXIS_H + layout.trackCount * rowH + 4;
      svgEl.setAttribute('width', worldW);
      svgEl.setAttribute('height', totalH);

      function xOf(d) { return LEFT_PAD + diffDays(minDate, d) * px; }
      function yOfTrack(k) { return AXIS_H + k * rowH; }

      var S = '';

      /* 月份网格 + 轴标签 */
      S += '<g>';
      var m0 = new Date(minDate.getFullYear(), minDate.getMonth(), 1);
      var lastLabelX = -999;
      for (var mm = new Date(m0); mm <= maxDate; mm = addMonths(mm, 1)) {
        if (mm > maxDate) break;
        var xm = xOf(mm);
        var isJan = mm.getMonth() === 0;
        var isFirst = (mm.getTime() === m0.getTime());
        S += '<line x1="' + xm.toFixed(1) + '" y1="' + AXIS_H + '" x2="' + xm.toFixed(1) + '" y2="' + totalH + '" stroke="#eef1f6" stroke-width="' + (isJan ? 1.5 : 1) + '"/>';
        if (xm - lastLabelX >= 46 || isFirst) {
          var lab = isFirst ? (mm.getFullYear() + '年' + (mm.getMonth() + 1) + '月') : (isJan ? String(mm.getFullYear()) + '年' : (mm.getMonth() + 1) + '月');
          var anchor = (xm < 30) ? 'start' : ((worldW - xm < 30) ? 'end' : 'middle');
          S += '<text x="' + xm.toFixed(1) + '" y="' + (AXIS_H - 7) + '" text-anchor="' + anchor + '" font-size="10" fill="#64748b">' + lab + '</text>';
          lastLabelX = xm;
        }
      }
      /* 轨道分隔线 */
      for (var kk = 1; kk < layout.trackCount; kk++) {
        var yy = yOfTrack(kk);
        S += '<line x1="' + LEFT_PAD + '" y1="' + yy + '" x2="' + worldW + '" y2="' + yy + '" stroke="#f2f5fa" stroke-width="1"/>';
      }
      S += '</g>';

      /* 今日竖线 */
      if (hasTodayInRange) {
        var tx = xOf(today);
        S += '<g><line x1="' + tx.toFixed(1) + '" y1="' + AXIS_H + '" x2="' + tx.toFixed(1) + '" y2="' + totalH + '" stroke="#ef4444" stroke-width="2.2" opacity=".95"/>' +
          '<text x="' + (tx + 6).toFixed(1) + '" y="' + (AXIS_H - 7) + '" font-size="10.5" font-weight="700" fill="#ef4444">今日</text></g>';
      }

      /* 里程碑/当日点标签防重叠 */
      var labelUsed = [];
      function rectOverlaps(l, r) {
        for (var i = 0; i < labelUsed.length; i++) {
          if (r > labelUsed[i][0] && l < labelUsed[i][1]) return true;
        }
        return false;
      }
      function addLabelSpan(l, r) { labelUsed.push([l, r]); }

      /* 任务条 */
      tasksAll.forEach(function (t) {
        var st = statusOf(t, today);
        var x1 = xOf(t.start), x2 = xOf(t.end);
        var k = layout.trackOf[t.id];
        var cy = yOfTrack(k) + rowH / 2;
        var id = esc(t.id || '');
        var isFlash = (flashId === t.id);
        var flashCls = isFlash ? ' gv-flash' : '';
        var hBar = Math.max(10, Math.min(16, rowH * 0.5));

        /* 里程碑 / 当日点 */
        if (t.point || t.milestone) {
          var col = (st === 'finish') ? '#9ca3af' : (t.crit ? '#ef4444' : '#8b5cf6');
          var sz = Math.min(6.5, rowH * 0.22 + 3);
          S += '<g class="gv-bar' + flashCls + '" data-id="' + id + '"><title>' + esc(displayName(t)) + '</title>' +
            '<path d="M' + x1.toFixed(1) + ',' + (cy - sz).toFixed(1) + ' L' + (x1 + sz).toFixed(1) + ',' + cy.toFixed(1) + ' L' + x1.toFixed(1) + ',' + (cy + sz).toFixed(1) + ' L' + (x1 - sz).toFixed(1) + ',' + cy.toFixed(1) + ' Z" fill="' + col + '" stroke="' + (isFlash ? '#f59e0b' : 'rgba(0,0,0,.15)') + '" stroke-width="' + (isFlash ? 2.5 : 1) + '"/></g>';
          /* 节点旁标签（仅在空白处且不重叠） */
          var labTxt = truncateText(displayName(t), 15);
          var labW = labTxt.length * 6.4;
          var l1 = x1 + sz + 5, r1 = l1 + labW + 4;
          var useRight = (r1 < worldW - RIGHT_PAD && !rectOverlaps(l1, r1));
          if (useRight) {
            S += '<text x="' + l1.toFixed(1) + '" y="' + (cy + 3.5).toFixed(1) + '" font-size="10" fill="#6b7280">' + esc(truncateText(labTxt, 15)) + '</text>';
            addLabelSpan(l1, r1);
          } else {
            var l2 = x1 - sz - 5 - labW - 4, r2 = x1 - sz - 5;
            if (l2 > LEFT_PAD && !rectOverlaps(l2, r2)) {
              S += '<text x="' + (x1 - sz - 5).toFixed(1) + '" y="' + (cy + 3.5).toFixed(1) + '" text-anchor="end" font-size="10" fill="#6b7280">' + esc(truncateText(labTxt, 15)) + '</text>';
              addLabelSpan(l2, r2);
            }
          }
          return;
        }

        /* 普通条 */
        var barFill, barStroke;
        if (st === 'finish') { barFill = '#cbd5e1'; barStroke = '#94a3b8'; }
        else if (st === 'going') { barFill = t.crit ? '#f87171' : '#2563eb'; barStroke = t.crit ? '#dc2626' : '#1d4ed8'; }
        else { barFill = t.crit ? '#fca5a5' : '#93c5fd'; barStroke = t.crit ? '#dc2626' : '#60a5fa'; }
        var w = Math.max(x2 - x1 + px, 3);
        var barY = cy - hBar / 2;
        S += '<g class="gv-bar' + flashCls + '" data-id="' + id + '"><title>' + esc(displayName(t)) + '</title>' +
          '<rect x="' + x1.toFixed(1) + '" y="' + barY.toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + hBar.toFixed(1) + '" rx="' + Math.min(5, hBar / 2) + '" fill="' + barFill + '" stroke="' + (isFlash ? '#f59e0b' : barStroke) + '" stroke-width="' + (isFlash ? 2.5 : 1) + '"/></g>';

        /* 条内文字分级：宽 > 150 → 「任务名（已含日期则不再补）」；宽 > 48 → 仅日期 */
        var tcDark = '#1e3a8a', tcLight = '#fff', tcGray = '#334155';
        var inDark = (barFill === '#2563eb' || barFill === '#f87171');
        var tc = inDark ? tcLight : (barFill === '#cbd5e1' ? tcGray : tcDark);
        if (w > 150) {
          var maxC = Math.max(8, Math.floor((w - 14) / 6.2));
          var shown = truncateText(displayName(t), maxC);
          if (shown.length * 6.2 < w - 12) {
            S += '<text x="' + (x1 + w / 2).toFixed(1) + '" y="' + (cy + 3.8).toFixed(1) + '" text-anchor="middle" font-size="11" font-weight="600" fill="' + tc + '">' + esc(shown) + '</text>';
          }
        } else if (w > 48) {
          var dt = rangeCN(t);
          if (dt.length * 6.2 < w - 8) {
            S += '<text x="' + (x1 + w / 2).toFixed(1) + '" y="' + (cy + 3.8).toFixed(1) + '" text-anchor="middle" font-size="10" font-weight="600" fill="' + tc + '">' + esc(dt) + '</text>';
          }
        }
      });
      svgEl.innerHTML = S;

      /* 事件委托（点击条/菱形） */
      svgEl.onclick = function (ev) {
        var g = ev.target && ev.target.closest ? ev.target.closest('.gv-bar') : null;
        if (!g || !g.dataset.id) return;
        var t = model.byId ? model.byId(g.dataset.id) : null;
        if (t) openDetail(t, false);
      };

      if (centerDate) scrollToCenter(centerDate);
      updateRange();
    }

    function scrollToCenter(cd) {
      var px = pxPerDay();
      var max = Math.max(parseFloat(svgEl.getAttribute('width')) - pw(), 0);
      var sl = (LEFT_PAD + diffDays(minDate, cd) * px) - pw() * 0.38;
      if (sl < 0) sl = 0;
      if (sl > max) sl = max;
      scrollEl.scrollLeft = sl;
    }

    function centerDate() {
      var px = pxPerDay();
      var max = Math.max(parseFloat(svgEl.getAttribute('width')) - pw(), 0);
      var sl = Math.min(Math.max(scrollEl.scrollLeft, 0), max);
      return addDays(minDate, (sl + pw() * 0.5 - LEFT_PAD) / px);
    }

    function updateRange() {
      var c = centerDate();
      var half = viewDays / 2;
      var f = new Date(Math.max(minDate, addDays(c, -half)));
      var t = new Date(Math.min(maxDate, addDays(c, half)));
      rangeEl.innerHTML = f.getFullYear() + '年' + (f.getMonth() + 1) + '月' +
        ' ~ ' + t.getFullYear() + '年' + (t.getMonth() + 1) + '月';
      legendEl.querySelectorAll('.gv-todaytag').forEach(function (e) { e.remove(); });
      var tt = el('span', 'gv-todaytag');
      tt.style.cssText = 'color:#ef4444;font-size:11.5px';
      tt.textContent = '（今日 ' + fmtCN(today) + '）';
      legendEl.appendChild(tt);
    }

    /* ---- 工具条 ---- */
    toolbar.addEventListener('click', function (ev) {
      var b = ev.target && ev.target.closest ? ev.target.closest('[data-act]') : null;
      if (!b) return;
      var act = b.dataset.act;
      var c = centerDate();
      var target = null, newDays = null;
      switch (act) {
        case 'zoomin':  newDays = viewDays / 1.7; target = c; break;
        case 'zoomout': newDays = viewDays * 1.7; target = c; break;
        case 'today':
          target = hasTodayInRange ? new Date(today) : (today > maxDate ? new Date(maxDate) : new Date(minDate));
          newDays = Math.min(viewDays, 110);
          break;
        case 'prevYear':
          newDays = Math.min(Math.max(viewDays, 90), 400);
          target = new Date(c.getFullYear() - 1, c.getMonth(), 15);
          break;
        case 'nextYear':
          newDays = Math.min(Math.max(viewDays, 90), 400);
          target = new Date(c.getFullYear() + 1, c.getMonth(), 15);
          break;
        case 'prevMonth':
          newDays = viewDays > 60 ? 45 : viewDays;
          target = new Date(c.getFullYear(), c.getMonth() - 1, 15);
          break;
        case 'nextMonth':
          newDays = viewDays > 60 ? 45 : viewDays;
          target = new Date(c.getFullYear(), c.getMonth() + 1, 15);
          break;
      }
      if (target) {
        if (target < minDate) target = new Date(minDate);
        if (target > maxDate) target = new Date(maxDate);
        viewDays = clamp(newDays != null ? newDays : viewDays, MIN_VIEW, MAX_VIEW);
        redraw(target);
      }
    });

    /* 滚动时刷新范围指示 */
    var scTimer = null;
    scrollEl.addEventListener('scroll', function () {
      if (scTimer) clearTimeout(scTimer);
      scTimer = setTimeout(updateRange, 150);
    });

    /* ---- 模式检测与自适应 ---- */
    function applyMode() {
      var W = window.innerWidth, H = window.innerHeight;
      var nextMobile = W <= 700;
      var nextLand = (W > H) && W <= 1024 && H <= 760;
      if (nextMobile !== isMobile || nextLand !== isLand) {
        isMobile = nextMobile;
        isLand = nextLand;
        root.classList.toggle('gv-land', isLand);
        var want = isLand ? 90 : (isMobile ? 80 : 110);
        if (Math.abs(viewDays - want) > 5) viewDays = want;
        redraw(centerDate());
        if (isLand) setLabelsCollapsed(true);
      }
    }
    window.addEventListener('resize', function () {
      applyMode();
      redraw(centerDate());
    });

    /* ---- 手机横屏旋转后：纵向滑动/滚轮 → 时间滚动 ---- */
    var lastTouchY = null;
    scrollEl.addEventListener('touchstart', function (e) {
      if (isLand && e.touches && e.touches.length === 1) {
        lastTouchY = e.touches[0].clientY;
        e.preventDefault();
      }
    }, { passive: false });
    scrollEl.addEventListener('touchmove', function (e) {
      if (isLand && e.touches && e.touches.length === 1) {
        if (lastTouchY == null) lastTouchY = e.touches[0].clientY;
        var dy = e.touches[0].clientY - lastTouchY;
        lastTouchY = e.touches[0].clientY;
        scrollEl.scrollLeft -= dy;   /* 旋转后视觉：手指下移=时间向未来（内容跟随） */
        e.preventDefault();
      }
    }, { passive: false });
    scrollEl.addEventListener('touchend', function () { lastTouchY = null; });
    scrollEl.addEventListener('wheel', function (e) {
      if (!isLand) return;
      e.preventDefault();
      scrollEl.scrollLeft += e.deltaY;   /* 滚轮向下=时间向后 */
    }, { passive: false });

    /* 键盘左右（桌面） */
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      var tag = document.activeElement && document.activeElement.tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT') return;
      var dx = e.key === 'ArrowLeft' ? -pw() * 0.7 : pw() * 0.7;
      scrollEl.scrollBy({ left: dx, behavior: 'smooth' });
    });

    /* ---- 详情抽屉 ---- */
    var mask = null, drawer = null;
    function flashTask(id) {
      flashId = id;
      redraw(centerDate());
      setTimeout(function () {
        if (flashId === id) { flashId = null; redraw(centerDate()); }
      }, 2600);
    }
    function openDetail(task, fromLabel) {
      var ev = eventsData[task.id] || null;
      var sec = secOfTask[task.id] || { name: '' };
      /* 点击左侧：弹窗 + 自动定位到事件日期 + 高亮 */
      if (fromLabel) {
        scrollToCenter(task.start);
        flashTask(task.id);
        Object.keys(labelRowByTask).forEach(function (id) { labelRowByTask[id].classList.remove('active'); });
        if (labelRowByTask[task.id]) labelRowByTask[task.id].classList.add('active');
      }
      if (!mask) {
        mask = el('div', 'gv-mask');
        drawer = el('div', 'gv-drawer');
        document.body.appendChild(mask);
        document.body.appendChild(drawer);
        mask.addEventListener('click', closeDetail);
      }
      var st = statusOf(task, today);
      var chips =
        '<span class="gv-chip c4">' + esc(sec.name) + '</span>' +
        (task.milestone || task.point ? '<span class="gv-chip c1">◆ 里程碑/当日</span>' : '') +
        (task.crit ? '<span class="gv-chip c3">关键节点</span>' : '') +
        (ev ? '<span class="gv-chip c2">📌 班级事务</span>' : '') +
        (String(task.name).indexOf('推测') >= 0 ? '<span class="gv-chip c1">日期为推测</span>' : '') +
        '<span class="gv-chip c4">' + (st === 'finish' ? '✓ 已过' : (st === 'going' ? '● 已到/进行' : '○ 未开始')) + '</span>';
      var timeRange = fmtYMD(task.start) + ' → ' + fmtYMD(task.end) + ((task.point || task.milestone) ? '（当日）' : '');

      var body = '';
      function row(k, v) { return '<div class="gv-drow"><span class="k">' + k + '</span><span class="v">' + v + '</span></div>'; }
      if (ev) {
        var kvs = [
          ['面向对象', ev.who], ['关键时间', ev.when], ['地点', ev.where], ['文件/材料', ev.files]
        ];
        kvs.forEach(function (p) { if (p[1]) body += row(p[0], esc(p[1])); });
        if (ev.steps && ev.steps.length) {
          body += row('执行步骤', '<ul class="gv-steps">' + ev.steps.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>');
        }
        if (ev.tips && ev.tips !== '—') body += row('提醒', esc(ev.tips));
        if (ev.owners && ev.owners.length) {
          body += row('负责班委', ev.owners.map(function (o) {
            return '<span class="gv-owner">' + esc(o.name) + (o.role ? '（' + esc(o.role) + '）' : '') + '</span>';
          }).join(''));
        }
        body += row('信息源', '班级通知「班群通知表」2026-09-03');
      } else {
        body += row('所在阶段', esc(sec.name));
        body += row('时间范围', timeRange);
        body += row('说明', (String(task.name).indexOf('推测') >= 0 || String(sec.name).indexOf('推测') >= 0)
          ? '2027-2028 学年校历尚未发布，此节点日期为按往年规律推算，请以学校正式通知为准。'
          : '非班务执行项。带 📌 的班级事务可点开查看面向同学的执行说明。');
      }

      drawer.innerHTML =
        '<div class="grab"></div><button class="gv-close" aria-label="关闭">✕</button>' +
        '<div class="gv-dhead">' + esc(ev ? ev.short : task.name) + '</div>' +
        '<div class="gv-dsub">' + chips + '<br>' + timeRange + '</div>' + body;
      drawer.querySelector('.gv-close').addEventListener('click', closeDetail);
      mask.classList.add('on');
      drawer.classList.add('on');
      document.body.style.overflow = 'hidden';
    }
    function closeDetail() {
      if (!drawer) return;
      mask.classList.remove('on');
      drawer.classList.remove('on');
      document.body.style.overflow = '';
    }

    /* 首次定位：今日（今日超出图范围则定位到数据末端） */
    root.classList.toggle('gv-land', isLand);
    var bootCenter = hasTodayInRange ? new Date(today) : (today > maxDate ? new Date(maxDate) : new Date(minDate));
    redraw(bootCenter);

    return {
      destroy: function () {
        if (mask) { mask.remove(); drawer.remove(); }
        container.removeChild(root);
        container.removeChild(styleEl);
      },
      goToday: function () { toolbar.querySelector('[data-act="today"]').click(); },
      toggleLabels: function () { setLabelsCollapsed(!labelsEl.classList.contains('collapsed')); }
    };
  }

  return { mount: mount };
});
