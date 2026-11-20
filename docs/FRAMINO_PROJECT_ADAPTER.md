# Framino — Project Adapter (Agent 1)

> Status: **implemented and verified offline** (2026-11-19); awaiting Studio E2E and a connected service.
> Owner: Agent 1. Contract: `FRAMINO_INTEGRATION_CONTRACT.md` §1–§4, §8, §9.

## Job

Turn `production/manifest.json` into a `film.html` Studio opens, and read `film.html` back into
`manifest.assembly` after the person edits. Verify: open, edit, save, reopen, export.

## Ground truth to build on

- The format: `packages/openfilm/SPEC.md` §1. There is no JSON schema; `film.html` is the project.
- Read and write only with `openfilm/film-doc` (package export): `readFilmFile(text)` → `{ value, layout, … }`,
  `filmHtml(value, before)` writes back preserving untouched text. See `film-doc.d.mts` for types
  (`FilmClip` :44, `readFilm` :110, `filmHtml` :116).
- The value shape: `{ stage: { w, h }, tracks: [{ clips, locked?, hidden?, muted?, attrs?, captions? }], keyframes? }`
  (`studio/server/ops.mjs:14`). Clip fields by kind: `film-doc.mjs:126-129`. `attrs` holds `data-*`.
- A still or a page without a duration needs `#t=0,length` (SPEC §1).
- Studio's edit ops are by clip id (`ops.mjs` header). Splits copy `data-*` and mint new ids (`ops.mjs:172-200`).
- Fades: `overrides='[{"fade":[in,out]}]'`.

## Mapping (first proposal, confirm in the contract)

| Manifest | film.html |
| --- | --- |
| `video.width/height` | `<meta name="viewport" content="width=…, height=…">` |
| shots in `order`, `selected_take` asset | `<video>` on the `video` track, `at` = running sum of durations, `src="…#t=0,dur"` |
| `shots[].voiceover` asset | `<audio>` on the `voiceover` track at the shot's `at` |
| `audio.music` | `<audio>` on the `music` track, `volume` = `music_volume` |
| `shots[].subtitle` | a cue in `captions/film.vtt` (cue id = `shot_id`), one caption track on top |
| IDs | `data-shot-id`, `data-scene-id`, `data-asset-id`; tracks `data-framino-track` |

## Re-assembly rule

When film.html already exists, the Adapter changes **only** clips it placed (`data-shot-id` present) whose take
changed, and adds shots that are missing. It never moves, retimes or deletes a clip the person edited. Detect "edited"
by comparing with `manifest.assembly.film_rev` and the clip's values at that revision.

## Status

_Verified 2026-11-19 against the code in `packages/framino-production/`. Contract sections linked where relevant._

### 1. What was implemented

The manifest ⇄ film.html chain of contract §1–§4, §8, §9, in four modules:

- `src/manifest.mjs`: the Production Manifest file — parse, validate (`problemsIn`), atomic read/write (`writeManifest`,
  `updateManifest` with `updated_at` ownership check per §4.1), the id minters of §2, the `request_key` hash of §6,
  and the `ManifestError` shape of §7. This is the package's default export (`paths .` and `./manifest`).
- `src/film.mjs`: the single bridge to `film-doc.mjs`. `packages/openfilm` is not linked into `node_modules` after a
  clean install, so every Framino import of `film-doc` goes through here by relative path (the decision and why are in
  the file header). Re-exports `readFilmFile`/`filmHtml`, plus `filmRev` (sha256, matching Studio's 16-char prefix),
  `readFilmAt`, `clipsOfShot` (find by `data-shot-id`, never clip id, §2.1), `assertStable` and helpers.
- `src/adapter.mjs`: `assemble(root, manifest)` places each shot's selected take on the video track (running-sum `at`,
  `#t`-style length, fade), voiceovers on `voiceover`, the music bed on `music` (level from `manifest.audio`), captions
  into `captions/film.vtt` (cue id = shot id), and writes `assembly` (`film_rev`, `at`, `placed`). `readAssembly` reads
  `film.html` back into `assembly`. Only `valid` assets are placed (§8); `agent-code` assets get
  `data-framino-test="true"` (§9). Tracks carry `data-framino-track` in §2.1's layer order.
- `src/film.mjs` + `adapter.mjs` together enforce the fixed point: `assemble` computes the text, checks it is stable
  under `filmHtml` (`assertStable`), and writes only when it actually differs — so assembling twice is byte-identical
  and `film_rev` can tell a person's edit from the Adapter's own write.
- `production/manifest.schema.json`: the JSON Schema of §4.2, draft 2020-12. `test/schema.test.mjs` (4 tests) proves it
  accepts a real manifest, rejects the fields both it and `problemsIn()` can check, and keeps unknown fields (§4.2).

The re-assembly rule is implemented: after the first assembly the film is the source of truth for placement. A clip's
`at` is never touched; a person's clip and a clip they deleted are left alone; a changed take rewrites only that clip's
`src`; a shot added later is placed without disturbing existing clips. `edited` is reported from the `film_rev` compare.

### 2. Files changed

