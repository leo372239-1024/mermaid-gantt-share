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

  /* v33：表单取消「阶段」字段后，新增条目统一归入这个 section。
     为什么不让表单自动选第一个 section：那会让新条目混进「入学前准备」这类语义明确的阶段里，
     反而更难找；显式给一个中性的收纳区，语义清晰、也不影响既有阶段的内容。 */
  var FALLBACK_SECTION = '新增事项';

  /* ---------- 日期工具（与 parser 保持一致） ---------- */
  var DAY = 86400000;
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function fmt(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  /* 带可选时分的日期输出：time 为 'HH:mm' 字符串（空则仅日期） */
  function fmtDT(d, time) { return time ? fmt(d) + ' ' + time : fmt(d); }
  function diffDays(a, b) { return Math.round((b - a) / DAY); }
  /* 忽略时分后的整天数差（用于判断是否同一天） */
  function dateGap(a, b) {
    var A = new Date(a.getFullYear(), a.getMonth(), a.getDate());
    var B = new Date(b.getFullYear(), b.getMonth(), b.getDate());
    return Math.round((B - A) / DAY);
  }
  function parseDate(s) {
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(s).trim());
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3]);
  }

  /* ---------- 序列化：模型 → mermaid 块 ---------- */
  /* 单行任务：`名称 :状态, id, 开始, 结束|0d`
     状态按 milestone/crit/done/active 组合输出。
     若任务带时分：跨天输出两端 `YYYY-MM-DD HH:mm`；同日则保留两端的时刻（表达当日时间段）；
     完全无时刻且同日时才写 0d（单日/里程碑点）。 */
  function taskLine(t) {
    var sts = [];
    if (t.milestone) sts.push('milestone');
    if (t.crit) sts.push('crit');
    if (t.done) sts.push('done');
    if (t.active) sts.push('active');
    var st = sts.length ? sts.join(',') + ', ' : '';
    var start = fmtDT(t.start, t.startTime);
    var endPart;
    if (t.end) {
      if (dateGap(t.start, t.end) > 0) {
        endPart = fmtDT(t.end, t.endTime);        // 跨天：两端带时间
      } else if (t.startTime || t.endTime) {
        endPart = fmtDT(t.end, t.endTime || t.startTime); // 同日且带时间：保留结束时刻
      } else {
        endPart = '0d';                            // 同日无时刻：单日点
      }
    } else {
      endPart = '0d';
    }
    return t.name + ' :' + st + t.id + ', ' + start + ', ' + endPart;
  }

  function serializeGantt(model) {
    var L = [];
    L.push('gantt');
    if (model.title) L.push('    title ' + model.title);
    /* 只要有任一任务带时分，dateFormat 就用含 HH:mm 的格式，保证标准 mermaid 也能解析 */
    var hasTime = model.sections.some(function (s) {
      return s.tasks.some(function (t) { return t.startTime || t.endTime; });
    });
    L.push(hasTime ? '    dateFormat YYYY-MM-DD HH:mm' : '    dateFormat YYYY-MM-DD');
    L.push('    axisFormat %Y-%m');
    /* v33：兜底 section —— 表单已取消「阶段」字段，新增条目若被放进一个不存在的 section，
       而这里又无脑 forEach，那条任务就会被静默丢掉（保存后「新增了但图上没有」）。
       因此只要模型里存在「不属于任何已知 section」的任务，就自动补一个兜底 section 承载它们。
       为什么放在末尾：保持既有 section 顺序不变（避免每次保存都重排 gantt.md 产生无意义 diff）。 */
    var known = {};
    (model.sections || []).forEach(function (sec) { known[sec.name] = true; });
    /* v40：逐层复制（数组 + section 对象 + tasks 数组），让本函数保持**纯函数**。
       旧写法 `.slice()` 只复制了外层数组，下面「把孤立任务并入已存在的兜底 section」那一步
       会顺手改到调用方 model 里的 section 对象 —— 同一个 model 序列化两次就会把孤立任务写两遍。
       当前调用点恰好不会踩到（handleSubmit 里 secExists 与 orphans 互斥），但这是个哑雷。 */
    var sections = (model.sections || []).map(function (sec) {
      return { name: sec.name, tasks: (sec.tasks || []).slice() };
    });
    /* 兜底 section 的三种情形（2026-09-19 修复「新增条目被静默丢弃」）：
       ①无孤立任务 → 什么都不做（凭空造空 section 会把 gantt.md 写脏）；
       ②有孤立任务且兜底 section 尚不存在 → 在**末尾**新补一个承载它们；
       ③有孤立任务且兜底 section 已存在 → **把任务并进那个已存在的 section**。

       ③ 是本次修掉的真实数据丢失 bug。线上 gantt.md 因「网页端新增→删除」残留了一个
       **空的**「新增事项」section（提交 3aea79c 手工清过一次，用户在线新建 t31/t32 后又出现）。
       旧逻辑写的是 `if (!known[FALLBACK] && orphans.length)`：兜底 section 一旦存在就跳过整段，
       而 model.orphans 并不在 model.sections 里、下面的 forEach 根本遍历不到它 —— 于是用户
       新填的条目被静默丢弃，前端却照常弹「已同步」。这正是用户曾报告过的「新增了但图上没有」。
       注意不能改成「先删掉已存在的空兜底 section 再 push」：那会把它在文件里的**位置**从
       中间挪到末尾（线上它排在 a1/课表之前），产生无意义 diff。原地并入则位置稳定。 */
    var orphanTasks = (model.orphans || []).filter(function (t) { return t && t.id; });
    if (orphanTasks.length) {
      if (!known[FALLBACK_SECTION]) {
        sections.push({ name: FALLBACK_SECTION, tasks: orphanTasks });
      } else {
        sections.forEach(function (sec) {
          if (sec.name === FALLBACK_SECTION) {
            sec.tasks = (sec.tasks || []).concat(orphanTasks);
          }
        });
      }
    }
    sections.forEach(function (sec) {
      L.push('    section ' + sec.name);
      sec.tasks.forEach(function (t) { L.push('    ' + taskLine(t)); });
    });
    return L.join('\n');
  }

  /* ---------- gantt.md（mermaid 块）的合并写回与 id 对账 ----------
     与 events.js 的 keepBlocks 同源思路：写回 = 「本页为准」+「远端本页未知的条目按原文保留」。
     为什么必须做（2026-10-09 真实数据丢失事故）：
       线上 gantt.md 曾出现两次同 id 的提交 ——
         38d2865  sync: add: m19 团推优会议
         ef18082  sync: add: m19 交积极分子材料      ← 把上一条整行替换掉了
       成因是 genId 只扫**本页 model**：页面数据过期（远端已有 m19、本页没有）时，
       新条目又被分配成 m19；而 gantt.md 当时是**整块替换**，
       旧护栏 precheckDrift 只比对「id 集合」，撞车后两边集合完全一致 → 判为「无漂移」→
       一句提示都没有，远端的「团推优会议」被静默覆盖，前端照常弹「已同步」。
       本段提供两道根治护栏：
         ① mergeGantt     —— 远端有、本页没有、且未被显式删除的任务行一律保留（只少写，不删）
         ② reconcileGantt —— 「本页新建」的 id 若已被远端占用，换一个两边都没占用的 id
     */

  /* 任务行里「状态词」全集（与 taskLine 的输出严格对应） */
  var STATE_WORDS = { milestone: 1, crit: 1, done: 1, active: 1 };
  /* 头部指令行（不是任务行）—— 与 js/parser.js 第 89~91 行识别的指令集合保持一致 */
  var HEAD_LINE = /^(gantt|title|dateFormat|axisFormat|excludes|topAxis|todayMarker|inclusiveEndDates|barGap|barHeight|useMaxWidth)\b/;
  /* 日期 token（含可选时分）—— 与 js/parser.js 的 toDateT 同一形状 */
  var DATE_TOKEN = /^\d{4}-\d{1,2}-\d{1,2}(?:\s+\d{1,2}:\d{1,2})?$/;

  /* 「冒号右侧是不是合法属性开头」—— 与 js/parser.js 的 isAttrStart 同口径。
     为什么必须用这条规则而不是 indexOf(':')：任务名里可能含时刻
     （如「数据科学与知识工程(周二·11.03 08:00-09:50 YF305) :k1w09, …」），
     名称里的那个冒号右侧是「00-09:50 YF305) :k1w09」——不是合法属性开头，会被跳过。 */
  function isAttrStart(head) {
    if (!head) return false;
    var tok = String(head).split(',')[0].trim();
    if (!tok) return false;
    if (STATE_WORDS[tok]) return true;
    if (/^after\s+[^\s,]+$/i.test(tok)) return true;
    if (DATE_TOKEN.test(tok)) return true;
    if (/^\d+d$/i.test(tok)) return true;
    if (/^[\w.#-]+$/.test(tok)) return true;
    return false;
  }

  /* 按「名称:属性」切分任务行（与 js/parser.js 第 103~109 行同口径）。
     test/unit.js [15f] 用真实 gantt.md 断言两者取出的 id 集合**完全相等** ——
     一旦解析器改了切分规则，这条断言会立刻红，不会让两套口径悄悄漂移。 */
  function splitTaskLine(line) {
    var s = String(line == null ? '' : line).replace(/\r$/, '');
    for (var i = 0; i < s.length; i++) {
      if (s.charAt(i) !== ':') continue;
      var candRaw = s.slice(i + 1).trim();
      var candName = s.slice(0, i).trim();
      if (candName && isAttrStart(candRaw)) {
        return {
          name: candName,
          colon: i,
          head: s.slice(0, i + 1),          /* 「缩进 + 名称 + 冒号」原文（含缩进，换号时逐字保留） */
          attr: s.slice(i + 1),            /* 冒号之后的属性原文 */
          tokens: candRaw.split(',').map(function (t) { return t.trim(); }).filter(Boolean)
        };
      }
    }
    return null;
  }

  /* 任务行 → id（认不出返回 ''）。id 的语义位置是「属性段里第一个既不是状态词、
     不是 after 依赖、也不是日期/时长的 token」。 */
  function taskIdOfLine(line) {
    var s = String(line == null ? '' : line).replace(/\r$/, '');
    var t = s.trim();
    if (!t) return '';
    if (/^section\s/.test(t)) return '';
    if (HEAD_LINE.test(t)) return '';
    if (t.charAt(0) === '#' || t.charAt(0) === '%') return '';   /* mermaid 注释 */
    var sp = splitTaskLine(t);
    if (!sp) return '';
    for (var k = 0; k < sp.tokens.length; k++) {
      var p = sp.tokens[k];
      if (STATE_WORDS[p]) continue;
      if (/^after\s+/i.test(p)) continue;
      if (DATE_TOKEN.test(p)) return '';     /* 已经走到日期了 → 本行没有 id */
      if (/^\d+d$/i.test(p)) return '';
      return p;
    }
    return '';
  }

  /* mermaid 代码块 → 结构：{ head:[...], sections:[{name, lines:[...]}], orphans:[...] }
     head   = 第一个 section 之前的头部指令（gantt / title / dateFormat / axisFormat）
     orphans= section 之前出现的任务行（异常结构，保留但不参与合并定位） */
  function mermaidStructure(code) {
    var lines = String(code == null ? '' : code).replace(/\r\n/g, '\n').split('\n');
    var head = [], sections = [], orphans = [], cur = null, seenSection = false;
    lines.forEach(function (line) {
      var t = line.trim();
      if (!t) return;
      if (/^section\s+/.test(t)) {
        seenSection = true;
        cur = { name: t.replace(/^section\s+/, '').trim(), lines: [] };
        sections.push(cur);
        return;
      }
      if (HEAD_LINE.test(t)) { head.push(line); return; }
      if (!seenSection) { orphans.push(line); return; }
      if (cur) cur.lines.push(line);
    });
    return { head: head, sections: sections, orphans: orphans };
  }

  /* 收集一份 mermaid 代码里的全部任务 id */
  function taskIdsIn(code) {
    var out = {};
    mermaidStructure(code).sections.forEach(function (s) {
      s.lines.forEach(function (l) { var id = taskIdOfLine(l); if (id) out[id] = 1; });
    });
    return out;
  }

  /* 把 mermaid 里 id 为 oldId 的任务行改成 newId（只动 id 那一段，其余逐字保留） */
  function renameTaskIdInCode(code, oldId, newId) {
    if (!oldId || !newId || oldId === newId) return code;
    return String(code == null ? '' : code).split('\n').map(function (line) {
      if (taskIdOfLine(line) !== oldId) return line;
      var sp = splitTaskLine(line);
      if (!sp) return line;
      var parts = sp.attr.split(',');
      for (var k = 0; k < parts.length; k++) {
        if (parts[k].trim() === oldId) {
          parts[k] = parts[k].replace(oldId, newId);   /* 保留原有空格 */
          return sp.head + parts.join(',');
        }
      }
      return line;
    }).join('\n');
  }

  /* 取一个两边都没占用的 id（保持原前缀与「数字递增」风格：m19 → m20 → m21…） */
  function nextFreeId(base, used) {
    var m = /^([A-Za-z_]*)(\d*)$/.exec(String(base == null ? '' : base));
    var pre = (m && m[1]) ? m[1] : String(base == null ? '' : base) || 'x';
    var n = (m && m[2]) ? parseInt(m[2], 10) : 0;
    var cand;
    do { n++; cand = pre + n; } while (used && used[cand]);
    return cand;
  }

  /* 合并写回：远端有、本页没有、且不在显式删除名单里的任务行 → 按原 section 逐字保留。
     返回 { code, kept:[id…] }。kept 供前端告知用户「保留了什么」。
     认不出 id 的远端行也一律保留 —— 宁多不少（多写的行解析器会忽略，丢了的行找不回来）。 */
  function mergeGantt(remoteCode, localCode, delIds) {
    var local = mermaidStructure(localCode);
    var remote = mermaidStructure(remoteCode);
    var del = delIds || [];
    var localIds = taskIdsIn(localCode);
    var kept = [];
    function put(name, line) {
      var target = null;
      local.sections.forEach(function (s) { if (s.name === name) target = s; });
      if (!target) { target = { name: name || FALLBACK_SECTION, lines: [] }; local.sections.push(target); }
      target.lines.push(line);
    }
    remote.sections.forEach(function (rs) {
      rs.lines.forEach(function (line) {
        var id = taskIdOfLine(line);
        if (id) {
          if (localIds[id] || del.indexOf(id) >= 0) return;   /* 本页已有 / 本页显式删除 → 不保留 */
          localIds[id] = 1;
          kept.push(id);
        } else if (!String(line).trim()) {
          return;
        }
        put(rs.name, line);
      });
    });
    remote.orphans.forEach(function (line) { put(FALLBACK_SECTION, line); });
    var out = local.head.slice();
    local.sections.forEach(function (s) {
      out.push('    section ' + s.name);
      s.lines.forEach(function (l) { out.push(l); });
    });
    return { code: out.join('\n'), kept: kept };
  }

  /* 写回前的对账（纯函数，test/unit.js 有断言）：
     ① 本页**新建**的 id 若已被远端占用 → 换 id（否则合并后会出现两条同 id，详情映射会错乱）
     ② 远端多出的条目 → 合并保留
     newIds：本页本次新建的 id 清单（由 viewer 记账）。只对「新建」的 id 做换号 ——
     本页对既有条目的编辑（update）不换号，那是正常的「本地覆盖远端」。 */
  function reconcileGantt(remoteCode, localCode, delIds, newIds) {
    var code = String(localCode == null ? '' : localCode);
    var renames = {};
    if (!code) return { code: code, kept: [], renames: renames };
    var used = taskIdsIn(code);
    var remoteIds = taskIdsIn(remoteCode);
    Object.keys(remoteIds).forEach(function (k) { used[k] = 1; });
    (newIds || []).forEach(function (id) {
      if (!id || !remoteIds[id]) return;      /* 只在「与远端撞车」时换号 */
      var next = nextFreeId(id, used);
      renames[id] = next;
      used[next] = 1;
      code = renameTaskIdInCode(code, id, next);
    });
    var merged = mergeGantt(remoteCode, code, delIds);
    return { code: merged.code, kept: merged.kept, renames: renames };
  }

  /* ---------- 序列化：events 数据 → events.js 全文 ---------- */
  function jsStr(v) { return JSON.stringify(v == null ? '' : String(v)); }
  function jsArr(v) { return JSON.stringify(v && v.length ? v : []); }
  function ownersCall(owners) {
    var names = (owners || []).map(function (o) { return o.name; });
    return 'owners(' + JSON.stringify(names) + ')';
  }

  /* ---------- 从 events.js 源码里切出各条目的「原文块」 ----------
     为什么需要（2026-09-10 真实事故）：写回是「整份覆盖」，本页的 events 若来自浏览器缓存的
     旧 js/events.js，写回就会把远端新增的条目静默删掉 —— b7 的详情（连同 where「主校区西操场」）
     就是这样被覆盖丢失的，且因为地点丢失，通道 C 闹钟标签的「地点」段也跟着没了。
     这里按 serializeEvents 的固定缩进（条目 4 空格开头、块尾 `    },`）做**行级切片**：
     只取原文，不 eval、不解析 JS 值，远端文件即便被手工改过也不会被执行。
     返回 { key: '     key: {\n…\n    },' }（含末尾逗号，可直接回填正文）。 */
  function blocksOf(src) {
    var s = String(src == null ? '' : src);
    /* 与 viewer.js 的 evKeysOf 用同一条正则，保证「判定为条目的行」与「能切出块的行」永远一致 */
    var OPEN = /^ {4}([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*\{/gm;
    var out = {}, m;
    while ((m = OPEN.exec(s)) !== null) {
      var close = s.indexOf('\n    },', OPEN.lastIndex);
      if (close < 0) {
        /* 宁可这次保存失败，也不能把文件截断成一个坏文件 */
        throw new Error('events.js 结构异常：条目「' + m[1] + '」缺少结束行「    },」，已中止保存');
      }
      /* 统一换行：仓库里 events.js 是 LF；本地 Windows 检出可能是 CRLF。
         保留块与其余正文拼在一起时必须同一种换行，否则整个文件会变成混合行尾。 */
      out[m[1]] = s.slice(m.index, close + '\n    },'.length).replace(/\r\n/g, '\n');
      OPEN.lastIndex = close + '\n    },'.length;
    }
    return out;
  }

  /* 计算「这一轮要按原文保留的远端条目」：远端有、本页没有、且不在显式删除名单里。
     这是合并写回的唯一判据（纯函数，test/unit.js [13] 有断言）。
     delIds 只由「删任务 / 取消勾选含详情」两处产生 —— 除用户明确表达删除之外，
     任何「本页没有」都只当作「本页没加载到」，一律保留。 */
  function keepBlocks(remoteSrc, localEvents, delIds) {
    var local = Object.keys(localEvents || {}).filter(function (k) { return k !== '_roles'; });
    var del = delIds || [];
    var blocks = blocksOf(remoteSrc), keep = {};
    Object.keys(blocks).forEach(function (k) {
      if (local.indexOf(k) >= 0) return;
      if (del.indexOf(k) >= 0) return;
      keep[k] = blocks[k];
    });
    return keep;
  }

  /* keepRaw（可选）：本页没有、远端有的条目原文块 → 逐字保留，合并写回。
     这是「保存不会丢数据」的护栏：页面过期只会「少写」，绝不会「删掉别人的东西」。 */
  function serializeEvents(eventsData, keepRaw) {
    var roles = eventsData._roles || {};
    var keep = keepRaw || {};
    var own = Object.keys(eventsData).filter(function (k) { return k !== '_roles'; });
    var extra = Object.keys(keep).filter(function (k) {
      return k !== '_roles' && own.indexOf(k) < 0 && typeof keep[k] === 'string' && keep[k];
    });
    var keys = own.concat(extra)
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
      /* 远端保留块：原文逐字回填（不重建、不改写，连注释与字段顺序都保持原样） */
      if (extra.indexOf(k) >= 0) { out.push(keep[k]); return; }
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
      out.push('      tipsImg: ' + jsStr(e.tipsImg) + ',');
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
    FALLBACK_SECTION: FALLBACK_SECTION,
    serializeGantt: serializeGantt,
    /* v40：gantt.md 的合并写回 / id 对账（纯函数，test/unit.js [15] 直接断言） */
    splitTaskLine: splitTaskLine,
    isAttrStart: isAttrStart,
    taskIdOfLine: taskIdOfLine,
    mermaidStructure: mermaidStructure,
    taskIdsIn: taskIdsIn,
    renameTaskIdInCode: renameTaskIdInCode,
    nextFreeId: nextFreeId,
    mergeGantt: mergeGantt,
    reconcileGantt: reconcileGantt,
    serializeEvents: serializeEvents,
    blocksOf: blocksOf,
    keepBlocks: keepBlocks,
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
