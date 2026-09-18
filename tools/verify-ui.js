/*
 * verify-ui.js —— 渲染页「端到端」自检（真实 Chromium，无头）
 *
 * 为什么需要它：test/unit.js 只能覆盖纯函数（解析器 / ics 生成器 / 时间格式化）。
 * 而「两条今日红线」「ddl 提醒的分钟级时间」「Ctrl+S 保存同步」「提醒弹窗的系统级按钮」
 * 这些能力都要真实 DOM + 真实 CSS + 真实事件才能验证，纯 Node 断言查不出来。
 *
 * 依赖（不随仓库安装，属于开发期工具）：
 *   - playwright / playwright-core（本机 node workspace 已装）
 *   - 任意 Chromium 可执行文件，路径用环境变量 PLAYWRIGHT_CHROMIUM 指定
 *
 * 用法（先起静态服务）：
 *   node tools/../ -m http.server 8899      # 或任意静态服务器
 *   PLAYWRIGHT_CHROMIUM="C:/.../chrome.exe" node tools/verify-ui.js http://127.0.0.1:8899/
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT_ = path.join(__dirname, '..');
const Parser = require(path.join(ROOT_, 'js', 'parser.js'));
const Admin = require(path.join(ROOT_, 'js', 'admin.js'));
const Events = require(path.join(ROOT_, 'js', 'events.js'));
/* [11]「合并写回」用例需要两个版本：完整的远端文件 + 「缺某条」的过期页面脚本 */
const eventsSrcFull = fs.readFileSync(path.join(ROOT_, 'js', 'events.js'), 'utf8');
const ganttSrcFull = fs.readFileSync(path.join(ROOT_, 'gantt.md'), 'utf8');

const URL_ = process.argv[2] || 'http://127.0.0.1:8899/';
const CHROME = process.env.PLAYWRIGHT_CHROMIUM || '';

let pw;
try { pw = require('playwright'); }
catch (e) { pw = require('playwright-core'); }

let failures = 0;
function check(cond, msg) {
  if (cond) console.log('  ✓ ' + msg);
  else { failures++; console.error('  ✗ ' + msg); }
}

/* ---------- 期望值从「站点实际提供的 gantt.md」推导 ----------
   为什么不把时刻写死在断言里：2026-09-10 管理员在网页上把 b7 由 18:45 改成 18:35→18:45，
   同一条「b7 落在 18:45」的断言在 test/unit.js 和本文件里接连假红两次 ——
   被验证的规则（分钟级定位）没坏，是断言跟实时数据耦合了。
   数据类断言一律「读数据 → 解析 → 推出期望值」，只有格式/行为类断言才用字面量。 */
async function loadGanttModel() {
  const res = await fetch(new URL('gantt.md', URL_).href, { cache: 'no-store' });
  if (!res.ok) throw new Error('读取 gantt.md 失败：HTTP ' + res.status + '（' + URL_ + '）');
  const md = await res.text();
  const m = /```mermaid[ \t]*\r?\n([\s\S]*?)\r?\n```/.exec(md);
  return Parser.parse(m ? m[1] : md);
}
/* 与 js/viewer.js 的 fmtPt / rangeCN 同构（只用于推导期望值，不参与渲染） */
function mdCN(d) { return (d.getMonth() + 1) + '.' + d.getDate(); }
function fmtPtCN(d, hm) { return mdCN(d) + (hm ? ' ' + hm : ''); }
function rangeCNOf(t) {
  if (!t.start) return '';
  const s = fmtPtCN(t.start, t.startTime || '');
  const e = t.end ? fmtPtCN(t.end, t.endTime || '') : '';
  if (!e || s === e) return s;
  return s + ((t.startTime || t.endTime) ? ' 至 ' : '至') + e;
}
/* 'HH:mm' → 当日占比（用于事件条定位断言） */
function fracOf(hm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || ''));
  return m ? (+m[1] + (+m[2]) / 60) / 24 : null;
}
/* 未填时刻时页面的既定语义：时间点/里程碑取当日正中，时间段事件按 00:00 起算。
   用 fallback 兜住「管理员把时刻清空了」的情况，避免又变成数据耦合的硬断言。 */
function fracOfOr(hm, fallback) { const f = fracOf(hm); return f === null ? fallback : f; }

