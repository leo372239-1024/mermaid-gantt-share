# 📊 班级甘特图共享站（Mermaid Gantt）

在本机跑一套 Docker 服务（PostgreSQL + Node），改完**立即写入数据库、刷新即见**；局域网内的同学用手机打开 `http://<本机IP>:18080` 就能看。**图中红色竖线 = 今日，位置随"打开当天"自动更新，不需要任何定时任务。**

## 🔗 访问地址

- **本机**：http://localhost:18080
- **局域网（手机 / 平板，需连同一 Wi-Fi）**：http://192.168.0.3:18080 ← 本机 WLAN 地址，换网络后可能变化，用 `tools\local-status.cmd` 查当前值
- **旧线上站（已停用，仅作历史存档）**：https://leo372239-1024.github.io/mermaid-gantt-share/
- 班级群二维码：`docs/gantt-qr.png`

> 2026-10-09 起，本项目从「GitHub Pages + Contents API 直写」切换为「**本机 Docker 服务 + PostgreSQL**」。
> 原因：线上每次保存要等 GitHub API 写入 → Actions 重建 deadlines → Pages 重新部署，全链路几十秒到几分钟。
> 现在保存只写本机数据库，**毫秒级生效**。详见下一节。

## ⚡ 本地化部署（Docker + PostgreSQL）

### 架构

```
浏览器（本机 / 局域网手机）
   │  HTTP :18080
   ▼
Node 服务（容器 gantt-app）
   ├─ 静态托管前端          index.html / js/* / fonts / vendor
   ├─ GitHub Contents API 兼容层   /api/gh/repos/:owner/:repo/contents/:path
   ├─ 资源直链              /raw/*
   ├─ deadlines 运行期现算   /deadlines.json、/deadlines.ics
   └─ 口令认证              POST /api/login
   │  TCP :5432（容器网络内）
   ▼
PostgreSQL 16（容器 gantt-db）
   ├─ files         gantt.md、js/events.js（路径即主键）
   ├─ assets        samples/*、files/* 二进制
   └─ revisions     每次写入的版本快照（可回滚）
```

**关键设计**：服务端把 GitHub Contents API 的 **URL 形状与响应字段原样复刻**，所以 `js/admin.js` 只改了三个常量（`API_BASE` / `rawUrl` / `validateToken`），业务逻辑一行未动 —— 迁移风险被压到最低。

### 快速上手

```bash
cd G:\IT_develop\github_projects\mermaid-gantt-share

docker compose up -d --build     # 启动（首次自动建表 + 把磁盘上的 gantt.md / events.js / samples 导入数据库）
docker compose logs -f app       # 看日志
docker compose ps                # 看状态
```

也可直接双击 `tools\local-status.cmd` 看状态。

打开 **http://localhost:18080** 即可。管理员口令见 `.env` 里的 `ADMIN_PASSWORD`。

### 端口（为什么是这两个）

本机 TCP 动态端口池是 **1024–15000**（`netsh int ipv4 show dynamicport tcp` 可查），
所以端口刻意选在 **15001–49151** 之间 —— 既避开系统临时端口，也不会落进 Windows 默认的 49152+ 区间。

| 端口 | 用途 | 暴露范围 |
|---|---|---|
| 18080 | Web 服务 | `0.0.0.0`，局域网可访问 |
| 15432 | PostgreSQL | `127.0.0.1`，仅本机可连 |

改端口：编辑 `.env` 里的 `APP_PORT` / `DB_PORT`，然后 `docker compose up -d`。

### 开机自启动

四层保障，按可靠性排序：

1. **容器 `restart: always`** —— ⭐ **主力**。Docker 引擎每次启动（= 每次开机）都会无条件恢复这两个容器，**包括此前被手动停过的情况**。
   > 这里必须用 `always` 而不是 `unless-stopped`。`unless-stopped` 的语义是「被手动停过的容器，即使守护进程重启也不拉起」——
   > 2026-10-14 00:02 一次手动停止，导致此后 10-14、10-15 两次开机都没能自动启动。这正是本次故障的第一层原因。
2. **计划任务 `MermaidGanttShare-Local`** —— 登录后 +30 秒，以 `cmd.exe /c tools\local-up.cmd` 拉起（**不经 Windows 脚本宿主、不经启动文件夹**）。
   注册一次即可：双击 `tools\install-autostart.cmd`。查看/手动执行：
   ```powershell
   Get-ScheduledTask   -TaskName MermaidGanttShare-Local
   Start-ScheduledTask -TaskName MermaidGanttShare-Local
   ```
