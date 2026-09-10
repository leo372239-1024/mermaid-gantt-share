/*
 * test/unit.js —— 数据与解析器冒烟测试（Node 环境运行，无需安装依赖）
 *
 * 用法：node test/unit.js
 * 校验内容：
 *   1) gantt.md 能被解析器完整解析：section 数量 / 任务数量 / 0 致命告警
 *   2) 每个任务都有 start/end；全图时间范围正确（2026.8 ~ 2028.7）
 *   3) 任务 id 全局唯一；events.js 中 b1..b9 与 gantt 任务 id 一一对应
 *   4) events.js 字段完整性（who/when/where/files/steps/owners 等）
 *   5) viewer.js 模块可正常加载并暴露 mount
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const Parser = require(path.join(ROOT, 'js', 'parser.js'));
const Events = require(path.join(ROOT, 'js', 'events.js'));
const Viewer = require(path.join(ROOT, 'js', 'viewer.js'));

let failures = 0;
function check(cond, msg) {
  if (cond) console.log('  ✓ ' + msg);
  else { failures++; console.error('  ✗ ' + msg); }
}
function readGanttMd() {
  const md = fs.readFileSync(path.join(ROOT, 'gantt.md'), 'utf8');
  const re = /```mermaid\s*\n([\s\S]*?)\n```/g;
  const blocks = [];
  let m;
  while ((m = re.exec(md)) !== null) blocks.push(m[1].trim());
  if (!blocks.length) throw new Error('gantt.md 中未找到 ```mermaid 代码块');
  return blocks[0];
}

/* ---- 1. 解析 gantt.md ---- */
console.log('[1] gantt.md 解析');
const code = readGanttMd();
const model = Parser.parse(code);
check(!!model && !!model.range, '解析成功，得到有效时间范围');
check(model.sections.length === 8, '包含 8 个 section（实际 ' + model.sections.length + '）');
check(model.all.length >= 25, '任务总数 >= 25（实际 ' + model.all.length + '）');
const fatal = model.warnings.filter(w => /缺少有效日期|未能从代码中解析/.test(w));
check(fatal.length === 0, '无致命告警（日期缺失/无法解析）');
if (model.warnings.length) {
  console.log('  · 非致命提示 ' + model.warnings.length + ' 条：' + model.warnings.slice(0, 3).join(' | '));
}

/* ---- 2. 日期完整性 ---- */
console.log('[2] 日期完整性');
let noDate = 0, flipped = 0, pointMismatch = 0;
model.all.forEach(t => {
  if (!t.start || !t.end) noDate++;
  if (t.end < t.start) flipped++;
  if (t.point && t.end.getTime() !== t.start.getTime()) pointMismatch++;
});
check(noDate === 0, '每个任务都有 start/end（缺失 ' + noDate + '）');
check(flipped === 0, 'end >= start（反向 ' + flipped + '）');
check(pointMismatch === 0, 'point 任务 end == start（违反 ' + pointMismatch + '）');
const R = model.range;
check(R && R.start.getFullYear() === 2026, '全图起点在 2026 年（实际 ' + Parser.fmt(R.start) + '）');
check(R && R.end.getFullYear() === 2028 && R.end.getMonth() === 6, '全图终点 2028-07（实际 ' + Parser.fmt(R.end) + '）');

/* ---- 3. id 唯一性 + 班务 id 对齐 ---- */
console.log('[3] id 唯一性 & 班务对齐');
const seen = new Set(); let dup = 0;
model.all.forEach(t => { if (seen.has(t.id)) dup++; seen.add(t.id); });
check(dup === 0, '任务 id 全局唯一（重复 ' + dup + '）');
const evIds = Object.keys(Events).filter(k => /^b\d+$/.test(k)).sort();
check(evIds.length >= 1, 'events.js 提供班务条目 b*（当前 ' + evIds.length + ' 条）');
let missing = evIds.filter(id => !model.byId(id));
check(missing.length === 0, '全部班务 id 在甘特图中存在（缺失: ' + (missing.join(',') || '无') + '）');
let orphan = model.all.filter(t => /^b\d+$/.test(t.id) && !Events[t.id]).map(t => t.id);
check(orphan.length === 0, '甘特图中 b* 任务均有班务详情（孤儿: ' + (orphan.join(',') || '无') + '）');

