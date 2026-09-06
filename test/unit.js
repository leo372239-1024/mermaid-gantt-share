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
check(model.all.length >= 40, '任务总数 >= 40（实际 ' + model.all.length + '）');
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
check(R && R.start.getFullYear() === 2026 && R.start.getMonth() === 7, '全图起点 2026-08（实际 ' + Parser.fmt(R.start) + '）');
check(R && R.end.getFullYear() === 2028 && R.end.getMonth() === 6, '全图终点 2028-07（实际 ' + Parser.fmt(R.end) + '）');

/* ---- 3. id 唯一性 + 班务 id 对齐 ---- */
console.log('[3] id 唯一性 & 班务对齐');
const seen = new Set(); let dup = 0;
model.all.forEach(t => { if (seen.has(t.id)) dup++; seen.add(t.id); });
check(dup === 0, '任务 id 全局唯一（重复 ' + dup + '）');
const evIds = Object.keys(Events).filter(k => /^b\d+$/.test(k)).sort();
check(evIds.length === 9, 'events.js 提供 9 个班务条目 b1..b9');
let missing = evIds.filter(id => !model.byId(id));
check(missing.length === 0, '全部班务 id 在甘特图中存在（缺失: ' + (missing.join(',') || '无') + '）');
let orphan = model.all.filter(t => /^b\d+$/.test(t.id) && !Events[t.id]).map(t => t.id);
check(orphan.length === 0, '甘特图中 b* 任务均有班务详情（孤儿: ' + (orphan.join(',') || '无') + '）');

/* ---- 4. events 字段完整性 ---- */
console.log('[4] 班务字段完整性');
const REQUIRED = ['short', 'who', 'when', 'where', 'files', 'steps', 'owners'];
let badEv = 0;
evIds.forEach(id => {
  const ev = Events[id];
  REQUIRED.forEach(f => { if (!ev[f] || (Array.isArray(ev[f]) && !ev[f].length)) { badEv++; console.error('    ' + id + ' 缺少字段 ' + f); } });
  if (ev.steps && ev.steps.length && ev.steps.some(s => !s.trim())) { badEv++; console.error('    ' + id + ' steps 含空项'); }
});
check(badEv === 0, '每个班务条目含完整必填字段（short/who/when/where/files/steps/owners）');
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
  if (JSON.stringify(Events[id].steps) !== JSON.stringify(Events2[id].steps)) evDiff++;
  if (Events[id].owners.map(o => o.name).join(',') !== Events2[id].owners.map(o => o.name).join(',')) evDiff++;
});
const r1 = Object.keys(Events._roles).sort().join(',');
const r2 = Object.keys(Events2._roles).sort().join(',');
if (r1 !== r2) evDiff++;
check(evDiff === 0, 'serializeEvents → require 数据完全一致（含 owners / _roles，' + k1.length + ' 条）');
check(typeof Events2.b1.owners[0].role === 'string' && Events2.b1.owners[0].role.length > 0, '序列化后再 require，owners.role 由 owners() 自动补全');

console.log(failures ? '\n结果：' + failures + ' 项失败 ❌' : '\n结果：全部通过 ✅');
process.exit(failures ? 1 : 0);
