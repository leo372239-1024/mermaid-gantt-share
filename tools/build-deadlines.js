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
const Ics = require(path.join(ROOT, 'js', 'ics.js'));

const DAY = 86400000;
const CST_OFFSET = 8 * 60 * 60 * 1000;

/* 窗口：纳入「未来 N 天内到期」的任务（deadlines.json 的提醒窗口） */
const WINDOW_DAYS = toInt(process.env.DEADLINE_WINDOW_DAYS, 30);
/* 逾期宽限：未标记 done 又刚过期的任务，再给 1 天曝光期（多半是忘了标 done） */
const OVERDUE_GRACE_DAYS = toInt(process.env.DEADLINE_OVERDUE_GRACE_DAYS, 1);
/* deadlines.ics（日历订阅用）的窗口更宽：日历经得起半年量级的条目 */
const ICS_WINDOW_DAYS = toInt(process.env.ICS_WINDOW_DAYS, 180);
/* 通道 C（快捷指令 → 时钟 App 闹钟）的提前量：闹钟锚在「开始时刻 − N 分钟」。
   为什么锚开始而不是截止：闹钟的作用是「把人从当前状态拉起来去做这件事」，
   而这件事在开始时刻就已经需要人在场了（例：领票 14:00 开始，17:00 才算截止）。 */
const ALARM_LEAD_MIN = toInt(process.env.DEADLINE_ALARM_LEAD_MIN, 15);
/* 通道 C 闹钟标签的字段分隔符：标签 =「名称｜地点｜开始→结束时间」，空段省略。
   不用逗号/顿号分段，是因为任务名本身可能含「，」（例：「去天佑会堂经管牌子集合看直播，13.15到」）。
   网页端 js/viewer.js 的 ALARM_LABEL_SEP / alarmLabelOf 必须与此同构（test/unit.js [11] 断言）。 */
const ALARM_LABEL_SEP = '｜';
function alarmLabelOf(name, where, when) {
  return [name, where, when].filter(Boolean).join(ALARM_LABEL_SEP);
}

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

function fmtDTYMD(d, h, mi) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
    ' ' + pad2(h) + ':' + pad2(mi);
}
function fmtMd(d) { return (d.getMonth() + 1) + '.' + d.getDate(); }

/* 时刻解析：合法 'H:mm' / 'HH:mm' → {h,mi,exact:true}；否则退回兜底值并标 exact:false */
function hmOf(raw, fh, fmi) {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(String(raw == null ? '' : raw).trim());
  if (!m) return { h: fh, mi: fmi, exact: false };
  const h = parseInt(m[1], 10), mi = parseInt(m[2], 10);
  if (h > 23 || mi > 59) return { h: fh, mi: fmi, exact: false };
  return { h: h, mi: mi, exact: true };
}
function startHmOf(t) { return hmOf(t.startTime, 0, 0); }
/* 截止时刻口径（与网页端 remDueHM 完全一致，两处必须同时改）：
   结束日期 + 结束时刻；未填结束时刻时，若起止同日且填了开始时刻则用开始时刻；否则回落 23:59 */
