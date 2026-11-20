# Framino — Video Agent Skill (Agent 2)

> Status: **Skill and ledger implemented and verified offline; real end-to-end run blocked on a connected video
> service**. Owner: Agent 2. Contract: `FRAMINO_INTEGRATION_CONTRACT.md` §4 (planning sections), §6, §7.

## Job

The production workflow a person's coding agent follows: idea → script → storyboard → **person approves** →
generation → asset validation → assembly → "open it in Studio".

## How skills reach agents today

- Entry: `skills/framino/SKILL.md` → reads `manual.md` and the skills in its own folder → `openfilm <command>` CLI
  → which names the core skills in `packages/openfilm/manual/{edit,media,canvas}/SKILL.md` (`src/skills.mjs`
  `CORE_SKILLS` :382). `openfilm skill <name>` prints one.
- The desktop app installs skills per agent (`apps/desktop/src/agent-skills.mjs` header): Claude Code as local
  plugins in `_meta.claudeCode.options`; Codex through ACP `additionalDirectories` (`<dir>/.agents/skills`);
  OpenCode, Qwen Code, Copilot each their own way. **Codex and Claude Code differ; test both.**
- Outside the desktop app the person installs `skills/<name>/` into their agent's own skills folder.

## Shape (proposal)

`skills/framino-production/SKILL.md` with frontmatter `name`, `description` (precise triggers: "a commercial", "a
storyboard", "generate shots"; not every video request, so it does not shadow `openfilm`), and steps:

1. Ask only for what is missing in the brief; write `manifest.brief`.
2. Write `production/script.md`; stop for the person's approval.
3. Write `shots[]`; render `production/storyboard.md`; stop for approval.
4. For each shot without a valid selected take: `openfilm get video --via <provider> --prompt … --duration …
   --aspect-ratio … --out <shot_id>-t<take>`. Write the task to the ledger first, then call. Never `--yes` unless the
   person agreed. Stop on `balance` and on `not_connected`. Never resubmit a task left `running`: resolve it against the
   disk (`FRAMINO_VIDEO_GENERATION.md`, contract §6).
5. Validate (pipeline), assemble (adapter), then `openfilm open <project>`.

Steps 4–5 call the pipeline and adapter; the skill does not reimplement them.

## Status

### 1. What was implemented

`skills/framino-production/SKILL.md` is the production workflow: frontmatter with precise triggers (a commercial,
an ad, a storyboard with generated shots — explicitly not every video request, so it does not shadow `framino`),
and five steps: brief → script (approval gate) → storyboard (approval gate) → generate (ledger-gated) →
validate/assemble/open. It points at `openfilm get video`, `packages/framino-production` and the ledger; it
reimplements none of them, passes neither `--yes` nor `--force`, and stops on `balance` and `not_connected`.

`skills/framino-production/ledger.mjs` implements the §6 state machine over the existing manifest primitives:

- `beginCall` writes a task `running` with its `request_key` **before** the call, atomically, and refuses a second
  begin for the same take and any begin before both approvals.
- `recover` = `resolveRunning` + `abandonVanished`: on start, a task left `running` is settled against the disk
  (valid clip → `succeeded` with a receipt; no clip → `failed` with `error.code = "timeout"`), and a `succeeded`
  task whose clip vanished becomes `abandoned`.
- `planCall` is the pure guard before every call: `skip` for a succeeded take (never resubmit), `resolve` for a
  running one, `new-take` with the next number for failed/abandoned, `call` only when no task exists.
- `nextTake` counts takes in **both** `tasks[]` and `assets[]` — `lastTake` alone would hand back the same number
  for a failed take that has no asset, which is the second-charge hazard §6 exists to prevent.
- `succeedCall`/`failCall` record the receipt from the vendor (provider/model from the receipt, per §4.1) and §7
  errors; both refuse to write a task that is no longer `running`.

### 2. Files changed

- `skills/framino-production/SKILL.md` — new, the workflow.
- `skills/framino-production/ledger.mjs` — new, the ledger state machine.
- `skills/framino-production/ledger.test.mjs` — new, 11 offline tests.
- `docs/FRAMINO_VIDEO_SKILL.md` — this status section and the status line.
- `docs/FRAMINO_VIDEO_GENERATION.md` — the ledger/resume implementation status.

### 3. Architecture and interfaces

Contract §4 (`tasks[]`, `shots[].status` field ownership), §6 (request_key, write-first, resolve-never-resubmit,
abandon-on-vanish), §7 (error shape), §8 (validity), §9 (real vs test). Consumes `manifest.mjs`
(`readManifest`/`updateManifest`/`requestKey`/`taskFor`/`lastTake`) and `assets.mjs` (`validate`). Produces the
ledger module the Skill calls; no direct vendor calls, no `film.html` writes.

### 4. How to run

Read `skills/framino-production/SKILL.md` from the project folder. The ledger is a library, called from the Skill:

```
node --test skills/framino-production/ledger.test.mjs   # offline verification
```

Real generation needs a service connected in Studio → Settings → Services and a person to confirm the spend; then
`openfilm get video --via <id> … --out <shot>-t<take>` per §4 of `docs/FRAMINO_VIDEO_GENERATION.md`.

### 5. How to test

`node --test skills/framino-production/ledger.test.mjs` runs 11 tests. Each builds a temp project in the OS temp
folder with ffmpeg-made clips (`origin: agent-code`, §9), removed afterwards; `validate` runs against real files.
The tests simulate a crash mid-run: a `running` task with a clip on disk resolves to `succeeded` and `planCall`
then says `skip`; with no clip it resolves to `failed` and the next take is a new number; a vanished clip becomes
`abandoned`. No network, no key, no spend.

### 6. Test results (actually run)

| Command | Result |
| --- | --- |
| `node --test skills/framino-production/ledger.test.mjs` | **11 pass, 0 fail** (twice, including after cleanup) |
| `node scripts/audit-public.mjs --no-secrets` | **No findings** (2869 files) |

Not run: any real `openfilm get video` call (`Not connected here`), Studio open/edit/export, and the Codex and
Claude Code transcripts — these need a connected service and the person, and are reported as blocked, not passing.

### 7. Known issues

- The offline tests inject ffmpeg fixtures; the exact CLI string in the Skill has not been executed against a live
  provider. Provider flags are copied from `get.mjs:119-128` and `docs/FRAMINO_VIDEO_GENERATION.md`, not guessed.
- `--force` remains a compatibility surface on `get.mjs`; the Skill simply never passes it. The ledger, not the CLI,
  owns de-duplication (plan §"what not to do").
- One process per project at a time (contract §4.1); `beginCall` guards with `expectUpdatedAt` but does not lock.
- Desktop installation (per-agent skill folders for Codex vs Claude Code, `apps/desktop/src/agent-skills.mjs`) was
  not exercised; only the skill folder itself was written and read as a document.

### 8. Next steps

1. Person connects a video service in Studio, then run one real shot end to end and record the receipt into the
   ledger via `succeedCall`.
2. Kill the process mid-run against the connected service, restart, run `recover()` and confirm no shot is
   generated twice with a real vendor receipt.
3. Capture one transcript each from Codex and Claude Code running the Skill, and verify both agent installs see
   `skills/framino-production/SKILL.md`.
4. Fill rows 4–6 and 12 of `docs/FRAMINO_E2E_TEST_REPORT.md` with the commands actually run (Step 4).