3. **Docker Desktop 的「登录时启动」**（本机已开启，`settings-store.json` 里 `AutoStart: true`）。
4. **启动文件夹兜底**：`%APPDATA%\...\Startup\MermaidGanttAutoStart.vbs` —— 登录后静默执行 `tools\local-up.cmd`。
   ⚠️ 这一层**单独不可靠**：实测该脚本在登录后约 3.5 分钟才被触发，且本次开机时整条链路静默失败（未产生任何 `docker` 调用）；
   火绒 HIPS 会把「启动文件夹里的脚本自启」记为 `fp_name_touch_startup_malware`（`file_prot_v6`，risk 3）。仅作冗余。

`tools\local-up.cmd` 每次运行都会把过程追加到 **`logs\autostart.log`**（已 gitignore）——
**自启出问题时先看这个文件**，它会记录工作目录、`docker` 路径、等待引擎的重试次数、`docker compose up -d` 的原始输出与退出码。

换机 / 重装：`tools\install-autostart.cmd` 安装，`tools\uninstall-autostart.cmd` 移除（只移除触发器，不会停正在跑的服务）。

> 2026-10-15 排障结论（供日后参考）：
> ① `restart: unless-stopped` 无法复活「被手动停过」的容器 —— 已改 `always`；
> ② 启动文件夹 VBS 链路在登录 3.5 分钟后才触发，且本次静默失败（火绒日志显示脚本确实被执行，但下游未产生任何 Docker API 调用）；
> ③ 计划任务兜底此前**从未注册过**（`C:\Windows\System32\Tasks\MermaidGanttShare-Local` 不存在），等于第三层保障一直是空的。


### 局域网访问

服务已监听 `0.0.0.0:18080`，但 **Windows 防火墙默认会拦截入站**。以管理员身份运行一次：

```
tools\allow-firewall.cmd
```

之后手机连同一 Wi-Fi，打开 `http://<本机IP>:18080`（当前 WLAN 地址为 `192.168.0.3`）。
**看的人不需要口令**；只有点「保存」写数据时才需要管理员口令。

### 常用运维

| 想做什么 | 命令 |
|---|---|
| 启动 / 重建 | `docker compose up -d --build` |
| 停止（数据保留） | `docker compose down` |
| 停止并**清空数据** | `docker compose down -v` ⚠️ 不可逆 |
| 重启 Web 服务（改过 `server/` 代码后） | `docker compose restart app` |
| 看日志 | `docker compose logs -f app` |
| 进数据库 | `docker exec -it gantt-db psql -U gantt -d gantt` |
| 看某文件的改动历史 | `curl "http://localhost:18080/api/revisions?path=gantt.md&limit=20"` |

### 改前端 vs 改后端

- **改前端**（`index.html`、`js/*`、`fonts/`）：项目目录以**只读卷**挂载进容器，改完**刷新浏览器**即可，不用重启。
- **改后端**（`server/*`）：需要 `docker compose up -d --build` 重建镜像。

### 数据在哪 / 怎么备份

数据全在 Docker named volume **`gantt-pgdata`** 里，容器删了也不丢。

```bash
# 备份
docker exec gantt-db pg_dump -U gantt -d gantt > backup-20261009.sql

# 恢复
docker exec -i gantt-db psql -U gantt -d gantt < backup-20261009.sql
```

### 与 GitHub 的关系

**已彻底解耦**。运行期不再读写 GitHub：

- 读：`/gantt.md`、`/js/events.js` 由服务从数据库返回（磁盘上的同名文件只在首次启动时当种子）；
- 写：全部落 PostgreSQL；
- `deadlines.json` / `deadlines.ics` 改为请求时现算，**不再依赖 GitHub Actions**。

`.github/workflows/update-deadlines.yml` 与仓库里那两个生成物保留着，但不再影响本地服务。

> ⚠️ 由此带来一个行为变化：**直接编辑磁盘上的 `gantt.md` 不会影响页面**（数据库才是唯一数据源）。
> 请通过网页端管理员登录来改，或直接 `psql` 改库。

### 故障排查

