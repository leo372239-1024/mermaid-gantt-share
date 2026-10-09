'use strict';

/*
 * db.js —— PostgreSQL 存储层
 *
 * 表结构见 schema.sql。核心约定：
 *   · files  表存文本文件（gantt.md / js/events.js），path 即主键；
 *   · assets 表存二进制（samples/*、files/*）；
 *   · 每次写文本都会往 revisions 追加一份快照，可回滚。
 *
 * 为什么 sha 要用 git blob 口径：
 *   前端 js/viewer.js 拿 getFile 返回的 sha 做「并发写保护」——保存前先读远端 sha，
 *   写回时带上它，不一致就说明远端在这期间被人改过（服务端返回 409，前端重取重试）。
 *   如果本地 sha 的算法和 GitHub 不一样，前端会永远认为「远端已变」而陷入重试。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const { mimeOf } = require('./mime');

const SITE_DIR = process.env.SITE_DIR || path.join(__dirname, '..');

const pool = new Pool({
  host: process.env.PGHOST || '127.0.0.1',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'gantt',
  user: process.env.PGUSER || 'gantt',
  password: process.env.PGPASSWORD || '',
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

pool.on('error', function (e) {
  console.error('[db] 空闲连接出错：', e.message);
});

/* git blob 的 SHA-1：sha1("blob " + 字节数 + "\0" + 内容) */
function gitBlobSha(buf) {
  const header = Buffer.from('blob ' + buf.length + '\0', 'utf8');
  return crypto.createHash('sha1').update(Buffer.concat([header, buf])).digest('hex');
}

/* ---------------- 文本文件 ---------------- */

async function getFile(p) {
  const r = await pool.query(
    'SELECT path, content, sha, updated_at FROM files WHERE path = $1', [p]);
  return r.rows[0] || null;
}

async function listFiles() {
  const r = await pool.query('SELECT path, sha, updated_at FROM files ORDER BY path');
  return r.rows;
}

/*
 * 写文本文件。expectSha 非空时做乐观并发校验：
 * 库里现有 sha 与它不一致 → 抛 SHA_MISMATCH（HTTP 层映射成 409）。
 */
async function putFile(p, content, expectSha, message) {
  const buf = Buffer.from(String(content), 'utf8');
  const sha = gitBlobSha(buf);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query('SELECT sha FROM files WHERE path = $1 FOR UPDATE', [p]);
    if (cur.rows.length && expectSha && cur.rows[0].sha !== expectSha) {
      await client.query('ROLLBACK');
      const err = new Error('远端内容已更新（sha 不匹配）');
      err.code = 'SHA_MISMATCH';
      throw err;
    }
    await client.query(
      'INSERT INTO files (path, content, sha, updated_at) VALUES ($1, $2, $3, now()) ' +
      'ON CONFLICT (path) DO UPDATE SET content = EXCLUDED.content, sha = EXCLUDED.sha, updated_at = now()',
      [p, String(content), sha]
    );
    await client.query(
      'INSERT INTO revisions (path, content, sha, message) VALUES ($1, $2, $3, $4)',
      [p, String(content), sha, message || null]
    );
    await client.query('COMMIT');
    return { path: p, sha: sha, size: buf.length };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* 连接已坏，忽略 */ }
    throw e;
  } finally {
    client.release();
  }
}

async function listRevisions(p, limit) {
  const r = await pool.query(
    'SELECT id, path, sha, message, created_at, length(content) AS size ' +
    'FROM revisions WHERE path = $1 ORDER BY created_at DESC LIMIT $2',
    [p, Math.min(Number(limit) || 50, 500)]);
  return r.rows;
}

/* ---------------- 二进制资源 ---------------- */

async function getAsset(p) {
  const r = await pool.query(
    'SELECT path, mime, bytes, size, sha, created_at FROM assets WHERE path = $1', [p]);
  return r.rows[0] || null;
}

