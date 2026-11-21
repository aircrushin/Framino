# Framino — End-to-End Test Report (Agent 5)

> Status: **offline run passed 2026-11-21** on `main` @ `310236a`. Owner: Agent 5. Every Real / test value below came
> from a command that was run; nothing is filled in from an expectation. The driver is
> `packages/framino-production/test/e2e-offline.mjs` (re-run it with `node packages/framino-production/test/e2e-offline.mjs`).
> Steps 4–6 remain blocked on a connected video service; they are not reported as passing.

## Scenario: Coffee Brand Commercial

A short 16:9 spot, 3 shots / 6 s, a voice-over on the first shot, a music bed, two captions, 1280×720. The shots are
ffmpeg `testsrc` clips with sine-wave voice-over and music — every asset is `origin: agent-code`, every placed clip
carries `data-framino-test="true"` (contract §9). **No clip in this run came from a video model.** A 30 s commercial
with real model output is the same flow with a connected service and is still to be run.

| # | Step | How it is checked | Real / test | Result |
| --- | --- | --- | --- | --- |
| 1 | Idea → `manifest.brief` | `newManifest` + `problemsIn() = 0` | test | **pass** |
| 2 | Script written, approved | `approval.script.state = approved` | test | **pass** |
| 3 | Storyboard: 3–5 shots, all contract fields | 3 shots × 14 fields, `problemsIn() = 0`, `approval.storyboard.state = approved` | test | **pass** |
| 4 | Generation through `openfilm get video` | `get video --help`: "Not connected here"; no call made | — | **blocked** (no service) |
| 5 | Restart mid-run: no shot generated twice | no real in-flight call to kill; ledger resume covered offline by `ledger.test.mjs` (11 pass) | test (offline) | **blocked** (no service) |
| 6 | Regenerate one shot | no real first take; take isolation covered by `assets.test.mjs` + `adapter.test.mjs` | test (offline) | **blocked** (no service) |
| 7 | Assets validated | 3 videos `valid` with real sha256/duration/640×360; VO + music `valid`; a text file named `.mp4` recorded `invalid` with a real reason | test | **pass** |
| 8 | Assembly | `assemble` fixed point (`film_rev` unchanged, 2nd pass writes nothing); `openfilm look`: `film 1280×720 · 6s · 5 sounds`, 12 frames drawn twice same picture, no errors | test | **pass** |
| 9 | Opens in Studio | Playwright loads `/projects/<id>` in headless Chromium, `[data-work-mode="edit"]` present, 0 page/console errors | test | **pass** |
| 10 | Edit a shot, a caption, the music level | via Studio API: shot `at` 0→0.25 s, music `volume` 0.3→0.1, caption line rewritten; `film.html` rev `920de96290`→`39b84b3c74`; reopen keeps all three | test | **pass** |
| 11 | Re-assemble after the edit | `assemble` reports `edited: true`, preserves the film byte-for-byte; `readAssembly` still finds shots by `data-shot-id` | test | **pass** |
| 12 | Export MP4 | `openfilm render --fps 10 --workers 2` → `coffee-30s.mp4`; ffprobe: `6.00 s, 1280x720, h264 + aac` | test | **pass** |

Result: **9 real offline passes, 3 blocked on a connected service, 0 failures.**

## Runs

**2026-11-21 — Windows, Node 22.22.2, ffmpeg/ffprobe 8.0.1, `main` @ `310236a`, clean tree.**

