/*
 * build-deadlines.js —— 把 gantt.md 编译成「给通知系统消费」的精简 JSON（deadlines.json）
 *
 * 为什么要这一步：
 *   gantt.md 是 Mermaid 语法，手机端的「快捷指令」解析起来非常别扭（要处理 section /
 *   状态词 / 日期与时分混排的冒号）。本脚本在构建期把解析结果拍平成一个扁平数组，
 *   快捷指令只需 3 个动作（获取 URL → 取字典值 → 重复+比较）即可完成筛选。
 *
 * 单一数据源原则：本脚本不产生新数据，只做「gantt.md + js/events.js → deadlines.json」
 *   的纯函数式转换。任何时候都不要手工编辑 deadlines.json。
 *
 * 用法：
 *   node tools/build-deadlines.js                  # 使用默认窗口（30 天）
 *   DEADLINE_WINDOW_DAYS=60 node tools/build-deadlines.js
 *
 * 时区：统一以北京时间（UTC+8）为准。GitHub Actions 运行在 UTC 环境下，若直接用
 *   本地时间取「今天」会整体偏移 8 小时，导致临期任务漏报或错报，因此这里所有日期
 *   运算都显式走 CST 换算。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const Parser = require(path.join(ROOT, 'js', 'parser.js'));
const Events = require(path.join(ROOT, 'js', 'events.js'));

const DAY = 86400000;
const CST_OFFSET = 8 * 60 * 60 * 1000;

/* 窗口：纳入「未来 N 天内到期」的任务 */
const WINDOW_DAYS = toInt(process.env.DEADLINE_WINDOW_DAYS, 30);
/* 逾期宽限：未标记 done 又刚过期的任务，再给 1 天曝光期（多半是忘了标 done） */
const OVERDUE_GRACE_DAYS = toInt(process.env.DEADLINE_OVERDUE_GRACE_DAYS, 1);