async function listAssets() {
  const r = await pool.query('SELECT path, mime, size, sha, created_at FROM assets ORDER BY path');
  return r.rows;
}

async function putAsset(p, buf, mime, message) {
  const sha = gitBlobSha(buf);
  await pool.query(
    'INSERT INTO assets (path, mime, bytes, size, sha) VALUES ($1, $2, $3, $4, $5) ' +
    'ON CONFLICT (path) DO UPDATE SET mime = EXCLUDED.mime, bytes = EXCLUDED.bytes, ' +
    'size = EXCLUDED.size, sha = EXCLUDED.sha',
    [p, mime || mimeOf(p), buf, buf.length, sha]
  );
  return { path: p, sha: sha, size: buf.length };
}

/* ---------------- 初始化与种子导入 ---------------- */

/* 首次启动时把磁盘上的项目文件搬进数据库。
   只在表里「没有这条记录」时导入 —— 之后数据库就是唯一数据源，磁盘改动不再影响页面。 */
const SEED_TEXT = ['gantt.md', 'js/events.js'];
const SEED_DIRS = ['samples', 'files'];

async function seed() {
  let count = 0;

  for (const rel of SEED_TEXT) {
    const abs = path.join(SITE_DIR, rel);
    if (!fs.existsSync(abs)) continue;
    const exists = await pool.query('SELECT 1 FROM files WHERE path = $1', [rel]);
    if (exists.rows.length) continue;
    const content = fs.readFileSync(abs, 'utf8');
    await putFile(rel, content, null, 'seed: 首次启动从磁盘导入');
    console.log('[db] 种子导入文本 ' + rel + '（' + Buffer.byteLength(content, 'utf8') + ' 字节）');
    count++;
  }

  for (const dir of SEED_DIRS) {
    const absDir = path.join(SITE_DIR, dir);
    if (!fs.existsSync(absDir)) continue;
    let names;
    try { names = fs.readdirSync(absDir); } catch (_) { continue; }
    for (const name of names) {
      const rel = dir + '/' + name;
      const abs = path.join(absDir, name);
      let st;
      try { st = fs.statSync(abs); } catch (_) { continue; }
      if (!st.isFile()) continue;
      const exists = await pool.query('SELECT 1 FROM assets WHERE path = $1', [rel]);
      if (exists.rows.length) continue;
      const buf = fs.readFileSync(abs);
      await putAsset(rel, buf, mimeOf(name), 'seed');
      count++;
    }
    console.log('[db] 种子扫描目录 ' + dir + '/ 完成');
  }

  const inited = await pool.query("SELECT value FROM settings WHERE key = 'initialized_at'");
  if (!inited.rows.length) {
    await pool.query("INSERT INTO settings (key, value) VALUES ('initialized_at', $1)",
      [new Date().toISOString()]);
  }

  if (count) console.log('[db] 本次共导入 ' + count + ' 条种子数据');
  else console.log('[db] 数据已存在，跳过种子导入');
}

/* 等数据库就绪（容器编排里 db 可能比 app 晚几百毫秒才接受连接） */
async function waitReady(retries, delayMs) {
  const n = retries || 30;
  const d = delayMs || 1000;
  for (let i = 1; i <= n; i++) {
    try {
      await pool.query('SELECT 1');
      return true;
    } catch (e) {
      if (i === n) throw e;
      console.log('[db] 等待数据库就绪… (' + i + '/' + n + ') ' + e.message);
      await new Promise(function (r) { setTimeout(r, d); });
    }
  }
}

async function init() {
  await waitReady();
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);
  await seed();
}

module.exports = {
  pool: pool,
  gitBlobSha: gitBlobSha,
  getFile: getFile,
  listFiles: listFiles,
  putFile: putFile,
  listRevisions: listRevisions,
  getAsset: getAsset,
  listAssets: listAssets,
  putAsset: putAsset,
  init: init
};