| 现象 | 处理 |
|---|---|
| 页面显示「内置示例」告警 | 服务没起来。`docker compose ps` 看状态，`docker compose logs app` 看日志 |
| 开机后服务没自动起来 | 先看 `logs\autostart.log`（启动器全程留痕）；再 `Get-ScheduledTask -TaskName MermaidGanttShare-Local` 确认计划任务在册；最后 `docker inspect gantt-app --format '{{.HostConfig.RestartPolicy.Name}}'` 应为 `always` |
| 保存时报「未登录或登录已过期」 | 令牌有效期 12 小时，重新点「🔒 管理员」输入口令即可 |
| 保存时报「远端内容已更新（sha 不匹配）」 | 这是并发保护生效：数据在你编辑期间被改过，重新打开详情再存一次即可 |
| 手机打不开 | ① 是否同一 Wi-Fi；② 是否跑过 `tools\allow-firewall.cmd`；③ IP 是否变了（`tools\local-status.cmd`） |
| 改了 `.env` 不生效 | 需要 `docker compose up -d` 让容器重建 |

## 一、这套东西怎么工作（30 秒理解）

| 文件 | 作用 |
|---|---|
| `gantt.md` | ⭐ **唯一数据源**：粘贴你的 Mermaid 甘特代码（支持多张图） |
| `index.html` | 手机/电脑访问的渲染页：打开时读取 gantt.md → 自研轻量渲染器现场出图（无外部依赖） |
| `js/parser.js` | Mermaid gantt 语法子集解析器（浏览器+Node 双用） |
| `js/events.js` | 班级事务结构化详情（表二·班群通知表，b1..b9） |
| `js/viewer.js` | 自研交互式 SVG 甘特渲染器：年月切换/回到今天/缩放（桌面 Ctrl+滚轮）/点击看详情/事件错色/智能防重叠标注/逐日交替底色/**分钟级等比事件条**/双条今日红线/手机横屏整页 90° 旋转 |
| `js/ics.js` | iCalendar(.ics) 生成器（网页「加入系统日历」与构建期 `deadlines.ics` 共用，UTC 绝对触发时刻） |
| `vendor/mermaid.min.js` | 自托管渲染引擎 v11.17.2（仅 `editor.html` 本地编辑器使用） |
| `fonts/fonts.css` + `fonts/inter-latin.woff2` | 自托管 Inter（Latin 子集，可变字体 400–700，48KB）。**原先引 Google Fonts，现为纯本地** —— 见下方「为什么零外链」 |
| `editor.html` | 本地即时预览编辑器（双击打开，左侧改代码右侧实时出图） |
| `test/unit.js` | Node 单测（15 节，断言数随数据推导）：解析器 + 数据完整性 + 序列化 round-trip + ics 生成器 + 分钟级时间口径 + 生成物一致性 + 过期快照体检 + **通道 C 闹钟口径（前后端同源校验）** + **编辑表单口径（类型/时间点/时刻清空）** + **合并写回护栏（页面过期不许删远端条目）** + **gantt.md 合并写回 + 新增条目 id 对账**（`node test/unit.js`） |
| `tools/verify-ui.js` | 真实 Chromium 端到端自检（13 节，断言数随数据推导）：**零第三方请求 / 本地字体已加载** / 红线标注左右位 / 分钟级标题 / 逐日斑马纹 / 日期数字居中 / 分钟级等比事件条 / ddl 面板 / Ctrl+S / 通道 C 闹钟清单 / **编辑表单（类型两选、时间点禁用结束时间、时刻可清空）** / **合并写回（用 GitHub API 替身跑一次真实保存，验证过期页面删不掉远端条目）** / **id 撞车对账（过期页面新增时远端同 id 条目不被覆盖）** / 移动端竖横屏 + 出预览截图（开发期工具，需本机 playwright） |
| `tools/build-deadlines.js` | ⭐ 把 `gantt.md` 编译成 `deadlines.json` + `deadlines.ics`（`node tools/build-deadlines.js`） |
| `deadlines.json` | **自动生成，勿手改**：拍平后的待办清单（时间精确到分钟），iPhone 快捷指令直接读取 |
| `deadlines.ics` | **自动生成，勿手改**：可订阅的系统日历源，一次订阅长期生效（含到点/提前两个闹铃） |
| `docs/ios-reminder-setup.md` | iPhone 强提醒配置指南（快捷指令 + 定时自动化，零服务器） |
| `docs/ios-system-alarm-setup.md` | iPhone **系统级闹钟/日历**配置指南（日历订阅、.ics 导入、时钟 App 真闹钟） |

