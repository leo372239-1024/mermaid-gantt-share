'use strict';

/*
 * validate-write.js —— 写入内容安全校验（纯函数，无任何依赖）
 *
 * 为什么单独一个文件：
 *   1) 它要在**宿主机**的单元测试里被直接 require（宿主机没装 pg，不能走 db.js 那条链）；
 *   2) 它是「数据源保护」这一职责的单一落点，服务端 gh-api.js 与测试共用同一份规则，
 *      避免「测试断言的和线上跑的不是一套」。
 *
 * 起因：2026-10-10 13:02 数据库里的 gantt.md 被一条**空内容写入**清空
 *   （files.content 变成 0 字符、sha = e69de29b ＝ git 空 blob 的 sha）。
 *   直接后果：/gantt.md 返回 0 字节、页面渲染成空白、
 *   /deadlines.json 报 HTTP 500「gantt.md 中未找到 ```mermaid 代码块」、提醒整块失效。
 *   当时服务端对写入内容没有任何校验 —— 空串照样落库。
 *
 * 设计原则：
 *   · 后端要防的是**结构性破坏**（数据源被清空 / 围栏丢失 / 语法坏掉），这些一眼可判，不可能误伤；
 *   · **故意的清空**走 allowEmpty 显式放行 —— 不靠猜用户意图；
 *   · 校验失败返回可操作的中文 reason，由前端原样弹进 toast。
 */

/*
 * @param {string} pathStr   仓库内路径（'gantt.md' / 'js/events.js' / …）
 * @param {string} text      本次要写入的文本
 * @param {string} prevText  该文件当前已有内容（不存在传空串）
 * @returns {{ok: boolean, reason?: string}}
 */
function validateWrite(pathStr, text, prevText) {
  const t = String(text == null ? '' : text);
  const prev = String(prevText == null ? '' : prevText);

  /* ---- 通用档 1：把本来有内容的文件写空 ---- */
  if (t.trim() === '' && prev.trim() !== '') {
    return {
      ok: false,
      reason: '拒绝写入空内容：' + pathStr + ' 原本有 ' + prev.length +
        ' 字符，本次写入为空。这通常是前端状态异常（页面数据没加载出来就点了保存）。' +
        '若确实要清空该文件，请显式带 allowEmpty。'
    };
  }

  /* ---- 通用档 2：缩水 >90%（比清空更隐蔽，破坏力一样）---- */
  if (prev.trim() !== '' && t.length > 0 && t.length < prev.length * 0.1) {
    return {
      ok: false,
      reason: '拒绝写入：' + pathStr + ' 内容从 ' + prev.length + ' 字符骤减到 ' + t.length +
        ' 字符（缩水超过 90%），疑似异常写入。若确为大幅删减，请显式带 allowEmpty。'
    };
  }

  /* ---- gantt.md：唯一的**时间线数据源**，必须有配平的 mermaid 围栏 ----
     围栏一旦丢失或损坏，页面渲染与 deadlines 生成会同时失效（正是本次事故的表现）。 */
  if (pathStr === 'gantt.md' && t.trim() !== '') {
    if (!/```mermaid/.test(t)) {
      return {
        ok: false,
        reason: '拒绝写入 gantt.md：内容里找不到 ```mermaid 代码块。' +
          '该文件是页面的唯一时间线数据源，缺少围栏会导致渲染与提醒同时失效。'
      };
    }
    const fences = (t.match(/^```/gm) || []).length;
    if (fences % 2 !== 0) {
      return {
        ok: false,
        reason: '拒绝写入 gantt.md：``` 代码围栏不配平（共 ' + fences + ' 个），文件结构已损坏。'
      };
    }
  }

  /* ---- js/events.js：必须是语法合法的模块 ----
     deadlines 生成时会在沙箱里 runInContext 求值；语法坏了整条提醒链路 500。
     这里只做**静态解析**（new Function 只编译不执行），既能查语法又不会真的跑用户代码。 */
  if (/^js\/events\.js$/.test(pathStr) && t.trim() !== '') {
    try {
      // eslint-disable-next-line no-new-func
      new Function(t);
    } catch (e) {
      return {
        ok: false,
        reason: '拒绝写入 js/events.js：语法错误（' + (e && e.message ? e.message : e) +
          '）。写入后会让提醒链路整体失效。'
      };
    }
  }

  return { ok: true };
}

module.exports = { validateWrite: validateWrite };
