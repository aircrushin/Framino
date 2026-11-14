# AGENTS.md — rules for every agent working on Framino

Codex reads this file. Claude Code reads it through `CLAUDE.md`. Both get the same rules.

## Read first, in this order

1. `FRAMINO_CONTEXT.md`: product, goals, phase. Its §13 lists what the code already does.
2. `docs/FRAMINO_INTEGRATION_CONTRACT.md`: IDs, the Production Manifest, errors, ownership. Binding.
3. `docs/FRAMINO_ARCHITECTURE.md`: where each Phase 2 module sits in the real code.
4. The doc for your module: `docs/FRAMINO_{PROJECT_ADAPTER,VIDEO_GENERATION,ASSET_PIPELINE,VIDEO_SKILL}.md`.
5. `packages/openfilm/SPEC.md` before touching anything that reads or writes `film.html`.

## Environment

- Node 22.18+, **pnpm 9.15.9 through corepack** (`corepack pnpm …`). A system pnpm 10 rewrites `pnpm-lock.yaml`. Do not
  use it.
- ffmpeg and ffprobe on `PATH`; git; headless Chromium for `look` / `render` (first run downloads it).
- Windows: PowerShell. Stop file watchers before deleting files (EPERM). If a port is reserved by Hyper-V, use another.

| Command | What it does |
| --- | --- |
| `corepack pnpm install --frozen-lockfile` | install; must leave `pnpm-lock.yaml` unchanged |
| `corepack pnpm dev` | source Studio on `127.0.0.1:4848`, state in `packages/openfilm/.dev/` |
| `corepack pnpm typecheck` | server + UI + shared + desktop |
| `node --test <file>` | one test file (the full `pnpm test` takes about 25 min) |
| `corepack pnpm test` | everything, serially |
| `node scripts/audit-public.mjs` | the CI public audit: CJK prose, home paths, out-of-repo paths, deps, secrets |
| `node packages/openfilm/bin/openfilm.mjs <cmd>` | the CLI from source: `open`, `look`, `render`, `get`, `skill`, … |

## Hard rules

1. **Do not change the format.** `packages/openfilm/SPEC.md`, `src/film-doc.mjs`, `src/timeline.mjs`, `src/host.mjs`,
   `studio/server/{film,ops,person-edits,person-merge*,history*}.mjs`. Framino metadata goes in `data-*` attributes.
2. **Do not rename compatibility surfaces**: the `openfilm` command and npm package, `exports` paths, `OPENFILM_*`
   variables, `~/.openfilm`, `.film/`, `openfilm.*` localStorage keys, `/api/` routes, the `product` id
   `openfilm-studio`. The audit, §2.1 and §9, explains each.
3. **Write `film.html` only through `film-doc.mjs`** (`readFilmFile` → change the value → `filmHtml(value, before)`),
   or through Studio's edit API. Never string-template HTML. Never write `.film/`.
4. **Reuse before you build.** Generation is `openfilm get` + a provider (`studio/server/providers/contract.mjs`).
   Metadata and thumbnails are `studio/server/derived.mjs`. Export is `studio/server/exports.mjs` / `openfilm render`.
   Saving and versions already happen. If you think you need a second one, write down why in your module doc first.
5. **Stay in your lane.** Edit only files your module owns (see the table below). A change to a shared file
   (the contract, `providers/index.mjs`, `get.mjs`, `MANUAL.md`, `package.json`) is proposed in your report and made by
   Agent 5, or by you after Agent 5 agrees in the contract's change log.
6. **No new large dependency** without a line in your module doc saying why the stdlib or an existing one will not do.
   The repo builds from npm and this repository alone (`audit:public` `deps`).
7. **Never present a mock as real.** Every asset records its `origin` in the manifest (`provider:<id>`,
   `openfilm-service`, `local`, `library`, `person`, `agent-code`). A hand-made or fixture clip is `agent-code`, and its
   clip in film.html carries `data-framino-test="true"`. Reports count real and test assets separately.
8. **Secrets**: the person's service keys live in Studio's Settings (`keys.mjs`) or their own environment. Framino code
   never stores, proxies or logs one. Never log a key, a bearer token or a signed URL. `.env*` is ignored by git.
9. **Spending needs the person.** A video clip is confirmed in Studio (`get.mjs` `approve`). Never pass `--yes` unless
   the person already agreed in this session. On `balance`, stop and tell them.
10. **Language**: code, comments, file names and docs in English. Chinese prose only in `*.zh-CN.md` and i18n files,
    or CI fails. User-visible UI strings go through `studio/ui/src/i18n/` in all five languages.

## File ownership in Phase 2

| Module | Owns (create freely) | Touches only with Agent 5's agreement |
| --- | --- | --- |
| 1 Project Adapter | `packages/framino-production/src/adapter*`, `docs/FRAMINO_PROJECT_ADAPTER.md` | — |
| 2 Video Skill | `skills/framino-production/`, `docs/FRAMINO_VIDEO_SKILL.md` | `packages/openfilm/MANUAL.md`, `manual/` |
| 3 Video Generation | `docs/FRAMINO_VIDEO_GENERATION.md` (no new service; the task ledger and resume rules) | — |
| 4 Asset Pipeline | `packages/framino-production/src/assets*`, `docs/FRAMINO_ASSET_PIPELINE.md` | — |
| 5 E2E | `docs/FRAMINO_INTEGRATION_CONTRACT.md`, `docs/FRAMINO_ARCHITECTURE.md`, `packages/framino-production/{package.json,src/manifest*,test/e2e*}`, `docs/FRAMINO_E2E_TEST_REPORT.md`, this file | everything shared |

`packages/framino-production` does not exist yet. It is the proposed home for the adapter, the pipeline and the
manifest; the workspace already includes `packages/*` and `apps/*` (`pnpm-workspace.yaml`). Whoever creates it first adds
only that folder. There is no gateway package: generation is the built-in `openfilm get video`.

## Before you start

State, in your first message or note: the task, the files you will change, the interfaces you consume and produce
(by contract section), and what you will not touch.

## When you finish

Report, in your module doc's "Status" section:

1. What was implemented.
2. Files changed.
3. Architecture and interfaces (link contract sections).
4. How to run.
5. How to test.
6. Test results: the command and its real output (pass/fail counts). Nothing marked passing that was not run.
7. Known issues.
8. Next steps.

Update `FRAMINO_CONTEXT.md` §7 only if the phase status actually changed.

## Principles

Understand the existing architecture, then make the smallest necessary change. A complete working flow beats a pile
of isolated features. Do not over-design; do not trade away editability for a quick demo.
