# Framino — Next Development Plan

> Written 2026-11-14 against `d63f7ef` on `main`, by reading and running the code. Supersedes
> `FRAMINO_PHASE2_PLAN.md` as the execution order. That plan's *reasoning* still holds; three of its facts
> are now out of date and two things it did not know about change the order.

## What I verified, and how

Every claim below came from a command run in this checkout, not from a document.

| Check | Command | Result |
| --- | --- | --- |
| HEAD | `git log --oneline -1` | `d63f7ef`, clean tree |
| Phase 2 code | `Test-Path packages/framino-production` | **absent** |
| Manifest anywhere | `Get-ChildItem -Recurse -Filter manifest*.json` | **none** |
| Skills present | `Get-ChildItem skills` | only `framino` (edit / media / canvas) |
| Deps installed | `corepack pnpm install --frozen-lockfile` | clean, `pnpm-lock.yaml` hash unchanged |
| Typecheck | `corepack pnpm typecheck` | **passes**, 3 of 4 projects |
| Format round-trip | `readFilmFile` → `filmHtml` on a two-clip film | `data-*` and stage intact |
| Rewrite stability | `filmHtml` applied 3× to a full document | **byte-identical every pass** |
| Rewrite stability, fragment | same, on a `<meta>`-only film | **grows 1 byte per pass** (see §Risk 1) |
| `--force` de-dup | grep `force` in `get.mjs` + `providers/*.mjs` | declared for `video`, **read only by `asr`** |
| Generation service | `openfilm get video --help` | **"Not connected here"** |
| `openfilm look` | on `.dev/sample` | works: `1920×1080 · 4s`, 12 frames drawn twice, same picture |
| Public audit | `node scripts/audit-public.mjs --no-secrets` | **174 findings, all CJK** (see §Risk 2) |

## Three corrections to the current plan

1. **`packages/openfilm` is not linked into `node_modules`.** The workspace has `packages/*`, but
   `node_modules/openfilm` does not exist after a clean install, so `import 'openfilm/film-doc'` fails with
   `ERR_MODULE_NOT_FOUND`. The Adapter must either import `film-doc.mjs` by a relative path that climbs to
   `packages/openfilm/src/`, or `openfilm` must be added as a real workspace dependency of the new package.
   Decide this before writing the first line, because it decides whether `packages/framino-production` can be a
   package at all.
2. **The format is stable to write through, but only for full documents.** `filmHtml` is idempotent on a
   `<!doctype html>` document and drifts on a `<meta>`-only fragment. `openfilm open` writes the full form
   (`projects.mjs:158`, `EMPTY_FILM`), so real projects are safe. The Adapter must never hand-write the
   fragment form the old plan's acceptance test describes.
3. **`main` is red.** CI's `audit` job runs `node scripts/audit-public.mjs`, which reports 174 CJK findings:
   166 in `docs/FRAMINO_ARCHITECTURE_AUDIT.md`, 8 in `FraminoAgentPanel.tsx`. The plan's Step 4 says "run the
   E2E for real"; it cannot be called done while CI is failing for an unrelated reason.

## The order I would use

The old plan's Step 1 → 4 sequence is right. What changes is what Step 1 has to prove, and that Step 0 exists.

### Step 0 — Make `main` green again (half a day)

Not Phase 2 work, but it gates every later "done".

