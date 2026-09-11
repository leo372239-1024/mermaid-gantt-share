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
      tipsImg: "",
      sampleUrl: "https://raw.githubusercontent.com/leo372239-1024/mermaid-gantt-share/main/samples/b1_20260906_210804.png",
      owners: owners(["王富祥"])
    },
    b2: {
      short: "户口迁移证提交",
      who: "已办理户口迁移的同学",
      when: "截止时间：9月9日（以甘特图日期组件设置为准；原通知表述为「9月10日前」）",
      where: "",
      files: "",
      steps: [],
      stepImg: "",
      attachments: [],
      tips: "",
      tipsImg: "",
      sampleUrl: "",
      owners: owners(["左依晗","张骏齐"])
    },
    b3: {
      short: "校外住宿登记承诺书(纸质版）提交",
      who: "",
      when: "",
      where: "",
      files: "",
      steps: [],
      stepImg: "",
      attachments: [],
      tips: "",
      tipsImg: "",
      sampleUrl: "",
      owners: owners(["肖康乐"])
    },
    b4: {
      short: "“北京交通大学研究生学生登记表”(电子版+纸质)提交",
      who: "全体新生",
      when: "",
      where: "",
      files: "",
      steps: [],
      stepImg: "",
      attachments: [],
      tips: "",
      tipsImg: "",
      sampleUrl: "",
      owners: owners(["覃丽嘉"])
    },
    b5: {
      short: "提交《放弃困难认定声明书》（纸质版）",
      who: "",
      when: "",
      where: "",
      files: "",
      steps: [],
      stepImg: "",
      attachments: [],
      tips: "",
      tipsImg: "",
      sampleUrl: "",
      owners: owners(["周英"])
    },
    b6: {
      short: "交学费",
      who: "",
      when: "",
      where: "",
      files: "",
      steps: [],
      stepImg: "",
      attachments: [],
      tips: "",
      tipsImg: "",
      sampleUrl: "",
      owners: owners([])
    },
    b7: {
      short: "交大人节”文艺晚会",
      who: "",
      when: "已报名的同学请于18：35前就坐。",
      where: "主校区西操场",
      files: "凭票与一卡通入场，票号将作为现场抽奖凭证。",
      steps: [],
      stepImg: "",
      attachments: [],
      tips: "",
      tipsImg: "",
      sampleUrl: "",
      owners: owners([])
    },
    b8: {
      short: "就业分享会",
      who: "",
      when: "",
      where: "九教东201",
      files: "",
      steps: [],
      stepImg: "",
      attachments: [],
      tips: "",
      tipsImg: "",
      sampleUrl: "",
      owners: owners([])
    },
    k1: {
      short: "数据科学与知识工程(周二第1节)",
      who: "选修本课程的同学（课程号 M510028B，课序号 02）",
      when: "每周二 第1节 08:00-09:50；教学周 第9-16周（首次 11.03，末次 12.22）",
      where: "海淀西校区 · 逸夫教学楼 YF305",
      files: "任课教师：沈孟如",
      steps: [],
      stepImg: "",
      attachments: [],
      tips: "教学周第1周自 9.7（周一）起算；法定节假日停课/调课以研究生院通知为准。",
      tipsImg: "",
      sampleUrl: "",
      owners: owners([])
    },
    k2: {
      short: "数据科学与知识工程(周三第6节)",
      who: "选修本课程的同学（课程号 M510028B，课序号 02）",
      when: "每周三 第6节 19:00-20:50；教学周 第9-16周（首次 11.04，末次 12.23）",
      where: "海淀西校区 · 逸夫教学楼 YF305",
      files: "任课教师：沈孟如",
      steps: [],
      stepImg: "",
      attachments: [],
      tips: "教学周第1周自 9.7（周一）起算；法定节假日停课/调课以研究生院通知为准。",
      tipsImg: "",
      sampleUrl: "",
      owners: owners([])
    },
    k3: {
      short: "网络计算与边缘智能(周四第1节)",
      who: "选修本课程的同学（课程号 M510029B，课序号 02）",
      when: "每周四 第1节 08:00-09:50；教学周 第1-16周（首次 09.10，末次 12.24）",
      where: "海淀西校区 · 思源楼 SY309",
      files: "任课教师：高博",
      steps: [],
      stepImg: "",
      attachments: [],
      tips: "教学周第1周自 9.7（周一）起算；法定节假日停课/调课以研究生院通知为准。",
      tipsImg: "",
      sampleUrl: "",
      owners: owners([])
    },
    k4: {
      short: "学术写作能力(周五第1节)",
      who: "选修本课程的同学（课程号 C410001B，课序号 01）",
      when: "每周五 第1节 08:00-09:50；教学周 第1-8周（首次 09.11，末次 10.30）",
      where: "海淀东校区 · 东区一教 DQ505",
      files: "任课教师：刘海明",
      steps: [],
      stepImg: "",
      attachments: [],
      tips: "教学周第1周自 9.7（周一）起算；法定节假日停课/调课以研究生院通知为准。",
      tipsImg: "",
      sampleUrl: "",
      owners: owners([])
    },
    k5: {
      short: "专业英语(周四第2节)",
      who: "选修本课程的同学（课程号 C410003B，课序号 01）",
      when: "每周四 第2节 10:10-12:00；教学周 第1-16周（首次 09.10，末次 12.24）",
      where: "海淀西校区 · 逸夫教学楼 YF411",
      files: "任课教师：马雨萱",
      steps: [],
      stepImg: "",
      attachments: [],
      tips: "教学周第1周自 9.7（周一）起算；法定节假日停课/调课以研究生院通知为准。",
      tipsImg: "",
      sampleUrl: "",
      owners: owners([])
    },
    k6: {
      short: "自然辩证法(周一第4-5节)",
      who: "选修本课程的同学（课程号 A209007B，课序号 08）",
      when: "每周一 第4节 14:10-16:00、第5节 16:20-18:10（连堂）；教学周 第8-13周（首次 10.26，末次 11.30）",
      where: "海淀西校区 · 思源楼 SY108",
      files: "任课教师：赵绪涛",
      steps: [],
      stepImg: "",
      attachments: [],
      tips: "教学周第1周自 9.7（周一）起算；法定节假日停课/调课以研究生院通知为准。",
      tipsImg: "",
      sampleUrl: "",
      owners: owners([])
    },
    k7: {
      short: "新时代中国特色社会主义理论与实践(周五第4-5节)",
      who: "选修本课程的同学（课程号 A209006B，课序号 10）",
      when: "每周五 第4节 14:10-16:00、第5节 16:20-18:10（连堂）；教学周 第1-12周（首次 09.11，末次 11.27）",
      where: "海淀西校区 · 逸夫教学楼 YF406",
      files: "任课教师：张瑞霖",
      steps: [],
      stepImg: "",
      attachments: [],
      tips: "教学周第1周自 9.7（周一）起算；法定节假日停课/调课以研究生院通知为准。",
      tipsImg: "",
      sampleUrl: "",
      owners: owners([])
    },
    k8: {
      short: "数值分析I(周三第5节)",
      who: "选修本课程的同学（课程号 C308102B，课序号 05）",
      when: "每周三 第5节 16:20-18:10；教学周 第1-16周（首次 09.09，末次 12.23）",
      where: "海淀西校区 · 思源楼 SY108",
      files: "任课教师：孟祥云",
      steps: [],
      stepImg: "",
      attachments: [],
      tips: "教学周第1周自 9.7（周一）起算；法定节假日停课/调课以研究生院通知为准。",
      tipsImg: "",
      sampleUrl: "",
      owners: owners([])
    },
    k9: {
      short: "基于欧拉操作系统的内核分析(周二第6-7节)",
      who: "选修本课程的同学（课程号 M510003B，课序号 01）",
      when: "每周二 第6节 19:00-20:50、第7节 21:00-21:50（连堂）；教学周 第1-8周（首次 09.08，末次 10.27）",
      where: "海淀东校区 · 东区一教 DQ505",
      files: "任课教师：张健",
      steps: [],
      stepImg: "",
      attachments: [],
      tips: "教学周第1周自 9.7（周一）起算；法定节假日停课/调课以研究生院通知为准。",
      tipsImg: "",
      sampleUrl: "",
      owners: owners([])
    },
    k10: {
      short: "基于欧拉操作系统的内核分析(周一第6节)",
      who: "选修本课程的同学（课程号 M510003B，课序号 01）",
      when: "每周一 第6节 19:00-20:50；教学周 第9-11周（首次 11.02，末次 11.16）",
      where: "海淀东校区 · 东区一教 DQ505",
      files: "任课教师：张健",
      steps: [],
      stepImg: "",
      attachments: [],
      tips: "课表原文：周一第6节为第09-11周，同一天第7节为第09-10周（原文如此，未作改动）。",
      tipsImg: "",
      sampleUrl: "",
      owners: owners([])
    },
    k11: {
      short: "基于欧拉操作系统的内核分析(周一第7节)",
      who: "选修本课程的同学（课程号 M510003B，课序号 01）",
      when: "每周一 第7节 21:00-21:50；教学周 第9-10周（首次 11.02，末次 11.09）",
      where: "海淀东校区 · 东区一教 DQ505",
      files: "任课教师：张健",
      steps: [],
      stepImg: "",
      attachments: [],
      tips: "课表原文：周一第7节为第09-10周，同一天第6节为第09-11周（原文如此，未作改动）。",
      tipsImg: "",
      sampleUrl: "",
      owners: owners([])
    },
    k12: {
      short: "知识产权法(在线课程,周四第7节)",
      who: "选修本课程的同学（课程号 A230005B，课序号 01）",
      when: "每周四 第7节 21:00-21:50；教学周 第3-13周（首次 09.24，末次 12.03）",
      where: "线上 · 雨课堂平台（第3-13周）",
      files: "任课教师：外聘教师",
      steps: [],
      stepImg: "",
      attachments: [],
      tips: "课表备注：专:3-13周雨课堂平台线上上课。",
      tipsImg: "",
      sampleUrl: "",
      owners: owners([])
    },
    _roles: ROLES
  };
});