### 本地化新增的文件

| 文件 | 作用 |
|---|---|
| `docker-compose.yml` | 编排 `gantt-db`（PostgreSQL 16）+ `gantt-app`（Node 服务），均 `restart: always`（开机必起，见「开机自启动」） |
| `server/index.js` | 本地服务主入口：静态托管 + Contents API 兼容层 + `/raw` 资源 + deadlines 现算 + 口令认证 |
| `server/db.js` + `server/schema.sql` | PostgreSQL 存储层（`files` / `assets` / `revisions` 三张表）与首次种子导入 |
| `server/gh-api.js` | GitHub Contents API 的本地兼容层（URL 形状与响应字段保持一致） |
| `server/auth.js` | 管理员口令校验 + 无状态令牌签发（HMAC-SHA256，12 小时有效） |
| `server/deadlines.js` | 运行期生成 `deadlines.json` / `.ics`，复用 `tools/build-deadlines.js` 的口径 |
| `.env` | 本地配置：端口 + 口令（**已 gitignore；含口令，勿外传、勿提交**） |
| `tools/local-up.cmd` / `local-down.cmd` / `local-status.cmd` | 一键启动 / 停止 / 查状态（`local-up.cmd` 同时是自启入口，全程写 `logs/autostart.log`） |
| `tools/install-autostart.cmd` / `uninstall-autostart.cmd` | 安装 / 移除开机自启（计划任务为主，启动文件夹 VBS 为冗余） |
| `tools/register-autostart.ps1` / `unregister-autostart.ps1` | 上述自启项的实际注册 / 注销逻辑（任务计划程序，无需管理员） |
| `tools/allow-firewall.cmd` | 放行入站 TCP 18080（需管理员运行），让局域网手机能访问 |
| `tools/local-push.mjs` | 把本地文件整份写回数据库（批量改代码时用） |

**为什么零外链（重要）**：本页此前用 `fonts.googleapis.com` 的样式表引入 Inter，而 `editor.html` 用的 mermaid 也已自托管。但那条字体外链有两个真实问题 —— ① `<link rel="stylesheet">` 是**渲染阻塞**的，取不到就一直白屏；② **中国大陆访问 Google Fonts 会被阻断**，而本页读者正是国内同学。现已把 Inter 的 **Latin 子集**（48KB 可变字体）下载进 `fonts/` 自托管：**整页零第三方请求、可离线打开**，首屏不再被第三方网络拖住。中文正文照旧走系统字体栈（PingFang SC / Microsoft YaHei），不需要也不应该打包 CJK 字库。

**今日线原理**：渲染时按浏览器当前日期绘制两条红色竖线 —— 实线为**当前时刻**（分钟级小数天偏移，页面上每分钟自动移动，标注「现在 HH:mm」置于线**左**侧），虚线为**今日 24:00**（当日右边界，标注置于线**右**侧）。全部本地计算，无服务器、无定时任务。

**坐标口径（分钟级，全链路统一）**：事件条的位置与长度按 `开始日期+开始时刻` → `结束日期+结束时刻` 的**真实比例**落在时间轴上（3 小时的会议就是 1/8 天宽，最小 3px 保可点）。未填时刻时的默认语义：开始 → 当日 00:00；截止 → 当日 23:59（起止同日且只填了开始时刻 → 用开始时刻）。时间点/里程碑是零长度区间：填了时刻精确落在该分钟，未填则取**当日正中**（压在日界线上会分不清属于哪一天）。此口径与 ddl 提醒、`deadlines.json`、`deadlines.ics` 完全一致 —— 改一处必须同步改 `js/viewer.js` 的 `remStartHM/remDueHM` 与 `tools/build-deadlines.js` 的 `startHmOf/dueHmOf`。

## 二、日常更新（本地化后：改完即见）

**方式 A（推荐，网页端）**

1. 打开 http://localhost:18080 → 点右上角「🔒 管理员」输入口令；
2. 点任意 **任务条 / 节点 / 标题 / 左侧名称** 打开详情弹窗；
3. 新增 / 编辑 / 删除 → 弹窗里点「保存」→ **刷新即见**（毫秒级，无需等待）。

**方式 B（批量改代码）**

