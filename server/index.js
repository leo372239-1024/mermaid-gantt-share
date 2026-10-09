'use strict';

/*
 * index.js —— 本地服务主入口
 *
 * 一个进程干四件事：
 *   ① 静态托管前端（index.html / js / fonts / vendor …）—— 来自挂载的只读目录 /site；
 *   ② 提供 GitHub Contents API 的兼容端点（/api/gh/repos/:owner/:repo/contents/:path）
 *      —— 前端 js/admin.js 只改了一个域名常量就完成迁移；
 *   ③ 提供 /raw/* 资源直链（图片、附件）；
 *   ④ 运行期现算 /deadlines.json 与 /deadlines.ics，取代原来的 GitHub Actions 构建。
 *
 * 读接口不需要登录（局域网内同学可以直接看），写接口需要管理员令牌。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const db = require('./db');
const auth = require('./auth');
const gh = require('./gh-api');
const deadlines = require('./deadlines');
const { mimeOf } = require('./mime');

const PORT = Number(process.env.PORT || 18080);
const HOST = process.env.HOST || '0.0.0.0';
const SITE_DIR = path.resolve(process.env.SITE_DIR || path.join(__dirname, '..'));

/* 这些路径由数据库供应（而不是磁盘上的同名文件）。
   数据库是运行期的唯一数据源；磁盘上的那份只在首次启动时当种子。 */
const DB_TEXT_ROUTES = {
  '/gantt.md': 'gantt.md',
  '/js/events.js': 'js/events.js'
};

/* ---------------- 响应辅助 ---------------- */

function sendText(res, status, text, ctype, extra) {
  const buf = Buffer.from(String(text == null ? '' : text), 'utf8');
  res.writeHead(status, Object.assign({
    'Content-Type': ctype || 'text/plain; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store'
  }, extra || {}));
  res.end(buf);
}

function sendJson(res, status, obj, extra) {
  const s = JSON.stringify(obj);
  const buf = Buffer.from(s, 'utf8');
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store'
  }, extra || {}));
  res.end(buf);
}

function sendBuf(res, status, buf, ctype, extra) {
  res.writeHead(status, Object.assign({
    'Content-Type': ctype || 'application/octet-stream',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store'
  }, extra || {}));
  res.end(buf);
}

