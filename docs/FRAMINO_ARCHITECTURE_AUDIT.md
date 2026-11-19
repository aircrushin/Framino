# Framino — OpenFilm Architecture Audit

> This file was completed before any code was changed. The audit target is the `openfilm/openfilm` source at
> `e07ae4c` (2026-11-13, v0.3.2), the starting point of the `feature/framino-transformation` branch of the `aircrushin/Framino` fork.
> Audit method: read-only walk of the repository + reading the key source files in full; no speculation.

---

## 0. Summary of audit conclusions

| Item | Conclusion |
| --- | --- |
| Project nature | pnpm 9 monorepo, TypeScript + a little JS (`.mjs`), **zero backend database**, purely local-first |
| Core asset | `film.html` — both the project file and the edit itself; the **single source of truth** on disk |
| Studio | React 19 + Vite 7 + Tailwind 4, single-page application, **home-grown routing**; the build output is served by a local Node HTTP server |
| CLI | `openfilm` single entry point, `bin/openfilm.mjs`; Skills feed the manual to the coding agent through CLI stdout |
| Agent collaboration | Studio and the Agent read and write the same `film.html` directly; the server has CAS writes, three-way merge, and the `/api/kept` negotiation channel |
| Freedom to modify | **Mainly `studio/ui/`, `docs/`, copy and icon assets**; format/serialization/CLI/API/storage keys are hard contracts |
| Existing UI completeness | A professional workbench skeleton already exists (top bar / preview / Inspector / timeline / asset drawer / export center / draggable dividers / responsive), **the layout does not need rewriting** |
| Strategy for this pass | Mainly resetting Design Tokens + local skins + brand replacement, keeping all layout computation and editing algorithms |

---

## 1. Original project architecture

### 1.1 Workspace

```
pnpm-workspace.yaml           packages/* + apps/*
package.json                 root, private, packageManager pnpm@9.15.9, engines.node >=22.18
├── packages/openfilm/       release unit: format + CLI + Studio + asset library (npm package name openfilm, v0.3.2)
│   ├── bin/openfilm.mjs     the CLI's only entry point
│   ├── src/*.mjs            35 runtime modules (format/playback/render/CLI capabilities)
│   ├── studio/server/       Node HTTP + WebSocket server (dual-origin security model)
│   ├── studio/ui/           React editor (442 source files, 121 node:test)
│   ├── manual/              the three core Skills (edit / media / canvas)
│   ├── library/             CC0 asset library
│   └── examples-index/      read-only mirror of the external openfilm/examples repository
├── packages/shared/         types shared across packages (@openfilm/shared, private)
├── apps/desktop/            Electron desktop App + chat front end (@openfilm/desktop, private)
├── skills/framino/          entry Skill installed for the coding agent (the manual and the sub-skills all live in its own folder)
└── docs/                    logo-light.svg / logo-dark.svg / openfilm.webp
```

**Key scripts** (`package.json`):

| Command | What it actually does |
| --- | --- |
| `pnpm dev` | `node scripts/dev.mjs`, source build of Studio, port **4848**, state in `packages/openfilm/.dev/` |
| `pnpm dev:desktop` | Electron dev flavor (`OpenFilm Dev`) |
| `pnpm build` | `build:ui` (Vite builds `studio/ui/dist`) + `build:shell` (desktop window page); **not a full compile** |
| `pnpm test` | recursive serial `node --test`, covering the pure-function unit tests of src / scripts / studio / server / providers / ui |
| `pnpm typecheck` | `tsc -p studio/server && tsc -p studio/ui` + shared + desktop chat/shell |
| `pnpm audit:public` | checks CJK prose, home-folder paths, out-of-repo paths, workspace dependencies, secrets |
| `pnpm check:pack` | packs `openfilm` the way npm publishes it and validates the `files` allowlist |

### 1.2 Runtime model (local-first)

- `~/.openfilm/run.json` stores `{pid, supervisor, origin, filmOrigin, key}`.
- Studio server: **dual origin**.
  - `http://127.0.0.1:<port>` (default 4747): editor page + API, requires the launch key.
  - `http://localhost:<port+1>`: read-only film files, signed access through `/p/<token>/…`, injects `bridge.js` / `stage.js`.
