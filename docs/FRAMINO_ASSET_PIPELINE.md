# Framino — Media Asset Pipeline (Agent 4)

> Status: **Step 2 done** (validate, probe, record; no downloads yet). Owner: Agent 4. Contract:
> `FRAMINO_INTEGRATION_CONTRACT.md` §2, §3, §4 (`assets[]`), §8.

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

### 1. What was implemented

`packages/framino-production/src/assets.mjs`, the validation half of this brief. Downloads, review thumbnails and
name-conflict suffixes (`-2`, `-3`) are not built; see §7.

| Export | What it does |
| --- | --- |
| `validate(path, { root, kind, duration, contentLength })` | §8's verdict: `{ status, invalid_reason, media, path, kind }`. `invalid_reason` is a sentence naming the file and what is wrong with it; it is `null` exactly when `status` is `valid`. |
| `probe(path)` | ffprobe's answer: `{ ok, error, facts, streams }`. Never throws for a file it cannot read. |
| `record(root, asset, { now, expectUpdatedAt })` | Validates, hashes, and writes one `assets[]` entry through `updateManifest`. Returns `{ manifest, asset }`. |
| `validateEntry(root, entry, { duration })` | Re-checks an entry already in the ledger against the disk. This is §6's resume rule ("exists and validates (§8)"). |
| `sha256File(path)` | The sha256 of a file, streamed. |
| `ASSETS_DIR`, `CAPTIONS_DIR`, `MIN_VIDEO_SEC`, `DURATION_TOLERANCE_SEC` | The constants §8 and §3 name. |

`media` is §4's object plus three fields §8 needs: `duration_requested_sec`, `duration_delta_sec` (the file's length
minus the length asked for, in seconds, to the millisecond) and `duration_within_tolerance` (whether that is inside
±0.5 s). Every fact is `null` when ffprobe could not tell it, so a caller never has to ask whether a key exists.

`record` builds the entry from the disk, never from what the caller claims: `status` and `invalid_reason` come from
`validate`, `media.sha256` from the file, and the length asked for from `asset.duration`, else the shot's own
`duration_sec` in `shots[]`. A file that fails §8 is still recorded, as `invalid` with its reason: the ledger is
where a broken take is listed for the E2E report, and §8 keeps it out of `film.html` by its `status` alone.

### 2. Files changed

- `packages/framino-production/src/assets.mjs` (new).
- `packages/framino-production/test/assets.test.mjs` (new, 23 tests).
- `docs/FRAMINO_ASSET_PIPELINE.md` (this section, and the status line).

Nothing else. `manifest.mjs`, `providers/common.mjs` and everything under `packages/openfilm/` are untouched.

### 3. Architecture and interfaces

Contract §8 is the spec, clause by clause:

| §8 | Where | Notes |
| --- | --- | --- |
| exists under `assets/`, size > 0, `sha256` recorded | `validate` | A subtitle is also accepted in `captions/`, where §3 puts it. |
| decodes: a stream of the expected kind | `validate` + `probe` | The expected kind is `kind`, else the file extension. See §7 for the ambiguities. |
| video: ≥ 0.5 s, ±0.5 s of the requested length or the difference recorded, width and height > 0 | `validate` | The difference is always recorded; being outside ±0.5 s is a fact, not a failure. |
| audio: an audio stream, length > 0 | `validate` | Applies to `voiceover`, `music` and `sfx`. |
| not a partial download: `Content-Length` equals the bytes on disk | `validate` | Only when the caller passes `contentLength`; nothing here downloads. |

§4 (`assets[]`), §2 (ids: `<kind>-<shot_id>-t<take>`, `<kind>-<shot_id>` for a take-less per-shot asset such as
`voiceover-sh01`, `<kind>-<name>` otherwise), §7 (`ManifestError` with `invalid_request`), §9 (`origin` is required
and is written as given; a fixture is `agent-code`).

ffprobe is called the way `providers/common.mjs` `mediaSeconds` (:328) calls it — `execFile('ffprobe', ['-v',
'error', …], { timeout: 15_000 })` — with `-print_format json -show_format -show_streams` added. The helpers there
were not reused: `mediaSeconds` asks only for `format=duration` and answers `null` for both "not media" and "could
not read it", and `mp4Facts` (:287) / `wavSeconds` (:228) parse bytes already in memory. §8 needs stream kinds,
codecs, picture size and the reason a file does not decode. `common.mjs` was not modified.

### 4. How to run

```powershell
cd packages/framino-production
node --test "test/**/*.test.mjs"
```