function dueHmOf(t) {
  const e = hmOf(t.endTime, 23, 59);
  if (e.exact) return e;
  const s = hmOf(t.startTime, 0, 0);
  const sameDay = t.start && t.end &&
    t.start.getFullYear() === t.end.getFullYear() &&
    t.start.getMonth() === t.end.getMonth() &&
    t.start.getDate() === t.end.getDate();
  if (s.exact && sameDay) return s;
  return e;
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

  /* 课程表（section 名含「课程表」）默认不过滤：课表上的上课日事件也进入提醒/日历/系统闹钟链路
     （v28 起按用户要求放开——今明两日的课也要能设「时钟」闹钟提醒）。
     每条 id 形如 k{w基础}w{周}，起止精确到分钟内；alarmLabel 已是「课程名｜教室｜起止」，语义正确。
     注：课程条目只对「今天开始」的那些（startDaysLeft===0 且已填开始时刻）进通道 C 闹钟，
     由 alarmItems 筛选天然控制，不会淹没；日历侧在 180 天窗口内的课按各自起止生成事件。 */

  const items = [];
  const icsItems = [];

  model.all.forEach(function (t) {
    if (!t.end) return;
    if (t.done) return;                     // 已完成不再提醒

    /* 起止时刻全部取自「编辑表单的日期/时刻组件」（即 gantt.md 里的 OO 段），精确到分钟 */
    const eh = dueHmOf(t);
    const sh = startHmOf(t);
    const y = t.end.getFullYear(), mo = t.end.getMonth() + 1, da = t.end.getDate();
    const sy = t.start.getFullYear(), smo = t.start.getMonth() + 1, sda = t.start.getDate();
    const time = pad2(eh.h) + ':' + pad2(eh.mi);
    const timeStart = pad2(sh.h) + ':' + pad2(sh.mi);

    const dueMs = cstToMs(y, mo, da, eh.h, eh.mi);
    const startMs = cstToMs(sy, smo, sda, sh.h, sh.mi);
    const daysLeft = cstDayNo(y, mo, da) - todayNo;
    /* 通道 C 的筛选依据：闹钟锚在开始时刻，所以「今天该不该建闹钟」要看开始日期而不是截止日期
       （例：今天 14:00 开始、9.12 截止的活动，按截止日算会被漏掉） */
    const startDaysLeft = cstDayNo(sy, smo, sda) - todayNo;
    /* 闹钟绝对时刻 = 开始时刻 − LEAD 分钟；小时/分钟用 UTC getter 读偏移后的北京时间 */
    const alarmMs = startMs - ALARM_LEAD_MIN * 60000;
    const alarmD = new Date(alarmMs + CST_OFFSET);
    const alarmTime = pad2(alarmD.getUTCHours()) + ':' + pad2(alarmD.getUTCMinutes());

    const ev = Events[t.id];
    const displayName = (ev && ev.short) ? ev.short : t.name;
    const whereText = (ev && ev.where) ? String(ev.where).trim() : '';
    const hoursLeft = Math.round((dueMs - nowMs) / 3600000);
    const overdue = daysLeft < 0;
    /* 人类可读的分钟级起止：'9.10 14:00 → 9.10 17:00'（未填时刻的推定值带 ~ 标记） */
    const windowText = fmtMd(t.start) + ' ' + (sh.exact ? '' : '~') + timeStart +
      ' → ' + fmtMd(t.end) + ' ' + (eh.exact ? '' : '~') + time;
    /* 通道 C 的闹钟标签 = 「名称｜地点｜开始→结束时间」，例：
       '文艺汇演领票｜主校区西操场｜9.10 14:00 → 9.10 17:00'
       （在「时钟」App 里一眼看清是哪件事、在哪、什么时候开始什么时候结束；地点为空则省略该段）
       起止同刻（时间点）时只显示一次时间，与标题 rangeCN 的口径保持一致 */
    const alarmWhen = (startMs === dueMs)
      ? fmtMd(t.start) + ' ' + (sh.exact ? '' : '~') + timeStart
      : windowText;
    const alarmLabel = alarmLabelOf(displayName, whereText, alarmWhen);

    const rec = {
      id: t.id,
      name: displayName,
      fullName: t.name,
      section: sectionOf[t.id] || '',
      /* 开始：日期组件「开始日期 + 时刻」 */
      start: sy + '-' + pad2(smo) + '-' + pad2(sda),
      startTime: timeStart,
      startAt: new Date(startMs).toISOString(),
      /* 截止：日期组件「结束日期 + 时刻」（未填时刻 → 23:59；时间点且填了开始时刻 → 开始时刻） */
      due: y + '-' + pad2(mo) + '-' + pad2(da),
      time: time,
      dueAt: new Date(dueMs).toISOString(),
      /* 分钟级起止字符串，快捷指令/通知正文可直接用 */
      window: windowText,
      startExact: sh.exact,
      dueExact: eh.exact,
      /* ---- 通道 C（快捷指令 → 「时钟」App 真闹钟）专用字段 ----
         闹钟「时间」锚在开始时刻前 ALARM_LEAD_MIN 分钟；「标签」= 名称 + 起止日期时间。
         时钟闹钟只有「时刻 + 重复」、不能绑定日期，所以快捷指令必须两道筛：
         ① startDaysLeft === 0（今天开始）② alarmAt 仍晚于当前时刻（已过点的会顺延到明天响）。 */
      startDaysLeft: startDaysLeft,
      alarmLead: ALARM_LEAD_MIN,
      alarmAt: new Date(alarmMs).toISOString(),
      alarmTime: alarmTime,
      alarmLabel: alarmLabel,
      /* 只有显式填了「开始时刻」，闹钟才落在有意义的时刻；
         未填时刻的开始按 00:00 计 → 闹钟会落到前一天 23:45，此时该条不应建闹钟 */
      alarmExact: sh.exact,
      /* daysLeft 按自然日计算，同一天内反复读取结果恒定 —— 判断「是否该提醒」请优先用它 */
      daysLeft: daysLeft,
      /* hoursLeft 是构建时刻的快照，数小时后读取会偏小，仅适合当次即时判断 */
      hoursLeft: hoursLeft,
      overdue: overdue,
      kind: t.milestone ? 'milestone' : (t.point ? 'point' : 'span'),
      crit: !!t.crit,
      owner: ownerBrief(ev),
      where: whereText,
      alert: dueText(daysLeft, time) + ' · ' + displayName,
      detail: dueTextLong(daysLeft, time, y, mo, da)
    };

    /* deadlines.json：只收「提醒窗口」内的条目（默认 30 天） */
    if (daysLeft <= WINDOW_DAYS && daysLeft >= -OVERDUE_GRACE_DAYS) items.push(rec);
    /* deadlines.ics：日历窗口更宽（默认 180 天），订阅一次可长期使用 */
    if (daysLeft <= ICS_WINDOW_DAYS && daysLeft >= -OVERDUE_GRACE_DAYS) icsItems.push(rec);
  });

  items.sort(function (a, b) {
    if (a.dueAt !== b.dueAt) return a.dueAt < b.dueAt ? -1 : 1;
    if (a.crit !== b.crit) return a.crit ? -1 : 1;
    return a.name < b.name ? -1 : 1;
  });

  const within24hItems = items.filter(function (it) { return it.hoursLeft <= 24; });

  /* 通道 C 的输入集合：只含「今天开始 + 显式填了开始时刻」的条目。
     时钟闹钟没有日期维度，非今天的条目会在今天同一时刻误响，所以必须由构建期先筛掉。
     快捷指令可以直接重复遍历 alarmItems（省掉「startDaysLeft = 0」那一道判断），
     但仍须保留「alarmAt 晚于当前日期」这一道 —— 那是运行时刻的判断，构建期无法代劳。
     注意 alarmItems 里可能含 alarmAt 已过点的条目（构建是 06:00/18:00 的快照），
     这一点与网页端 remAlarmCandidates 的实现一致：网页端会把已过点的实时剔除。 */
  const alarmItems = items.filter(function (it) { return it.startDaysLeft === 0 && it.alarmExact; });

  const out = {
    schema: 4,
    generatedAt: new Date(nowMs).toISOString(),
    timezone: 'Asia/Shanghai',
    windowDays: WINDOW_DAYS,
    icsWindowDays: ICS_WINDOW_DAYS,
    /* 通道 C 的提前量（分钟）：闹钟锚在「开始时刻 − 这个值」 */
    alarmLeadMin: ALARM_LEAD_MIN,
    /* 通道 C 闹钟标签的字段分隔符（名称｜地点｜起止） */
    alarmLabelSep: ALARM_LABEL_SEP,
    today: now.y + '-' + pad2(now.m) + '-' + pad2(now.d),
    count: items.length,

    /* ⚠️ 以下字段是「构建时刻」的快照，只在生成的瞬间准确。
       若消费方是在几小时后才读取，请改用 daysLeft（自然日，一天内稳定）
       或 dueAt（绝对时刻，可自行与当前时间求差）来做判断。 */
    within24h: within24hItems.length,
    within24hText: within24hItems.map(function (it) { return it.alert; }).join('\n'),

    /* 通道 C 专用：今天该建闹钟的条目（与 items 同结构，是 items 的子集） */
    alarmCount: alarmItems.length,
    alarmItems: alarmItems,

    /* 窗口内全部条目的汇总，换行分隔，可直接作为通知正文 */
    summary: items.map(function (it) { return it.alert; }).join('\n'),
    items: items
  };

  /* ---------- 同源产出可订阅的 .ics ----------
     为什么需要：静态网页发不出「系统级」通知（iOS 的 Critical Alert 需 Apple 审批，
     Web Push 只能发普通级别、且要加到主屏幕）。而把截止项写进系统日历后，到点由 iOS
     原生日历闹铃服务触发，能穿透静音与专注模式，且不依赖任何 App 或网页。
     用户在 iPhone 上一次订阅：设置 → 日历 → 账户 → 添加订阅日历 → 填下面的地址。 */
  const icsEvents = icsItems.map(function (it) {
    const startMs = Date.parse(it.startAt);
    const endMs = Date.parse(it.dueAt);
    /* 预响：默认提前 30 分钟，但不超过整段时间的一半，也绝不早于开始时刻 */
    const span = Math.max(60000, endMs - startMs);
    const pre = Math.max(60000, Math.min(30 * 60 * 1000, Math.round(span / 2)));
    const desc = [
      '阶段：' + (it.section || '—'),
      '起止：' + it.window,
      it.owner ? '负责班委：' + it.owner : '',
      it.where ? '地点：' + it.where : '',
      '来源：读研甘特图（软件2603班专属）'
    ].filter(Boolean).join('\n');
    return {
      uid: 'gantt-' + String(it.id).replace(/[^\w.-]/g, '') + '@mermaid-gantt-share',
      title: '⏰ 截止：' + it.name,
      startMs: Math.max(startMs, endMs - pre),
      endMs: endMs,
      desc: desc,
      location: it.where || '',
      alarmsMin: [0, -Math.round(pre / 60000)],
      alarmText: it.name
    };
  });
  const ics = icsEvents.length
    ? Ics.build(icsEvents, { calName: '软件2603 · 班务截止提醒' })
    : '';

  return { out: out, ics: ics, icsCount: icsEvents.length };
}

