/*
 * viewer.js —— 自研交互式甘特渲染器（纯本地、无外部依赖，替代 CDN mermaid）
 *
 * 能力：
 *  1) 解析 gantt.md 中的 mermaid gantt 语法（js/parser.js）
 *  2) 自绘 SVG：今日红色竖线随打开当天自动定位（无需任何定时任务）
 *  3) 工具条：上一/下一学年、上一/下一月、回到今天、放大/缩小（缩放以视口中心日期为锚点）
 *  4) 点击任务条或左侧任务名 → 弹出结构化班务详情（js/events.js，数据=班群通知表）
 *  5) 桌面/手机通用：左侧任务名固定，右侧时间轴横向拖拽/滚动
 *
 * 用法：GanttViewer.mount(containerEl, ganttCode, eventsData)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GanttViewer = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DAY = 86400000;
  /* 注意：本文件处于工厂函数体内，作用域链上并无外层 IIFE 的参数 root，
     必须经由 globalThis 取全局对象（Node 走 module.exports 分支不触达此行）。 */
  var G = (typeof globalThis !== 'undefined') ? globalThis
    : (typeof self !== 'undefined' ? self : this);
  var Parser = (typeof module === 'object' && module.exports)
    ? require('./parser.js')
    : (G.GanttParser || {});

  var CSS = String.raw `
.gv-root{--gv-blue:#2563eb;--gv-ink:#1f2937;--gv-sub:#6b7280;--gv-line:#e5e7eb;
  font-family:"Microsoft YaHei","PingFang SC",system-ui,sans-serif;color:var(--gv-ink)}
.gv-root *{box-sizing:border-box}
.gv-toolbar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;background:#fff;border:1px solid var(--gv-line);
  border-radius:10px;padding:8px;margin:10px 0;position:sticky;top:0;z-index:30;box-shadow:0 2px 6px rgba(15,23,42,.06)}
.gv-tbtn{appearance:none;border:1px solid #dbe3ef;background:#fff;color:#1e3a5f;border-radius:8px;
  padding:5px 9px;font-size:13px;line-height:1.2;cursor:pointer;display:inline-flex;align-items:center;gap:3px;touch-action:manipulation}
.gv-tbtn:hover{background:#eff6ff;border-color:#93c5fd}
.gv-tbtn:active{transform:translateY(1px)}
.gv-tbtn.primary{background:linear-gradient(135deg,#1d4ed8,#3b82f6);color:#fff;border-color:#1d4ed8;font-weight:600}
.gv-tbtn.primary:hover{background:linear-gradient(135deg,#1e40af,#2563eb)}
.gv-range{font-size:12px;color:var(--gv-sub);background:#f1f5f9;border-radius:6px;padding:4px 9px;white-space:nowrap}
.gv-range b{color:#0f4c9c}
.gv-legend{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:11.5px;color:var(--gv-sub);margin:4px 2px 8px}
.gv-legend i{display:inline-block;width:20px;height:3px;border-radius:2px;margin-right:4px;vertical-align:middle}
.gv-legend i.dia{width:8px;height:8px;transform:rotate(45deg);border-radius:1px}
.gv-legend i.today{width:2px;height:11px;background:#ef4444;margin-right:5px}
.gv-legend .hint{margin-left:2px}
.gv-body{display:flex;align-items:flex-start;background:#fff;border:1px solid var(--gv-line);border-radius:10px;overflow:hidden}
.gv-labels{flex:0 0 auto;width:148px;border-right:2px solid #dbe3ef;background:#fff;position:relative;z-index:5}
.gv-scroll{flex:1 1 auto;overflow-x:auto;overflow-y:hidden;-webkit-overflow-scrolling:touch;overscroll-behavior-x:contain}
.gv-scroll svg{display:block}
.gv-sec{background:linear-gradient(90deg,#dfe9ff,#f2f6ff);color:#0f3b8f;font-weight:700;font-size:12px;
  padding:5px 8px;line-height:1.25;cursor:default;border-bottom:1px solid #dbe3ef}
.gv-lname{display:flex;align-items:center;gap:4px;padding:0 7px;cursor:pointer;font-size:11.5px;color:#374151;
  border-bottom:1px solid #f1f5f9;overflow:hidden}
.gv-lname:hover{background:#eaf2ff}
.gv-lname .nm{flex:1 1 auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gv-lname .dot{flex:0 0 auto;font-size:10px}
.gv-err{color:#991b1b;background:#fee2e2;border:1px solid #fca5a5;border-radius:10px;padding:12px 14px;font-size:12.5px;margin:10px 0 0;white-space:pre-wrap}
.gv-warn{color:#92400e;background:#fef3c7;border:1px solid #fcd34d;border-radius:10px;padding:10px 14px;font-size:12.5px;margin:10px 0 0;white-space:pre-wrap}
.gv-bar{cursor:pointer}
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
@media (max-width:560px){ .gv-labels{width:124px}.gv-lname{font-size:11px}.gv-sec{font-size:11px} }
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
  function statusOf(task, today) {
    if (!task.start || !task.end) return 'future';
    var end = dateOnly(task.end);
    if (end < today) return 'finish';
    var start = dateOnly(task.start);
    if (start <= today && today <= end) return 'going';
    return 'future';
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

    /* ---- 行布局（labels 与 svg 共用一套坐标） ---- */
    var AXIS_H = 30, SEC_H = 30, ROW_H = 34;
    var rows = [];            // {kind:'sec'|'task', y, h, task, sec}
    var y = AXIS_H;
    model.sections.forEach(function (sec) {
      rows.push({ kind: 'sec', sec: sec, y: y, h: SEC_H });
      y += SEC_H;
      sec.tasks.forEach(function (t) {
        rows.push({ kind: 'task', task: t, sec: sec, y: y, h: ROW_H });
        y += ROW_H;
      });
    });
    var totalH = y + 2;

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
      '<div class="gv-body">' +
      '  <div class="gv-labels" id="gv-labels"></div>' +
      '  <div class="gv-scroll" id="gv-scroll"><svg id="gv-svg"></svg></div>' +
      '</div>';

    var toolbar = root.querySelector('.gv-toolbar');
    var rangeEl = root.querySelector('#gv-cen');
    var labelsEl = root.querySelector('#gv-labels');
    var scrollEl = root.querySelector('#gv-scroll');
    var svgEl = root.querySelector('#gv-svg');
    var legendEl = root.querySelector('#gv-legend');

    /* 解析告警 */
    if (model.warnings && model.warnings.length) {
      var warnEl = el('div', 'gv-warn', '⚠ 解析提示（不阻塞渲染，可忽略或修正语法）：\n' + esc(model.warnings.slice(0, 6).join('\n')));
      root.insertBefore(warnEl, root.querySelector('.gv-toolbar').nextSibling || null);
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

    /* ---- 左侧任务名列 ---- */
    var secOfTask = {};
    rows.forEach(function (r) { if (r.kind === 'task') secOfTask[r.task.id] = r.sec; });
    var labelRowByTask = {};
    rows.forEach(function (r) {
      var cell;
      if (r.kind === 'sec') {
        cell = el('div', 'gv-sec', esc(r.sec.name) + '（' + r.sec.tasks.length + '）');
      } else {
        var t = r.task;
        var dot = '';
        if (eventsData[t.id]) dot = '<span class="dot" title="班级事务">📌</span>';
        else if (t.milestone || t.point) dot = '<span class="dot" title="里程碑">◆</span>';
        cell = el('div', 'gv-lname', dot + '<span class="nm">' + esc(t.name) + '</span>');
        cell.style.cursor = 'pointer';
        cell.addEventListener('click', function () { openDetail(t); });
        labelRowByTask[t.id] = cell;
      }
      cell.style.height = r.h + 'px';
      labelsEl.appendChild(cell);
    });

    /* ---- 视图状态 ---- */
    var LEFT_PAD = 12, RIGHT_PAD = 30;
    var viewDays = 120;               // 视口覆盖天数（初始约 4 个月）
    var MIN_VIEW = 12, MAX_VIEW = totalDays * 1.04;

    function pw() { return Math.max(scrollEl.clientWidth, 220); }

    /* ---- 绘制 ---- */
    function redraw(centerDate) {
      var plotW = pw();
      var px = plotW / viewDays;
      var worldW = Math.max(LEFT_PAD + totalDays * px + RIGHT_PAD, plotW);
      svgEl.setAttribute('width', worldW);
      svgEl.setAttribute('height', totalH);

      var S = '';
      function xOf(d) { return LEFT_PAD + diffDays(minDate, d) * px; }

      /* 月份网格 + 轴标签 */
      S += '<g>';
      var m0 = new Date(minDate.getFullYear(), minDate.getMonth(), 1);
      var lastLabelX = -999;
      for (var mm = new Date(m0); mm <= maxDate; mm = addMonths(mm, 1)) {
        if (mm > maxDate) break;
        var xm = xOf(mm);
        var isJan = mm.getMonth() === 0;
        var isFirst = (mm.getTime() === m0.getTime());
        S += '<line x1="' + xm.toFixed(1) + '" y1="' + AXIS_H + '" x2="' + xm.toFixed(1) + '" y2="' + totalH + '" stroke="#edf0f4" stroke-width="' + (isJan ? 1.5 : 1) + '"/>';
        if (xm - lastLabelX >= 46 || isFirst) {
          var lab = isFirst ? (mm.getFullYear() + '年' + (mm.getMonth() + 1) + '月') : (isJan ? String(mm.getFullYear()) + '年' : (mm.getMonth() + 1) + '月');
          var anchor = (xm < 30) ? 'start' : ((worldW - xm < 30) ? 'end' : 'middle');
          S += '<text x="' + xm.toFixed(1) + '" y="' + (AXIS_H - 8) + '" text-anchor="' + anchor + '" font-size="10" fill="#64748b">' + lab + '</text>';
          lastLabelX = xm;
        }
      }
      S += '</g>';

      /* 今日竖线 */
      if (hasTodayInRange) {
        var tx = xOf(today);
        S += '<g><line x1="' + tx.toFixed(1) + '" y1="' + AXIS_H + '" x2="' + tx.toFixed(1) + '" y2="' + totalH + '" stroke="#ef4444" stroke-width="2.2" opacity=".95"/>' +
          '<text x="' + (tx + 6).toFixed(1) + '" y="' + (AXIS_H - 8) + '" font-size="10.5" font-weight="700" fill="#ef4444">今日</text></g>';
      }

      /* 任务条 */
      rows.forEach(function (r) {
        if (r.kind !== 'task') return;
        var t = r.task;
        var st = statusOf(t, today);
        var x1 = xOf(t.start), x2 = xOf(t.end);
        var cy = r.y + r.h / 2;
        var id = esc(t.id || '');
        var tip = esc(t.name + '（' + fmtMD(t.start) + ' — ' + fmtMD(t.end) + '）');

        if (t.point || t.milestone) {
          var col = (st === 'finish') ? '#9ca3af' : (t.crit ? '#ef4444' : '#8b5cf6');
          var sz = 6.5;
          S += '<g class="gv-bar" data-id="' + id + '"><title>' + tip + '</title>' +
            '<path d="M' + x1.toFixed(1) + ',' + (cy - sz).toFixed(1) + ' L' + (x1 + sz).toFixed(1) + ',' + cy.toFixed(1) + ' L' + x1.toFixed(1) + ',' + (cy + sz).toFixed(1) + ' L' + (x1 - sz).toFixed(1) + ',' + cy.toFixed(1) + ' Z" fill="' + col + '" stroke="rgba(0,0,0,.15)" stroke-width="1"/></g>';
          return;
        }
        var w = Math.max(x2 - x1 + px, 3);
        var fill, stroke;
        if (st === 'finish') { fill = '#cbd5e1'; stroke = '#94a3b8'; }
        else if (st === 'going') { fill = t.crit ? '#f87171' : '#2563eb'; stroke = t.crit ? '#dc2626' : '#1d4ed8'; }
        else { fill = t.crit ? '#fca5a5' : '#93c5fd'; stroke = t.crit ? '#dc2626' : '#60a5fa'; }
        var hBar = 15, barY = cy - hBar / 2;
        S += '<g class="gv-bar" data-id="' + id + '"><title>' + tip + '</title>' +
          '<rect x="' + x1.toFixed(1) + '" y="' + barY.toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + hBar + '" rx="4" fill="' + fill + '" stroke="' + stroke + '" stroke-width="1"/>';
        if (w > 66 && px > 1.1) {
          var txt = fmtMD(t.start) + '–' + fmtMD(t.end);
          if (txt.length * 6.1 < w - 12) {
            var tc = (fill === '#2563eb' || fill === '#f87171') ? '#fff' : '#1e3a8a';
            S += '<text x="' + (x1 + w / 2).toFixed(1) + '" y="' + (cy + 3.5).toFixed(1) + '" text-anchor="middle" font-size="10.5" font-weight="600" fill="' + tc + '">' + txt + '</text>';
          }
        }
        S += '</g>';
      });
      svgEl.innerHTML = S;

      /* 事件委托 */
      svgEl.onclick = function (ev) {
        var g = ev.target && ev.target.closest ? ev.target.closest('.gv-bar') : null;
        if (!g || !g.dataset.id) return;
        var t = model.byId ? model.byId(g.dataset.id) : null;
        if (t) openDetail(t);
      };

      /* 定位 */
      if (centerDate) scrollToCenter(centerDate);
      updateRange();
    }

    function scrollToCenter(cd) {
      var plotW = pw();
      var px = plotW / viewDays;
      var max = svgEl.getAttribute('width') - plotW;
      var sl = (LEFT_PAD + diffDays(minDate, cd) * px) - plotW * 0.38; // 中心略偏左，给右侧留视野
      if (sl < 0) sl = 0;
      if (sl > max) sl = max;
      scrollEl.scrollLeft = sl;
    }

    function centerDate() {
      var plotW = pw();
      var px = plotW / viewDays;
      var sl = Math.min(Math.max(scrollEl.scrollLeft, 0), svgEl.getAttribute('width') - plotW);
      return addDays(minDate, (sl + plotW * 0.5 - LEFT_PAD) / px);
    }

    function updateRange() {
      var c = centerDate();
      var f = new Date(Math.max(minDate, addDays(c, -viewDays / 2)));
      var t = new Date(Math.min(maxDate, addDays(c, viewDays / 2)));
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
          newDays = Math.min(viewDays, 120);
          break;
        case 'prevYear':
          newDays = Math.min(Math.max(viewDays, 90), 400);
          target = new Date(Math.max(minDate.getFullYear() - 0, 2000), c.getMonth() - 12 + (c.getMonth() >= 0 ? 0 : 0), 15);
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
        viewDays = Math.min(Math.max(newDays != null ? newDays : viewDays, MIN_VIEW), MAX_VIEW);
        redraw(target);
      }
    });

    /* 滚动时刷新范围指示（触摸横向滚动） */
    var scTimer = null;
    scrollEl.addEventListener('scroll', function () {
      if (scTimer) clearTimeout(scTimer);
      scTimer = setTimeout(updateRange, 150);
    });
    window.addEventListener('resize', function () {
      var c = centerDate();
      redraw(c);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      var tag = document.activeElement && document.activeElement.tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT') return;
      var dx = e.key === 'ArrowLeft' ? -pw() * 0.7 : pw() * 0.7;
      scrollEl.scrollBy({ left: dx, behavior: 'smooth' });
    });

    /* ---- 详情抽屉 ---- */
    var mask = null, drawer = null;
    function openDetail(task) {
      var ev = eventsData[task.id] || null;
      var sec = secOfTask[task.id] || { name: '' };
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
      function row(k, v) { return '<div class="gv-drow"><span class="k">' + k + '</span><span class="v">' + v + '</span></div>'; }

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
    var bootCenter = hasTodayInRange ? new Date(today) : (today > maxDate ? new Date(maxDate) : new Date(minDate));
    redraw(bootCenter);

    return {
      destroy: function () {
        if (mask) { mask.remove(); drawer.remove(); }
        container.removeChild(root);
        container.removeChild(styleEl);
      },
      goToday: function () { toolbar.querySelector('[data-act="today"]').click(); }
    };
  }

  return { mount: mount };
});
