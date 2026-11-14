# Framino — OpenFilm 架构审计

> 本文件在修改任何代码之前完成。审计对象为 `openfilm/openfilm` 的 `e07ae4c`
> （2026-11-13，v0.3.2）源码，对应 Fork `aircrushin/Framino` 的 `feature/framino-transformation` 分支起点。
> 审计方式：只读遍历仓库 + 实读关键源码；不含推测。

---

## 0. 审计结论摘要

| 项 | 结论 |
| --- | --- |
| 项目性质 | pnpm 9 monorepo，TypeScript + 少量 JS（`.mjs`），**零后端数据库**，纯 local-first |
| 核心资产 | `film.html` —— 既是项目文件，也是剪辑本身；磁盘上的**唯一真相源** |
| Studio | React 19 + Vite 7 + Tailwind 4，单页应用，**自研路由**；构建产物由本地 Node HTTP 服务提供 |
| CLI | `openfilm` 单入口，`bin/openfilm.mjs`；Skills 通过 CLI stdout 把手册喂给 coding agent |
| Agent 协作 | Studio 与 Agent 直接读写同一个 `film.html`；服务端有 CAS 写、三方合并、`/api/kept` 协商通道 |
| 改造自由度 | **主要在 `studio/ui/`、`docs/`、文案与图标资源**；格式/序列化/CLI/API/存储 key 是硬契约 |
| 既有 UI 完成度 | 已具备专业工作台骨架（顶栏 / 预览 / Inspector / 时间线 / 素材抽屉 / 导出中心 / 可拖拽分隔条 / 响应式），**不需要重写布局** |
| 本次策略 | 以重设 Design Tokens + 局部皮肤 + 品牌替换为主，保留全部布局计算与编辑算法 |

---

## 1. 原项目架构

### 1.1 Workspace

```
pnpm-workspace.yaml           packages/* + apps/*
package.json                 root，private，packageManager pnpm@9.15.9，engines.node >=22.18
├── packages/openfilm/       发布单元：格式 + CLI + Studio + 素材库（npm 包名 openfilm，v0.3.2）
│   ├── bin/openfilm.mjs     CLI 唯一入口
│   ├── src/*.mjs            35 个运行模块（格式/播放/渲染/CLI 能力）
│   ├── studio/server/       Node HTTP + WebSocket 服务（双 origin 安全模型）
│   ├── studio/ui/           React 编辑器（442 个源码文件，121 个 node:test）
│   ├── manual/              三个核心 Skill（edit / media / canvas）
│   ├── library/             CC0 素材库
│   └── examples-index/      外部 openfilm/examples 仓库的只读镜像
├── packages/shared/         跨包共享类型（@openfilm/shared，private）
├── apps/desktop/            Electron 桌面 App + chat 前端（@openfilm/desktop，private）
├── skills/openfilm/         给 coding agent 安装的入口 Skill
└── docs/                    logo-light.svg / logo-dark.svg / openfilm.webp
```

**关键脚本**（`package.json`）：

| 命令 | 实际动作 |
| --- | --- |
| `pnpm dev` | `node scripts/dev.mjs`，源码版 Studio，端口 **4848**，状态在 `packages/openfilm/.dev/` |
| `pnpm dev:desktop` | Electron dev 风味（`OpenFilm Dev`） |
| `pnpm build` | `build:ui`（Vite 构建 `studio/ui/dist`）+ `build:shell`（桌面窗口页）；**不是全量编译** |
| `pnpm test` | 递归串行 `node --test`，覆盖 src / scripts / studio / server / providers / ui 的纯函数单测 |
| `pnpm typecheck` | `tsc -p studio/server && tsc -p studio/ui` + shared + desktop chat/shell |
| `pnpm audit:public` | 检查 CJK 散文、家目录路径、越界路径、workspace 依赖、secret |
| `pnpm check:pack` | 按 npm 发布方式打包 `openfilm` 并校验 `files` 白名单 |

### 1.2 运行模型（local-first）

- `~/.openfilm/run.json` 保存 `{pid, supervisor, origin, filmOrigin, key}`。
- Studio 服务：**双 origin**。
  - `http://127.0.0.1:<port>`（默认 4747）：编辑器页面 + API，需要 launch key。
  - `http://localhost:<port+1>`：只读影片文件，`/p/<token>/…` 签名访问，注入 `bridge.js` / `stage.js`。
