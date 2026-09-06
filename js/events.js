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
    b1: {
      short: "收体检表",
      who: "全体新生，目前未提交同学鉴于备注",
      when: "9月5、6、7日的工作时间，校医院有对应体检项目，均可去",
      where: "校医院",
      files: "",
      steps: ["1阅读附件9，[携带材料体检]请携带贴好条形码的体检指引单(既往病史、现病史填表人签名、确认已经签约并签名)和贴好条型码的化验单去体检","2【检查体检表】查看提交材料参考示例，检查4项体检结果，三个“无”（根据实际情况填写），两个自己签名。","3提交体检表给负责的班委"],
      stepImg: "",
      attachments: [],
      tips: "目前未提交名单：",
      sampleUrl: "https://raw.githubusercontent.com/leo372239-1024/mermaid-gantt-share/main/samples/b1_20260906_210804.png",
      owners: owners(["王富祥"])
    },
    b2: {
      short: "户口迁移证提交",
      who: "已办理户口迁移的同学",
      when: "截止时间9月10日前；",
      where: "",
      files: "",
      steps: [],
      stepImg: "",
      attachments: [],
      tips: "",
      sampleUrl: "",
      owners: owners(["左依晗","张骏齐"])
    },
    _roles: ROLES
  };
});