Command:
```
node packages/framino-production/test/e2e-offline.mjs
```
Raw output (the driver prints an assertion line per check; all shown here are `PASS` or `BLOCKED`):
```
STEP 1 — Idea -> manifest.brief; the manifest validates
  PASS  brief written; problemsIn() = 0 (version 0.2)
STEP 2 — Script written and approved (approval gate before generation)
  PASS  approval.script.state = approved
STEP 3 — Storyboard: 3 shots, all contract fields; approved
  PASS  3 shots, all 14 contract fields present; manifest validates
  PASS  approval.storyboard.state = approved
STEP 4 — Generation through openfilm get video
  BLOCKED  no video service connected in Studio; no real clip was generated
STEP 5 — Restart mid-run: no shot generated twice
  BLOCKED  needs a real in-flight call to kill and resume; ledger resume is covered by ledger.test.mjs offline
STEP 6 — Regenerate one shot: new take, others untouched
  BLOCKED  needs a real first take; take isolation is covered by assets.test.mjs and adapter.test.mjs offline
STEP 7 — Assets land and validate (section 8)
  PASS  3 video takes valid with real sha256, duration and 640x360 probed by ffprobe
  PASS  voiceover and music bed valid with real audio streams
  PASS  a text file named .mp4 is invalid with a real reason: "the file is not media: nothing in it is a video, picture, audio or subtitle container: assets/video/broken-t1.mp4"
STEP 8 — Assembly: manifest -> film.html, checked by openfilm look
  PASS  assembled: 5 clips added, shots placed = {"sh01":["sh01","sh01-vo"],"sh02":["sh02"],"sh03":["sh03"]}
  PASS  3 caption cues written to captions/film.vtt
  PASS  assembly is a fixed point: second pass writes nothing, film_rev 920de9629096a9fc347c08240f2bbfe9a700de966fcc6d6b9bd1747b5db56f88 unchanged
  PASS  every placed clip carries data-framino-test="true" (5 clips, §9)
  PASS  openfilm look: no errors, no page/request errors
    film  1280×720 · 6s · 5 sounds
    ♪ 0s  assets/audio/vo-sh01.wav  2s  peak -18 dB
    ♪ 0s  assets/audio/music-bed.mp3  6s  peak -29 dB
    ♪ mix  -22.7 LUFS integrated · true peak -16.4 dBTP
    ✓ 12 frames drawn twice, in two shuffled orders: same t, same picture
STEP 9 — The assembled film opens in Studio with 0 console errors
  PASS  Studio loaded the project, 0 console/page errors (0)
STEP 10 — Edit a shot, a caption and the music level in Studio
  PASS  film.html rev changed 920de96290 -> 39b84b3c74
  PASS  shot at = 0.25 s and music volume = 0.1 written to film.html
  PASS  caption line edited in captions/film.vtt
  PASS  reopened Studio: no errors and the edited film.html is unchanged
STEP 11 — Re-assemble after the edit: the person's edit survives
  PASS  Adapter detected the edit and preserved it byte-for-byte (shot at stayed 0.25 s)
  PASS  readAssembly finds shots by data-shot-id and write:false leaves film.html untouched
STEP 12 — Export MP4 and verify with ffprobe
  PASS  openfilm render produced .../coffee-30s/coffee-30s.mp4
  PASS  MP4 verified: 6.00 s, 1280x720, h264 + aac
    60 frames · 6s at 10 fps · 1280×720 · 2 workers · h264_nvenc · 10.7 s
E2E OFFLINE RUN: PASS (steps 1-3, 7-12 real; 4-6 blocked on a connected video service)
All 5 clips in the manifest are origin agent-code; 0 video-model clips were made.
```
Supporting commands, all run on this checkout and passing:
```
corepack pnpm --filter @framino/production test     # 57 pass, 0 fail
node --test skills/framino-production/ledger.test.mjs   # 11 pass, 0 fail
corepack pnpm typecheck                             # 4 of 4 projects
node scripts/audit-public.mjs --no-secrets          # No findings (2869 files)
```
Real assets made by a video model: **0** (no service connected). Test assets made by ffmpeg here: **5** (3 video,
1 voice-over, 1 music), all `origin: agent-code` and tagged in `film.html`.

## Known gaps

- Steps 4–6 need a video service connected in Studio → Settings → Services (fal.ai, Google, OpenFilm or OpenRouter)
  and the person's confirmation of the spend. `openfilm get video --help` reported "Not connected here" at this run.
  Until then, no real generation, no crash-and-resume against a live call, and no real regenerate have happened.
- The ledger's resume / no-double-charge and the take-isolation rules are verified only by the offline unit tests
  (`ledger.test.mjs`, `assets.test.mjs`), not by a killed live call.
- The demo is a 6 s, 640×360-source spot built from test patterns; it proves the chain, not picture quality. A 30 s
  1920×1080 commercial from a real model is the same flow and is not yet run.
- Model output for Codex and Claude Code transcripts (Skill step 3) has not been captured; that needs a connected
  service and both agents installed.

## Next steps

1. Person connects a video service in Studio, then re-runs this driver with real shots to fill steps 4–6.
2. Kill the process mid-generation against that service, restart, and confirm no shot is generated twice (step 5).
3. Regenerate one shot and confirm the other takes are byte-identical (step 6).
4. Capture one Codex and one Claude Code transcript running `skills/framino-production/SKILL.md`.