- 只接受 Host 为 `127.0.0.1` / `localhost` / `[::1]` 的请求（防 DNS rebinding）。
- 预览与导出都用 Chromium（playwright-core），首次运行下载 headless Chromium 约 100 MB。
- ffmpeg / ffprobe 必须在 PATH；git 用于项目版本历史。

### 1.3 五层模块地图

1. **格式层** `src/film-doc.mjs` —— 项目文件的读、校验、计算、序列化。唯一真相源。
2. **播放/渲染层** `src/timeline.mjs`（浏览器内播放）、`src/host.mjs`（Host 时钟）、`src/render.mjs`（成片渲染）。
3. **服务层** `studio/server/*` —— 项目读写、媒体服务、导出队列、版本历史、Agent 协商、WebSocket 事件。
4. **编辑器层** `studio/ui/*` —— React 工作台、时间线、Inspector、素材库、预览、导出 UI。
5. **Agent 层** `skills/openfilm/SKILL.md` → `MANUAL.md` → `manual/*/SKILL.md` → `openfilm <command>` CLI。

---

## 2. 核心模块说明（按可改造性分类）

### 2.1 绝对不能修改（底层契约）

| 路径 | 为什么 |
| --- | --- |
| `packages/openfilm/SPEC.md` | 格式协议 0.1，`window.film.frame(t)` / `window.filmHost` 契约 |
| `packages/openfilm/src/film-doc.mjs` | `readFilmFile` / `filmHtml` 的字符级 tokenizer + layout 切片序列化；`FILM_FILE='film.html'`、字段白名单、`toMs` |
| `packages/openfilm/src/timeline.mjs` | 与 film-doc 共用同一份读法的播放实现 |
| `packages/openfilm/src/host.mjs` | `FILM_CLOCK` 把 `Date` / `rAF` / CSS 动画钉在 `t` |
| `packages/openfilm/studio/server/film.mjs` | `rev` = sha256；`changeProjectFilm` 的 CAS `replaceIfStill` + 10 次重试 |
| `packages/openfilm/studio/server/ops.mjs` | `applyOps` 按 **clip id** 应用编辑（Agent 重写文件后下标会漂） |
| `person-edits.mjs` / `person-merge*.mjs` | git 式三方合并，**人的编辑优先**，冲突记下来告知 Agent |
| `studio/server/history*.mjs` | `.film/history` 独立 git 仓库；trailer `Openfilm-Version:` 是旧版本读取依据 |
| `packages/openfilm/package.json` 的 `name` / `bin.openfilm` / `exports` / `files` / 钩子 | CLI 名、导出路径、npm 发布内容 |
| `packages/openfilm/bin/openfilm.mjs` | 子命令名与参数；`asRun()` 依赖 |
| `packages/openfilm/MANUAL.md` / `manual/*/SKILL.md` / `skills/openfilm/SKILL.md` | coding agent 的指令集，含大量 `openfilm …` 命令字面量 |
| `studio/client.mjs` | `health()` 校验 `product === 'openfilm-studio'`；`run.json` 字段；`keptNote()` |
| `studio/server/server.mjs` | 全部 `/api/` 路由、WS 路径、cookie 名、`product` 标识、409/422 语义 |
| `src/render.mjs` / `studio/server/exports.mjs` | 导出参数名、`kinds`、`VideoAsk`、`ExportJob.status/phase` |
| `LICENSE`（3 份）、`TRADEMARK.md`（2 份）、`THIRD_PARTY_NOTICES.md`（2 份）、`library/LICENSE.md` | MIT 全文 + `Copyright (c) 2026 OpenFilm contributors`；商标政策；第三方声明 |

### 2.2 可直接复用（保留逻辑，可换皮肤）

