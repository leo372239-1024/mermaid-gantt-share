-- 读研甘特图 · 本地库表结构
--
-- 设计要点：把「Git 仓库里的文件」原样搬进数据库 —— 路径即主键、内容即正文。
-- 这样前端那套 GitHub Contents API 调用（js/admin.js 的 getFile / putFile / putImage）
-- 可以零改动地平移到本地：服务端只要把同样的 URL 形状映射到这几张表即可。

-- 文本文件：gantt.md（mermaid 时间线）、js/events.js（班务详情 —— 这个项目里「代码即数据」）
CREATE TABLE IF NOT EXISTS files (
  path        text        PRIMARY KEY,
  content     text        NOT NULL,
  sha         text        NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- 二进制资源：samples/*.png（提交材料示例图 / 执行步骤图）、files/*（「用到的文件材料」附件）
CREATE TABLE IF NOT EXISTS assets (
  path        text        PRIMARY KEY,
  mime        text        NOT NULL,
  bytes       bytea       NOT NULL,
  size        integer     NOT NULL,
  sha         text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- 版本历史：每次写入留一份快照。可回滚、可追溯「什么时候改了什么」。
-- 注：只在文本文件上记录（附件体积大，且基本是只增不改）。
CREATE TABLE IF NOT EXISTS revisions (
  id          bigserial   PRIMARY KEY,
  path        text        NOT NULL,
  content     text,
  sha         text        NOT NULL,
  message     text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS revisions_path_time ON revisions (path, created_at DESC);

-- 杂项设置（当前只用来记库的初始化时间）
CREATE TABLE IF NOT EXISTS settings (
  key   text PRIMARY KEY,
  value text NOT NULL
);
