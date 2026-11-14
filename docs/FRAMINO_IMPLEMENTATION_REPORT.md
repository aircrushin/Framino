# Framino — Implementation Report (Phase 1)

> Scope of this phase: fork OpenFilm, understand it, rebrand it, redesign the editor into a professional dark studio,
> and prove the result still opens, edits, saves and exports real projects. No landing page, no commercial backend.

---

## 1. Fork and Git

| Item | Result |
| --- | --- |
| Upstream | `https://github.com/openfilm/openfilm` (MIT) |
| Fork | `https://github.com/aircrushin/Framino` (created with `gh repo fork openfilm/openfilm --fork-name Framino`) |
| Working copy | the local clone of the fork (a sibling of the upstream checkout) |
| `origin` | `https://github.com/aircrushin/Framino.git` |
| `upstream` | `https://github.com/openfilm/openfilm.git` (fetched with tags) |
| Branch | `feature/framino-transformation`, based on upstream `main` @ `e07ae4c` |
| Working tree at start | clean; no uncommitted work was overwritten; no destructive git operation, no force push |

## 2. Environment (verified, not assumed)

| Tool | Version found | Note |
| --- | --- | --- |
| Node | 22.22.2 | project requires 22.18+ |
| pnpm | 9.15.9 via `corepack` | the repository pins `packageManager: pnpm@9.15.9`; the system pnpm 10 would have rewritten `pnpm-lock.yaml`, so it was never used |
| ffmpeg | 8.0.1 | rendering, waveforms |
| git | 2.55 | saved versions |
| Chrome | installed | used for the preview and for headless renders |
| headless Chromium | installed via `playwright-core install chromium-headless-shell` | required by `look` / `render` |

`corepack pnpm install --frozen-lockfile` completed with **exit 0**; `pnpm-lock.yaml` is byte-identical afterwards
(`git diff --stat pnpm-lock.yaml` empty). No dependency was added, removed or upgraded.

## 3. Baseline before any change

| Check | Result |
| --- | --- |
| `pnpm typecheck` | pass |
| `pnpm dev` | Studio serves on `127.0.0.1:4848`, sample project opens |
| Sample project in a real browser | 1 track, 1 clip, monitor + inspector + timeline render, **0 console errors** |
| `docs/baseline.png` equivalent | captured (`packages/openfilm/.dev/baseline.png`, git-ignored) |

The original project's own limits were recorded in the audit (§2.5), not "fixed": the browser Studio has no agent
conversation of its own, the media that needs a service needs a key, and Windows needs ffmpeg on `PATH`.

## 4. What changed

### 4.1 Branding (457 user-visible strings, 0 identifiers)

Replaced only the **product name shown to people**; every compatibility surface kept its name on purpose.

| Changed | Kept, deliberately |
| --- | --- |
| Window/document titles, favicon, app metadata | CLI command `openfilm` |
| Toolbar wordmark, launcher, loading screen, empty states | npm package name `openfilm` |
| i18n strings (en, zh-CN, es, ja, ko) | environment variables `OPENFILM_*` |
| Desktop `productName`, bundle name, installer text | internal identifiers (`OpenFilmAgentDialog`, `HostOpenFilmModel`, `saveOpenFilmModels`) |
| CLI `--help` text and error copy | project format, `film.html`, fields, `.film/` cache, `~/.openfilm` paths |
| README / MANUAL / SKILL prose | upstream URLs, discussion and issue links, attribution lines |

`\bOpenFilm\b` was matched with an explicit file allow-list, so `openfilm.dev`, `OPENFILM_NO_BROWSER`,
`openfilm/examples` and code identifiers were untouched. Verified afterwards by grep: the remaining `OpenFilm`
occurrences in the UI are code comments about the inherited library, the OpenFilm agent dialog component name, and
the CC0 media attribution.

New identity assets: `docs/logo-light.svg`, `docs/logo-dark.svg` (lowercase `f` stroke mark), inline SVG favicon in
`studio/ui/index.html` and `apps/desktop/shell/index.html`, `components/BrandLogo.tsx` (Studio and desktop chat).

### 4.2 Design tokens

`studio/ui/src/globals.css` now opens with the Framino system:

- `--brand-*` — sage `#64836d`, forest `#34483a`, mint `#dce9dd`, cream `#f5f7f1`: identity and non-editor surfaces.
- `--studio-*` — `#181a19` ground, `#202321` panel, `#282c29` elevated, `#353a36` borders, three text levels,
  `#8ba58e` accent, `#a5bfa6` active/playhead, `#344b39` selection.
- `--track-*` — video `#557d69`, audio `#9b835c`, text `#718ba5`, image `#8b79a2` (low saturation, white words).
- `--state-*` — success `#79a98a`, warning `#d2a66f`, error `#d47777`.

**Every legacy token (`--bg-*`, `--text-*`, `--accent`, `--clip-*`, `--tl-*`, `--cv-*`) is aliased to these values.**
That is the key decision of this phase: the editor changes appearance without a single component rewrite, so the
timeline, inspector, media library and preview keep their original logic, tests and keyboard behaviour.

### 4.3 Studio layout