/* ---- 4. events 字段完整性 ---- */
console.log('[4] 班务字段完整性');
/* 必填字段以「存在即合法」为准：用户在线新建条目可能未填全（files/steps 可选），
   硬性全集校验会误报。仅断言已有字段的结构合法（owners 结构 / steps 无空项）。 */
let badEv = 0;
evIds.forEach(id => {
  const ev = Events[id];
  if (!ev.short) { badEv++; console.error('    ' + id + ' 缺少 short'); }
  if (ev.steps && ev.steps.length && ev.steps.some(s => !s.trim())) { badEv++; console.error('    ' + id + ' steps 含空项'); }
  if (ev.owners && ev.owners.some(o => !o || !o.name)) { badEv++; console.error('    ' + id + ' owners 含非法项'); }
});
check(badEv === 0, '每个班务条目核心字段合法（short 必填，steps 无空项，owners 结构正确）');
check(evIds.every(id => Events[id].owners.every(o => o.name && typeof o.name === 'string')), 'owners 均为 {name[,role]} 结构');
check(typeof Events._roles === 'object' && Object.keys(Events._roles).length >= 7, '班委职务表 _roles 存在（≥7 人）');

/* ---- 5. viewer 模块可加载 ---- */
console.log('[5] viewer 模块');
check(!!Viewer && typeof Viewer.mount === 'function', 'viewer.js 暴露 GanttViewer.mount');
check(!!Parser.parse && !!Parser.fmt, 'parser.js 暴露 parse/fmt');

/* ---- 6. 序列化 round-trip（admin.js 写回 GitHub 前的安全阀） ---- */
console.log('[6] 序列化 round-trip');
const Admin = require(path.join(ROOT, 'js', 'admin.js'));
const serGantt = Admin.serializeGantt(model);
const model2 = Parser.parse(serGantt);
let fieldDiff = 0;
if (model.title !== model2.title) fieldDiff++;
if (model.sections.length !== model2.sections.length) fieldDiff++;
if (model.all.length !== model2.all.length) fieldDiff++;
model.all.forEach(t => {
  const t2 = model2.byId(t.id);
  if (!t2) { fieldDiff++; return; }
  ['milestone', 'crit', 'done', 'active', 'point'].forEach(f => { if (!!t[f] !== !!t2[f]) fieldDiff++; });
  if (Parser.fmt(t.start) !== Parser.fmt(t2.start)) fieldDiff++;
  if (Parser.fmt(t.end) !== Parser.fmt(t2.end)) fieldDiff++;
});
check(fieldDiff === 0, 'serializeGantt → parse 字段完全一致（' + model.all.length + ' 任务，无丢失/类型/日期漂移）');

const tmpPath = path.join(ROOT, 'test', '_events_tmp.js');
fs.writeFileSync(tmpPath, Admin.serializeEvents(Events), 'utf8');
const Events2 = require(tmpPath);
fs.unlinkSync(tmpPath);
const k1 = Object.keys(Events).filter(k => k !== '_roles').sort();
const k2 = Object.keys(Events2).filter(k => k !== '_roles').sort();
let evDiff = 0;
if (JSON.stringify(k1) !== JSON.stringify(k2)) evDiff++;
k1.forEach(id => {
  ['short', 'who', 'when', 'where', 'files', 'tips'].forEach(f => { if (Events[id][f] !== Events2[id][f]) evDiff++; });
  /* v17：sampleUrl 保持往返一致（默认 '' 也要一致） */
  if ((Events[id].sampleUrl || '') !== (Events2[id].sampleUrl || '')) evDiff++;
  /* v19：stepImg（单图）与 attachments（多附件）保持往返一致（默认空也要一致） */
  if ((Events[id].stepImg || '') !== (Events2[id].stepImg || '')) evDiff++;
  if (JSON.stringify(Events[id].attachments || []) !== JSON.stringify(Events2[id].attachments || [])) evDiff++;
  /* v20：tipsImg（备注单图）保持往返一致 */
  if ((Events[id].tipsImg || '') !== (Events2[id].tipsImg || '')) evDiff++;
  if (JSON.stringify(Events[id].steps) !== JSON.stringify(Events2[id].steps)) evDiff++;
  if (Events[id].owners.map(o => o.name).join(',') !== Events2[id].owners.map(o => o.name).join(',')) evDiff++;
});
const r1 = Object.keys(Events._roles).sort().join(',');
const r2 = Object.keys(Events2._roles).sort().join(',');
if (r1 !== r2) evDiff++;
check(evDiff === 0, 'serializeEvents → require 数据完全一致（含 owners / _roles，' + k1.length + ' 条）');
check(typeof Events2.b1.owners[0].role === 'string' && Events2.b1.owners[0].role.length > 0, '序列化后再 require，owners.role 由 owners() 自动补全');

