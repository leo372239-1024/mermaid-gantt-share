'use strict';

/*
 * deadlines.js —— 运行期生成 deadlines.json / deadlines.ics
 *
 * 线上版靠 GitHub Actions 在 push 后跑 tools/build-deadlines.js 生成这两个文件，
 * 存在「改完要等 CI」的延迟。本地版直接在请求时现算：
 *   gantt.md（数据库） + js/events.js（数据库） → deadlines.json / .ics
 *
 * 复用 tools/build-deadlines.js 里的全部口径（时区、窗口、闹钟提前量、dueToday 判定…），
 * 只是把「数据从哪来」改成可注入 —— 避免本地与线上两套算法漂移。
 */

const path = require('path');
const vm = require('vm');
const db = require('./db');

const SITE_DIR = process.env.SITE_DIR || path.join(__dirname, '..');
const builder = require(path.join(SITE_DIR, 'tools', 'build-deadlines.js'));

/* 从 gantt.md 全文里取第一个 ```mermaid 代码块（与 index.html 的 FENCE_RE 同口径） */
function extractMermaid(md) {
  const re = /```mermaid\s*\n([\s\S]*?)\n```/g;
  const blocks = [];
  let m;
  while ((m = re.exec(String(md || ''))) !== null) blocks.push(m[1].trim());
  if (!blocks.length) throw new Error('gantt.md 中未找到 ```mermaid 代码块');
  return blocks[0];
}

/*
 * 在沙箱里求值 events.js 源码，拿到 BJTU_EVENTS 对象。
 * 为什么不直接 require：events.js 在这个项目里就是数据本身，运行期会被网页端改写；
 * require 有模块缓存，改完不会生效。每次取数据库里的最新源码重新求值才实时。
 * 该文件是 UMD 包装（typeof module === 'object' 时走 module.exports），所以给个 module 即可。
 */
function evalEvents(src) {
  const mod = { exports: {} };
  const sandbox = { module: mod, exports: mod.exports, console: console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(String(src), sandbox, { filename: 'js/events.js', timeout: 5000 });
  return mod.exports || {};
}

async function build() {
  const gantt = await db.getFile('gantt.md');
  if (!gantt) throw new Error('数据库里还没有 gantt.md');
  const eventsFile = await db.getFile('js/events.js');

  return builder.build({
    ganttCode: extractMermaid(gantt.content),
    events: eventsFile ? evalEvents(eventsFile.content) : {}
  });
}

module.exports = {
  build: build,
  extractMermaid: extractMermaid
};
