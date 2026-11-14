# Framino — End-to-End Test Report (Agent 5)

> Status: **no E2E run yet**. Owner: Agent 5. Nothing in this file is filled in until it was run.

## Scenario: Coffee Brand Commercial

About 30 s, 3–5 shots, music bed, voice-over or captions, 16:9 1920×1080.

| # | Step | How it is checked | Real / test | Result |
| --- | --- | --- | --- | --- |
| 1 | Idea → `manifest.brief` | manifest validates | — | not run |
| 2 | Script written, approved | `approval.script.state = approved` | — | not run |
| 3 | Storyboard: 3–5 shots, all contract fields | manifest validates | — | not run |
| 4 | Generation through `openfilm get video` | one task per shot in the ledger, all `succeeded` | real service? | not run |
| 5 | Restart mid-run: no shot generated twice | ledger task count = shot count; no duplicate files on disk | | not run |
| 6 | Regenerate one shot | new take; other shots' files byte-identical | | not run |
| 7 | Assets validated | every placed asset `valid` | | not run |
| 8 | Assembly | `openfilm look` reports no problems; clips carry `data-shot-id` | — | not run |
| 9 | Opens in Studio | Studio loads, 0 console errors | — | not run |
| 10 | Edit a shot, a caption, the music level | film.html rev changes; reopen keeps it | — | not run |
| 11 | Re-assemble after the edit | the person's edits survive | — | not run |
| 12 | Export MP4 | ffprobe: duration, size, fps, audio present | — | not run |

## Runs

_Each run: date, commit, machine, commands, raw pass/fail counts, which assets were real and which were test._

## Known gaps

_List what was not run and why._