- Only accepts requests whose Host is `127.0.0.1` / `localhost` / `[::1]` (prevents DNS rebinding).
- Preview and export both use Chromium (playwright-core); the first run downloads about 100 MB of headless Chromium.
- ffmpeg / ffprobe must be on PATH; git is used for the project's version history.

### 1.3 Five-layer module map

1. **Format layer** `src/film-doc.mjs` — reading, validation, computation and serialization of the project file. The single source of truth.
2. **Playback/render layer** `src/timeline.mjs` (in-browser playback), `src/host.mjs` (Host clock), `src/render.mjs` (final render).
3. **Server layer** `studio/server/*` — project reads and writes, media serving, export queue, version history, Agent negotiation, WebSocket events.
4. **Editor layer** `studio/ui/*` — React workbench, timeline, Inspector, asset library, preview, export UI.
5. **Agent layer** `skills/framino/SKILL.md` → `manual.md` → `edit|media|canvas/SKILL.md` → `openfilm <command>` CLI.

---

## 2. Core modules (classified by how changeable they are)

### 2.1 Absolutely must not be modified (underlying contracts)

| Path | Why |
| --- | --- |
| `packages/openfilm/SPEC.md` | format protocol 0.1, the `window.film.frame(t)` / `window.filmHost` contract |
| `packages/openfilm/src/film-doc.mjs` | the character-level tokenizer + layout-slice serialization of `readFilmFile` / `filmHtml`; `FILM_FILE='film.html'`, the field allowlist, `toMs` |
| `packages/openfilm/src/timeline.mjs` | playback implementation sharing the same reading as film-doc |
| `packages/openfilm/src/host.mjs` | `FILM_CLOCK` pins `Date` / `rAF` / CSS animations to `t` |
| `packages/openfilm/studio/server/film.mjs` | `rev` = sha256; the CAS `replaceIfStill` of `changeProjectFilm` + 10 retries |
| `packages/openfilm/studio/server/ops.mjs` | `applyOps` applies edits **by clip id** (indices drift once the Agent rewrites the file) |
| `person-edits.mjs` / `person-merge*.mjs` | git-style three-way merge, **the person's edits win**, conflicts are recorded and reported to the Agent |
| `studio/server/history*.mjs` | `.film/history` is a separate git repository; the trailer `Openfilm-Version:` is what reading old versions relies on |
| `packages/openfilm/package.json`'s `name` / `bin.openfilm` / `exports` / `files` / hooks | CLI name, export paths, npm publish contents |
| `packages/openfilm/bin/openfilm.mjs` | subcommand names and arguments; `asRun()` depends on them |
| `packages/openfilm/MANUAL.md` / `manual/*/SKILL.md` / `skills/framino/SKILL.md` | the coding agent's instruction set, containing many `openfilm …` command literals |
| `studio/client.mjs` | `health()` checks `product === 'openfilm-studio'`; the `run.json` fields; `keptNote()` |
| `studio/server/server.mjs` | every `/api/` route, WS paths, cookie names, the `product` identifier, 409/422 semantics |
| `src/render.mjs` / `studio/server/exports.mjs` | export parameter names, `kinds`, `VideoAsk`, `ExportJob.status/phase` |
| `LICENSE` (3 copies), `TRADEMARK.md` (2 copies), `THIRD_PARTY_NOTICES.md` (2 copies), `library/LICENSE.md` | the full MIT text + `Copyright (c) 2026 OpenFilm contributors`; trademark policy; third-party notices |

### 2.2 Directly reusable (keep the logic, the skin may change)

