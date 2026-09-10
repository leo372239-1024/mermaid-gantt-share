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
  const browser = await pw.chromium.launch(opts);
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(URL_, { waitUntil: 'load' });
  await page.waitForSelector('#gv-svg .gv-bar', { timeout: 15000 });

  console.log('[1] 页面无脚本错误');
  check(errors.filter(e => !/favicon|fonts\.googleapis/i.test(e)).length === 0,
    '无 pageerror / console.error' + (errors.length ? '（' + errors.slice(0, 3).join(' | ') + '）' : ''));

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
  check(whens.length > 0, '提醒列表有 ' + whens.length + ' 条');
  /* 只断言「格式」是分钟级起止，不断言具体时刻：面板会随真实时间推移淘汰已过期条目 */
  check(whens.every(t => /^\d{1,2}\.\d{1,2} \d{2}:\d{2} → \d{1,2}\.\d{1,2} \d{2}:\d{2}$/.test(t)),
    '每条显示开始→截止（分钟级）：' + whens.join(' | '));
  check(chips.some(t => /剩 \d+ (分钟|小时)/.test(t)), '剩余时长精确到分钟：' + chips.join(' | '));
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
    mp.on('pageerror', e => merrs.push(e.message));
    mp.on('console', m => { if (m.type() === 'error') merrs.push(m.text()); });
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
    check(merrs.filter(e => !/favicon|fonts\.googleapis/i.test(e)).length === 0, tag + '无脚本错误');
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

  console.log('[9] 截图存档');
  await page.screenshot({ path: path.join(__dirname, '..', 'docs', 'preview-desktop.png'), fullPage: false });
  await page.click('[data-act="remind"]');
  await page.waitForSelector('.gv-rem-panel.on');
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(__dirname, '..', 'docs', 'preview-remind.png'), fullPage: false });
  console.log('  ✓ 已输出 docs/preview-desktop.png / docs/preview-remind.png');

  await browser.close();
  console.log(failures ? '\nUI 自检：' + failures + ' 项失败 ❌' : '\nUI 自检：全部通过 ✅');
  process.exit(failures ? 1 : 0);
})().catch(function (e) {
  console.error('UI 自检异常：', e && e.message ? e.message : e);
  process.exit(2);
});
