/*
 * ics.js —— iCalendar(.ics) 生成器（UMD：浏览器 / Node 双用，无任何外部依赖）
 *
 * 职责单一：把「一组带绝对时刻的提醒事件」序列化成 RFC 5545 文本。
 * 网页端（viewer.js 的「📅 加入系统日历」按钮）与构建期（tools/build-deadlines.js
 * 产出可订阅的 deadlines.ics）共用本模块，保证两处导出的日历行为完全一致。
 *
 * 输入 events: [{
 *   uid        : string   事件唯一标识（客户端靠它去重 / 覆盖更新）
 *   title      : string   标题
 *   startMs    : number   事件开始（毫秒时间戳）
 *   endMs      : number   事件结束 —— 对班务场景就是「真正的截止时刻」
 *   desc       : string   可选，描述（可用 \n 换行）
 *   location   : string   可选，地点
 *   alarmsMin  : number[] 可选，相对「结束时刻」的分钟偏移（负数=提前，0=到点）；默认 [0]
 * }]
 * opts: { calName?: string, tzid?: string, tzOffsetMin?: number }
 *
 * 时区策略（关键）：所有时刻都按「固定偏移时区」输出本地时间，并在文件里内嵌 VTIMEZONE
 *   定义。这样无论生成端跑在 GitHub Actions 的 UTC 环境，还是手机处在别的时区，
 *   事件时刻都不会漂移。中国自 1991 年起不实行夏令时，固定 +0800 是安全的。
 *
 * 为什么用日历而不是推送：iOS 上网页永远拿不到 Critical Alert 权限，Web Push 也只能发
 *   普通级别通知（静音/专注照样压掉）。而「系统日历事件 + VALARM」是原生能力，到点由
 *   系统闹铃服务触发，能穿透静音与专注模式，且不依赖网页是否打开。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GanttIcs = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULT_TZID = 'Asia/Shanghai';
  var DEFAULT_TZ_OFFSET_MIN = 480;   /* UTC+8 */

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  /* iCalendar 文本转义：反斜杠 / 分号 / 逗号 / 换行 */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\r?\n/g, '\\n');
  }

  /* 单字符 UTF-8 字节数（用于按 75 octets 折行，避免把汉字劈开） */
  function utf8Len(ch) {
    var c = ch.charCodeAt(0);
    if (c < 0x80) return 1;
    if (c < 0x800) return 2;
    return 3;   /* 本模块只会遇到 BMP 字符（不含 emoji，emoji 由调用方决定是否使用） */
  }

  /* 折行：第 75 字节处断开，续行以单个空格开头（RFC 5545 §3.1）。按字符边界断，绝不断汉字 */
  function fold(line) {
    var out = [], cur = '', bytes = 0;
    for (var i = 0; i < line.length; i++) {
      var ch = line.charAt(i);
      var b = utf8Len(ch);
      if (bytes + b > 73) { out.push(cur); cur = ' '; bytes = 1; }
      cur += ch; bytes += b;
    }
    out.push(cur);
    return out.join('\r\n');
  }

  /* 绝对毫秒 + 固定偏移 → iCalendar 本地时间戳（无 Z，配合 TZID 使用） */
  function fmtLocal(ms, offMin) {
    var d = new Date(ms + offMin * 60000);
    return d.getUTCFullYear() + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate()) + 'T' +
      pad2(d.getUTCHours()) + pad2(d.getUTCMinutes()) + pad2(d.getUTCSeconds());
  }

  /* UTC 时间戳（仅 DTSTAMP 用） */
  function fmtUTC(ms) {
    var d = new Date(ms);
    return d.getUTCFullYear() + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate()) + 'T' +
      pad2(d.getUTCHours()) + pad2(d.getUTCMinutes()) + pad2(d.getUTCSeconds()) + 'Z';
  }

  /* 相对分钟偏移 → 绝对 UTC 触发时刻：TRIGGER;VALUE=DATE-TIME:20260913T152900Z
     为什么用绝对时刻而不是 TRIGGER:-PT30M / RELATED=END：
     相对触发依赖各客户端对 RELATED 参数（START/END）的实现，历史上差异较大；
     绝对时刻是 RFC 5545 的通用形式，Apple / Google / Outlook 全部一致支持。
     本文件的生成频率（每次 gantt.md 变更或每日定时）远高于用户查看频率，不存在失配问题。 */
  function triggerAbs(endMs, min) {
    return 'TRIGGER;VALUE=DATE-TIME:' + fmtUTC(endMs + (min || 0) * 60000);
  }

  function build(events, opts) {
    opts = opts || {};
    var TZ = opts.tzid || DEFAULT_TZID;
    var OFF = (opts.tzOffsetMin == null) ? DEFAULT_TZ_OFFSET_MIN : opts.tzOffsetMin;
    var offNote = (OFF >= 0 ? '+' : '-') + pad2(Math.floor(Math.abs(OFF) / 60)) + pad2(Math.abs(OFF) % 60);

    var L = [];
    L.push('BEGIN:VCALENDAR');
    L.push('VERSION:2.0');
    L.push('PRODID:-//mermaid-gantt-share//banwu-deadlines//CN');
    L.push('CALSCALE:GREGORIAN');
    L.push('METHOD:PUBLISH');
    if (opts.calName) L.push('X-WR-CALNAME:' + esc(opts.calName));
    L.push('X-WR-TIMEZONE:' + TZ);
    L.push('BEGIN:VTIMEZONE');
    L.push('TZID:' + TZ);
    L.push('BEGIN:STANDARD');
    L.push('DTSTART:19700101T000000');
    L.push('TZOFFSETFROM:' + offNote);
    L.push('TZOFFSETTO:' + offNote);
    L.push('TZNAME:CST');
    L.push('END:STANDARD');
    L.push('END:VTIMEZONE');

    var stamp = fmtUTC(opts.now == null ? Date.now() : opts.now);

    (events || []).forEach(function (ev) {
      if (!ev || ev.startMs == null || ev.endMs == null) return;
      var uid = String(ev.uid || '').replace(/[^\w.@-]/g, '') || ('evt-' + ev.endMs);
      L.push('BEGIN:VEVENT');
      L.push('UID:' + uid);
      L.push('DTSTAMP:' + stamp);
      L.push('DTSTART;TZID=' + TZ + ':' + fmtLocal(ev.startMs, OFF));
      L.push('DTEND;TZID=' + TZ + ':' + fmtLocal(ev.endMs, OFF));
      L.push('SUMMARY:' + esc(ev.title));
      if (ev.desc) L.push('DESCRIPTION:' + esc(ev.desc));
      if (ev.location) L.push('LOCATION:' + esc(ev.location));
      L.push('TRANSP:OPAQUE');
      var alarms = (ev.alarmsMin && ev.alarmsMin.length) ? ev.alarmsMin : [0];
      alarms.forEach(function (min) {
        L.push('BEGIN:VALARM');
        L.push('ACTION:DISPLAY');
        L.push('DESCRIPTION:' + esc(ev.alarmText || (ev.title + (min < 0 ? ' 即将截止' : ' 现在截止'))));
        L.push(triggerAbs(ev.endMs, min));
        L.push('END:VALARM');
      });
      L.push('END:VEVENT');
    });

    L.push('END:VCALENDAR');
    return L.map(fold).join('\r\n') + '\r\n';
  }

  return { build: build, esc: esc, fmtLocal: fmtLocal, fmtUTC: fmtUTC, fold: fold };
});