一次要改很多条时，先在本地把 `gantt.md` / `js/events.js` 改好，再整份写回数据库：

```bash
# 1) 从数据库导出当前内容
curl -s http://localhost:18080/gantt.md > gantt.md
curl -s http://localhost:18080/js/events.js > js/events.js

# 2) 用 VS Code / editor.html 本地编辑 ...

# 3) 写回（口令自动从 .env 读取；会记录一条版本历史）
node tools/local-push.mjs gantt.md --message "批量更新"
node tools/local-push.mjs js/events.js --message "同步班务详情"
```

> ⚠️ 本地化后**不再需要 `git push` 来发布**。Git 只用于代码版本管理，页面数据来自 PostgreSQL。
> 直接编辑磁盘上的 `gantt.md` 不会影响页面 —— 数据库才是唯一数据源。

### 渲染页交互（v2 起，面向同学）

> 预览图（由 `tools/verify-ui.js` 自动生成，可随时重跑刷新）：
> [`docs/preview-desktop.png`](docs/preview-desktop.png)（主图 · 两条今日红线）·
> [`docs/preview-remind.png`](docs/preview-remind.png)（今日截止提醒弹窗 · 分钟级时间 + 系统级通道按钮）

工具栏：
- **＋ 放大 / － 缩小**：以视口中心日期为锚点伸缩时间窗
- **桌面 Ctrl + 滚轮**：直接缩放时间范围（夹紧在数据全跨度内，最长可看到 2026.8.1 – 2028.7.30）
- **‹‹ 上年 / 下年 ››**：年份切换（自动给出约 1 年跨度）
- **‹ 上月 / 下月 ›**：月份切换（自动给约 1.5 月跨度）
- **📍 回到今天**：一键定位到当前日期，红线随打开当天自动更新
- **🔔 提醒**：查看「**截止日期就是今天**」的所有待办（v33 起口径由此前的「距截止不足 24 小时」改为此规则），弹窗**按截止时刻从早到晚排序**；每项前有复选框，勾选后该项变灰、加删除线并折叠到底部（勾选状态自动保存在本机浏览器，刷新不丢失）。按钮右上角红点显示当前待办数量，无待办时不显示。
  弹窗底部四个系统级动作：**📅 加入系统日历**（导出 `.ics`，到点由系统日历闹铃响）、**⏰ 同步系统闹钟**（唤起快捷指令，在「时钟」App 里建真闹钟：**只对「今天开始」的条目**、每条**只建 1 个**闹钟，时间 = 该条**开始时刻前 15 分钟**，标签 = **名称｜地点｜开始→结束时间**；清单会先复制到剪贴板）、**📋 复制清单**、**🔗 订阅地址**。
- **弹窗内点「保存」即实时写入数据库**（v41）：管理员在新增/编辑/删除弹窗里点「保存」，改动**立刻写进本机 PostgreSQL**，无需任何二次操作 —— 不再有「暂存 → 点工具栏同步」两步，全班刷新即见
- **写入失败自动重试**：万一写库失败（服务重启 / 网络抖动），改动会留在本机队列，页面在 **30 秒**内自动重试；工具栏此时才会出现「**⚠️ 重试同步**」按钮，可立即手动重试（正常使用时该按钮不显示）。**Ctrl + S / ⌘ + S** 同效（浏览器默认的「保存网页」被拦截）
- **左侧事件列表**（v33）：不再按「阶段」分区，**平铺**展示全部事件与时间点；**最新修改的条目排在最上面**，条数超出可视高度时列表内**上下滚动**

任务交互：
- 左侧任务名 / 右侧任务条 → 点击弹出底部抽屉，显示该任务的结构化详情
- 带 📌 的任务 = 班级事务（`js/events.js` 来源：班群通知表 2026-09-03）
- ◆ 形节点 = 时间点（单一时刻）
- 点击左侧事件名 → 弹详情 + 自动滚动定位到事件日期 + 闪烁高亮
- 左侧列表每条带 **#序号** 与 **事件 / 时间点** 角标（平铺后仍可一眼区分类型）；新增条目统一归入「新增事项」收纳区（v33 起表单不再要求选择阶段）

