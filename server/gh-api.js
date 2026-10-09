'use strict';

/*
 * gh-api.js —— GitHub Contents API 的本地兼容层
 *
 * 为什么要有这一层：
 *   前端 js/admin.js 原本直连 api.github.com（读 gantt.md、写回 gantt.md / js/events.js、
 *   上传 samples/ 与 files/ 资源）。本地化最省事、最不容易引入回归的做法，
 *   不是去改前端的业务逻辑，而是**保持 URL 形状与响应字段完全一致**，
 *   只把域名换成 http://127.0.0.1:18080。前端于是几乎零改动。
 *
 * 路径分流规则（沿用本项目的既有约定）：
 *   samples/**  与  files/**  → 二进制，进 assets 表
 *   其余（gantt.md、js/events.js） → 文本，进 files 表
 */

const db = require('./db');

function isAssetPath(p) {
  return /^(samples|files)\//.test(String(p || ''));
}

function baseName(p) {
  const s = String(p);
  const i = s.lastIndexOf('/');
  return i < 0 ? s : s.slice(i + 1);
}

/* 读：返回 GitHub 形状的 { name, path, sha, size, content(base64), encoding } */
async function read(pathStr) {
  if (isAssetPath(pathStr)) {
    const a = await db.getAsset(pathStr);
    if (!a) return null;
    return {
      name: baseName(pathStr),
      path: pathStr,
      sha: a.sha,
      size: a.size,
      type: 'file',
      encoding: 'base64',
      content: a.bytes.toString('base64')
    };
  }
  const f = await db.getFile(pathStr);
  if (!f) return null;
  const buf = Buffer.from(f.content, 'utf8');
  return {
    name: baseName(pathStr),
    path: pathStr,
    sha: f.sha,
    size: buf.length,
    type: 'file',
    encoding: 'base64',
    content: buf.toString('base64')
  };
}

/* 写：content 是 base64（与 GitHub API 一致），sha 可选（乐观并发校验） */
async function write(pathStr, base64Content, sha, message) {
  const buf = Buffer.from(String(base64Content || ''), 'base64');
  if (isAssetPath(pathStr)) {
    const r = await db.putAsset(pathStr, buf, null, message);
    return { path: pathStr, sha: r.sha, size: r.size };
  }
  const r = await db.putFile(pathStr, buf.toString('utf8'), sha, message);
  return { path: pathStr, sha: r.sha, size: r.size };
}

module.exports = {
  isAssetPath: isAssetPath,
  read: read,
  write: write
};
