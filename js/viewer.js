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
 *  9) 桌面 Ctrl+滚轮 缩放显示日期范围（夹紧在数据全跨度内）
 * 10) 时间轴天刻度：逐日细网格 + 【每一天】数字刻度（随缩放自动取舍）
 * 11) 事件按序号错色配色（已完成统一灰）；条内/点旁标注「名称(日期)」防重叠；
 *     条内放不下时自动降级并条尾外置（强制显示标题）
 * 12) 视图切换：常规视图 ⇄ 向右旋转90° 横屏视图（右上角按钮手动切换；手机横屏仍自动）
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
/* ---- 手机横屏（landscape）：整页由 index.html 向右旋转 90°（header/甘特图/footer 整体旋转）。
       此处只做布局微调：左列高度收紧；.gv-scroll 保留原生横向滚动（时间轴），但不再拦截触摸事件，
       与页面共享手势——纵向拖拽自然冒泡到 body 翻页，横向拖拽滚时间轴（浏览器自动分工） ---- */
.gv-land .gv-toolbar{position:static}
.gv-land .gv-body{position:relative;overflow:hidden}
.gv-land .gv-labels{max-height:calc(100vh - 6px)}
.gv-land .gv-labels.collapsed{width:34px}
.gv-land .gv-scroll{overflow-x:auto;overflow-y:hidden;overscroll-behavior-x:contain;-webkit-overflow-scrolling:touch;touch-action:auto}
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
  /* 事件错色色板：[0]=实色(已到/进行,白字) [1]=浅色(未开始,深字) [2]=墨色(描边/浅底文字)；
     已完成任务统一灰色。序号步长 5 循环 → 相邻事件颜色差异大，便于区分 */
  var PAL = [
    ['#1d4ed8', '#bfdbfe', '#1e40af'],
    ['#7c3aed', '#ddd6fe', '#6d28d9'],
    ['#0e7490', '#a5f3fc', '#155e75'],
    ['#047857', '#a7f3d0', '#065f46'],
    ['#b45309', '#fde68a', '#92400e'],
    ['#be185d', '#fbcfe8', '#9d174d'],
    ['#4338ca', '#c7d2fe', '#3730a3'],
    ['#0f766e', '#99f6e4', '#115e59'],
    ['#c2410c', '#fed7aa', '#9a3412'],
    ['#4d7c0f', '#d9f99d', '#3f6212'],
    ['#9f1239', '#fecdd3', '#881337'],
    ['#0c4a6e', '#bae6fd', '#075985']
  ];
  /* 名称是否已自带括号日期注记（半/全角括号均可，括号内含 "9.5"/"8.1至8.25" 类点号日期） */
  function hasOwnDateNote(n) {
    var i = String(n).search(/[(\uFF08]/);
    if (i < 0) return false;
    return /\d{1,2}\s*[.\uFF0E]\s*\d{1,2}/.test(String(n).slice(i));
  }
  /* 图表完整标题：原名已带日期注记 → 原样；否则自动补「（s至e）」，保证每条呈现 名称(日期) 形态 */
  function captionOf(t) {
    var n = t.name || '';
    if (hasOwnDateNote(n)) return n;
    var r = rangeCN(t);
    return r ? n + '（' + r + '）' : n;
  }
  /* 估算文本像素宽（CJK≈字号，ASCII≈0.55 字号） */
  function estW(txt, fs) {
    var w = 0;
    for (var i = 0; i < txt.length; i++) {
      w += (txt.charCodeAt(i) >= 0x2E80) ? fs : fs * 0.55;
    }
    return w;
  }
  /* 条/节点内标注重排：优先保留括号日期注记，只截断头部名称（防文字重叠遮盖）。
     注：超长注记（如「新生体检(9.5至9.7工作时间,交体检表至9.7)」）整体优先采用，
     实在放不下再降级为纯日期「(9.5至9.7)」，仍放不下才返回空（由调用方外置） */
  function shortCaption(t, limit, fs) {
    var n = t.name || '';
    var i = String(n).search(/[(\uFF08]/);
    var head = (i < 0 ? n : n.slice(0, i)).trim();
    var tail = '';
    if (i >= 0 && hasOwnDateNote(n)) tail = n.slice(i);
    else {
      var r = rangeCN(t);
      if (r) tail = '（' + r + '）';
    }
    if (!head && !tail) return '';
    var wTail = estW(tail, fs);
    if (wTail > limit - 2) {
      /* 降级：注记过长 → 只保留日期「(9.5至9.7)」或当日「9.5」 */
      var r2 = rangeCN(t);
      var tail2 = '';
      if (t.point || t.milestone) tail2 = r2 ? r2 : '';
      else tail2 = r2 ? '（' + r2 + '）' : '';
      var wTail2 = tail2 ? estW(tail2, fs) : 0;
      if (wTail2 <= limit - 2) { tail = tail2; wTail = wTail2; }
      else return '';   /* 纯日期也放不下 → 交调用方外置/放弃 */
    }
    var out = '', w = 0, maxH = limit - 2 - wTail;
    for (var k = 0; k < head.length; k++) {
      var cw = (head.charCodeAt(k) >= 0x2E80) ? fs : fs * 0.55;
      if (w + cw > maxH) { if (out) out += '…'; break; }
      w += cw; out += head[k];
    }
    return (out + tail).trim();
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

    /* 整页向右旋转 90° 回调（index.html 挂载，applyMode/reportLand 共用同一变量） */
    var onLand = null;

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
      '<span><i class="today"></i>今日线(随打开自动更新)</span>' +
      '<span><i style="background:#cbd5e1"></i>已完成</span>' +
      '<span><i style="background:#1d4ed8"></i><i style="background:#7c3aed"></i><i style="background:#047857"></i><i style="background:#b45309"></i>不同事件/节点错色区分</span>' +
      '<span><i class="dia" style="background:#7c3aed"></i>里程碑/当日</span>' +
      '<span><i style="border:1.5px dashed #dc2626;background:transparent;height:4px;width:16px;border-radius:2px"></i>关键节点(红圈)</span>' +
      '<span class="hint">🖱 点条/◆/左侧名 → 班务详情 · 桌面 Ctrl+滚轮缩放</span>';

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
    var autoLand = window.innerWidth > window.innerHeight && window.innerWidth <= 1024 && window.innerHeight <= 760;
    /* 手动视图覆盖：null=自动（桌面常规/手机横屏自动旋转）；'land'=强制向右旋转90°；'normal'=强制常规 */
    var viewOverride = null;
    function effLand() { return viewOverride === 'land' ? true : (viewOverride === 'normal' ? false : autoLand); }
    var isLand = effLand();
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
      /* 彩虹外框渐变（红橙黄绿青蓝紫），用于「开始日在今天±3天内且未结束」的事件/节点 */
      S += '<defs><linearGradient id="gv-rainbow" x1="0" y1="0" x2="1" y2="0">' +
        '<stop offset="0" stop-color="#ff4d4f"/><stop offset=".17" stop-color="#ff9f43"/>' +
        '<stop offset=".33" stop-color="#ffd93d"/><stop offset=".5" stop-color="#46c35f"/>' +
        '<stop offset=".67" stop-color="#2f9bff"/><stop offset=".83" stop-color="#7b5cff"/>' +
        '<stop offset="1" stop-color="#d94dff"/></linearGradient></defs>';

      /* 月份网格 + 轴标签 */
      S += '<g>';
      var m0 = new Date(minDate.getFullYear(), minDate.getMonth(), 1);
      var lastLabelX = -999;
      var monthLabelXs = [];
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
          monthLabelXs.push(xm);
          lastLabelX = xm;
        }
      }
      /* 天刻度：逐日细网格 + 【每一天】数字刻度（px 足够时全部显示，随缩放自动取舍；避开月份/今日文字） */
      var todayX = hasTodayInRange ? xOf(today) : -9999;
      if (px >= 6) {
        for (var di = 0; di <= totalDays; di++) {
          var ddx = LEFT_PAD + di * px;
          S += '<line x1="' + ddx.toFixed(1) + '" y1="' + AXIS_H + '" x2="' + ddx.toFixed(1) + '" y2="' + totalH + '" stroke="#f6f8fb" stroke-width="1"/>';
        }
        if (px >= 10.5) {
          /* 每一天都显示日期数字（不再只显示奇数天） */
          for (var dj = 0; dj <= totalDays; dj++) {
            var ddt = addDays(minDate, dj);
            var ddx2 = LEFT_PAD + dj * px;
            var tooNear = Math.abs(ddx2 - todayX) < 12;
            for (var mi = 0; !tooNear && mi < monthLabelXs.length; mi++) {
              if (Math.abs(ddx2 - monthLabelXs[mi]) < 10) tooNear = true;
            }
            if (tooNear) continue;
            if (ddx2 < LEFT_PAD + 7 || ddx2 > worldW - RIGHT_PAD - 4) continue;
            S += '<text x="' + ddx2.toFixed(1) + '" y="' + (AXIS_H + 2) + '" text-anchor="middle" font-size="8.5" fill="#9fb0c3">' + ddt.getDate() + '</text>';
          }
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

      /* ================= 绘制事件（两遍：先画条收集占用矩形，再放里程碑与防重叠标注） ================= */
      var barRects = [];    // 已画元素占用 {x1,y1,x2,y2}
      var labelRects = [];  // 已放文字占用（条内文字按整条保守占位）
      function rHit(ax1, ay1, ax2, ay2, bx1, by1, bx2, by2) {
        return ax1 < bx2 && ax2 > bx1 && ay1 < by2 && ay2 > by1;
      }
      /* 序号→配色：已完成 → null(灰)；否则步长 5 循环取色，相邻事件颜色差异大 */
      function palOf(t) {
        if (statusOf(t, today) === 'finish') return null;
        var ord = tasksAll.indexOf(t);
        return PAL[((ord + 1) * 5) % PAL.length];
      }
      /* 彩虹高亮命中：开始日期在「今天±3天」内 且 未结束（finish → 不亮） */
      function isRainbow(t) {
        if (statusOf(t, today) === 'finish') return false;
        var ds = diffDays(today, dateOnly(t.start));
        return ds >= -3 && ds <= 3;
      }

      /* ---- 第一遍：普通时间条 ---- */
      tasksAll.forEach(function (t) {
        if (t.point || t.milestone) return;
        var x1 = xOf(t.start), x2 = xOf(t.end);
        var w = Math.max(x2 - x1 + px, 3);
        var st = statusOf(t, today);
        var k = layout.trackOf[t.id];
        var cy = yOfTrack(k) + rowH / 2;
        var id = esc(t.id || '');
        var isFlash = (flashId === t.id);
        var flashCls = isFlash ? ' gv-flash' : '';
        var hBar = Math.max(10, Math.min(16, rowH * 0.5));
        var p = palOf(t);
        var barFill, barStroke, inText;
        if (!p) { barFill = '#cbd5e1'; barStroke = t.crit ? '#b91c1c' : '#94a3b8'; inText = '#475569'; }
        else if (st === 'going') { barFill = p[0]; barStroke = p[2]; inText = '#fff'; }
        else { barFill = p[1]; barStroke = p[2]; inText = p[2]; }
        if (t.crit && p) barStroke = '#b91c1c';           /* crit：红圈强调 */
        var barY = cy - hBar / 2;
        var rb = isRainbow(t);
        var strokeW = (isFlash ? 2.5 : (t.crit ? 1.8 : 1));
        /* 彩虹命中 → 双层描边：底层同色描边 + 外层 3.5px 彩虹渐变描边+外发光（边缘向外扩展 3.5px） */
        if (rb) {
          var hh = Math.max(hBar + 7, 20);
          S += '<g class="gv-bar gv-rb' + flashCls + '" data-id="' + id + '"><title>' + esc(captionOf(t)) + '</title>' +
            '<rect x="' + (x1 - 1.75).toFixed(1) + '" y="' + (barY - 1.75).toFixed(1) + '" width="' + (w + 3.5).toFixed(1) + '" height="' + hh.toFixed(1) + '" rx="' + Math.min(6, hh / 2) + '" fill="none" stroke="url(#gv-rainbow)" stroke-width="3.5" opacity=".95"/>' +
            '<rect x="' + x1.toFixed(1) + '" y="' + barY.toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + hBar.toFixed(1) + '" rx="' + Math.min(5, hBar / 2) + '" fill="' + barFill + '" stroke="' + barStroke + '" stroke-width="' + strokeW.toFixed(1) + '"/></g>';
          barRects.push({ x1: x1 - 4, y1: barY - 4, x2: x1 + w + 4, y2: barY + hBar + 4 });
        } else {
          S += '<g class="gv-bar' + flashCls + '" data-id="' + id + '"><title>' + esc(captionOf(t)) + '</title>' +
            '<rect x="' + x1.toFixed(1) + '" y="' + barY.toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + hBar.toFixed(1) + '" rx="' + Math.min(5, hBar / 2) + '" fill="' + barFill + '" stroke="' + barStroke + '" stroke-width="' + strokeW.toFixed(1) + '"/></g>';
          barRects.push({ x1: x1, y1: barY, x2: x1 + w, y2: barY + hBar });
        }

        /* 条内文字：统一「名称(日期)」形态 —— 宽条全名、中条截头保尾（尾部日期不可断） */
        var placedInBar = false;
        if (w > 160) {
          var t1 = shortCaption(t, w - 14, 11);
          if (t1) {
            S += '<text x="' + (x1 + w / 2).toFixed(1) + '" y="' + (cy + 3.8).toFixed(1) + '" text-anchor="middle" font-size="11" font-weight="600" fill="' + inText + '">' + esc(t1) + '</text>';
            labelRects.push({ x1: x1 + 3, y1: cy - 9, x2: x1 + w - 3, y2: cy + 6 });
            placedInBar = true;
          }
        } else if (w > 46) {
          var t2 = shortCaption(t, w - 12, 10);
          if (t2) {
            S += '<text x="' + (x1 + w / 2).toFixed(1) + '" y="' + (cy + 3.4).toFixed(1) + '" text-anchor="middle" font-size="10" font-weight="600" fill="' + inText + '">' + esc(t2) + '</text>';
            labelRects.push({ x1: x1 + 3, y1: cy - 8, x2: x1 + w - 3, y2: cy + 5 });
            placedInBar = true;
          }
        } else if (w > 24) {
          /* 很窄条：优先放「名称+日期」缩写，放不下再退「纯日期」 */
          var tn = shortCaption(t, w - 12, 9);
          if (tn && estW(tn, 9) < w - 4) {
            S += '<text x="' + (x1 + w / 2).toFixed(1) + '" y="' + (cy + 3.2).toFixed(1) + '" text-anchor="middle" font-size="9" font-weight="600" fill="' + inText + '">' + esc(tn) + '</text>';
            labelRects.push({ x1: x1 + 2, y1: cy - 8, x2: x1 + w - 2, y2: cy + 5 });
            placedInBar = true;
          } else {
            var dt = rangeCN(t);
            if (dt && estW(dt, 9) < w - 4) {
              S += '<text x="' + (x1 + w / 2).toFixed(1) + '" y="' + (cy + 3.2).toFixed(1) + '" text-anchor="middle" font-size="9" font-weight="600" fill="' + inText + '">' + esc(dt) + '</text>';
              labelRects.push({ x1: x1 + 2, y1: cy - 8, x2: x1 + w - 2, y2: cy + 5 });
              placedInBar = true;
            }
          }
        }
        /* w<=24 或条内放不下：条尾外置「名称(日期)」必显标题 */
        if (!placedInBar) {
          var capOut = shortCaption(t, 999, 9.5);   /* 无限宽限 → 一定产出（含降级日期） */
          if (capOut) placeText(x2 + 2, cy, capOut, 9.5, !p ? '#94a3b8' : p[2], true, true);
        }
      });

      /* ---- 外置文字放置器：右/左/上/下多档试位，撞条或撞字即跳过；
             force=true 时若全档冲突，在本行 ±2 轨空白高度内扫描空位放置，并拉一条同色折线引回事件/节点；
             高密度时标题也必显且不重叠（不再强制重叠硬画）。 ---- */
      function placeText(x, y, txt, fs, col, force, leadTo) {
        var wT = estW(txt, fs);
        var tries = [
          { dx: 5, dy: 0, an: 'start' },
          { dx: -5, dy: 0, an: 'end' },
          { dx: 5, dy: -(rowH * 0.32), an: 'start' },
          { dx: -5, dy: -(rowH * 0.32), an: 'end' },
          { dx: 5, dy: rowH * 0.26, an: 'start' },
          { dx: -5, dy: rowH * 0.26, an: 'end' }
        ];
        function rectHit(ax1, ay1, ax2, ay2) {
          if (ax1 < LEFT_PAD || ax2 > worldW - RIGHT_PAD) return true;
          for (var bi = 0; bi < barRects.length; bi++) {
            var b = barRects[bi];
            if (rHit(ax1 - 2, ay1, ax2 + 2, ay2, b.x1, b.y1, b.x2, b.y2)) return true;
          }
          for (var li = 0; li < labelRects.length; li++) {
            var lr = labelRects[li];
            if (rHit(ax1 - 1, ay1, ax2 + 1, ay2, lr.x1, lr.y1, lr.x2, lr.y2)) return true;
          }
          return false;
        }
        var placed = false, fx = 0, fy = 0, fan = 'start';
        for (var ti = 0; !placed && ti < tries.length; ti++) {
          var tr = tries[ti];
          var bx = (tr.an === 'start') ? (x + tr.dx) : (x + tr.dx - wT);
          var by0 = y + tr.dy;
          if (by0 - 7 < AXIS_H || by0 + 4 > totalH) continue;
          if (bx < LEFT_PAD || bx + wT > worldW - RIGHT_PAD) continue;
          if (!rectHit(bx - 2, by0 - 7, bx + wT + 2, by0 + 4)) {
            placed = true; fx = bx; fy = by0; fan = tr.an; break;
          }
        }
        if (!placed && force) {
          var step = Math.max(5, rowH * 0.22);
          for (var ky = -rowH * 2; ky <= rowH * 2 + 0.01; ky += step) {
            for (var dir = 0; dir < 2 && !placed; dir++) {
              var cand = (dir === 0) ? (x + 5) : (x - 5 - wT);
              var cly = y + ky;
              if (cly - 7 < AXIS_H || cly + 4 > totalH) continue;
              if (cand < LEFT_PAD || cand + wT > worldW - RIGHT_PAD) continue;
              var an2 = (dir === 0) ? 'start' : 'end';
              if (!rectHit(cand - 2, cly - 7, cand + wT + 2, cly + 4)) {
                placed = true; fx = cand; fy = cly; fan = an2;
              }
            }
            if (placed) break;
          }
        }
        if (!placed) return false;

        S += '<text x="' + fx.toFixed(1) + '" y="' + fy.toFixed(1) + '" text-anchor="' + fan + '" font-size="' + fs + '" font-weight="600" fill="' + col + '">' + esc(txt) + '</text>';
        labelRects.push({ x1: (fan === 'start' ? fx : fx), y1: fy - 7, x2: (fan === 'start' ? fx + wT : fx + wT), y2: fy + 4 });

        if (leadTo) {
          var textEdge = (fan === 'start') ? fx : fx + wT;
          var midX = (x + textEdge) / 2;
          S += '<path d="M' + x.toFixed(1) + ',' + y.toFixed(1) +
            ' L' + midX.toFixed(1) + ',' + y.toFixed(1) +
            ' L' + midX.toFixed(1) + ',' + (fy - 1).toFixed(1) +
            ' L' + textEdge.toFixed(1) + ',' + (fy - 1).toFixed(1) +
            '" fill="none" stroke="' + col + '" stroke-width="1.15" opacity=".7"/>';
        }
        return true;
      }

      /* ---- 第二遍：里程碑/当日点（菱形+旁标）与过窄条外置名称标注 ---- */
      tasksAll.forEach(function (t) {
        var x1 = xOf(t.start), x2 = xOf(t.end);
        var k = layout.trackOf[t.id];
        var cy = yOfTrack(k) + rowH / 2;
        var id = esc(t.id || '');
        var isFlash = (flashId === t.id);
        var flashCls = isFlash ? ' gv-flash' : '';
        var st = statusOf(t, today);
        var p = palOf(t);

        if (t.point || t.milestone) {
          var dCol = !p ? '#94a3b8' : ((st === 'going') ? p[0] : p[2]);
          var sz = Math.min(6.5, rowH * 0.22 + 3);
          var rb = isRainbow(t);
          var dStroke = (isFlash ? '#f59e0b' : (t.crit ? '#b91c1c' : '#fff'));
          var dWid = (isFlash ? 2.5 : (t.crit ? 2 : 1));
          var extra = '';
          /* 彩虹命中 → 节点外加一圈同色彩虹渐变描边菱形（扩大 sz+3.5） */
          if (rb) {
            var sz2 = sz + 3.5;
            extra = '<path d="M' + x1.toFixed(1) + ',' + (cy - sz2).toFixed(1) + ' L' + (x1 + sz2).toFixed(1) + ',' + cy.toFixed(1) + ' L' + x1.toFixed(1) + ',' + (cy + sz2).toFixed(1) + ' L' + (x1 - sz2).toFixed(1) + ',' + cy.toFixed(1) + ' Z" fill="none" stroke="url(#gv-rainbow)" stroke-width="3" opacity=".95"/>';
          }
          S += '<g class="gv-bar' + flashCls + '" data-id="' + id + '"><title>' + esc(captionOf(t)) + '</title>' + extra +
            '<path d="M' + x1.toFixed(1) + ',' + (cy - sz).toFixed(1) + ' L' + (x1 + sz).toFixed(1) + ',' + cy.toFixed(1) + ' L' + x1.toFixed(1) + ',' + (cy + sz).toFixed(1) + ' L' + (x1 - sz).toFixed(1) + ',' + cy.toFixed(1) + ' Z" fill="' + dCol + '" stroke="' + dStroke + '" stroke-width="' + dWid + '"/></g>';
          barRects.push({ x1: x1 - sz - 2, y1: cy - sz - 2, x2: x1 + sz + 2, y2: cy + sz + 2 });
          /* 点旁名称标注：「名称(日期)」完整形态，撞条/撞字自动让位；过宽则降级截断，仍强制显示 */
          var capF = captionOf(t);
          if (estW(capF, 10.5) > 260) capF = shortCaption(t, 240, 10.5);
          placeText(x1, cy, capF, 10.5, !p ? '#8b98a9' : p[2], true, true);
          return;
        }
        /* 过窄条（w<=24，已在第一遍放置条尾外置）→ 无需重复 */
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
    /* 整页向右旋转 90° 回调（index.html 挂载）：true=整页旋转；false/null=不旋转 */
    var lastReported = null;
    function reportLand() {
      if (typeof onLand !== 'function') return;
      var v = effLand();
      if (v !== lastReported) { lastReported = v; onLand(v); }
    }
    function applyMode() {
      var W = window.innerWidth, H = window.innerHeight;
      var nextMobile = W <= 700;
      autoLand = (W > H) && W <= 1024 && H <= 760;
      var nextLand = effLand();
      reportLand();
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
    /* 受右上角按钮调用的视图切换：'normal'|'land'|'auto' */
    function setViewMode(mode) {
      viewOverride = (mode === 'normal' || mode === 'land') ? mode : null;
      applyMode();
      redraw(centerDate());
    }
    window.addEventListener('resize', function () {
      applyMode();
      redraw(centerDate());
    });

    /* ---- 滚动交互 ---- */
    /* 注：横屏（整页旋转）不再拦截触摸——纵向拖拽自然冒泡给 html.page-land body 做整页翻页，
       横向拖拽由 .gv-scroll 原生 overflow-x:auto 滚时间轴（浏览器自动分工，无需 JS） */
    scrollEl.addEventListener('wheel', function (e) {
      /* 桌面：Ctrl+滚轮 = 缩放时间范围（以视口中心日期为锚点，夹紧数据全跨度） */
      if (e.ctrlKey) {
        e.preventDefault();
        var factor = Math.exp(e.deltaY * 0.0016);
        var nd = clamp(Math.round(viewDays * factor), MIN_VIEW, MAX_VIEW);
        if (nd !== viewDays) {
          viewDays = nd;
          redraw(centerDate());
        }
        return;
      }
      if (!isLand) return;
      /* 横屏整页旋转：滚轮不再横向转时间，交还页面纵向滚动（整页翻页） */
      return;
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
      toggleLabels: function () { setLabelsCollapsed(!labelsEl.classList.contains('collapsed')); },
      setViewMode: setViewMode,          /* v5：右上角按钮调用（'normal'/'land'/'auto'） */
      getViewMode: function () { return viewOverride || (isLand ? 'land' : 'normal'); },
      onLand: function (fn) { onLand = fn; } /* v6：整页向右旋转 90° 回调（index.html 挂载） */
    };
  }

  return { mount: mount };
});
