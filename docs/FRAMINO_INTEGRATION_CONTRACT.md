# Framino — Integration Contract

> Status: **v0.1 draft**, 2026-11-14. Owner: Agent 5 (Production Workflow & E2E). Every Phase 2 module reads and writes
> the shapes in this file. A module that needs a shape changed proposes the change here first; it does not ship its
> own variant.
>
> Everything below was written against the code at `feature/framino-transformation` (`123e654`). Where this file
> says "verified", a file and line is given. Where it says "proposal", nothing is built yet.

---

## 1. The one fact everything depends on

There is **no JSON project schema** in OpenFilm. The project is a folder, and the edit is `film.html`
(`packages/openfilm/SPEC.md` §1, read strictly by `packages/openfilm/src/film-doc.mjs`).

```
<project>/
  film.html            the edit: tracks (<section>) of clips (<video> <img> <audio> <iframe>) — the truth
  assets/              media; providers may only write here (studio/server/get.mjs landable(), :472)
  scenes/*.html        pages (window.film.frame(t)) for titles, graphics
  captions/*.vtt       caption tracks (WebVTT on film time)
  production/          Framino's production state (this contract, §4) — proposal
  .film/               Studio's own: history git repo, caches, chat. No agent and no Framino module writes here.
```

Consequences:

1. The **Production Manifest is a plan and a ledger, not the edit.** Before assembly it is the source of truth for
   shots, takes and tasks. After assembly, `film.html` is the source of truth for timing, order and placement,
   because the person edits it in Studio and Studio wins merges (`studio/server/person-edits.mjs`).
2. The Project Adapter writes `film.html` only through `film-doc.mjs` (`readFilmFile` / `readFilm` / `filmHtml`).
   No string templating of HTML.
3. Nothing is added to the `film.html` vocabulary. Framino identifiers travel in `data-*` attributes, which the format
   keeps and ignores (`film-doc.mjs:132`, `KEPT_ATTRIBUTE`; tracks `:134`).

---

## 2. Identifiers

| ID | Format | Example | Scope | Who mints it |
| --- | --- | --- | --- | --- |
| `project_id` | the project folder's name, `[a-z0-9-]{1,64}` | `coffee-30s` | one project | Skill, at Idea |
| `scene_id` | `sc` + 2 digits | `sc01` | project | Skill, at Script |
| `shot_id` | `sh` + 2 digits | `sh03` | project | Skill, at Storyboard |
| `asset_id` | `<kind>-<shot_id>-t<take>` for per-shot media; `<kind>-<name>` otherwise | `video-sh03-t2`, `music-bed` | project | whoever requests the asset |
| `task_id` | `t<take>-<shot_id>` for a generation run; the provider's own id when it returns one | `t2-sh03` | project | Skill, before the call |
| clip `id` | film.html clip id, `^[A-Za-z][\w-]*$` (`studio/server/ops.mjs:180`) | `sh03`, `sh03-vo` | film | Adapter |

Rules:

1. `shot_id` never changes once minted. Reordering shots changes `order`, not the id. A deleted shot's id is not reused.
2. A shot has **0..n takes**. Each take is one asset (`video-sh03-t1`, `video-sh03-t2`, …). `take` numbers only grow.
3. Every generation task names exactly one `shot_id` and one target `asset_id`.
4. Regenerating a shot creates a new take. It never overwrites another take's file and never touches another shot.
   The take number is in the file name (`assets/video/<shot_id>-t<take>.mp4`), which is what makes this true without
   any extra machinery.
5. A task that succeeded is never sent again, including after a crash or restart (§6).
6. Studio's `project id` (`studio/server/projects.mjs`, the Recent list) is Studio's own and is **not** `project_id`.
   Address projects by folder path.

### 2.1 How IDs appear in film.html

```html
<section data-framino-track="video">
  <video id="sh01" src="assets/video/sh01-t1.mp4" at="0"
         data-shot-id="sh01" data-scene-id="sc01" data-asset-id="video-sh01-t1"></video>
  <video id="sh02" src="assets/video/sh02-t1.mp4" at="6"
         data-shot-id="sh02" data-scene-id="sc01" data-asset-id="video-sh02-t1"></video>
</section>
```

