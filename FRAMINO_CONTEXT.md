# Framino — Project Context

> AI Video Production Studio · *Make more. Create freely.*
>
> Read this file before any task. Then read `AGENTS.md` (rules) and the doc for the module you are working on (§12).
> The Chinese original of this file is `FRAMINO_CONTEXT.zh-CN.md`. **This English file is canonical**: the repository's
> public audit (`scripts/audit-public.mjs`, run in CI) rejects CJK prose outside `*.zh-CN.md` and i18n files.
> When the two disagree, this one wins, and §13 wins over everything above it.

---

## 1. What Framino is

Framino is a professional video production and editing workbench for AI video creators. It is neither a
prompt-to-MP4 website nor a classic NLE. It joins two things:

1. **An AI agent produces**: it understands the idea, writes the script, designs the storyboard, calls video models,
   gathers media and organises the project.
2. **A person reviews and controls**: in a visual editor they adjust shots, timeline, captions, audio, media and the
   final cut.

Core idea: **AI does the heavy production work; the creator keeps control of the work.**

People use their own Codex, Claude Code or similar coding agent. Framino provides the video production API, media
management, project assembly and the professional editor. The deliverable is **a complete, editable project**, not
only an MP4.

## 2. Positioning and users

**Positioning**: AI-native video production studio, the workbench between coding agents and video models.

**Users**: AI developers and creators on Codex / Claude Code; independent video creators; AI video studios; individuals
and small teams producing video cheaply and in volume; anyone who wants agent automation but final human control.

**Value**: low cost per video; high automation; no lock-in to one coding agent; no forced expensive closed workflow;
output stays editable; video APIs, agent and editor form one workflow.

**Difference**: others do *prompt → video → download*. Framino does *idea → script → storyboard → generation → media
→ assembly → human edit → export*. **The AI produces an editable project, not a file.**

## 3. Production workflow

| Step | What happens | Output |
| --- | --- | --- |
| 1 Idea | the agent captures topic, audience, length, aspect ratio, style, platform, language, budget/limits | `manifest.brief` |
| 2 Script | hook, scenes, voice-over, dialogue, subtitles, ending, pacing | `production/script.md` |
| 3 Storyboard | one structured entry per shot: `shot_id, scene_id, duration, visual_description, camera_movement, camera_angle, lighting, composition, generation_prompt, reference_assets, voiceover, subtitle, aspect_ratio` | `manifest.shots[]` |
| — Approval | **the person approves script and storyboard before anything is generated** | `manifest.approval` |
| 4 Generation | one `openfilm get video` call per shot, through the service the person connected in Studio; the person confirms the spend; retry on failure; regenerate one shot; never regenerate a shot that succeeded; keep every task's parameters | `manifest.tasks[]` |
| 5 Asset pipeline | land video, image, audio, voice-over, subtitles; probe duration, resolution, fps, codecs, audio; stable `asset_id`; broken files never enter the project | `manifest.assets[]` |
| 6 Assembly | build a project Studio opens: each shot its own clip, separate audio tracks, captions, order and timing, metadata, every shot replaceable | `film.html` |
| 7 Studio review | the person edits shots, timeline, media, captions, audio, durations, order, picture | `film.html` (Studio writes it) |
| 8 Export | MP4, the full editable project, original media, audio, pictures, captions and metadata | Studio's export (exists today) |

