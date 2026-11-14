# Framino — Phase 2 Development Plan

> Written 2026-11-14 against `b06587e` on `main`. Supersedes the five-agent parallel plan in
> `FRAMINO_CONTEXT.md` §7 as the *execution order*; §7 still describes the modules correctly.

## Where the project actually is

Verified by reading the code, not the docs:

| Thing | State |
| --- | --- |
| `packages/framino-production` | **does not exist** |
| manifest code anywhere in the repo | **none** — no `manifest.json`, no reader, no writer |
| Contract `FRAMINO_INTEGRATION_CONTRACT.md` | **v0.2, 320 lines, complete** |
| Module docs (Adapter, Skill, Generation, Pipeline) | all say **not started** |
| E2E report | 12 steps, **0 run** |
| Phase 1 (brand, Studio, design system) | done, shipped on `main` |

So: the design is finished and the implementation has not begun. That is a good place to be, and it changes
what the plan should be.

## The interfaces were checked, not assumed

Everything the Adapter and Pipeline depend on was run before this plan was written:

- `readFilmFile` → `filmHtml` round-trips a `film.html` with two clips, `data-shot-id` and `data-asset-id` intact.
  Writing back reindents `<section>` children to two spaces and changes nothing else. **The format is safe to
  write through**, which is the single fact the Adapter rests on.
- `openfilm/film-doc` resolves as a package export (`package.json` `exports`).
- `ffmpeg` and `ffprobe` are on `PATH`; Node 24.12.0; corepack 0.34.5.
- `pnpm-workspace.yaml` already globs `packages/*`, so a new package needs no workspace edit.
- `openfilm get video` exists with `--prompt --out --duration --aspect-ratio --via --model`.

## What is wrong with the current plan

`FRAMINO_CONTEXT.md` §7 proposes five agents in parallel after the contract is frozen. The contract *is* frozen.
Running five agents now would put four of them on a manifest schema that **no code has ever read or written**.
Each would implement its reading of §4, and the first integration would be a reconciliation.

The contract is a good draft. It is not yet a *tested* draft. Until something writes a manifest and something
else reads it back, every module is guessing at the same spec independently.

## The order I would use

### Step 1 — Adapter alone, against a hand-written manifest

Build `packages/framino-production` with the manifest reader/writer and the Adapter. No other module.

- **Why first**: it is the only module testable with no API key, no spend and no network. A hand-written
  `production/manifest.json` plus local test clips is a complete test.
- **Why alone**: it is the module that proves §4 is executable. If the schema is wrong, that is learned on day
  one instead of after three modules depend on it.
- **Acceptance**: a hand-written manifest becomes a `film.html` that `openfilm look` reports no problems for,
  opens in Studio, and survives edit → save → reopen → re-assemble with the person's edits intact.
- **Also produces**: `production/manifest.schema.json`, which §4.2 currently defers to "once Agent 1 builds it".

### Step 2 — Asset Pipeline, still no spend

`validate()` and `record()` per contract §8, using ffprobe the way `providers/common.mjs` already does.

- **Why second**: it needs no vendor either. It turns files on disk into `assets[]` entries, which the Adapter
  then places. Steps 1 and 2 together are a complete offline chain.
- **Acceptance**: a valid clip is recorded `valid` with real `media` facts; a truncated file, a zero-byte file
  and a non-media file are each recorded `invalid` with the right `invalid_reason`, and none reaches `film.html`.

### Step 3 — The Skill, and the ledger that protects money

`skills/framino-production/`, plus the task ledger from contract §6.

- **Not a new generation path.** `openfilm get video` already exists and is the only path. Module 3 in §7 is
  not a build task; it is the ledger, and the ledger belongs to whoever calls the CLI.
- **The hazard, stated plainly**: `--force` is declared at `get.mjs:122` but **no provider reads it and `get.mjs`
  never checks it**. The CLI's help text promises "the same request again returns the same clip" and that is not
  implemented. So there is no de-duplication anywhere. The ledger is the *only* thing between a restart and a
  second charge. Build it before the first real call, not after.
- **Acceptance**: kill the process mid-run, restart, and no shot is generated twice. One transcript each from
  Codex and Claude Code, as `FRAMINO_VIDEO_SKILL.md` already requires.

### Step 4 — E2E, with real and test assets counted apart

The 12 steps in `FRAMINO_E2E_TEST_REPORT.md`, run for real, each row filled with the command and its output.

- **Acceptance**: the Coffee Brand Commercial demo, 3–5 shots, every asset's `origin` recorded, real and
  `agent-code` assets counted separately, export verified with ffprobe.

## What not to do

- **Do not start four modules in parallel.** The contract has never been executed. One module first.
- **Do not build a gateway.** Dropped 2026-11-14 and correctly so; `openfilm get video` is the path.
- **Do not build de-duplication into the CLI.** `--force` is a compatibility surface already declared; the
  ledger is Framino's job and contract §6 says so.
- **Do not touch `film-doc.mjs`, `SPEC.md`, `ops.mjs` or `.film/`.** Hard rule 1 and 3.
- **Do not present a fixture clip as generated.** `origin: "agent-code"` and `data-framino-test="true"`.

## The one thing that could stop all of it

A real generation call needs a service connected in Studio (Settings → Services) with the person's own key, or
the OpenFilm service, or a local model. Steps 1 and 2 need none of that. Step 3's first real call does, and
Step 4's demo does. **That is the only external dependency in the plan, and it is the person's decision, not a
build task.**

## Suggested first commit

`packages/framino-production/` with `package.json`, `src/manifest.mjs` (read/write/validate, atomic writes per
§4), `src/adapter.mjs` (manifest → `film.html` through `film-doc`), and one test that round-trips a
hand-written manifest into a film the format accepts. Nothing else.
