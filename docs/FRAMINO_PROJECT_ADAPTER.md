# Framino — Project Adapter (Agent 1)

> Status: **not started**. Owner: Agent 1. Contract: `FRAMINO_INTEGRATION_CONTRACT.md` §1–§4, §8, §9.

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

_Fill in when done: AGENTS.md "When you finish", items 1–8._