| 路径 | 职责 |
| --- | --- |
| `studio/ui/src/App.tsx` | 自研路由（`location.pathname` + `history.pushState` + `popstate`），无 router 库 |
| `studio/ui/src/components/ProjectView.tsx` (5160 行) | **工作台组装与状态中枢**：顶栏、viewer 行、Inspector、时间线、浮层、快捷键、响应式 |
| `studio/ui/src/components/Timeline.tsx` (5092 行) | 时间刻度、播放头、轨道、clip block、缩放、选择、命令 ref |
| `studio/ui/src/components/useBlockDrag.ts` + `lib/timeline-{drag,edit}.ts` + `lib/clip-speed.ts` | 拖动 / 裁剪 / ripple / 变速 / 吸附 / 跨轨道 / 链接组，`onCommit(ops, label)` 契约 |
| `studio/ui/src/lib/keymap*.ts` / `timeline-keys.ts` | 三套快捷键方案（openfilm / premiere / fcp）+ 自定义槽 |
| `studio/ui/src/components/PaneDivider.tsx` | 真实可拖拽分隔条 + `usePaneSize` 持久化 + 键盘 ±16/48px |
| `studio/ui/src/editor/{Preview,player,use-film,undo,steps,preview-frames}.*` | iframe 双帧热切换、Web Audio 播放时钟、乐观编辑 + undo/redo 栈 |
| `studio/ui/src/components/{FilmInspector,InspectorWorkspace,inspector-fields,inspector-look,PropertiesSection,TextInspector,CaptionInspector,ResourceInspector}.*` | 属性分组与「先绘制、后提交」的数值写回 |
| `studio/ui/src/components/{MediaPool,LibraryDrawer,WorkspaceLibraryPane}.*` + `lib/{library,asset-timeline,media-*,thumb-*}.*` | 素材分类、缩略图、搜索、拖放到时间线 |
| `studio/ui/src/components/export/*` + `lib/export-*.*` | 8 类导出目标、真实进度、取消 |
| `studio/ui/src/components/{ViewerBar,ViewerZoom,LiveTime,AudioMeters,FilmFullscreenBar}.*` | 播放控制、时间码、缩放、电平表 |
| `studio/ui/src/components/{ProjectHistoryControls,OperationHistory,ProjectTitle,AppMenu,ProjectTabs,ExportTray}.*` | 版本历史、会话步骤、项目名、菜单、导出托盘 |

### 2.3 需要品牌化（用户可见层）

- `studio/ui/index.html`：`<title>`、内联 data-URI favicon、`aria-label` / `<title>`。
- `studio/ui/src/components/BrandLogo.tsx`、桌面 `chat/src/components/BrandLogo.tsx`：内联 SVG mark。
- `studio/ui/src/components/BrandLoadingScreen.tsx`：加载屏。
- `studio/ui/src/i18n/{en,zh-CN,ja,ko,es}.ts`：每语言约 60 处产品名词条**值**（约 300 处）。
- `apps/desktop/chat/src/i18n/locales/{en-US,zh-CN,ja,ko,es}.ts`：7 个 key × 5 语言。
- `studio/ui/src/lib/whats-new.ts`：5 语言更新日志。
- 硬编码：`SettingsModal.tsx`、`OpenFilmAgentDialog.tsx`、`ShortcutsSection.tsx`、`TextStyleSample.tsx`、`font-menu.ts`。
- `apps/desktop/src/flavor.mjs` 的 4 个 `PRODUCT_NAME`、`scripts/release.mjs` 的 `NAME`、`apps/desktop/package.json` 的 `productName`。
- `docs/logo-{light,dark}.svg`（字标是**路径轮廓**，无法文本替换，需重做）。
- `README.md` / `README.zh-CN.md` / 各包 README / `CONTRIBUTING.md` / `MANUAL.md` 等产品描述段落。

### 2.4 需要重新设计 UI（视觉层，最高杠杆点）

| 路径 | 说明 |
| --- | --- |
| `studio/ui/src/globals.css` (709 行) | **整个设计系统的唯一入口**：`:root` / `[data-theme='dark']` 两套 token、`.tl-*` 时间线皮肤、`.stage*` 画布、canvas 子系统 `--cv-*`、滚动条、焦点环、动画 |
| 10 个 `*.module.css` | 局部皮肤（AppMenu / InspectorWorkspace / ProjectTabs / WorkspaceEditor / WorkspaceLibraryPane / …） |
| `dock-pane-bar.ts` 的 `PANE_BAR/PANE_BTN/PANE_TITLE` | 面板标题条常量 |
| `inspector-fields.tsx` 的 `FIELD/INPUT/HEAD_BTN` | 输入控件皮肤常量 |
| `Timeline.tsx` 的 `KIND_COLOR` / `TL` / `laneTone()` / `SelectFrame` | 轨道与 clip 的视觉常量（**不是算法**） |