| Path | Responsibility |
| --- | --- |
| `studio/ui/src/App.tsx` | home-grown routing (`location.pathname` + `history.pushState` + `popstate`), no router library |
| `studio/ui/src/components/ProjectView.tsx` (5160 lines) | **workbench assembly and state hub**: top bar, viewer row, Inspector, timeline, overlays, shortcuts, responsive |
| `studio/ui/src/components/Timeline.tsx` (5092 lines) | time ruler, playhead, tracks, clip blocks, zoom, selection, command refs |
| `studio/ui/src/components/useBlockDrag.ts` + `lib/timeline-{drag,edit}.ts` + `lib/clip-speed.ts` | drag / trim / ripple / speed change / snapping / cross-track / linked groups, the `onCommit(ops, label)` contract |
| `studio/ui/src/lib/keymap*.ts` / `timeline-keys.ts` | three shortcut schemes (openfilm / premiere / fcp) + custom slots |
| `studio/ui/src/components/PaneDivider.tsx` | real draggable dividers + `usePaneSize` persistence + keyboard ±16/48px |
| `studio/ui/src/editor/{Preview,player,use-film,undo,steps,preview-frames}.*` | iframe dual-frame hot swap, Web Audio playback clock, optimistic edits + undo/redo stack |
| `studio/ui/src/components/{FilmInspector,InspectorWorkspace,inspector-fields,inspector-look,PropertiesSection,TextInspector,CaptionInspector,ResourceInspector}.*` | property grouping and numeric write-back that draws first and commits later |
| `studio/ui/src/components/{MediaPool,LibraryDrawer,WorkspaceLibraryPane}.*` + `lib/{library,asset-timeline,media-*,thumb-*}.*` | asset categorization, thumbnails, search, drag and drop onto the timeline |
| `studio/ui/src/components/export/*` + `lib/export-*.*` | 8 export target kinds, real progress, cancel |
| `studio/ui/src/components/{ViewerBar,ViewerZoom,LiveTime,AudioMeters,FilmFullscreenBar}.*` | playback controls, timecode, zoom, level meters |
| `studio/ui/src/components/{ProjectHistoryControls,OperationHistory,ProjectTitle,AppMenu,ProjectTabs,ExportTray}.*` | version history, session steps, project name, menus, export tray |

### 2.3 Needs branding (user-visible layer)

- `studio/ui/index.html`: `<title>`, inline data-URI favicon, `aria-label` / `<title>`.
- `studio/ui/src/components/BrandLogo.tsx`, desktop `chat/src/components/BrandLogo.tsx`: inline SVG mark.
- `studio/ui/src/components/BrandLoadingScreen.tsx`: the loading screen.
- `studio/ui/src/i18n/{en,zh-CN,ja,ko,es}.ts`: about 60 product-name entry **values** per language (about 300 in total).
- `apps/desktop/chat/src/i18n/locales/{en-US,zh-CN,ja,ko,es}.ts`: 7 keys × 5 languages.
- `studio/ui/src/lib/whats-new.ts`: release notes in 5 languages.
- Hard-coded: `SettingsModal.tsx`, `OpenFilmAgentDialog.tsx`, `ShortcutsSection.tsx`, `TextStyleSample.tsx`, `font-menu.ts`.
- The 4 `PRODUCT_NAME`s in `apps/desktop/src/flavor.mjs`, `NAME` in `scripts/release.mjs`, `productName` in `apps/desktop/package.json`.
- `docs/logo-{light,dark}.svg` (the wordmark is **path outlines**, so it cannot be replaced as text and has to be redrawn).
- Product description paragraphs in `README.md` / `README.zh-CN.md` / each package README / `CONTRIBUTING.md` / `MANUAL.md` and so on.

### 2.4 Needs UI redesign (visual layer, the highest-leverage point)

| Path | Notes |
| --- | --- |
| `studio/ui/src/globals.css` (709 lines) | **the single entry point of the whole design system**: the two token sets `:root` / `[data-theme='dark']`, the `.tl-*` timeline skin, the `.stage*` canvas, the canvas subsystem `--cv-*`, scrollbars, focus rings, animations |
| 10 `*.module.css` | local skins (AppMenu / InspectorWorkspace / ProjectTabs / WorkspaceEditor / WorkspaceLibraryPane / …) |
| `PANE_BAR/PANE_BTN/PANE_TITLE` in `dock-pane-bar.ts` | panel title bar constants |
| `FIELD/INPUT/HEAD_BTN` in `inspector-fields.tsx` | input control skin constants |
| `KIND_COLOR` / `TL` / `laneTone()` / `SelectFrame` in `Timeline.tsx` | visual constants of tracks and clips (**not algorithms**) |