/* ---- 7. ics.js 生成器（系统级日历闹铃） ---- */
console.log('[7] ics.js 生成器');
const Ics = require(path.join(ROOT, 'js', 'ics.js'));
const icsSample = Ics.build([{
  uid: 'gantt-x@test', title: '测试（中文；逗号,分号）', desc: '第一行\n第二行;含分隔符,',
  startMs: Date.parse('2026-09-10T06:00:00Z'),   /* 北京 14:00 */
  endMs: Date.parse('2026-09-10T09:00:00Z'),     /* 北京 17:00 */
  location: '主校区西操场', alarmsMin: [0, -30]
}], { calName: '测试日历' });
check(/^BEGIN:VCALENDAR\r\n/.test(icsSample) && /END:VCALENDAR\r\n$/.test(icsSample), '以 BEGIN/END:VCALENDAR 包裹且 CRLF 结尾');
check((icsSample.match(/BEGIN:VEVENT/g) || []).length === 1, '1 个 VEVENT');
check((icsSample.match(/BEGIN:VALARM/g) || []).length === 2, '2 个 VALARM（到点 + 提前 30 分钟）');
check(icsSample.indexOf('DTSTART;TZID=Asia/Shanghai:20260910T140000') >= 0, 'DTSTART 按固定 +0800 输出 14:00（不随运行环境时区漂移）');
check(icsSample.indexOf('DTEND;TZID=Asia/Shanghai:20260910T170000') >= 0, 'DTEND 按固定 +0800 输出 17:00');
check(icsSample.indexOf('TRIGGER;VALUE=DATE-TIME:20260910T090000Z') >= 0, '到点 VALARM 用绝对 UTC 触发时刻');
check(icsSample.indexOf('TRIGGER;VALUE=DATE-TIME:20260910T083000Z') >= 0, '提前 30 分钟的 VALARM 用绝对 UTC 触发时刻');
check(icsSample.indexOf('第一行\\n第二行\\;含分隔符\\,') >= 0, '换行/分号/逗号按 RFC 5545 转义');
check(icsSample.split('\r\n').filter(l => Buffer.byteLength(l, 'utf8') > 75).length === 0, '折行后每行 ≤75 octets（中文不劈开）');
check(Ics.build([], {}).indexOf('BEGIN:VEVENT') < 0, '空事件列表不产生 VEVENT');

/* ---- 8. 分钟级时间口径（标题 / 左侧列表 / ddl 提醒共用同一套） ---- */
console.log('[8] 分钟级时间口径');
const t25 = model.byId('t25');     /* 文艺汇演领票 2026-09-10 14:00 → 17:00 */
const b7 = model.byId('b7');       /* 交大人节文艺晚会 18:45（起止同刻） */
const b3 = model.byId('b3');       /* 校外住宿登记承诺书 2026-09-13 单日点（无时刻） */
check(Viewer.rangeCN(t25) === '9.10 14:00 至 9.10 17:00', '标题时间精确到分钟（实际「' + Viewer.rangeCN(t25) + '」）');
check(Viewer.captionOf(t25) === '文艺汇演领票（9.10 14:00 至 9.10 17:00）', '完整标题形如「名称（起 至 止）」（实际「' + Viewer.captionOf(t25) + '」）');
check(Viewer.rangeCN(b7) === '9.10 18:45', '起止同刻只显示一次（实际「' + Viewer.rangeCN(b7) + '」）');
check(Viewer.rangeCN(b3) === '9.13', '未填时刻的条目保持纯日期（实际「' + Viewer.rangeCN(b3) + '」）');
check(Viewer.hmOf('9:5') === '09:05' && Viewer.hmOf('') === '', '时刻归一：9:5→09:05，空值→空');