Needs `ffmpeg` and `ffprobe` on `PATH` (8.0.1 here). The tests make every fixture with ffmpeg in a folder under the
system temp directory and delete it afterwards; no binary is committed.

### 5. How to test

`test/assets.test.mjs` covers, one test per clause: a valid clip whose `media` facts are compared against a direct
`ffprobe` call; a clip under 0.5 s; a valid WAV and a clip with no audio stream; a still picture and a subtitle; a
truncated MP4; a zero-byte file; a text file named `.mp4`; an audio file named `.mp4`; a `Content-Length` that does
not match; a file outside `assets/` and a missing file; a name that implies no kind; `probe` on a missing file; a
duration 1 s off the requested length; `sha256` against an independent computation; take 2 not overwriting take 1;
two refusals that would overwrite or move another take's entry; the three broken files recorded `invalid` with the
manifest still validating; id minting; a shot that does not exist; re-recording a take in place; `validateEntry`
after the file is deleted.

### 6. Test results

```
$ node --test "test/**/*.test.mjs"
ℹ tests 41
ℹ pass 41
ℹ fail 0
```

41 = 18 in `manifest.test.mjs` (unchanged) + 23 here. `corepack pnpm typecheck` passes (4 of 4 projects).
`node scripts/audit-public.mjs --no-secrets` reports `No findings.`

The three broken-file reasons, as produced:

- truncated MP4 — `the file is incomplete: it starts like mp4 but ffprobe could not read it (moov atom not found): assets/video/truncated.mp4`
- zero bytes — `the file is empty (0 bytes): assets/video/zero.mp4`
- a text file named `.mp4` — `the file is not media: nothing in it is a video, picture, audio or subtitle container: assets/video/text.mp4`

### 7. Known issues, and where §8 was ambiguous

1. **"under `assets/`" vs §3's `captions/`.** §8 says every asset lives under `assets/`; §3 puts the caption track at
   `captions/film.vtt`. Chosen: a `subtitle` is accepted in either folder, every other kind only under `assets/`.
2. **"a stream of the expected kind" for an image.** ffprobe reports a still picture as a `video` stream, so an
   `image` is checked for a video stream that is not an attached picture (`disposition.attached_pic !== 1`), plus a
   width and height above 0. An animated GIF therefore passes as an image; §8 does not say it should not.
3. **"a stream of the expected kind" for a subtitle.** Checked for `codec_type === 'subtitle'`. ffprobe reads a
   WebVTT or SRT file as one, but a `.vtt` with no cue at all still probes as a subtitle stream, so an empty caption
   track passes. §8 has no length rule for subtitles, and this module does not invent one.
4. **What "the expected kind" is when the caller names none.** `validate` uses the file extension. An extension that
   implies nothing (`.bin`) is `invalid` rather than guessed at. An audio extension implies `audio` but not which of
   `voiceover` / `music` / `sfx`, so `record` requires a `kind` for audio files.
5. **±0.5 s: a failure or a fact?** Read literally, §8 makes it a fact ("or the difference is recorded"), so a clip
   1 s off is still `valid` and carries `duration_delta_sec: -1` and `duration_within_tolerance: false`. If the
   intent was "outside ±0.5 s is invalid", `validate` is the one place to change.
6. **A video with no audio stream.** §8 lists no audio requirement for video, so a silent clip is `valid` and its
   `media.audio_codec` is `null`. Worth knowing because a shot with a voice-over needs the two files to line up.
7. **`Content-Length`.** Nothing in this module downloads, so the check only runs when the caller passes
   `contentLength`. A caller that has the header should pass it; `record` stores it as `content_length` so
   `validateEntry` can re-check it later.
8. **A truncated file whose header survived.** Cutting an MP4 made with `-movflags +faststart` in half still probes
   cleanly (the `moov` box is at the front), so it is `valid` by §8's rules. Only the `Content-Length` check catches
   that one, which is why clause 7 matters. The truncation §8's test names — an ordinary MP4 cut in half — loses its
   `moov` and is caught.
9. **Not built yet**: downloads for media that does not come through `openfilm get` (temp file, rename, https only,
   retry with backoff), the `-2` / `-3` name-conflict suffixes, and `production/thumbs/`. The brief lists them; Step 2
   does not need them and no vendor is reachable.

### 8. Next steps

- The Adapter reads `status` and places only `valid` assets; nothing here writes `film.html`.
- Step 3's ledger can call `validateEntry` on a `running` task's file to settle it against the disk (§6).
- If a download path is added, it should pass the response's `Content-Length` into `record` as `content_length`.
