/*
 * viewer.js —— 自研交互式甘特渲染器 v3（纯本地、无外部依赖）
 *
 * 能力：
 *  1) 解析 gantt.md 的 mermaid gantt 子集语法（js/parser.js）
 *  2) 自绘 SVG：今日红色竖线随打开当天自动定位（无需定时任务）
 *  3) 轨道压缩布局：任务按时间不重叠贪心分配轨道，多任务可同一行 → 总行数大幅减少
 *  4) 任务条/里程碑文字：按条宽分级显示「任务名(8.1至8.25)」；点击条/节点/左侧名均弹详情
 *  5) 点击左侧事件名 → 弹详情抽屉 + 自动滚动定位到事件日期并闪烁高亮
 *  6) 工具条：上一/下一学年、上一/下一月、回到今天、放大/缩小（以视口中心日期为锚点）
 *  7) 左侧事件索引列与顶部说明栏均可折叠（默认折叠）
 *  8) 手机横屏（窄屏 landscape）：时间图向右旋转 90° 供横屏浏览（时间纵向流动），
 *     触屏纵向滑动 / 滚轮 映射为时间滚动；桌面保持常规横向视图
 *
 *  9) 桌面 Ctrl+滚轮 缩放显示日期范围（夹紧在数据全跨度内）
 * 10) 时间轴天刻度：逐日细网格 + 【每一天】数字刻度（随缩放自动取舍）
 * 11) 事件按序号错色配色（已完成统一灰）；条内/点旁标注「名称(日期)」防重叠；
 *     条内放不下时自动降级并条尾外置（强制显示标题）
 * 12) 视图切换：常规视图 ⇄ 向右旋转90° 横屏视图（右上角按钮手动切换；手机横屏仍自动）
 * 13) 管理员编辑表单：类型只有「事件 / 时间点」两种（**时间点不设结束时间**，自动禁用+清空）；
 *     开始/结束的时刻与结束日期都有「清除」按钮（原生控件选完后无法置空）；
 *     「关键节点紫圈」是历史数据的强调标记，不再是类型，编辑既有 crit 条目时可取消
 * 14) 通道 C（快捷指令 → 时钟 App 真闹钟）：**只对「今天开始」的条目**、每条只建 1 个闹钟，
 *     时间 = 开始时刻前 15 分钟，标签 = 「名称｜地点｜开始→结束时间」（口径与
 *     tools/build-deadlines.js 的 alarmAt/alarmLabel 必须同构）
 * 15) 保存采用**合并写回**：写回 js/events.js 前先读远端原文，「远端有、本页没有、且不是本次
 *     显式删除（pending.delIds）」的条目按原文逐字保留 —— 页面过期只会少写、绝不删数据；
 *     gantt.md 因是整块替换，仍保留一道 id 级漂移体检（remote − local − delIds）。
 *
 * 用法：GanttViewer.mount(containerEl, ganttCode, eventsData)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GanttViewer = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DAY = 86400000;
  /* 工厂函数体内取全局对象必须走 globalThis（闭包拿不到外层 IIFE 的 root） */
  var G = (typeof globalThis !== 'undefined') ? globalThis
    : (typeof self !== 'undefined' ? self : this);
  var Parser = (typeof module === 'object' && module.exports)
    ? require('./parser.js')
    : (G.GanttParser || {});
  /* .ics 生成器（网页与构建脚本共用；缺省时相关按钮降级提示，不影响主图渲染） */
  var Ics = (typeof module === 'object' && module.exports)
    ? require('./ics.js')
    : (G.GanttIcs || null);

  var CSS = String.raw`
.gv-root{--gv-blue:#4f46e5;--gv-blue-50:#eef2ff;--gv-blue-100:#e0e7ff;--gv-blue-700:#3730a3;
  --gv-ink:#0f172a;--gv-body:#475569;--gv-sub:#64748b;--gv-line:#e2e8f0;--gv-line-soft:#f1f5f9;
  --gv-card:#ffffff;--gv-radius:12px;
  font-family:"Inter","PingFang SC","Microsoft YaHei",system-ui,sans-serif;
  color:var(--gv-ink);--gv-rowh:30px;line-height:1.6;background:#fafafa}
.gv-root *{box-sizing:border-box}
.gv-toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;background:var(--gv-card);
  border:1px solid var(--gv-line);border-radius:14px;padding:10px 12px;margin:12px 0 8px;
  position:sticky;top:0;z-index:30;
  box-shadow:0 1px 2px rgba(15,23,42,.04),0 12px 28px -16px rgba(79,70,229,.14)}
.gv-tbtn{appearance:none;border:1px solid #e2e8f0;background:#fff;color:#334155;border-radius:9px;
  padding:6px 12px;font-size:13px;line-height:1.2;cursor:pointer;display:inline-flex;align-items:center;gap:4px;
  touch-action:manipulation;transition:transform .3s,box-shadow .3s,background .3s,border-color .3s,color .3s;
  box-shadow:0 1px 2px rgba(15,23,42,.05)}
.gv-tbtn:hover{transform:translateY(-1px);background:#f8fafc;border-color:#c7d2fe;color:#3730a3;
  box-shadow:0 2px 6px rgba(79,70,229,.14)}
.gv-tbtn:active{transform:translateY(0)}
.gv-tbtn.primary{background:linear-gradient(135deg,#4f46e5,#6366f1);color:#fff;border-color:transparent;
  font-weight:600;box-shadow:0 4px 14px -4px rgba(79,70,229,.45)}
.gv-tbtn.primary:hover{transform:translateY(-1px);background:linear-gradient(135deg,#4338ca,#4f46e5);
  border-color:transparent;color:#fff;box-shadow:0 8px 22px -6px rgba(79,70,229,.5)}
.gv-tbtn.gv-fsbtn{color:#475569;border-color:#e2e8f0}
.gv-tbtn.gv-fsbtn:hover{color:#3730a3}
/* 浏览器内全屏：原生 Fullscreen API 生效态（桌面/Android/iPad） */
.gv-root:fullscreen{background:#fafafa;overflow:auto;padding:14px 16px;width:100%;height:100%}
.gv-root:-webkit-full-screen{background:#fafafa;overflow:auto;padding:14px 16px;width:100%;height:100%}
/* CSS 模拟全屏（iPhone 等不支持 Element.requestFullscreen 的环境兜底） */
.gv-root.faux-full{position:fixed;inset:0;z-index:999;background:#fafafa;overflow:auto;padding:14px 16px}
.gv-range{font-size:12px;color:var(--gv-sub);background:#f8fafc;border:1px solid #eef1f6;border-radius:8px;
  padding:5px 11px;white-space:nowrap;font-variant-numeric:tabular-nums}
.gv-range b{color:var(--gv-blue-700);font-weight:600}
.gv-legend{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:11.5px;color:var(--gv-sub);margin:2px 4px 8px}
.gv-legend i{display:inline-block;width:20px;height:3px;border-radius:2px;margin-right:5px;vertical-align:middle}
.gv-legend i.dia{width:8px;height:8px;transform:rotate(45deg);border-radius:1.5px}
.gv-legend i.today{width:2px;height:12px;background:linear-gradient(#ef4444,#dc2626);margin-right:5px;border-radius:1px}
.gv-legend .hint{opacity:.75}
.gv-body{display:flex;align-items:stretch;background:var(--gv-card);border:1px solid var(--gv-line);
  border-radius:14px;overflow:hidden;
  box-shadow:0 1px 2px rgba(15,23,42,.04),0 16px 40px -24px rgba(15,23,42,.1)}
/* ---- 左侧事件索引列（与轨道行解耦，可折叠） ---- */
.gv-labels{flex:0 0 auto;width:176px;border-right:1px solid var(--gv-line);background:#fff;
  position:relative;z-index:5;display:flex;flex-direction:column;min-height:140px}
.gv-labels.collapsed{width:34px;min-height:0}
.gv-labels.collapsed .gv-lhead{flex-direction:column;gap:8px;padding:8px 3px;background:#fafbff}
.gv-labels.collapsed .gv-lhead .gv-lttl{display:none}
.gv-labels.collapsed .gv-lbox{display:none}
.gv-lhead{flex:0 0 auto;display:flex;align-items:center;gap:6px;padding:7px 9px;font-size:12px;font-weight:700;
  color:#4338ca;background:linear-gradient(180deg,#f5f7ff,#fafbff);border-bottom:1px solid var(--gv-line-soft)}
.gv-lhead .cnt{color:#64748b;font-weight:600;font-size:11px;background:#fff;border:1px solid #e2e8f0;
  border-radius:999px;padding:0 8px}
.gv-lttl{white-space:nowrap;letter-spacing:.2px}
.gv-chev{flex:0 0 auto;border:1px solid #c7d2fe;background:#fff;color:#4f46e5;border-radius:8px;cursor:pointer;
  font-size:12px;line-height:1;padding:5px 8px;transition:background .2s,transform .2s}
.gv-chev:hover{background:#eef2ff;transform:translateY(-1px)}
.gv-lbox{flex:1 1 auto;overflow-y:auto;overscroll-behavior:contain;padding-bottom:4px}
.gv-lsec{position:sticky;top:0;background:linear-gradient(180deg,#eef2ff,#f5f7ff);color:#4338ca;font-weight:700;
  font-size:11px;padding:5px 9px;z-index:2;border-bottom:1px solid var(--gv-line-soft);letter-spacing:.2px}
.gv-lname{display:flex;align-items:flex-start;gap:5px;padding:6px 9px;cursor:pointer;font-size:11.5px;color:#334155;
  border-bottom:1px solid #f8fafc;line-height:1.5;transition:background .15s}
.gv-lname:hover{background:#f5f7ff}
.gv-lname.active{background:#eef2ff;color:#4338ca}
.gv-lname .dot{flex:0 0 auto;font-size:10px;line-height:1.6}
.gv-lname .nm{flex:1 1 auto;min-width:0}
.gv-lname .nm b{display:block;font-weight:600;color:#1e293b;font-size:11.5px;white-space:normal;word-break:break-all}
.gv-lname .nm .dt{display:block;font-size:10px;color:#94a3b8;font-weight:400;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* ---- 右侧滚动时间图 ---- */
.gv-scroll{flex:1 1 auto;overflow-x:auto;overflow-y:hidden;-webkit-overflow-scrolling:touch;overscroll-behavior-x:contain;min-width:0}
.gv-scroll svg{display:block}
.gv-err{color:#991b1b;background:#fef2f2;border:1px solid #fecaca;border-radius:12px;padding:13px 16px;font-size:12.5px;margin:12px 0 0;white-space:pre-wrap}
.gv-warn{color:#92400e;background:#fffbeb;border:1px solid #fde68a;border-radius:12px;padding:11px 16px;font-size:12.5px;margin:12px 0 0;white-space:pre-wrap}
.gv-bar{cursor:pointer}
.gv-hit{cursor:pointer}
.gv-flash{animation:gvFlash 1.2s ease-in-out 2}
@keyframes gvFlash{0%,100%{opacity:1}50%{opacity:.3}}
/* 详情中心弹窗（fixed 相对视口；全屏时 .gv-root:fullscreen 成为 containing block，仍居中显示） */
.gv-mask{position:fixed;inset:0;background:rgba(15,23,42,.4);z-index:60;opacity:0;transition:opacity .18s;pointer-events:none;-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px)}
.gv-mask.on{opacity:1;pointer-events:auto}
.gv-drawer{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%) scale(.96);
  width:min(640px,calc(100vw - 32px));max-height:86vh;overflow-y:auto;background:#fff;z-index:61;
  border-radius:18px;padding:16px 20px 20px;opacity:0;pointer-events:none;
  transition:opacity .22s,transform .22s cubic-bezier(.2,.8,.25,1);box-shadow:0 24px 64px -16px rgba(15,23,42,.35)}
.gv-drawer.on{opacity:1;transform:translate(-50%,-50%) scale(1);pointer-events:auto}
.gv-drawer .grab{width:44px;height:4px;border-radius:2px;background:#e2e8f0;margin:0 auto 12px}
.gv-dhead{font-size:18px;font-weight:700;color:#0f172a;margin:2px 0;display:flex;align-items:center;gap:8px;flex-wrap:wrap;line-height:1.3}
.gv-dsub{font-size:12px;color:var(--gv-sub);margin-bottom:12px;line-height:1.8}
.gv-chip{display:inline-block;font-size:11px;border-radius:999px;padding:2px 10px;font-weight:600;margin:0 5px 4px 0}
.gv-chip.c1{background:#fffbeb;color:#92400e}.gv-chip.c2{background:#ecfdf5;color:#065f46}
.gv-chip.c3{background:#f5f3ff;color:#6d28d9}.gv-chip.c4{background:#eef2ff;color:#4338ca}
.gv-drow{display:flex;gap:10px;padding:9px 0;border-top:1px solid #f1f5f9;font-size:13px}
.gv-drow .k{flex:0 0 80px;color:var(--gv-sub);font-size:12px;padding-top:2px}
.gv-drow .v{flex:1 1 auto;color:#1e293b;line-height:1.7;word-break:break-word}
.gv-steps{margin:2px 0;padding:0;list-style:none}
.gv-steps li{padding:2px 0 2px 18px;position:relative}
.gv-steps li::before{content:"";position:absolute;left:3px;top:11px;width:6px;height:6px;border-radius:50%;background:#6366f1}
.gv-owner{display:inline-block;background:#eef2ff;border:1px solid #c7d2fe;color:#4338ca;border-radius:999px;
  font-size:11.5px;padding:2px 10px;margin:2px 4px 0 0}
.gv-close{position:sticky;top:0;float:right;border:none;background:#f1f5f9;width:32px;height:32px;border-radius:50%;
  cursor:pointer;font-size:15px;color:#475569;transition:background .2s,transform .2s}
.gv-close:hover{background:#e2e8f0;transform:rotate(90deg)}
/* ---- 提醒消息弹窗（截止不足一天） ---- */
.gv-rembtn{position:relative}
.gv-rem-badge{position:absolute;top:-7px;right:-7px;min-width:17px;height:17px;padding:0 4px;border-radius:999px;
  background:#ef4444;color:#fff;font-size:10.5px;font-weight:700;display:flex;align-items:center;justify-content:center;
  box-shadow:0 0 0 2px #fff;line-height:1}
.gv-rem-badge:empty{display:none}
.gv-rem-mask{position:fixed;inset:0;background:rgba(15,23,42,.4);z-index:62;opacity:0;pointer-events:none;transition:opacity .18s;-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px)}
.gv-rem-mask.on{opacity:1;pointer-events:auto}
.gv-rem-panel{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%) scale(.96);width:min(460px,calc(100vw - 32px));
  max-height:82vh;display:flex;flex-direction:column;background:#fff;z-index:63;border-radius:18px;padding:16px 18px;
  opacity:0;pointer-events:none;transition:opacity .22s,transform .22s cubic-bezier(.2,.8,.25,1);
  box-shadow:0 24px 64px -16px rgba(15,23,42,.35)}
.gv-rem-panel.on{opacity:1;transform:translate(-50%,-50%) scale(1);pointer-events:auto}
.gv-rem-head{display:flex;align-items:center;gap:8px;margin-bottom:4px}
.gv-rem-head .icon{width:34px;height:34px;border-radius:10px;background:#fef2f2;color:#dc2626;display:flex;align-items:center;justify-content:center;font-size:18px}
.gv-rem-head h3{margin:0;font-size:16px;font-weight:700;color:#0f172a}
.gv-rem-sub{font-size:12px;color:#94a3b8;margin:0 0 10px}
.gv-rem-clear{margin-left:auto;border:none;background:transparent;color:#94a3b8;font-size:12px;cursor:pointer;padding:4px 6px;border-radius:6px}
.gv-rem-clear:hover{background:#f1f5f9;color:#475569}
.gv-rem-list{overflow-y:auto;flex:1 1 auto;min-height:60px;max-height:56vh;padding-right:4px}
.gv-rem-empty{padding:26px 12px;text-align:center;color:#94a3b8;font-size:13.5px;line-height:1.7}
.gv-rem-item{display:flex;align-items:flex-start;gap:10px;padding:11px 10px;border-bottom:1px solid #f1f5f9;cursor:pointer;
  border-radius:10px;transition:background .15s}
.gv-rem-item:hover{background:#f8fafc}
.gv-rem-item input{width:16px;height:16px;margin-top:2px;accent-color:#22c55e;flex:0 0 auto;cursor:pointer}
.gv-rem-item .nm{font-size:13.5px;color:#1e293b;line-height:1.4}
.gv-rem-item .mt{font-size:12px;color:#b45309;margin-top:3px;display:flex;gap:6px;align-items:center}
.gv-rem-item .mt .chip{font-size:10.5px;font-weight:600;background:#fef3c7;color:#92400e;border-radius:999px;padding:1px 7px}
.gv-rem-item .mt .sec{color:#94a3b8;font-weight:400}
.gv-rem-item input:checked ~ .nm{text-decoration:line-through;color:#94a3b8}
.gv-rem-item.done .nm{text-decoration:line-through;color:#94a3b8}
.gv-rem-item.done .mt{opacity:.55}
/* 勾选已完成的移到折叠区 */
.gv-rem-done{margin-top:8px;border-top:1px dashed #e2e8f0;padding-top:6px}
.gv-rem-done .gv-rem-item{background:#fafbfc}
.gv-rem-done .gv-rem-item .nm{text-decoration:line-through;color:#94a3b8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:280px}
.gv-rem-done .gv-rem-item .mt{opacity:.55}
.gv-rem-done .gv-rem-item .chip{background:#f1f5f9;color:#94a3b8}
.gv-rem-foot{padding:10px 4px 0;font-size:11.5px;color:#94a3b8;text-align:center;border-top:1px solid #f1f5f9;margin-top:8px}
.gv-rem-item .mt .when{color:#92400e;font-weight:600;font-variant-numeric:tabular-nums}
/* 系统级提醒通道按钮组 */
.gv-rem-sys{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px;padding-top:10px;border-top:1px solid #f1f5f9}
.gv-rem-btn{appearance:none;border:1px solid #e2e8f0;background:#fff;color:#334155;border-radius:9px;
  padding:7px 11px;font-size:12px;font-weight:600;cursor:pointer;line-height:1.2;
  transition:background .2s,border-color .2s,color .2s,transform .2s}
.gv-rem-btn:hover{background:#f8fafc;border-color:#c7d2fe;color:#4338ca;transform:translateY(-1px)}
.gv-rem-btn:active{transform:translateY(0)}
.gv-rem-note{margin-top:7px;font-size:11px;color:#94a3b8;line-height:1.65;word-break:break-all}
/* 轻量提示条（Ctrl+S 保存反馈 / 系统通道反馈） */
.gv-toast{position:fixed;left:50%;bottom:30px;transform:translate(-50%,10px);max-width:min(560px,84vw);
  background:rgba(15,23,42,.93);color:#fff;font-size:12.5px;line-height:1.5;padding:10px 18px;border-radius:12px;
  z-index:70;opacity:0;pointer-events:none;transition:opacity .2s,transform .2s;text-align:center;
  box-shadow:0 12px 32px -10px rgba(15,23,42,.5)}
.gv-toast.on{opacity:1;transform:translate(-50%,0)}
.gv-rem-close{position:absolute;top:12px;right:12px;border:none;background:#f1f5f9;width:30px;height:30px;border-radius:50%;cursor:pointer;font-size:14px;color:#475569}
.gv-rem-close:hover{background:#e2e8f0}
/* ---- 管理员 CRUD 表单 ---- */
.gv-adminbar{display:flex;gap:8px;margin:10px 0 2px;flex-wrap:wrap}
.gv-adminbar .gv-tbtn{font-size:12.5px;padding:6px 14px}
.gv-form{display:flex;flex-direction:column;gap:10px;margin-top:6px}
.gv-form .f-row{display:flex;gap:10px;flex-wrap:wrap}
.gv-form .f-col{flex:1 1 200px;min-width:0;display:flex;flex-direction:column;gap:4px}
.gv-form label{font-size:11.5px;color:#64748b;font-weight:600;display:flex;flex-direction:column;gap:4px}
.gv-form input[type=text],.gv-form input[type=date],.gv-form input[type=time],.gv-form select,.gv-form textarea{
  appearance:none;border:1px solid #e2e8f0;background:#fff;border-radius:9px;padding:8px 11px;font-size:13.5px;
  color:#1e293b;font-family:inherit;transition:border-color .2s,box-shadow .2s;width:100%}
.gv-form input:focus,.gv-form select:focus,.gv-form textarea:focus{outline:none;border-color:#818cf8;box-shadow:0 0 0 3px rgba(99,102,241,.15)}
.gv-form textarea{min-height:88px;resize:vertical;line-height:1.6}
.gv-form .f-check{flex-direction:row;align-items:center;gap:8px;font-size:13px;color:#334155;font-weight:600}
.gv-form .f-check input{width:16px;height:16px;accent-color:#4f46e5}
.gv-form .f-hint{font-size:11px;color:#94a3b8;font-weight:400}
.gv-form .f-time{flex-direction:row;align-items:center;gap:6px;font-size:11px;color:#94a3b8;font-weight:500}
.gv-form .f-time input[type=time]{flex:0 0 118px;padding:6px 8px;font-size:13px}
/* v27：日期/时刻的显式「清除」出口。
   原生 date/time 输入在 iOS 上是滚轮选择器，一旦选定没有任何方式置空（桌面端也只有悬停时
   才出现一个不显眼的 ×），导致「先填了时刻、后想改回不填」这条路径走不通。 */
.gv-form .f-dtrow{display:flex;gap:6px;align-items:center}
.gv-form .f-dtrow input{flex:1 1 auto;min-width:0}
.gv-form .f-clear{appearance:none;flex:0 0 auto;border:1px solid #e2e8f0;background:#f8fafc;color:#64748b;
  border-radius:8px;padding:6px 9px;font-size:11.5px;font-weight:600;cursor:pointer;line-height:1;font-family:inherit;
  transition:background .2s,border-color .2s,color .2s}
.gv-form .f-clear:hover{background:#eef2ff;border-color:#c7d2fe;color:#4338ca}
.gv-form .f-clear:disabled{opacity:.4;cursor:not-allowed}
.gv-form .f-off{opacity:.45}
.gv-form .f-owners{display:flex;flex-wrap:wrap;gap:6px;margin-top:2px}
.gv-form .f-owner{flex-direction:row;align-items:center;gap:5px;font-size:12.5px;font-weight:500;color:#334155;
  background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:5px 9px;cursor:pointer}
.gv-form .f-owner input{width:15px;height:15px;accent-color:#4f46e5;margin:0}
.gv-form .f-owner:has(input:checked){background:#eef2ff;border-color:#c7d2fe;color:#4338ca}
.gv-form .f-radio{display:flex;gap:14px;margin-top:2px}
.gv-form .f-radio label{flex-direction:row;align-items:center;gap:5px;font-size:13px;font-weight:500;color:#334155;cursor:pointer}
.gv-form .f-radio input{width:15px;height:15px;accent-color:#4f46e5;margin:0}
.gv-evfields{border:1px solid #eef2ff;background:#fafbff;border-radius:12px;padding:12px}
.gv-evfields .ev-title{font-size:12px;font-weight:700;color:#4338ca;margin-bottom:10px}
.gv-form .f-actions{display:flex;gap:8px;margin-top:4px}
.gv-form .f-actions .gv-tbtn{font-size:13.5px;padding:9px 18px}
.gv-busy{opacity:.6;pointer-events:none}
.gv-form .f-err{background:#fef2f2;border:1px solid #fecaca;color:#991b1b;border-radius:9px;padding:9px 12px;font-size:12.5px;line-height:1.6;white-space:pre-wrap}
.gv-confirm{background:#fffbeb;border:1px solid #fde68a;color:#92400e;border-radius:12px;padding:14px 16px;font-size:13px;line-height:1.7;margin-top:10px}
.gv-confirm b{color:#7c2d12}
/* v17：提交材料参考示例（图片） */
.gv-sample{margin-top:4px}
.gv-sample .gv-sample-thumb{display:block;max-width:280px;max-height:200px;border-radius:12px;border:1px solid #e2e8f0;margin:6px 0 4px;cursor:zoom-in;box-shadow:0 4px 12px -6px rgba(15,23,42,.18)}
.gv-sample a{font-size:12.5px;font-weight:600;color:#4f46e5;text-decoration:none}
.gv-sample a:hover{text-decoration:underline}
/* 图片灯箱：与弹窗同级全屏遮罩预览大图 */
.gv-lightbox{position:fixed;inset:0;background:rgba(15,23,42,.78);z-index:10001;display:flex;align-items:center;justify-content:center;cursor:zoom-out;-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px)}
.gv-lightbox img{max-width:92vw;max-height:88vh;border-radius:10px;box-shadow:0 24px 80px -12px rgba(0,0,0,.6)}
.gv-form .f-sample{display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap}
.gv-form .f-sample img{max-width:160px;max-height:120px;border-radius:10px;border:1px solid #e2e8f0;margin:4px 0}
.gv-form .f-sample .f-sample-actions{display:flex;flex-direction:column;gap:6px;align-items:flex-start}
.gv-form .f-sample input[type=file]{font-size:12px;width:100%;max-width:220px}
.gv-form .f-sample .f-sample-rm{background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;border-radius:8px;padding:5px 10px;font-size:12px;cursor:pointer}
/* v19：执行步骤配图 + 多文件附件 */
.gv-stepimg{display:block;max-width:280px;max-height:200px;border-radius:12px;border:1px solid #e2e8f0;margin:8px 0 2px;cursor:zoom-in;box-shadow:0 4px 12px -6px rgba(15,23,42,.18)}
.gv-att{display:flex;flex-wrap:wrap;gap:8px;margin-top:4px}
.gv-att a{display:inline-flex;align-items:center;gap:5px;background:#eef2ff;border:1px solid #c7d2fe;color:#4338ca;
  border-radius:8px;padding:5px 11px;font-size:12.5px;font-weight:600;text-decoration:none;transition:background .15s}
.gv-att a:hover{background:#e0e7ff;text-decoration:none}
.gv-att .gv-att-ico{font-size:14px}
.gv-form .f-attlist{display:flex;flex-direction:column;gap:6px;margin-top:4px}
.gv-form .f-att-row{display:flex;align-items:center;gap:8px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:9px;padding:5px 10px}
.gv-form .f-att-row .nm{flex:1;font-size:12.5px;color:#334155;word-break:break-all}
.gv-form .f-att-row .rm{background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;border-radius:7px;
  padding:3px 9px;font-size:11.5px;cursor:pointer}
.gv-form .f-stepimg img{max-width:160px;max-height:120px;border-radius:10px;border:1px solid #e2e8f0;margin:4px 0}
/* v20：备注配图（详情 + 表单） */
.gv-tipsimg{display:block;max-width:280px;max-height:200px;border-radius:12px;border:1px solid #e2e8f0;margin:8px 0 2px;cursor:zoom-in;box-shadow:0 4px 12px -6px rgba(15,23,42,.18)}
.gv-form .f-tipsimg img{max-width:160px;max-height:120px;border-radius:10px;border:1px solid #e2e8f0;margin:4px 0}
.coming{opacity:.6;font-style:italic}
/* ---- 手机横屏（landscape）：整页由 index.html 向右旋转 90°（header/甘特图/footer 整体旋转）。
       此处只做布局微调：左列高度收紧；.gv-scroll 保留原生横向滚动（时间轴），但不再拦截触摸事件，
       与页面共享手势——纵向拖拽自然冒泡到 body 翻页，横向拖拽滚时间轴（浏览器自动分工） ---- */
.gv-land .gv-toolbar{position:static}
.gv-land .gv-body{position:relative;overflow:hidden}
.gv-land .gv-labels{max-height:calc(100vh - 6px)}
.gv-land .gv-labels.collapsed{width:34px}
.gv-land .gv-scroll{overflow-x:auto;overflow-y:hidden;overscroll-behavior-x:contain;-webkit-overflow-scrolling:touch;touch-action:auto}
@media (max-width:560px){
  .gv-labels{width:150px}.gv-lhead{font-size:11px;padding:5px 6px}
  .gv-lname{padding:4px 6px;font-size:11px}
  .gv-lname .nm b{font-size:11px}
  .gv-toolbar{padding:8px 9px;gap:6px}
  .gv-tbtn{padding:5px 9px;font-size:12px}
}
`;

  /* ---------- 基础工具 ---------- */
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function dateOnly(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function addDays(d, n) { var x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function addMonths(d, n) { return new Date(d.getFullYear(), d.getMonth() + n, 1); }
  function diffDays(a, b) { return Math.round((b - a) / DAY); }
  function fmtMD(d) { return (d.getMonth() + 1) + '.' + d.getDate(); }
  function fmtYMD(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  /* 带可选时分的日期输出：time 为 'HH:mm'（空则仅日期） */
  function fmtDT(d, time) { return time ? fmtYMD(d) + ' ' + time : fmtYMD(d); }
  function hmOf(time) { return /^(\d{1,2}):(\d{1,2})$/.test(String(time)) ? pad(+time.split(':')[0]) + ':' + pad(+time.split(':')[1]) : ''; }
  function fmtCN(d) { return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日'; }
  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function truncateText(txt, maxLen) {
    txt = String(txt);
    if (txt.length <= maxLen) return txt;
    return txt.slice(0, Math.max(3, maxLen - 1)) + '…';
  }
  /* 状态色 */
  function statusOf(task, today) {
    if (!task.start || !task.end) return 'future';
    var end = dateOnly(task.end);
    if (end < today) return 'finish';
    var start = dateOnly(task.start);
    if (start <= today && today <= end) return 'going';
    return 'future';
  }
  /* 单个时刻的紧凑写法：「9.10」/「9.10 14:00」（时刻归一为 2 位分钟） */
  function fmtPt(d, time) {
    if (!d) return '';
    var hm = hmOf(time);
    return fmtMD(d) + (hm ? ' ' + hm : '');
  }
  /* 范围内紧凑写法（标题用）：
     同日同刻 →「9.10 18:45」；纯日期 →「8.25至9.9」；
     含时刻 →「9.10 14:00 至 9.10 17:00」（两侧留空格，避免数字与「至」粘连）
     时刻来自 gantt.md 里「日期 时:分」的 OO 段，精确到分钟。 */
  function rangeCN(t) {
    if (!t.start) return '';
    var s = fmtPt(t.start, t.startTime);
    var e = t.end ? fmtPt(t.end, t.endTime) : '';
    if (!e || s === e) return s;
    var hasTime = !!(hmOf(t.startTime) || hmOf(t.endTime));
    return s + (hasTime ? ' 至 ' : '至') + e;
  }
  /* ================= 时刻口径（分钟级，纯函数） =================
     为什么放在模块级：这套口径被三条链路共用 —— ①图内标题/左侧列表 ②ddl 提醒面板
     ③通道 C 的「系统闹钟」文案（时间 = 开始前 15 分钟，标签 = 名称 + 起止）。
     放在模块级才能被 test/unit.js 直接调到，用来与构建端 tools/build-deadlines.js
     的 startHmOf/dueHmOf/alarmAt/alarmLabel 做跨端口径断言（两边必须同构）。
     mount() 内部的 remHM/remStartHM/remDueHM/remWhenText/remAlarm* 都只是这里的薄封装。 */

  /* 通道 C 的提前量（分钟）：闹钟锚在「开始时刻 − 这个值」；
     与构建端常量 ALARM_LEAD_MIN 必须一致（两侧都可由环境变量覆盖，网页端固定为 15） */
  var ALARM_LEAD_MIN = 15;

  /* 通道 C 闹钟标签 = 「名称｜地点｜开始→结束时间」，空段自动省略。
     分隔符为什么不用顿号/逗号：任务名里本身就可能含「，」（例：「去天佑会堂经管牌子集合看直播，13.15到」），
     用全角竖线分段才不会被误读成名称的一部分。
     与构建端 tools/build-deadlines.js 的 ALARM_LABEL_SEP / alarmLabelOf 必须同构（test/unit.js [11] 断言）。 */
  var ALARM_LABEL_SEP = '｜';
  function alarmLabelOf(name, where, when) {
    return [name, where, when].filter(Boolean).join(ALARM_LABEL_SEP);
  }

  /* 时刻解析：'9:5' → {h:9,mi:5,exact:true}；未填/非法 → 兜底值并标 exact:false */
  function hmParts(raw, fh, fmi) {
    var m = /^(\d{1,2}):(\d{1,2})$/.exec(String(raw == null ? '' : raw).trim());
    if (!m) return { h: fh, mi: fmi, exact: false };
    var h = +m[1], mi = +m[2];
    if (h > 23 || mi > 59) return { h: fh, mi: fmi, exact: false };
    return { h: h, mi: mi, exact: true };
  }
  /* 开始时刻：取自编辑表单「开始日期 / 时刻」组件，未填时刻按 00:00 */
  function startHMOf(task) { return hmParts(task.startTime, 0, 0); }
  /* 截止时刻（唯一权威口径）：结束日期 + 结束时刻；未填结束时刻时，若起止同日且填了
     开始时刻则用开始时刻；否则回落当日 23:59 —— 这就是「未填时刻」的默认语义 */
  function dueHMOf(task) {
    var e = hmParts(task.endTime, 23, 59);
    if (e.exact) return e;
    var s = hmParts(task.startTime, 0, 0);
    if (s.exact && task.start && task.end && fmtYMD(task.start) === fmtYMD(task.end)) return s;
    return e;
  }
  /* 起止文案（分钟级）：「9.10 14:00 → 9.10 17:00」；未填时刻的推定值以「~」标出 */
  function whenTextOf(task) {
    var sd = task.start || task.end, ed = task.end || task.start;
    if (!sd || !ed) return '';
    var s = startHMOf(task), e = dueHMOf(task);
    return fmtMD(sd) + ' ' + (s.exact ? '' : '~') + pad(s.h) + ':' + pad(s.mi) +
      ' → ' + fmtMD(ed) + ' ' + (e.exact ? '' : '~') + pad(e.h) + ':' + pad(e.mi);
  }
  /* 通道 C：闹钟绝对时刻 = 开始时刻 − ALARM_LEAD_MIN 分钟
     （分钟传负数时 Date 自动向前跨日/跨月，无需手工借位） */
  function alarmAtOf(task) {
    var sd = task.start || task.end;
    if (!sd) return null;
    var s = startHMOf(task);
    return new Date(sd.getFullYear(), sd.getMonth(), sd.getDate(), s.h, s.mi - ALARM_LEAD_MIN);
  }
  /* 通道 C：闹钟时刻「HH:mm」 */
  function alarmHMOf(task) {
    var d = alarmAtOf(task);
    return d ? pad(d.getHours()) + ':' + pad(d.getMinutes()) : '';
  }
  /* 通道 C：闹钟标签里的起止部分 —— 起止同刻（时间点/里程碑）只显示一次，
     与标题 rangeCN 的口径一致（构建端 alarmLabel 同此逻辑） */
  function alarmWhenOf(task) {
    var sd = task.start || task.end, ed = task.end || task.start;
    if (!sd || !ed) return '';
    var s = startHMOf(task), e = dueHMOf(task);
    var same = (s.h === e.h && s.mi === e.mi && fmtYMD(sd) === fmtYMD(ed));
    return same
      ? fmtMD(sd) + ' ' + (s.exact ? '' : '~') + pad(s.h) + ':' + pad(s.mi)
      : whenTextOf(task);
  }

  /* 事件错色色板：[0]=实色(已到/进行,白字) [1]=浅色(未开始,深字) [2]=墨色(描边/浅底文字)；
     已完成任务统一灰色。序号步长 5 循环 → 相邻事件颜色差异大，便于区分 */
  var PAL = [
    ['#4f46e5', '#c7d2fe', '#3730a3'],
    ['#7c3aed', '#ddd6fe', '#6d28d9'],
    ['#0e7490', '#a5f3fc', '#155e75'],
    ['#047857', '#a7f3d0', '#065f46'],
    ['#0369a1', '#bae6fd', '#075985'],
    ['#1d4ed8', '#bfdbfe', '#1e40af'],
    ['#4338ca', '#c7d2fe', '#3730a3'],
    ['#0f766e', '#99f6e4', '#115e59'],
    ['#15803d', '#bbf7d0', '#166534'],
    ['#4d7c0f', '#d9f99d', '#3f6212'],
    ['#6b21a8', '#e9d5ff', '#581c87'],
    ['#0c4a6e', '#bae6fd', '#075985']
  ];
  /* 名称是否已自带括号日期注记（半/全角括号均可，括号内含 "9.5"/"8.1至8.25" 类点号日期） */
  function hasOwnDateNote(n) {
    var i = String(n).search(/[(\uFF08]/);
    if (i < 0) return false;
    return /\d{1,2}\s*[.\uFF0E]\s*\d{1,2}/.test(String(n).slice(i));
  }
  /* 图表完整标题：原名已带日期注记 → 原样；否则自动补「（s至e）」，保证每条呈现 名称(日期) 形态 */
  function captionOf(t) {
    var n = t.name || '';
    if (hasOwnDateNote(n)) return n;
    var r = rangeCN(t);
    return r ? n + '（' + r + '）' : n;
  }
  /* 估算文本像素宽（CJK≈字号，ASCII≈0.55 字号） */
  function estW(txt, fs) {
    var w = 0;
    for (var i = 0; i < txt.length; i++) {
      w += (txt.charCodeAt(i) >= 0x2E80) ? fs : fs * 0.55;
    }
    return w;
  }
  /* events.js 顶层的班务 key 提取。不 eval 远端代码，只按 serializeEvents 的固定缩进（4 空格）扫。
     为什么要这个：保存是「整份写回」，本页的 events 若来自浏览器缓存的旧 js/events.js（或陈旧 pending），
     写回就会把远端新增的条目静默删掉 —— 2026-09-10 实际发生过一次（b7 的详情被覆盖丢失）。 */
  function evKeysOf(src) {
    var out = [], re = /^ {4}([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*\{/gm, m;
    while ((m = re.exec(String(src || ''))) !== null) { if (m[1] !== '_roles') out.push(m[1]); }
    return out;
  }
  /* 「远端有、本地没有」的 key —— 即本次整份写回会删除掉的条目 */
  function evDriftKeys(remoteSrc, localEvents) {
    if (!localEvents) return [];
    var local = Object.keys(localEvents).filter(function (k) { return k !== '_roles'; });
    return evKeysOf(remoteSrc).filter(function (k) { return local.indexOf(k) < 0; });
  }
  /* 条/节点内标注重排：优先保留括号日期注记，只截断头部名称（防文字重叠遮盖）。
     注：超长注记（如「新生体检(9.5至9.7工作时间,交体检表至9.7)」）整体优先采用，
     实在放不下再降级为纯日期「(9.5至9.7)」，仍放不下才返回空（由调用方外置） */
  function shortCaption(t, limit, fs) {
    var n = t.name || '';
    var i = String(n).search(/[(\uFF08]/);
    var head = (i < 0 ? n : n.slice(0, i)).trim();
    var tail = '';
    if (i >= 0 && hasOwnDateNote(n)) tail = n.slice(i);
    else {
      var r = rangeCN(t);
      if (r) tail = '（' + r + '）';
    }
    if (!head && !tail) return '';
    var wTail = estW(tail, fs);
    if (wTail > limit - 2) {
      /* 降级：注记过长 → 只保留日期「(9.5至9.7)」或当日「9.5」 */
      var r2 = rangeCN(t);
      var tail2 = '';
      if (t.point || t.milestone) tail2 = r2 ? r2 : '';
      else tail2 = r2 ? '（' + r2 + '）' : '';
      var wTail2 = tail2 ? estW(tail2, fs) : 0;
      if (wTail2 <= limit - 2) { tail = tail2; wTail = wTail2; }
      else return '';   /* 纯日期也放不下 → 交调用方外置/放弃 */
    }
    var out = '', w = 0, maxH = limit - 2 - wTail;
    for (var k = 0; k < head.length; k++) {
      var cw = (head.charCodeAt(k) >= 0x2E80) ? fs : fs * 0.55;
      if (w + cw > maxH) { if (out) out += '…'; break; }
      w += cw; out += head[k];
    }
    return (out + tail).trim();
  }
  /* 左列副行：完整 Y-M-D([HH:mm]) 便于核对年份/时刻 */
  function ymdRange(t) {
    if (!t.start) return '';
    if (t.point || t.milestone) return fmtDT(t.start, t.startTime);
    return fmtDT(t.start, t.startTime) + ' → ' + fmtDT(t.end, t.endTime);
  }

  /* ---------- 主挂载 ---------- */
  function mount(container, ganttCode, eventsData) {
    if (!container) return null;
    eventsData = eventsData || {};

    /* 管理员 CRUD（GitHub API 线上直写）：GanttAdmin 由 index.html 先引入 */
    var Admin = (G.GanttAdmin && G.GanttAdmin.isLoggedIn) ? G.GanttAdmin : null;
    var isAdmin = !!(Admin && Admin.isLoggedIn());

    /* 整页向右旋转 90° 回调（index.html 挂载，applyMode/reportLand 共用同一变量） */
    var onLand = null;

    var model = Parser.parse ? Parser.parse(ganttCode) : null;
    if (!model || !model.range) {
      container.innerHTML = '';
      var errEl = el('div', 'gv-err');
      errEl.textContent = '⚠ 未能解析出有效甘特图数据。\n请检查代码是否以 "gantt" 开头、任务是否含有效日期 YYYY-MM-DD。\n\n' +
        ((model && model.warnings) ? model.warnings.join('\n') : '');
      container.appendChild(errEl);
      return null;
    }

    var styleEl = el('style'); styleEl.textContent = CSS;
    var root = el('div', 'gv-root');
    container.appendChild(styleEl);
    container.appendChild(root);

    /* ---- 今日（本地日期：今日线随打开当天自动更新） ---- */
    var today = dateOnly(new Date());

    var minDate = dateOnly(model.range.start);
    var maxDate = dateOnly(model.range.end);
    var totalDays = diffDays(minDate, maxDate) + 1;
    var hasTodayInRange = (today >= minDate && today <= maxDate);

    /* 全部任务 */
    var tasksAll = model.all;

    /* 课程表条目（section 名含「课程表」）只上图，不进待办提醒链路 ——
       周期性上课不是「截止待办」：进入提醒面板会显示「<课程名> 截止」，
       导出的 .ics 会变成「结束前 30 分钟」的假截止，通道 C 的今日闹钟清单也会被上课提醒淹没。
       口径与构建端 tools/build-deadlines.js 的 isCourseTask() 一致（两处必须同时改）。 */
    function isCourseTask(t) {
      var sec = (t && secOfTask) ? secOfTask[t.id] : null;
      return !!sec && /课程表/.test(sec.name || '');
    }

    /* 课程日事件（id 形如 k1w09）→ 基础课程详情（k1）归一并注入「第N教学周 · 具体日期」。
       这样按周逐日拆开的 114 条不用在 events.js 里写 114 份复制，点任一课日条都弹同一门课的详情，
       且「时间要求」动态呈现该具体日期的起止。 */
    function courseDetailOf(t) {
      var m = /^k(\d+)w(\d+)$/.exec(t && t.id || '');
      if (!m) return null;
      var base = eventsData['k' + m[1]] || null;
      if (!base) return null;
      var week = parseInt(m[2], 10);
      var dd = fmtYMD(t.start);
      var hm = (t.startTime ? t.startTime : '') + ' - ' + (t.endTime ? t.endTime : '');
      var o = {};
      Object.keys(base).forEach(function (k) { o[k] = base[k]; });
      o.when = '第 ' + week + ' 教学周 · ' + dd + ' ' + hm + (base.when ? '　依课表：' + base.when : '');
      return o;
    }

    /* ---- 骨架 ---- */
    root.innerHTML =
      '<div class="gv-toolbar">' +
      '  <button class="gv-tbtn" data-act="zoomout" title="缩小">－ 缩小</button>' +
      '  <button class="gv-tbtn" data-act="zoomin" title="放大">＋ 放大</button>' +
      '  <span style="width:2px;height:16px;background:var(--gv-line);display:inline-block"></span>' +
      '  <button class="gv-tbtn" data-act="prevYear" title="上一学年">‹‹ 上年</button>' +
      '  <button class="gv-tbtn" data-act="prevMonth" title="上一月">‹ 上月</button>' +
      '  <span class="gv-range"><b id="gv-cen">—</b></span>' +
      '  <button class="gv-tbtn" data-act="nextMonth" title="下一月">下月 ›</button>' +
      '  <button class="gv-tbtn" data-act="nextYear" title="下一学年">下年 ››</button>' +
      '  <span style="width:2px;height:16px;background:var(--gv-line);display:inline-block"></span>' +
      '  <button class="gv-tbtn primary" data-act="today" title="回到今天">📍 回到今天</button>' +
      (isAdmin ? '  <button class="gv-tbtn gv-addbtn" data-act="add" title="新增事件/时间点" style="background:#f0fdf4;border-color:#bbf7d0;color:#15803d">＋ 新增</button>' +
      '  <button class="gv-tbtn gv-savebtn" data-act="save" title="保存更改">💾 保存更改</button>' : '') +
      '  <button class="gv-tbtn gv-rembtn" data-act="remind" title="查看ddl(截止不足一天)提醒" style="margin-left:auto">🔔 提醒<span class="gv-rem-badge" id="gv-rembadge"></span></button>' +
      '  <button class="gv-tbtn gv-fsbtn" data-act="fullscreen" title="浏览器内全屏显示甘特图">⛶ 全屏</button>' +
      '</div>' +
      '<div class="gv-legend" id="gv-legend"></div>' +
      '<div class="gv-body" id="gv-body">' +
      '  <div class="gv-labels" id="gv-labels">' +
      '    <div class="gv-lhead">' +
      '      <button class="gv-chev" id="gv-ltoggle" title="展开事件列表">☰</button>' +
      '      <span class="gv-lttl">事件列表</span><span class="cnt" id="gv-lcnt"></span>' +
      '      <span style="flex:1"></span>' +
      '    </div>' +
      '    <div class="gv-lbox" id="gv-lbox"></div>' +
      '  </div>' +
      '  <div class="gv-scroll" id="gv-scroll"><svg id="gv-svg"></svg></div>' +
      '</div>';

    var toolbar = root.querySelector('.gv-toolbar');
    var rangeEl = root.querySelector('#gv-cen');
    var bodyEl = root.querySelector('#gv-body');
    var labelsEl = root.querySelector('#gv-labels');
    var lboxEl = root.querySelector('#gv-lbox');
    var ltoggleEl = root.querySelector('#gv-ltoggle');
    var lcntEl = root.querySelector('#gv-lcnt');
    var scrollEl = root.querySelector('#gv-scroll');
    var svgEl = root.querySelector('#gv-svg');
    var legendEl = root.querySelector('#gv-legend');

    /* 轻量提示条：3.4s 自动消失（Ctrl+S 保存反馈、系统提醒通道反馈等共用） */
    var toastEl = null, toastTimer = null;
    function toast(msg) {
      if (!toastEl) { toastEl = el('div', 'gv-toast'); root.appendChild(toastEl); }
      toastEl.textContent = msg;
      toastEl.classList.add('on');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(function () { toastEl.classList.remove('on'); }, 3400);
    }

    /* 解析告警 */
    if (model.warnings && model.warnings.length) {
      var warnEl = el('div', 'gv-warn', '⚠ 解析提示（不阻塞渲染，可忽略或修正语法）：\n' + esc(model.warnings.slice(0, 6).join('\n')));
      root.insertBefore(warnEl, toolbar.nextSibling || null);
    }

    /* ---- 图例 ---- */
    legendEl.innerHTML =
      '<span><i class="today"></i>今日 2 条红线：现在(实线) / 24:00(虚线)</span>' +
      '<span><i style="background:linear-gradient(90deg,#ef4444,#dc2626);border-radius:2px"></i>近3天开始·未结束(红色高亮)</span>' +
      '<span><i style="background:#cbd5e1"></i>已完成</span>' +
      '<span><i style="background:#4f46e5"></i><i style="background:#7c3aed"></i><i style="background:#047857"></i><i style="background:#0e7490"></i>不同事件/节点错色区分</span>' +
      '<span><i class="dia" style="background:#7c3aed"></i>时间点/当日点</span>' +
      '<span><i style="border:1.5px dashed #6d28d9;background:transparent;height:4px;width:16px;border-radius:2px"></i>关键节点(紫圈)</span>' +
      '<span class="hint">🖱 点条/◆/标题文字/左侧名 → 详情 · 桌面 Ctrl+滚轮缩放</span>';

    /* ---- 左侧事件索引（每任务一项；点击=详情+定位高亮） ---- */
    var secOfTask = {};
    model.sections.forEach(function (sec) {
      sec.tasks.forEach(function (t) { secOfTask[t.id] = sec; });
    });
    /* ID 序号（从 1 自增，按 gantt.md 顺序，管理员不可修改，仅展示） */
    var seqById = {};
    model.all.forEach(function (t, i) { seqById[t.id] = i + 1; });
    var labelRowByTask = {};
    function buildLabelList() {
      lboxEl.innerHTML = '';
      labelRowByTask = {};
      model.sections.forEach(function (sec) {
        var secHead = el('div', 'gv-lsec', esc(sec.name) + '（' + sec.tasks.length + '）');
        lboxEl.appendChild(secHead);
        sec.tasks.forEach(function (t) {
          var dot = '';
          if (t.milestone || t.point) dot = '<span class="dot">◆</span>';
          else dot = '<span class="dot">▪</span>';
          var cell = el('div', 'gv-lname',
            dot +
            '<span class="nm"><b>' + esc(t.name) + '</b>' +
            '<span class="dt">' + esc(ymdRange(t)) + '</span></span>');
          cell.addEventListener('click', function () { openDetail(t, true); });
          lboxEl.appendChild(cell);
          labelRowByTask[t.id] = cell;
        });
      });
      lcntEl.textContent = tasksAll.length;
    }
    buildLabelList();

    /* 左列折叠（默认折叠） */
    function setLabelsCollapsed(collapsed) {
      labelsEl.classList.toggle('collapsed', collapsed);
      ltoggleEl.textContent = collapsed ? '☰' : '◀';
      ltoggleEl.title = collapsed ? '展开事件列表' : '折叠事件列表';
    }
    ltoggleEl.addEventListener('click', function () {
      setLabelsCollapsed(!labelsEl.classList.contains('collapsed'));
    });
    setLabelsCollapsed(true);

    /* ---- 视图状态 ---- */
    var LEFT_PAD = 12, RIGHT_PAD = 30;
    var AXIS_H = 26;
    var isMobile = window.innerWidth <= 700;
    var autoLand = window.innerWidth > window.innerHeight && window.innerWidth <= 1024 && window.innerHeight <= 760;
    /* 手动视图覆盖：null=自动（桌面常规/手机横屏自动旋转）；'land'=强制向右旋转90°；'normal'=强制常规 */
    var viewOverride = null;
    function effLand() { return viewOverride === 'land' ? true : (viewOverride === 'normal' ? false : autoLand); }
    var isLand = effLand();
    var viewDays = isLand ? 53 : (isMobile ? 47 : 65); // 视口覆盖天数（默认档 = 点击一次放大的时间范围，原 110/80/90 → ÷1.7）
    var MIN_VIEW = 10, MAX_VIEW = Math.max(totalDays * 1.02, 400);

    function pw() { return Math.max(scrollEl.clientWidth, 200); }
    function pxPerDay() { return pw() / viewDays; }

    /* 每帧轨道分配：按像素区间贪心，重叠者落到下一轨道（多任务可同一行） */
    function computeTracks() {
      var px = pxPerDay();
      var sorted = tasksAll.slice().sort(function (a, b) { return a.start - b.start || a.end - b.end; });
      var ends = [];
      var trackOf = {};
      sorted.forEach(function (t) {
        var x1 = LEFT_PAD + diffDays(minDate, t.start) * px;
        var x2 = LEFT_PAD + diffDays(minDate, t.end) * px + px;
        var placed = -1;
        for (var k = 0; k < ends.length; k++) {
          if (ends[k] <= x1 - 2) { placed = k; break; }
        }
        if (placed < 0) { placed = ends.length; ends.push(0); }
        ends[placed] = Math.max(ends[placed], x2);
        trackOf[t.id] = placed;
      });
      return { trackOf: trackOf, trackCount: Math.max(ends.length, 1) };
    }

    function computeRowH(trackCount) {
      var cap;
      if (isLand) {
        /* 旋转后行方向变视觉横向：一屏尽量放下所有轨道 */
        cap = Math.max(window.innerHeight - 30, 150);
        return clamp(Math.floor((cap - AXIS_H) / trackCount), 12, 60);
      }
      if (isMobile) {
        /* 竖屏手机：行数少则行高放大，让图尽量占满屏高（9:16 沉浸式） */
        cap = Math.max(window.innerHeight * 0.6, 400);
        return clamp(Math.floor((cap - AXIS_H) / trackCount), 20, 68);
      }
      /* 桌面：总高趋于稳定，行数与行高成反比 */
      cap = Math.min(window.innerHeight * 0.62, 720);
      return clamp(Math.floor((cap - AXIS_H) / trackCount), 20, 46);
    }

    /* ---- 今日两条红线：① 当前时刻（分钟级） ② 今日 24:00 ----
       为什么是两条：只画一条「今日」竖线时，看不出当天还剩多少时间、也定位不到此刻在一天中的位置。
       ① 走分钟级小数天偏移，随打开/每分钟自动重绘；② 是当日右边界（24:00 == 次日 00:00），固定不动。 */
    function xOfDayFrac(d, frac, px) {
      return LEFT_PAD + (diffDays(minDate, dateOnly(d)) + frac) * px;
    }
    function redLineXs(px) {
      if (!hasTodayInRange) return [];
      var n = new Date();
      var fracNow = (n.getHours() * 60 + n.getMinutes()) / 1440;
      return [xOfDayFrac(n, fracNow, px), xOfDayFrac(n, 1, px)];
    }
    /* 两条红线的 SVG 片段（px/totalH 由调用方传入；单列成函数是为了让①线能被定时刷新，无需整图重绘）
       标注位置约定（避免与月份标签行互相错位）：
         · 「现在 HH:mm」文字置于线的【左侧】（左侧越界时自动翻到右侧）
         · 「今日 24:00」文字置于线的【右侧】（右侧越界时自动翻到左侧）
       两条标签共用同一条基线 y = AXIS_H-18（月份标签在 y = AXIS_H-7，错开一整行，互不撞字）。 */
    function nowLinesSVG(px, totalH, worldW) {
      if (!hasTodayInRange) return '';
      var xs = redLineXs(px);
      var n = new Date();
      var nowHM = pad(n.getHours()) + ':' + pad(n.getMinutes());
      var labY = (AXIS_H - 18).toFixed(1);
      var out = '';
      /* ① 当前时刻：实线 + 标签在左 */
      out += '<line x1="' + xs[0].toFixed(1) + '" y1="' + AXIS_H + '" x2="' + xs[0].toFixed(1) + '" y2="' + totalH + '" stroke="#ef4444" stroke-width="2.2" opacity=".95"/>';
      if (xs[0] >= LEFT_PAD && xs[0] <= worldW - RIGHT_PAD) {
        var labNow = '现在 ' + nowHM;
        var leftOk = (xs[0] - 6 - estW(labNow, 10.5)) >= 2;   /* 左侧放得下就放左边（默认） */
        out += '<text x="' + (leftOk ? xs[0] - 6 : xs[0] + 6).toFixed(1) + '" y="' + labY +
          '" text-anchor="' + (leftOk ? 'end' : 'start') + '" font-size="10.5" font-weight="700" fill="#ef4444">' + labNow + '</text>';
      }
      /* ② 今日 24:00：虚线 + 标签在右 */
      out += '<line x1="' + xs[1].toFixed(1) + '" y1="' + AXIS_H + '" x2="' + xs[1].toFixed(1) + '" y2="' + totalH + '" stroke="#ef4444" stroke-width="1.6" stroke-dasharray="5 4" opacity=".8"/>';
      if (xs[1] >= LEFT_PAD && xs[1] <= worldW - RIGHT_PAD) {
        var labEod = '今日 24:00';
        var rightOk = (xs[1] + 6 + estW(labEod, 10.5)) <= (worldW - RIGHT_PAD + 4);  /* 右侧放得下就放右边（默认） */
        out += '<text x="' + (rightOk ? xs[1] + 6 : xs[1] - 6).toFixed(1) + '" y="' + labY +
          '" text-anchor="' + (rightOk ? 'start' : 'end') + '" font-size="10.5" font-weight="700" fill="#ef4444">' + labEod + '</text>';
      }
      return out;
    }
    /* 「现在」线每分钟刷新一次（只在分钟数变化时改 DOM；页面隐藏时跳过，不白发算力） */
    var nowTimer = null;
    var lastNowMin = '';
    function tickNowLine() {
      if (document.hidden) return;
      var n = new Date();
      var key = n.getFullYear() + '-' + n.getMonth() + '-' + n.getDate() + ' ' + n.getHours() + ':' + n.getMinutes();
      if (key === lastNowMin) return;
      lastNowMin = key;
      /* ① 两条红线需要刷新（「现在」线每分钟移动，「今日 24:00」线跨天后整体右移一天） */
      var g = svgEl.querySelector('#gv-nowlines');
      if (g) {
        var px = pxPerDay();
        var wW = parseFloat(svgEl.getAttribute('width')) || 0;
        var tH = parseFloat(svgEl.getAttribute('height')) || 0;
        g.innerHTML = nowLinesSVG(px, tH, wW);
      }
      /* ② 提醒角标依赖「剩余时长」，跨分钟后可能变化 */
      try { remUpdateBadge(); } catch (e) {}
    }
    if (nowTimer) { clearInterval(nowTimer); nowTimer = null; }
    nowTimer = setInterval(tickNowLine, 20000);

    /* ---- 绘制 ---- */
    var flashId = null;
    var curMonthLabelXs = [];
    function redraw(centerDate) {
      var px = pxPerDay();
      var layout = computeTracks();
      var rowH = computeRowH(layout.trackCount);
      var worldW = Math.max(LEFT_PAD + totalDays * px + RIGHT_PAD, pw());
      var totalH = AXIS_H + layout.trackCount * rowH + 4;
      svgEl.setAttribute('width', worldW);
      svgEl.setAttribute('height', totalH);

      function xOf(d) { return LEFT_PAD + diffDays(minDate, d) * px; }
      function yOfTrack(k) { return AXIS_H + k * rowH; }
      /* ---- 分钟级定位（与提醒口径 / deadlines.json 完全一致，改一处必须同步另一处）----
         开始：开始日期 + 开始时刻（未填时刻 → 当日 00:00）
         截止：结束日期 + 结束时刻（未填 → 当日 23:59；起止同日且只填了开始时刻 → 用开始时刻）
         于是「3 小时的会议」就是 1/8 天宽的条，不再一律占满整日。 */
      function fracOfHM(hm) { return (hm.h * 60 + hm.mi) / 1440; }
      function xOfSpanStart(t) { return xOfDayFrac(t.start, fracOfHM(remStartHM(t)), px); }
      function xOfSpanEnd(t) { return xOfDayFrac(t.end || t.start, fracOfHM(remDueHM(t)), px); }
      /* 时间点/里程碑（零长度区间）：填了时刻 → 精确落在该分钟；未填 → 取当日正中。
         为什么未填取正中而不是日界：零长度标记压在斑马纹的日界线上会让人分不清属于哪一天。 */
      function xOfPoint(t) {
        var s = remHM(t.startTime, 0, 0);
        var hm = s.exact ? s : remHM(t.endTime, 0, 0);   /* 只看时刻本身，不做 23:59 兜底 */
        return xOfDayFrac(t.start, hm.exact ? fracOfHM(hm) : 0.5, px);
      }

      var S = '';
      /* 近期事件高亮渐变 + 今日竖线渐变（红色 #ef4444 → #dc2626），用于「开始日在今天±3天内且未结束」的事件/节点与今日线
         （红色为唯一允许使用的高亮边缘色） */
      S += '<defs>' +
        '<linearGradient id="gv-rainbow" x1="0" y1="0" x2="1" y2="0">' +
        '<stop offset="0" stop-color="#ef4444"/><stop offset="1" stop-color="#dc2626"/>' +
        '</linearGradient>' +
        '<linearGradient id="gv-today" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0" stop-color="#ef4444"/><stop offset="1" stop-color="#dc2626"/>' +
        '</linearGradient>' +
        '</defs>';

      /* 逐日交替底色（浅蓝 #e8f2fd / 留白）：先铺底，再压网格与事件条，用于一眼区分相邻日期。
         阈值 px>=4：再窄时单日不足 4px，条纹会退化成摩尔纹噪声，此时靠月份网格定位即可。 */
      if (px >= 4) {
        S += '<g id="gv-zebra">';
        for (var zi = 1; zi < totalDays; zi += 2) {
          S += '<rect x="' + (LEFT_PAD + zi * px).toFixed(1) + '" y="' + AXIS_H +
            '" width="' + px.toFixed(1) + '" height="' + (totalH - AXIS_H).toFixed(1) + '" fill="#e8f2fd"/>';
        }
        S += '</g>';
      }

      /* 月份网格 + 轴标签 */
      S += '<g>';
      var m0 = new Date(minDate.getFullYear(), minDate.getMonth(), 1);
      var lastLabelX = -999;
      var monthLabelXs = [];
      for (var mm = new Date(m0); mm <= maxDate; mm = addMonths(mm, 1)) {
        if (mm > maxDate) break;
        var xm = xOf(mm);
        var isJan = mm.getMonth() === 0;
        var isFirst = (mm.getTime() === m0.getTime());
        S += '<line x1="' + xm.toFixed(1) + '" y1="' + AXIS_H + '" x2="' + xm.toFixed(1) + '" y2="' + totalH + '" stroke="#eef1f6" stroke-width="' + (isJan ? 1.5 : 1) + '"/>';
        if (xm - lastLabelX >= 46 || isFirst) {
          var lab = isFirst ? (mm.getFullYear() + '年' + (mm.getMonth() + 1) + '月') : (isJan ? String(mm.getFullYear()) + '年' : (mm.getMonth() + 1) + '月');
          var anchor = (xm < 30) ? 'start' : ((worldW - xm < 30) ? 'end' : 'middle');
          S += '<text x="' + xm.toFixed(1) + '" y="' + (AXIS_H - 7) + '" text-anchor="' + anchor + '" font-size="10" fill="#64748b">' + lab + '</text>';
          monthLabelXs.push(xm);
          lastLabelX = xm;
        }
      }
      /* 天刻度：【每一天】的日期数字放在该日区间的正中（原来贴在日界线上，视觉上分不清属于哪一天；
         日界线本身已由逐日交替底色表达，不再画冗余细网格） */
      var redXs = redLineXs(px);
      if (px >= 10.5) {
        for (var dj = 0; dj < totalDays; dj++) {
          var ddt = addDays(minDate, dj);
          var ddx2 = LEFT_PAD + (dj + 0.5) * px;          /* 日中心 */
          var tooNear = false;
          for (var ri = 0; !tooNear && ri < redXs.length; ri++) { if (Math.abs(ddx2 - redXs[ri]) < 12) tooNear = true; }
          for (var mi = 0; !tooNear && mi < monthLabelXs.length; mi++) {
            if (Math.abs(ddx2 - monthLabelXs[mi]) < 12) tooNear = true;
          }
          if (tooNear) continue;
          if (ddx2 < LEFT_PAD + 7 || ddx2 > worldW - RIGHT_PAD - 4) continue;
          S += '<text x="' + ddx2.toFixed(1) + '" y="' + (AXIS_H + 2) + '" text-anchor="middle" font-size="8.5" fill="#7e93a6">' + ddt.getDate() + '</text>';
        }
      }
      curMonthLabelXs = monthLabelXs;
      /* 轨道分隔线 */
      for (var kk = 1; kk < layout.trackCount; kk++) {
        var yy = yOfTrack(kk);
        S += '<line x1="' + LEFT_PAD + '" y1="' + yy + '" x2="' + worldW + '" y2="' + yy + '" stroke="#f2f5fa" stroke-width="1"/>';
      }
      S += '</g>';

      /* 今日两条红线（纯红 #ef4444；SVG 渐变在零宽竖线上会失效，故用纯色）：
         ① 当前时刻（分钟级，独立 #gv-nowlines 组，可被 tickNowLine 单独刷新） ② 今日 24:00 */
      S += '<g id="gv-nowlines">' + nowLinesSVG(px, totalH, worldW) + '</g>';

      /* ================= 绘制事件（两遍：先画条收集占用矩形，再放里程碑与防重叠标注） ================= */
      var barRects = [];    // 已画元素占用 {x1,y1,x2,y2}
      var labelRects = [];  // 已放文字占用（条内文字按整条保守占位）
      function rHit(ax1, ay1, ax2, ay2, bx1, by1, bx2, by2) {
        return ax1 < bx2 && ax2 > bx1 && ay1 < by2 && ay2 > by1;
      }
      /* 序号→配色：已完成 → null(灰)；否则步长 5 循环取色，相邻事件颜色差异大 */
      function palOf(t) {
        if (statusOf(t, today) === 'finish') return null;
        var ord = tasksAll.indexOf(t);
        return PAL[((ord + 1) * 5) % PAL.length];
      }
      /* 彩虹高亮命中：开始日期在「今天±3天」内 且 未结束（finish → 不亮） */
      function isRainbow(t) {
        if (statusOf(t, today) === 'finish') return false;
        var ds = diffDays(today, dateOnly(t.start));
        return ds >= -3 && ds <= 3;
      }

      /* ---- 第一遍：普通时间条 ---- */
      tasksAll.forEach(function (t) {
        if (t.point || t.milestone) return;
        /* 起止按「日期 + 分钟级时刻」比例定位与定长：3 小时的事件就是 1/8 天宽（最小 3px 保可点） */
        var x1 = xOfSpanStart(t), x2 = xOfSpanEnd(t);
        var w = Math.max(x2 - x1, 3);
        var st = statusOf(t, today);
        var k = layout.trackOf[t.id];
        var cy = yOfTrack(k) + rowH / 2;
        var id = esc(t.id || '');
        var isFlash = (flashId === t.id);
        var flashCls = isFlash ? ' gv-flash' : '';
        var hBar = Math.max(10, Math.min(16, rowH * 0.5));
        var p = palOf(t);
        var barFill, barStroke, inText;
        if (!p) { barFill = '#cbd5e1'; barStroke = t.crit ? '#6d28d9' : '#94a3b8'; inText = '#475569'; }
        else if (st === 'going') { barFill = p[0]; barStroke = p[2]; inText = '#fff'; }
        else { barFill = p[1]; barStroke = p[2]; inText = p[2]; }
        if (t.crit && p) barStroke = '#6d28d9';           /* crit：紫圈强调（关键节点禁用红色） */
        var barY = cy - hBar / 2;
        var rb = isRainbow(t);
        var strokeW = (isFlash ? 2.5 : (t.crit ? 1.8 : 1));
        /* 近期命中 → 双层描边：底层同色描边 + 外层 3.5px 红色渐变描边（与今日线同色，边缘向外扩展 3.5px） */
        if (rb) {
          var hh = Math.max(hBar + 7, 20);
          S += '<g class="gv-bar gv-rb' + flashCls + '" data-id="' + id + '"><title>' + esc(captionOf(t)) + '</title>' +
            '<rect x="' + (x1 - 1.75).toFixed(1) + '" y="' + (barY - 1.75).toFixed(1) + '" width="' + (w + 3.5).toFixed(1) + '" height="' + hh.toFixed(1) + '" rx="' + Math.min(6, hh / 2) + '" fill="none" stroke="url(#gv-rainbow)" stroke-width="3.5" opacity=".95"/>' +
            '<rect x="' + x1.toFixed(1) + '" y="' + barY.toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + hBar.toFixed(1) + '" rx="' + Math.min(5, hBar / 2) + '" fill="' + barFill + '" stroke="' + barStroke + '" stroke-width="' + strokeW.toFixed(1) + '"/></g>';
          barRects.push({ x1: x1 - 4, y1: barY - 4, x2: x1 + w + 4, y2: barY + hBar + 4 });
        } else {
          S += '<g class="gv-bar' + flashCls + '" data-id="' + id + '"><title>' + esc(captionOf(t)) + '</title>' +
            '<rect x="' + x1.toFixed(1) + '" y="' + barY.toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + hBar.toFixed(1) + '" rx="' + Math.min(5, hBar / 2) + '" fill="' + barFill + '" stroke="' + barStroke + '" stroke-width="' + strokeW.toFixed(1) + '"/></g>';
          barRects.push({ x1: x1, y1: barY, x2: x1 + w, y2: barY + hBar });
        }

        /* 条内文字：统一「名称(日期)」形态 —— 宽条全名、中条截头保尾（尾部日期不可断） */
        var placedInBar = false;
        if (w > 160) {
          var t1 = shortCaption(t, w - 14, 11);
          if (t1) {
            S += '<text class="gv-hit" data-id="' + id + '" x="' + (x1 + w / 2).toFixed(1) + '" y="' + (cy + 3.8).toFixed(1) + '" text-anchor="middle" font-size="11" font-weight="600" fill="' + inText + '">' + esc(t1) + '</text>';
            labelRects.push({ x1: x1 + 3, y1: cy - 9, x2: x1 + w - 3, y2: cy + 6 });
            placedInBar = true;
          }
        } else if (w > 46) {
          var t2 = shortCaption(t, w - 12, 10);
          if (t2) {
            S += '<text class="gv-hit" data-id="' + id + '" x="' + (x1 + w / 2).toFixed(1) + '" y="' + (cy + 3.4).toFixed(1) + '" text-anchor="middle" font-size="10" font-weight="600" fill="' + inText + '">' + esc(t2) + '</text>';
            labelRects.push({ x1: x1 + 3, y1: cy - 8, x2: x1 + w - 3, y2: cy + 5 });
            placedInBar = true;
          }
        } else if (w > 24) {
          /* 很窄条：优先放「名称+日期」缩写，放不下再退「纯日期」 */
          var tn = shortCaption(t, w - 12, 9);
          if (tn && estW(tn, 9) < w - 4) {
            S += '<text class="gv-hit" data-id="' + id + '" x="' + (x1 + w / 2).toFixed(1) + '" y="' + (cy + 3.2).toFixed(1) + '" text-anchor="middle" font-size="9" font-weight="600" fill="' + inText + '">' + esc(tn) + '</text>';
            labelRects.push({ x1: x1 + 2, y1: cy - 8, x2: x1 + w - 2, y2: cy + 5 });
            placedInBar = true;
          } else {
            var dt = rangeCN(t);
            if (dt && estW(dt, 9) < w - 4) {
              S += '<text class="gv-hit" data-id="' + id + '" x="' + (x1 + w / 2).toFixed(1) + '" y="' + (cy + 3.2).toFixed(1) + '" text-anchor="middle" font-size="9" font-weight="600" fill="' + inText + '">' + esc(dt) + '</text>';
              labelRects.push({ x1: x1 + 2, y1: cy - 8, x2: x1 + w - 2, y2: cy + 5 });
              placedInBar = true;
            }
          }
        }
        /* w<=24 或条内放不下：条尾外置「名称(日期)」必显标题 */
        if (!placedInBar) {
          var capOut = shortCaption(t, 999, 9.5);   /* 无限宽限 → 一定产出（含降级日期） */
          if (capOut) placeText(x2 + 2, cy, capOut, 9.5, !p ? '#94a3b8' : p[2], true, true, t.id);
        }
      });

      /* ---- 外置文字放置器：右/左/上/下多档试位，撞条或撞字即跳过；
             force=true 时若全档冲突，在本行 ±2 轨空白高度内扫描空位放置，并拉一条同色折线引回事件/节点；
             高密度时标题也必显且不重叠（不再强制重叠硬画）。 ---- */
      function placeText(x, y, txt, fs, col, force, leadTo, refId) {
        var wT = estW(txt, fs);
        var tries = [
          { dx: 5, dy: 0, an: 'start' },
          { dx: -5, dy: 0, an: 'end' },
          { dx: 5, dy: -(rowH * 0.32), an: 'start' },
          { dx: -5, dy: -(rowH * 0.32), an: 'end' },
          { dx: 5, dy: rowH * 0.26, an: 'start' },
          { dx: -5, dy: rowH * 0.26, an: 'end' }
        ];
        function rectHit(ax1, ay1, ax2, ay2) {
          if (ax1 < LEFT_PAD || ax2 > worldW - RIGHT_PAD) return true;
          for (var bi = 0; bi < barRects.length; bi++) {
            var b = barRects[bi];
            if (rHit(ax1 - 2, ay1, ax2 + 2, ay2, b.x1, b.y1, b.x2, b.y2)) return true;
          }
          for (var li = 0; li < labelRects.length; li++) {
            var lr = labelRects[li];
            if (rHit(ax1 - 1, ay1, ax2 + 1, ay2, lr.x1, lr.y1, lr.x2, lr.y2)) return true;
          }
          return false;
        }
        var placed = false, fx = 0, fy = 0, fan = 'start';
        for (var ti = 0; !placed && ti < tries.length; ti++) {
          var tr = tries[ti];
          var bx = (tr.an === 'start') ? (x + tr.dx) : (x + tr.dx - wT);
          var by0 = y + tr.dy;
          if (by0 - 7 < AXIS_H || by0 + 4 > totalH) continue;
          if (bx < LEFT_PAD || bx + wT > worldW - RIGHT_PAD) continue;
          if (!rectHit(bx - 2, by0 - 7, bx + wT + 2, by0 + 4)) {
            placed = true; fx = bx; fy = by0; fan = tr.an; break;
          }
        }
        if (!placed && force) {
          var step = Math.max(5, rowH * 0.22);
          for (var ky = -rowH * 2; ky <= rowH * 2 + 0.01; ky += step) {
            for (var dir = 0; dir < 2 && !placed; dir++) {
              var cand = (dir === 0) ? (x + 5) : (x - 5 - wT);
              var cly = y + ky;
              if (cly - 7 < AXIS_H || cly + 4 > totalH) continue;
              if (cand < LEFT_PAD || cand + wT > worldW - RIGHT_PAD) continue;
              var an2 = (dir === 0) ? 'start' : 'end';
              if (!rectHit(cand - 2, cly - 7, cand + wT + 2, cly + 4)) {
                placed = true; fx = cand; fy = cly; fan = an2;
              }
            }
            if (placed) break;
          }
        }
        /* 全档扫描仍无空位（高密度极端区，如图最左端里程碑右侧被宽条占满、左侧又越界 LEFT_PAD）：
           不再放弃——选中锚点右侧（含文字探入左栏）或左边界内（端对齐）作无条件兜底，
           保证标题与引线始终存在、线与节点永不断开（宁等叠不断线）。 */
        if (!placed && force) {
          var byF = y - rowH * 0.26;
          if (byF - 7 < AXIS_H) byF = AXIS_H + 7;
          if (byF + 4 > totalH) byF = totalH - 4;
          if (x + 5 + wT <= worldW - RIGHT_PAD) { fx = x + 5; fy = byF; fan = 'start'; }
          else { fx = Math.max(LEFT_PAD, x - 5 - wT); fy = byF; fan = 'end'; }
          placed = true;
        }
        if (!placed) return false;

        var hitAttrs = refId ? ' class="gv-hit" data-id="' + esc(refId) + '"' : '';
        S += '<text' + hitAttrs + ' x="' + fx.toFixed(1) + '" y="' + fy.toFixed(1) + '" text-anchor="' + fan + '" font-size="' + fs + '" font-weight="600" fill="' + col + '">' + esc(txt) + '</text>';
        labelRects.push({ x1: (fan === 'start' ? fx : fx), y1: fy - 7, x2: (fan === 'start' ? fx + wT : fx + wT), y2: fy + 4 });

        if (leadTo) {
          var textEdge = (fan === 'start') ? fx : fx + wT;
          var midX = (x + textEdge) / 2;
          S += '<path' + hitAttrs + ' d="M' + x.toFixed(1) + ',' + y.toFixed(1) +
            ' L' + midX.toFixed(1) + ',' + y.toFixed(1) +
            ' L' + midX.toFixed(1) + ',' + (fy - 1).toFixed(1) +
            ' L' + textEdge.toFixed(1) + ',' + (fy - 1).toFixed(1) +
            '" fill="none" stroke="' + col + '" stroke-width="2.3" opacity=".7"/>';
        }
        return true;
      }

      /* ---- 第二遍：里程碑/当日点（菱形+旁标）与过窄条外置名称标注 ---- */
      tasksAll.forEach(function (t) {
        var x1 = xOfPoint(t);   /* 分钟级定位：填了时刻落该分钟；未填取当日正中 */
        var k = layout.trackOf[t.id];
        var cy = yOfTrack(k) + rowH / 2;
        var id = esc(t.id || '');
        var isFlash = (flashId === t.id);
        var flashCls = isFlash ? ' gv-flash' : '';
        var st = statusOf(t, today);
        var p = palOf(t);

        if (t.point || t.milestone) {
          var dCol = !p ? '#94a3b8' : ((st === 'going') ? p[0] : p[2]);
          var sz = Math.min(6.5, rowH * 0.22 + 3);
          var rb = isRainbow(t);
          var dStroke = (isFlash ? '#f59e0b' : (t.crit ? '#6d28d9' : '#fff'));
          var dWid = (isFlash ? 2.5 : (t.crit ? 2 : 1));
          var extra = '';
          /* 近期命中 → 节点外加一圈同色红渐变描边菱形（扩大 sz+3.5，与今日线同色） */
          if (rb) {
            var sz2 = sz + 3.5;
            extra = '<path d="M' + x1.toFixed(1) + ',' + (cy - sz2).toFixed(1) + ' L' + (x1 + sz2).toFixed(1) + ',' + cy.toFixed(1) + ' L' + x1.toFixed(1) + ',' + (cy + sz2).toFixed(1) + ' L' + (x1 - sz2).toFixed(1) + ',' + cy.toFixed(1) + ' Z" fill="none" stroke="url(#gv-rainbow)" stroke-width="3" opacity=".95"/>';
          }
          S += '<g class="gv-bar' + flashCls + '" data-id="' + id + '"><title>' + esc(captionOf(t)) + '</title>' + extra +
            '<path d="M' + x1.toFixed(1) + ',' + (cy - sz).toFixed(1) + ' L' + (x1 + sz).toFixed(1) + ',' + cy.toFixed(1) + ' L' + x1.toFixed(1) + ',' + (cy + sz).toFixed(1) + ' L' + (x1 - sz).toFixed(1) + ',' + cy.toFixed(1) + ' Z" fill="' + dCol + '" stroke="' + dStroke + '" stroke-width="' + dWid + '"/></g>';
          barRects.push({ x1: x1 - sz - 2, y1: cy - sz - 2, x2: x1 + sz + 2, y2: cy + sz + 2 });
          /* 点旁名称标注：「名称(日期)」完整形态，撞条/撞字自动让位；过宽则降级截断，仍强制显示 */
          var capF = captionOf(t);
          if (estW(capF, 10.5) > 260) capF = shortCaption(t, 240, 10.5);
          placeText(x1, cy, capF, 10.5, !p ? '#8b98a9' : p[2], true, true, t.id);
          return;
        }
        /* 过窄条（w<=24，已在第一遍放置条尾外置）→ 无需重复 */
      });
      svgEl.innerHTML = S;

      /* 事件委托（点击条/菱形/外置标题文字/引线） */
      svgEl.onclick = function (ev) {
        var g = ev.target && ev.target.closest ? ev.target.closest('.gv-bar, .gv-hit') : null;
        if (!g || !g.dataset.id) return;
        var t = model.byId ? model.byId(g.dataset.id) : null;
        if (t) openDetail(t, false);
      };

      if (centerDate) scrollToCenter(centerDate);
      updateRange();
    }

    function scrollToCenter(cd) {
      var px = pxPerDay();
      var max = Math.max(parseFloat(svgEl.getAttribute('width')) - pw(), 0);
      var sl = (LEFT_PAD + diffDays(minDate, cd) * px) - pw() * 0.38;
      if (sl < 0) sl = 0;
      if (sl > max) sl = max;
      scrollEl.scrollLeft = sl;
    }

    function centerDate() {
      var px = pxPerDay();
      var max = Math.max(parseFloat(svgEl.getAttribute('width')) - pw(), 0);
      var sl = Math.min(Math.max(scrollEl.scrollLeft, 0), max);
      return addDays(minDate, (sl + pw() * 0.5 - LEFT_PAD) / px);
    }

    function updateRange() {
      var c = centerDate();
      var half = viewDays / 2;
      var f = new Date(Math.max(minDate, addDays(c, -half)));
      var t = new Date(Math.min(maxDate, addDays(c, half)));
      rangeEl.innerHTML = f.getFullYear() + '年' + (f.getMonth() + 1) + '月' +
        ' ~ ' + t.getFullYear() + '年' + (t.getMonth() + 1) + '月';
      legendEl.querySelectorAll('.gv-todaytag').forEach(function (e) { e.remove(); });
      var tt = el('span', 'gv-todaytag');
      tt.style.cssText = 'color:#ef4444;font-size:11.5px';
      tt.textContent = '（今日 ' + fmtCN(today) + '）';
      legendEl.appendChild(tt);
    }

    /* ---- 全屏显示 ---- */
    var fsBtn = root.querySelector('[data-act="fullscreen"]');
    function syncFsIcon() {
      var on = !!(document.fullscreenElement || document.webkitFullscreenElement) || root.classList.contains('faux-full');
      if (fsBtn) fsBtn.innerHTML = on ? '⛶ 退出全屏' : '⛶ 全屏';
    }
    function enterFaux() {
      root.classList.add('faux-full');
      document.body.style.overflow = 'hidden';
      syncFsIcon();
    }
    function exitFaux() {
      root.classList.remove('faux-full');
      document.body.style.overflow = '';
      syncFsIcon();
    }
    function toggleFullscreen() {
      if (root.classList.contains('faux-full')) { exitFaux(); return; }
      var fsEl = document.fullscreenElement || document.webkitFullscreenElement;
      if (fsEl) {
        if (document.exitFullscreen) document.exitFullscreen();
        else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
        return;
      }
      var fs = root.requestFullscreen || root.webkitRequestFullscreen;
      if (fs) {
        try {
          var p = fs.call(root);
          if (p && p.catch) p.catch(function () { enterFaux(); });
        } catch (e) { enterFaux(); }
      } else {
        enterFaux();
      }
    }
    document.addEventListener('fullscreenchange', syncFsIcon);
    document.addEventListener('webkitfullscreenchange', syncFsIcon);

    /* ---- 工具条 ---- */
    toolbar.addEventListener('click', function (ev) {
      var b = ev.target && ev.target.closest ? ev.target.closest('[data-act]') : null;
      if (!b) return;
      var act = b.dataset.act;
      var c = centerDate();
      var target = null, newDays = null;
      switch (act) {
        case 'zoomin':  newDays = viewDays / 1.7; target = c; break;
        case 'zoomout': newDays = viewDays * 1.7; target = c; break;
        case 'add':
          openAddForm();
          return;
        case 'save':
          saveAll();
          return;
        case 'fullscreen':
          toggleFullscreen();
          return;
        case 'remind':
          openRemind();
          return;
        case 'today':
          target = hasTodayInRange ? new Date(today) : (today > maxDate ? new Date(maxDate) : new Date(minDate));
          newDays = Math.min(viewDays, 110);
          break;
        case 'prevYear':
          newDays = Math.min(Math.max(viewDays, 90), 400);
          target = new Date(c.getFullYear() - 1, c.getMonth(), 15);
          break;
        case 'nextYear':
          newDays = Math.min(Math.max(viewDays, 90), 400);
          target = new Date(c.getFullYear() + 1, c.getMonth(), 15);
          break;
        case 'prevMonth':
          newDays = viewDays > 60 ? 45 : viewDays;
          target = new Date(c.getFullYear(), c.getMonth() - 1, 15);
          break;
        case 'nextMonth':
          newDays = viewDays > 60 ? 45 : viewDays;
          target = new Date(c.getFullYear(), c.getMonth() + 1, 15);
          break;
      }
      if (target) {
        if (target < minDate) target = new Date(minDate);
        if (target > maxDate) target = new Date(maxDate);
        viewDays = clamp(newDays != null ? newDays : viewDays, MIN_VIEW, MAX_VIEW);
        redraw(target);
      }
    });

    /* 滚动时刷新范围指示 */
    var scTimer = null;
    scrollEl.addEventListener('scroll', function () {
      if (scTimer) clearTimeout(scTimer);
      scTimer = setTimeout(updateRange, 150);
    });

    /* ---- 模式检测与自适应 ---- */
    /* 整页向右旋转 90° 回调（index.html 挂载）：true=整页旋转；false/null=不旋转 */
    var lastReported = null;
    function reportLand() {
      if (typeof onLand !== 'function') return;
      var v = effLand();
      if (v !== lastReported) { lastReported = v; onLand(v); }
    }
    function applyMode() {
      var W = window.innerWidth, H = window.innerHeight;
      var nextMobile = W <= 700;
      autoLand = (W > H) && W <= 1024 && H <= 760;
      var nextLand = effLand();
      reportLand();
      if (nextMobile !== isMobile || nextLand !== isLand) {
        isMobile = nextMobile;
        isLand = nextLand;
        root.classList.toggle('gv-land', isLand);
        var want = isLand ? 53 : (isMobile ? 47 : 65);
        if (Math.abs(viewDays - want) > 5) viewDays = want;
        redraw(centerDate());
        if (isLand) setLabelsCollapsed(true);
      }
    }
    /* 受右上角按钮调用的视图切换：'normal'|'land'|'auto' */
    function setViewMode(mode) {
      viewOverride = (mode === 'normal' || mode === 'land') ? mode : null;
      applyMode();
      redraw(centerDate());
    }
    window.addEventListener('resize', function () {
      applyMode();
      redraw(centerDate());
    });

    /* ---- 滚动交互 ---- */
    /* 注：横屏（整页旋转）不再拦截触摸——纵向拖拽自然冒泡给 html.page-land body 做整页翻页，
       横向拖拽由 .gv-scroll 原生 overflow-x:auto 滚时间轴（浏览器自动分工，无需 JS） */
    scrollEl.addEventListener('wheel', function (e) {
      /* 桌面：Ctrl+滚轮 = 缩放时间范围（以视口中心日期为锚点，夹紧数据全跨度） */
      if (e.ctrlKey) {
        e.preventDefault();
        var factor = Math.exp(e.deltaY * 0.0016);
        var nd = clamp(Math.round(viewDays * factor), MIN_VIEW, MAX_VIEW);
        if (nd !== viewDays) {
          viewDays = nd;
          redraw(centerDate());
        }
        return;
      }
      if (!isLand) return;
      /* 横屏整页旋转：滚轮不再横向转时间，交还页面纵向滚动（整页翻页） */
      return;
    }, { passive: false });

    /* 键盘（桌面）：← / → 横向滚动；Ctrl / ⌘ + S = 保存同步（等价于工具栏「💾 保存更改」） */
    document.addEventListener('keydown', function (e) {
      var tag = document.activeElement && document.activeElement.tagName;
      var inField = (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT' ||
        !!(document.activeElement && document.activeElement.isContentEditable));
      /* Ctrl/⌘ + S → 保存同步（浏览器默认行为是「保存网页」，必须先拦截） */
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && String(e.key).toLowerCase() === 's') {
        e.preventDefault();
        if (!isAdmin) { toast('Ctrl+S = 保存同步：当前未登录管理员。点右上角「🔒 管理员」登录后即可使用。'); return; }
        var sbtn = toolbar.querySelector('[data-act="save"]');
        if (!sbtn) { toast('未找到保存按钮，请刷新页面后重试。'); return; }
        if (!hasPending()) { toast('✅ 当前没有未保存的改动（Ctrl+S = 保存同步）。'); return; }
        toast('💾 正在保存同步到 GitHub…');
        sbtn.click();
        return;
      }
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      if (inField) return;
      var dx = e.key === 'ArrowLeft' ? -pw() * 0.7 : pw() * 0.7;
      scrollEl.scrollBy({ left: dx, behavior: 'smooth' });
    });

    /* ---- 详情抽屉 ---- */
    var mask = null, drawer = null;
    /* 抽屉惰性创建：详情/新增/编辑都可能最先触发（管理员首次点「＋新增」时 drawer 尚不存在）。
       挂到 .gv-root 内：全屏（.gv-root:fullscreen）时弹窗仍在全屏层内可见。 */
    function ensureDrawer() {
      if (!mask || !drawer) {
        mask = el('div', 'gv-mask');
        drawer = el('div', 'gv-drawer');
        root.appendChild(mask);
        root.appendChild(drawer);
        mask.addEventListener('click', closeDetail);
      }
    }
    function flashTask(id) {
      flashId = id;
      redraw(centerDate());
      setTimeout(function () {
        if (flashId === id) { flashId = null; redraw(centerDate()); }
      }, 2600);
    }
    function openDetail(task, fromLabel) {
      /* 课程日事件（k1w09 类）→ 归一到基础课程详情，注入具体日期；普通事件直接取 eventsData */
      var ev = eventsData[task.id] || courseDetailOf(task) || null;
      var sec = secOfTask[task.id] || { name: '' };
      /* 点击左侧：弹窗 + 自动定位到事件日期 + 高亮 */
      if (fromLabel) {
        scrollToCenter(task.start);
        flashTask(task.id);
        Object.keys(labelRowByTask).forEach(function (id) { labelRowByTask[id].classList.remove('active'); });
        if (labelRowByTask[task.id]) labelRowByTask[task.id].classList.add('active');
      }
      if (!mask) {
        ensureDrawer();
      }
      var st = statusOf(task, today);
      var chips =
        '<span class="gv-chip c4">' + esc(sec.name) + '</span>' +
        (task.milestone || task.point ? '<span class="gv-chip c1">◆ 时间点</span>' : '<span class="gv-chip c1">▬ 事件（时间段）</span>') +
        (task.crit ? '<span class="gv-chip c3">关键节点</span>' : '') +
        (String(task.name).indexOf('推测') >= 0 ? '<span class="gv-chip c1">日期为推测</span>' : '') +
        '<span class="gv-chip c4">' + (st === 'finish' ? '✓ 已过' : (st === 'going' ? '● 已到/进行' : '○ 未开始')) + '</span>';
      var timeRange = fmtDT(task.start, task.startTime) + ' → ' + fmtDT(task.end, task.endTime) + ((task.point || task.milestone) ? '（当日）' : '');

      var body = '';
      function row(k, v) { return '<div class="gv-drow"><span class="k">' + k + '</span><span class="v">' + v + '</span></div>'; }
      /* 统一 9 项属性：ID / 名称 / 面向对象 / 时间要求 / 地点 / 文件材料 / 执行步骤 / 备注 / 责任班委；缺省写 "/" */
      var seq = seqById[task.id] || '';
      var name = task.name || '';
      var who = (ev && ev.who) ? ev.who : '/';
      var when = (ev && ev.when) ? ev.when : timeRange;
      var where = (ev && ev.where) ? ev.where : '由负责的班委确定，联系负责的班委同学';
      var files = (ev && ev.files && ev.files !== '—') ? ev.files : '见于班级通知群';
      var atts = (ev && ev.attachments && ev.attachments.length) ? ev.attachments : null;
      var steps = (ev && ev.steps && ev.steps.length) ? ev.steps : null;
      var stepImg = (ev && ev.stepImg) ? ev.stepImg : null;
      var tips = (ev && ev.tips && ev.tips !== '—') ? ev.tips : '/';
      var tipsImg = (ev && ev.tipsImg) ? ev.tipsImg : null;
      var owners = (ev && ev.owners && ev.owners.length) ? ev.owners : null;

      body += row('ID', '#' + seq);
      body += row('待办事项名称', esc(name));
      body += row('面向对象', esc(who));
      body += row('时间要求', esc(when));
      body += row('地点', esc(where));
      body += row('用到的文件材料等', esc(files) + (atts
        ? '<div class="gv-att">' + atts.map(function (a) {
          return '<a href="' + esc(a.url) + '" target="_blank" rel="noopener" download><span class="gv-att-ico">📎</span>' + esc(a.name) + '</a>';
        }).join('') + '</div>'
        : ''));
      body += row('相关同学执行步骤', steps
        ? '<ul class="gv-steps">' + steps.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' +
          (stepImg ? '<img class="gv-stepimg" src="' + esc(stepImg) + '" alt="执行步骤配图" loading="lazy">' : '')
        : (stepImg ? '<img class="gv-stepimg" src="' + esc(stepImg) + '" alt="执行步骤配图" loading="lazy">' : '/'));
      body += row('备注', esc(tips) + (tipsImg ? '<img class="gv-tipsimg" src="' + esc(tipsImg) + '" alt="备注配图" loading="lazy">' : ''));
      body += row('负责的班委', owners
        ? owners.map(function (o) {
          return '<span class="gv-owner">' + esc(o.name) + (o.role ? '（' + esc(o.role) + '）' : '') + '</span>';
        }).join('')
        : '/');
      body += row('是否已完成', task.done ? '已完成' : '未完成');
      /* v17：提交材料参考示例（图片）——所有人可见、可点击查看大图、可下载 */
      if (ev && ev.sampleUrl) {
        body += '<div class="gv-drow"><span class="k">提交材料参考示例</span><span class="v gv-sample">' +
          '<img class="gv-sample-thumb" src="' + esc(ev.sampleUrl) + '" alt="材料示例图" loading="lazy">' +
          '<br><a href="' + esc(ev.sampleUrl) + '" target="_blank" rel="noopener" download>查看大图 / 下载图片</a>' +
          '</span></div>';
      } else {
        body += row('提交材料参考示例', '/');
      }

      drawer.innerHTML =
        '<div class="grab"></div><button class="gv-close" aria-label="关闭">✕</button>' +
        '<div class="gv-dhead">' + esc(task.name) + '</div>' +
        '<div class="gv-dsub">' + chips + '<br>' + timeRange + '</div>' + body +
        (isAdmin
          ? '<div class="gv-adminbar">' +
            '<button class="gv-tbtn gv-editbtn" type="button">✏️ 编辑</button>' +
            '<button class="gv-tbtn gv-delbtn" type="button" style="color:#b91c1c;border-color:#fecaca">🗑 删除</button>' +
            '</div>'
          : '');
      drawer.querySelector('.gv-close').addEventListener('click', closeDetail);
      /* v17：示例图片点击 → 全屏灯箱查看大图 */
      var thumb = drawer.querySelector('.gv-sample-thumb');
      if (thumb) {
        thumb.addEventListener('click', function () {
          var lb = document.createElement('div');
          lb.className = 'gv-lightbox';
          var img = document.createElement('img');
          img.src = thumb.src; img.alt = '示例大图';
          lb.appendChild(img);
          lb.addEventListener('click', function () { lb.remove(); });
          (root || document.body).appendChild(lb);
        });
      }
      /* v19：执行步骤配图点击 → 同款灯箱 */
      var stepImgEl = drawer.querySelector('.gv-stepimg');
      if (stepImgEl) {
        stepImgEl.addEventListener('click', function () {
          var lb = document.createElement('div');
          lb.className = 'gv-lightbox';
          var img = document.createElement('img');
          img.src = stepImgEl.src; img.alt = '执行步骤配图大图';
          lb.appendChild(img);
          lb.addEventListener('click', function () { lb.remove(); });
          (root || document.body).appendChild(lb);
        });
      }
      /* v20：备注配图点击 → 同款灯箱 */
      var tipsImgEl = drawer.querySelector('.gv-tipsimg');
      if (tipsImgEl) {
        tipsImgEl.addEventListener('click', function () {
          var lb = document.createElement('div');
          lb.className = 'gv-lightbox';
          var img = document.createElement('img');
          img.src = tipsImgEl.src; img.alt = '备注配图大图';
          lb.appendChild(img);
          lb.addEventListener('click', function () { lb.remove(); });
          (root || document.body).appendChild(lb);
        });
      }
      if (isAdmin) {
        drawer.querySelector('.gv-editbtn').addEventListener('click', function () { openEditForm(task); });
        drawer.querySelector('.gv-delbtn').addEventListener('click', function () { confirmDelete(task); });
      }
      mask.classList.add('on');
      drawer.classList.add('on');
      document.body.style.overflow = 'hidden';
    }
    function closeDetail() {
      if (!drawer) return;
      mask.classList.remove('on');
      drawer.classList.remove('on');
      document.body.style.overflow = '';
    }

    /* ================= 提醒消息弹窗：截止不足一天的待办 ================= */
    var REM_KEY = 'mermaid-gantt.remDone.v1';
    function loadRemDone() {
      try { var a = JSON.parse(localStorage.getItem(REM_KEY)); return Array.isArray(a) ? a : []; }
      catch (e) { return []; }
    }
    function saveRemDone(a) {
      try { localStorage.setItem(REM_KEY, JSON.stringify(a)); } catch (e) {}
    }
    /* 时刻口径全部下沉到模块级纯函数（hmParts / startHMOf / dueHMOf / whenTextOf /
       alarmAtOf / alarmHMOf / alarmWhenOf），这里只保留既有调用名的薄封装，
       以便与构建端 tools/build-deadlines.js 做跨端口径断言。 */
    function remHM(raw, fh, fmi) { return hmParts(raw, fh, fmi); }
    function remStartHM(task) { return startHMOf(task); }
    function remDueHM(task) { return dueHMOf(task); }
    /* 任务「真实截止时间」= 结束日期 + 结束时刻，精确到分钟（不再一律按当天 23:59） */
    function remDeadlineOf(task) {
      var end = task.end || task.start;
      if (!end) return null;
      var t = remDueHM(task);
      return new Date(end.getFullYear(), end.getMonth(), end.getDate(), t.h, t.mi, 0, 0).getTime();
    }
    /* 起止文案（分钟级）：「9.10 14:00 → 9.10 17:00」；未填时刻的推定值以「~」标出 */
    function remWhenText(task) { return whenTextOf(task); }
    /* ---- 通道 C（快捷指令 → 「时钟」App 闹钟）----
       只对【今天开始】的条目建闹钟（时钟闹钟没有日期维度，见 remAlarmCandidates 的三道筛）；
       「时间」= 开始时刻 − 15 分钟（alarmAtOf / alarmHMOf）；「标签」= 名称｜地点｜开始→结束时间
       （与构建端 tools/build-deadlines.js 的 alarmAt / alarmTime / alarmLabel 同一口径，
        改任一侧都要同步另一侧；test/unit.js [11] 有跨端断言） */
    function remAlarmName(task) {
      var ev = eventsData[task.id] || {};
      return ev.short || task.name;
    }
    function remAlarmWhere(task) {
      var ev = eventsData[task.id] || {};
      return String(ev.where || '').trim();
    }
    function remAlarmLabel(task) {
      return alarmLabelOf(remAlarmName(task), remAlarmWhere(task), alarmWhenOf(task));
    }
    /* 闹钟清单的每一行：第一行 = 闹钟标签原文（与快捷指令实际写入的内容一致），第二行给出闹钟时刻 */
    function remAlarmLine(task) {
      var d = alarmAtOf(task);
      var when = d ? fmtMD(d) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) : '—';
      return '· ' + remAlarmLabel(task) + '\n  ⏰ 系统闹钟 ' + when + '（开始前 ' + ALARM_LEAD_MIN + ' 分钟）';
    }
    function remLeftMs(task, now) {
      var dl = remDeadlineOf(task);
      if (dl == null) return null;
      return dl - now.getTime();
    }
    /* 收集：未完成、尚未过期、剩余未超24h 的待办，按最先截止排序 */
    function remCollect(now) {
      var out = [];
      for (var i = 0; i < model.all.length; i++) {
        var t = model.all[i];
        if (t.done) continue;
        if (isCourseTask(t)) continue;      /* 课程表：只上图，不进待办提醒 */
        var leftMs = remLeftMs(t, now);
        if (leftMs == null || leftMs < 0 || leftMs > DAY) continue;
        out.push(t);
      }
      out.sort(function (a, b) { return remLeftMs(a, now) - remLeftMs(b, now); });
      return out;
    }
    /* 弹窗容器惰性创建 */
    var remMask = null, remPanel = null, remListEl = null, remDoneEl = null, remSubEl = null, remFootEl = null;
    function remEnsure() {
      if (!remMask || !remPanel) {
        remMask = el('div', 'gv-rem-mask');
        remPanel = el('div', 'gv-rem-panel');
        remPanel.innerHTML =
          '<button class="gv-rem-close" aria-label="关闭">✕</button>' +
          '<div class="gv-rem-head">' +
          '  <span class="icon">🔔</span><h3>ddl 提醒</h3>' +
          '  <button class="gv-rem-clear" type="button">清除已完成</button>' +
          '</div>' +
          '<p class="gv-rem-sub" id="gv-rem-sub"></p>' +
          '<div class="gv-rem-list" id="gv-rem-list"></div>' +
          '<div class="gv-rem-done" id="gv-rem-done"></div>' +
          '<div class="gv-rem-foot">勾选 = 标记完成，自动折叠到底部 · 时间取自编辑表单的日期/时刻组件，未填「时刻」按 00:00 / 23:59 计（带 ~ 标记）</div>' +
          '<div class="gv-rem-sys">' +
          '  <button type="button" class="gv-rem-btn" data-act="ics" title="下载 .ics：在 iPhone「文件」中打开即写入系统日历，截止前 30 分钟与到点各响一次">📅 加入系统日历</button>' +
          '  <button type="button" class="gv-rem-btn" data-act="alarm" title="唤起快捷指令「甘特图闹钟」：只对【今天开始】的条目，在【开始时刻前 15 分钟】各建一个闹钟，标签 = 「名称｜地点｜开始→结束时间」，在「时钟」App 中生成真正的系统闹钟">⏰ 同步系统闹钟</button>' +
          '  <button type="button" class="gv-rem-btn" data-act="copy" title="复制精确到分钟的截止清单">📋 复制清单</button>' +
          '  <button type="button" class="gv-rem-btn" data-act="sub" title="复制可订阅的日历地址（iPhone：设置 → 日历 → 账户 → 添加订阅日历）">🔗 订阅地址</button>' +
          '</div>' +
          '<div class="gv-rem-note" id="gv-rem-note">📅 原生日历+闹铃（全平台通用） · ⏰ 快捷指令创建系统闹钟：只设【今天开始】的条目，时间 = 开始前 15 分钟，标签 = 「名称｜地点｜开始→结束时间」（需 iPhone 已装「甘特图闹钟」，步骤见 docs/ios-system-alarm-setup.md）</div>';
        root.appendChild(remMask);
        root.appendChild(remPanel);
        remMask.addEventListener('click', remClose);
        remPanel.querySelector('.gv-rem-close').addEventListener('click', remClose);
        remPanel.querySelector('.gv-rem-clear').addEventListener('click', remClearAll);
        remPanel.querySelectorAll('.gv-rem-btn').forEach(function (b) {
          b.addEventListener('click', function () { remSysAction(b.getAttribute('data-act')); });
        });
      }
      remSubEl = remPanel.querySelector('#gv-rem-sub');
      remListEl = remPanel.querySelector('#gv-rem-list');
      remDoneEl = remPanel.querySelector('#gv-rem-done');
      remFootEl = remPanel.querySelector('.gv-rem-foot');
    }
    /* 截止文案：已过点=已到期；否则给出精确剩余时长（分钟级，如「剩 3 小时 12 分」） */
    function remChip(t, now) {
      var left = remLeftMs(t, now);
      if (left == null) return '';
      if (left <= 0) return '已到期';
      var mins = Math.floor(left / 60000);
      var h = Math.floor(mins / 60), m2 = mins % 60;
      if (h <= 0) return '剩 ' + m2 + ' 分钟';
      return '剩 ' + h + ' 小时' + (m2 ? ' ' + m2 + ' 分' : '');
    }
    function remItemHTML(list, isDone) {
      var html = '';
      var now = new Date();
      for (var i = 0; i < list.length; i++) {
        var t = list[i];
        var sec = secOfTask[t.id] || { name: '' };
        var when = remWhenText(t);
        html += '<label class="gv-rem-item' + (isDone ? ' done' : '') + '" data-id="' + escId(t.id) + '">' +
          '<input type="checkbox" data-id="' + escId(t.id) + '"' + (isDone ? ' checked' : '') + '>' +
          '<span style="flex:1">' +
          '  <span class="nm">' + esc(t.name) + '</span>' +
          '  <span class="mt"><span class="chip">' + esc(remChip(t, now)) + '</span><span class="when" title="开始 → 截止（分钟级，取自编辑表单的日期/时刻组件）">' + esc(when) + '</span><span class="sec">' + esc(sec.name) + '</span></span>' +
          '</span>' +
          '</label>';
      }
      return html;
    }
    function escId(s) { return String(s).replace(/["\\]/g, ''); }
    function remBindItems(container) {
      if (!container) return;
      container.querySelectorAll('.gv-rem-item').forEach(function (label) {
        var id = label.dataset.id;
        var cb = label.querySelector('input');
        cb.addEventListener('change', function () {
          var done = loadRemDone();
          var i = done.indexOf(id);
          if (cb.checked) { if (i < 0) done.push(id); }
          else if (i >= 0) done.splice(i, 1);
          saveRemDone(done);
          remRender();
        });
        label.addEventListener('click', function (ev) { if (ev.target !== cb) cb.click(); });
      });
    }
    function remRender() {
      remEnsure();
      var now = new Date();
      var list = remCollect(now);
      var doneIds = loadRemDone();
      var pending = [], finished = [];
      list.forEach(function (t) { (doneIds.indexOf(t.id) >= 0 ? finished : pending).push(t); });
      var dateStr = now.getFullYear() + '年' + (now.getMonth() + 1) + '月' + now.getDate() + '日';
      remSubEl.textContent = list.length
        ? dateStr + ' · 有 ' + list.length + ' 项待办剩余不足一天（按最先截止排序）'
        : dateStr + ' · 当前无截止不足一天的待办';
      if (!pending.length && !finished.length) {
        remListEl.innerHTML = '<div class="gv-rem-empty">🎉暂无即将截止的待办<br>继续保持</div>';
        remDoneEl.innerHTML = '';
        remFootEl.style.visibility = 'hidden';
        return;
      }
      remListEl.innerHTML = remItemHTML(pending, false);
      remDoneEl.innerHTML = finished.length
        ? '<div class="gv-rem-head" style="margin:2px 0 6px"><h3 style="font-size:13px;color:#94a3b8">已完成（折叠）</h3></div>' + remItemHTML(finished, true)
        : '';
      remFootEl.style.visibility = finished.length ? 'visible' : 'hidden';
      remBindItems(remListEl);
      remBindItems(remDoneEl);
    }
    function remClose() {
      if (!remPanel) return;
      remMask.classList.remove('on');
      remPanel.classList.remove('on');
      document.body.style.overflow = '';
    }
    function remClearAll() {
      saveRemDone([]);
      remRender();
    }
    function openRemind() {
      remEnsure();
      remRender();
      remMask.classList.add('on');
      remPanel.classList.add('on');
      document.body.style.overflow = 'hidden';
    }
    /* 角标：待提醒数量 */
    function remUpdateBadge() {
      var badge = document.getElementById('gv-rembadge');
      if (!badge) return;
      var n = remCollect(new Date()).length;
      badge.textContent = n > 0 ? String(n) : '';
    }

    /* ================= 系统级提醒通道：导出 .ics（原生日历闹铃）/ 唤起快捷指令闹钟 ================= */
    /* 为什么走这两条路：
       静态网页拿不到 iOS 的 Critical Alert 权限，Web Push 也只能发普通级别通知；
       而「日历事件 + VALARM」与「时钟 App 闹钟」都是系统原生能力，能真正穿透静音/专注。 */
    var ALARM_SHORTCUT = '甘特图闹钟';
    var ICS_SUB_URL = location.origin + location.pathname.replace(/[^/]*$/, '') + 'deadlines.ics';

    function remNote(msg) {
      var n = remPanel && remPanel.querySelector('#gv-rem-note');
      if (n) n.textContent = msg;
    }
    /* 把当前待办列表映射成 ics.js 要的通用结构：
       事件「起」= 截止前 pre 分钟（不早于开始时刻），「止」= 精确截止时刻；
       两个 VALARM：到点(0) + 提前 pre 分钟，与构建期产出的 deadlines.ics 行为一致。
       UID 固定为「gantt-<id>@…」——同一条待办改期后重新导入是「更新」而不是「新增一条」。 */
    function buildICS(list) {
      if (!Ics || !Ics.build) return '';
      var events = list.map(function (t) {
        var s = remStartHM(t), e = remDueHM(t);
        var sd = t.start || t.end, ed = t.end || t.start;
        var startMs = new Date(sd.getFullYear(), sd.getMonth(), sd.getDate(), s.h, s.mi).getTime();
        var endMs = new Date(ed.getFullYear(), ed.getMonth(), ed.getDate(), e.h, e.mi).getTime();
        var ev = eventsData[t.id] || {};
        var title = ev.short || t.name;
        /* 预响时长：默认提前 30 分钟，但不超过「整段时间的一半」，也绝不早于开始时刻 */
        var span = Math.max(60000, endMs - startMs);
        var pre = Math.max(60000, Math.min(30 * 60 * 1000, Math.round(span / 2)));
        var evStart = Math.max(startMs, endMs - pre);
        var desc = [];
        desc.push('阶段：' + ((secOfTask[t.id] && secOfTask[t.id].name) || '—'));
        desc.push('起止：' + remWhenText(t));
        if (ev.who) desc.push('面向：' + ev.who);
        if (ev.where) desc.push('地点：' + ev.where);
        if (ev.owners && ev.owners.length) desc.push('负责班委：' + ev.owners.map(function (o) { return o.name; }).join('、'));
        desc.push('来源：读研甘特图（软件2603班专属）');
        return {
          uid: 'gantt-' + String(t.id).replace(/[^\w.-]/g, '') + '@mermaid-gantt-share',
          title: '⏰ 截止：' + title,
          startMs: evStart,
          endMs: endMs,
          desc: desc.join('\n'),
          location: ev.where || '',
          alarmsMin: [0, -Math.round(pre / 60000)],
          alarmText: title
        };
      });
      return Ics.build(events, { calName: '软件2603 · 班务截止提醒' });
    }
    function downloadText(name, text, mime) {
      try {
        var blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url; a.download = name; a.style.display = 'none';
        document.body.appendChild(a); a.click();
        setTimeout(function () { URL.revokeObjectURL(url); if (a.parentNode) a.parentNode.removeChild(a); }, 1500);
        return true;
      } catch (e) { return false; }
    }
    function copyText(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
      return new Promise(function (res, rej) {
        try {
          var ta = document.createElement('textarea');
          ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
          document.body.appendChild(ta); ta.select();
          var ok = document.execCommand('copy');
          document.body.removeChild(ta);
          ok ? res() : rej(new Error('execCommand copy 失败'));
        } catch (e) { rej(e); }
      });
    }
    /* 唤起「快捷指令」：iOS 会先问「是否在快捷指令中打开」；1.8s 后若页面未被切走则给降级提示 */
    function runAlarmShortcut(planned) {
      var went = false;
      var onVis = function () { if (document.hidden) went = true; };
      document.addEventListener('visibilitychange', onVis);
      try { location.href = 'shortcuts://run-shortcut?name=' + encodeURIComponent(ALARM_SHORTCUT); }
      catch (e) { /* 桌面浏览器无此 scheme，忽略 */ }
      setTimeout(function () {
        document.removeEventListener('visibilitychange', onVis);
        if (went) {
          remNote('已唤起「' + ALARM_SHORTCUT + '」：只对【今天开始】的条目，各建一个【开始时刻前 ' + ALARM_LEAD_MIN + ' 分钟】的闹钟，标签为「名称｜地点｜开始→结束时间」' +
            (planned ? '（本次预计 ' + planned + ' 条）' : '（今天没有已填开始时刻的待办）') +
            '。清单已复制到剪贴板。');
        } else {
          remNote('未能唤起快捷指令：当前设备可能不是 iPhone，或尚未安装快捷指令「' + ALARM_SHORTCUT + '」。可改用「📅 加入系统日历」，配置步骤见 docs/ios-system-alarm-setup.md');
        }
      }, 1800);
    }
    /* 导出用的清单：优先「当前提醒列表里未勾选完成」的项；为空则退化为未来 60 天内的未完成项 */
    function remExportList(now) {
      var doneIds = loadRemDone();
      var list = remCollect(now).filter(function (t) { return doneIds.indexOf(t.id) < 0; });
      if (list.length) return list;
      var horizon = now.getTime() + 60 * DAY;
      var dayStart = dateOnly(now).getTime();
      return model.all.filter(function (t) {
        if (t.done || !t.end) return false;
        if (isCourseTask(t)) return false;   /* 课程表：只上图，不导出为待办/日历 */
        var dl = remDeadlineOf(t);
        return dl != null && dl >= dayStart && dl <= horizon;
      });
    }
    /* 通道 C 真正能被建成闹钟的条目，判定与捷径（读 deadlines.json）完全一致：
       ①开始日期 = 今天（时钟闹钟没有「日期」维度，非今天的会被顺延到错误的日子响）
       ②显式填了开始时刻（未填时刻按 00:00 计 → 闹钟落到前一天 23:45，无意义）
       ③闹钟时刻尚未过点（已过点的会被顺延到明天响，捷径侧也会剔除）
       注意：这里必须直接从全量任务取，**不能**复用「剩余不足一天」的提醒列表 ——
       今天开始但截止还在 24 小时以外的活动，其闹钟仍然有效，却不在提醒列表里。 */
    function remAlarmCandidates() {
      var today = fmtYMD(new Date());
      var nowMs = Date.now();
      var doneIds = loadRemDone();
      return model.all.filter(function (t) {
        if (t.done || doneIds.indexOf(t.id) >= 0) return false;
        if (isCourseTask(t)) return false;   /* 课程表：只上图，不建系统闹钟 */
        var sd = t.start || t.end;
        if (!sd || fmtYMD(sd) !== today || !remStartHM(t).exact) return false;
        var d = alarmAtOf(t);
        return !!d && d.getTime() > nowMs;
      });
    }
    function remSysAction(act) {
      remEnsure();
      var now = new Date();
      var list = remExportList(now);
      if (act === 'ics') {
        var text = buildICS(list);
        if (!text) { remNote('日历模块（js/ics.js）未加载，无法导出 .ics；请强制刷新页面（Ctrl+F5）后重试。'); return; }
        var ok = downloadText('deadlines-' + fmtYMD(now) + '.ics', text, 'text/calendar;charset=utf-8');
        remNote(ok
          ? '已下载 .ics（' + list.length + ' 项）——在 iPhone 上打开该文件 →「添加到日历」，即可获得系统日历闹铃（含到点与提前提醒）。'
          : '浏览器阻止了下载，请改用订阅地址：' + ICS_SUB_URL);
        return;
      }
      if (act === 'alarm') {
        /* 只把「捷径真正会建闹钟」的条目复制出去，清单即"将发生什么"的预览 */
        var cands = remAlarmCandidates();
        copyText(cands.length
          ? cands.map(remAlarmLine).join('\n')
          : '今天没有「已填开始时刻、且闹钟时刻未过点」的待办 —— 捷径不会新建闹钟（只对【今天开始】的条目建闹钟；未填时刻的条目请用 📅 加入系统日历，它有日期维度，不受此限）'
        ).catch(function () {});
        runAlarmShortcut(cands.length);
        return;
      }
      if (act === 'copy') {
        var txt = list.map(function (t) { return '· ' + remWhenText(t) + '  ' + t.name; }).join('\n');
        copyText(txt).then(function () { remNote('已复制 ' + list.length + ' 条截止清单（分钟级）到剪贴板。'); },
          function () { remNote('复制被浏览器拒绝，请手动长按选择文本。'); });
        return;
      }
      if (act === 'sub') {
        copyText(ICS_SUB_URL).then(function () {
          remNote('订阅地址已复制：' + ICS_SUB_URL + '（iPhone：设置 → 日历 → 账户 → 添加订阅日历 → 粘贴）');
        }, function () { remNote('订阅地址：' + ICS_SUB_URL); });
        return;
      }
    }

    /* ================= 管理员 CRUD（GitHub API 线上直写） ================= */
    /* 生成同类 id 的下一个编号：普通/crit → t*，里程碑 → m*，含详情 → b* */
    function genId(prefix) {
      var max = 0;
      var re = new RegExp('^' + prefix + '(\\d+)$');
      model.all.forEach(function (t) {
        var m = re.exec(t.id || '');
        if (m) max = Math.max(max, parseInt(m[1], 10));
      });
      return prefix + (max + 1);
    }
    function sectionOptions(cur) {
      return model.sections.map(function (sec) {
        return '<option value="' + esc(sec.name) + '"' + (sec.name === cur ? ' selected' : '') + '>' + esc(sec.name) + '</option>';
      }).join('');
    }
    /* 基于当前 eventsData 构造新对象：changeEvent=null 删除，否则新增/覆盖 */
    function buildEvents(changeId, changeEvent) {
      var out = {};
      Object.keys(eventsData).forEach(function (k) { out[k] = eventsData[k]; });
      if (changeEvent === null) delete out[changeId];
      else out[changeId] = changeEvent;
      return out;
    }
    /* 保存/暂存后重渲染：不整页刷新（避免退出全屏）。用最新代码重新解析当前 mount 实例的数据变量，
       原地重建左列 + 重绘，全屏状态与滚动位置全部保留。 */
    function reloadAfterSave(code, evData) {
      if (!code) { var p = loadPending(); code = p ? p.ganttCode : ''; }
      if (!code) return;
      if (evData === undefined) evData = eventsData;
      var newModel = Parser.parse ? Parser.parse(code) : null;
      if (!newModel || !newModel.range) return;
      /* 若详情弹窗正打开着（编辑/新增表单或详情），提交/保存后自动关闭，回到甘特图视图 */
      if (drawer && drawer.classList.contains('on')) closeDetail();
      /* 更新核心数据变量（闭包内 var，重新赋值即全局生效） */
      model = newModel;
      tasksAll = model.all;
      minDate = dateOnly(model.range.start);
      maxDate = dateOnly(model.range.end);
      totalDays = diffDays(minDate, maxDate) + 1;
      hasTodayInRange = (today >= minDate && today <= maxDate);
      MAX_VIEW = Math.max(totalDays * 1.02, 400);
      eventsData = evData || {};
      /* 重建映射与左列 */
      secOfTask = {};
      model.sections.forEach(function (sec) {
        sec.tasks.forEach(function (t) { secOfTask[t.id] = sec; });
      });
      seqById = {};
      model.all.forEach(function (t, i) { seqById[t.id] = i + 1; });
      buildLabelList();
      /* 保持当前视图中心重绘 */
      redraw(centerDate());
      syncSaveBtn();
    }
    function showFormErr(form, msg) {
      var old = form.querySelector('.f-err');
      if (old) old.remove();
      var d = el('div', 'f-err', '⚠️ ' + esc(msg));
      form.insertBefore(d, form.querySelector('.f-actions'));
    }

    /* ================= 本地待提交队列（localStorage + IndexedDB 双存） =================
       所有增删改先写到这里（不立即请求 GitHub API），点「保存更改」后统一写回。
       注意：图片 base64 很容易超过 localStorage 5MB 配额，一旦写入失败会被静默吞掉
       （旧版 try/catch 空捕获）→ 保存按钮恒 disabled →「保存没反应」。v20 起：
       ① >200KB 的 dataUrl 自动外迁 IndexedDB，pending 只留 'blb:' 轻量引用；
       ② 写入失败不再静默，给用户明确告警。 */
    var PENDING_KEY = 'gantt_pending';
    var IDB_NAME = 'gantt-gv-idb', IDB_STORE = 'blobs';
    var BIG_LIMIT = 200 * 1024;
    function idbOpen() {
      return new Promise(function (resolve, reject) {
        if (!G.indexedDB) return reject(new Error('当前环境不支持 IndexedDB'));
        var req = G.indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = function () { try { req.result.createObjectStore(IDB_STORE); } catch (e) {} };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error || new Error('IndexedDB 打开失败')); };
      });
    }
    function idbPut(key, data) {
      return idbOpen().then(function (db) {
        return new Promise(function (resolve, reject) {
          var tx = db.transaction(IDB_STORE, 'readwrite');
          tx.objectStore(IDB_STORE).put(data, key);
          tx.oncomplete = resolve;
          tx.onerror = function () { reject(tx.error); };
        });
      });
    }
    function idbGet(key) {
      return idbOpen().then(function (db) {
        return new Promise(function (resolve, reject) {
          var tx = db.transaction(IDB_STORE, 'readonly');
          var rq = tx.objectStore(IDB_STORE).get(key);
          rq.onsuccess = function () { resolve(rq.result); };
          rq.onerror = function () { reject(rq.error); };
        });
      });
    }
    /* dataUrl 超限 → 外迁 IndexedDB，返回 'blb:*' 轻量引用（异步写库，失败静默降级为原值） */
    function extDataUrl(v, slug) {
      if (v && v.indexOf('data:') === 0 && v.length > BIG_LIMIT) {
        var k = 'blb:' + slug + ':' + Math.random().toString(36).slice(2, 8);
        idbPut(k, v).catch(function () {});
        return k;
      }
      return v;
    }
    /* 深度外迁 pending 中所有超限 dataUrl（不影响原对象，返回新对象） */
    function externalizePending(cur) {
      var next = null;
      function extFrom(src) {
        if (!src || typeof src !== 'object') return;
        src.forEach && src.forEach(function (u) { if (u && u.dataUrl) u.dataUrl = extDataUrl(u.dataUrl, (u.id || 'a') + '-' + (u.name || 'd')); });
      }
      if (cur.events) {
        next = JSON.parse(JSON.stringify(cur));
        ['sampleUrl', 'stepImg', 'tipsImg'].forEach(function (f) {
          Object.keys(next.events).forEach(function (kid) { if (next.events[kid] && next.events[kid][f]) next.events[kid][f] = extDataUrl(next.events[kid][f], f + '-' + kid); });
        });
        Object.keys(next.events).forEach(function (kid) {
          var ats = next.events[kid] && next.events[kid].attachments;
          if (ats) ats.forEach(function (a, i) { if (a && a.url) a.url = extDataUrl(a.url, 'att-' + kid + '-' + i); });
        });
        ['sampleUploads', 'stepImgUploads', 'tipsImgUploads', 'attUploads'].forEach(function (qn) {
          extFrom(next[qn]);
        });
        return next;
      }
      next = {};
      Object.keys(cur).forEach(function (k) { next[k] = cur[k]; });
      /* 无 events 分支（纯 gantt 改动）：仍外迁队列里的超限 dataUrl */
      ['sampleUploads', 'stepImgUploads', 'tipsImgUploads', 'attUploads'].forEach(function (qn) {
        if (next[qn]) next[qn] = next[qn].map(function (u) { if (u && u.dataUrl) return Object.assign({}, u, { dataUrl: extDataUrl(u.dataUrl, (u.id || 'a') + '-' + (u.name || 'd')) }); return u; });
      });
      return next;
    }
    function loadPending() {
      try { return JSON.parse(localStorage.getItem(PENDING_KEY) || 'null'); } catch (e) { return null; }
    }
    function savePending(partial) {
      var cur = loadPending() || {};
      if (partial.ganttCode !== undefined) cur.ganttCode = partial.ganttCode;
      if (partial.events !== undefined) cur.events = partial.events;
      if (partial.desc !== undefined) cur.desc = partial.desc;
      /* delIds：本页**显式**删掉的 id（删任务 / 取消勾选「含详情」）。
         只用累加、只增不减：合并写回要靠它区分「我确实要删」与「本页没加载到」，
         万一某次误删了不该删的，宁可不删（保留）也不要错删。 */
      if (partial.delIds !== undefined && partial.delIds.length) {
        var merged = (cur.delIds || []).slice();
        partial.delIds.forEach(function (id) { if (id && merged.indexOf(id) < 0) merged.push(id); });
        cur.delIds = merged;
      }
      /* v17：待上传示例图队列 */
      if (partial.sampleUploads !== undefined) cur.sampleUploads = partial.sampleUploads || [];
      /* v19：待上传步骤图队列 + 附件队列 */
      if (partial.stepImgUploads !== undefined) cur.stepImgUploads = partial.stepImgUploads || [];
      if (partial.attUploads !== undefined) cur.attUploads = partial.attUploads || [];
      /* v20：待上传备注图队列 */
      if (partial.tipsImgUploads !== undefined) cur.tipsImgUploads = partial.tipsImgUploads || [];
      /* v20：超限 dataUrl 外迁 IndexedDB 后才写 localStorage（防止配额爆掉导致整包丢失） */
      cur = externalizePending(cur);
      try {
        localStorage.setItem(PENDING_KEY, JSON.stringify(cur));
        return true;
      } catch (e) {
        console.error('[gantt] 本地暂存写入失败：', e);
        try { alert('⚠️ 本地暂存写入失败（浏览器存储空间不足）。\n请压缩图片（≤500KB）后重试，或先点「保存更改」把已有改动同步到 GitHub。'); } catch (e2) {}
        return false;
      }
    }
    function clearPending() {
      try { localStorage.removeItem(PENDING_KEY); } catch (e) {}
      /* 顺手清理孤儿 blob（量大时才会开） */
      try {
        idbOpen().then(function (db) {
          var tx = db.transaction(IDB_STORE, 'readwrite');
          tx.objectStore(IDB_STORE).clear();
        }).catch(function () {});
      } catch (e) {}
    }
    /* v20：把 pending 里的 'blb:*' 引用还原为真实 dataUrl（写回/上传前必须还原；原地修改 pending） */
    function hydratePending(p) {
      if (!p) return Promise.resolve(p);
      var keys = [];
      function scan(v) { if (typeof v === 'string' && v.indexOf('blb:') === 0 && keys.indexOf(v) < 0) keys.push(v); }
      if (p.events) {
        Object.keys(p.events).forEach(function (kid) {
          var e = p.events[kid]; if (!e) return;
          scan(e.sampleUrl); scan(e.stepImg); scan(e.tipsImg);
          (e.attachments || []).forEach(function (a) { scan(a && a.url); });
        });
      }
      ['sampleUploads', 'stepImgUploads', 'tipsImgUploads', 'attUploads'].forEach(function (qn) {
        (p[qn] || []).forEach(function (u) { scan(u && u.dataUrl); });
      });
      if (!keys.length) return Promise.resolve(p);
      return Promise.all(keys.map(function (k) { return idbGet(k).then(function (d) { return { k: k, d: d }; }); })).then(function (pairs) {
        var map = {};
        pairs.forEach(function (x) { if (x.d) map[x.k] = x.d; });
        function fill(v) { return (typeof v === 'string' && map[v]) ? map[v] : v; }
        if (p.events) Object.keys(p.events).forEach(function (kid) {
          var e = p.events[kid]; if (!e) return;
          e.sampleUrl = fill(e.sampleUrl); e.stepImg = fill(e.stepImg); e.tipsImg = fill(e.tipsImg);
          (e.attachments || []).forEach(function (a) { if (a) a.url = fill(a.url); });
        });
        ['sampleUploads', 'stepImgUploads', 'tipsImgUploads', 'attUploads'].forEach(function (qn) {
          (p[qn] || []).forEach(function (u) { if (u) u.dataUrl = fill(u.dataUrl); });
        });
        return p;
      });
    }
    function hasPending() {
      var p = loadPending();
      return !!(p && (p.ganttCode || p.events ||
        (p.sampleUploads && p.sampleUploads.length) ||
        (p.stepImgUploads && p.stepImgUploads.length) ||
        (p.attUploads && p.attUploads.length) ||
        (p.tipsImgUploads && p.tipsImgUploads.length)));
    }
    /* 保存按钮状态：有未提交改动 → 绿色高亮「💾 保存更改」；无 → 灰「✅ 已同步」 */
    function syncSaveBtn() {
      var btn = toolbar.querySelector('[data-act="save"]');
      if (!btn) return;
      if (hasPending()) {
        btn.textContent = '💾 保存更改';
        btn.style.background = '#dcfce7'; btn.style.borderColor = '#86efac'; btn.style.color = '#15803d';
        btn.disabled = false;
        btn.title = '将本地所有改动一次性写回 GitHub（全班刷新即见）';
      } else {
        btn.textContent = '✅ 已同步';
        btn.style.background = ''; btn.style.borderColor = ''; btn.style.color = '';
        btn.disabled = true;
        btn.title = '当前无未保存的改动';
      }
    }
    /* 统一提交：读 pending → 先上传新资源（示例图/步骤图/附件）→
       再写回 gantt.md / events.js（带 sha 防覆盖，冲突自动重试）→ 清空并刷新。
       opts.silent=true 供每 3 分钟自动同步调用（失败不弹窗，只写状态条）。返回 Promise。 */
    function saveAll(opts) {
      opts = opts || {};
      var pending = loadPending();
      if (!pending || (!pending.ganttCode && !pending.events &&
        !(pending.sampleUploads && pending.sampleUploads.length) &&
        !(pending.stepImgUploads && pending.stepImgUploads.length) &&
        !(pending.tipsImgUploads && pending.tipsImgUploads.length) &&
        !(pending.attUploads && pending.attUploads.length))) {
        syncSaveBtn(); return Promise.resolve();
      }
      var saveBtn = toolbar.querySelector('[data-act="save"]');
      if (saveBtn) { saveBtn.disabled = true; if (!opts.silent) saveBtn.textContent = '保存中…'; }
      var msg = 'sync: ' + (pending.desc || 'batch update');

      /* v20：写回前先把 pending 里外迁到 IndexedDB 的 'blb:*' 引用还原为真实 dataUrl */
      return hydratePending(pending).then(function (hp) {
        pending = hp;
        return doSaveAll(opts, pending, saveBtn, msg, hydratePending);
      });
    }
    /* 实际执行保存（saveAll 的异步主体，方便 hydrate 后串联） */
    function doSaveAll(opts, pending, saveBtn, msg, hydrateFn) {

      /* 本次写回时因「本页没有」而按原文保留的远端条目 id（合并写回的产物，仅用于事后告知） */
      var mergedKeep = [];

      /* 先上传四类待传资源（每项仅传一次），返回 { sample:{id:url}, step:{id:url}, tips:{id:url}, att:[{id,name,url}] } */
      function uploadAll() {
        var sampleUps = (pending.sampleUploads || []).filter(function (u) { return u && u.id && u.dataUrl; });
        var stepUps = (pending.stepImgUploads || []).filter(function (u) { return u && u.id && u.dataUrl; });
        var tipsUps = (pending.tipsImgUploads || []).filter(function (u) { return u && u.id && u.dataUrl; });
        var attUps = (pending.attUploads || []).filter(function (u) { return u && u.id && u.name && u.dataUrl; });
        if (!sampleUps.length && !stepUps.length && !tipsUps.length && !attUps.length) return Promise.resolve({});
        var jobs = [];
        sampleUps.forEach(function (u) {
          jobs.push(Admin.putImage(u.id, u.dataUrl, msg).then(function (url) { return { kind: 'sample', id: u.id, url: url }; }));
        });
        stepUps.forEach(function (u) {
          jobs.push(Admin.putImage(u.id, u.dataUrl, msg).then(function (url) { return { kind: 'step', id: u.id, url: url }; }));
        });
        tipsUps.forEach(function (u) {
          jobs.push(Admin.putImage(u.id, u.dataUrl, msg).then(function (url) { return { kind: 'tips', id: u.id, url: url }; }));
        });
        attUps.forEach(function (u) {
          jobs.push(Admin.putAttachment(u.id, u.name, u.dataUrl, msg).then(function (url) { return { kind: 'att', id: u.id, name: u.name, url: url }; }));
        });
        return Promise.all(jobs).then(function (results) {
          var acc = { sample: {}, step: {}, tips: {}, att: [] };
          results.forEach(function (r) {
            if (r.kind === 'sample') acc.sample[r.id] = r.url;
            else if (r.kind === 'step') acc.step[r.id] = r.url;
            else if (r.kind === 'tips') acc.tips[r.id] = r.url;
            else acc.att.push(r);
          });
          return acc;
        });
      }

      /* 带重试的写回：GitHub API 缓存/并发可能返回过期 sha → 409 冲突时重新 getFile 拿最新 sha 再写（最多 3 次） */
      function writeFile(path, buildContent) {
        var attempt = function (retries) {
          return Admin.getFile(path).then(function (f) {
            return Admin.putFile(path, buildContent(f), f.sha, msg);
          }).catch(function (err) {
            var m = String(err && err.message ? err.message : '');
            if (/is at|expected|does not match/i.test(m) && retries > 0) {
              return new Promise(function (resolve) { setTimeout(resolve, 500); }).then(function () {
                return attempt(retries - 1);
              });
            }
            throw err;
          });
        };
        return attempt(3);
      }

      /* 本页显式删掉的 id（doDelete / 取消勾选「含详情」时记账）。
         只有被显式删掉的条目才允许从远端消失，其余一律视为「本页没加载到」而保留 ——
         这条规则是「页面过期也只少写、不删数据」的关键。 */
      function delIds() { return (pending.delIds || []).slice(); }
      /* 从 gantt.md 全文取出第一段 ```mermaid 代码块 */
      function mermaidOf(src) {
        var m = /```mermaid[ \t]*\r?\n([\s\S]*?)\r?\n```/.exec(String(src || ''));
        return m ? m[1] : '';
      }
      function taskIdsOf(code) {
        var mdl = code ? Parser.parse(code) : null;
        return ((mdl && mdl.all) || []).map(function (t) { return t.id; }).filter(Boolean);
      }

      /* 写回前体检（必须在任何写操作之前，避免「gantt.md 已写、events.js 中止」的半成品状态）：
         events.js 已改为**合并写回**（本页没有的远端条目按原文逐字保留），不会丢数据，故不再体检；
         但 gantt.md 是「整块替换」，本页 model 若来自过期页面，写回会把远端新增的任务删掉。
         判定：远端有、本页没有、且不是本次显式删除的 id。 */
      function precheckDrift() {
        if (!pending.ganttCode) return Promise.resolve();
        return Admin.getFile('gantt.md').then(function (f) {
          var local = taskIdsOf(pending.ganttCode);
          var del = delIds();
          var missing = taskIdsOf(mermaidOf(f.content)).filter(function (id) {
            return local.indexOf(id) < 0 && del.indexOf(id) < 0;
          });
          if (!missing.length) return;
          var list = missing.join('、');
          if (opts.silent) {
            throw new Error('页面数据可能过期（远端多出任务 ' + list + '），已跳过本次自动同步以免误删');
          }
          var ok = window.confirm(
            '检测到远端存在、但本页没有的任务：' + list + '\n\n' +
            '继续保存会把它们从甘特图上删掉。\n' +
            '（它们的执行说明不会丢 —— events.js 已改为合并写回，本页没加载到的条目会按原文保留）\n\n' +
            '· 确实要删除 → 点「确定」\n' +
            '· 本页数据过期（打开了很久的旧标签页）→ 点「取消」，' +
            '再按 Ctrl+F5（Mac：⌘+Shift+R）强制刷新后重试');
          if (!ok) throw new Error('已取消保存：页面数据可能过期，请先强制刷新（Ctrl+F5）再重试');
        });
      }

      return precheckDrift().then(function () { return uploadAll(); }).then(function (res) {
        var ops = [];
        var effEvents = pending.events;
        if (res && effEvents) {
          /* 上传直链合并进 events：仅当 events 里还是本地 dataUrl 时才替换（保留已有 raw 直链） */
          effEvents = JSON.parse(JSON.stringify(effEvents));
          Object.keys(res.sample || {}).forEach(function (id) {
            if (effEvents[id] && effEvents[id].sampleUrl && /^data:image\//.test(effEvents[id].sampleUrl)) effEvents[id].sampleUrl = res.sample[id];
          });
          Object.keys(res.step || {}).forEach(function (id) {
            if (effEvents[id] && effEvents[id].stepImg && /^data:image\//.test(effEvents[id].stepImg)) effEvents[id].stepImg = res.step[id];
          });
          Object.keys(res.tips || {}).forEach(function (id) {
            if (effEvents[id] && effEvents[id].tipsImg && /^data:image\//.test(effEvents[id].tipsImg)) effEvents[id].tipsImg = res.tips[id];
          });
          (res.att || []).forEach(function (r) {
            var ev = effEvents[r.id];
            if (!ev) return;
            /* 新增附件以 dataUrl 形式已在 events 里（本地可预览）→ 上传后替换为 raw 直链；若缺失则追加 */
            var atts = ev.attachments || [];
            var idx = -1;
            for (var i = 0; i < atts.length; i++) {
              if (atts[i].name === r.name && /^data:/.test(atts[i].url || '')) { idx = i; break; }
            }
            if (idx >= 0) atts[idx] = { name: r.name, url: r.url };
            else atts.push({ name: r.name, url: r.url });
            ev.attachments = atts;
          });
        }
        if (pending.ganttCode) {
          ops.push(writeFile('gantt.md', function (f) {
            return f.content.replace(/```mermaid\s*\n[\s\S]*?\n```/, '```mermaid\n' + pending.ganttCode + '\n```');
          }));
        }
        if (effEvents) {
          ops.push(writeFile('js/events.js', function (f) {
            /* 合并写回：远端有、本页没有、且不是本次显式删除的条目 → 原文逐字保留。
               页面过期只影响「本次写了多少」，绝不会「删掉什么」——
               2026-09-10 b7 详情（含 where「主校区西操场」）被整份覆盖丢失，就是缺这道护栏。 */
            var keep = Admin.keepBlocks(f.content, effEvents, delIds());
            mergedKeep = Object.keys(keep).sort();
            return Admin.serializeEvents(effEvents, keep);
          }));
        }
        return Promise.all(ops).then(function () {
          return effEvents;
        });
      }).then(function (effEvents) {
        clearPending();
        syncSaveBtn();
        /* 手动保存（非静默）：写回成功后原地重建渲染（不再整页刷新，避免退出全屏）。
           effEvents 为写回后的正式数据（含 sampleUrl 直链）；无 gantt 改动时沿用当前 model 渲染 */
        if (!opts.silent) {
          reloadAfterSave(pending.ganttCode || Admin.serializeGantt(model), effEvents || eventsData);
          if (mergedKeep.length) {
            /* 本页数据比远端旧：已保留远端多出的条目，刷新一次把合并后的最新数据取回来，避免后续编辑基于旧数据 */
            toast('ℹ️ 本页数据较旧：已保留远端新增的 ' + mergedKeep.join('、') + ' 条执行说明（未丢失），正在刷新…');
            setTimeout(function () { location.reload(); }, 1500);
          } else {
            toast('✅ 已保存同步到 GitHub（含 deadlines.json 重建），全班刷新即见。');
          }
        }
      }).catch(function (err) {
        if (saveBtn) saveBtn.disabled = false;
        syncSaveBtn();
        if (!opts.silent) { toast('❌ 保存失败：' + (err && err.message ? err.message : err)); alert('保存失败：' + (err && err.message ? err.message : err)); }
        else console.warn('[gantt] 自动同步失败：', err && err.message ? err.message : err);
      });
    }

    /* 渲染编辑/新增表单到抽屉 */
    function renderForm(opts) {
      /* 抽屉惰性创建：新增/编辑可能比详情更早触发 */
      ensureDrawer();
      var task = opts.task || null;
      var ev = opts.ev || null;
      var isNew = !!opts.isNew;
      var kind = task ? (task.milestone ? 'milestone' : 'normal') : 'normal';
      var secName = task ? ((secOfTask[task.id] && secOfTask[task.id].name) || '') : model.sections[0].name;
      var startStr = task ? fmtYMD(task.start) : fmtYMD(today);
      var endStr = task ? ((task.point || task.milestone) ? '' : fmtYMD(task.end)) : '';
      var startTStr = task ? hmOf(task.startTime) : '';
      var endTStr = task ? hmOf(task.endTime) : '';
      /* 责任班委多选（选项来自 ROLES 表：职务 + 姓名） */
      function ownerBoxes(selected) {
        var roles = eventsData._roles || {};
        var names = Object.keys(roles);
        if (!names.length) return '<span class="f-hint">暂无班委名单</span>';
        return names.map(function (n) {
          var c = selected && selected.indexOf(n) >= 0;
          return '<label class="f-owner"><input type="checkbox" name="owner" value="' + esc(n) + '"' + (c ? ' checked' : '') + '><span>' + esc(roles[n]) + ' ' + esc(n) + '</span></label>';
        }).join('');
      }

      drawer.innerHTML =
        '<div class="grab"></div><button class="gv-close" aria-label="关闭">✕</button>' +
        '<div class="gv-dhead">' + (isNew ? '＋ 新增事件' : '✏️ 编辑「' + esc(task.name) + '」') + '</div>' +
        '<form class="gv-form" id="gv-crudform">' +
        '  <div class="f-row">' +
        '    <div class="f-col" style="flex:0 0 70px"><label>ID<input type="text" value="' + (isNew ? '#' + (model.all.length + 1) : '#' + (seqById[task.id] || '')) + '" disabled readonly style="background:#f1f5f9;color:#64748b;font-weight:600"></label></div>' +
        '    <div class="f-col" style="flex:2 1 260px"><label>待办事项名称<input type="text" name="name" required value="' + esc(task ? task.name : '') + '"></label></div>' +
        '    <div class="f-col"><label>阶段<select name="section">' + sectionOptions(secName) + '</select></label></div>' +
        '  </div>' +
        '  <div class="f-row">' +
        '    <div class="f-col"><label>类型<select name="kind">' +
        '      <option value="normal"' + (kind === 'normal' ? ' selected' : '') + '>事件（有开始→结束的时间范围）</option>' +
        '      <option value="milestone"' + (kind === 'milestone' ? ' selected' : '') + '>时间点（只有单一时刻 ◆）</option>' +
        '    </select></label>' +
        /* 类型只剩「事件 / 时间点」两种。「关键节点紫圈」是历史数据的强调标记（gantt.md 里的 crit），
           不再是可选项；仅当该条原本带这个标记时才给一个开关，避免编辑一次就把标记悄悄丢掉。 */
        (task && task.crit ? '<label class="f-check"><input type="checkbox" name="keepCrit" checked> 保留「关键节点」紫圈标记（历史数据）</label>' : '') +
        '    </div>' +
        '    <div class="f-col"><label>是否已完成<div class="f-radio">' +
        '      <label><input type="radio" name="completed" value="done"' + (task && task.done ? ' checked' : '') + '> 已完成</label>' +
        '      <label><input type="radio" name="completed" value="undone"' + (!task || !task.done ? ' checked' : '') + '> 未完成</label>' +
        '    </div></label></div>' +
        '  </div>' +
        '  <div class="f-row">' +
        '    <div class="f-col"><label>开始日期<input type="date" name="start" required value="' + startStr + '"></label>' +
        '      <label class="f-time">时刻 <span class="f-hint">（可选，24小时制）</span><input type="time" name="startTime" value="' + startTStr + '"><button type="button" class="f-clear" data-clear="startTime" title="清除开始时刻（恢复为不填）">清除</button></label></div>' +
        '    <div class="f-col" id="gv-endcol"><label>结束日期 <span class="f-hint" id="gv-endhint">（留空 = 单日）</span><span class="f-dtrow"><input type="date" name="end" value="' + endStr + '"><button type="button" class="f-clear" data-clear="end" title="清除结束日期（留空 = 单日）">清除</button></span></label>' +
        '      <label class="f-time">时刻 <span class="f-hint">（可选，24小时制）</span><input type="time" name="endTime" value="' + endTStr + '"><button type="button" class="f-clear" data-clear="endTime" title="清除结束时刻（恢复为不填）">清除</button></label></div>' +
        '  </div>' +
        '  <label class="f-check"><input type="checkbox" name="isEvent"' + (ev ? ' checked' : '') + '> 含面向同学的执行说明（详情）</label>' +
        '  <div class="gv-evfields" id="gv-evfields">' +
        '    <div class="ev-title">事件详情</div>' +
        '    <div class="f-row">' +
        '      <div class="f-col"><label>面向对象<input type="text" name="who" value="' + esc(ev ? ev.who : '') + '"></label></div>' +
        '      <div class="f-col"><label>时间要求<input type="text" name="when" value="' + esc(ev ? ev.when : '') + '"></label></div>' +
        '    </div>' +
        '    <div class="f-col"><label>地点 <span class="f-hint">（默认：由负责的班委确定，联系负责的班委同学）</span><input type="text" name="where" value="' + esc(ev ? ev.where : '') + '" placeholder="由负责的班委确定，联系负责的班委同学"></label></div>' +
        '    <div class="f-col"><label>用到的文件材料等 <span class="f-hint">（默认：见于班级通知群；可上传多个附件，全班可下载）</span><input type="text" name="files" value="' + esc(ev && ev.files && ev.files !== '—' ? ev.files : '') + '" placeholder="见于班级通知群">' +
        '      <div class="f-attlist" id="gv-attlist">' + (ev && ev.attachments ? ev.attachments.map(function (a, i) { return '<div class="f-att-row" data-i="' + i + '"><span class="nm">📎 ' + esc(a.name) + '</span><button type="button" class="rm" data-act="rm-att">移除</button></div>'; }).join('') : '') + '</div>' +
        '      <div class="f-att-add"><input type="file" name="attFiles" multiple></div>' +
        '</label></div>' +
        '    <div class="f-col"><label>相关同学执行步骤 <span class="f-hint">（每行一步，可配一张步骤图）</span><textarea name="steps">' + esc(ev && ev.steps ? ev.steps.join('\n') : '') + '</textarea>' +
        '      <div class="f-stepimg"><img id="gv-stepimg-preview" src="' + (ev && ev.stepImg ? esc(ev.stepImg) : '') + '" style="display:' + (ev && ev.stepImg ? 'block' : 'none') + '" alt="步骤图预览"><input type="file" name="stepImgFile" accept="image/png,image/jpeg,image/gif,image/webp"></div>' +
        '</label></div>' +
        '    <div class="f-col"><label>备注 <span class="f-hint">（可配一张图）</span><input type="text" name="tips" value="' + esc(ev ? ev.tips : '') + '">' +
        '      <div class="f-tipsimg"><img id="gv-tipsimg-preview" src="' + (ev && ev.tipsImg ? esc(ev.tipsImg) : '') + '" style="display:' + (ev && ev.tipsImg ? 'block' : 'none') + '" alt="备注图预览"><input type="file" name="tipsImgFile" accept="image/png,image/jpeg,image/gif,image/webp"></div>' +
        '</label></div>' +
        '    <div class="f-col"><label>负责的班委 <span class="f-hint">（多选）</span><div class="f-owners">' + ownerBoxes(ev && ev.owners ? ev.owners.map(function (o) { return o.name; }) : []) + '</div></label></div>' +
        '    <div class="f-col"><label>提交材料参考示例 <span class="f-hint">（可选，上传一张图片，全班可见可下载）</span>' +
        '      <div class="f-sample"><img id="gv-sample-preview" src="' + (ev && ev.sampleUrl ? esc(ev.sampleUrl) : '') + '" style="display:' + (ev && ev.sampleUrl ? 'block' : 'none') + '" alt="预览">' +
        '      <div class="f-sample-actions"><input type="file" name="sampleFile" accept="image/png,image/jpeg,image/gif,image/webp">' +
        (ev && ev.sampleUrl ? '<button type="button" class="f-sample-rm" id="gv-sample-rm">移除示例图</button>' : '') +
        '      </div></div></label></div>' +
        '  </div>' +
        '  <div class="f-actions">' +
        '    <button type="submit" class="gv-tbtn primary" id="gv-crudsave">✓ 暂存更改</button>' +
        '    <button type="button" class="gv-tbtn gv-crudcancel">取消</button>' +
        '  </div>' +
        '</form>';

      drawer.querySelector('.gv-close').addEventListener('click', closeDetail);
      drawer.querySelector('.gv-crudcancel').addEventListener('click', closeDetail);
      drawer.querySelector('#gv-crudform').addEventListener('submit', function (e) {
        e.preventDefault();
        handleSubmit(opts, this);
      });
      var evFields = drawer.querySelector('#gv-evfields');
      var isEventCb = drawer.querySelector('[name=isEvent]');
      function syncEv() { evFields.style.display = isEventCb.checked ? 'block' : 'none'; }
      isEventCb.addEventListener('change', syncEv);
      syncEv();

      /* v27：日期/时刻的「清除」按钮 —— 手机（及桌面）原生日期/时间控件选完后无法置空，
         这里给一条显式出口：清空该字段并派发 change，让联动逻辑（类型联动）立即跟上。 */
      drawer.querySelectorAll('[data-clear]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var target = btn.getAttribute('data-clear');
          var inp = drawer.querySelector('[name="' + target + '"]');
          if (!inp || inp.disabled) return;
          inp.value = '';
          inp.dispatchEvent(new Event('change', { bubbles: true }));
          inp.focus();
        });
      });

      /* v27：类型联动 —— 类型只剩「事件 / 时间点」两种；时间点 = 单一时刻，
         结束日期与结束时刻随之禁用并清空（提交时也强制 end = start、endTime 为空）。 */
      var kindSel = drawer.querySelector('[name=kind]');
      var endDateIn = drawer.querySelector('[name=end]');
      var endTimeIn = drawer.querySelector('[name=endTime]');
      var endCol = drawer.querySelector('#gv-endcol');
      function syncKind() {
        var isPoint = !!kindSel && kindSel.value === 'milestone';
        [endDateIn, endTimeIn].forEach(function (i) {
          if (!i) return;
          i.disabled = isPoint;
          if (isPoint) i.value = '';
        });
        if (endCol) {
          endCol.classList.toggle('f-off', isPoint);
          endCol.querySelectorAll('[data-clear]').forEach(function (b) { b.disabled = isPoint; });
        }
        var hint = drawer.querySelector('#gv-endhint');
        if (hint) {
          hint.textContent = isPoint
            ? '（时间点只有单一时刻，结束时间不可设置）'
            : '（留空 = 单日；跨天请填结束日期）';
        }
      }
      if (kindSel) {
        kindSel.addEventListener('change', syncKind);
        syncKind();
      }

      /* v17：示例图上传预览 + 移除（图片仅暂存本地 pending，随「保存更改」统一上传） */
      var sampleFile = drawer.querySelector('[name=sampleFile]');
      var samplePrev = drawer.querySelector('#gv-sample-preview');
      var sampleRm = drawer.querySelector('#gv-sample-rm');
      window.__sampleDataUrl = (ev && ev.sampleUrl) ? ev.sampleUrl : null;   /* 挂全局供 handleSubmit 读取（表单字段不落盘） */
      if (sampleFile) {
        sampleFile.addEventListener('change', function () {
          var f = sampleFile.files && sampleFile.files[0];
          if (!f) return;
          if (!/^image\/(png|jpeg|gif|webp)$/.test(f.type)) { showFormErr(form, '仅支持 png/jpeg/gif/webp 图片'); sampleFile.value = ''; return; }
          var rd = new FileReader();
          rd.onload = function () {
            window.__sampleDataUrl = rd.result;
            samplePrev.src = rd.result; samplePrev.style.display = 'block';
            if (!sampleRm) {
              sampleRm = document.createElement('button');
              sampleRm.type = 'button'; sampleRm.className = 'f-sample-rm'; sampleRm.textContent = '移除示例图';
              sampleFile.parentNode.appendChild(sampleRm);
              sampleRm.addEventListener('click', function () {
                window.__sampleDataUrl = null; sampleFile.value = '';
                samplePrev.style.display = 'none';
                sampleRm.remove();
              });
            }
          };
          rd.readAsDataURL(f);
        });
      }
      if (sampleRm) {
        sampleRm.addEventListener('click', function () {
          window.__sampleDataUrl = null; sampleFile.value = '';
          samplePrev.style.display = 'none';
          sampleRm.remove();
        });
      }

      /* v19：执行步骤配图上传预览 + 移除（与 v17 示例图同模式，用全局暂存变量） */
      var stepImgFile = drawer.querySelector('[name=stepImgFile]');
      var stepImgPrev = drawer.querySelector('#gv-stepimg-preview');
      window.__stepImgDataUrl = (ev && ev.stepImg) ? ev.stepImg : null;
      var stepRmBtn = null;
      function mkStepRm() {
        if (stepRmBtn) return;
        stepRmBtn = document.createElement('button');
        stepRmBtn.type = 'button'; stepRmBtn.className = 'f-sample-rm'; stepRmBtn.textContent = '移除步骤图';
        stepImgFile.parentNode.appendChild(stepRmBtn);
        stepRmBtn.addEventListener('click', function () {
          window.__stepImgDataUrl = null; stepImgFile.value = '';
          stepImgPrev.style.display = 'none';
          stepRmBtn.remove(); stepRmBtn = null;
        });
      }
      if (stepImgPrev.src && stepImgPrev.style.display !== 'none') mkStepRm();
      if (stepImgFile) {
        stepImgFile.addEventListener('change', function () {
          var f = stepImgFile.files && stepImgFile.files[0];
          if (!f) return;
          if (!/^image\/(png|jpeg|gif|webp)$/.test(f.type)) { showFormErr(form, '步骤图仅支持 png/jpeg/gif/webp 图片'); stepImgFile.value = ''; return; }
          var rd = new FileReader();
          rd.onload = function () {
            window.__stepImgDataUrl = rd.result;
            stepImgPrev.src = rd.result; stepImgPrev.style.display = 'block';
            mkStepRm();
          };
          rd.readAsDataURL(f);
        });
      }

      /* v20：备注配图上传预览 + 移除（与步骤图同模式） */
      var tipsImgFile = drawer.querySelector('[name=tipsImgFile]');
      var tipsImgPrev = drawer.querySelector('#gv-tipsimg-preview');
      window.__tipsImgDataUrl = (ev && ev.tipsImg) ? ev.tipsImg : null;
      var tipsRmBtn = null;
      function mkTipsRm() {
        if (tipsRmBtn) return;
        tipsRmBtn = document.createElement('button');
        tipsRmBtn.type = 'button'; tipsRmBtn.className = 'f-sample-rm'; tipsRmBtn.textContent = '移除备注图';
        tipsImgFile.parentNode.appendChild(tipsRmBtn);
        tipsRmBtn.addEventListener('click', function () {
          window.__tipsImgDataUrl = null; tipsImgFile.value = '';
          tipsImgPrev.style.display = 'none';
          tipsRmBtn.remove(); tipsRmBtn = null;
        });
      }
      if (tipsImgPrev.src && tipsImgPrev.style.display !== 'none') mkTipsRm();
      if (tipsImgFile) {
        tipsImgFile.addEventListener('change', function () {
          var f = tipsImgFile.files && tipsImgFile.files[0];
          if (!f) return;
          if (!/^image\/(png|jpeg|gif|webp)$/.test(f.type)) { showFormErr(form, '备注图仅支持 png/jpeg/gif/webp 图片'); tipsImgFile.value = ''; return; }
          var rd = new FileReader();
          rd.onload = function () {
            window.__tipsImgDataUrl = rd.result;
            tipsImgPrev.src = rd.result; tipsImgPrev.style.display = 'block';
            mkTipsRm();
          };
          rd.readAsDataURL(f);
        });
      }

      /* v19：文件材料附件——多文件选择 → 立即加入待传列表（dataUrl 暂存内存，随保存统一上传） */
      var attList = drawer.querySelector('#gv-attlist');
      var attFilesIn = drawer.querySelector('[name=attFiles]');
      var pendingAtts = [];                    /* [{name, dataUrl}] 新增待传附件（含本表单新增） */
      if (attFilesIn) {
        attFilesIn.addEventListener('change', function () {
          var fl = attFilesIn.files;
          for (var i = 0; i < fl.length; i++) {
            var f = fl[i];
            if (f.size > 3 * 1024 * 1024) { showFormErr(form, '附件「' + f.name + '」超过 3MB，请压缩后重试'); continue; }
            (function (file) {
              var rd = new FileReader();
              rd.onload = function () {
                allAtts.push({ name: file.name, dataUrl: rd.result });
                renderAttList();
              };
              rd.readAsDataURL(file);
            })(f);
          }
          attFilesIn.value = '';
        });
      }
      var allAtts = ((ev && ev.attachments) ? ev.attachments.map(function (a) { return { name: a.name, url: a.url }; }) : []).concat(pendingAtts);
      function renderAttList() {
        if (!attList) return;
        attList.innerHTML = allAtts.map(function (a, idx) {
          return '<div class="f-att-row" data-i="' + idx + '"><span class="nm">📎 ' + esc(a.name) + '</span>' +
            (a.url ? '<a href="' + esc(a.url) + '" target="_blank" rel="noopener" download style="font-size:11.5px">已有</a>' : '') +
            '<button type="button" class="rm" data-act="rm-att">移除</button></div>';
        }).join('');
        attList.querySelectorAll('[data-act=rm-att]').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var idx = +btn.parentNode.getAttribute('data-i');
            allAtts.splice(idx, 1);
            renderAttList();
          });
        });
      }
      renderAttList();

      /* 附件列表暴露给 handleSubmit 读取：表单内新增附件（dataUrl）+ 已有附件（url）合并 */
      var crudForm = drawer.querySelector('#gv-crudform');
      if (crudForm) crudForm._gvAtts = allAtts;

      mask.classList.add('on');
      drawer.classList.add('on');
      document.body.style.overflow = 'hidden';
    }

    function openAddForm() { renderForm({ isNew: true, task: null, ev: null }); }
    function openEditForm(task) { renderForm({ isNew: false, task: task, ev: eventsData[task.id] || null }); }

    function handleSubmit(opts, form) {
      var fd = new FormData(form);
      var name = String(fd.get('name') || '').trim();
      var sectionName = String(fd.get('section') || '');
      var kind = String(fd.get('kind') || 'normal');
      var completed = String(fd.get('completed') || 'undone');
      var startStr = String(fd.get('start') || '');
      var endStr = String(fd.get('end') || '');
      var startTStr = String(fd.get('startTime') || '').trim();
      var endTStr = String(fd.get('endTime') || '').trim();
      var isEvent = !!fd.get('isEvent');
      if (!name) { showFormErr(form, '名称不能为空'); return; }
      /* 类型只有两种：事件（normal）/ 时间点（milestone）。关键节点紫圈是历史数据的强调标记，
         不是类型 —— 只对「原本就带 crit」的条目保留开关，新建条目永不写入 crit。 */
      var milestone = (kind === 'milestone');
      var crit = !!(opts.task && opts.task.crit && fd.get('keepCrit'));
      var start = Admin.parseDate(startStr);
      if (!start) { showFormErr(form, '开始日期无效，请选择有效日期'); return; }
      /* 合并可选时刻（HH:mm，24小时制）到 Date */
      function applyHM(d, hm) {
        var mm = /^(\d{1,2}):(\d{1,2})$/.exec(hm);
        if (!mm) return d;
        var h = +mm[1], mi = +mm[2];
        var nd = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, mi);
        if (isNaN(nd.getTime())) return d;
        return nd;
      }
      if (startTStr) start = applyHM(start, startTStr);
      var end = Admin.parseDate(endStr);
      if (milestone) end = start;
      if (!end) end = start;
      if (!milestone && endTStr) end = applyHM(end, endTStr);
      /* 归一化为 'HH:MM' 或空串；时间点没有结束时刻（提交时强制置空，
         序列化侧会回落到开始时刻，所以已有的 `:milestone, id, 9.10 18:45, 9.10 18:45` 形态不变） */
      var startT = hmOf(startTStr);
      var endT = milestone ? '' : hmOf(endTStr);
      /* 同日且两端无时刻 → 结束归一到开始日期，序列化为 0d */
      if (end && (start.getFullYear() === end.getFullYear() && start.getMonth() === end.getMonth() && start.getDate() === end.getDate())) {
        if (!startT && !endT) end = new Date(start.getFullYear(), start.getMonth(), start.getDate());
      }

      var done = (completed === 'done');
      var active = false;
      var task = opts.task || null;
      var ev = opts.ev || null;
      var isNew = !!opts.isNew;

      var id = task ? task.id : (isEvent ? genId('b') : (milestone ? genId('m') : genId('t')));
      var newTask = { name: name, id: id, start: start, end: end, startTime: startT, endTime: endT, milestone: milestone, crit: crit, done: done, active: active };

      var newModel = {
        title: model.title,
        sections: model.sections.map(function (sec) {
          var tasks = sec.tasks.filter(function (t) { return t.id !== (task ? task.id : null); });
          if (sec.name === sectionName) tasks = tasks.concat([newTask]);
          return { name: sec.name, tasks: tasks };
        })
      };

      var newEvent = null;
      if (isEvent) {
        /* v19：附件 = 既有已上传（url）+ 本次新增（dataUrl 也写入 events，本地可预览；saveAll 上传成功后替换为 raw 直链） */
        var attsIn = [];
        var attsPending = [];
        if (form._gvAtts && form._gvAtts.length) {
          form._gvAtts.forEach(function (a) {
            if (a.url) attsIn.push({ name: a.name, url: a.url });
            else {
              attsPending.push({ name: a.name, dataUrl: a.dataUrl });
              attsIn.push({ name: a.name, url: a.dataUrl });
            }
          });
        }
        var stepImgVal = window.__stepImgDataUrl || (ev ? (ev.stepImg || '') : '');
        var tipsImgVal = window.__tipsImgDataUrl || (ev ? (ev.tipsImg || '') : '');
        newEvent = {
          short: name,
          who: String(fd.get('who') || '').trim(),
          when: String(fd.get('when') || '').trim(),
          where: String(fd.get('where') || '').trim(),
          files: String(fd.get('files') || '').trim(),
          steps: String(fd.get('steps') || '').split('\n').map(function (s) { return s.trim(); }).filter(Boolean),
          stepImg: stepImgVal,
          attachments: attsIn,
          tips: String(fd.get('tips') || '').trim(),
          tipsImg: tipsImgVal,
          sampleUrl: window.__sampleDataUrl || (ev ? (ev.sampleUrl || '') : ''),
          owners: fd.getAll('owner').map(function (n) { return { name: n, role: (eventsData._roles && eventsData._roles[n]) || '' }; })
        };
        window.__sampleDataUrl = null;
        window.__stepImgDataUrl = null;
        window.__tipsImgDataUrl = null;
      }

      var needEvents = false, newEvents = null, delIdsNow = [];
      if (isEvent) { needEvents = true; newEvents = buildEvents(id, newEvent); }
      else if (!isNew && ev) {
        /* 明确取消勾选「含详情」→ 这是一次**显式**删除，要记账，
           否则合并写回会把远端那份详情原样保留回来，用户会以为「取消钩子没生效」 */
        needEvents = true; newEvents = buildEvents(task.id, null); delIdsNow.push(task.id);
      }

      var msg = (isNew ? 'add' : 'update') + ': ' + id + ' ' + name;
      /* v17：若用户本次选了新图片（本地 dataUrl）→ 记录到待上传队列（上传成功后写回 events 时替换为 raw 直链） */
      var pendingPartial = {
        ganttCode: Admin.serializeGantt(newModel),
        events: needEvents ? newEvents : undefined,
        delIds: delIdsNow,
        desc: msg
      };
      var sampleUrlVal = newEvent ? newEvent.sampleUrl : null;
      if (sampleUrlVal && /^data:image\//.test(sampleUrlVal)) {
        var ups = (loadPending() || {}).sampleUploads || [];
        ups = ups.filter(function (u) { return u.id !== id; });
        ups.push({ id: id, dataUrl: sampleUrlVal });
        pendingPartial.sampleUploads = ups;
      }
      /* v19：执行步骤配图 + 附件入队（同一 id 下旧队列先清掉，避免残留） */
      if (newEvent) {
        var stepVal = newEvent.stepImg;
        if (stepVal && /^data:image\//.test(stepVal)) {
          var sups = (loadPending() || {}).stepImgUploads || [];
          sups = sups.filter(function (u) { return u.id !== id; });
          sups.push({ id: id, dataUrl: stepVal });
          pendingPartial.stepImgUploads = sups;
        }
        /* v20：备注配图入队（同步骤图模式） */
        var tipsVal = newEvent.tipsImg;
        if (tipsVal && /^data:image\//.test(tipsVal)) {
          var tups = (loadPending() || {}).tipsImgUploads || [];
          tups = tups.filter(function (u) { return u.id !== id; });
          tups.push({ id: id, dataUrl: tipsVal });
          pendingPartial.tipsImgUploads = tups;
        }
        var attPend = (form._gvAtts && form._gvAtts.length) ? form._gvAtts.filter(function (a) { return a.dataUrl; }).map(function (a) { return { id: id, name: a.name, dataUrl: a.dataUrl }; }) : [];
        if (attPend.length) {
          var aups = (loadPending() || {}).attUploads || [];
          aups = aups.filter(function (u) { return !(u.id === id && attPend.some(function (ap) { return ap.name === u.name; })); });
          aups = aups.concat(attPend);
          pendingPartial.attUploads = aups;
        }
      }
      /* 本地暂存改动（不立即请求 GitHub API），点工具栏「保存更改」/每 3 分钟自动同步时统一写回 */
      savePending(pendingPartial);
      /* 原地重渲染（不整页刷新，避免退出全屏）：用刚暂存的数据重建左列 + 重绘 */
      reloadAfterSave(Admin.serializeGantt(newModel), needEvents ? newEvents : eventsData);
    }

    function confirmDelete(task) {
      var ev = eventsData[task.id] || null;
      drawer.innerHTML =
        '<div class="grab"></div><button class="gv-close">✕</button>' +
        '<div class="gv-dhead">🗑 删除确认</div>' +
        '<div class="gv-confirm">确定删除 <b>「' + esc(task.name) + '」</b> 吗？<br>' +
        (ev ? '该条目含执行说明，将<b>同时删除其执行说明</b>。' : '') +
        '删除会先暂存在本地，点工具栏「保存更改」后统一写回并对全班生效。</div>' +
        '<div class="f-actions"><button class="gv-tbtn gv-delconfirm" style="background:#dc2626;color:#fff;border-color:#dc2626">确认删除</button><button class="gv-tbtn gv-crudcancel">取消</button></div>';
      drawer.querySelector('.gv-close').addEventListener('click', closeDetail);
      drawer.querySelector('.gv-crudcancel').addEventListener('click', closeDetail);
      drawer.querySelector('.gv-delconfirm').addEventListener('click', function () { doDelete(task); });
    }
    function doDelete(task) {
      var ev = eventsData[task.id] || null;
      var newModel = {
        title: model.title,
        sections: model.sections.map(function (sec) {
          return { name: sec.name, tasks: sec.tasks.filter(function (t) { return t.id !== task.id; }) };
        })
      };
      var msg = 'delete: ' + task.id + ' ' + task.name;
      /* 本地暂存删除（不立即请求 GitHub API），点工具栏「保存更改」后统一写回。
         delIds 记账：只有在这里登记过的 id，合并写回时才允许从远端 events.js 消失 */
      savePending({
        ganttCode: Admin.serializeGantt(newModel),
        events: ev ? buildEvents(task.id, null) : undefined,
        delIds: [task.id],
        desc: msg
      });
      /* 原地重渲染（不整页刷新，避免退出全屏） */
      reloadAfterSave(Admin.serializeGantt(newModel), ev ? buildEvents(task.id, null) : eventsData);
    }

    /* 首次定位：今日（今日超出图范围则定位到数据末端） */
    root.classList.toggle('gv-land', isLand);
    var bootCenter = hasTodayInRange ? new Date(today) : (today > maxDate ? new Date(maxDate) : new Date(minDate));
    redraw(bootCenter);
    syncSaveBtn();
    /* 提醒角标 & 弹窗可被后续 data 变化刷新 */
    try { remUpdateBadge(); } catch (e) {}

    /* v17：每 3 分钟自动同步——管理员登录态且本地有未提交改动时，静默写回 GitHub（成功不清空页面，免打扰） */
    var AUTO_SYNC_MS = 3 * 60 * 1000;
    var autoSyncTimer = null;
    function autoSyncTick() {
      var adminNow = (G.GanttAdmin && G.GanttAdmin.isLoggedIn) ? G.GanttAdmin.isLoggedIn() : false;
      if (adminNow && hasPending()) {
        saveAll({ silent: true });
      }
    }
    autoSyncTimer = setInterval(autoSyncTick, AUTO_SYNC_MS);
    /* 页面不可见时暂停，避免后台标签页白白调用 GitHub API；回到可见再补一次 */
    function onVis() { if (!document.hidden) autoSyncTick(); }
    G.document && G.document.addEventListener && G.document.addEventListener('visibilitychange', onVis);

    mount._stopAutoSync = function () { if (autoSyncTimer) { clearInterval(autoSyncTimer); autoSyncTimer = null; } };

    /* v20：刷新/首载即补一次同步——页面加载完成 1.5s 后，若管理员已登录且本地有待提交改动，
       自动触发一次静默写回（解决「刚编辑完就刷新，pending 一直滞留本地」的问题）。 */
    var bootSyncTimer = setTimeout(function () {
      var adminNow = (G.GanttAdmin && G.GanttAdmin.isLoggedIn) ? G.GanttAdmin.isLoggedIn() : false;
      if (adminNow && hasPending()) saveAll({ silent: true });
    }, 1500);

    return {
      destroy: function () {
        if (autoSyncTimer) { clearInterval(autoSyncTimer); autoSyncTimer = null; }
        if (bootSyncTimer) { clearTimeout(bootSyncTimer); bootSyncTimer = null; }
        if (nowTimer) { clearInterval(nowTimer); nowTimer = null; }
        if (mask) { mask.remove(); drawer.remove(); }
        container.removeChild(root);
        container.removeChild(styleEl);
      },
      goToday: function () { toolbar.querySelector('[data-act="today"]').click(); },
      toggleLabels: function () { setLabelsCollapsed(!labelsEl.classList.contains('collapsed')); },
      setViewMode: setViewMode,          /* v5：右上角按钮调用（'normal'/'land'/'auto'） */
      getViewMode: function () { return viewOverride || (isLand ? 'land' : 'normal'); },
      onLand: function (fn) { onLand = fn; } /* v6：整页向右旋转 90° 回调（index.html 挂载） */
    };
  }

  /* 纯函数导出：给 test/unit.js 做回归断言用（不参与页面渲染） */
  return { mount: mount, rangeCN: rangeCN, fmtPt: fmtPt, hmOf: hmOf, captionOf: captionOf, shortCaption: shortCaption,
    alarmHMOf: alarmHMOf, alarmWhenOf: alarmWhenOf, alarmAtOf: alarmAtOf, alarmLeadMin: ALARM_LEAD_MIN,
    alarmLabelOf: alarmLabelOf, alarmLabelSep: ALARM_LABEL_SEP,
    evKeysOf: evKeysOf, evDriftKeys: evDriftKeys };
});