- `docs/FRAMINO_ARCHITECTURE_AUDIT.md` is 5,247 CJK characters against 1,780 Latin words. It is the only
  document in the repo written in Chinese prose, and four files link to it (`README.md:158`,
  `README.zh-CN.md:131`, `FRAMINO_CONTEXT.md:174`, `FRAMINO_ARCHITECTURE.md:4`). Either translate it to English
  (the audit's rule: English prose, Chinese only in `*.zh-CN.md`) or move it to `FRAMINO_ARCHITECTURE_AUDIT.zh-CN.md`
  and fix the four links. **Translate, do not rename** — the file is the inherited-architecture record that
  hard rule 1 depends on, and a `.zh-CN.md` name would make it look like a translation of something else.
- `FraminoAgentPanel.tsx:54-62` holds its Chinese strings in a local `WORDS` map instead of
  `studio/ui/src/i18n/`. The file already imports `useLanguage` from there. Move the 8 strings into
  `zh-CN.ts` and the other four dictionaries, delete the local map.
- **Acceptance**: `node scripts/audit-public.mjs --no-secrets` exits 0. Nothing else in this plan starts
  before that.

### Step 1 — Adapter, alone, against a hand-written manifest

Build `packages/framino-production` with the manifest reader/writer and the Adapter. No other module.

- **Why first, unchanged**: no API key, no spend, no network. A hand-written `production/manifest.json` plus
  local clips is a complete test.
- **What it must prove, beyond the old plan**: not just "a manifest becomes a film", but that
  **assemble → write → re-read → assemble is a fixed point.** `film_rev` in contract §4 is a `sha256` of
  `film.html`; if a second assembly changes the file, the Adapter can never tell "the person edited this" from
  "I wrote it again", and the re-assembly rule in `FRAMINO_PROJECT_ADAPTER.md` silently breaks. Test it as a
  property: assemble twice, assert byte-identical, and assert `film_rev` is unchanged.
- **Acceptance**:
  1. A hand-written manifest becomes a `film.html` that `openfilm look` reports no problems for.
  2. It opens in Studio, 0 console errors.
  3. Edit → save → reopen → re-assemble keeps the person's edits, and the second assembly is byte-identical
     to the first.
  4. `production/manifest.schema.json` exists and the manifest validates against it.
- **Also decides**: the import question in §Corrections 1. Write the answer in the module doc.
- **Do not** use the `<meta>`-only fragment as a fixture. Use `filmHtml(EMPTY_FILM)` output, which is what
  `openfilm open` really writes.

### Step 2 — Asset Pipeline, still no spend

`validate()` and `record()` per contract §8, using ffprobe the way `providers/common.mjs` already does
(`mp4Facts`, `mediaSeconds`).

- **Why second**: needs no vendor. Steps 1 + 2 are a complete offline chain.
- **Acceptance**: a valid clip is recorded `valid` with real `media` facts; a truncated file, a zero-byte file
  and a non-media file are each `invalid` with the right `invalid_reason`, and none reaches `film.html`.
- **Fixture**: generate the clips with `ffmpeg` (already on PATH, 8.0.1) rather than committing binaries —
  `testsrc` for the valid one, `head -c` truncation for the broken ones. They are `origin: "agent-code"`.

### Step 3 — The ledger, before the first real call

`skills/framino-production/`, plus the task ledger from contract §6.

- **The hazard is confirmed at HEAD, not inherited from a stale doc.** `--force` is declared for `video`
  (`get.mjs:122`) and the only code that reads it is the `asr` path (`get.mjs`, `if (verb === 'asr' && args.force !== true …`).
  No provider reads it. The help text still promises "the same request again returns the same clip". So there
  is no de-duplication anywhere, and the ledger is the only thing between a restart and a second charge.
- **Acceptance**: kill the process mid-run, restart, no shot is generated twice; one transcript each from
  Codex and Claude Code.
- **Blocked on the person**: this is the first step that needs a connected service, and `openfilm get video`
  currently reports none. Steps 0–2 do not.

### Step 4 — E2E, real and test assets counted apart

The 12 steps in `FRAMINO_E2E_TEST_REPORT.md`, run for real, each row filled with the command and its output.

- **Acceptance**: the Coffee Brand Commercial demo, 3–5 shots, every asset's `origin` recorded, real and
  `agent-code` assets counted separately, export verified with ffprobe.
- **Blocked on the person**: same dependency as Step 3. Until a service is connected, rows 4–6 and 12 can be
  filled with `agent-code` fixtures and must say so.

## Risks, in the order they would bite

1. **Fragment drift.** `filmHtml` adds a newline before `<section>` on each pass when the film has no
   `<head>` (`film-doc.mjs:1109-1113`, the `else` branch after `layout.viewport` is absent). Full documents
   are unaffected. Mitigation: the Adapter only ever writes documents produced by `filmHtml`, and Step 1's
   fixed-point test fails loudly if this ever reaches a real project. Do **not** patch `film-doc.mjs` — hard
   rule 1.
2. **CI red on `main`.** 174 CJK findings. Any PR opened before Step 0 lands inherits a failing check that has
   nothing to do with it, and the habit of ignoring red CI starts here.
3. **No generation service connected.** The one external dependency, and the person's decision. It does not
   block Steps 0–2, which is exactly why they come first.
4. **`node_modules` is not linked for `openfilm`.** Cheap to fix, expensive to discover mid-build.

## What not to do

- **Do not start four modules in parallel.** The contract has never been executed. One module first.
- **Do not build a gateway.** Dropped 2026-11-14; `openfilm get video` is the path.
- **Do not build de-duplication into the CLI.** `--force` is a compatibility surface; the ledger is Framino's job.
- **Do not touch** `film-doc.mjs`, `SPEC.md`, `ops.mjs`, `timeline.mjs`, `host.mjs` or `.film/`. Hard rules 1 and 3.
- **Do not present a fixture clip as generated.** `origin: "agent-code"`, `data-framino-test="true"`.
- **Do not rename `FRAMINO_ARCHITECTURE_AUDIT.md` to a `.zh-CN.md` name to silence the audit.** Translate it.

## Suggested first commit

Step 0, as one commit: the audit document in English, the Agent panel strings moved into `i18n/`, and
`node scripts/audit-public.mjs --no-secrets` exiting 0. It is small, it is verifiable, and it makes every
commit after it honest.
