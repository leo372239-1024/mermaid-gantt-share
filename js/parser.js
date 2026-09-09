/*
 * gantt-parser.js —— Mermaid Gantt 语法子集解析器（自研，供浏览器与 Node 测试双用）
 *
 * 支持语法：
 *   gantt / title / dateFormat YYYY-MM-DD / axisFormat ...（axis 标签我们自绘）
 *   section 阶段名
 *   任务名 :done|active|crit|milestone(可多个，逗号分隔), 任务id, 开始日期YYYY-MM-DD[, 结束日期|Nd]
 *   里程碑：任务名 :milestone, id, 日期, 0d（0d 也视为单日节点）
 *   after 依赖（begin after id）：提供基础支持
 * 输出统一模型 { title, sections:[{name,tasks:[{id,name,start,end,point,milestone,done,active,crit,raw}]}], range:{start,end} }
 * 解析失败的行不会中断，会进入 warnings 供页面提示。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GanttParser = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DAY = 86400000;
  var STATUS_WORDS = ['done', 'active', 'crit', 'milestone'];

  function toDate(s) {
    var d = toDateT(s);
    return d ? d.d : null;
  }

  /* 解析日期，支持可选时分（24小时制）：YYYY-M-D 或 YYYY-M-D HH:mm。
     返回 { d: Date(带时分的时刻), t: 'HH:mm' 字符串或空 }；无法解析返回 null。 */
  function toDateT(s) {
    var str = String(s).trim();
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{1,2}))?$/.exec(str);
    if (!m) return null;
    var h = m[4] != null ? +m[4] : 0;
    var mi = m[5] != null ? +m[5] : 0;
    if (h > 23 || mi > 59) return null;
    var d = new Date(+m[1], +m[2] - 1, +m[3], h, mi);
    if (isNaN(d.getTime())) return null;
    var time = m[4] != null ? pad2(h) + ':' + pad2(mi) : '';
    return { d: d, time: time };
  }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function fmt(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function fmtDT(d, time) {
    if (time) return fmt(d) + ' ' + time;
    return fmt(d);
  }

  function addDays(d, n) {
    var x = new Date(d.getTime());
    x.setDate(x.getDate() + n);
    return x;
  }

  function diffDays(a, b) { return Math.round((b - a) / DAY); }

  function truncate(s, n) { s = String(s); return s.length > (n || 60) ? s.slice(0, n) + '…' : s; }

  /* 判断冒号后内容是否像「合法任务属性」开头（用于定位 名称:属性 的分隔冒号） */
  function isAttrStart(head) {
    if (!head) return false;
    var tok = head.split(',')[0].trim();
    if (!tok) return false;
    if (STATUS_WORDS.indexOf(tok) >= 0) return true;
    if (/^after\s+[^\s,]+$/i.test(tok)) return true;
    if (toDateT(tok)) return true;          // 日期(/带时分) token
    if (/^(\d+)d$/i.test(tok)) return true; // Nd
    if (/^[\w.#-]+$/.test(tok)) return true; // 裸 id（连续字母数字，含 . # -）
    return false;
  }

  function parse(text) {
    var warnings = [];
    var model = { title: '', sections: [], all: [] };
    var cur = null;
    var idMap = {}; // id -> task（after 解析用）

    var lines = String(text).split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i];
      var line = raw.trim();
      if (!line || line.indexOf('%%') === 0) continue;
      var m;

      if (/^gantt\b/i.test(line)) continue;
      if ((m = /^title\s+(.+)$/.exec(line))) { model.title = m[1].trim(); continue; }
      if (/^(dateFormat|axisFormat|excludes|topAxis|todayMarker|inclusiveEndDates|barGap|barHeight|useMaxWidth)\b/.test(line)) continue;

      if ((m = /^section\s+(.+)$/.exec(line))) {
        cur = { name: m[1].trim(), tasks: [] };
        model.sections.push(cur);
        continue;
      }

      /* 任务行：切分「名称:属性」。不能用 lastIndexOf(':')——因为时间值(如 14:30)也含冒号。
         改为从左到右找第一个「:右侧是合法属性片段」的冒号作为分隔符：
         时间 token 内的冒号右侧是残留的分钟数字，不构成合法属性开头，会被自然跳过；
         而真正的分隔冒号右侧是 id/状态/日期/after/Nd 之一。 */
      var ci = -1, name = '', attrRaw = '';
      for (var sc = 0; sc < line.length; sc++) {
        if (line.charAt(sc) !== ':') continue;
        var candRaw = line.slice(sc + 1).trim();
        var candName = line.slice(0, sc).trim();
        if (candName && isAttrStart(candRaw)) { ci = sc; name = candName; attrRaw = candRaw; break; }
      }
      if (ci < 0) { warnings.push('第' + (i + 1) + '行 未识别（非任务/指令行）：' + truncate(line)); continue; }

      var tokens = attrRaw.split(',').map(function (t) { return t.trim(); }).filter(Boolean);
      if (!tokens.length) { warnings.push('第' + (i + 1) + '行 任务「' + truncate(name, 24) + '」缺少属性'); continue; }

      if (!cur) { cur = { name: '未分组', tasks: [] }; model.sections.unshift(cur); }

      var task = {
        name: name, id: '', start: null, end: null,
        startTime: '', endTime: '',
        point: false, milestone: false, done: false, active: false, crit: false,
        depId: null, depAfter: false, raw: line.trim()
      };
      var dates = [];
      var dateTimes = [];
      var durDays = null;
      var haveId = false;

      for (var j = 0; j < tokens.length; j++) {
        var t = tokens[j];
        if (STATUS_WORDS.indexOf(t) >= 0) {
          if (t === 'milestone') task.milestone = true;
          else if (t === 'done') task.done = true;
          else if (t === 'active') task.active = true;
          else if (t === 'crit') task.crit = true;
          continue;
        }
        var am = /^after\s+([\w.-]+)$/.exec(t);
        if (am) { task.depId = am[1]; task.depAfter = true; continue; }
        var dt = toDateT(t);
        if (dt && dt.d) { dates.push(dt.d); dateTimes.push(dt.time); continue; }
        var dm = /^(\d+)d$/i.exec(t);
        if (dm) { durDays = parseInt(dm[1], 10); continue; }
        if (!haveId) { task.id = t; haveId = true; continue; }
        warnings.push('第' + (i + 1) + '行 忽略无法识别的属性「' + truncate(t, 20) + '」');
      }

      if (durDays === 0) task.point = true; // 0d → 单日节点
      if (task.milestone && !task.end && dates.length === 1 && durDays === null) { task.point = true; }

      if (dates.length) { task.start = dates[0]; if (dateTimes[0]) task.startTime = dateTimes[0]; }
      if (dates.length > 1) { task.end = dates[1]; if (dateTimes[1]) task.endTime = dateTimes[1]; }

      if (task.start) {
        if (!task.end) {
          if (durDays !== null && durDays > 0) task.end = addDays(task.start, durDays - 1); // Nd 表示含开始日共 N 天
          else if (durDays === 0) task.end = task.start; // 0d → 当日点
          else task.end = task.start; // 未写结束 → 单日
        }
      }

      if (!task.start) {
        if (task.depAfter) {
          // after 依赖：占位，第二轮解析
        } else {
          warnings.push('第' + (i + 1) + '行 任务「' + truncate(name, 24) + '」缺少有效日期，已跳过');
          continue;
        }
      }
      if (!task.id) task.id = task.name;
      cur.tasks.push(task);
      model.all.push(task);
      if (task.id && !idMap[task.id]) idMap[task.id] = task;
    }

    /* after 依赖解析：start = 依赖任务结束日 +1 天；如循环引用则给出警告并置为数据集首日 */
    var pass, resolved = true, guard = 0;
    while (guard++ < 6) {
      resolved = true;
      for (var k = 0; k < model.all.length; k++) {
        var tk = model.all[k];
        if (!tk.depAfter || tk.start) continue;
        var dep = idMap[tk.depId];
        if (dep && dep.end) { tk.start = addDays(dep.end, 1); if (tk.end === null && durFor(tk) === null) tk.end = tk.start; resolved = false; }
        else { warnings.push('任务「' + truncate(tk.name, 20) + '」依赖 after ' + tk.depId + ' 未找到前置任务，已置为全图首日'); tk.depAfter = false; }
      }
      if (resolved) break;
    }

    /* 计算全图时间范围（含今日之外的护栏：至少覆盖所有任务） */
    var min = null, max = null;
    model.all.forEach(function (t) {
      if (!t.start) return;
      if (!min || t.start < min) min = new Date(t.start);
      if (!max || t.end > max) max = new Date(t.end);
    });
    if (!min || !max) { warnings.push('未能从代码中解析出任何有效日期，请检查格式'); }
    model.range = (min && max) ? { start: min, end: max } : null;

    /* 便捷查询 */
    model.byId = function (id) { return idMap[id] || null; };
    model.warnings = warnings;
    return model;

    function durFor(t) { return null; }
  }

  return { parse: parse, toDate: toDate, toDateT: toDateT, fmt: fmt, fmtDT: fmtDT, addDays: addDays, diffDays: diffDays };
});
