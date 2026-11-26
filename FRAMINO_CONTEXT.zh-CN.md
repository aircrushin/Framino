# Framino — Project Context（中文原文）

> AI Video Production Studio\
> Tagline: Make more. Create freely.
>
> 本文件是产品上下文的中文原文。规范版本是英文的 `FRAMINO_CONTEXT.md`：仓库的公开审计（`scripts/audit-public.mjs`，CI 运行）
> 只允许 `*.zh-CN.md` 与 i18n 文件包含中文正文。两者不一致时以英文版为准；英文版 §13「以代码为准的事实」优先于本文的一切描述。

## 1. 项目是什么

Framino 是一个面向 AI 视频创作者的专业视频生产与编辑工作台。

它不是一个简单的 AI 视频生成网站，也不是传统意义上的视频剪辑软件。

Framino 希望把两种能力结合起来：

1. **AI Agent 负责创作和生产**：理解创意、编写脚本、设计分镜、调用视频模型、生成素材、组织项目。
2. **人类负责审片和精细控制**：通过可视化编辑器调整镜头、时间线、字幕、音频、素材和最终成片。

核心理念：

**让 AI 负责繁重的生产工作，让创作者保留对作品的控制权。**

用户可以使用自己的 Codex、Claude Code 等 Coding Agent 完成视频创作，而 Framino 提供视频生产 API、素材管理、工程组装和专业可视化编辑能力。

最终交付的不应该只有一个 MP4，而应该是一个完整、可继续编辑的视频工程。

---

## 2. 产品定位与目标用户

### 产品定位

AI-native Video Production Studio。

目标是成为 Coding Agent 与视频生成模型之间的生产工作台。

### 目标用户

- 使用 Codex、Claude Code 等工具的 AI 开发者和创作者。
- 独立视频创作者。
- AI 视频生产工作室。
- 需要低成本、批量化生产视频的个人和小团队。
- 希望通过 Agent 自动化视频生产，但仍然需要人工控制最终效果的人。

### 核心价值

- 高性价比的视频生产。
- 自动化程度高，减少重复劳动。
- 不绑定单一 AI Coding Agent。
- 不强迫用户使用昂贵的闭源创作工作流。
- 生成结果可以继续编辑，而不是只能接受 AI 的最终输出。
- 视频生成直接用用户自己连接的服务，Framino 不经手账号和额度。
- 让视频生成、Agent 和专业编辑器形成统一工作流。

### 产品差异化

普通 AI 视频产品通常关注：输入 Prompt → 生成视频 → 下载 MP4。

Framino 希望实现：输入创意 → AI 创作 → 分镜生成 → 视频素材生成 → 素材整理 → 工程组装 → 人工编辑 → 最终导出。

最重要的差异：**AI 生成的是一个可编辑的作品工程，而不只是一个视频文件。**

---

## 3. 核心工作流

### Step 1 — Idea

用户输入视频创意，例如："Create a 30-second cinematic commercial for a specialty coffee brand."

Agent 需要理解：视频主题、目标受众、视频时长、视频比例、视频风格、发布平台、语言、预算或生成限制。

### Step 2 — Script

Agent 自动生成脚本，包括：Hook、场景安排、旁白、对白、字幕、结尾、镜头节奏。

### Step 3 — Storyboard

Agent 将脚本转化为结构化分镜。每个 Shot 应包含：

- shot_id
- scene_id
- duration
- visual_description
- camera_movement
- camera_angle
- lighting
- composition
- generation_prompt
- reference_assets
- voiceover
- subtitle
- aspect_ratio

分镜是后续视频生成和工程组装的基础。

### Step 4 — Generation

Agent 通过项目自带的 `openfilm get video` 调用视频模型（服务由用户在 Studio 里连接）。基本要求：

- 每个镜头一次调用，异步等待结果。
- 支持失败重试。
- 支持单镜头重新生成。
- 不重复生成已经成功的镜头。
- 保留每个镜头的生成参数和任务记录。

用户的 Codex / Claude Code 订阅主要承担创作推理成本。视频生成由用户在 Studio 里连接的服务直接计费，Framino 不转售、不代扣。

### Step 5 — Asset Pipeline

生成完成后，系统下载并整理：Video、Image、Audio、Voiceover、Subtitle。

同时提取：Duration、Resolution、Frame rate、Codec、Audio metadata、Thumbnail。

所有素材应当有稳定的 asset_id，并且在工程中可以被准确引用。不完整或损坏的素材不能进入正式工程。

### Step 6 — Project Assembly

将所有镜头和素材组装成 Framino 可以打开的可编辑项目。核心要求：

- 保留每个镜头的独立视频文件。
- 保留独立音轨。
- 保留字幕。
- 保留时间线和镜头顺序。
- 保留素材元数据。
- 支持镜头独立替换和调整。
- 支持重新打开项目。
- 支持继续编辑和导出。

必须以当前 OpenFilm 实际项目 Schema 为准，不要自行猜测项目文件格式。

### Step 7 — Studio Review

用户在 Framino Studio 中检查和修改：视频镜头、时间线、素材、字幕、音频、镜头时长、镜头顺序、画面参数。