### 2.5 已知限制（原项目自己声明）

- Node ≥22.2（npm）/ ≥22.18（源码）；pnpm 9.15.9；ffmpeg + ffprobe；git；首次下载 Chromium ≈100 MB。
- 预览必须 Chromium 系；ProRes / 无硬解 HEVC 需 `seekable.mjs` 生成代理副本。
- 生成配音/音乐/图片/视频需在 Settings 配自己的 API key；库语义搜索 / 本地模型首次需联网下载模型。
- `film.html` 严格白名单：多余属性、`transition`、`position/transform/margin`、`<script>` 都报错；时间精度只到毫秒。
- **无 Save 按钮**：编辑即写磁盘（`useFilm` 乐观应用 + 串行 POST），版本保存是手动 git 版本。
- **导出无 Retry**：失败/取消后只能重新排队（选项由 localStorage 记住）。
- **Studio 浏览器版不渲染 chat 面板**：真实 Agent 对话在 `apps/desktop/chat/`，Studio 只通过 `studioHost.panel` 预留 inset。
- UI 层**没有组件渲染测试 / E2E**：121 个测试全是 `node:test` 纯函数单测。
- Windows 注意：文件占用 EPERM 重试、ffmpeg shim 需 `taskkill /T /F`、Hyper-V 保留端口需换端口。

---

## 3. 关键组件及文件路径

### 3.1 Studio 前端入口

| 文件 | 作用 |
| --- | --- |
| `packages/openfilm/studio/ui/index.html` | 单页 HTML；首屏前同步脚本读 `localStorage['openfilm.theme']` 写 `data-theme`（防闪白） |
| `packages/openfilm/studio/ui/vite.config.ts` | `root=__dirname`，`react()` + `tailwind()`，`@` → `./src`，`outDir=dist` |
| `packages/openfilm/studio/ui/src/main.tsx` | `createRoot` → `<StrictMode><FocusNav /><App /></StrictMode>`；先 `applyStudioHost()` |
| `packages/openfilm/studio/ui/src/App.tsx` | 路由决策：`/projects/<id>` → `ProjectView`；无 id → `Launcher` / `ProjectsPopover` / `BrandLoadingScreen` |
| `packages/openfilm/studio/ui/src/api.ts` | 全部 `/api/` 端点与 SSE 事件订阅（**与服务端契约，不改**） |

### 3.2 工作台主 JSX（`ProjectView.tsx:4543–5095`）

| 区域 | 行 | 内容 |
| --- | --- | --- |
| `data-titlebar` | 4548–4600 | `ProjectTitle`、`AppMenu`、`ProjectTabs`、`ProjectLayoutMenu`、`ProjectHistoryButton`、导出按钮、`ExportTray`、模式切换 |
| `viewerRowRef` | 4606 | 左 `LayersPanel`（`data-workspace-layers`）、中 `data-viewer-pane`（`SourcePreview` + `Preview` + `ViewerZoom` + `ViewerBar`）、右 `data-workspace-inspector` |
| Inspector 内容 | 4853–4915 | `ResourceInspector` / `CaptionInspector` / `FilmInspector` 三选一 |
| `data-workspace-timeline` | 4923–4995 | `<Timeline>` + `AudioMeters` |
| `data-workspace-canvas` | 5002–5016 | `@xyflow/react` 节点画布（另一模式） |
| 浮层 | 5021–5093 | `ProjectHistoryControls`、`ProjectsPopover`、`SettingsModal`、`WorkspaceLibraryPane`（含 `LibraryDrawer`）、`WorkspaceEditor`、`ExportCenter`、`Toast` |

尺寸常量：`DOCK_GAP=1`、`GRAB=14`、`MIN_INSPECTOR=280`、`MIN_VIEWER=280`、`DEFAULT_INSPECTOR=360`、`TIMELINE_H=200`、`TIMELINE_SHARE=0.45`、`MIN_STAGE_H=220`；`ResizeObserver` + `rowNarrow = rowWidth < 880` 自动收起 Inspector；Tailwind 4 容器查询 `@xs/@lg/@xl`。

### 3.3 CLI / 服务端入口