### 2.5 Known limitations (declared by the original project itself)

- Node ≥22.2 (npm) / ≥22.18 (source); pnpm 9.15.9; ffmpeg + ffprobe; git; first download of Chromium ≈100 MB.
- Preview must be Chromium-based; ProRes / HEVC without hardware decoding needs `seekable.mjs` to generate a proxy copy.
- Generating voice-over/music/images/video requires your own API key in Settings; library semantic search / local models need a model downloaded over the network the first time.
- `film.html` has a strict allowlist: extra attributes, `transition`, `position/transform/margin` and `<script>` all raise errors; time precision is milliseconds only.
- **No Save button**: an edit writes to disk at once (`useFilm` optimistic apply + serial POST); saving a version is a manual git version.
- **No Retry for export**: after a failure or a cancel you can only queue again (the options are remembered by localStorage).
- **The browser build of Studio does not render a chat panel**: the real Agent conversation is in `apps/desktop/chat/`, and Studio only reserves an inset through `studioHost.panel`.
- The UI layer has **no component render tests / E2E**: all 121 tests are `node:test` pure-function unit tests.
- Windows notes: retry on EPERM when a file is in use, the ffmpeg shim needs `taskkill /T /F`, and a port reserved by Hyper-V needs another port.

---

## 3. Key components and file paths

### 3.1 Studio front-end entry points

| File | Role |
| --- | --- |
| `packages/openfilm/studio/ui/index.html` | the single-page HTML; a synchronous script before first paint reads `localStorage['openfilm.theme']` and writes `data-theme` (prevents a white flash) |
| `packages/openfilm/studio/ui/vite.config.ts` | `root=__dirname`, `react()` + `tailwind()`, `@` → `./src`, `outDir=dist` |
| `packages/openfilm/studio/ui/src/main.tsx` | `createRoot` → `<StrictMode><FocusNav /><App /></StrictMode>`; `applyStudioHost()` first |
| `packages/openfilm/studio/ui/src/App.tsx` | routing decision: `/projects/<id>` → `ProjectView`; no id → `Launcher` / `ProjectsPopover` / `BrandLoadingScreen` |
| `packages/openfilm/studio/ui/src/api.ts` | every `/api/` endpoint and the SSE event subscriptions (**a contract with the server, do not change**) |

### 3.2 Main workbench JSX (`ProjectView.tsx:4543–5095`)

| Area | Lines | Contents |
| --- | --- | --- |
| `data-titlebar` | 4548–4600 | `ProjectTitle`, `AppMenu`, `ProjectTabs`, `ProjectLayoutMenu`, `ProjectHistoryButton`, export button, `ExportTray`, mode switch |
| `viewerRowRef` | 4606 | left `LayersPanel` (`data-workspace-layers`), middle `data-viewer-pane` (`SourcePreview` + `Preview` + `ViewerZoom` + `ViewerBar`), right `data-workspace-inspector` |
| Inspector contents | 4853–4915 | one of `ResourceInspector` / `CaptionInspector` / `FilmInspector` |
| `data-workspace-timeline` | 4923–4995 | `<Timeline>` + `AudioMeters` |
| `data-workspace-canvas` | 5002–5016 | `@xyflow/react` node canvas (the other mode) |
| Overlays | 5021–5093 | `ProjectHistoryControls`, `ProjectsPopover`, `SettingsModal`, `WorkspaceLibraryPane` (including `LibraryDrawer`), `WorkspaceEditor`, `ExportCenter`, `Toast` |

Size constants: `DOCK_GAP=1`, `GRAB=14`, `MIN_INSPECTOR=280`, `MIN_VIEWER=280`, `DEFAULT_INSPECTOR=360`, `TIMELINE_H=200`, `TIMELINE_SHARE=0.45`, `MIN_STAGE_H=220`; `ResizeObserver` + `rowNarrow = rowWidth < 880` collapses the Inspector automatically; Tailwind 4 container queries `@xs/@lg/@xl`.

### 3.3 CLI / server entry points