### Step 8 — Export

最终输出：MP4 成片、完整可编辑项目、原始视频素材、音频素材、图片素材、字幕和相关元数据。

---

## 4. 当前技术架构

Framino 目前基于 OpenFilm 开源项目进行 Fork 和二次开发。OpenFilm 提供原有的视频项目结构、编辑器、时间线和渲染能力。Framino 在其基础上构建 AI 视频生产能力。

### A. Framino Studio

用户使用的可视化视频编辑器。主要负责：Project Workspace、Media Library、Video Preview、Timeline、Inspector、Subtitle Editing、Audio Editing、Export。

要求保留 OpenFilm 原有核心编辑和渲染能力，不要为了视觉改造破坏原有引擎。

### B. Video Agent Skill

为用户自己的 Coding Agent 提供视频创作工作流。需要支持 Codex 和 Claude Code。主要负责：

- Idea → Script
- Script → Storyboard
- Storyboard → Generation
- 调用 `openfilm get video`
- 轮询任务
- 整理生成结果
- 创建 Production Manifest
- 调用 Project Adapter
- 输出可以在 Framino Studio 中打开的项目

Skill 负责创作编排，不应该重复实现视频生成或 Project Adapter。需要根据 Codex 和 Claude Code 的实际 Skill 规范分别适配，不要假设两者完全相同。

### C. Video Generation

视频生成完全使用项目自带的 `openfilm get video`。用户在 Studio 的 Settings → Services 里连接一个服务（自己的 key、OpenFilm 账号，或本地模型），Agent 调用 CLI。

**不做 Framino Gateway，不做 Framino 账号，不做 Framino Credits**（2026-11-14 决定）。Framino 只加一本账：调用前先把任务写进 manifest；上次留下的 running 任务按磁盘上的文件判定，不盲目重发；每次重试都是新的 take 和新文件名，不覆盖、不重复付费。

细节见 `docs/FRAMINO_VIDEO_GENERATION.md`。

### D. Media Asset Pipeline

负责：下载素材、验证素材、提取元数据、生成缩略图、整理文件、处理重试、处理文件冲突、管理素材引用。

素材管线不负责编辑器 UI，也不负责修改 OpenFilm 的时间线序列化逻辑。

### E. Project Adapter

负责把中间项目格式转换为 OpenFilm 实际支持的工程格式。建议采用独立的 Production Manifest 作为中间数据结构。

但必须先检查当前仓库的真实 Schema、序列化方式、项目示例和时间线结构。不要凭空设计一个与 OpenFilm 不兼容的项目格式。

---

## 5. 核心数据和接口约定

不同模块需要共享一致的数据标识：project_id、scene_id、shot_id、asset_id、task_id。

基本原则：

1. shot_id 在整个生产过程中保持稳定。
2. 每个生成任务关联对应的 shot_id。
3. 每个生成素材拥有独立 asset_id。
4. 一个 shot 可以有多个生成版本。
5. 重新生成某个镜头不应该影响其他镜头。
6. 已成功的任务不能因为工作流重启而重复生成。
7. 中间结果需要持久化，支持中断恢复。

Production Manifest 应当描述：项目信息、视频配置、场景、镜头、素材、音频、字幕、时间线、生成任务记录。

具体 Schema 以 `docs/FRAMINO_INTEGRATION_CONTRACT.md` 为准。

---

## 6. 品牌和视觉设计规范

品牌名称：Framino。品牌关键词：Professional、Efficient、Creative、Affordable、Minimal、Creator-focused。Tagline：Make more. Create freely.

### 品牌色系

- Sage Green: #64836D
- Forest Green: #34483A
- Soft Mint: #DCE9DD
- Warm Cream: #F5F7F1
- White: #FFFFFF

### 编辑器设计方向

Framino Studio 采用 Professional Dark Editorial Studio 风格。参考：DaVinci Resolve、Adobe Premiere Pro、Final Cut Pro、Linear。

编辑器基础颜色：Background #181A19、Panel #202321、Elevated #282C29、Border #353A36、Primary Text #E5E8E4、Secondary Text #A0A7A1、Muted Text #707A72、Accent #8BA58E、Active Accent #A5BFA6、Selection #344B39。

Timeline 轨道颜色：Video #557D69、Audio #9B835C、Text #718BA5、Image #8B79A2。

### UI 设计原则

- 专业视频编辑器，而不是 AI SaaS Dashboard。
- 高信息密度。
- 精确、克制、清晰的交互。
- 合理利用空间。
- 保持统一的 Design Tokens。
- 面板之间要有明确的层级。
- 时间线需要有专业工具的操作感。

### 禁止的设计倾向

过度圆角卡片；大量渐变；玻璃拟态；AI 星星装饰；大面积发光效果；过度留白；典型的 AI SaaS Dashboard 视觉；为了好看而牺牲专业编辑器的操作效率。

---

## 7. 当前开发进度

### 已完成：第一阶段 — 品牌化与 Studio UI 改造