渲染特性：
- 时间轴：年份/月份行 + **逐日交替底色**（浅蓝 `#e8f2fd` / 留白，一眼区分相邻日期；`px/天 < 4` 时自动省略，避免退化成摩尔纹）；放大后【每一天】的日期数字显示在**该日区间正中**（原来贴日界线，容易误读成前后一天）
- **事件条按分钟级时段等比定位定长**：`9.10 14:00 → 17:00` 的会议就是 1/8 天宽、起点落在当天 14:00 处；时间点填了时刻就精确落在那一分钟（未填取当日正中）
- **今日两条红线**：实线 = **当前时刻**（分钟级，页面上每分钟自动移动，标注「现在 HH:mm」在线**左**侧），虚线 = **今日 24:00**（当日右边界，标注在线**右**侧）；两条标注同基线，不再错位
- 配色：已完成统一灰；其余事件按序号错色（12 色调色板 × 步长 5，相邻事件不同色），关键节点（crit）叠加紫圈
- 标注：每条呈现「名称(起 至 止)」形态且**精确到分钟**，例如 `文艺汇演领票（9.10 14:00 至 9.10 17:00）`；起止同刻只显示一次（`9.10 18:45`），无时刻的条目保持纯日期（`9.13`）；超长注记自动降级、条内放不下时条尾外置并强制显示；条/点旁标注按"右/左/上/下"四档试位 + 双向碰撞检测防重叠（实测 32 条标题 0 重叠）
- 视图：右上角 **⇄ 横屏视图** 按钮可随时切换 常规视图 ↔ **整页向右旋转 90°**（header + 甘特图 + footer 整体旋转，手机横着看更清晰）；手机横屏时自动切换

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

> **时间精确到时分（24小时制，可选）**：日期后跟 `HH:mm` 即带时刻，
> 例：`带时段的班会 :b, 2026-09-20 14:30, 2026-09-20 17:00`、`单日某个时刻 :c, 2026-09-21 09:00, 0d`。
> 不带时刻的任务仍只写日期。管理员在「编辑」表单里可直接选开始/结束时刻。

> **关于 `section`（v33 起，表单不再要求选阶段）**：`section 阶段名` 仍是 Mermaid 语法的一部分、
> 也仍是 gantt.md 的**数据组织方式**，但**新增/编辑表单里已取消「阶段」下拉**——
> 编辑既有条目时自动沿用其所在阶段，新增条目统一落到末尾的「**新增事项**」收纳区。
> 这样做的原因：阶段是「数据从哪儿来」的组织维度，对「我此刻要办哪件事」没有检索价值，
> 反而让每次新增都多一步无意义的选择。左侧事件列表也因此改为**不分区的平铺**（见第三节）。

> **课程表条目（`section 课程表…`，id `k1…k12`）**：本学期课表按「星期几 + 节次」拆条（连堂的第 4-5 节、
> 第 6-7 节合为一条），条形跨越该时段的上课**周次**。教学周第 1 周周一 = `2026-09-07`，
> 第 N 周周一 = 9.7 + (N−1)×7 天。**课程（v28 起）进入待办提醒链路**
> （`deadlines.json` / `deadlines.ics` / 页面「🔔 提醒」/ 通道 C 闹钟）——每条上课日事件按它真实的
> 「教室 + 起止」建提醒，通道 C 为「今天开始」的课各设一个「时钟」闹钟
> （如 `学术写作能力(...)｜东区DQ505｜9.11 08:00 → 9.11 09:50` 设 07:45）。某天课多，今日闹钟清单就多几行。

### 管理员的编辑表单（三点口径）

| 项 | 规则 |
|---|---|
| **时刻可清空** | 每处「时刻」与「结束日期」右侧都有 **清除** 按钮 —— 原生日期/时间控件在手机上（及桌面上）选完后无法置空，这是唯一的显式出口。清空后该条回落到「未填时刻」语义（开始按 00:00、截止按 23:59 计，图表标注带 `~`）。 |
| **类型只有两种** | 「事件（有开始→结束的时间范围）」与「时间点（只有单一时刻 ◆）」。**「关键节点」不再是类型**；历史数据里的 `crit` 紫圈标记会在编辑该条时以一个默认勾选的复选框出现，取消勾选即移除。 |
| **时间点不设结束时间** | 类型选「时间点」后，结束日期与结束时刻**自动禁用并清空**（时间点就是零长度区间）；切回「事件」即恢复可填。 |
| **保存是「合并写回」** | 写回 `js/events.js` 与 `gantt.md` 前都会先读远端原文：**远端有、本页没有、且不是本次显式删除**的条目，按原文逐字保留；本页新建的条目若与远端已有 id 撞车（页面数据过期时会 —— 新 id 只按本页 model 计算），自动改用两边都没占用的 id。所以「标签页开了很久 → 页面数据过期 → 保存」只会**少写**，绝不会删掉别人的内容，页面还会明确告知保留了哪几条、哪条换了 id。（2026-09-10 曾因整份覆盖丢掉 b7 的详情与 `where`；2026-10-09 又因 id 撞车 + gantt.md 整块替换，静默覆盖掉 m19「团推优会议」——两处现都由回归断言守住。）|

