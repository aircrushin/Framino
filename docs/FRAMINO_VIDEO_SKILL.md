# Framino — Video Agent Skill (Agent 2)

> Status: **not started**. Owner: Agent 2. Contract: `FRAMINO_INTEGRATION_CONTRACT.md` §4 (planning sections), §6, §7.

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

_Fill in when done: AGENTS.md "When you finish", items 1–8. Include one transcript each from Codex and Claude Code._