1. Design System：CSS Variables、Design Tokens、基础控件。
2. Brand Identity：OpenFilm 用户可见品牌替换为 Framino，包括 Logo、Favicon、Metadata 等。
3. Studio Workspace：Toolbar、主布局、Media、Preview、Inspector、Timeline Panel。
4. Media Library & Preview：素材库、缩略图、素材选择、预览。
5. Inspector & Timeline：属性面板与时间线视觉改造。

注意：以上表示 UI 改造已经完成，不意味着所有 AI 生产能力已经实现。

### 已完成开发：第二阶段 — 完整 AI 视频生产链路

- **Agent 1 — Project Adapter**：研究 OpenFilm Schema；创建 Production Manifest；实现工程转换；验证打开、编辑、保存、重开、导出。
- **Agent 2 — Video Agent Skill**：实现 Codex / Claude Code 视频创作 Skill；完成 Idea、Script、Storyboard、Generation、Assembly 工作流。
- **Agent 3 — Video Generation**：打通自带的 `openfilm get video` 路径；任务账本；中断后按磁盘恢复，不重复付费。
- **Agent 4 — Media Asset Pipeline**：下载、验证、整理素材；生成缩略图和媒体元数据。
- **Agent 5 — Production Workflow & E2E**：统一接口契约；集成各个模块；实现端到端测试；构建完整 Demo。

五个模块需要遵守统一的 Integration Contract，不能各自发明一套数据结构。

建议集成顺序：1. 统一 Integration Contract；2. 并行开发生成账本、Asset Pipeline、Project Adapter；3. 集成 Skill；4. 完成 E2E；5. 验证 Studio 的完整编辑和导出流程。

五个模块的代码已全部完成，两轮端到端测试均为绿灯：

- **2026-11-25 — MiniMax H3 真实闭环（12/12 步真实通过）**：三段真实的 `provider:minimax` / `MiniMax-H3` 片段加两段合成音频，跑通了创意 → brief、脚本与分镜审批、通过 `openfilm get video` 真实生成、真实中断恢复（已落盘的任务不重复提交）、单镜头重新生成（其他 take 字节不变）、素材校验（含拒绝损坏的 `.mp4`）、装配到不动点、`openfilm look`、Studio 打开/编辑/重开零控制台错误、重装配逐字节保留人工编辑、ffprobe 校验 MP4 导出。驱动：`packages/framino-production/test/e2e-minimax.mjs`。
- **2026-11-21 — 离线（9/12 步真实通过）**：同样链路，但全部用 ffmpeg 测试素材（`origin: agent-code`，标记 `data-framino-test="true"`）；第 4–6 步当时因未连接服务被阻塞，现已由上面的真实运行覆盖。驱动：`packages/framino-production/test/e2e-offline.mjs`。

详见 `docs/FRAMINO_E2E_TEST_REPORT.md`。第二阶段代码已完成，剩下的不是写代码：由用户确认并产出一条约 30 秒、1920×1080 的真实模型广告片（当前 Demo 是 6 秒测试图案），以及分别用 Codex 和 Claude Code 跑一遍 `skills/framino-production/SKILL.md` 并留存记录。

---

## 8. MVP 验证目标

当前目标是尽快验证核心价值：**用户能否通过自己的 Coding Agent，以较低成本自动生产一个完整的视频工程，并在 Framino 中继续编辑和导出？**

MVP 至少要完成：

1. 用户输入一个视频创意。
2. Agent 自动生成脚本。
3. Agent 自动生成分镜。
4. 用户确认脚本和分镜。
5. Agent 调用真实视频生成 API。
6. 自动下载并整理视频素材。
7. 自动组装为 Framino 可打开的项目。
8. 用户打开 Studio。
9. 用户能够修改镜头、字幕和音频。
10. 用户能够保存项目并导出 MP4。

建议 Demo：**Coffee Brand Commercial**。时长约 30 秒；镜头 3–5 个；有明确的开头、中间和结尾；至少包含独立视频镜头；包含背景音乐；包含旁白或字幕；每个镜头都能独立编辑和替换。

真实模型生成和本地测试素材必须明确区分。

---

## 9. 当前阶段不做什么

完整用户系统；复杂的 SaaS 商业后台；在线支付；完整 Credits 商业系统；云端多人协作；云端视频编辑器；复杂的多模型自动路由；大型 Landing Page；复杂的模板市场；社区和创作者生态。

当前优先级是生产链路可用，而不是商业包装完整。

---

## 10. Agent 开发规则

见 `AGENTS.md`（规范全文）。

**先理解现有架构，再进行最小必要改造。**

**优先实现完整可运行的工作流，而不是堆积孤立功能。**

**不要为了架构优雅过度设计，也不要为了快速演示破坏后续可编辑性。**

---

## 11. 给所有 Agent 的一句话说明

Framino 是一个基于 OpenFilm 改造的 AI Video Production Studio。它让用户通过自己的 Codex 或 Claude Code 自动完成视频创意、脚本、分镜、视频生成、素材管理和工程组装，最后在 Framino 的专业可视化编辑器中人工调整并导出。产品的核心不是 AI 生成一个 MP4，而是让 AI 生成一个完整、可编辑、可持续迭代的视频工程。

开发过程中始终围绕这一目标做决策。