const built = build();
const result = built.out;
const outPath = path.join(ROOT, 'deadlines.json');
fs.writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n', 'utf8');

if (built.ics) {
  fs.writeFileSync(path.join(ROOT, 'deadlines.ics'), built.ics, 'utf8');
}

console.log('[build-deadlines] 已生成 deadlines.json' + (built.ics ? ' 与 deadlines.ics' : ''));
console.log('  基准日期（北京）：' + result.today);
console.log('  窗口：提醒 ' + WINDOW_DAYS + ' 天 / 日历 ' + ICS_WINDOW_DAYS + ' 天（逾期宽限 ' + OVERDUE_GRACE_DAYS + ' 天）');
console.log('  条目：' + result.count + ' 条，其中 24 小时内到期 ' + result.within24h + ' 条；日历事件 ' + built.icsCount + ' 条');
/* 通道 C 体检：只有「今天开始」且「显式填了开始时刻」的条目才可能建成闹钟 */
const alarmToday = result.alarmItems;
console.log('  通道 C 可建闹钟：' + alarmToday.length + ' 条（今天开始且有明确开始时刻，锚点 = 开始前 ' + ALARM_LEAD_MIN + ' 分钟）');
alarmToday.forEach(function (it) {
  console.log('   ⏰ ' + it.alarmTime + '  ' + it.alarmLabel);
});
const alarmSkipped = result.items.filter(function (it) { return it.startDaysLeft === 0 && !it.alarmExact; });
if (alarmSkipped.length) {
  console.log('   （今天开始但未填开始时刻，不建闹钟 —— 交给日历通道：' +
    alarmSkipped.map(function (it) { return it.name; }).join('、') + '）');
}
result.items.forEach(function (it) {
  console.log('   · [' + it.window + '] ' + it.alert + (it.overdue ? '  ⚠ 未标记 done' : ''));
});
if (result.count === 0) console.log('   （窗口内没有待办）');
