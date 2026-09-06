/*
 * events.js —— 班务事件结构化详情（面向同学，数据来源：班务附件「表二 · 班群通知表」2026-09-03）
 *
 * key 与 gantt.md 中任务 id（b1..b9）一一对应。页面点击任务条/任务名后，
 * 会弹出本文件中对应 id 的结构化信息卡。
 *
 * 维护提示：班级事务有变化时，更新对应 id 的字段即可，无需改渲染代码。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BJTU_EVENTS = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* 表零：班委名单（用于「负责班委」字段展示职务） */
  var ROLES = {
    "覃丽嘉": "党支书",
    "周英": "团支书",
    "王富祥": "班长",
    "郑宇煊": "安全委员",
    "左依晗": "组织委员",
    "张骏齐": "文体委员",
    "肖康乐": "心理委员",
    "王韵琪": "宣传委员"
  };

  function owners(names) {
    return names.map(function (n) {
      return { name: n, role: ROLES[n] || '' };
    });
  }

  return {
    _roles: ROLES
  };
});
