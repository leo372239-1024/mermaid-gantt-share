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
 *
 * ── 有效期开关（2026-10-11，v43）──
 * 默认 **永不过期**：本项目是本机/局域网单人运维的自用工具，
 * 令牌 12 小时到期带来的实际困扰（正在编辑时突然写库失败、要重新输口令）
 * 远大于它挡住的风险 —— 服务本就不对公网暴露，且写入侧另有内容护栏兜底。
 *
 * 想恢复定期过期：在 .env 里加一行 TOKEN_TTL=12h（或 30m / 7d），
 * 重启容器即生效，无需改代码。取值语义：
 *   · 0 / 空 / 非正值 / 无法解析  → 永不过期（固定令牌，不含时间戳）
 *   · 正数（如 12h、90m、3600）  → 该时长后过期
 *
 * ── 本模块的两个职责，以及为什么做成可注入 ──
 *   createAuth({ password, tokenTtl }) → 一套自洽的 issue/verify/checkPassword
 *   module.exports                     → 用 process.env 创建的**默认实例**（index.js 直接用）
 *
 * 这样拆的原因：旧版把「读环境变量」写在模块顶层，导致单测无法在不重启进程的
 * 前提下验证「换 TOKEN_TTL 行为是否跟着变」—— 而本机沙箱禁止 spawn 子进程
 * （spawnSync 报 EBUSY），子进程方案在此环境根本跑不起来。
 * 做成工厂后，测试可以在一份进程里造出任意配置的实例，测得更彻底也更稳。
 *
 * 关于「永不过期」为什么用固定串而不是「时间戳推到 100 年后」：
 *   若只把时间戳推远，同一浏览器每次登录都拿到**不同**的串，浏览器里于是堆积
 *   历史令牌；固定令牌只有一个值，语义上「口令即凭证」更直白。
 *   两种做法下**换口令都会让所有旧令牌立即失效**（签名密钥由口令派生），不受影响。
 */

const crypto = require('crypto');

/* 固定令牌的「首段」标识。用 '0' 而不是空串，是为了让令牌始终保持
   `<段>.<签名>` 的两段形状 —— verify 与前端都不必为两种模式写两套分支。 */
const PERMANENT_MARK = '0';

/*
 * 解析时长字符串 → 毫秒。返回 0 表示「永不过期」。
 * 支持 30s / 45m / 12h / 7d / 500ms，以及纯数字（按秒计，如 3600 = 1 小时）。
 * 任何无法识别或非正的值一律返回 0（安全默认：不因格式写错而把服务意外锁死）。
 */
function parseTtlMs(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!s) return 0;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/.exec(s);
  if (!m) return 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const unit = m[2] || 's';
  const mult = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }[unit] || 1000;
  const ms = n * mult;
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

/*
 * 用给定配置造一套鉴权函数。
 * @param {{password?: string, tokenTtl?: string|number}} cfg
 */
function createAuth(cfg) {
  const c = cfg || {};
  const ADMIN_PASSWORD = c.password == null ? '' : String(c.password);
  const TOKEN_TTL_MS = parseTtlMs(c.tokenTtl);
  const NEVER_EXPIRES = TOKEN_TTL_MS <= 0;

  function key() {
    return crypto.createHash('sha256')
      .update('gantt-local|' + ADMIN_PASSWORD, 'utf8')
      .digest();
  }

  function sign(payload) {
    return crypto.createHmac('sha256', key()).update(payload).digest('base64url');
  }

  function issue() {
    /* 永不过期 → 固定令牌；幂等，重复签发得到同一串 */
    if (NEVER_EXPIRES) return PERMANENT_MARK + '.' + sign(PERMANENT_MARK);
    const exp = String(Date.now() + TOKEN_TTL_MS);
    return exp + '.' + sign(exp);
  }

  function verify(token) {
    if (!token) return false;
    const s = String(token);
    const i = s.lastIndexOf('.');
    if (i <= 0) return false;                       /* 无分隔符 / 首段为空 → 拒绝 */
    const exp = s.slice(0, i);
    const sig = s.slice(i + 1);
    const expect = sign(exp);
    const a = Buffer.from(sig, 'utf8');
    const b = Buffer.from(expect, 'utf8');
    if (a.length !== b.length) return false;        /* timingSafeEqual 要求等长，先挡掉 */
    if (!crypto.timingSafeEqual(a, b)) return false;
    /* 签名已通过。用**精确字符串比较**认固定令牌 —— 不写成 Number(exp) === 0：
       那样 '0.0'、'00' 这类数值同为 0 的串也会被放行，而它们并非我们签发的固定令牌。
       固定令牌只在「本服务确实配置为永不过期」时才有效：否则一个本想过期的部署
       会被这串绕过。 */
    if (exp === PERMANENT_MARK) return NEVER_EXPIRES;
    const ts = Number(exp);
    return Number.isFinite(ts) && ts > Date.now();
  }

  function checkPassword(pw) {
    if (!ADMIN_PASSWORD) return false;
    const a = Buffer.from(String(pw == null ? '' : pw), 'utf8');
    const b = Buffer.from(ADMIN_PASSWORD, 'utf8');
    if (a.length !== b.length) return false;        /* 先比长度，再定长比较 */
    return crypto.timingSafeEqual(a, b);
  }

  return {
    issue: issue,
    verify: verify,
    checkPassword: checkPassword,
    hasPassword: !!ADMIN_PASSWORD,
    ttlMs: TOKEN_TTL_MS,
    neverExpires: NEVER_EXPIRES
  };
}

/* 默认实例：直接用 process.env（index.js require 的就是它）。
   ADMIN_PASSWORD 缺省时 hasPassword=false，登录接口会明确报「服务端未配置」，
   不会退化成「任意口令都通过」。 */
const defaultAuth = createAuth({
  password: process.env.ADMIN_PASSWORD || '',
  tokenTtl: process.env.TOKEN_TTL
});

module.exports = Object.assign({}, defaultAuth, {
  createAuth: createAuth,
  parseTtlMs: parseTtlMs,
  PERMANENT_MARK: PERMANENT_MARK
});