- The clip `id` starts as the `shot_id`, but **do not find shots by clip id**. A Studio split copies the clip
  including its `data-*` (`ops.mjs:177-183`, `structuredClone`) and gives the right half a new id. So one shot can
  map to several clips. Find a shot's clips by `data-shot-id`.
- A clip without `data-shot-id` belongs to the person (added in Studio). Framino modules leave it alone.
- Tracks Framino creates carry `data-framino-track` = `captions | video | overlay | voiceover | music | sfx`.
  The first `<section>` is the top layer (SPEC §1).

---

## 3. Project layout (proposal)

```
<project>/
  film.html
  production/
    manifest.json        the Production Manifest (§4)
    script.md            the script, human-readable, approved by the person
    storyboard.md        optional render of the shots for review
    thumbs/<asset_id>.jpg  optional, the pipeline's own review thumbnails
  assets/
    video/<shot_id>-t<take>.mp4      generated takes   (get.mjs VERBS.video.dir = 'assets/video')
    image/<shot_id>-ref<n>.png       reference / first-frame pictures
    audio/vo-<shot_id>.wav           voice-over per shot (+ .vtt transcript beside it, SPEC §Words)
    audio/music-bed.mp3              music
  captions/film.vtt                  subtitles on film time, cue id = shot_id
```

- `production/` is ignored by Studio's media list (it is not under `assets/`) and is not `.film/`, so agents may
  write it.
- Thumbnails Studio shows come from Studio's own cache (`studio/server/derived.mjs`, `.film/cache/`). The pipeline does
  not write there and does not need to make thumbnails for Studio.

---

## 4. Production Manifest — `production/manifest.json`

JSON, UTF-8, 2-space indent, written atomically (write `manifest.json.tmp`, then rename). Times in seconds, rounded to
milliseconds like the format (`toMs`).

```jsonc
{
  "manifest_version": "0.2",
  "project_id": "coffee-30s",
  "title": "Specialty coffee — 30 s spot",
  "created_at": "2026-11-14T08:00:00Z",
  "updated_at": "2026-11-14T08:42:10Z",

  "brief": {
    "idea": "A 30-second cinematic commercial for a specialty coffee brand.",
    "audience": "urban coffee lovers 25-40",
    "platform": "youtube",            // youtube | tiktok | instagram | web | other
    "language": "en",                 // BCP 47
    "duration_sec": 30,
    "aspect_ratio": "16:9",           // one of get.mjs video --aspect-ratio choices
    "style": "warm, macro, shallow depth of field",
    "limits": { "max_generated_seconds": 45, "max_takes_per_shot": 3 }
  },

  "video": { "width": 1920, "height": 1080, "fps": 30 },   // width/height become film.html's viewport

  "approval": {                       // the Skill must not generate before both are "approved"
    "script":     { "state": "approved", "at": "2026-11-14T08:10:00Z" },
    "storyboard": { "state": "approved", "at": "2026-11-14T08:15:00Z" }
  },

  "scenes": [
    { "scene_id": "sc01", "title": "Morning ritual", "shots": ["sh01", "sh02"] }
  ],

  "shots": [
    {
      "shot_id": "sh01",
      "scene_id": "sc01",
      "order": 1,
      "duration_sec": 6,
      "visual_description": "Steam rising off a ceramic cup in morning light",
      "camera_movement": "slow push-in",
      "camera_angle": "eye level",
      "lighting": "soft window light, warm",
      "composition": "cup on left third",
      "generation_prompt": "…",
      "reference_assets": ["image-sh01-ref1"],
      "voiceover": "Every great day starts slow.",
      "subtitle": "Every great day starts slow.",
      "aspect_ratio": "16:9",
      "status": "generated",          // planned | generating | generated | failed | placed
      "takes": ["video-sh01-t1"],
      "selected_take": "video-sh01-t1"
    }
  ],

  "assets": [
    {
      "asset_id": "video-sh01-t1",
      "kind": "video",                // video | image | voiceover | music | sfx | subtitle
      "shot_id": "sh01",              // absent for project-wide assets (music)
      "take": 1,
      "path": "assets/video/sh01-t1.mp4",
      "origin": "provider:fal",        // provider:<id> | openfilm-service | local | library | person | agent-code
      "provider": "fal", "model": "seedance-2.0",
      "task_id": "t1-sh01",
      "status": "valid",              // pending | downloaded | valid | invalid
      "invalid_reason": null,
      "media": {
        "duration_sec": 6.042, "width": 1920, "height": 1080, "fps": 30,
        "video_codec": "h264", "audio_codec": "aac", "audio_channels": 2, "sample_rate": 48000,
        "size_bytes": 4821331, "sha256": "…"
      },
      "thumbnail": "production/thumbs/video-sh01-t1.jpg",
      "created_at": "2026-11-14T08:30:00Z"
    }
  ],

  "tasks": [
    {
      "task_id": "t1-sh01",
      "shot_id": "sh01",
      "asset_id": "video-sh01-t1",
      "request_key": "sha256 of the canonical request (§6)",
      "provider": "fal", "model": "seedance-2.0",
      "request": { "prompt": "…", "duration": 6, "aspect_ratio": "16:9", "resolution": "1080p", "first_frame": null },
      "state": "succeeded",           // running | succeeded | failed | abandoned
      "attempts": 1,
      "error": null,                  // { "code": "…", "message": "…", "retryable": true }
      "receipt": { "src": "assets/video/sh01-t1.mp4", "dur": 6.042, "hasAudio": true },
      "created_at": "…", "updated_at": "…"
    }
  ],

  "audio": { "music": "music-bed", "music_volume": 0.35, "voiceover_volume": 1.0 },
  "captions": { "path": "captions/film.vtt", "language": "en" },

  "assembly": {                       // written by the Project Adapter
    "film_rev": "sha256 of film.html after the last assembly",
    "at": "…",
    "placed": { "sh01": ["sh01"], "sh02": ["sh02", "sh02-b"] }   // shot_id → clip ids found by data-shot-id
  }
}
```