| File | Role |
| --- | --- |
| `packages/openfilm/bin/openfilm.mjs` | `open / look / render / get / canvas / skills / skill / update / doctor`, exit codes 0/1/2 |
| `packages/openfilm/studio/server/main.mjs` | supervisor + worker, two processes, `~/.openfilm/run.json` |
| `packages/openfilm/studio/server/server.mjs` | `startStudio()`, route table from `:206`, project-level routes from `:699`, WS `:1238–1265` |
| `packages/openfilm/studio/server/exports.mjs` | export queue → `render-worker.mjs` → `src/render.mjs` |
| `packages/openfilm/studio/client.mjs` | CLI discovers/starts Studio, `keptNote()`, `agentName()` |

---

## 4. Project data structure

### 4.1 On-disk layout

```
<project>/
  film.html              the edit itself (the single source of truth)
  *.html / scenes/*.html  pages (each exposes window.film.frame(t))
  assets/                 video / images / sound
  .film/                  tooling directory (history git repository, cache, opened marker) — the Agent must not touch it
  .git/                   the user's own (optional)
```

### 4.2 `film.html` structure (`SPEC.md` §1)

- `<head>`: the film's own styles, **no `<script>`**. `<meta name="viewport" content="width=…, height=…">` defines the stage, 1920×1080 by default.
- `<body>`: each `<section>` is one track, **the first one is on top**; it may carry `hidden / muted / locked`. Clips on the same track do not overlap.
- clip elements: `<iframe>` (page), `<video>`, `<img>` (still frame), `<audio>` (sound); their content must be empty.

| Attribute | Meaning |
| --- | --- |
| `src` | path relative to `film.html` (`assets/a.mp4`, `scenes/title.html`), may carry a `#t=in,out` media fragment |
| `at` | start second within the film (default 0) |
| `speed` | 0.1–100; film duration = `(out−in)/speed` |
| `volume` | linear gain |
| `size` | the page's `1920x1080` |
| `id` | unique across the whole film, defaults to the file name |
| `style` | **only** `left / top / width / height / rotate` may take part in placement; `position/transform/margin/transition` raise errors |
| `overrides` | **the person's edits made in Studio**, a JSON array; with `at` (a CSS selector) it applies to a page clip, fields `n/t/s/r/style/text/lock`; at most one entry without `at`, which is the clip's `fade:[in,out]` |
| `<track kind="captions|subtitles" src="…vtt">` | WebVTT subtitles, timed on the film timeline |

All times are rounded to **milliseconds** (`toMs`, each value rounded independently).

### 4.3 Page contract (`SPEC.md` §2–§4)

```js
window.film = {
  frame(t) { /* draw the complete picture at second t */ },  // may return a Promise
  duration: 12,                            // optional, its own length in seconds
  ready: loadEverything(),                 // optional Promise
  width: 480, height: 320,                 // optional, the page's own size
  frameReadsOverrides: true,               // optional
};
```

**The one rule**: the same `t` always draws the same picture. The Host requests frames out of order, in parallel, and at fractional frames (motion blur). When `window.filmHost` (`{version:'0.1', name}`) is present, the page must not run its own clock.

### 4.4 Serialization / deserialization

All of it is in `src/film-doc.mjs`, **no third-party dependencies, pure JS**:

- Deserialization: the character-level tokenizer `markup(text)` cuts the HTML into `open/close/text/comment/doctype`, each item with its character offset; `clipOfTag()` parses attributes, `declarations()` parses style with a hand-written semicolon split, `fragmentSeconds()` parses `#t=`, `keyframeBlocks()` parses `@keyframes` with hand-written brace balancing; `readFilm()` performs strict allowlist validation.
- Serialization: `filmHtml(value, before)` **splices based on the original text positions in `layout`** — an unchanged clip is kept verbatim with `old.text.slice(start, end)`, only a changed one is rewritten with `clipTag(clip)`, and the head is patched locally from back to front using `edits[]`. Comments, line breaks and all untouched original text are preserved.
- `filmHead(text)` lets the player decide "if only the tracks changed, change in place; only reload the page when the head changed".

