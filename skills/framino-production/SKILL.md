---
name: framino-production
description: Produce a finished film from a brief through the Framino production workflow: write a script and storyboard for the person to approve, generate shots, validate assets, assemble an editable film.html and open it in Studio. Use when the user asks to make a commercial, an ad, a spot, a launch film, a storyboard with generated shots, or to "generate the shots" of a planned film. It is the multi-shot, approval-gated production flow. For editing, cutting, rendering or opening an existing film, or a single quick clip, use the framino skill instead.
---

# Framino Production

You take a brief all the way to an editable film, with the person approving before anything is spent. The work is a
folder on disk and a ledger that makes the flow safe to restart. Read this file whole before acting.

There are three tools and one rule that keeps the work honest:

- `openfilm get video` makes clips. A person connects a service in Studio (Settings → Services) and confirms the
  spend; you never pass `--yes` unless they agreed in this session, and you never pass `--force`.
- `packages/framino-production` validates assets and assembles `film.html`. You call it, you do not reimplement it.
- `skills/framino-production/ledger.mjs` is the task ledger. It is the only thing between a crash and a second
  charge, because `get video` has no de-duplication. **Call the ledger before and after every generation.**
- Contract (`docs/FRAMINO_INTEGRATION_CONTRACT.md`) §4 (manifest), §6 (ledger/resume), §7 (errors), §8 (validity),
  §9 (real vs test) is binding. When this file and the contract disagree, the contract wins.

Run every command in the film's folder. `openfilm` means Framino (see `skills/framino/SKILL.md`).

## The workflow

### 1. Brief — fill only what is missing

Pick a `project_id` (folder name, `[a-z0-9-]`, e.g. `coffee-30s`). Create the folder with `openfilm open <id>` and
keep Studio open. Write `production/manifest.json` through `newManifest()` and `writeManifest()` from
`packages/framino-production/src/manifest.mjs`. Ask the person only for what the brief does not say (audience,
platform, duration, language, aspect ratio, style, limits); put what you know into `manifest.brief`, `manifest.video`
and `manifest.scenes`. Mint stable ids with `sceneId(n)` and `shotId(n)` — an id never changes and is never reused.

### 2. Script — stop for approval

Write the script to `production/script.md` and fill `manifest.shots` (visual, camera, light, composition, prompt,
duration, voiceover, subtitle). Set `approval.script.state = 'draft'` and write the manifest. **Stop here.** Tell
the person where the script is and ask them to approve it. On approval, set
`approval.script = { state: 'approved', at: <ISO time> }`. Generate nothing until step 3 is also approved.

### 3. Storyboard — stop for approval

Render a readable `production/storyboard.md` from `manifest.shots` (one block per shot: id, duration, picture,
prompt). Set `approval.storyboard.state = 'draft'` and write. **Stop again.** Ask the person to approve. On approval
set `approval.storyboard = { state: 'approved', at: <ISO time> }`. Now, and only now, generation is allowed —
`ledger.mjs`'s `assertApproved()` enforces this.

### 4. Generate — ledger first, call second, never resubmit

**On start of every run, before anything:** call `recover(root)` from `ledger.mjs`. It settles tasks left `running`
by a crash against the disk (`resolveRunning`) and marks succeeded tasks whose clip vanished `abandoned`
(`abandonVanished`). This is what stops a restart paying twice.

For each shot without a valid selected take:

1. Read the ledger: `planCall(manifest, shot, take)`.
   - `skip` — that take already succeeded. Move on. **Never send it again.**
   - `resolve` — a task is still `running`. Run `recover(root)` again before deciding.
   - `new-take` — that take failed or was abandoned. Use the `next_take` it returns, not the old number.
   - `call` — no task for this take. Continue.
2. Choose the take: `take = plan.next_take ?? 1`. Build the §6 request object (prompt, duration, aspect_ratio,
   resolution, frame/reference hashes). Write the task **before** the call:
   `beginCall(root, { shot, take, provider, model, request })`. It computes the `request_key` and stores the task
   as `running` atomically. If it throws, stop — do not call the vendor.
3. Call the CLI with a unique `--out`, from `outName(shot, take)`:
   ```
   openfilm get video --via <provider> --model <model> \
     --prompt "<generation_prompt>" --duration <duration_sec> \
     --aspect-ratio <aspect_ratio> --resolution 1080p --out <shot>-t<take>
   ```
   Use only `--via`/`--model` that `openfilm get` lists as connected; the person's Settings choice is the default.
   Do not hardcode a vendor. One shot per call: never batch, never continue past a failure.
4. Record the outcome from the receipt, not from what you asked:
   - success → `succeedCall(root, { shot, take, receipt, provider, model })` with `provider`/`model` **from the
     receipt**. Then record the landed file with the asset pipeline's `record()` (§8, `origin: 'provider:<id>'`).
   - failure → `failCall(root, { shot, take, error })` using a §7 code.
5. On `balance` or `not_connected`: **stop the whole run** and tell the person where to connect or top up. Never
   loop. On `timeout`, do not resubmit the take — `recover()` checks the disk, and a retry is a new take.

A fixture or hand-made clip is never passed off as generated: it is `origin: 'agent-code'` and the Adapter tags its
clip `data-framino-test="true"` (§9).

### 5. Validate, assemble, open

Validate each landed clip with the pipeline's `validate()`/`record()` (§8); only `valid` assets are placed. Assemble
with the Project Adapter (`adapter.mjs`), which writes `film.html` through `film-doc.mjs` only. Then
`openfilm open <project>` and tell the person the film is ready to watch and edit in Studio. Editing, versions and
export are Studio's — do not reimplement them.

## Quick reference

| Function | Where | When |
| --- | --- | --- |
| `newManifest`, `writeManifest`, `readManifest`, `requestKey` | `packages/framino-production/src/manifest.mjs` | steps 1–3 |
| `recover`, `planCall`, `beginCall`, `succeedCall`, `failCall`, `nextTake` | `skills/framino-production/ledger.mjs` | step 4, every run |
| `validate`, `record` | `packages/framino-production/src/assets.mjs` | steps 4–5 |
| assemble | `packages/framino-production/src/adapter.mjs` | step 5 |
| `openfilm get video` | CLI | step 4, never `--yes`/`--force` |

The ledger's behaviour and the resume rules are documented in `docs/FRAMINO_VIDEO_GENERATION.md`; the offline tests
that prove no shot is generated twice are `skills/framino-production/ledger.test.mjs`.