function toInt(v, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

/* ---------- 北京时间工具 ---------- */

/* 当前北京时间（用 UTC getter 读取偏移后的时刻） */
function nowCST() {
  const s = new Date(Date.now() + CST_OFFSET);
  return {
    y: s.getUTCFullYear(),
    m: s.getUTCMonth() + 1,
    d: s.getUTCDate()
  };
}

/* 北京时间 y-m-d hh:mm → UTC 毫秒时间戳 */
function cstToMs(y, m, d, hh, mm) {
  return Date.UTC(y, m - 1, d, hh, mm) - CST_OFFSET;
}

/* 北京时间自然日序号（用于算「相差几天」，不受时分干扰） */
function cstDayNo(y, m, d) {
  return Math.round((Date.UTC(y, m - 1, d) - CST_OFFSET) / DAY);
}

/* ---------- 读取数据源 ---------- */

function readGanttCode() {
  const md = fs.readFileSync(path.join(ROOT, 'gantt.md'), 'utf8');
  const re = /```mermaid\s*\n([\s\S]*?)\n```/g;
  const blocks = [];
  let m;
  while ((m = re.exec(md)) !== null) blocks.push(m[1].trim());
  if (!blocks.length) throw new Error('gantt.md 中未找到 ```mermaid 代码块');
  return blocks[0];
}

function ownerBrief(ev) {
  if (!ev || !Array.isArray(ev.owners) || !ev.owners.length) return '';
  return ev.owners.map(function (o) { return o.name; }).join('、');
}

/* ---------- 文案 ---------- */

function dueText(daysLeft, time) {
  const hm = time ? ' ' + time : '';
  if (daysLeft < 0) return '已过期 ' + (-daysLeft) + ' 天';
  if (daysLeft === 0) return '今天' + hm + ' 截止';
  if (daysLeft === 1) return '明天' + hm + ' 截止';
  return daysLeft + ' 天后截止';
}

function dueTextLong(daysLeft, time, y, m, d) {
  const cal = m + '月' + d + '日';
  const hm = time ? ' ' + time : '';
  if (daysLeft < 0) return '已过期 ' + (-daysLeft) + ' 天（' + cal + '）';
  if (daysLeft === 0) return '今天' + hm + ' 截止';
  if (daysLeft === 1) return '明天' + hm + ' 截止';
  return cal + hm + '（' + daysLeft + ' 天后）';
}

/* ---------- 主流程 ---------- */

function build() {
  const model = Parser.parse(readGanttCode());
  const now = nowCST();
  const nowMs = Date.now();
  const todayNo = cstDayNo(now.y, now.m, now.d);

  const fatal = model.warnings.filter(function (w) {
    return /缺少有效日期|未能从代码中解析/.test(w);
  });
  if (fatal.length) {
    console.error('[build-deadlines] gantt.md 存在致命解析问题，已中止：');
    fatal.forEach(function (w) { console.error('  - ' + w); });
    process.exit(1);
  }

  /* 任务 id → 所属 section 名 */
  const sectionOf = {};
  model.sections.forEach(function (sec) {
    sec.tasks.forEach(function (t) { sectionOf[t.id] = sec.name; });
  });

  const items = [];

  model.all.forEach(function (t) {
    if (!t.end) return;
    if (t.done) return;                     // 已完成不再提醒

    /* 截止时刻：带时分则用该时刻，否则默认当日 23:59（北京时间） */
    const y = t.end.getFullYear();
    const mo = t.end.getMonth() + 1;
    const da = t.end.getDate();
    const time = t.endTime || '';
    let hh = 23, mi = 59;
    if (time) {
      const p = time.split(':');
      hh = parseInt(p[0], 10);
      mi = parseInt(p[1], 10);
    }

    const dueMs = cstToMs(y, mo, da, hh, mi);
    const daysLeft = cstDayNo(y, mo, da) - todayNo;

    if (daysLeft > WINDOW_DAYS) return;
    if (daysLeft < -OVERDUE_GRACE_DAYS) return;

    const ev = Events[t.id];
    const displayName = (ev && ev.short) ? ev.short : t.name;
    const hoursLeft = Math.round((dueMs - nowMs) / 3600000);
    const overdue = daysLeft < 0;

    items.push({
      id: t.id,
      name: displayName,
      fullName: t.name,
      section: sectionOf[t.id] || '',
      due: y + '-' + pad2(mo) + '-' + pad2(da),
      time: time,
      dueAt: new Date(dueMs).toISOString(),
      /* daysLeft 按自然日计算，同一天内反复读取结果恒定 —— 判断「是否该提醒」请优先用它 */
      daysLeft: daysLeft,
      /* hoursLeft 是构建时刻的快照，数小时后读取会偏小，仅适合当次即时判断 */
      hoursLeft: hoursLeft,
      overdue: overdue,
      kind: t.milestone ? 'milestone' : (t.point ? 'point' : 'span'),
      crit: !!t.crit,
      owner: ownerBrief(ev),
      where: (ev && ev.where) ? ev.where : '',
      alert: dueText(daysLeft, time) + ' · ' + displayName,
      detail: dueTextLong(daysLeft, time, y, mo, da)
    });
  });

  items.sort(function (a, b) {
    if (a.dueAt !== b.dueAt) return a.dueAt < b.dueAt ? -1 : 1;
    if (a.crit !== b.crit) return a.crit ? -1 : 1;
    return a.name < b.name ? -1 : 1;
  });

  const within24hItems = items.filter(function (it) { return it.hoursLeft <= 24; });

  const out = {
    schema: 1,
    generatedAt: new Date(nowMs).toISOString(),
    timezone: 'Asia/Shanghai',
    windowDays: WINDOW_DAYS,
    today: now.y + '-' + pad2(now.m) + '-' + pad2(now.d),
    count: items.length,

    /* ⚠️ 以下字段是「构建时刻」的快照，只在生成的瞬间准确。
       若消费方是在几小时后才读取，请改用 daysLeft（自然日，一天内稳定）
       或 dueAt（绝对时刻，可自行与当前时间求差）来做判断。 */
    within24h: within24hItems.length,
    within24hText: within24hItems.map(function (it) { return it.alert; }).join('\n'),

    /* 窗口内全部条目的汇总，换行分隔，可直接作为通知正文 */
    summary: items.map(function (it) { return it.alert; }).join('\n'),
    items: items
  };

  return out;
}

const result = build();
const outPath = path.join(ROOT, 'deadlines.json');
fs.writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n', 'utf8');

console.log('[build-deadlines] 已生成 deadlines.json');
console.log('  基准日期（北京）：' + result.today);
console.log('  窗口：未来 ' + WINDOW_DAYS + ' 天（逾期宽限 ' + OVERDUE_GRACE_DAYS + " 天）");
console.log('  条目：' + result.count + ' 条，其中 24 小时内到期 ' + result.within24h + ' 条');
result.items.forEach(function (it) {
  console.log('   · [' + it.due + '] ' + it.alert + (it.overdue ? '  ⚠ 未标记 done' : ''));
});
if (result.count === 0) console.log('   （窗口内没有待办）');