The person's coding-agent subscription pays for the creative reasoning. Video generation is billed by whatever service
the person connected in Studio (their own key, OpenFilm's service, or a local model). Framino never sits in the middle.

## 4. Architecture

Framino is a fork of OpenFilm (MIT). OpenFilm provides the project format, the editor, the timeline and rendering.
Framino adds AI production on top.

- **A. Framino Studio**: the editor (workspace, media library, preview, timeline, inspector, captions, audio, export).
  OpenFilm's editing and rendering engine stays intact.
- **B. Video Agent Skill**: the production workflow for the person's coding agent (Codex and Claude Code, adapted to
  each one's real skill mechanism). Orchestrates; does not reimplement the generation path or the adapter.
- **C. Video Generation**: the built-in path, `openfilm get video`. The person connects a service in Studio
  (Settings → Services) with their own key, or signs in to OpenFilm's service, or runs a local model; the agent calls
  the CLI. **There is no Framino gateway, no Framino account and no Framino credits** (dropped 2026-11-14). What
  Framino adds is a ledger: the task is written to the manifest before the call, a task left running is resolved
  against the disk instead of being resubmitted, and every retry is a new take with a new file name, so nothing is
  overwritten and nobody pays twice. Details: `docs/FRAMINO_VIDEO_GENERATION.md`.
- **D. Media Asset Pipeline**: download, validate, probe, thumbnail, organise, retry, resolve name conflicts, manage
  references. Not the editor UI, not timeline serialisation.
- **E. Project Adapter**: converts the Production Manifest into OpenFilm's real project format, after reading the
  real format. Never invents an incompatible one.

## 5. Shared identifiers

`project_id`, `scene_id`, `shot_id`, `asset_id`, `task_id`. Rules: `shot_id` is stable for the whole production; every
task names its `shot_id`; every asset has its own `asset_id`; a shot can have several takes; regenerating one shot
affects no other; a succeeded task is never re-run after a restart; intermediate state is persisted so work resumes.

Exact formats, the manifest schema and ownership: **`docs/FRAMINO_INTEGRATION_CONTRACT.md`**.

## 6. Brand and visual design

Name **Framino** · keywords Professional, Efficient, Creative, Affordable, Minimal, Creator-focused.

| Brand | Hex | Editor | Hex | Track | Hex |
| --- | --- | --- | --- | --- | --- |
| Sage Green | `#64836D` | Background | `#181A19` | Video | `#557D69` |
| Forest Green | `#34483A` | Panel | `#202321` | Audio | `#9B835C` |
| Soft Mint | `#DCE9DD` | Elevated | `#282C29` | Text | `#718BA5` |
| Warm Cream | `#F5F7F1` | Border | `#353A36` | Image | `#8B79A2` |
| White | `#FFFFFF` | Text / 2nd / muted | `#E5E8E4` / `#A0A7A1` / `#707A72` | | |
| | | Accent / active / selection | `#8BA58E` / `#A5BFA6` / `#344B39` | | |

Studio style: **Professional Dark Editorial Studio** (references: DaVinci Resolve, Premiere Pro, Final Cut Pro,
Linear). A professional editor, not an AI SaaS dashboard: dense, precise, restrained, one set of tokens, clear panel
hierarchy, a timeline that feels like a tool.

**Never**: heavy rounded cards, gradients, glassmorphism, AI sparkle decoration, large glows, excess whitespace,
SaaS-dashboard look, beauty at the cost of editing speed.

Tokens as shipped: `docs/FRAMINO_DESIGN_SYSTEM.md` and `packages/openfilm/studio/ui/src/globals.css`.

## 7. Progress

**Phase 1, done (UI and brand only)**: design system and tokens; Framino identity (logo, favicon, metadata, app
icons); studio workspace (toolbar, layout, media, preview, inspector, timeline); media library and preview; inspector
and timeline skin. This does **not** mean any AI production capability exists. Report:
`docs/FRAMINO_IMPLEMENTATION_REPORT.md`.

**Phase 2, in progress: the full AI production chain**, five parallel modules under one integration contract:

| Agent | Module | Doc |
| --- | --- | --- |
| 1 | Project Adapter: manifest → film.html; verify open, edit, save, reopen, export | `docs/FRAMINO_PROJECT_ADAPTER.md` |
| 2 | Video Agent Skill: idea → script → storyboard → generation → assembly | `docs/FRAMINO_VIDEO_SKILL.md` |
| 3 | Video Generation: the built-in `openfilm get video` path, the task ledger, resume without paying twice | `docs/FRAMINO_VIDEO_GENERATION.md` |
| 4 | Media Asset Pipeline: download, validate, organise, metadata | `docs/FRAMINO_ASSET_PIPELINE.md` |
| 5 | Production Workflow & E2E: owns the contract, integration, E2E tests, the demo | `docs/FRAMINO_E2E_TEST_REPORT.md` |

Integration order: (1) freeze the contract → (2) generation ledger, Pipeline, Adapter in parallel → (3) integrate the Skill →
(4) E2E → (5) verify full edit and export in Studio.

## 8. MVP target

The question to answer: **can a person, with their own coding agent, cheaply produce a complete video project
automatically, then keep editing and export it in Framino?**

Must work end to end: idea → script → storyboard → **person approves** → real video API → media landed and organised →
project assembled → opened in Studio → shots, captions and audio edited → saved → MP4 exported.

Demo: **Coffee Brand Commercial**, about 30 s, 3–5 shots, clear opening/middle/end, independent video shots, music
bed, voice-over or captions, every shot independently editable and replaceable. Real model output and local test
media are always labelled apart.

## 9. Not now

Full user system, SaaS admin, online payment, full commercial credits, cloud collaboration, cloud editor, multi-model
auto-routing, large landing page, template market, community. Priority is a working production chain, not packaging.

## 10. Agent rules (summary; full text in `AGENTS.md`)

Before: read this file, README, the real structure, `package.json` scripts; check existing code; state file ownership
and interface boundaries. During: do not guess the format; do not break the editor or renderer; do not do another
module's job; no unrelated refactors; no large new dependencies; tests for key logic; handle errors and resume; never
present a mock as real; do not edit shared core files across agents. After: report what, which files, interfaces, how
to run, how to test, results, known issues, next steps.

**Understand the existing architecture, then make the smallest necessary change. A complete working flow beats a pile
of isolated features. Do not over-design; do not trade away editability for a quick demo.**

## 11. One-paragraph brief

Framino is an AI video production studio built on OpenFilm. Through their own Codex or Claude Code, a person goes from
idea to script, storyboard, generated video, organised media and an assembled project, then adjusts and exports it in
Framino's professional editor. The point is not that AI makes an MP4; it is that AI makes a complete, editable project
that can keep evolving.

## 12. Where context lives

| File | Purpose | Owner |
| --- | --- | --- |
| `FRAMINO_CONTEXT.md` | this file: product, goals, phase | product lead |
| `FRAMINO_CONTEXT.zh-CN.md` | the Chinese original | product lead |
| `AGENTS.md` | rules for every agent (Codex reads it; `CLAUDE.md` imports it) | Agent 5 |
| `docs/FRAMINO_ARCHITECTURE.md` | the real architecture, Phase 2 modules mapped onto the code | Agent 5 |
| `docs/FRAMINO_INTEGRATION_CONTRACT.md` | IDs, manifest schema, errors, idempotency, ownership | Agent 5 |
| `docs/FRAMINO_PROJECT_ADAPTER.md` · `_VIDEO_GENERATION.md` · `_ASSET_PIPELINE.md` · `_VIDEO_SKILL.md` | one per module | Agents 1–4 |
| `docs/FRAMINO_E2E_TEST_REPORT.md` | what was run, and what passed | Agent 5 |
| `docs/FRAMINO_ARCHITECTURE_AUDIT.md` | Phase 1 audit of inherited OpenFilm (Chinese) | — |
| `docs/FRAMINO_DESIGN_SYSTEM.md` · `docs/FRAMINO_IMPLEMENTATION_REPORT.md` | Phase 1 design system and report | — |

## 13. Ground truth that overrides the brief above

Read from the code at `123e654` on `feature/framino-transformation`. Where the brief and the code disagree, the code
wins.

1. **There is no JSON project schema.** The project is a folder; the edit is `film.html` (`packages/openfilm/SPEC.md`
   §1), parsed strictly by `packages/openfilm/src/film-doc.mjs`. The manifest is Framino's plan and ledger; after
   assembly `film.html` is the truth, and Studio merges a person's edits over an agent's (`studio/server/person-edits.mjs`).
2. **Saving and export already exist.** Studio writes every edit to disk as it is made (no Save button); versions live
   in `.film/history`; export (MP4 and NLE formats) is `studio/server/exports.mjs` and `openfilm render`. Do not build
   another.
3. **Video generation already has a path.** `openfilm get video` (`studio/server/get.mjs`) runs through a provider
   (`studio/server/providers/contract.mjs`), asks the person to confirm the spend in Studio, writes only under
   `assets/`, and already supports fal, OpenRouter, Google, OpenFilm's own service and local models. **This is the only
   generation path**; there is no Framino gateway to build. Note that `--force` is declared but read by no provider, so
   de-duplication is Framino's job, not the CLI's (`docs/FRAMINO_VIDEO_GENERATION.md`).
4. **Media metadata and thumbnails exist** in Studio (`studio/server/derived.mjs`, cached in `.film/cache/`). The
   pipeline validates and records to the manifest; it does not re-implement Studio's thumbnails.
5. **The skill mechanism exists.** `skills/framino/SKILL.md` (self-contained: its manual and skills ship in its own
   folder) → `openfilm` CLI → core skills in
   `packages/openfilm/manual/{edit,media,canvas}/` (`src/skills.mjs` `CORE_SKILLS`). The desktop app already hands
   them to Claude Code, Codex and others (`apps/desktop/src/agent-skills.mjs`). The production skill joins that.
6. **Names that must not change**: the `openfilm` command and npm package, `OPENFILM_*` variables, `~/.openfilm`,
   `.film/`, `film.html` and its attributes, every `/api/` route. See the audit §2.1 and §9.