### 4.1 Field ownership

| Section | Written by | Read by |
| --- | --- | --- |
| `brief`, `video`, `approval`, `scenes`, `shots` (except `status`, `takes`, `selected_take`) | Skill | all |
| `tasks`, `shots[].status = generating / failed` | Skill (from the `get video` receipt) | Pipeline, E2E |
| `assets[]` entries, `status`, `media`, `thumbnail` | Asset Pipeline | Adapter, Skill |
| `shots[].takes`, `selected_take` | Skill (the person's choice) | Adapter |
| `assembly`, `shots[].status = placed` | Project Adapter | Skill, E2E |

Concurrent writers: one process at a time per project. A module reads, changes only its own sections, writes
atomically, and re-reads if `updated_at` moved under it.

### 4.2 Validation

A JSON Schema lives at `production/manifest.schema.json` in the Adapter's package once Agent 1 builds it (not yet).
Until then this section is the schema. Unknown fields are kept on rewrite and ignored.

---

## 5. Module boundaries

```
 Skill ──(manifest: shots, tasks)──► openfilm get video --via <provider> ──► vendor
   │                                       │ (Studio confirms the spend, lands the file in assets/video/)
   │                                       ▼
   ├──────────────────────────────► Asset Pipeline: validate + probe ──► manifest.assets[]
   │
   └──────────────────────────────► Project Adapter: manifest ──► film.html  (and film.html ──► manifest.assembly)
                                                                      │
                                                                      ▼
                                                           Studio (edit, versions, export)
```

| Module | Owns | Must not |
| --- | --- | --- |
| Skill | creative steps, manifest planning sections, the task ledger, calling `openfilm get video` | call vendors directly, write film.html by hand, probe media itself |
| Asset Pipeline | validation, metadata, `production/thumbs/`, conflict-free names | change film.html, write `.film/`, call a vendor |
| Project Adapter | manifest ⇄ film.html, `captions/film.vtt` | change `film-doc.mjs`, `SPEC.md`, `ops.mjs`; invent attributes |
| E2E | this contract, fixtures, the demo, the test report | implement another module's logic to make a test pass |

There is no Gateway module. Generation is the built-in `openfilm get video` path; see `FRAMINO_VIDEO_GENERATION.md`.

---

## 6. Idempotency and resume

There is no server to be idempotent for. `openfilm get video` is a blocking call with no task id and no de-duplication
(`--force` is declared at `get.mjs:122` but no provider reads it), so **Framino's own ledger is the only thing standing
between a restart and a second charge.** The rules:

- `request_key = sha256(canonical JSON of { project_id, shot_id, take, provider, model, prompt, duration,
  aspect_ratio, resolution, first_frame_sha256, last_frame_sha256, reference_sha256s })`, keys sorted, no whitespace.
- **Write the task first.** Before calling, append the task with `state: "running"` and its `request_key`, then call.
- **Resolve, never resubmit.** On start, any task still `running` is settled against the disk: if
  `assets/video/<shot_id>-t<take>.mp4` exists and validates (§8), it is `succeeded`; if it does not, it is `failed`
  with `error.code = "timeout"` and may be retried as a **new take**.
- A `succeeded` task whose asset is still `valid` is never sent again. A `succeeded` task whose asset vanished is
  `abandoned`, and the shot needs a new take.
- Never pass `--force`. A new take is a new `--out` name, so a new request_key, so there is nothing to force.
- The Skill checks the ledger before every call. If it cannot read the manifest, it stops rather than guessing.

## 7. Errors

One shape everywhere: `{ "code": string, "message": string, "retryable": boolean }`.

| code | Meaning | Retry |
| --- | --- | --- |
| `invalid_request` | bad parameters (duration, ratio, missing prompt). `get.mjs` `usage()` :209, exit 2 | no, fix the request |
| `content_rejected` | the vendor refused the prompt or the picture | no, rewrite the prompt |
| `balance` | no credit left. The same code OpenFilm uses (`providers/common.mjs` `noBalance` :65, `get.mjs:364-372`) | no. Stop and tell the person |
| `rate_limited` | too many requests | yes, with backoff |
| `provider_error` | vendor 5xx or a malformed answer | yes, max 3 attempts |
| `timeout` | no result within the limit (`get.mjs:363`; 1200 s for `video`) | check the disk first, then a new take |
| `not_connected` | no service makes clips yet (`get.mjs:322`) | no. Tell the person where to connect one |
| `asset_invalid` | the file landed but failed validation (§8) | regenerate as a new take |

The Skill stops the whole run on `balance` and on `not_connected`, matching `get.mjs`: tell the person, do not loop.

## 8. Asset validity

An asset is `valid` only when **all** hold (checked with ffprobe, which Studio already requires):

- the file exists under `assets/`, size > 0, and its `sha256` is recorded;
- it decodes: ffprobe returns a stream of the expected kind;
- video: duration ≥ 0.5 s and within ±0.5 s of the requested duration, or the difference is recorded;
  width and height > 0;
- audio: at least one audio stream, duration > 0;
- not a partial download: the HTTP `Content-Length` (when given) equals bytes on disk.

The Adapter places only `valid` assets. Anything else stays out of film.html and is listed in the E2E report.

## 9. Real vs test

- Every asset records where it came from in `origin`: `provider:<id>`, `openfilm-service`, `local`, `library`,
  `person`, or `agent-code`. A clip made by a local test fixture or a hand-made file is `agent-code`, and the Adapter
  tags its clip `data-framino-test="true"`.
- No document, log line or UI string calls a test asset "generated by a video model". The E2E report counts real and
  test assets separately.

## 10. Changing this contract

Bump `manifest_version` for any field rename or removal. New optional fields need no bump. Record each change below.

| Version | Date | Change |
| --- | --- | --- |
| 0.1 | 2026-11-14 | first draft, written against `123e654` |
| 0.2 | 2026-11-14 | the gateway is dropped: `task_id` is Framino's own, `origin` loses `gateway`/`test-provider`, §6 is a disk-resolved ledger, §7 gains `not_connected` and loses `not_found` |