| 文件 | 作用 |
| --- | --- |
| `packages/openfilm/bin/openfilm.mjs` | `open / look / render / get / canvas / skills / skill / update / doctor`，退出码 0/1/2 |
| `packages/openfilm/studio/server/main.mjs` | supervisor + worker 双进程，`~/.openfilm/run.json` |
| `packages/openfilm/studio/server/server.mjs` | `startStudio()`，路由表 `:206` 起、项目级路由 `:699` 起、WS `:1238–1265` |
| `packages/openfilm/studio/server/exports.mjs` | 导出队列 → `render-worker.mjs` → `src/render.mjs` |
| `packages/openfilm/studio/client.mjs` | CLI 发现/启动 Studio、`keptNote()`、`agentName()` |

---

## 4. 项目数据结构

### 4.1 磁盘布局

```
<project>/
  film.html              剪辑本身（唯一真相源）
  *.html / scenes/*.html  页面（每个暴露 window.film.frame(t)）
  assets/                 视频 / 图片 / 声音
  .film/                  工具目录（历史 git 仓库、缓存、opened 标记）— Agent 不得动
  .git/                   用户自己的（可选）
```

### 4.2 `film.html` 结构（`SPEC.md` §1）

- `<head>`：影片自己的样式，**无 `<script>`**。`<meta name="viewport" content="width=…, height=…">` 定义舞台，缺省 1920×1080。
- `<body>`：每个 `<section>` 一条轨道，**第一个在最上层**；可带 `hidden / muted / locked`。同轨 clip 不重叠。
- clip 元素：`<iframe>`（页面）、`<video>`、`<img>`（静帧）、`<audio>`（声音），内容必须为空。

| 属性 | 含义 |
| --- | --- |
| `src` | 相对 `film.html` 的路径（`assets/a.mp4`、`scenes/title.html`），可带 `#t=in,out` 媒体片段 |
| `at` | 在影片中的起始秒（默认 0） |
| `speed` | 0.1–100；影片时长 = `(out−in)/speed` |
| `volume` | 线性增益 |
| `size` | 页面的 `1920x1080` |
| `id` | 全片唯一，缺省用文件名 |
| `style` | **只允许** `left / top / width / height / rotate` 参与放置；`position/transform/margin/transition` 报错 |
| `overrides` | **Studio 里人的修改**，JSON 数组；带 `at`（CSS 选择器）作用于页面 clip，字段 `n/t/s/r/style/text/lock`；不带 `at` 的最多一条，为 clip 的 `fade:[in,out]` |
| `<track kind="captions|subtitles" src="…vtt">` | WebVTT 字幕，时间在影片时间轴上 |

所有时间四舍五入到**毫秒**（`toMs`，逐值独立取整）。

### 4.3 页面契约（`SPEC.md` §2–§4）

```js
window.film = {
  frame(t) { /* 画出 t 秒的完整画面 */ },  // 可返回 Promise
  duration: 12,                            // 可选，自身秒数
  ready: loadEverything(),                 // 可选 Promise
  width: 480, height: 320,                 // 可选，页面自身尺寸
  frameReadsOverrides: true,               // 可选
};
```

**唯一规则**：同一 `t` 永远画出同一画面。Host 会乱序、并行、取分数帧（运动模糊）请求帧。`window.filmHost`（`{version:'0.1', name}`）存在时页面禁止自走时钟。

### 4.4 序列化 / 反序列化

全部在 `src/film-doc.mjs`，**无第三方依赖、纯 JS**：

- 反序列化：`markup(text)` 字符级 tokenizer 把 HTML 切成 `open/close/text/comment/doctype`，每项带字符偏移；`clipOfTag()` 解析属性、`declarations()` 手写分号分割解析 style、`fragmentSeconds()` 解析 `#t=`、`keyframeBlocks()` 手写花括号配平解析 `@keyframes`；`readFilm()` 做严格白名单校验。
- 序列化：`filmHtml(value, before)` **基于 `layout` 原文位置切片拼接** —— 未变化的 clip 直接 `old.text.slice(start, end)` 原样保留，变化的才用 `clipTag(clip)` 重写，head 用 `edits[]` 从后往前局部替换。注释、换行、未改动原文全部保留。
- `filmHead(text)` 让播放器判断「只有轨道变了就原地改，head 变了才重载页面」。

