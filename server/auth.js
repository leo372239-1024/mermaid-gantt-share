'use strict';

/*
 * auth.js —— 管理员口令与访问令牌
 *
 * 场景：服务监听 0.0.0.0，局域网内的手机/平板也能打开页面。
 * 「看」不需要登录（同学随便看），「改」必须带令牌。
 *
 * 令牌设计：<过期时间戳>.<HMAC 签名>，签名密钥由 ADMIN_PASSWORD 派生。
 *   · 不落库、不落文件，纯计算 → 无状态，重启服务后已发出的令牌依然有效；
 *   · 用 timingSafeEqual 比较，避免通过响应耗时逐字节猜口令。
 */

const crypto = require('crypto');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;   /* 令牌有效期 12 小时 */

function key() {
  return crypto.createHash('sha256')
    .update('gantt-local|' + ADMIN_PASSWORD, 'utf8')
    .digest();
}

function issue() {
  const exp = String(Date.now() + TOKEN_TTL_MS);
  const sig = crypto.createHmac('sha256', key()).update(exp).digest('base64url');
  return exp + '.' + sig;
}

function verify(token) {
  if (!token) return false;
  const s = String(token);
  const i = s.lastIndexOf('.');
  if (i <= 0) return false;
  const exp = s.slice(0, i);
  const sig = s.slice(i + 1);
  const expect = crypto.createHmac('sha256', key()).update(exp).digest('base64url');
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expect, 'utf8');
  if (a.length !== b.length) return false;
  if (!crypto.timingSafeEqual(a, b)) return false;
  const ts = Number(exp);
  return Number.isFinite(ts) && ts > Date.now();
}

function checkPassword(pw) {
  if (!ADMIN_PASSWORD) return false;
  const a = Buffer.from(String(pw == null ? '' : pw), 'utf8');
  const b = Buffer.from(ADMIN_PASSWORD, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = {
  issue: issue,
  verify: verify,
  checkPassword: checkPassword,
  hasPassword: !!ADMIN_PASSWORD
};
