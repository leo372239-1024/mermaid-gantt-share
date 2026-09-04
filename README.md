# 📊 班级甘特图共享站（Mermaid Gantt）

在电脑上改一份 `gantt.md` → git push → 全班在手机上打开同一个链接，看到最新甘特图。**图中红色竖线 = 今日，位置随"打开当天"自动更新，不需要任何定时任务。**

## 🔗 线上地址（发班级群用）

- **主用链接（GitHub Pages，公开免 token）**：https://leo372239-1024.github.io/mermaid-gantt-share/
- 班级群二维码：`docs/gantt-qr.png`
- ⚠️ EdgeOne Pages 说明：其默认域名受平台合规策略限制（含中国大陆区域的默认域名只能走 3 小时过期的预览链接，对匿名访问返回 401），故主用 GitHub Pages；若后续绑定自有域名，可切回 EdgeOne 做国内加速。

## 一、这套东西怎么工作（30 秒理解）

| 文件 | 作用 |
|---|---|
| `gantt.md` | ⭐ **唯一数据源**：粘贴你的 Mermaid 甘特代码（支持多张图） |
| `index.html` | 手机/电脑访问的渲染页：打开时读取 gantt.md → 前端用 Mermaid 引擎现场渲染 |
| `vendor/mermaid.min.js` | 自托管渲染引擎 v11.17.2（不依赖国外公共 CDN，国内访问稳） |
| `editor.html` | 本地即时预览编辑器（双击打开，左侧改代码右侧实时出图） |

**今日线原理**：Mermaid 的甘特图默认在渲染时刻按「浏览器当前日期」画今日竖线。因此每次有人打开页面，红色竖线就自动走到当天 —— 无需服务器、无需定时任务，永久有效。

## 二、日常更新（3 步，以后每天都这样）

1. 改代码：用 VS Code（装 Mermaid Preview 插件）或直接双击 `editor.html` 本地预览校对；
2. 把最终代码粘贴进 `gantt.md`（替换 ```mermaid 代码块内容），保存；
3. 提交推送：`git add -A && git commit -m "更新甘特图" && git push` —— 等约 1 分钟，线上自动更新。

> 手机也能改：打开 GitHub 仓库网页版直接编辑 `gantt.md` → Commit changes，同样会自动发布。

## 三、首次部署到 EdgeOne Pages（一次性，约 5 分钟）

前置：腾讯云账号 + 实名认证（微信扫码实名即可）。

1. 打开 https://console.cloud.tencent.com/edgeone/pages （控制台 → EdgeOne → Pages）；
2. 创建项目 → 选择「从 Git 仓库导入 / 连接 GitHub」，按引导授权本仓库 `mermaid-gantt-share`；
3. 框架预设选「无 / 静态站点」，构建命令留空，输出目录填 `/`；
4. 点击部署 → 等待 1 分钟 → 获得 `https://xxxx.edgeone.app` 类型链接；
5. 把链接发班级群（可用「草料二维码」cli.im 生成二维码，或把链接发我，我帮你生成二维码图）。

以后每次 push 到 main 分支，EdgeOne 自动重新部署，同学们刷新即是最新版。

## 四、本地预览（不部署也能看效果）

```bash
cd 本目录
python -m http.server 8890
# 浏览器打开 http://localhost:8890/  （渲染页）
# 或打开 http://localhost:8890/editor.html （即时预览编辑器）
```

> 直接双击 `index.html` 也可以看效果 —— 此时因浏览器安全限制读不到 gantt.md，会自动展示内置示例图。

## 五、Mermaid 甘特图语法速查

```mermaid
gantt
    dateFormat YYYY-MM-DD        # 输入日期格式
    axisFormat %m-%d             # 横轴显示格式（月-日）
    todayMarker stroke-width:2.5px,stroke:#ef4444,opacity:0.85   # 今日竖线样式（去掉此行=默认样式；写 todayMarker off 隐藏）
    section 阶段名
        任务A   :done,    a1, 2026-09-01, 3d          # 已完成：done
        任务B   :active,  a2, 2026-09-04, 5d          # 进行中：active
        任务C   :         a3, after a2, 10d           # 未开始，接在 a2 后
        里程碑  :milestone, m1, 2026-10-20, 0d        # 里程碑
```

完整语法见 https://mermaid.js.org/syntax/gantt.html

## 六、常见问题

- **今日线会过期吗？** 不会。每次打开页面按当天重画，永远指向当天。
- **多张图？** 在 gantt.md 里写多个 ```mermaid 代码块，页面依次展示。
- **手机上图太宽？** 页面支持横向滑动/双指拖动；已关闭自动压缩，保证文字清晰。
- **私密性？** 页面为公开 URL。若需仅班内可见，可在渲染页前加一道口令页（需要时再找我加）。
- **EdgeOne 免费额度？** 官方长期免费套餐：静态流量/请求不限量，每月有定额构建次数（改一次代码消耗一次，日常更新绰绰有余）。
