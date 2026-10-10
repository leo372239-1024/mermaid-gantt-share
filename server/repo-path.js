'use strict';

/*
 * repo-path.js —— 仓库内路径归一化（纯函数，无任何依赖）
 *
 * 与 validate-write.js 同理单独成文件：要在**宿主机**单测里直接 require
 * （宿主机没有 pg，不能走 index.js → db.js 那条链），
 * 且保证「测试断言的和线上跑的是同一份规则」。
 *
 * 起因：2026-10-10 排查「保存后内容不见了」时发现，
 *   contents 路由用 /(.+)$/ 捕获路径，遇到
 *     /api/gh/repos/o/r/contents//gantt.md
 *   （客户端把 base 与文件名各自带斜杠拼起来）时，捕获到的是 '/gantt.md'。
 *   于是数据库里 'gantt.md' 与 '/gantt.md' 成了两条独立记录：
 *   前端读的是 'gantt.md'，写进去的却是 '/gantt.md' —— 表现就是
 *   「提示保存成功，但刷新后内容没变」，且真正受害的那条记录无人知晓。
 *   排查时还留下了 2 条 files + 4 条 revisions 脏数据需手工清理。
 *
 * 因此这里统一收敛：去前导/结尾斜杠、折叠重复斜杠、反斜杠视作分隔符，
 * 并拒绝空路径、'.'/'..' 段、控制字符。
 */

/*
 * @param {string} raw  从 URL 捕获到的原始路径片段（已 decodeURIComponent）
 * @returns {string}    归一化后的仓库内相对路径；**返回空串表示非法**
 */
function normalizeRepoPath(raw) {
  let p = String(raw == null ? '' : raw);

  /* 客户端可能用 Windows 风格路径拼接，反斜杠一律当分隔符 */
  p = p.replace(/\\/g, '/');
  /* 去掉所有前导斜杠（这是本次踩坑的直接修因） */
  p = p.replace(/^\/+/, '');
  /* 折叠重复斜杠 */
  p = p.replace(/\/{2,}/g, '/');
  /* 去掉结尾斜杠 */
  p = p.replace(/\/+$/, '');

  if (!p) return '';

  /* 逐段处理：
     · ''（空段，已折叠，此处兜底）→ 丢掉
     · '.'（当前目录）→ 丢掉，与 shell 语义一致（'./gantt.md' ≡ 'gantt.md'）
     · '..'（上级目录）→ **拒绝整个路径**，不做「弹栈」，避免 a/../b 这类歧义路径
       被静默改写成 b 之后绕过调用方的预期 */
  const segs = p.split('/');
  const out = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s === '..') return '';
    if (s === '' || s === '.') continue;
    out.push(s);
  }
  p = out.join('/');

  if (!p) return '';

  /* 挡掉 NUL 与控制字符，避免落库后难以排查 */
  if (/[\u0000-\u001f]/.test(p)) return '';

  return p;
}

module.exports = { normalizeRepoPath: normalizeRepoPath };
