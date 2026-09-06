/*
 * admin.js —— 管理员 CRUD 支持（GitHub API 线上直写，双端 IIFE）
 *
 * 职责：把甘特图的时间线（gantt.md 的 mermaid 块）与班务详情（js/events.js）
 *       从渲染模型「序列化回源文件」，并通过 GitHub Contents API 写回仓库，
 *       实现「点开详情弹窗 → 增删改查 → 保存 → 全班刷新即见」。
 *
 * 安全模型：
 *   - 令牌（PAT）由管理员本人在浏览器输入，仅存于其本地 localStorage，绝不写入代码/仓库。
 *   - 未登录（无令牌）时，渲染端只读，不显示任何编辑入口。
 *   - 所有写操作走官方 REST API（api.github.com 支持 CORS）。
 *
 * 用法：GanttAdmin.serializeGantt(model) / serializeEvents(events) / getFile / putFile
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GanttAdmin = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var G = (typeof globalThis !== 'undefined') ? globalThis
    : (typeof self !== 'undefined' ? self : this);

  /* 目标仓库（与本项目 remote 一致） */
  var REPO = { owner: 'leo372239-1024', repo: 'mermaid-gantt-share', branch: 'main' };
  var API_BASE = 'https://api.github.com/repos/' + REPO.owner + '/' + REPO.repo + '/contents/';
  var TOKEN_KEY = 'gantt_admin_token';

  /* ---------- 日期工具（与 parser 保持一致） ---------- */
  var DAY = 86400000;
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function fmt(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function diffDays(a, b) { return Math.round((b - a) / DAY); }
  function parseDate(s) {
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(s).trim());
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3]);
  }

  /* ---------- 序列化：模型 → mermaid 块 ---------- */
  /* 单行任务：`名称 :状态, id, 开始, 结束|0d`
     状态按 milestone/crit/done/active 组合输出；end==start 时写 0d（单日/里程碑点）。 */
  function taskLine(t) {
    var sts = [];
    if (t.milestone) sts.push('milestone');
    if (t.crit) sts.push('crit');
    if (t.done) sts.push('done');
    if (t.active) sts.push('active');
    var st = sts.length ? sts.join(',') + ', ' : '';
    var start = fmt(t.start);
    var endPart = (t.end && diffDays(t.start, t.end) === 0) ? '0d' : fmt(t.end);
    return t.name + ' :' + st + t.id + ', ' + start + ', ' + endPart;
  }

  function serializeGantt(model) {
    var L = [];
    L.push('gantt');
    if (model.title) L.push('    title ' + model.title);
    L.push('    dateFormat YYYY-MM-DD');
    L.push('    axisFormat %Y-%m');
    model.sections.forEach(function (sec) {
      L.push('    section ' + sec.name);
      sec.tasks.forEach(function (t) { L.push('    ' + taskLine(t)); });
    });
    return L.join('\n');
  }

  /* ---------- 序列化：events 数据 → events.js 全文 ---------- */
  function jsStr(v) { return JSON.stringify(v == null ? '' : String(v)); }
  function jsArr(v) { return JSON.stringify(v && v.length ? v : []); }
  function ownersCall(owners) {
    var names = (owners || []).map(function (o) { return o.name; });
    return 'owners(' + JSON.stringify(names) + ')';
  }

  function serializeEvents(eventsData) {
    var roles = eventsData._roles || {};
    var keys = Object.keys(eventsData).filter(function (k) { return k !== '_roles'; })
      .sort(function (a, b) { return a.localeCompare(b, 'zh', { numeric: true }); });

    var out = [];
    out.push('/*');
    out.push(' * events.js —— 班务事件结构化详情（面向同学，数据来源：班务附件「表二 · 班群通知表」2026-09-03）');
    out.push(' *');
    out.push(' * key 与 gantt.md 中任务 id（b1..b9）一一对应。页面点击任务条/任务名后，');
    out.push(' * 会弹出本文件中对应 id 的结构化信息卡。');
    out.push(' *');
    out.push(' * 维护提示：班级事务有变化时，更新对应 id 的字段即可，无需改渲染代码。');
    out.push(' */');
    out.push('(function (root, factory) {');
    out.push("  if (typeof module === 'object' && module.exports) module.exports = factory();");
    out.push('  else root.BJTU_EVENTS = factory();');
    out.push("})(typeof self !== 'undefined' ? self : this, function () {");
    out.push("  'use strict';");
    out.push('');
    out.push('  /* 表零：班委名单（用于「负责班委」字段展示职务） */');
    /* roles 按「职务+姓名」紧凑排版，稳定可读 */
    var roleEntries = Object.keys(roles).map(function (n) {
      return '    ' + jsStr(n) + ': ' + jsStr(roles[n]);
    });
    out.push('  var ROLES = {');
    out.push(roleEntries.join(',\n'));
    out.push('  };');
    out.push('');
    out.push('  function owners(names) {');
    out.push('    return names.map(function (n) {');
    out.push("      return { name: n, role: ROLES[n] || '' };");
    out.push('    });');
    out.push('  }');
    out.push('');
    out.push('  return {');
    keys.forEach(function (k) {
      var e = eventsData[k] || {};
      out.push('    ' + k + ': {');
      out.push('      short: ' + jsStr(e.short) + ',');
      out.push('      who: ' + jsStr(e.who) + ',');
      out.push('      when: ' + jsStr(e.when) + ',');
      out.push('      where: ' + jsStr(e.where) + ',');
      out.push('      files: ' + jsStr(e.files) + ',');
      out.push('      steps: ' + jsArr(e.steps) + ',');
      out.push('      stepImg: ' + jsStr(e.stepImg) + ',');
      out.push('      attachments: ' + JSON.stringify(e.attachments && e.attachments.length ? e.attachments : []) + ',');
      out.push('      tips: ' + jsStr(e.tips) + ',');
      out.push('      sampleUrl: ' + jsStr(e.sampleUrl) + ',');
      out.push('      owners: ' + ownersCall(e.owners));
      out.push('    },');   /* 每个条目后必带逗号（_roles 恒在末尾） */
    });
    out.push('    _roles: ROLES');
    out.push('  };');
    out.push('});');
    out.push('');
    return out.join('\n');
  }

  /* ---------- Token 管理（浏览器） ---------- */
  function storage() {
    try { return G.localStorage; } catch (e) { return null; }
  }
  function getToken() {
    var s = storage();
    if (!s) return '';
    try { return s.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
  }
  function setToken(t) {
    var s = storage();
    if (!s) return false;
    try { s.setItem(TOKEN_KEY, t); return true; } catch (e) { return false; }
  }
  function clearToken() {
    var s = storage();
    if (!s) return false;
    try { s.removeItem(TOKEN_KEY); return true; } catch (e) { return false; }
  }
  function isLoggedIn() { return !!getToken(); }

  /* ---------- UTF-8 ↔ Base64 ---------- */
  function utf8ToB64(str) {
    var bytes = new TextEncoder().encode(str);
    var bin = '';
    bytes.forEach(function (b) { bin += String.fromCharCode(b); });
    return btoa(bin);
  }
  function b64ToUtf8(b64) {
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  /* ---------- GitHub API ---------- */
  function authHeaders() {
    var h = { 'Accept': 'application/vnd.github+json' };
    var t = getToken();
    if (t) h['Authorization'] = 'Bearer ' + t;
    return h;
  }

  /* 读文件：返回 { content: 解码后的文本, sha }（加时间戳 cache-busting，绕过 GitHub CDN 缓存避免拿到过期 sha） */
  function getFile(path) {
    return fetch(API_BASE + path + '?ref=' + REPO.branch + '&_=' + Date.now(), { headers: authHeaders(), cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) return res.json().then(function (j) { throw new Error('读取 ' + path + ' 失败：' + (j.message || res.status)); });
        return res.json();
      })
      .then(function (j) {
        return { content: b64ToUtf8(j.content), sha: j.sha };
      });
  }

  /* 写文件：content 为 UTF-8 文本，sha 为当前版本（防并发覆盖） */
  function putFile(path, content, sha, message) {
    var body = {
      message: message,
      content: utf8ToB64(content),
      branch: REPO.branch
    };
    if (sha) body.sha = sha;
    return fetch(API_BASE + path, {
      method: 'PUT',
      headers: Object.assign(authHeaders(), { 'Content-Type': 'application/json' }),
      body: JSON.stringify(body)
    }).then(function (res) {
      if (!res.ok) return res.json().then(function (j) { throw new Error('写入 ' + path + ' 失败：' + (j.message || res.status)); });
      return res.json();
    });
  }

  /* 资源直链：raw.githubusercontent 前缀拼装（path 需 encodeURIComponent 兼容中文文件名） */
  function rawUrl(p) {
    return 'https://raw.githubusercontent.com/' + REPO.owner + '/' + REPO.repo + '/' + REPO.branch + '/' +
      p.split('/').map(encodeURIComponent).join('/');
  }
  /* 通用资源上传：base64 原样写回仓库指定路径（UTF-8 转码会破坏二进制），返回 raw 直链 */
  function putAsset(p, b64, message) {
    return fetch(API_BASE + p, {
      method: 'PUT',
      headers: Object.assign(authHeaders(), { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        message: message || ('asset: ' + p),
        content: b64,
        branch: REPO.branch
      })
    }).then(function (res) {
      if (!res.ok) return res.json().then(function (j) { throw new Error('上传资源失败：' + (j.message || res.status)); });
      return rawUrl(p);
    });
  }
  /* 解析 dataUrl → { b64, ext, mime }；仅限图片与非图片通用（附件支持任意小文件） */
  function parseDataUrl(dataUrl) {
    var m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(String(dataUrl || ''));
    if (!m) return null;
    return { mime: m[1], b64: (m[2] ? m[3] : null), raw: !m[2] };
  }

  /* 图片上传到仓库 samples/ 并返回 raw 直链（供事件「提交材料参考示例」/「执行步骤图」使用）。
     文件名规则：{id}_{yyyyMMdd_HHmmss}{ext}，天然幂等且避免与他人并发重名。 */
  function putImage(id, dataUrl, message) {
    var m = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/.exec(String(dataUrl || ''));
    if (!m) return Promise.reject(new Error('图片格式不支持，仅支持 png/jpeg/gif/webp'));
    var ext = m[1] === 'image/jpeg' ? '.jpg' : m[1].replace('image/', '.');
    var now = new Date();
    function p2(n) { return n < 10 ? '0' + n : '' + n; }
    var p = 'samples/' + String(id).replace(/[^A-Za-z0-9_-]/g, '') + '_' +
      now.getFullYear() + p2(now.getMonth() + 1) + p2(now.getDate()) + '_' +
      p2(now.getHours()) + p2(now.getMinutes()) + p2(now.getSeconds()) + ext;
    return putAsset(p, m[2], message || ('sample: ' + p));
  }

  /* 附件上传到仓库 files/ 并返回 raw 直链（供「用到的文件材料等」多文件附件使用）。
     文件名规则：{id}_{yyyyMMdd_HHmmss}_{原始名}，中文名经 encodeURIComponent 后可访问可下载。 */
  function putAttachment(id, fileName, dataUrl, message) {
    var p = parseDataUrl(dataUrl);
    if (!p || !p.b64) return Promise.reject(new Error('附件数据格式无效'));
    var safeName = String(fileName || 'file').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
    var now = new Date();
    function p2(n) { return n < 10 ? '0' + n : '' + n; }
    var pth = 'files/' + String(id).replace(/[^A-Za-z0-9_-]/g, '') + '_' +
      now.getFullYear() + p2(now.getMonth() + 1) + p2(now.getDate()) + '_' +
      p2(now.getHours()) + p2(now.getMinutes()) + p2(now.getSeconds()) + '_' + safeName;
    return putAsset(pth, p.b64, message || ('file: ' + pth));
  }

  /* 验证令牌是否有效（读一个已知文件，contents:read 即可） */
  function validateToken(token) {
    var h = { 'Accept': 'application/vnd.github+json', 'Authorization': 'Bearer ' + token };
    return fetch(API_BASE + 'gantt.md?ref=' + REPO.branch, { headers: h, cache: 'no-store' })
      .then(function (res) {
        if (res.status === 401 || res.status === 403) throw new Error('令牌无效或无权限');
        if (!res.ok) throw new Error('验证请求失败：HTTP ' + res.status);
        return true;
      });
  }

  return {
    REPO: REPO,
    serializeGantt: serializeGantt,
    serializeEvents: serializeEvents,
    taskLine: taskLine,
    fmt: fmt,
    parseDate: parseDate,
    diffDays: diffDays,
    getToken: getToken,
    setToken: setToken,
    clearToken: clearToken,
    isLoggedIn: isLoggedIn,
    validateToken: validateToken,
    getFile: getFile,
    putFile: putFile,
    putImage: putImage,
    putAttachment: putAttachment,
    rawUrl: rawUrl
  };
});
