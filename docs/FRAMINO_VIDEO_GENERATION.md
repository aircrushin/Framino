# Framino — Video Generation (the built-in path)

> Status: **decision stands, ledger built and verified offline; first real call blocked on a connected service**.
> There is **no Framino Video API Gateway**. Generation uses what already ships: `openfilm get video` and its
> providers. Owner: Agent 2 (Skill) records the tasks; Agent 4 (Pipeline) validates what lands. Contract:
> `FRAMINO_INTEGRATION_CONTRACT.md` §4 (`tasks[]`, `assets[]`), §6, §7.

## Decision

The gateway was dropped on 2026-11-14. One generation path only: the person connects a service in Studio
(Settings → Services), and the agent calls `openfilm get video`. No Framino service, no second API, no vendor keys
anywhere in Framino's code.

What that costs, stated plainly: there is no Framino account, no Framino credits, no hosted task queue, and no
cross-machine resume. What it buys: the spend confirmation, the `assets/`-only write, the timeouts and the error copy
that already exist are the ones people get, and nothing has to be trusted twice.

## What exists (verified at `123e654`)

| Thing | Where |
| --- | --- |
| The verb and its flags: `--prompt --out --duration 2-30 --resolution 480p…4K --aspect-ratio --first-frame --last-frame --input-reference --video --audio --voice --force` | `studio/server/get.mjs:119-128` |
| Providers that make clips: fal (Seedance 2.0, Kling 3.0), OpenRouter (bytedance/seedance-*), Google (gemini-omni-1.2-flash), OpenFilm's own service (signed in, billed to the OpenFilm balance), Local | `studio/server/providers/index.mjs:47`, `fal.mjs:18`, `openrouter.mjs:32`, `google.mjs:22` |
| The person confirms the spend in Studio before anything is made | `get.mjs:351-358`, `approved()` :380 |
| Files land only under `assets/`, no `..`, no symlink write-through | `land()` :493, `landable()` :472, `landsInside()` :462 |
| Output name → `assets/video/<out>.mp4` | `providers/common.mjs` `landing()` |
| Timeout (1200 s for `video`) and its message | `get.mjs:119`, :363 |
| No balance → stop and tell the person, never loop | `providers/common.mjs` `noBalance` :65, `get.mjs:364-372` |
| The receipt the agent reads: `{ provider, model, src, dur, hasAudio, …resolution }` | `fal.mjs:224`, shown by `show()` `get.mjs:551` |

## What does not exist (also verified)

1. **No de-duplication.** `--force` is declared for `video` (`get.mjs:122`) but **no provider reads it** and `get.mjs`
   never checks it. The help text says "the same request again returns the same clip; `--force` makes a new one" —
   that is not implemented. Do not build on it.
2. **No task id, no status endpoint, no credits endpoint.** From the agent's side the call is synchronous: it blocks
   until the clip is made or the timeout fires.
3. **No resume.** If the agent dies mid-call, nothing records whether the clip was made.

## So Framino supplies exactly three things

1. **A ledger, before the call.** Write the task into `manifest.tasks[]` with `state: "running"`, its `request_key`
   (contract §6) and its target `asset_id`, *then* call. A crash leaves a record instead of a mystery.
2. **A check, on start.** A task left `running` from an earlier run is resolved by looking at the disk: if
   `assets/video/<shot_id>-t<take>.mp4` exists and validates, it is `succeeded`; otherwise it is `failed` and may be
   retried. **Never blind-resubmit** — that is how a person pays twice.
3. **Take numbering.** `--out <shot_id>-t<take>`. A retry is a new take, so a new file name, so nothing is ever
   overwritten and the old take stays available for comparison.

## The call, per shot

```
openfilm get video --via <provider> --model <model> \
  --prompt "<shots[].generation_prompt>" \
  --duration <shots[].duration_sec> --aspect-ratio <brief.aspect_ratio> --resolution 1080p \
  --out <shot_id>-t<take> [--first-frame <reference asset>]
```

Rules:

- One shot per call. Never batch, never a loop that keeps going after a failure.
- `--via` / `--model` only from what `openfilm get` lists as connected (`catalog()` :565). The person's Settings choice
  is the default; the Skill does not hardcode a vendor.
- **Never `--yes`** unless the person agreed in this session. Without a Studio page to ask, the CLI says so and the
  Skill must ask the person instead (`approved()` :383).
- On `balance`: stop the whole run, say which service and where to top up, do not retry.
- On timeout: the clip may still be made at the vendor. Re-run the same take only after checking the disk; if a new
  take is needed, say so.
- Record `provider` and `model` from the receipt into the task, not from what was asked.

## What the person sees

Studio → Settings → Services: their own key, or OpenFilm's service, or a local model. That is the whole setup. The
first clip of a run is confirmed in Studio, like any other `get video`.

## The three things, implemented

The three things §"So Framino supplies exactly three things" promises are now code in
`skills/framino-production/ledger.mjs`, called by the Skill (contract §6):

| Promise | Function | Behaviour |
| --- | --- | --- |
| A ledger before the call | `beginCall` | Appends the task `running` with its `request_key`, atomically, before the CLI call; refuses a duplicate take and a pre-approval begin. |
| A check on start | `recover` (`resolveRunning` + `abandonVanished`) | A task left `running` is settled against the disk: valid clip → `succeeded` with a receipt, no clip → `failed` with `error.code = "timeout"`; a `succeeded` task whose clip vanished → `abandoned`. Never a blind resubmit. |
| Take numbering | `nextTake`, `outName` | A retry uses a new take and a new `--out` (`<shot>-t<take>`), so no file is overwritten and nothing is ever forced. `nextTake` counts takes in `tasks[]` as well as `assets[]` — a failed take has no asset, and counting only assets would reuse its number (the second-charge hazard). |

The guard the Skill asks before every call is `planCall(manifest, shot, take)`: `skip` (succeeded → never resend),
`resolve` (still running → recover first), `new-take` (failed/abandoned → use the number it returns), `call` (no
task → begin first). The `request_key` is `manifest.mjs`'s §6 hash; `succeedCall` records provider/model from the
vendor receipt (§4.1), `failCall` records a §7 error.

### Verification

`node --test skills/framino-production/ledger.test.mjs` — 11 pass, 0 fail, offline. The tests make ffmpeg fixtures
(`origin: agent-code`, §9), settle `running` tasks against real files, and prove that after a simulated crash a
succeeded take is skipped and a failed take gets a new number. No vendor, key or spend. `openfilm get video` still
reports "Not connected here", so the first real call, a real kill-mid-run restart and the Codex/Claude transcripts
remain blocked on the person connecting a service (see `docs/FRAMINO_VIDEO_SKILL.md` §Status).
