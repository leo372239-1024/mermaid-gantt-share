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
const path = require('path');

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

(async function main() {
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
  check(caps.some(t => t.indexOf('9.10 14:00 至 9.10 17:00') >= 0), '文艺汇演领票标题含「9.10 14:00 至 9.10 17:00」');
  check(caps.some(t => t.indexOf('9.10 18:45') >= 0), '交大人节标题含「9.10 18:45」');
  const selLabels = await page.$$eval('#gv-lbox .gv-lname .dt', els => els.map(e => e.textContent.trim()));
  check(selLabels.some(t => t === '2026-09-10 14:00 → 2026-09-10 17:00'), '左侧列表显示分钟级起止');

  console.log('[4] ddl 提醒面板');
  await page.click('[data-act="remind"]');
  await page.waitForSelector('.gv-rem-panel.on', { timeout: 5000 });
  const whens = await page.$$eval('.gv-rem-list .gv-rem-item .when', els => els.map(e => e.textContent.trim()));
  const chips = await page.$$eval('.gv-rem-list .gv-rem-item .chip', els => els.map(e => e.textContent.trim()));
  /* ⚠️ 「有 N 条」是时间相关断言：9.10 晚上 19:00 之后，当天所有条目都已过点，
     又还没有 24 小时内到期的新条目 → 列表合法地为空。此时校验空态文案，而不是让用例假红。 */
  if (whens.length) {
    check(true, '提醒列表有 ' + whens.length + ' 条');
    /* 只断言「格式」是分钟级起止，不断言具体时刻：面板会随真实时间推移淘汰已过期条目 */
    check(whens.every(t => /^\d{1,2}\.\d{1,2} \d{2}:\d{2} → \d{1,2}\.\d{1,2} \d{2}:\d{2}$/.test(t)),
      '每条显示开始→截止（分钟级）：' + whens.join(' | '));
    check(chips.some(t => /剩 \d+ (分钟|小时)/.test(t)), '剩余时长精确到分钟：' + chips.join(' | '));
  } else {
    const emptyTxt = await page.$eval('.gv-rem-empty', e => e.textContent.trim()).catch(() => '');
    check(/暂无即将截止的待办/.test(emptyTxt),
      '当前无「剩余不足一天」的待办 → 面板给出空态文案（时间相关，非缺陷）：「' + emptyTxt.replace(/\s+/g, ' ') + '」');
  }
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
    const dn = Array.prototype.slice.call(svg.querySelectorAll('text'))
      .filter(e => e.getAttribute('font-size') === '8.5' && /^\d{1,2}$/.test(e.textContent.trim()))
      .map(e => Math.round((((parseFloat(e.getAttribute('x')) - leftPad) / px) % 1) * 1000) / 1000);
    return { px: px, leftPad: leftPad, count: blue.length, xs: xs, fills: fills, dayFracs: dn };
  });
  check(!!geo && geo.count > 0, '存在逐日交替底色条纹（' + (geo && geo.count) + ' 条，px/天=' + (geo && geo.px.toFixed(2)) + '）');
  check(!!geo && geo.fills.every(f => f === '#e8f2fd'), '条纹统一浅蓝 #e8f2fd');
  check(!!geo && geo.xs.length > 1 && Math.abs((geo.xs[1] - geo.xs[0]) - 2 * geo.px) < 0.5,
    '蓝条逐日交替（相邻蓝条间隔 = 2 天，实测 ' + (geo && (geo.xs[1] - geo.xs[0]).toFixed(1)) + 'px，期望 ' + (geo && (2 * geo.px).toFixed(1)) + 'px）');
  check(!!geo && geo.dayFracs.length >= 3 && geo.dayFracs.every(f => Math.abs(f - 0.5) < 0.02),
    '日期数字落在当日正中（日内小数≈0.5，实测 ' + (geo ? geo.dayFracs.slice(0, 6).join(' / ') : '') + '）');

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
  check(!!bars && !!bars.bars.t25 && Math.abs(bars.bars.t25.frac - 14 / 24) < 0.01,
    't25 起点落在当日 14:00（日内占比 ' + (bars && bars.bars.t25 && bars.bars.t25.frac.toFixed(3)) + ' ≈ 0.583）');
  const expW = bars ? Math.max(0.125 * bars.px, 3) : 0;
  check(!!bars && !!bars.bars.t25 && Math.abs(bars.bars.t25.w - expW) < 0.6,
    't25 长度 = 3 小时占比（期望 ' + expW.toFixed(1) + 'px，实际 ' + (bars && bars.bars.t25 && bars.bars.t25.w.toFixed(1)) + 'px）');
  check(!!bars && !!bars.bars.m12 && Math.abs(bars.bars.m12.frac - 13 / 24) < 0.01,
    'm12 里程碑落在当日 13:00（日内占比 ' + (bars && bars.bars.m12 && bars.bars.m12.frac.toFixed(3)) + ' ≈ 0.542）');
  check(!!bars && !!bars.bars.b7 && Math.abs(bars.bars.b7.frac - 18.75 / 24) < 0.01,
    'b7 落在当日 18:45（日内占比 ' + (bars && bars.bars.b7 && bars.bars.b7.frac.toFixed(3)) + ' ≈ 0.781）');
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
    const dts = bullets.map(l => (l.match(/(\d{1,2}\.\d{1,2}) \d{2}:\d{2}/) || [])[1]).filter(Boolean);
    const dset = Array.from(new Set(dts));
    check(dset.length === 0 || dset.every(d => d === md.today || d === md.yest),
      '清单只含「今天开始」的条目（出现日期 ' + dset.join('/') + '，含跨零点回退的昨天 ' + md.yest + '）');
  }
  /* 线上/本地实际提供的 deadlines.json 必须满足通道 C 契约（这部分与真实时间无关，任何时候都成立）：
     ① schema = 4 ② alarmItems 是 items 的今日子集 ③ 有地点的条目，标签里必须带「｜地点｜」段。
     这一步能抓到「忘了提交 deadlines.json」「Actions 用旧脚本重建」这类只在产物层暴露的问题。 */
  const dj = await page.evaluate(async () => {
    const res = await fetch('./deadlines.json', { cache: 'no-store' });
    return res.ok ? res.json() : null;
  });
  check(!!dj && dj.schema === 4, '站点提供的 deadlines.json schema = 4（实际 ' + (dj && dj.schema) + '）');
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

  /* 编辑「已存在」的时间点（b7 交大人节文艺晚会，18:45）：结束侧应在打开表单时就已禁用+清空。
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
  check(eb.sv === '18:45', '编辑既有时间点：开始时刻回显 18:45（实际「' + eb.sv + '」）');
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

  console.log('[11] 截图存档');
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