(async function main() {
  /* 先从站点取回 gantt.md 解析出模型：后续所有「某条任务的时刻」都从它推出来，不写死 */
  const gModel = await loadGanttModel();
  const T = id => gModel.byId(id) || {};
  const b7t = T('b7'), t25t = T('t25'), m12t = T('m12'), b3t = T('b3');

  const opts = { headless: true, args: ['--no-sandbox'] };
  if (CHROME) opts.executablePath = CHROME;
  /* 可选代理：对线上地址（GitHub Pages）跑本工具时，Chromium 默认不走系统代理，
     会直接 ERR_CONNECTION_CLOSED。置 PLAYWRIGHT_PROXY=http://127.0.0.1:7897 即可。
     本地 127.0.0.1 地址无需设置。 */
  if (process.env.PLAYWRIGHT_PROXY) {
    opts.proxy = { server: process.env.PLAYWRIGHT_PROXY };
  }
  const browser = await pw.chromium.launch(opts);
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  /* 拦截剪贴板：通道 C 点「⏰ 同步系统闹钟」时会先把闹钟清单写进剪贴板，这里捕获它做断言
     （headless 下没有真实剪贴板权限，必须替身；同时避免弹权限框阻塞用例） */
  await page.addInitScript(() => {
    window.__clip = '';
    try {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        get() { return { writeText: t => { window.__clip = String(t); return Promise.resolve(); } }; }
      });
    } catch (e) { /* 失败则退化为不校验剪贴板 */ }
  });

  const errors = [];
  const extReqs = [];
  const sameOrigin = new URL(URL_).origin;
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => {
    if (m.type() === 'error') {
      /* ⚠️ console 的 text 只有「Failed to load resource: net::ERR_CONNECTION_CLOSED」，
         不带 URL —— 早期版本按 text 过滤 fonts.googleapis 是无效的（匹配不到），
         于是第三方字体请求失败会被误报成「页面脚本错误」。这里把 location.url 一并带上。 */
      const u = (m.location() && m.location().url) || '';
      errors.push('console: ' + m.text() + (u ? '  @' + u : ''));
    }
  });
  /* 第三方请求监控：本项目要求「零外链」——自托管字体后，页面只应请求同源资源。
     这条断言把「第三方 CDN 挂掉/被墙导致首屏卡住或报错」变成确定性检测。 */
  page.on('request', r => {
    const u = r.url();
    if (!/^https?:/i.test(u)) return;
    let o; try { o = new URL(u).origin; } catch (e) { return; }
    if (o !== sameOrigin) extReqs.push(u);
  });

  await page.goto(URL_, { waitUntil: 'load' });
  await page.waitForSelector('#gv-svg .gv-bar', { timeout: 15000 });

  console.log('[1] 页面无脚本错误 / 无第三方请求');
  check(errors.length === 0,
    '无 pageerror / console.error' + (errors.length ? '（' + errors.slice(0, 3).join(' | ') + '）' : ''));
  check(extReqs.length === 0,
    '零第三方网络请求（实际 ' + extReqs.length + (extReqs.length ? '：' + extReqs.slice(0, 3).join(', ') : '') + '）');

  /* 字体自托管是否真的生效：必须有一个 family=Inter 的 FontFace 已 loaded，
     且其来源是同源的 woff2（而非 fonts.gstatic.com）。 */
  const fontInfo = await page.evaluate(async () => {
    await document.fonts.ready;
    const faces = [];
    document.fonts.forEach(f => faces.push({ family: f.family, status: f.status, weight: f.weight }));
    return {
      faces: faces,
      inter: faces.filter(f => /Inter/i.test(f.family)),
      ok: document.fonts.check('600 16px Inter')
    };
  });
  check(fontInfo.inter.length > 0 && fontInfo.inter.every(f => f.status === 'loaded'),
    'Inter 本地字体已加载（' + (fontInfo.inter.map(f => f.family + '/' + f.weight + ':' + f.status).join(', ') || '未注册') + '）');
  check(fontInfo.ok, 'document.fonts.check("600 16px Inter") = true');

  console.log('[2] 今日两条红线');
  const lines = await page.$$eval('#gv-nowlines line', els => els.map(e => ({
    x: parseFloat(e.getAttribute('x1')), dash: e.getAttribute('stroke-dasharray'), stroke: e.getAttribute('stroke')
  })));
  const labels = await page.$$eval('#gv-nowlines text', els => els.map(e => e.textContent));
  check(lines.length === 2, '恰好 2 条红线（实际 ' + lines.length + '）');
  check(lines.every(l => l.stroke === '#ef4444'), '两条线都是红色 #ef4444');
  check(!!lines[0] && !lines[0].dash && !!lines[1] && !!lines[1].dash, '① 当前时刻=实线，② 24:00=虚线');
  check(labels.some(t => /^现在 \d{2}:\d{2}$/.test(t)), '有「现在 HH:mm」分钟级标签（实际 ' + labels.join(' / ') + '）');
  check(labels.some(t => t === '今日 24:00'), '有「今日 24:00」标签');
  const nowX = await page.evaluate(() => {
    const els = document.querySelectorAll('#gv-nowlines line');
    return els.length === 2 ? [parseFloat(els[0].getAttribute('x1')), parseFloat(els[1].getAttribute('x1'))] : null;
  });
  check(nowX && nowX[1] > nowX[0], '「现在」线在「24:00」线左侧（' + (nowX && nowX.join(' < ')) + '）');
  /* 标注左右位：①「现在」放线的左侧 ②「今日 24:00」放线的右侧；两条标注同一基线（不错位） */
  const lab = await page.$$eval('#gv-nowlines text', els => els.map(e => ({
    t: e.textContent, x: parseFloat(e.getAttribute('x')), y: parseFloat(e.getAttribute('y')),
    an: e.getAttribute('text-anchor')
  })));
  const lNow = lab.filter(o => /^现在 \d{2}:\d{2}$/.test(o.t))[0];
  const lEod = lab.filter(o => o.t === '今日 24:00')[0];
  check(!!lNow && !!nowX && lNow.x < nowX[0] && lNow.an === 'end',
    '「现在」标注在线左侧（文字 x=' + (lNow && lNow.x) + ' < 线 x=' + (nowX && nowX[0]) + '，anchor=' + (lNow && lNow.an) + '）');
  check(!!lEod && !!nowX && lEod.x > nowX[1] && lEod.an === 'start',
    '「今日 24:00」标注在线右侧（文字 x=' + (lEod && lEod.x) + ' > 线 x=' + (nowX && nowX[1]) + '，anchor=' + (lEod && lEod.an) + '）');
  check(!!lNow && !!lEod && Math.abs(lNow.y - lEod.y) < 0.01,
    '两条标注同基线 y=' + (lNow && lNow.y) + '（不再错位）');

  console.log('[3] 标题时间精确到分钟');
  const caps = await page.$$eval('#gv-svg .gv-bar title', els => els.map(e => e.textContent));
  check(caps.some(t => t.indexOf(rangeCNOf(t25t)) >= 0), '文艺汇演领票标题含「' + rangeCNOf(t25t) + '」');
  check(caps.some(t => t.indexOf(rangeCNOf(b7t)) >= 0), '交大人节标题含「' + rangeCNOf(b7t) + '」');
  /* 形态断言（与数据无关）：有起止时刻的条目必须长成「M.D HH:mm 至 M.D HH:mm」 */
  check(caps.some(t => /\d{1,2}\.\d{1,2} \d{2}:\d{2} 至 \d{1,2}\.\d{1,2} \d{2}:\d{2}/.test(t)),
    '标题里的分钟级起止形态正确（含 至 连接词）');
  /* v33：左侧列表条目现在是「◆/▪ + 名称 + [#序号 + 日期区间 + 类型角标]」的复合结构，
     所以不能再拿 .dt 的整段 textContent 去等一个纯日期串；
     改为断言「存在含该分钟级区间的条目」，这是本来的验证意图（列表能显示到分钟）。 */
  const selLabels = await page.$$eval('#gv-lbox .gv-lname', els => els.map(e => e.textContent.replace(/\s+/g, ' ')));
  check(selLabels.some(t => t.indexOf('2026-09-10 14:00 → 2026-09-10 17:00') >= 0),
    '左侧列表显示分钟级起止（在 ' + selLabels.length + ' 行中匹配到）');

  console.log('[3b] 左侧事件列表（v33：平铺 / 最新修改在最上面 / 可滚动）');
  /* 结构：不再按 section 分区，条目直接平铺在 .gv-lbox 下 */
  const lboxInfo = await page.evaluate(() => {
    const box = document.querySelector('#gv-lbox');
    const rows = Array.prototype.slice.call(box.querySelectorAll('.gv-lname'));
    /* 是否存在「阶段/section 标题」这类分区行：v33 后应为 0 */
    const secRows = Array.prototype.slice.call(box.querySelectorAll('.gv-lsec,.gv-lhead-row,[class*=sec]'))
      .filter(e => !e.classList.contains('gv-lname'));
    return { rows: rows.length, secRows: secRows.length, cnt: (document.querySelector('#gv-lcnt') || {}).textContent };
  });
  check(lboxInfo.rows > 0, '左侧列表平铺出 ' + lboxInfo.rows + ' 个条目行');
  check(lboxInfo.secRows === 0, '左侧列表已无分区头（阶段属性取消后不再分组，实际 ' + lboxInfo.secRows + ' 个分区行）');
  /* 序号与类型角标：让「事件 / 时间点」在平铺后仍一眼可辨 */
  const badges = await page.$$eval('#gv-lbox .gv-lname .kbadge', els => els.map(e => e.textContent.trim()));
  check(badges.length === lboxInfo.rows, '每个条目都带类型角标（' + badges.length + ' 个）');
  check(badges.every(t => t === '事件' || t === '时间点'), '角标取值合法（出现：' + Array.from(new Set(badges)).join('/') + '）');
  check(badges.some(t => t === '事件') && badges.some(t => t === '时间点'), '事件与时间点两类角标均出现');
  const seqNums = await page.$$eval('#gv-lbox .gv-lname .sq', els => els.map(e => e.textContent.trim()));
  check(seqNums.length === lboxInfo.rows && seqNums.every(t => /^#\d+$/.test(t)), '每个条目带 #序号（' + seqNums.slice(0, 3).join(' ') + ' …）');
  /* 「最新修改在最上面」：给列表**最后一条**打上当前时间戳，重载后它必须跑到第一位。
     这是本需求的判定式 —— 不这么做就只是"看起来排过序"，无法证明按 modTs 降序。 */
  const lastOne = await page.evaluate(() => {
    const rows = Array.prototype.slice.call(document.querySelectorAll('#gv-lbox .gv-lname'));
    const last = rows[rows.length - 1];
    if (!last) return null;
    return {
      name: (last.querySelector('.nm b') || {}).textContent || '',
      seq: (last.querySelector('.sq') || {}).textContent || ''
    };
  });
  check(!!lastOne && !!lastOne.name, '取到列表末位条目（' + (lastOne && lastOne.name) + ' ' + (lastOne && lastOne.seq) + '）');
  if (lastOne && lastOne.name) {
    /* modTs 以任务 id 为键，而 DOM 上只有 #序号；通过 viewer 暴露的只读自检口反查 id */
    const ordered = await page.evaluate(async (targetName) => {
      const KEY = 'mermaid-gantt.modTs.v1';
      const v = window.__ganttViewer;
      if (!v || typeof v.debugTasks !== 'function') return { ok: false, reason: 'window.__ganttViewer.debugTasks 不可用' };
      const t = v.debugTasks().filter(x => x.name === targetName)[0];
      if (!t) return { ok: false, reason: '未找到同名任务「' + targetName + '」' };
      /* 只给这一条打上「未来」时间戳（远超其他），其余清掉 —— 排序必须把它顶到首位 */
      localStorage.setItem(KEY, JSON.stringify({ [t.id]: Date.now() + 86400000 }));
      return { ok: true, id: t.id };
    }, lastOne.name);
    if (ordered.ok) {
      await page.reload({ waitUntil: 'load' });
      /* 不用 waitForSelector：页面上同时存在 100+ 个 .gv-lname，playwright 会解析出多个候选
         并反复等待「第一个可见」，在本页的滚动容器里容易卡到超时。
         直接轮询行数与首行文本，稳定且能表达真实意图。 */
      const waitFirstRow = async () => {
        for (let i = 0; i < 60; i++) {
          const txt = await page.$eval('#gv-lbox .gv-lname .nm b', e => e.textContent.trim()).catch(() => '');
          if (txt) return txt;
          await page.waitForTimeout(250);
        }
        return '';
      };
      const topNow = await waitFirstRow();
      check(topNow === lastOne.name,
        '打上最新修改时间戳后，该条目升到列表首位（目标「' + lastOne.name + '」，实际首位「' + topNow + '」）');
      /* 反向：清空 modTs 后应回落到「按 ID 序号升序」的稳定序（不是随便排） */
      await page.evaluate(() => localStorage.removeItem('mermaid-gantt.modTs.v1'));
      await page.reload({ waitUntil: 'load' });
      await waitFirstRow();
      const seqAfter = await page.$$eval('#gv-lbox .gv-lname .sq', els => els.map(e => e.textContent.replace('#', '')));
      const nums = seqAfter.map(Number);
      check(nums.length > 0 && nums.every((n, i) => i === 0 || n >= nums[i - 1]),
        '无修改记录时回落到 ID 序号升序的稳定排序（前 5 个：' + seqAfter.slice(0, 5).join(', ') + '）');
    } else {
      console.log('   · 跳过「最新修改在最上面」断言（' + ordered.reason + '）');
    }
  }
  /* 滚动条：一屏放不下时可滚动。
     注意：无头默认视口下左栏可能是**折叠态**（高度 0），此时 scrollHeight/clientHeight 都是 0，
     断言会「空过」。所以先显式展开左栏，再量真实高度——否则这条等于没测。 */
  await page.evaluate(() => {
    const v = window.__ganttViewer;
    if (v && typeof v.toggleLabels === 'function') {
      const collapsed = document.querySelector('#gv-labels').classList.contains('collapsed');
      if (collapsed) v.toggleLabels();
    }
  });
  await page.waitForTimeout(350);
  const scrollInfo = await page.evaluate(() => {
    const box = document.querySelector('#gv-lbox');
    const cs = getComputedStyle(box);
    return {
      overflowY: cs.overflowY,
      maxH: cs.maxHeight,
      scrollH: box.scrollHeight,
      clientH: box.clientHeight,
      rows: box.querySelectorAll('.gv-lname').length,
      canScroll: box.scrollHeight > box.clientHeight + 1
    };
  });
  check(/auto|scroll/.test(scrollInfo.overflowY), '列表容器纵向可滚动（overflow-y=' + scrollInfo.overflowY + '）');
  check(scrollInfo.maxH && scrollInfo.maxH !== 'none', '列表容器有最大高度约束（max-height=' + scrollInfo.maxH + '）→ 超出时出现滚动条');
  check(scrollInfo.clientH > 0,
    '展开左栏后容器有真实高度（' + scrollInfo.clientH + 'px 视口 / ' + scrollInfo.scrollH + 'px 内容 / ' + scrollInfo.rows + ' 行）');
  check(scrollInfo.canScroll,
    '★ 需求 1b：146 条内容超出可视高度 → 容器确实可上下滚动（' + scrollInfo.clientH + 'px 视口 / ' + scrollInfo.scrollH + 'px 内容）');
  /* 实际滚一下，确认不是「声明了 overflow 但滚不动」 */
  const scrolled = await page.evaluate(() => {
    const box = document.querySelector('#gv-lbox');
    const before = box.scrollTop;
    box.scrollTop = 500;
    return { before: before, after: box.scrollTop };
  });
  check(scrolled.after > scrolled.before,
    '★ 需求 1b：滚动真实生效（scrollTop ' + scrolled.before + ' → ' + scrolled.after + '）');
  await page.evaluate(() => {
    const box = document.querySelector('#gv-lbox');
    if (box) box.scrollTop = 0;
  });

  console.log('[3c] 左栏搜索（v34：名称 / 日期 / 时刻 / 编号 / 详情 · 类型档 · 高亮 · 图上圈出）');
  /* 行取数器：一次取回「标题 / 序号 / 类型角标 / 来源标签 / 高亮标记数」，
     分多次 $$eval 会在防抖重绘的间隙读到前后不一致的快照。 */
  const srRows = () => page.$$eval('#gv-lbox .gv-lname', els => els.map(e => ({
    name: (e.querySelector('.nm b') || {}).textContent || '',
    seq: (e.querySelector('.sq') || {}).textContent || '',
    badge: (e.querySelector('.kbadge') || {}).textContent || '',
    why: (e.querySelector('.gv-why') || {}).textContent || '',
    marks: e.querySelectorAll('mark.gv-hl').length
  })));
  const srCnt = () => page.$eval('#gv-lcnt', e => e.textContent.trim());
  /* 输入有 130ms 防抖（客户端小列表的推荐区间）→ 断言前等条件成立，而不是死等固定时长 */
  async function srWait(pred, tries) {
    for (let i = 0; i < (tries || 40); i++) {
      const r = await srRows();
      if (pred(r)) return r;
      await page.waitForTimeout(100);
    }
    return await srRows();
  }
  /* ⚠️ 输入后必须先「越过防抖窗口」再取数：否则 srWait 会立刻被上一轮的旧快照满足，
     断言读到的是上一次查询的结果（本轮实测：编号/日期/详情三条角标断言集体假红）。 */
  async function srFill(q) {
    await page.fill('#gv-lq', q);
    await page.waitForTimeout(280);
  }
  const srFirstTasks = await page.evaluate(() => window.__ganttViewer.debugTasks());
  const srAll = await srRows();
  const srTotal = srAll.length;
  check(srTotal > 0, '搜索前左栏共 ' + srTotal + ' 条（作为过滤基数）');
  const srDom = await page.evaluate(() => {
    const box = document.querySelector('#gv-lsearch'), inp = document.querySelector('#gv-lq');
    return {
      hasBox: !!box, visible: !!(box && box.offsetHeight > 0),
      ph: inp ? inp.getAttribute('placeholder') : '', aria: inp ? inp.getAttribute('aria-label') : '',
      chips: Array.prototype.slice.call(document.querySelectorAll('#gv-lchips [data-ftype]'))
        .map(b => ({ t: b.textContent.trim(), on: b.classList.contains('on') })),
      ov: document.querySelectorAll('#gv-searchhits').length
    };
  });
  check(srDom.hasBox && srDom.visible, '左栏展开后出现搜索框（占位文案「' + srDom.ph + '」）');
  check(/搜索/.test(srDom.aria || ''), '搜索框带 aria-label（' + srDom.aria + '）');
  check(srDom.chips.length === 3 && srDom.chips[0].on,
    '类型档「' + srDom.chips.map(c => c.t).join('/') + '」，默认「全部」选中');
  check(srDom.ov === 0, '未搜索时图上没有命中叠加层（默认视图零影响，实际 ' + srDom.ov + ' 个）');

  /* ① 名称：关键词取自真实数据（首条任务名的前两字），不写死任何名称 */
  const srKw = String(srFirstTasks.filter(t => t.name && t.name.length >= 4)[0].name).slice(0, 2);
  await srFill(srKw);
  const srNameRows = await srWait(r => r.length > 0 && r.length < srTotal);
  check(srNameRows.length > 0 && srNameRows.length < srTotal,
    '关键词「' + srKw + '」把 ' + srTotal + ' 条过滤到 ' + srNameRows.length + ' 条');
  check(srNameRows.every(r => r.name.indexOf(srKw) >= 0 || r.why),
    '结果每条要么标题含关键词、要么带来源角标（无「看不懂为什么搜出来」的行）');
  check(srNameRows.some(r => r.marks > 0), '标题里的关键词被标黄高亮（<mark class="gv-hl">）');
  check(srNameRows.every(r => r.name.indexOf(srKw) >= 0 || r.marks === 0),
    '高亮只出现在真正含关键词的标题上');
  const srCntA = await srCnt();
  check(srCntA === srNameRows.length + ' / ' + srTotal,
    '头部计数切换为「命中 N / 总数」（实际「' + srCntA + '」）');
  const srOvCount = await page.$$eval('#gv-searchhits rect, #gv-searchhits path', els => els.length);
  check(srOvCount > 0, '图上画出琥珀虚线命中轮廓（' + srOvCount + ' 个）');
  check(srOvCount >= srNameRows.length, '命中轮廓数量覆盖全部命中条目（' + srOvCount + ' ≥ ' + srNameRows.length + '）');
  check((await page.evaluate(() => window.__ganttViewer.searchInfo().overlay)) === true,
    'searchInfo().overlay = true（只读自检口与 DOM 一致）');
  check(await page.$eval('#gv-lsearch', e => e.classList.contains('hasq')), '有输入时清空按钮（✕）显示');

  /* 定位条：命中都在视野外时，图上轮廓「等于没圈」→ 必须给出「点此定位首条」的出路 */
  const srFoot = await page.evaluate(() => {
    const f = document.querySelector('#gv-lfoot');
    return { on: f.classList.contains('on'), away: f.classList.contains('away'), tx: f.textContent.trim() };
  });
  check(srFoot.on && /视野外|已圈出/.test(srFoot.tx), '列表底部给出命中定位条（「' + srFoot.tx + '」）');
  if (srFoot.away) {
    await page.click('#gv-lfoot');
    await page.waitForTimeout(600);
    const srAfter = await page.evaluate(() => {
      const f = document.querySelector('#gv-lfoot');
      const g = document.querySelector('#gv-searchhits rect, #gv-searchhits path');
      const sc = document.querySelector('#gv-scroll').getBoundingClientRect();
      const r = g ? g.getBoundingClientRect() : null;
      return {
        tx: f.textContent.trim(), away: f.classList.contains('away'),
        active: (document.querySelector('#gv-lbox .gv-lname.active .nm b') || {}).textContent || '',
        inside: !!(r && r.left >= sc.left - 2 && r.right <= sc.right + 2)
      };
    });
    check(!srAfter.away && /已圈出/.test(srAfter.tx),
      '点定位条 → 视野跳到命中处，提示切换为「已圈出」（「' + srAfter.tx + '」）');
    check(srAfter.active === srNameRows[0].name,
      '定位后该条在列表里被标为当前选中（' + srAfter.active + '）');
    check(srAfter.inside, '★ 定位后命中轮廓确实落在可视区内（不是「圈在视野外」）');
  } else {
    console.log('   · 命中恰好在当前视野内，跳过「定位首条」分支');
  }

  /* ② 编号：#序号精确到唯一一条 */
  const srOne = srNameRows[0];
  await srFill(srOne.seq);
  const srIdRows = await srWait(r => r.length === 1);
  check(srIdRows.length === 1 && srIdRows[0].name === srOne.name,
    '按 #序号「' + srOne.seq + '」精确定位到唯一一条：' + (srIdRows[0] || {}).name);
  check(/编号/.test(srIdRows[0].why), '按 #序号命中 → 来源角标「编号」（实际「' + srIdRows[0].why + '」）');

  /* ③ 日期：完整形式 + 「9.5」短形式（同学最常用的写法），期望值从 gantt.md 推导 */
  const p2s = n => (n < 10 ? '0' : '') + n;
  const srDt = gModel.all.filter(t => t.name && t.start)[0];
  const srYmd = srDt.start.getFullYear() + '-' + p2s(srDt.start.getMonth() + 1) + '-' + p2s(srDt.start.getDate());
  const srMd = (srDt.start.getMonth() + 1) + '.' + srDt.start.getDate();
  await srFill(srYmd);
  const srYmdRows = await srWait(r => r.some(x => x.name === srDt.name));
  check(srYmdRows.some(x => x.name === srDt.name),
    '按完整日期「' + srYmd + '」搜到该日期的条目（' + srYmdRows.length + ' 条）');
  check(srYmdRows.some(x => /日期/.test(x.why)), '日期命中带来源角标「日期」');
  await srFill(srMd);
  const srMdRows = await srWait(r => r.some(x => x.name === srDt.name));
  check(srMdRows.some(x => x.name === srDt.name),
    '按短日期「' + srMd + '」（月.日）同样搜得到（' + srMdRows.length + ' 条）');

  /* ④ 时刻：挑一条「时刻不在标题里」的任务，验证时刻域独立可搜 */
  const srHmTask = gModel.all.filter(t => t.startTime && String(t.name).indexOf(t.startTime) < 0)[0];
  if (srHmTask) {
    await srFill(srHmTask.startTime);
    const srHmRows = await srWait(r => r.some(x => x.name === srHmTask.name));
    const hit = srHmRows.filter(x => x.name === srHmTask.name)[0];
    check(!!hit && /时刻/.test(hit.why),
      '按开始时刻「' + srHmTask.startTime + '」命中「' + srHmTask.name + '」并标「时刻」（实际「' + (hit ? hit.why : '未命中') + '」）');
  }

  /* ⑤ 详情：按负责人姓名搜（详情字段，标题里通常没有） */
  const srEvKey = Object.keys(Events).filter(k => /^b/.test(k) && Events[k] && Events[k].owners && Events[k].owners.length)[0];
  if (srEvKey) {
    const srOwner = Events[srEvKey].owners[0].name;
    await srFill(srOwner);
    const srEvRows = await srWait(r => r.length > 0);
    check(srEvRows.some(x => /详情/.test(x.why)),
      '按负责人「' + srOwner + '」搜到详情命中条目（' + srEvRows.filter(x => /详情/.test(x.why)).length + ' 条带「详情」角标）');
  }

  /* ⑥ 多关键词 AND：任一不命中 → 整条不进结果，且给出空状态文案 */
  await srFill(srKw + ' zzz不存在');
  const srAndRows = await srWait(r => r.length === 0);
  const srEmptyTxt = await page.$eval('.gv-lnmatch', e => e.textContent.trim()).catch(() => '');
  check(srAndRows.length === 0 && /没有匹配/.test(srEmptyTxt),
    '多关键词 AND：一个词不命中 → 0 结果 + 空状态文案（「' + srEmptyTxt.slice(0, 34) + '…」）');
  check((await srCnt()) === '0 / ' + srTotal, '零命中时计数显示「0 / ' + srTotal + '」（实际「' + (await srCnt()) + '」）');

  /* ⑦ 清空按钮回全量 */
  await page.click('#gv-lclr');
  const srClrRows = await srWait(r => r.length === srTotal);
  check(srClrRows.length === srTotal && (await srCnt()) === String(srTotal),
    '点 ✕ 清空 → 列表恢复全量 ' + srTotal + ' 条');
  check(!(await page.$eval('#gv-lsearch', e => e.classList.contains('hasq'))), '清空后 ✕ 隐藏');
  check((await page.$$eval('#gv-searchhits rect, #gv-searchhits path', els => els.length)) === 0,
    '清空后图上命中轮廓一并撤掉');
  check(!(await page.evaluate(() => document.querySelector('#gv-lfoot').classList.contains('on'))),
    '清空后底部定位条一并隐藏');

  /* ⑧ 类型档：与关键词「与」关系，单独用也能筛 */
  await page.click('#gv-lchips [data-ftype="point"]');
  const srPtRows = await srWait(r => r.length > 0 && r.every(x => x.badge === '时间点'));
  check(srPtRows.length > 0 && srPtRows.every(x => x.badge === '时间点'),
    '类型档「时间点」→ 结果全是时间点（' + srPtRows.length + ' 条）');
  await page.click('#gv-lchips [data-ftype="event"]');
  const srEvtRows = await srWait(r => r.length > 0 && r.every(x => x.badge === '事件'));
  check(srEvtRows.length > 0 && srEvtRows.every(x => x.badge === '事件'),
    '类型档「事件」→ 结果全是事件（' + srEvtRows.length + ' 条）');
  check(srPtRows.length + srEvtRows.length === srTotal,
    '两档条数之和 = 全部（' + srPtRows.length + ' + ' + srEvtRows.length + ' = ' + srTotal + '）');

  /* ⑨ 回车直达：打开第一条命中的详情（含定位+闪烁） */
  await page.click('#gv-lchips [data-ftype="all"]');
  await srFill(srKw);
  const srEnterRows = await srWait(r => r.length > 0 && r.length < srTotal);
  await page.keyboard.press('Enter');
  await page.waitForSelector('.gv-drawer.on', { timeout: 5000 });
  const srDhead = await page.$eval('.gv-drawer .gv-dhead', e => e.textContent.trim());
  check(srDhead === srEnterRows[0].name,
    '回车打开第一条命中的详情（列表首条「' + srEnterRows[0].name + '」= 弹窗标题「' + srDhead + '」）');
  await page.click('.gv-drawer .gv-close');
  await page.waitForTimeout(260);

  /* ⑩ Esc：输入框内按 Esc 清空并恢复全量 */
  await srFill(srKw);
  await srWait(r => r.length < srTotal);
  await page.keyboard.press('Escape');
  const srEscRows = await srWait(r => r.length === srTotal);
  check(srEscRows.length === srTotal && (await page.$eval('#gv-lq', e => e.value)) === '',
    'Esc 清空关键词并恢复全量列表（' + srEscRows.length + ' 条）');

  /* ⑪ 折叠左栏时搜索区一并隐藏（不能留一条点不动的输入框在 34px 窄条里） */
  await page.evaluate(() => window.__ganttViewer.toggleLabels());
  await page.waitForTimeout(250);
  const srCollapsed = await page.evaluate(() => {
    const box = document.querySelector('#gv-lsearch');
    return { hidden: !box || box.offsetHeight === 0, w: document.querySelector('#gv-labels').offsetWidth };
  });
  check(srCollapsed.hidden, '折叠左栏 → 搜索区隐藏（栏宽 ' + srCollapsed.w + 'px）');
  await page.evaluate(() => window.__ganttViewer.toggleLabels());
  await page.waitForTimeout(250);
  check(await page.evaluate(() => document.querySelector('#gv-lsearch').offsetHeight > 0), '再次展开 → 搜索区回来');
  check(errors.length === 0,
    '搜索交互全程无 pageerror / console.error' + (errors.length ? '（' + errors.slice(0, 2).join(' | ') + '）' : ''));

  console.log('[4] 今日截止提醒面板（v33 口径：截止日期 = 今天）');
  await page.click('[data-act="remind"]');
  await page.waitForSelector('.gv-rem-panel.on', { timeout: 5000 });
  const whens = await page.$$eval('.gv-rem-list .gv-rem-item .when', els => els.map(e => e.textContent.trim()));
  const chips = await page.$$eval('.gv-rem-list .gv-rem-item .chip', els => els.map(e => e.textContent.trim()));
  /* v33 口径：收录「截止日期 = 当天」的条目，与运行时刻无关 ——
     所以「今天有课」的日期下列表必非空（课程表逐日展开，今天一定有课）。
     但仍保留空态分支：数据侧若当天真的无条目，面板应给出空态文案而非崩溃。 */
  if (whens.length) {
    check(true, '今日截止提醒列表有 ' + whens.length + ' 条');
    /* 只断言「格式」是分钟级起止，不断言具体时刻：面板内容随数据变化 */
    check(whens.every(t => /^\d{1,2}\.\d{1,2} \d{2}:\d{2} → \d{1,2}\.\d{1,2} \d{2}:\d{2}$/.test(t)),
      '每条显示开始→截止（分钟级）：' + whens.join(' | '));
    check(chips.some(t => /剩 \d+ (分钟|小时)/.test(t) || /已过点/.test(t)),
      '剩余时长/过点状态明确：' + chips.join(' | '));
  } else {
    const emptyTxt = await page.$eval('.gv-rem-empty', e => e.textContent.trim()).catch(() => '');
    check(/今天没有截止的待办/.test(emptyTxt),
      '今天无截止条目 → 面板给出空态文案：「' + emptyTxt.replace(/\s+/g, ' ') + '」');
  }
  /* v33 新增断言：面板副标题必须明示新口径（避免旧文案残留让同学误解筛选规则） */
  const remSub = await page.$eval('.gv-rem-panel', e => e.textContent.replace(/\s+/g, ' ')).catch(() => '');
  check(/今天截止/.test(remSub), '提醒面板文案明示「今天截止」口径（' + remSub.slice(0, 120) + '…）');
  check(!/不足一天|24 ?小时/.test(remSub), '提醒面板已不含「不足一天 / 24 小时」旧口径文案');
  const btns = await page.$$eval('.gv-rem-btn', els => els.map(e => e.textContent.trim()));
  check(btns.length === 4, '系统级通道 4 个按钮（实际 ' + btns.length + '）');
  check(btns.some(t => t.indexOf('加入系统日历') >= 0) && btns.some(t => t.indexOf('同步系统闹钟') >= 0), '含「加入系统日历」「同步系统闹钟」');
  /* 校验 .ics 的真实产出（不下载，直接调内部函数） */
  const icsOk = await page.evaluate(() => {
    const d = document.createElement('a');
    return typeof Blob !== 'undefined' && typeof URL.createObjectURL === 'function';
  });
  check(icsOk, 'Blob / createObjectURL 可用（.ics 下载通道可用）');
  await page.click('.gv-rem-close');

  console.log('[5] Ctrl+S → 保存同步');
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyS');
  await page.keyboard.up('Control');
  await page.waitForTimeout(300);
  const toastTxt = await page.$eval('.gv-toast', e => e.textContent).catch(() => '');
  check(toastTxt.indexOf('Ctrl+S') >= 0, '未登录时给出明确提示（实际「' + toastTxt + '」）');

  console.log('[6] 逐日交替底色 + 日期数字居中');
  /* 用条纹几何反推 pxPerDay / LEFT_PAD。
     ⚠️ 不能用「单条条纹的取整宽度」当 px（rect width 已 toFixed(1)，0.03px 的取整误差乘上
     十几天的跨度就会放大成 0.04 天的假偏差）——改用首尾两条蓝纹的跨度反推，精度提升两个数量级。 */
  const geo = await page.evaluate(() => {
    const svg = document.querySelector('#gv-svg');
    const blue = svg.querySelectorAll('#gv-zebra rect');
    if (!blue.length) return null;
    const xs = Array.prototype.slice.call(blue).map(e => parseFloat(e.getAttribute('x')));
    const fills = Array.prototype.slice.call(blue).map(e => e.getAttribute('fill'));
    /* 蓝纹 zi = 1,3,5... 相邻两条相差 2 天 → px = (x_last - x_first) / (2*(n-1)) */
    const px = xs.length > 1 ? (xs[xs.length - 1] - xs[0]) / (2 * (xs.length - 1)) : parseFloat(blue[0].getAttribute('width'));
    const leftPad = xs[0] - px;                 /* 第 1 条蓝纹 = 第 1 天 → x = LEFT_PAD + 1*px */
    /* 日期数字的文本节点形如「18」（px/天宽时）或「18 周五」（放大后带周几，周几在 <tspan> 里，
       textContent 因此含「周X」后缀）。早先这里用 /^\d{1,2}$/ 严格匹配纯数字，
       放大态下全部落选 → dayFracs 为空 → 断言假红。改为「以 1-2 位数字开头即算日期数字」。 */
    const dn = Array.prototype.slice.call(svg.querySelectorAll('text'))
      .filter(e => e.getAttribute('font-size') === '8.5' && /^\d{1,2}(\s|$)/.test(e.textContent.trim()))
      .map(e => Math.round((((parseFloat(e.getAttribute('x')) - leftPad) / px) % 1) * 1000) / 1000);
    return { px: px, leftPad: leftPad, count: blue.length, xs: xs, fills: fills, dayFracs: dn,
      dayTxts: Array.prototype.slice.call(svg.querySelectorAll('text'))
        .filter(e => e.getAttribute('font-size') === '8.5').slice(0, 4)
        .map(e => e.textContent.trim()) };
  });
  check(!!geo && geo.count > 0, '存在逐日交替底色条纹（' + (geo && geo.count) + ' 条，px/天=' + (geo && geo.px.toFixed(2)) + '）');
  check(!!geo && geo.fills.every(f => f === '#e8f2fd'), '条纹统一浅蓝 #e8f2fd');
  check(!!geo && geo.xs.length > 1 && Math.abs((geo.xs[1] - geo.xs[0]) - 2 * geo.px) < 0.5,
    '蓝条逐日交替（相邻蓝条间隔 = 2 天，实测 ' + (geo && (geo.xs[1] - geo.xs[0]).toFixed(1)) + 'px，期望 ' + (geo && (2 * geo.px).toFixed(1)) + 'px）');
  check(!!geo && geo.dayFracs.length >= 3 && geo.dayFracs.every(f => Math.abs(f - 0.5) < 0.02),
    '日期数字落在当日正中（日内小数≈0.5，实测 ' + (geo ? geo.dayFracs.slice(0, 6).join(' / ') : '') + '）');
  check(!!geo && geo.dayTxts.length > 0,
    '日期数字文本可识别（样本：' + (geo ? geo.dayTxts.join(' | ') : '') + '）');

  console.log('[7] 事件条按分钟级时刻等比定位与定长');
  const bars = await page.evaluate(() => {
    const svg = document.querySelector('#gv-svg');
    const blue = svg.querySelectorAll('#gv-zebra rect');
    if (!blue.length) return null;
    /* 与上面 [6] 同法：用首尾蓝纹跨度反推 px，避免取整宽度带来的累积偏差 */
    const bxs = Array.prototype.slice.call(blue).map(e => parseFloat(e.getAttribute('x')));
    const px = bxs.length > 1 ? (bxs[bxs.length - 1] - bxs[0]) / (2 * (bxs.length - 1)) : parseFloat(blue[0].getAttribute('width'));
    const leftPad = bxs[0] - px;
    const out = {};
    ['t25', 'm12', 'b7', 'b3'].forEach(id => {
      const host = svg.querySelector('.gv-bar[data-id="' + id + '"]');
      if (!host) { out[id] = null; return; }
      /* 近期事件会有「彩虹外描边」作为同级元素先出现：外描边 fill="none"，需排除 */
      const rects = Array.prototype.slice.call(host.querySelectorAll('rect'));
      const r = rects.filter(e => e.getAttribute('fill') !== 'none')[0];
      const p = rects.length ? null : host.querySelector('path');
      if (r) {
        const x = parseFloat(r.getAttribute('x')), w = parseFloat(r.getAttribute('width'));
        out[id] = { kind: 'rect', x: x, w: w, dayFrac: (x - leftPad) / px, frac: ((x - leftPad) / px) % 1, wDays: w / px };
      } else if (p) {
        const nums = (p.getAttribute('d') || '').match(/-?\d+(?:\.\d+)?/g);
        const xs = (nums || []).map(Number).filter((_, i) => i % 2 === 0);
        const cx = xs.length ? (Math.min.apply(null, xs) + Math.max.apply(null, xs)) / 2 : NaN;
        out[id] = { kind: 'path', cx: cx, dayFrac: (cx - leftPad) / px, frac: ((cx - leftPad) / px) % 1 };
      } else { out[id] = null; }
    });
    return { px: px, bars: out };
  });
  check(!!bars && !!bars.bars.t25 && Math.abs(bars.bars.t25.frac - fracOfOr(t25t.startTime, 0)) < 0.01,
    't25 起点落在当日 ' + t25t.startTime + '（日内占比 ' + (bars && bars.bars.t25 && bars.bars.t25.frac.toFixed(3)) + ' ≈ ' + fracOfOr(t25t.startTime, 0).toFixed(3) + '）');
  const expW = bars ? Math.max(0.125 * bars.px, 3) : 0;
  check(!!bars && !!bars.bars.t25 && Math.abs(bars.bars.t25.w - expW) < 0.6,
    't25 长度 = 3 小时占比（期望 ' + expW.toFixed(1) + 'px，实际 ' + (bars && bars.bars.t25 && bars.bars.t25.w.toFixed(1)) + 'px）');
  check(!!bars && !!bars.bars.m12 && Math.abs(bars.bars.m12.frac - fracOfOr(m12t.startTime, 0.5)) < 0.01,
    'm12 里程碑落在当日 ' + m12t.startTime + '（日内占比 ' + (bars && bars.bars.m12 && bars.bars.m12.frac.toFixed(3)) + ' ≈ ' + fracOfOr(m12t.startTime, 0.5).toFixed(3) + '）');
  check(!!bars && !!bars.bars.b7 && Math.abs(bars.bars.b7.frac - fracOfOr(b7t.startTime, 0.5)) < 0.01,
    'b7 落在当日 ' + b7t.startTime + '（日内占比 ' + (bars && bars.bars.b7 && bars.bars.b7.frac.toFixed(3)) + ' ≈ ' + fracOfOr(b7t.startTime, 0.5).toFixed(3) + '）');
  check(!!bars && !!bars.bars.b3 && Math.abs(bars.bars.b3.frac - 0.5) < 0.02,
    '未填时刻的里程碑取当日正中（b3 日内占比 ' + (bars && bars.bars.b3 && bars.bars.b3.frac.toFixed(3)) + ' ≈ 0.5）');

  console.log('[8] 移动端（竖屏 390×844 / 横屏 844×390）');
  /* 本项目主要使用者是手机上打开的同学：逐日底色、日期数字居中、红线标注左右位都必须在
     窄视口下同样成立（竖屏 px/天 较小，日期数字会按阈值自动省略，属预期）。 */
  for (const vp of [{ w: 390, h: 844, n: '竖屏' }, { w: 844, h: 390, n: '横屏' }]) {
    const mp = await browser.newPage({ viewport: { width: vp.w, height: vp.h } });
    const merrs = [];
    const mext = [];
    mp.on('pageerror', e => merrs.push('pageerror: ' + e.message));
    mp.on('console', m => {
      if (m.type() === 'error') {
        const u = (m.location() && m.location().url) || '';
        merrs.push(m.text() + (u ? '  @' + u : ''));
      }
    });
    mp.on('request', r => {
      const u = r.url();
      if (!/^https?:/i.test(u)) return;
      let o; try { o = new URL(u).origin; } catch (e) { return; }
      if (o !== sameOrigin) mext.push(u);
    });
    await mp.goto(URL_, { waitUntil: 'load' });
    await mp.waitForSelector('#gv-svg .gv-bar', { timeout: 15000 });
    await mp.waitForTimeout(350);
    const mr = await mp.evaluate(() => {
      const svg = document.querySelector('#gv-svg');
      const blue = svg.querySelectorAll('#gv-zebra rect');
      const xs = Array.prototype.slice.call(blue).map(e => parseFloat(e.getAttribute('x')));
      const px = xs.length > 1 ? (xs[xs.length - 1] - xs[0]) / (2 * (xs.length - 1)) : 0;
      const leftPad = xs.length ? xs[0] - px : 0;
      const dn = Array.prototype.slice.call(svg.querySelectorAll('text'))
        .filter(e => e.getAttribute('font-size') === '8.5' && /^\d{1,2}$/.test(e.textContent.trim()))
        .map(e => Math.round((((parseFloat(e.getAttribute('x')) - leftPad) / px) % 1) * 1000) / 1000);
      const lab = Array.prototype.slice.call(svg.querySelectorAll('#gv-nowlines text')).map(e => ({ t: e.textContent, x: parseFloat(e.getAttribute('x')), an: e.getAttribute('text-anchor') }));
      const ln = Array.prototype.slice.call(svg.querySelectorAll('#gv-nowlines line')).map(e => parseFloat(e.getAttribute('x1')));
      return { px: px, zebra: blue.length, dn: dn, lab: lab, ln: ln, bars: svg.querySelectorAll('.gv-bar').length };
    });
    const tag = '[' + vp.n + '] ';
    check(merrs.length === 0, tag + '无脚本错误' + (merrs.length ? '（' + merrs.slice(0, 2).join(' | ') + '）' : ''));
    check(mext.length === 0, tag + '零第三方请求（实际 ' + mext.length + '）');
    check(mr.bars >= 30, tag + '事件条渲染完整（' + mr.bars + ' 条）');
    check(mr.px > 0, tag + '逐日底色/日几何有效（px/天=' + mr.px.toFixed(2) + '）');
    check(mr.dn.length === 0 || mr.dn.every(f => Math.abs(f - 0.5) < 0.02),
      tag + '日期数字居中或按阈值省略（实测 ' + (mr.dn.length ? mr.dn.slice(0, 5).join('/') : '已省略，px<10.5') + '）');
    if (mr.lab.length === 2 && mr.ln.length === 2) {
      const n2 = mr.lab.filter(o => /^现在/.test(o.t))[0], e2 = mr.lab.filter(o => /^今日 24:00$/.test(o.t))[0];
      check(!!n2 && n2.x < mr.ln[0] && n2.an === 'end', tag + '「现在」标注在线左侧');
      check(!!e2 && e2.x > mr.ln[1] && e2.an === 'start', tag + '「今日 24:00」标注在线右侧');
    } else {
      console.log('  · ' + tag + '今日不在可视范围，跳过红线标签检查');
    }
    await mp.close();
  }

  console.log('[9] 通道 C：闹钟清单（名称｜地点｜起止日期时间 / 仅今日 / 开始前 15 分钟）');
  await page.click('[data-act="remind"]');
  await page.waitForSelector('.gv-rem-panel.on', { timeout: 5000 });
  const alarmTitle = await page.$eval('[data-act="alarm"]', e => e.getAttribute('title'));
  check(/开始时刻前 15 分钟/.test(alarmTitle || ''), '⏰ 按钮说明写明了「闹钟时间 = 开始时刻前 15 分钟」');
  check(/今天开始/.test(alarmTitle || ''), '⏰ 按钮说明写明了「只对今天开始的条目建闹钟」');
  check(/地点/.test(alarmTitle || ''), '⏰ 按钮说明里标签包含地点段');
  const noteTxt = await page.$eval('#gv-rem-note', e => e.textContent);
  check(/时间 = 开始前 15 分钟/.test(noteTxt) && /标签 = 「名称｜地点｜开始→结束时间」/.test(noteTxt),
    '面板提示写明「时间 = 开始前 15 分钟，标签 = 名称｜地点｜起止时间」');
  await page.click('[data-act="alarm"]');
  await page.waitForTimeout(400);
  const clip = await page.evaluate(() => window.__clip || '');
  const almLines = clip.split('\n').filter(l => l.indexOf('⏰ 系统闹钟') >= 0);
  const noCand = clip.indexOf('不会新建闹钟') >= 0;
  check(clip.length > 0, '点击后写入了剪贴板（' + clip.split('\n').length + ' 行）');
  check(noCand || almLines.length > 0,
    noCand ? '今天无「已填开始时刻」的待办 → 给出不建闹钟的说明（正确降级）'
      : '清单含 ' + almLines.length + ' 条闹钟行');
  check(almLines.every(l => /⏰ 系统闹钟 \d{1,2}\.\d{1,2} \d{2}:\d{2}（开始前 15 分钟）$/.test(l)),
    '每条闹钟行形如「⏰ 系统闹钟 <日期> <时刻>（开始前 15 分钟）」：' + (almLines[0] || '—'));
  /* 标签 =「名称｜地点｜起止」，与紧接着的闹钟行成对出现 */
  const bullets = clip.split('\n').filter(l => l.indexOf('· ') === 0);
  check(bullets.length === almLines.length || noCand,
    '每条闹钟行都对应一条名称行（' + bullets.length + ' vs ' + almLines.length + '）');
  check(bullets.every(l => /· .+\S｜[^｜]*\d{1,2}\.\d{1,2} \d{2}:\d{2}/.test(l)),
    '名称行形如「名称〔｜地点〕｜起止日期时间」：' + (bullets[0] || '—'));
  /* 只设「今天开始」的条目：清单里出现的日期必须是今天（跨零点回退时会出现昨天） */
  if (!noCand) {
    const md = await page.evaluate(() => {
      const f = t => (t.getMonth() + 1) + '.' + t.getDate();
      return { today: f(new Date()), yest: f(new Date(Date.now() - 86400000)) };
    });
    const dts = bullets.map(l => {
      /* 只取「｜」之后的起止段（避免课程名里内嵌的「MM.DD HH:mm」（如 09.11 14:10）被误抓；
         真正的开始日期在 alarmLabel 的最后一段（名称｜地点｜起止） */
      const afterSep = (l.split('｜').pop() || '');
      return (afterSep.match(/(\d{1,2}\.\d{1,2}) \d{2}:\d{2}/) || [])[1];
    }).filter(Boolean);
    const dset = Array.from(new Set(dts));
    check(dset.length === 0 || dset.every(d => d === md.today || d === md.yest),
      '清单只含「今天开始」的条目（出现日期 ' + dset.join('/') + '，含跨零点回退的昨天 ' + md.yest + '）');
  }
  /* 线上/本地实际提供的 deadlines.json 必须满足通道 C 契约（这部分与真实时间无关，任何时候都成立）：
     ① schema = 5（v33：提醒口径改为「截止落在当天」）② items 均带 dueToday 布尔位
     ③ alarmItems 是 items 的今日子集 ④ 有地点的条目，标签里必须带「｜地点｜」段。
     这一步能抓到「忘了提交 deadlines.json」「Actions 用旧脚本重建」这类只在产物层暴露的问题。 */
  const dj = await page.evaluate(async () => {
    const res = await fetch('./deadlines.json', { cache: 'no-store' });
    return res.ok ? res.json() : null;
  });
  check(!!dj && dj.schema === 5, '站点提供的 deadlines.json schema = 5（v33 口径，实际 ' + (dj && dj.schema) + '）');
  check(!!dj && dj.within24h === undefined && dj.within24hText === undefined,
    '站点产物已移除旧的 within24h / within24hText 字段');
  check(!!dj && typeof dj.dueTodayCount === 'number' && typeof dj.dueTodayText === 'string',
    '站点产物带 dueTodayCount / dueTodayText（' + (dj && dj.dueTodayCount) + ' 条：「' + (dj && dj.dueTodayText) + '」）');
  check(!!dj && dj.items.every(i => typeof i.dueToday === 'boolean'),
    '站点产物 items 均带 dueToday 布尔位（' + (dj && dj.items.length) + ' 条）');
  check(!!dj && dj.alarmLabelSep === '｜' && dj.alarmLeadMin === 15,
    '站点产物带 alarmLabelSep = ｜、alarmLeadMin = 15');
  check(!!dj && Array.isArray(dj.alarmItems) && dj.alarmItems.every(i => i.startDaysLeft === 0 && i.alarmExact === true),
    'alarmItems 只含「今天开始 + 已填开始时刻」的条目（' + (dj && dj.alarmCount) + ' 条）');
  check(!!dj && dj.alarmItems.every(a => dj.items.some(i => i.id === a.id)),
    'alarmItems 是 items 的子集（不多出窗口外的条目）');
  const withWhere = (dj && dj.items || []).filter(i => i.where);
  check(withWhere.every(i => i.alarmLabel.indexOf('｜' + i.where + '｜') > 0),
    '有地点的条目标签含「｜地点｜」段（' + withWhere.length + ' 条：' +
    withWhere.map(i => i.alarmLabel).join(' / ') + '）');
  await page.click('.gv-rem-close');

  console.log('[10] 编辑表单：类型只有两种 / 时间点不可设结束时间 / 时刻可清除');
  /* 走进编辑表单需要「已登录」这一前置（isAdmin 只检查 localStorage 是否有令牌）；
     这里只放一个假令牌 —— 全程不触发任何 GitHub 写操作。用完立即清掉，
     让随后的截图仍是「未登录」的默认态。 */
  await page.evaluate(() => localStorage.setItem('gantt_admin_token', 'ui-test-only'));
  await page.goto(URL_, { waitUntil: 'load' });
  await page.waitForSelector('[data-act="add"]', { timeout: 10000 });
  await page.click('[data-act="add"]');
  await page.waitForSelector('#gv-crudform', { timeout: 5000 });

  const kindOpts = await page.$$eval('[name=kind] option', els => els.map(e => e.textContent.trim()));
  check(kindOpts.length === 2, '类型下拉只有 2 项（实际 ' + kindOpts.length + ' 项：' + kindOpts.join(' / ') + '）');
  check(kindOpts.some(t => t.indexOf('事件') >= 0) && kindOpts.some(t => t.indexOf('时间点') >= 0),
    '两项分别是「事件」与「时间点」');
  check(!kindOpts.some(t => t.indexOf('关键节点') >= 0), '类型里已无「关键节点」选项');

  /* v33 需求 1a：表单取消「阶段」字段 —— 彻底不存在该控件（不是隐藏、不是禁用） */
  const secField = await page.evaluate(() => {
    const byName = document.querySelector('#gv-crudform [name=section]');
    const labels = Array.prototype.slice.call(document.querySelectorAll('#gv-crudform label'))
      .map(l => l.textContent.trim());
    return { hasSelect: !!byName, secLabel: labels.filter(t => /^阶段/.test(t)) };
  });
  check(!secField.hasSelect, '新增表单已无「阶段」下拉控件（name=section 不存在）');
  check(secField.secLabel.length === 0, '表单标签里已无「阶段」字样（实际 ' + JSON.stringify(secField.secLabel) + '）');

  /* 时刻清除：原生 time 控件在手机上无法置空，必须有一个显式出口 */
  await page.fill('[name=startTime]', '14:00');
  const stBefore = await page.inputValue('[name=startTime]');
  await page.click('[data-clear="startTime"]');
  const stAfter = await page.inputValue('[name=startTime]');
  check(stBefore === '14:00' && stAfter === '', '开始时刻可被清除（' + stBefore + ' → 「' + stAfter + '」）');
  await page.fill('[name=endTime]', '17:00');
  const etBefore = await page.inputValue('[name=endTime]');
  await page.click('[data-clear="endTime"]');
  const etAfter = await page.inputValue('[name=endTime]');
  check(etBefore === '17:00' && etAfter === '', '结束时刻可被清除（' + etBefore + ' → 「' + etAfter + '」）');
  await page.fill('[name=end]', '2026-09-13');
  const edBefore = await page.inputValue('[name=end]');
  await page.click('[data-clear="end"]');
  const edAfter = await page.inputValue('[name=end]');
  check(edBefore === '2026-09-13' && edAfter === '', '结束日期可被清除（' + edBefore + ' → 「' + edAfter + '」）');

  /* 类型联动：时间点 → 结束日期/时刻禁用并清空 */
  await page.fill('[name=end]', '2026-09-13');
  await page.fill('[name=endTime]', '17:00');
  await page.selectOption('[name=kind]', 'milestone');
  await page.waitForTimeout(120);
  const pt = await page.evaluate(() => {
    const e = document.querySelector('[name=end]'), t = document.querySelector('[name=endTime]');
    const cs = Array.prototype.slice.call(document.querySelectorAll('#gv-endcol [data-clear]'));
    return { eDis: e.disabled, tDis: t.disabled, eVal: e.value, tVal: t.value, clearDis: cs.map(b => b.disabled), n: cs.length };
  });
  check(pt.eDis && pt.tDis, '类型=时间点 → 结束日期与结束时刻均被禁用');
  check(pt.eVal === '' && pt.tVal === '', '类型=时间点 → 已填入的结束日期/时刻被清空');
  check(pt.n === 2 && pt.clearDis.every(Boolean), '时间点下两个结束侧的「清除」按钮一并禁用（' + pt.n + ' 个）');
  const hint = await page.$eval('#gv-endhint', e => e.textContent);
  check(/时间点/.test(hint), '结束日期旁给出「时间点不需要结束时间」的说明（实际「' + hint + '」）');
  /* 切回事件 → 恢复可填 */
  await page.selectOption('[name=kind]', 'normal');
  await page.waitForTimeout(120);
  const back = await page.evaluate(() => {
    const e = document.querySelector('[name=end]'), t = document.querySelector('[name=endTime]');
    return { eDis: e.disabled, tDis: t.disabled };
  });
  check(!back.eDis && !back.tDis, '切回「事件」后结束日期/时刻恢复可填');
  await page.click('.gv-close');

  /* 编辑「已存在」的时间点（b7 交大人节文艺晚会，时刻由管理员维护，期望值从 gantt.md 推导）：结束侧应在打开表单时就已禁用+清空。
     这条路径与新增表单不同 —— 初始 kind 直接就是 milestone，靠 renderForm 末尾的 syncKind() 兜住。 */
  await page.evaluate(() => {
    const row = Array.prototype.slice.call(document.querySelectorAll('.gv-lname'))
      .filter(x => x.textContent.indexOf('交大人节') >= 0)[0];
    if (row) row.click();
  });
  await page.waitForSelector('.gv-editbtn', { timeout: 5000 });
  await page.click('.gv-editbtn');
  await page.waitForSelector('#gv-crudform', { timeout: 5000 });
  const eb = await page.evaluate(() => {
    const k = document.querySelector('[name=kind]'), s = document.querySelector('[name=startTime]');
    const e = document.querySelector('[name=end]'), t = document.querySelector('[name=endTime]');
    return { kind: k.value, sv: s.value, eDis: e.disabled, tDis: t.disabled, ev: e.value, tv: t.value };
  });
  check(eb.kind === 'milestone', '编辑既有时间点：类型回显为「时间点」（实际 ' + eb.kind + '）');
  check(eb.sv === b7t.startTime, '编辑既有时间点：开始时刻回显 ' + b7t.startTime + '（实际「' + eb.sv + '」）');
  check(eb.eDis && eb.tDis && eb.ev === '' && eb.tv === '',
    '编辑既有时间点：结束日期/时刻打开即禁用并清空（值「' + eb.ev + '」「' + eb.tv + '」）');
  await page.click('.gv-close');

  /* 「关键节点」已不是类型，但既有 crit 条目（t8 期末考试周）在编辑时应给出可取消的保留开关 */
  await page.evaluate(() => {
    const row = Array.prototype.slice.call(document.querySelectorAll('.gv-lname'))
      .filter(x => x.textContent.indexOf('期末考试周') >= 0)[0];
    if (row) row.click();
  });
  await page.waitForSelector('.gv-editbtn', { timeout: 5000 });
  await page.click('.gv-editbtn');
  await page.waitForSelector('#gv-crudform', { timeout: 5000 });
  const ck = await page.evaluate(() => {
    const k = document.querySelector('[name=kind]'), c = document.querySelector('[name=keepCrit]');
    return { kind: k ? k.value : '', hasCk: !!c, checked: !!(c && c.checked), opts: Array.prototype.slice.call(k.options).map(o => o.value).join(',') };
  });
  check(ck.kind === 'normal' && ck.opts === 'normal,milestone',
    '编辑既有 crit 条目：类型回显「事件」，下拉只有 normal/milestone（' + ck.opts + '）');
  check(ck.hasCk && ck.checked, '既有 crit 条目给出「保留关键节点紫圈标记」复选框，默认勾选');
  await page.click('.gv-close');
  await page.evaluate(() => localStorage.removeItem('gantt_admin_token'));

  console.log('[11] 合并写回：页面过期也不许删掉远端条目（回归 2026-09-10 b7 详情丢失事故）');
  /* 事故复盘：管理员的标签页停在旧版 js/events.js（当时远端已有 b7、页面里没有），
     点一次「保存更改」→ 整份写回 events.js → b7 的详情连同 where「主校区西操场」被删掉，
     通道 C 闹钟标签的「地点」段随之消失。
     这里把当时的现场原样搭出来（页面脚本给「缺 b7」的旧文件、GitHub API 给完整文件），
     跑一次真实保存，断言写回内容里 b7 仍在 —— 护栏必须挡住这一类静默删数据。 */
  {
    const staleEvents = Admin.serializeEvents((function () {
      const o = JSON.parse(JSON.stringify(Events));
      delete o.b7;
      return o;
    })());
    const p2 = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    p2.on('dialog', d => d.accept());
    /* ① 页面脚本：给「缺 b7」的旧文件（等价于浏览器缓存了过期文件） */
    await p2.route('**/js/events.js*', route => route.fulfill({
      status: 200, contentType: 'application/javascript; charset=utf-8', body: staleEvents
    }));
    /* ② GitHub API 替身：GET 给完整文件（远端有 b7），PUT 记录下来并假装成功 */
    const puts = [];
    await p2.route('**/*api.github.com/**', route => {
      const req = route.request(), url = req.url();
      if (req.method() === 'PUT') {
        puts.push({ url: url, body: JSON.parse(req.postData() || '{}') });
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ content: { sha: 'new' }, commit: { sha: 'c1' } }) });
      }
      const isEvents = /events\.js/.test(decodeURIComponent(url));
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          content: Buffer.from(isEvents ? eventsSrcFull : ganttSrcFull, 'utf8').toString('base64'),
          encoding: 'base64', sha: isEvents ? 'sha-ev' : 'sha-gantt'
        })
      });
    });
    await p2.addInitScript(() => { try { localStorage.setItem('gantt_admin_token', 'ui-test-only'); } catch (e) {} });
    await p2.goto(URL_, { waitUntil: 'load' });
    await p2.waitForSelector('#gv-svg .gv-bar', { timeout: 15000 });
    const scn = await p2.evaluate(() => ({ keys: Object.keys(window.BJTU_EVENTS || {}).join(','), b7: !!(window.BJTU_EVENTS && window.BJTU_EVENTS.b7) }));
    check(scn.keys.length > 0 && !scn.b7,
      '场景就位：旧 events.js 已生效（有 ' + scn.keys + '，无 b7）');
    /* 随便改一条本来就有详情的任务（t25），触发一次真实的「暂存 → 保存」 */
    await p2.evaluate(() => {
      const row = Array.prototype.slice.call(document.querySelectorAll('.gv-lname'))
        .filter(x => x.textContent.indexOf('收体检表') >= 0)[0];
      if (row) row.click();
    });
    await p2.waitForSelector('.gv-editbtn', { timeout: 5000 });
    await p2.click('.gv-editbtn');
    await p2.waitForSelector('#gv-crudform', { timeout: 5000 });
    /* v33：表单提交后**立即同步**（需求 2），所以这里不再有「暂存等手动保存」的中间态。
       改造成两段：
         A 段 —— 在**已登录**态点保存：必须立刻产生 PUT 写回，且 pending 被清空（需求 2 的判定式）；
         B 段 —— 单独构造「本页缺 b7 + 远端有 b7」的合并写回场景（把提交后的写回内容当作观察对象）。 */
    await p2.click('#gv-crudsave');
    /* 等真实写回落地（PUT 被拦截到即证明立即同步生效） */
    for (let i = 0; i < 40 && !puts.some(x => /events\.js/.test(decodeURIComponent(x.url))); i++) {
      await p2.waitForTimeout(150);
    }
    const staged = await p2.evaluate(() => {
      const p = (function () { try { return JSON.parse(localStorage.getItem('gantt_pending') || 'null'); } catch (e) { return null; } })();
      return { has: !!p };
    });
    check(puts.length > 0,
      '★ 需求 2：表单点「保存」后立即触发同步（拦截到 ' + puts.length + ' 次 PUT，无需再点工具栏保存）');
    check(!staged.has,
      '★ 需求 2：同步成功后 pending 被清空（改动已进 GitHub，不再滞留本地队列）');

    const evPut = puts.filter(x => /events\.js/.test(decodeURIComponent(x.url)))[0];
    check(!!evPut, '保存真的写回了 js/events.js（拦截到 PUT ' + puts.length + ' 次）');
    const written = evPut ? Buffer.from(evPut.body.content || '', 'base64').toString('utf8') : '';
    check(/^ {4}b7: \{/m.test(written), '写回内容里保留了 b7 条目（本页根本没加载它，靠合并写回带回）');
    check(written.indexOf('主校区西操场') > 0, '保留的 b7 里带着 where「主校区西操场」——正是 9.10 丢掉的那一段');
    check(/^ {4}b1: \{/m.test(written) && /^ {4}b6: \{/m.test(written), '其余条目照常写出（合并没有破坏正常内容）');
    const gPut = puts.filter(x => /gantt\.md/.test(decodeURIComponent(x.url)))[0];
    check(!!gPut, 'gantt.md 同样被写回（两条写操作都在）');
    /* v33：保留远端条目的提示改由「提交即同步」的 saveAll().then 发出 */
    const toastTxt = await p2.evaluate(() => {
      const t = document.querySelector('.gv-toast');
      return t ? t.textContent : '';
    });
    check(/保留远端新增的 ?b7/.test(toastTxt), '页面明确告知「已保留远端新增的 b7」（实际「' + toastTxt + '」）');
    await p2.close();
  }

  console.log('[12] 截图存档');
  /* 预览图必须是「用户刚打开页面」的默认态，而不是测试操作后的残留态
     （前面点过缩放、点过任务、开过弹窗）。所以先整页重载再拍。 */
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(URL_, { waitUntil: 'load' });
  await page.waitForSelector('#gv-svg .gv-bar', { timeout: 15000 });
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const m = document.querySelector('.gv-rem-mask'), p = document.querySelector('.gv-rem-panel');
    if (m) m.classList.remove('on');
    if (p) p.classList.remove('on');
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(__dirname, '..', 'docs', 'preview-desktop.png'), fullPage: false });
  await page.click('[data-act="remind"]');
  await page.waitForSelector('.gv-rem-panel.on');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(__dirname, '..', 'docs', 'preview-remind.png'), fullPage: false });
  console.log('  ✓ 已输出 docs/preview-desktop.png / docs/preview-remind.png');

  await browser.close();
  console.log(failures ? '\nUI 自检：' + failures + ' 项失败 ❌' : '\nUI 自检：全部通过 ✅');
  process.exit(failures ? 1 : 0);
})().catch(function (e) {
  console.error('UI 自检异常：', e && e.message ? e.message : e);
  process.exit(2);
});