> **Constraint on Framino**: field names, timeline structure, media reference rules and the serialization mechanism must not be changed. Extensions must be backward compatible and synchronized in `film-doc.mjs` + `SPEC.md`.

---

## 5. How the Agent and Studio interact

### 5.1 Three layers of Skill

```
skills/framino/SKILL.md         → "Read manual.md in this folder, then the skill the task needs"
packages/openfilm/MANUAL.md     → one-page manual (printed to CLI stdout, asRun() replaces the runtime command prefix)
manual/{edit,media,canvas}/SKILL.md → the body of the three core skills + openfilm.json (multilingual title/description)
```

Call chain:

```
coding agent
  ├─ npx -y openfilm@latest          → prints MANUAL.md
  ├─ openfilm skill edit|media|canvas → reads the skill (local file)
  ├─ openfilm open <folder>           → studio/client.mjs → POST /api/open → Studio opens the project
  ├─ openfilm look / render           → local validation / render (the same mix and clock as export)
  └─ openfilm get / canvas / skills   → Studio API → the file lands in assets/ or on the canvas → fs.watch → WS → immediately visible in Studio
```

### 5.2 One and the same project data (the key point)

- Studio and the Agent **both read and write `film.html` on disk directly**; there is no database and no intermediate representation layer.
- Studio writes: `changeProjectFilm()` serial queue → `settle()` → `filmHtml(…, current.text)` → **CAS `replaceIfStill()`** (writes only if the file is still the text that was read, otherwise replays, and after 10 attempts returns 409 `conflict`).
- The Agent overwrites the whole file: `watch.mjs` fs.watch (120ms coalescing) → `settle()` requires the same bytes to read identically twice within `STABLE_MS=150` → `person-edits.mergeFilmWrite()` performs a **git-style three-way merge**: what only the Writer changed belongs to the Writer, what only the Person changed is kept, and where both changed the same place **the Person wins**; the text before and after the merge is stored in `.film/history` (`agent.html` / `merged.html`).
- Notification chain: `noteFor(root, agent)` → `GET /api/kept` → before each command the CLI prints `keptNotice()` to stderr → `POST /api/kept/said` acknowledges it.
- Page-level conflicts: `rev` (sha1) / `expect` in `page-text.mjs`; a mismatch returns 409 `"was changed since (by the agent, or in another window)"`.
- `agentIn()` forbids renaming/deleting the project while the Agent is working (409 `agent-running`).

> This already satisfies "after the Agent changes something Studio can see the update / after Studio changes something the Agent can read the latest state / unsaved changes must not be overwritten / conflicts are surfaced and recoverable", and **Framino does not need to build another data layer**.

### 5.3 Current state of the Agent panel

- `studio/ui` **does not render a chat panel**; the real chat UI is in `apps/desktop/chat/` (90+ files).
- Studio only reserves the inset and `setOpen/setWidth` through `studioHost.panel` / `useHostPanel()`, and the Agents page of `SettingsModal` appears only when a desktop host is present.
- The desktop chat reuses Studio's components and global variables by importing `openfilm/studio-ui/*`.
- **Conclusion**: the Agent side panel of the browser build of Studio needs a new UI entry point; the first phase must state plainly that "the browser Studio is not connected to Agent conversations, and the real conversation is provided by the desktop app / the user's own coding agent + CLI", and must not fake execution results.

---

## 6. Project save and export flow

### 6.1 Save

```
Inspector / Timeline edit
  → commit(ClipEdit[]) → useFilm(editor/use-film.ts)
  → server/ops.mjs applyOps applies locally at once (optimistic)
  → serial POST /api/projects/:id/edit
  → film.mjs editProjectFilm(root, base, ops)   [by clip id]
  → filmHtml() partial rewrite → atomic.mjs atomic write
  → ws event {type:'film', rev} → page refresh
```

- **No Save button / dirty flag**: any edit lands on disk immediately.
- Saving a version: `ProjectHistoryButton` → the separate `.film/history` git repository, `save/discard/checkout/restore/copy/delete/recover`.
- Automatic versions: at the start/end of an Agent turn, when the folder has been still for 2 minutes (at most 10 minutes), and when the project is closed.
- Undo/Redo is the **session edit history** (inverse operations in `editor/steps.ts` + `undo.ts`), ⌘Z; it is a different thing from the git version history.