> **对 Framino 的约束**：不得改变字段名、时间线结构、媒体引用规则、序列化机制。扩展必须向后兼容并在 `film-doc.mjs` + `SPEC.md` 同步。

---

## 5. Agent 与 Studio 的交互方式

### 5.1 三层 Skill

```
skills/openfilm/SKILL.md        → "Run npx -y openfilm@latest and follow the manual it prints"
packages/openfilm/MANUAL.md     → 一页手册（CLI stdout 打印，asRun() 替换运行时命令前缀）
manual/{edit,media,canvas}/SKILL.md → 三个核心技能正文 + openfilm.json（多语言标题/说明）
```

调用链：

```
coding agent
  ├─ npx -y openfilm@latest          → 打印 MANUAL.md
  ├─ openfilm skill edit|media|canvas → 读技能（本地文件）
  ├─ openfilm open <folder>           → studio/client.mjs → POST /api/open → Studio 打开项目
  ├─ openfilm look / render           → 本地校验 / 渲染（与导出同一份混音和时钟）
  └─ openfilm get / canvas / skills   → Studio API → 文件落进 assets/ 或画布 → fs.watch → WS → Studio 即时可见
```

### 5.2 同一份项目数据（关键）

- Studio 与 Agent **都直接读写磁盘上的 `film.html`**，没有数据库、没有中间表示层。
- Studio 写：`changeProjectFilm()` 串行队列 → `settle()` → `filmHtml(…, current.text)` → **CAS `replaceIfStill()`**（文件仍是读时文本才写，否则重放，10 次后 409 `conflict`）。
- Agent 整文件覆盖写：`watch.mjs` fs.watch（120ms 聚合）→ `settle()` 要求 `STABLE_MS=150` 内同一字节读两次一致 → `person-edits.mergeFilmWrite()` 做 **git 式三方合并**：只有 Writer 改的归 Writer，只有 Person 改的保留，双方同处冲突时 **Person 优先**；合并前后文本存进 `.film/history`（`agent.html` / `merged.html`）。
- 告知链路：`noteFor(root, agent)` → `GET /api/kept` → CLI 每条命令前 `keptNotice()` 打到 stderr → `POST /api/kept/said` 回执。
- 页面级冲突：`page-text.mjs` 的 `rev`（sha1）/`expect`，不匹配返回 409 `"was changed since (by the agent, or in another window)"`。
- `agentIn()` 在 Agent 工作期间禁止重命名/删除项目（409 `agent-running`）。

> 这已经满足「Agent 修改后 Studio 能看到更新 / Studio 修改后 Agent 能读最新状态 / 不允许覆盖未保存修改 / 冲突提示与恢复」的要求，**Framino 不需要另造一套数据层**。

### 5.3 Agent 面板现状

- `studio/ui` **不渲染 chat 面板**；真实聊天 UI 在 `apps/desktop/chat/`（90+ 文件）。
- Studio 只通过 `studioHost.panel` / `useHostPanel()` 预留 inset 与 `setOpen/setWidth`，`SettingsModal` 的 Agents 页仅在桌面宿主存在时出现。
- 桌面 chat 通过 `openfilm/studio-ui/*` 导入复用 Studio 的组件与全局变量。
- **结论**：浏览器版 Studio 的 Agent 侧边面板需要新增 UI 入口；第一阶段应明确标注「浏览器 Studio 未接入 Agent 对话，真实对话由桌面端 / 用户自己的 coding agent + CLI 提供」，不得伪造执行结果。

---

## 6. 项目保存与导出流程

### 6.1 保存

```
Inspector / Timeline 编辑
  → commit(ClipEdit[]) → useFilm(editor/use-film.ts)
  → server/ops.mjs applyOps 本地立即应用（乐观）
  → 串行 POST /api/projects/:id/edit
  → film.mjs editProjectFilm(root, base, ops)   [按 clip id]
  → filmHtml() 局部重写 → atomic.mjs 原子写
  → ws 事件 {type:'film', rev} → 页面刷新
```

- **没有 Save 按钮 / dirty 标记**：任何编辑立即落盘。
- 版本保存：`ProjectHistoryButton` → `.film/history` 独立 git 仓库，`save/discard/checkout/restore/copy/delete/recover`。
- 自动版本：Agent turn 开始/结束、文件夹静止 2 分钟（最多 10 分钟）、项目关闭时。
- Undo/Redo 是**会话编辑历史**（`editor/steps.ts` + `undo.ts` 逆操作），⌘Z；与 git 版本历史是两套东西。