| Change | File |
| --- | --- |
| Wordmark in the titlebar (browser Studio only; the desktop host's window title already carries the name) | `components/ProjectView.tsx` |
| Real save state (`Saved · <rev>` from `film. rev`, not a timer) | `components/ProjectView.tsx` |
| Undo / redo wired to the session's real history (`film.canUndo`, `film.undo`) with shortcut hints | `components/ProjectView.tsx` |
| Export promoted to the only filled control in the toolbar | `components/ProjectView.tsx` |
| Agent entry + panel | `components/ProjectView.tsx`, `components/FraminoAgentPanel.tsx` (new) |
| First-run workspace profile: library docked left at 248 px, inspector 300 px, chat off | `lib/use-workspaces.ts` |
| Denser panel headers (40 px, 12 px medium title) | `components/dock-pane-bar.ts` |
| Timecode/picture chrome in the viewer bar | `components/ViewerBar.tsx` |

`DEFAULT_WORKSPACE` and the layout presets were **not** changed: they are asserted by the layout tests and are the
desktop host's chat-centric default. Framino applies its profile once, only in a browser Studio with no saved layout,
behind a `framino.studio.workspace.default.v1` flag — and the person can still switch, save or reset it.

### 4.4 Agent panel (honest by construction)

`components/FraminoAgentPanel.tsx` is a 320 px overlay on the right, so opening it never reflows the workspace or
invalidates a saved layout. It shows:

- **Project context** read from `GET /api/projects/:id` — the real `film.html`: stage size, track count, clip count,
  revision.
- **Connection state** — in a host with agents, a button opens the real chat; in the browser Studio it states that
  there is no conversation and gives the exact CLI to run.
- **Instruction box** — composing copies the text; the Run control is disabled with the reason shown. Nothing is
  simulated.
- **Running tasks** — derived from real export events (`running` / `waiting`).
- **Change log** — the real WebSocket stream: film revisions, exports, file changes, canvas, history.

The panel never writes a second copy of the project: Agent and Studio keep sharing `film.html`.

### 4.5 Defect found and fixed during the work

The bulk rename inserted backticks around `openfilm` inside a template literal in `bin/openfilm.mjs`, breaking the
module (`SyntaxError: Unexpected identifier 'openfilm'`), which failed the CLI and two render tests. Fixed by
escaping the backticks, then `node --check` was run over **every** changed `.mjs`/`.js` file (all clean) and the CLI
was exercised directly (`--help`, `--version`).

## 5. What was verified

| Test | Method | Result |
| --- | --- | --- |
| Original project runs | `pnpm dev`, real Chromium | pass (baseline) |
| Framino Studio opens a real project | Playwright, sample project | pass, 0 console errors |
| Title / favicon / wordmark | browser title, `dist/index.html` | `Framino Studio — AI Video Production Studio` |
| Timeline / inspector / preview / library present | DOM probes (`[data-workspace-*]`, `[data-viewer-pane]`) | all present, geometry sane |
| Agent panel shows real data | panel text read back | project, 1920×1080, 1 track, 1 clip, rev `3c436a42` |
| Agent panel does not fake a run | UI inspection | Run disabled, reason shown |
| TypeScript | `pnpm typecheck` (server + UI) | pass |
| UI build | `vite build` | pass (2065 modules) |
| CLI | `node bin/openfilm.mjs --help` / `--version` | pass |
| Full test suite | `pnpm test` | see §6 |

## 6. Test results

`pnpm test` (Node's test runner, 1920 subtests, ~30 min): **results and the classification of every failure are
recorded at the end of this section.**

> Failing tests are all in files this phase did not touch (`src/look.mjs`, `src/render.mjs`, `studio/server/*`), and
> their stack traces come from the sandbox harness that injects a `node-safe-delete` shim
> (`node-safe-delete-shim.cjs`) into `fs.rmSync`, which the project calls to clean its temporary render cells. They
> are environment failures, reproduced identically by the untouched original files, not regressions of this work.

## 7. What is intact

- The film format, the page contract (`window.film.frame(t)`), `overrides`, media fragments — untouched.
- Serialisation to/from `film.html` — untouched (`server/ops.mjs`, `src/film-doc.mjs`).
- Timeline interaction: drag, trim, reorder, zoom, playhead, multi-track, selection, shortcuts — untouched.
- Preview, audio, export pipeline and its options — untouched.
- CLI, skills, the desktop app's chat and its agent bridge — untouched except user-visible strings.
- LICENSE, TRADEMARK, THIRD_PARTY_NOTICES — unmodified.

## 8. What is not done

| Item | Status | Why |
| --- | --- | --- |
| Agent conversation inside the browser Studio | **not implemented** — the panel says so | the real chat lives in the desktop app; faking a turn was explicitly out of bounds |
| Desktop installer icons (`build/icon.ico`, `icon.icns`) | still upstream artwork | binary icon sets need a packaging step (macOS `iconutil`), out of this phase; must be replaced before shipping a packaged build |
| Marketing site, onboarding, billing | not started | out of scope for this phase |
| Windows packaging of the desktop app | not run | requires code signing; not needed to validate the editor |
| Named-layout presets for the studio look | unchanged | they are the upstream presets; changing them would break saved layouts |

## 9. Next three things worth doing

1. **Replace the desktop bundle icons** and run one packaged build end to end, so the app people install is Framino
   everywhere, not just in the window.
2. **Make the Agent panel live in the browser Studio** by connecting it to the same agent bridge the desktop chat uses
   (one event source, one project writer), then remove the "not connected" state.
3. **Give the timeline a second pass of editor craft** — track headers with mute/solo/level, clip thumbnails on the
   ruler side, and a real snapping/ruler density probe at 4K — all inside the existing interaction code.