### 6.2 Export

| Target | Parameters |
| --- | --- |
| `video` | `codec`(h264/hevc/vp9/prores422hq/prores4444/hevc_alpha/png), `shortEdge` 64–4096, `fps` 1–120, `quality` standard/high/master, `scale`, `sidecar` srt/vtt, `loudness` |
| `alpha` / `gif` / `audio`(wav/m4a/mp3 + stems) / `stills` / `poster` / `subtitles` / `slides`(pptx/pdf) / `nle`(xmeml/fcpxml/jianying) / `project`(zip/folder) | each has its own options |
| Common | `range` or `ranges` (1–100 segments), `burnSubtitles`, `label`, `name` |

Progress chain: `render.mjs opts.onProgress` → `render-worker.mjs` IPC → `exports.mjs frames()` (rate/etaMs/progress) → `server.mjs watchers.emit` → project WS `{type:'export', job}` → `ExportTray` shows percentage/ETA/rate/bytes.

- **Cancel**: `cancelExport()` → `AbortController` → kill the ffmpeg tree → `status:'cancelled'`, cleaning up the half-finished output.
- **Retry**: there is no requeue underneath; you have to reopen ExportCenter and queue again (the options are remembered by `openfilm.exportCenter.v1`).
- **Failure**: `ExportError` → job `error`; `recordProblem()` writes `logs/problems.jsonl`, which Settings → Developer → Copy report can export.
- **Does not overwrite project files**: the output is written to the exports directory, named after the project, and does not overwrite old files; the project source and the original assets stay editable.

> This is exactly what Framino requires: "export the project as currently edited / real progress / real errors / the project source files are preserved".

---

## 7. Existing design system

- **Tailwind 4 configured in pure CSS**, no `tailwind.config.*`, no `@theme {}`; components consume ordinary `:root` custom properties through arbitrary values such as `bg-[var(--bg-panel)]`.
- Theme: `<html data-theme>`, with two complete sets of values, `:root, [data-theme='light']` and `[data-theme='dark']`; **dark by default**.
- Fonts: `@import '@fontsource-variable/inter'`; `--font-sans` = `'Inter Variable', … , var(--font-cjk-sans)` (the CJK stack includes Noto Sans SC / Source Han Sans).
- Token groups:
  - Surfaces `--bg-app/titlebar/panel/raised/viewer`, `--dock-line`, `--bg-field/hover/pressed/selected`
  - Text `--text/muted/faint`, lines `--border/strong`
  - Primary actions `--primary/hover/on-primary`; accents `--accent/soft/on-accent/switch-on/bg-picked/text-selection`
  - States `--ok/warn/err`; clip kinds `--clip-video/image/page/text/sticker/filter/effect/audio`
  - Timeline `--tl-lane/row/gap/lane-on/playhead/select/wave/wave-band/wave-clip`
  - Canvas has its own `--cv-*` (30 of them) + React Flow `--xy-*`
- Key original dark values: `--bg-app:#141414`, `--bg-panel:#181818`, `--bg-raised:#202020`, `--accent:#00c1cd` (cyan), `--tl-playhead:#ffffff`.

---

## 8. UI transformation plan

### 8.1 Principles

Keep the layout computation and every interaction algorithm of `ProjectView.tsx` / `Timeline.tsx`, and **only reset the tokens and local skins**. This is the path with the lowest risk and the highest return.

### 8.2 Layered implementation