### 6.2 导出

| 目标 | 参数 |
| --- | --- |
| `video` | `codec`(h264/hevc/vp9/prores422hq/prores4444/hevc_alpha/png)、`shortEdge` 64–4096、`fps` 1–120、`quality` standard/high/master、`scale`、`sidecar` srt/vtt、`loudness` |
| `alpha` / `gif` / `audio`(wav/m4a/mp3 + stems) / `stills` / `poster` / `subtitles` / `slides`(pptx/pdf) / `nle`(xmeml/fcpxml/剪映) / `project`(zip/folder) | 各有独立选项 |
| 通用 | `range` 或 `ranges`（1–100 段）、`burnSubtitles`、`label`、`name` |

进度链：`render.mjs opts.onProgress` → `render-worker.mjs` IPC → `exports.mjs frames()`（rate/etaMs/progress）→ `server.mjs watchers.emit` → 项目 WS `{type:'export', job}` → `ExportTray` 显示百分比/ETA/速率/字节数。

- **取消**：`cancelExport()` → `AbortController` → kill ffmpeg 树 → `status:'cancelled'`，清理半成品。
- **重试**：底层无 requeue；需重新打开 ExportCenter 排队（选项由 `openfilm.exportCenter.v1` 记住）。
- **失败**：`ExportError` → job `error`；`recordProblem()` 写 `logs/problems.jsonl`，Settings → Developer → Copy report 可导出。
- **不覆盖项目文件**：产物写到 exports 目录，以项目名命名，不覆盖旧文件；项目源与原始素材保持可编辑。

> 这正是 Framino 要求的「导出当前编辑后的项目 / 真实进度 / 真实错误 / 项目源文件保留」。

---

## 7. 现有设计系统

- **Tailwind 4 纯 CSS 配置**，无 `tailwind.config.*`、无 `@theme {}`；组件用 `bg-[var(--bg-panel)]` 之类的任意值消费普通 `:root` 自定义属性。
- 主题：`<html data-theme>`，`:root, [data-theme='light']` 与 `[data-theme='dark']` 两套完整值；**默认 dark**。
- 字体：`@import '@fontsource-variable/inter'`；`--font-sans` = `'Inter Variable', … , var(--font-cjk-sans)`（CJK 栈含 Noto Sans SC / 思源黑体）。
- Token 组：
  - 表面 `--bg-app/titlebar/panel/raised/viewer`、`--dock-line`、`--bg-field/hover/pressed/selected`
  - 文字 `--text/muted/faint`，线 `--border/strong`
  - 主操作 `--primary/hover/on-primary`；强调 `--accent/soft/on-accent/switch-on/bg-picked/text-selection`
  - 状态 `--ok/warn/err`；clip 类 `--clip-video/image/page/text/sticker/filter/effect/audio`
  - 时间线 `--tl-lane/row/gap/lane-on/playhead/select/wave/wave-band/wave-clip`
  - Canvas 独立 `--cv-*`（30 个）+ React Flow `--xy-*`
- 原暗色关键值：`--bg-app:#141414`、`--bg-panel:#181818`、`--bg-raised:#202020`、`--accent:#00c1cd`（青色）、`--tl-playhead:#ffffff`。

---

## 8. UI 改造方案

### 8.1 原则

保留 `ProjectView.tsx` / `Timeline.tsx` 的布局计算与全部交互算法，**只重设 token 与局部皮肤**。这是风险最低、收益最高的路径。

### 8.2 分层实施