/* ---- 9. 生成物口径一致（deadlines.json ↔ deadlines.ics） ---- */
console.log('[9] 生成物口径一致');
const dj = JSON.parse(fs.readFileSync(path.join(ROOT, 'deadlines.json'), 'utf8'));
check(dj.schema === 2, 'deadlines.json schema = 2（新增分钟级 start/due/window 字段）');
const w25 = dj.items.filter(i => i.id === 't25')[0];
check(!!w25 && w25.time === '17:00', '截止时刻精确到分钟 time=' + (w25 && w25.time));
check(!!w25 && w25.window === '9.10 14:00 → 9.10 17:00', '起止文案分钟级 window=' + (w25 && w25.window));
check(!!w25 && Date.parse(w25.dueAt) === Date.parse('2026-09-10T09:00:00Z'), 'dueAt = 北京时间 17:00 的绝对时刻');
const b2it = dj.items.filter(i => i.id === 'b2')[0];
check(!!b2it && b2it.due === '2026-09-09', 'b2 户口迁移证截止口径 = 日期组件的 2026-09-09');
const icsPath = path.join(ROOT, 'deadlines.ics');
check(fs.existsSync(icsPath), 'deadlines.ics 已生成（可订阅的系统日历源）');
if (fs.existsSync(icsPath)) {
  const icsTxt = fs.readFileSync(icsPath, 'utf8');
  const nEv = (icsTxt.match(/BEGIN:VEVENT/g) || []).length;
  check(nEv >= dj.count - 1, 'ics 事件数 ≥ 提醒窗口条目数（' + nEv + ' vs ' + dj.count + '）');
  check(nEv === (icsTxt.match(/END:VEVENT/g) || []).length, 'VEVENT 开闭标签配平');
  check((icsTxt.match(/BEGIN:VALARM/g) || []).length === nEv * 2, '每条事件恰好 2 个 VALARM');
}

/* ---- 10. 防误删闸门（过期快照体检） ---- */
console.log('[10] 保存前的「过期快照」体检');
/* 用真实 events.js 源码当作"远端"内容，用序列化产物当作"本地"内容 → 无漂移 */
const realSrc = fs.readFileSync(path.join(ROOT, 'js', 'events.js'), 'utf8');
const keysAll = Viewer.evKeysOf(realSrc);
check(keysAll.length >= 5 && keysAll.indexOf('b7') >= 0, '从 events.js 源码提取到顶层班务 key（' + keysAll.join(',') + '）');
check(keysAll.indexOf('_roles') < 0, '提取时排除 _roles（它不是班务条目）');
check(keysAll.indexOf('short') < 0 && keysAll.indexOf('who') < 0, '不受缩进 6 空格的嵌套字段干扰');
check(Viewer.evDriftKeys(realSrc, Events).length === 0, '本地与远端一致时漂移为空（不会误弹确认框）');
/* 模拟"本页 events 来自缓存的旧文件"：删掉 b7 → 必须被识别为「会被误删的条目」 */
const stale = JSON.parse(JSON.stringify(Events));
delete stale.b7;
check(Viewer.evDriftKeys(realSrc, stale).join(',') === 'b7', '本地缺 b7 时能识别出漂移 b7（本次真实事故场景）');
check(Viewer.evDriftKeys('', Events).length === 0, '远端内容为空时不误报');
check(Viewer.evDriftKeys(realSrc, null).length === 0, '无本地 events 时不误报');

console.log(failures ? '\n结果：' + failures + ' 项失败 ❌' : '\n结果：全部通过 ✅');
process.exit(failures ? 1 : 0);