| Layer | Action | Files |
| --- | --- | --- |
| L0 Tokens | In `globals.css`, define a full set of Framino `--studio-*` brand/editing-bench tokens and map them onto the existing `--bg-*` / `--accent` / `--clip-*` / `--tl-*`; change the dark values to deep grey-black + low-saturation track colors + a Sage green accent | `globals.css` |
| L1 Brand | new wordmark SVG (lowercase `framino`); replace both `BrandLogo.tsx`; new favicon data URI; `index.html` title; loading screen; i18n entry values in 5+5 languages; desktop `PRODUCT_NAME` | see §2.3 |
| L2 Panel skins | top bar height/density, panel title bars, Inspector fields, asset library list, preview monitor background, timeline clip/ruler/playhead/selection box | `globals.css` + `*.module.css` + `dock-pane-bar.ts` + `inspector-fields.tsx` + `KIND_COLOR` in `Timeline.tsx` |
| L3 Agent entry | new Agent button in the top bar → side panel: project context (real data), task/change record (real film events), input area; state the status plainly when not connected, do not fake results | minimal injection into `ProjectView.tsx` + new components |
| L4 States | unify hover / selection / empty / loading / focus styles; keep `prefers-reduced-motion` and `data-focus-nav` | `globals.css` |

### 8.3 Explicitly out of scope

- Do not rewrite the timeline, do not rewrite the render engine, do not change the `film.html` format, do not change the API/CLI/Skills.
- Do not introduce the cloud, sign-in, multi-person collaboration, new dependencies, or framework upgrades.
- Do not dress up "unsupported Inspector properties", "export retry" or "browser-build Agent conversation" as if they were implemented.

---

## 9. Potential compatibility risks

| Risk | Level | Mitigation |
| --- | --- | --- |
| Changing the package name / CLI name / `exports` / directory names | **Fatal** | keep all of them; `scripts/check-pack.mjs:24`, `audit-public.mjs:43,55` and `.gitleaks.toml` hard-code the paths |
| Changing `openfilm.*` localStorage keys, `OPENFILM_*` environment variables, postMessage source, drag MIME type | **Fatal** | keep all of them (otherwise users lose preferences / the desktop host protocol breaks / already-saved projects stop rendering) |
| Changing `film.html` fields or `film-doc.mjs` | **Fatal** | leave it entirely alone, so that existing projects and Agent output do not stop working |
| Changing `.tl-blade` sizes/hotspots or the `data-zoom-layer` / `data-block-*` selectors in `globals.css` | High | change only colors and cursor colors, keep the sizes and every data attribute |
| Changing layout computations such as `TIMELINE_H` / `RULER_H` / `pxPerMs` | High | leave them alone; responsiveness is already implemented with `ResizeObserver` + container queries |
| Changing the structure of the `openfilm.theme` theme script | Medium | change only the default color values, keep the anti-white-flash script |
| Mistyping key names or placeholders during a bulk i18n replacement | Medium | replace **entry values** only; `i18n-placeholders.test.ts` checks `{n}` consistency |
| Editing `examples-index/examples.json` directly | Medium | this is a mirror of the external `openfilm/examples`, and `examples:sync --check` would fail; leave it as it is and explain it in the docs |
| Renaming `docs/openfilm.webp` so that README references break | Low | keep the file name, or update the README at the same time |
| Deleting / rewriting the historical links in `CHANGELOG.md` | Low | keep the history as it is |
| Turning on `noUnusedLocals/noUnusedParameters` in `tsconfig` | Low | deleting UI variables easily triggers type errors; always run `pnpm typecheck` after a change |
| The light theme being mistaken for the editing bench's main color | Low | the brand light colors are used only outside the editing workspace; the editor is forced to a professional dark |

---

## 10. Baseline before the transformation (recorded in Phase 1.3)

| Item | Value |
| --- | --- |
| Environment | Windows / Node v22.22.2 / pnpm 9.15.9 (corepack, resolved from `packageManager`) / FFmpeg 8.0.1 / Git 2.55.0 |
| Git | `origin=https://github.com/aircrushin/Framino.git`, `upstream=https://github.com/openfilm/openfilm.git`, branch `feature/framino-transformation` |
| `pnpm install --frozen-lockfile` | succeeded; `prepare` produced `studio/ui/dist/index.html` automatically; `pnpm-lock.yaml` unchanged |
| `pnpm typecheck` / `pnpm test` / `pnpm build` | see the "Baseline before the transformation" section of `docs/FRAMINO_IMPLEMENTATION_REPORT.md` |

---

*This audit document is extended with measured results as the implementation progresses; every "absolutely must not be modified" conclusion is based on reading the source code itself.*