| 层 | 动作 | 文件 |
| --- | --- | --- |
| L0 Tokens | 在 `globals.css` 定义 Framino `--studio-*` 一整套品牌/编辑台 token，并把它们映射到既有 `--bg-*` / `--accent` / `--clip-*` / `--tl-*`；暗色值改为深灰黑 + 低饱和轨道色 + Sage 绿强调 | `globals.css` |
| L1 品牌 | 新字标 SVG（小写 `framino`）；替换两个 `BrandLogo.tsx`；新 favicon data URI；`index.html` title；加载屏；5+5 语言 i18n 词条值；桌面 `PRODUCT_NAME` | 见 §2.3 |
| L2 面板皮肤 | 顶栏高度/密度、面板标题条、Inspector 字段、素材库列表、预览监视器背景、时间线 clip/刻度/播放头/选中框 | `globals.css` + `*.module.css` + `dock-pane-bar.ts` + `inspector-fields.tsx` + `Timeline.tsx` 的 `KIND_COLOR` |
| L3 Agent 入口 | 顶栏新增 Agent 按钮 → 侧边面板：项目上下文（真实数据）、任务/变更记录（真实 film 事件）、输入区；未接入时明确标注状态，不伪造结果 | `ProjectView.tsx` 最小注入 + 新组件 |
| L4 状态 | hover / selection / empty / loading / focus 样式统一；`prefers-reduced-motion`、`data-focus-nav` 保留 | `globals.css` |

### 8.3 明确不做

- 不重写时间线、不重写渲染引擎、不改 `film.html` 格式、不改 API/CLI/Skills。
- 不引入云端、登录、多人协作、新依赖、框架升级。
- 不把「不支持的 Inspector 属性」「导出重试」「浏览器版 Agent 对话」伪装成已实现。

---

## 9. 潜在兼容性风险

| 风险 | 等级 | 缓解 |
| --- | --- | --- |
| 改包名 / CLI 名 / `exports` / 目录名 | **致命** | 全部保留；`scripts/check-pack.mjs:24`、`audit-public.mjs:43,55`、`.gitleaks.toml` 硬编码了路径 |
| 改 `openfilm.*` localStorage key、`OPENFILM_*` 环境变量、postMessage source、drag MIME type | **致命** | 全部保留（会丢用户偏好 / 断桌面宿主协议 / 破坏已存项目渲染） |
| 改 `film.html` 字段或 `film-doc.mjs` | **致命** | 完全不动，避免已有项目和 Agent 产物失效 |
| 改 `globals.css` 中 `.tl-blade` 尺寸/hotspot、`data-zoom-layer` / `data-block-*` 选择器 | 高 | 只换颜色与光标配色，保留尺寸与所有 data 属性 |
| 改 `TIMELINE_H` / `RULER_H` / `pxPerMs` 等布局计算 | 高 | 不动；响应式通过 `ResizeObserver` + 容器查询已实现 |
| 改 `openfilm.theme` 主题脚本结构 | 中 | 只改默认色值，保留防闪白脚本 |
| 批量替换 i18n 时误改 key 名或占位符 | 中 | 只替换**词条值**；`i18n-placeholders.test.ts` 会校验 `{n}` 一致性 |
| 直接改 `examples-index/examples.json` | 中 | 这是外部 `openfilm/examples` 的镜像，`examples:sync --check` 会失败；保持原样并在文档说明 |
| 改 `docs/openfilm.webp` 文件名导致 README 引用断 | 低 | 保持文件名或同步改 README |
| 删除 / 改写 `CHANGELOG.md` 历史链接 | 低 | 历史记录原样保留 |
| `tsconfig` 开启 `noUnusedLocals/noUnusedParameters` | 低 | 删 UI 变量易触发类型错误，改后必跑 `pnpm typecheck` |
| 浅色主题被误当成编辑台主色 | 低 | 品牌浅色只用于非编辑工作区；编辑器强制专业深色 |

---

## 10. 改造前基准（Phase 1.3 记录）

| 项 | 值 |
| --- | --- |
| 环境 | Windows / Node v22.22.2 / pnpm 9.15.9（corepack，按 `packageManager` 解析）/ FFmpeg 8.0.1 / Git 2.55.0 |
| Git | `origin=https://github.com/aircrushin/Framino.git`，`upstream=https://github.com/openfilm/openfilm.git`，分支 `feature/framino-transformation` |
| `pnpm install --frozen-lockfile` | 成功；`prepare` 自动产出 `studio/ui/dist/index.html`；`pnpm-lock.yaml` 未改动 |
| `pnpm typecheck` / `pnpm test` / `pnpm build` | 见 `docs/FRAMINO_IMPLEMENTATION_REPORT.md` 的「改造前基准」章节 |

---

*本审计文档随实现推进补充实测结果；所有"绝对不能修改"结论均以实读源码为依据。*
