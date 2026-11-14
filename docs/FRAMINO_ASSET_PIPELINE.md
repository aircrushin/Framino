# Framino — Media Asset Pipeline (Agent 4)

> Status: **not started**. Owner: Agent 4. Contract: `FRAMINO_INTEGRATION_CONTRACT.md` §2, §3, §4 (`assets[]`), §8.

## Job

Make every file a shot depends on trustworthy and addressable: validate it, probe it, give it an `asset_id`, record it
in `manifest.assets[]`, and keep broken files out of the project.

## What already exists (do not duplicate)

- Files from `openfilm get` are already written under `assets/` by Studio (`get.mjs` `land()` :493) with path and
  symlink checks. The pipeline does not download those again; it validates what landed.
- Studio's own posters, timeline thumbnails, waveforms and durations: `studio/server/derived.mjs`, cached in
  `.film/cache/`. Studio does not need thumbnails from the pipeline.
- ffprobe helpers in Studio: `providers/common.mjs` (`mp4Facts` :287, `mediaSeconds` :328, `wavSeconds` :228).
  Prefer calling ffprobe the same way over adding a media library.

## What is new

- `validate(path) → { status: 'valid' | 'invalid', invalid_reason, media }` per contract §8.
- `record(manifest, asset)`: adds or updates `assets[]`, computes `sha256`, never overwrites another take's entry.
- Downloads only for media that does not come through `openfilm get` (a URL a vendor returned outside Studio):
  temp file, then rename; https only; size and type checked; retry with backoff.
- Name conflicts: `assets/video/<shot_id>-t<take>.mp4` is unique by construction; anything else gets `-2`, `-3`.
- Optional review thumbnails in `production/thumbs/` for the storyboard doc. Not for Studio.

## Status

_Fill in when done: AGENTS.md "When you finish", items 1–8._
