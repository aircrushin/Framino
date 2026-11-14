# Framino — Architecture

> The real architecture, and where each Phase 2 module plugs into it. Inherited internals are in
> `FRAMINO_ARCHITECTURE_AUDIT.md` (Chinese, Phase 1). Data shapes are in `FRAMINO_INTEGRATION_CONTRACT.md`.
> Last checked against `123e654`, 2026-11-14.

## 1. What exists today

```
pnpm monorepo (pnpm-workspace.yaml: packages/*, apps/*)
├── packages/openfilm/        npm "openfilm": format + CLI + Studio + library
│   ├── SPEC.md               the film format (film.html + window.film pages)
│   ├── src/film-doc.mjs      the one reader/writer of film.html
│   ├── src/render.mjs        rendering (Chromium + ffmpeg)
│   ├── bin/openfilm.mjs      CLI: open look render get canvas skills skill update doctor
│   ├── MANUAL.md, manual/    what the CLI prints to agents; core skills edit / media / canvas
│   └── studio/
│       ├── server/           local HTTP + WS on 127.0.0.1, project I/O, merges, history, exports, get, providers/
│       └── ui/               React editor (Framino-skinned in Phase 1)
├── packages/shared/          @openfilm/shared: types shared by Studio and desktop
├── apps/desktop/             Electron app "Framino": Studio + chat for Claude Code, Codex, Pi, others (ACP)
└── skills/framino/          the entry skill an agent installs: its manual and skills in its own folder
```

Everything is local. There is no database and no server of Framino's own.

## 2. The loop that already works

```
coding agent ──► openfilm get video --prompt … ──► Studio server get.mjs
                                                   ├─ chooseProvider (Settings or --via)
                                                   ├─ approve: the person confirms the spend in Studio
                                                   ├─ provider.run()  (fal / openrouter / google / openfilm / local)
                                                   └─ land(): files under assets/ only
coding agent ──► edits film.html (or Studio edit API) ──► watch.mjs ──► three-way merge, person wins ──► Studio
person ──► Studio edits ──► ops.mjs applyOps by clip id ──► film-doc filmHtml ──► atomic write ──► WS to agent
person ──► Export ──► exports.mjs ──► render-worker ──► render.mjs ──► MP4 / NLE / project zip
```

Key files: `studio/server/get.mjs` (`runGet` :305, `land` :493, `VERBS.video` :119),
`studio/server/providers/contract.mjs` (the `Provider` interface), `providers/index.mjs` (`BUILT_IN` :47),
`studio/server/film.mjs`, `ops.mjs`, `person-edits.mjs`, `watch.mjs`, `derived.mjs`, `exports.mjs`.

## 3. Phase 2 modules on top

```
        ┌──────────────── person's Codex / Claude Code ────────────────┐
        │  skills/framino-production/SKILL.md  (Agent 2)               │
        │  idea → script → storyboard → [person approves] → generate   │
        └───┬──────────────────────┬───────────────────────┬───────────┘
            │ manifest.json        │ openfilm get video     │ framino-production CLI
            ▼                      │  --via <provider>      ▼
  production/manifest.json ◄───────┼──────────── packages/framino-production (Agents 1, 4, 5)
    (contract §4)                  │               ├─ assets:   validate, probe, record   (Agent 4)
                                   │               ├─ adapter:  manifest ⇄ film.html      (Agent 1)
                                   ▼               └─ manifest: read/write/lock, schema   (Agent 5)
        providers/{fal,openrouter,google,openfilm,local}.mjs ──► the service the person connected
                                   │
                                   ▼
                         Studio land() → assets/video/
```

### Decisions this layout makes

| Decision | Why |
| --- | --- |
| **No gateway.** Generation is `openfilm get video` and the providers that already ship | Studio already does spend approval, timeouts, `assets/`-only writes, symlink checks and agent-readable receipts. A Framino service would duplicate all of it, add an account and a billing surface, and put a second party between the person and the vendor they already pay. |
| What Framino adds is a **ledger**, not a service | `get video` has no task id and no de-duplication (`--force` is declared at `get.mjs:122` but read by no provider), so a crash mid-call is invisible. Writing the task before the call and resolving it against the disk afterwards is the whole fix, and it needs no server. |
| Adapter and Pipeline live in a new package, not inside `packages/openfilm` | keeps upstream merges clean; the package imports `openfilm/film-doc` through its public `exports`. |
| The manifest lives in `<project>/production/`, not `.film/` | `.film/` is Studio's and agents must not write it; `production/` travels with the project and is not media. |
| Framino IDs are `data-*` on clips and tracks | the format keeps them (`film-doc.mjs:132`) and they survive Studio edits; no format change. |
| One shot ⇄ many clips (by `data-shot-id`) | Studio splits copy `data-*` to both halves (`ops.mjs:177`). |

### Open questions (decide in the contract before building)

1. **How the Skill drives the Adapter and Pipeline**: a CLI (`npx framino-production assemble <project>`) or an
   `openfilm` subcommand? A separate bin avoids touching `bin/openfilm.mjs`, which the audit lists as fixed.
2. **Captions**: one caption track `captions/film.vtt` built from `shots[].subtitle`, or per-voice-over transcripts
   (SPEC §Words) only? The MVP needs at least one.

## 4. Runtime boundaries

| Process | Where | Holds secrets |
| --- | --- | --- |
| Studio server | person's machine, 127.0.0.1 | the person's own service keys, in Studio Settings (`keys.mjs`), or the `*_API_KEY` variables |
| Coding agent + Skill | person's machine | none; it calls `openfilm get video`, which uses Studio's key |
| The service the person connected | the vendor's own servers | the person's account and balance; Framino never sees either |
