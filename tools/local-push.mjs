/*
 * local-push.mjs —— 把本地文件写回本地服务的数据库
 *
 * 用途：一次要改很多条时，先在本地把 gantt.md / js/events.js 改好，再整份写回，
 *       比在网页端逐条点更省事。写回会自动带上当前 sha（乐观并发保护）并记一条版本历史。
 *
 * 用法：
 *   node tools/local-push.mjs gantt.md
 *   node tools/local-push.mjs js/events.js --message "同步班务详情"
 *
 * 口令来源（按优先级）：环境变量 ADMIN_PASSWORD → 项目根目录 .env 里的 ADMIN_PASSWORD
 * 服务地址：环境变量 GANTT_BASE，默认 http://127.0.0.1:18080
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const argv = process.argv.slice(2);
const rel = argv.find(function (a) { return !a.startsWith('--'); });
const mi = argv.indexOf('--message');
const message = mi >= 0 ? argv[mi + 1] : ('local-push: ' + rel);

if (!rel) {
  console.error('用法: node tools/local-push.mjs <相对路径> [--message "说明"]');
  console.error('例如: node tools/local-push.mjs gantt.md --message "批量更新"');
  process.exit(1);
}

function readPassword() {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  const envPath = path.join(ROOT, '.env');
  if (fs.existsSync(envPath)) {
    const m = /^ADMIN_PASSWORD=(.+)$/m.exec(fs.readFileSync(envPath, 'utf8'));
    if (m) return m[1].trim();
  }
  return '';
}

const BASE = process.env.GANTT_BASE || 'http://127.0.0.1:18080';
const enc = function (p) { return p.split('/').map(encodeURIComponent).join('/'); };
const API = BASE + '/api/gh/repos/leo372239-1024/mermaid-gantt-share/contents/';

const abs = path.join(ROOT, rel);
if (!fs.existsSync(abs)) {
  console.error('本地文件不存在：' + abs);
  process.exit(1);
}
const content = fs.readFileSync(abs, 'utf8');

/* 1) 口令换令牌 */
const lr = await fetch(BASE + '/api/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: readPassword() })
});
if (!lr.ok) {
  console.error('登录失败（HTTP ' + lr.status + '）—— 检查 .env 里的 ADMIN_PASSWORD，以及服务是否在跑');
  process.exit(1);
}
const token = (await lr.json()).token;

/* 2) 取当前 sha（文件不存在时返回 404，sha 留空表示新建） */
let sha = null;
const gr = await fetch(API + enc(rel));
if (gr.ok) sha = (await gr.json()).sha;

/* 3) 写回 */
const pr = await fetch(API + enc(rel), {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
  body: JSON.stringify({
    message: message,
    content: Buffer.from(content, 'utf8').toString('base64'),
    sha: sha,
    branch: 'main'
  })
});

if (!pr.ok) {
  console.error('写入失败（HTTP ' + pr.status + '）：' + (await pr.text()));
  process.exit(1);
}

const out = await pr.json();
console.log('\u2713 已写入 ' + rel + '  →  sha ' + String(out.content.sha).slice(0, 10) + '\u2026');
console.log('  刷新 http://localhost:18080 即可看到最新内容。');