- `packages/framino-production/src/{manifest,film,adapter,assets}.mjs` and `test/*.test.mjs` — the package as built
  (this module owns `manifest*` and `adapter*`; `assets*` is Agent 4's).
- `packages/framino-production/src/adapter.mjs` — repaired three comment lines where em dashes and a `§` had been
  corrupted into U+FFFD characters; comments only, no behavior change.
- `packages/framino-production/production/manifest.schema.json` + `test/schema.test.mjs` (2026-11-20) — the §4.2
  schema and its consistency test, closing the last Step 1 acceptance item.
- `docs/FRAMINO_PROJECT_ADAPTER.md` — this status section and the status line.
- `packages/framino-production/package.json`, `tsconfig.json` — package wiring (`exports` for `./manifest`, `./film`,
  `./adapter`, `./assets`; test and typecheck scripts).

### 3. Architecture and interfaces

Consumed: contract §1 (no JSON schema; `film.html` is the edit), §2 (ids and `data-*` placement), §3 (project layout),
§4 (manifest shape and field ownership), §8 (validity), §9 (real vs test), and `packages/openfilm/SPEC.md` §1 plus
`src/film-doc.mjs` (the format). `film.html` is written only through `film-doc.mjs` — hard rule 3 — never templated.

Produced (contract §4.1, §5): `manifest ⇄ film.html` and `captions/film.vtt`; `manifest.assembly` and
`shots[].status = placed` are this module's fields. Public API of the package: `readManifest`, `writeManifest`,
`updateManifest`, `problemsIn`, `requestKey`, the id minters, `assemble`, `readAssembly`, and the `film.mjs` helpers.

### 4. How to run

From the repo root, Node 22.18+ and `corepack pnpm` 9.15.9:

```
node packages/openfilm/bin/openfilm.mjs open <project-folder>     # create the empty film.html first
# then, in code:
import { readManifest } from '@framino/production/manifest';
import { assemble, readAssembly } from '@framino/production/adapter';
const result = await assemble(root, await readManifest(root));    # root = the project folder
```

`assemble` needs a valid `production/manifest.json` (written per §4) and expects media paths from §3; it does not check
the media bytes themselves (that is Agent 4's `validate()`). Options: `{ now, fade }` (`fade: 0` for a hard cut).

### 5. How to test

```
node --test packages/framino-production/test/manifest.test.mjs    # manifest: 18 tests
node --test packages/framino-production/test/adapter.test.mjs     # adapter:  12 tests
node --test packages/framino-production/test/schema.test.mjs      # schema:    4 tests
corepack pnpm --filter @framino/production test                   # all five files (includes Agent 4's assets)
corepack pnpm --filter @framino/production typecheck
node scripts/audit-public.mjs --no-secrets
```

The adapter tests use hand-written manifests and temp folders (no service, no spend): a two-shot manifest reads back
with every `data-*` and the right stage; assembling twice is byte-identical with unchanged `film_rev`; invalid and
unselected takes stay out; `agent-code` clips are tagged; a person's edit, deletion, added shot, changed take, split
clip and the music/voiceover levels all behave per the re-assembly rule; a project with no `film.html` starts from the
format's full empty document. Fixtures are not video files, so no asset is presented as generated (§9).

### 6. Test results

Run 2026-11-19 on this checkout (Windows, Node 22.22.2):

| Command | Result |
| --- | --- |
| `node --test packages/framino-production/test/adapter.test.mjs` | **12 pass, 0 fail** (twice, before and after the comment repair) |
| `node --test packages/framino-production/test/manifest.test.mjs` | **18 pass, 0 fail** |
| `node --test packages/framino-production/test/assets.test.mjs` | 23 pass, 0 fail (Agent 4's; context) |
| `node --test packages/framino-production/test/schema.test.mjs` | **4 pass, 0 fail** (2026-11-20) |
| `corepack pnpm --filter @framino/production test` | **57 pass, 0 fail, 0 cancelled, 0 skipped, 0 todo** (2026-11-20; 53 before the schema was added) |
| `corepack pnpm --filter @framino/production typecheck` | passes (no errors) |
| `corepack pnpm typecheck` (whole workspace) | passes, 4 of 4 projects |
| `node scripts/audit-public.mjs --no-secrets` | **No findings** |

Nothing above is marked passing that was not actually run. The raw CI audit command (without `--no-secrets`) could not
run here because `gitleaks` is not installed on this machine; the secret scan is an environment dependency, not a code
result.

### 7. Known issues

- The schema is checked by a test-only validator that implements only the keywords the schema uses; no general JSON
  Schema library was added. A full validator would be ajv, which is not in the dependency tree and would require
  editing `package.json` and the lockfile (Agent 5's files, AGENTS.md rule 5). Production validation stays in
  `problemsIn()`; the schema is the published §4.2 contract for tooling and people.
- JSON Schema cannot express id uniqueness and cross-section references (e.g. a task's `shot_id` naming a real shot);
  those rules live only in `problemsIn()`, so the schema alone is not a complete validator.
- The `edited` detection is coarse: any `film_rev` mismatch marks the whole film as the person's, which is safe (it only
  makes the Adapter more conservative) but cannot attribute a specific change.
- `EMPTY_FILM`/`emptyFilmText()` assume the full `<!doctype html>` document that `openfilm open` writes. The `<meta>`-only
  fragment form drifts on rewrite (`film-doc.mjs`); the Adapter never produces that form, but a project hand-edited into
  it is out of scope.
- Studio open/edit/save/reopen/export, and a real connected generation service, are not covered here — they are E2E
  steps 8–12 (Agent 5) and need a service connected in Studio.

### 8. Next steps

1. Run `openfilm look` on an assembled project, then Studio open → edit → save → reopen → re-assemble → export (E2E 8–12).
2. Connect a video service in Studio and run the Coffee Brand Commercial demo end to end (needs the person's key).
3. Keep this status honest: update the E2E report (`docs/FRAMINO_E2E_TEST_REPORT.md`) only with commands actually run.