完整语法见 https://mermaid.js.org/syntax/gantt.html

## 六、常见问题

- **今日线会过期吗？** 不会。每次打开页面按当天重画，永远指向当天。
- **多张图？** 在 gantt.md 里写多个 ```mermaid 代码块，页面依次展示。
- **手机上图太宽？** 页面支持横向滑动/双指拖动；已关闭自动压缩，保证文字清晰。
- **私密性？** 页面为公开 URL。若需仅班内可见，可在渲染页前加一道口令页（需要时再找我加）。
- **EdgeOne 免费额度？** 官方长期免费套餐：静态流量/请求不限量，每月有定额构建次数（改一次代码消耗一次，日常更新绰绰有余）。

## 七、iPhone 强提醒 / 系统级闹钟（可选，零服务器）

页面里的「🔔 提醒」只在打开网页时可见。若要让临近截止的待办**主动**提醒你，且强度要达到
「突破静音与专注模式、像闹钟一样响」，有三条零 App、零服务器、零授权的通道：

| 通道 | 强度 | 配置量 | 说明 |
|---|---|---|---|
| **日历订阅 `deadlines.ics`** | 系统日历闹铃 | 一次订阅，长期生效 | **首选**；每条待办带「到点」+「提前 30 分钟」两个闹铃 |
| **网页导出 `.ics`** | 系统日历闹铃 | 点一下按钮 | 临时/单次；UID 固定，重新导入是「更新」不重复 |
| **快捷指令真闹钟** | 时钟 App 闹钟（最强） | 建一次指令 | 网页「⏰ 同步系统闹钟」一键唤起；**只对「今天开始」的条目**、每条**只建 1 个**闹钟，**时间 = 该条开始时刻前 15 分钟**，**标签 = 名称｜地点｜开始→结束时间** |

**为什么不直接发推送**：iOS 的通知分五档，最强的「系统级闹钟」需要原生 App 的 AlarmKit 框架，
「关键警报」需要 Apple 单独审批的 entitlement（个人开发者基本拿不到）。**网页两条路都走不通**，
但系统日历与快捷指令是原生能力，可以绕开推送体系直接拿到同级强度。

**数据流**：

```
gantt.md ──(GitHub Actions 自动编译)──┬─▶ deadlines.json ──▶ iPhone 快捷指令 ──▶ 时钟 App 闹钟
                                     │                    （alarmAt / alarmLabel）
                                     └─▶ deadlines.ics  ──▶ 系统日历订阅   ──▶ 系统日历闹铃
```

- 本地编译：`node tools/build-deadlines.js`（时区按北京时间处理；阈值可用环境变量
  `DEADLINE_WINDOW_DAYS` / `ICS_WINDOW_DAYS` / `DEADLINE_ALARM_LEAD_MIN`（默认 15 分钟）调整）
- 自动编译：`.github/workflows/update-deadlines.yml`，在 `gantt.md` 变更时以及每天 06:00 / 18:00 各跑一次
- 线上地址：
  - `https://leo372239-1024.github.io/mermaid-gantt-share/deadlines.json`
  - `https://leo372239-1024.github.io/mermaid-gantt-share/deadlines.ics`

手把手配置步骤见 **[`docs/ios-system-alarm-setup.md`](docs/ios-system-alarm-setup.md)**（系统级闹钟/日历）
与 **[`docs/ios-reminder-setup.md`](docs/ios-reminder-setup.md)**（快捷指令定时强提醒）。

> 提示：快捷指令无法远程分发给同学，每个人需要各自配置一次；但**日历订阅链接可以直接发群**，
> 同学点开订阅一次即可。如果班级要统一推送，替代方案是 GitHub Actions + Bark（关键警报级推送），
> 但需要每人安装 App 并提交 device key。
