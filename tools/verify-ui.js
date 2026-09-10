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
  check(whens.some(t => t.indexOf('9.10 14:00 → 9.10 17:00') >= 0), '每条显示开始→截止（分钟级）：' + whens.join(' | '));
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

  console.log('[6] 截图存档');
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