function readBody(req, limit) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    let n = 0;
    const max = limit || 32 * 1024 * 1024;
    req.on('data', function (c) {
      n += c.length;
      if (n > max) {
        reject(new Error('请求体过大（上限 ' + Math.round(max / 1048576) + ' MB）'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', function () { resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

/* ---------------- 认证 ---------------- */

function bearer(req) {
  const h = String(req.headers['authorization'] || '');
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : '';
}
function isAuthed(req) {
  return auth.verify(bearer(req));
}

/* ---------------- 静态文件 ---------------- */

function serveStatic(res, urlPath) {
  let rel = String(urlPath || '').replace(/^\/+/, '');
  if (rel === '') rel = 'index.html';

  const abs = path.resolve(SITE_DIR, rel);
  /* 防目录穿越：解析后的绝对路径必须仍在 SITE_DIR 之内 */
  if (abs !== SITE_DIR && !abs.startsWith(SITE_DIR + path.sep)) {
    return sendText(res, 403, '403 Forbidden');
  }

  fs.stat(abs, function (err, st) {
    if (!err && st.isDirectory()) {
      return serveStatic(res, rel.replace(/\/?$/, '/') + 'index.html');
    }
    if (err || !st.isFile()) {
      return sendText(res, 404, '404 Not Found');
    }
    fs.readFile(abs, function (e2, buf) {
      if (e2) return sendText(res, 500, '500 ' + e2.message);
      res.writeHead(200, {
        'Content-Type': mimeOf(abs),
        'Content-Length': buf.length,
        'Last-Modified': st.mtime.toUTCString(),
        /* no-cache = 允许缓存但每次回源校验。本地服务回源成本极低，
           换来的是「改完前端代码刷新即生效」，不必手动清缓存。 */
        'Cache-Control': 'no-cache'
      });
      res.end(buf);
    });
  });
}

/* ---------------- deadlines 短缓存 ---------------- */
/* 现算一次约几毫秒，但页面可能被多端同时拉取，5 秒缓存足够且不会让人感到延迟。 */
let dlCache = { at: 0, data: null };
async function buildDeadlines() {
  const now = Date.now();
  if (dlCache.data && now - dlCache.at < 5000) return dlCache.data;
  const d = await deadlines.build();
  dlCache = { at: now, data: d };
  return d;
}

/* ---------------- 路由 ---------------- */

const server = http.createServer(async function (req, res) {
  const method = String(req.method || 'GET').toUpperCase();
  let url;
  try {
    url = new URL(req.url, 'http://' + (req.headers.host || '127.0.0.1'));
  } catch (e) {
    return sendText(res, 400, '400 Bad Request');
  }

  let pathname;
  try { pathname = decodeURIComponent(url.pathname); }
  catch (e) { pathname = url.pathname; }

  try {
    /* --- 健康检查（compose healthcheck 用） --- */
    if (pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, time: new Date().toISOString() });
    }

    /* --- 管理员登录：口令换令牌 --- */
    if (pathname === '/api/login' && method === 'POST') {
      if (!auth.hasPassword) {
        return sendJson(res, 500, { message: '服务端未配置 ADMIN_PASSWORD' });
      }
      let pw = '';
      try { pw = (JSON.parse(await readBody(req, 64 * 1024)) || {}).password || ''; }
      catch (e) { pw = ''; }
      if (!auth.checkPassword(pw)) {
        return sendJson(res, 401, { message: '口令不正确' });
      }
      return sendJson(res, 200, { token: auth.issue() });
    }

    /* --- 会话校验 --- */
    if (pathname === '/api/session') {
      const ok = isAuthed(req);
      return sendJson(res, ok ? 200 : 401, { ok: ok });
    }

    /* --- GitHub Contents API 兼容层 --- */
    const m = /^\/api\/gh\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/.exec(pathname);
    if (m) {
      const filePath = m[3];

      if (method === 'GET') {
        const doc = await gh.read(filePath);
        if (!doc) return sendJson(res, 404, { message: 'Not Found: ' + filePath });
        return sendJson(res, 200, doc);
      }

      if (method === 'PUT' || method === 'POST') {
        if (!isAuthed(req)) {
          return sendJson(res, 401, { message: '未登录或登录已过期，请重新登录' });
        }
        let payload;
        try { payload = JSON.parse(await readBody(req, 64 * 1024 * 1024)); }
        catch (e) { return sendJson(res, 400, { message: '请求体不是合法 JSON' }); }

        const r = await gh.write(filePath, payload.content, payload.sha, payload.message);
        /* 写完即让 deadlines 缓存失效，保证「改完立刻看到新提醒」 */
        dlCache = { at: 0, data: null };
        return sendJson(res, 200, {
          content: { path: r.path, sha: r.sha, size: r.size },
          commit: { message: payload.message || '', sha: r.sha }
        });
      }

      return sendJson(res, 405, { message: 'Method Not Allowed' });
    }

    /* --- 资源直链（前端 rawUrl() 指向这里） --- */
    if (pathname.startsWith('/raw/')) {
      const rel = pathname.slice('/raw/'.length);
      const a = await db.getAsset(rel);
      if (!a) return sendText(res, 404, '404 Not Found');
      return sendBuf(res, 200, a.bytes, a.mime, { 'Cache-Control': 'no-cache' });
    }

    /* --- 版本历史（可选查询接口，便于日后做「回滚到某版」） --- */
    if (pathname === '/api/revisions') {
      const p = url.searchParams.get('path') || 'gantt.md';
      const rows = await db.listRevisions(p, url.searchParams.get('limit'));
      return sendJson(res, 200, { path: p, items: rows });
    }

    /* --- deadlines：运行期现算，取代 GitHub Actions --- */
    if (pathname === '/deadlines.json') {
      const built = await buildDeadlines();
      return sendJson(res, 200, built.out, { 'Cache-Control': 'no-cache' });
    }
    if (pathname === '/deadlines.ics') {
      const built = await buildDeadlines();
      return sendText(res, 200, built.ics || '', 'text/calendar; charset=utf-8',
        { 'Cache-Control': 'no-cache' });
    }

    /* --- 数据库供应的文本文件（必须在静态之前） --- */
    if (DB_TEXT_ROUTES[pathname] && method === 'GET') {
      const f = await db.getFile(DB_TEXT_ROUTES[pathname]);
      if (!f) return sendText(res, 404, '404 Not Found');
      return sendText(res, 200, f.content, mimeOf(pathname));
    }

    /* --- 其余一律静态 --- */
    if (method === 'GET' || method === 'HEAD') {
      return serveStatic(res, pathname);
    }

    return sendText(res, 405, '405 Method Not Allowed');
  } catch (e) {
    if (e && e.code === 'SHA_MISMATCH') {
      return sendJson(res, 409, { message: e.message });
    }
    console.error('[http] ' + method + ' ' + pathname + ' 出错：', e);
    return sendJson(res, 500, { message: String((e && e.message) || e) });
  }
});

/* ---------------- 启动 ---------------- */

(async function main() {
  console.log('[server] 正在初始化数据库…');
  await db.init();

  server.listen(PORT, HOST, function () {
    console.log('[server] 已启动 → http://127.0.0.1:' + PORT);
    console.log('[server] 局域网访问 → http://<本机IP>:' + PORT);
    console.log('[server] 静态目录 → ' + SITE_DIR);
    console.log('[server] 管理员口令 → ' + (auth.hasPassword ? '已配置' : '未配置（无法登录）'));
  });
})().catch(function (e) {
  console.error('[server] 启动失败：', e);
  process.exit(1);
});

/* 容器收到 stop 信号时优雅退出，避免连接被硬切 */
['SIGTERM', 'SIGINT'].forEach(function (sig) {
  process.on(sig, function () {
    console.log('[server] 收到 ' + sig + '，正在关闭…');
    server.close(function () {
      db.pool.end().then(function () { process.exit(0); }).catch(function () { process.exit(0); });
    });
    setTimeout(function () { process.exit(0); }, 5000).unref();
  });
});
