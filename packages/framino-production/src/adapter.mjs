// @ts-check
/**
 * The Project Adapter: `production/manifest.json` becomes a `film.html` Studio opens, and `film.html` is read back
 * into `manifest.assembly` after the person edits. Contract: `docs/FRAMINO_INTEGRATION_CONTRACT.md` §1 (the format),
 * §2 (ids), §3 (layout), §4 (the manifest), §5 (module boundaries), §8 (asset validity), §9 (real vs test).
 *
 * Three rules decide everything here.
 *
 * 1. `film.html` is written only through `film-doc.mjs`, never by string-templating HTML (hard rule 3). Every import
 *    of it goes through `./film.mjs`, the one bridge, because `packages/openfilm` is not linked into `node_modules`
 *    (that file's header has the decision and why).
 * 2. **Assembling twice changes nothing.** `manifest.assembly.film_rev` is the sha256 of `film.html`; if a second
 *    assembly rewrote the file, the Adapter could never tell "the person edited this" from "I wrote it again", and
 *    the re-assembly rule below would silently break. So the text is computed, checked to be a fixed point of
 *    `filmHtml` (`assertStable`), and written only when it actually changed.
 * 3. **After the first assembly the film is the source of truth for timing, order and placement** (§1). The Adapter
 *    adds clips for shots that are new and rewrites the `src` of a clip whose take changed. It never moves, retimes
 *    or deletes a clip, and it never re-adds one the person removed.
 *
 * The re-assembly rule (`docs/FRAMINO_PROJECT_ADAPTER.md`): once the film exists, the Adapter changes only the clips
 * it placed -- those carrying `data-shot-id` -- and only the ones whose take changed, and it adds shots that are
 * missing. "Edited" is detected by comparing `manifest.assembly.film_rev` with the film's current revision; the
 * result is reported as `edited` so a caller can tell the person what it found.
 *
 * Shots are found by `data-shot-id`, never by clip id: a Studio split copies the clip including its `data-*` and
 * mints a new id, so one shot can be several clips (§2.1).
 */
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { writeAtomic } from '../../openfilm/studio/server/atomic.mjs';
import { cueEscape, readVtt, writeVtt } from '../../openfilm/src/captions.mjs';
import { ManifestError, toMs, writeManifest } from './manifest.mjs';
import {
  FILM_FILE, assertStable, clipsOfShot, filmHtml, filmRev, freeClipId, readFilmAt, readFilmFile, trackOfRole,
} from './film.mjs';

/** The caption file the shots' subtitles are written to (§3): cues on film time, a cue's id is its shot id. */
export const CAPTIONS_PATH = 'captions/film.vtt';

/** The track roles of §2.1, top layer first. The Adapter makes the first four; `overlay` and `sfx` are the person's. */
export const TRACK_ROLES = Object.freeze(['captions', 'video', 'overlay', 'voiceover', 'music', 'sfx']);

/** The fade a placed clip gets at each end, in seconds. `assemble(root, manifest, { fade: 0 })` cuts hard instead. */
export const FADE_SEC = 0.2;

/** A file a browser plays as a video: an `<audio>` of one is that video's sound alone (`sound: true`). */
const VIDEO_FILE = /\.(mp4|m4v|mov|webm|mkv|avi|ogv)$/i;

/** @param {unknown} value @returns {value is Record<string, any>} */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** @param {unknown} value */
const isText = (value) => typeof value === 'string' && value.trim().length > 0;

/** A number of seconds as the format writes it: to the millisecond. */
const ms = (/** @type {number} */ seconds) => toMs(seconds);

/**
 * What one shot becomes: the film second its picture starts at, how long it lasts, and the asset it comes from.
 * @typedef {{ shot: any, asset: any, at: number, duration: number }} Placement
 */

/**
 * What `assemble` changed: the clip ids it added, the clip ids whose take it rewrote, the caption cue ids it added,
 * and the track roles it made.
 * @typedef {{ added: string[], retaken: string[], levelled: string[], captions: string[], tracks: string[] }} Changes
 */

/** An empty record of changes. */
const noChanges = () => ({ added: [], retaken: [], levelled: [], captions: [], tracks: [] });

/** The asset an id names, when it may reach `film.html`: it exists, it is `valid` (§8) and it has a path. */
function validAsset(/** @type {Record<string, any>} */ manifest, /** @type {unknown} */ assetId) {
  if (!isText(assetId)) return null;
  const asset = (manifest.assets ?? []).find((/** @type {any} */ a) => a.asset_id === assetId);
  if (!isObject(asset) || asset.status !== 'valid' || !isText(asset.path)) return null;
  return asset;
}

/**
 * The voiceover asset of a shot. The contract writes `shots[].voiceover` as the words and §3 puts the recording at
 * `assets/audio/vo-<shot_id>.wav`; the mapping table calls it an asset. All three shapes are accepted: an asset id
 * (`voiceover-sh01`), `{ asset_id }`, or the words, in which case the shot's own valid `voiceover` asset is used.
 * @param {Record<string, any>} manifest @param {any} shot
 * @returns {Record<string, any> | null}
 */
function voiceoverOf(manifest, shot) {
  const said = shot?.voiceover;
  if (isObject(said) && isText(said.asset_id)) return validAsset(manifest, said.asset_id);
  if (isText(said)) {
    const named = validAsset(manifest, said);
    if (named) return named;
  }
  const own = (manifest.assets ?? []).filter((/** @type {any} */ a) => (
    a.kind === 'voiceover' && a.shot_id === shot.shot_id && a.status === 'valid' && isText(a.path)
  ));
  if (!own.length) return null;
  return own.find((/** @type {any} */ a) => a.path === `assets/audio/vo-${shot.shot_id}.wav`) ?? own[own.length - 1];
}

/**
 * The shots in `order`, each with the film second it starts at: the running sum of the durations of the shots that
 * are placed, so a shot with no usable take leaves no hole in the film. A shot that cannot be placed is skipped and
 * says why; it is never a reason to stop.
 * @param {Record<string, any>} manifest
 * @returns {{ placed: Placement[], skipped: { shot_id: string, reason: string }[] }}
 */
export function planShots(manifest) {
  const shots = [...(manifest.shots ?? [])].sort((/** @type {any} */ a, /** @type {any} */ b) => a.order - b.order);
  /** @type {Placement[]} */
  const placed = [];
  /** @type {{ shot_id: string, reason: string }[]} */
  const skipped = [];
  let cursor = 0;
  for (const shot of shots) {
    const asset = validAsset(manifest, shot.selected_take);
    if (!asset) {
      skipped.push({
        shot_id: shot.shot_id,
        reason: isText(shot.selected_take)
          ? `its selected take ${shot.selected_take} is not a valid asset (§8), so it is not placed`
          : 'it has no selected take, so there is nothing to place',
      });
      continue;
    }
    const duration = ms(shot.duration_sec);
    placed.push({ shot, asset, at: ms(cursor), duration });
    cursor = ms(cursor + duration);
  }
  return { placed, skipped };
}

/**
 * The clip ids a film holds for each shot, found by `data-shot-id` and never by clip id (§2.1): a Studio split
 * leaves one shot with several clips. Only shots the manifest still has are listed, because `assembly.placed` has to
 * name shots that exist (`manifest.mjs`).
 * @param {any} value the film's value
 * @param {Record<string, any>} manifest
 * @returns {Record<string, string[]>}
 */
export function placedIn(value, manifest) {
  /** @type {Record<string, string[]>} */
  const placed = {};
  const shots = [...(manifest.shots ?? [])].sort((/** @type {any} */ a, /** @type {any} */ b) => a.order - b.order);
  for (const shot of shots) {
    const ids = clipsOfShot(value, shot.shot_id).map((/** @type {any} */ c) => c.clip.id);
    if (ids.length) placed[shot.shot_id] = ids;
  }
  return placed;
}

/**
 * The track Framino made for a role, made now when it is missing, in the layer order of `TRACK_ROLES`: a caption
 * track on top (it is drawn over the tracks below it), a picture track above the sounds, and anything else after the
 * last Framino track that comes before it. The index is looked up again on every call, never held: making one track
 * moves another.
 * @param {any} value @param {string} role
 */
function ensureTrack(value, role) {
  const found = trackOfRole(value, role);
  if (found >= 0) return value.tracks[found];
  const track = { clips: [], attrs: { 'data-framino-track': role } };
  const rank = TRACK_ROLES.indexOf(role);
  let after = -1;
  value.tracks.forEach((/** @type {any} */ t, /** @type {number} */ i) => {
    const r = TRACK_ROLES.indexOf(t.attrs?.['data-framino-track']);
    if (r >= 0 && r < rank) after = i;
  });
  value.tracks.splice(after + 1, 0, track);
  return track;
}

/**
 * The clips of a shot on one of Framino's tracks. `clipsOfShot` finds a shot's clips anywhere in the film (a
 * voiceover carries `data-shot-id` too); a picture and a sound are told apart by the track they are on.
 * @param {any} value @param {string} role @param {string} shot
 * @returns {any[]}
 */
function clipsOn(value, role, shot) {
  const ti = trackOfRole(value, role);
  if (ti < 0) return [];
  return (value.tracks[ti].clips ?? []).filter((/** @type {any} */ c) => c.attrs?.['data-shot-id'] === shot);
}

/**
 * Mark a clip as a test asset or clear the mark (§9): a clip made by `agent-code` -- a fixture, a hand-made file --
 * says so, and a clip whose take became a real one stops saying it.
 * @param {any} clip @param {Record<string, any>} asset
 */
function tagTest(clip, asset) {
  const attrs = { ...(clip.attrs ?? {}) };
  if (asset.origin === 'agent-code') attrs['data-framino-test'] = 'true';
  else delete attrs['data-framino-test'];
  clip.attrs = attrs;
}

/**
 * A fade that fits inside a clip: `FADE_SEC` at each end, shortened together when the clip is short (both fades have
 * to fit in its length, `film-doc.mjs`).
 * @param {number} fade @param {number} duration
 * @returns {[number, number] | null}
 */
function fadeFor(fade, duration) {
  const each = ms(Math.min(fade, duration / 4));
  return each > 0 ? [each, each] : null;
}

/** How much of a take plays: the shot's duration, cut to the file's own length when that is known and shorter. */
function takeLength(/** @type {Placement} */ placement) {
  const native = placement.asset?.media?.duration_sec;
  return ms(Number.isFinite(native) && native > 0 ? Math.min(placement.duration, native) : placement.duration);
}

/** Add a clip to a track where the timeline reads it: before the first clip that starts later. Never reorders. */
function insertByAt(/** @type {any[]} */ clips, /** @type {any} */ clip) {
  const at = clip.at ?? 0;
  const i = clips.findIndex((/** @type {any} */ c) => (c.at ?? 0) > at);
  if (i < 0) clips.push(clip);
  else clips.splice(i, 0, clip);
}

/** A new clip of a shot's take on the video track. */
function videoClip(/** @type {any} */ film, /** @type {Placement} */ placement, /** @type {number} */ fade) {
  const { shot, asset, at } = placement;
  const length = takeLength(placement);
  /** @type {Record<string, string>} */
  const attrs = {
    'data-shot-id': shot.shot_id,
    'data-scene-id': shot.scene_id,
    'data-asset-id': asset.asset_id,
  };
  if (asset.origin === 'agent-code') attrs['data-framino-test'] = 'true';
  const fades = fadeFor(fade, length);
  return {
    src: asset.path,
    id: freeClipId(film, shot.shot_id),
    ...(at ? { at } : {}),
    time: [0, length],
    ...(fades ? { overrides: [{ fade: fades }] } : {}),
    attrs,
  };
}

/**
 * A sound to place: its file, the clip id it would like, where it starts, its level, and its `data-*`.
 * @typedef {{ src: string, wanted: string, at?: number, volume?: number, attrs: Record<string, string> }} SoundSpec
 */

/**
 * A new sound clip: a voiceover or the music bed.
 * @param {any} film @param {SoundSpec} sound
 */
function soundClip(film, sound) {
  /** @type {any} */
  const clip = { src: sound.src, id: freeClipId(film, sound.wanted) };
  /* an <audio> of a video file is that video's sound alone (film-doc.mjs): say so, or the clip is not a sound */
  if (VIDEO_FILE.test(sound.src)) clip.sound = true;
  if (sound.at) clip.at = sound.at;
  if (sound.volume != null && sound.volume !== 1) clip.volume = sound.volume;
  clip.attrs = sound.attrs;
  return clip;
}

/**
 * Put a shot's take on the video track: add the clip when the shot has none, and when it has one, rewrite only the
 * ones whose take changed. A clip's `at` is never touched: after the first assembly the film decides where a clip
 * sits (section 1). A shot whose clips the person deleted is not added again -- that deletion is an edit like any other.
 * @param {any} value @param {Placement} placement @param {number} fade
 * @param {Changes} changed @param {Set<string>} removed shots whose clips the person took out
 */
function placeVideo(value, placement, fade, changed, removed) {
  const { shot, asset } = placement;
  const track = ensureTrack(value, 'video');
  const mine = clipsOn(value, 'video', shot.shot_id);
  if (!mine.length) {
    if (removed.has(shot.shot_id)) return;
    const clip = videoClip(value, placement, fade);
    insertByAt(track.clips, clip);
    changed.added.push(clip.id);
    return;
  }
  for (const clip of mine) {
    if (clip.attrs?.['data-asset-id'] === asset.asset_id) continue;
    clip.src = asset.path;
    clip.time = [0, takeLength(placement)];
    clip.attrs = { ...clip.attrs, 'data-asset-id': asset.asset_id };
    tagTest(clip, asset);
    changed.retaken.push(clip.id);
  }
}

/**
 * Put a sound on one of Framino's tracks: added when there is none, its file rewritten when it changed. Its `at` is
 * always the person's once it exists; its `volume` follows the manifest only while the film is still exactly what the
 * Adapter wrote (`ours`), so `music_volume` is not a dead field and a person's own level is never overwritten.
 * @param {any} value @param {string} role @param {SoundSpec} sound
 * @param {{ ours: boolean, shot: string | null }} how
 * @param {Changes} changed @param {Set<string>} removed
 */
function placeSound(value, role, sound, { ours, shot }, changed, removed) {
  const track = ensureTrack(value, role);
  const mine = shot
    ? clipsOn(value, role, shot)
    : track.clips.filter((/** @type {any} */ c) => c.attrs?.['data-asset-id'] === sound.attrs['data-asset-id']);
  if (!mine.length) {
    if (shot && removed.has(shot)) return;
    const clip = soundClip(value, sound);
    insertByAt(track.clips, clip);
    changed.added.push(clip.id);
    return;
  }
  for (const clip of mine) {
    const retake = clip.src !== sound.src;
    const reattr = clip.attrs?.['data-asset-id'] !== sound.attrs['data-asset-id'];
    if (retake) clip.src = sound.src;
    if (reattr) clip.attrs = { ...clip.attrs, ...sound.attrs };
    if (retake || reattr) changed.retaken.push(clip.id);
    if (!ours) continue;
    const level = sound.volume != null && sound.volume !== 1 ? sound.volume : undefined;
    if (clip.volume !== level) {
      if (level === undefined) delete clip.volume;
      else clip.volume = level;
      changed.levelled.push(clip.id);
    }
  }
}

/**
 * The caption file the shots' subtitles make: a cue per shot, its id the shot id, on the film's time. A cue that is
 * already there is kept as it is (the person may have cut it by hand), and so are notes, regions, styles and cues
 * that are not a shot's. Only a cue that is missing is added.
 * @param {Placement[]} placed
 * @param {string | null} before the caption file as it is
 * @returns {{ text: string | null, added: string[] }}
 */
function captionFile(placed, before) {
  const vtt = before ? readVtt(before) : { header: 'WEBVTT', notes: [], regions: [], styles: [], cues: [] };
  const have = new Set(vtt.cues.map((/** @type {any} */ c) => c.id).filter(Boolean));
  /** @type {string[]} */
  const added = [];
  for (const p of placed) {
    const said = p.shot.subtitle;
    if (!isText(said)) continue;
    const id = p.shot.shot_id;
    if (have.has(id)) continue;
    vtt.cues.push({ id, start: ms(p.at), end: ms(p.at + p.duration), settings: '', text: cueEscape(said) });
    have.add(id);
    added.push(id);
  }
  return { text: vtt.cues.length ? writeVtt(vtt) : null, added };
}

/** Read a text file, or null when it is not there. */
async function readText(/** @type {string} */ path) {
  try {
    return await readFile(path, 'utf8');
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return null;
    throw e;
  }
}

/**
 * The film as it is in `root`, and whether the file was there at all. A project with no `film.html` reads as the
 * empty film, which is what `openfilm open` would have written there.
 * @param {string} root
 * @returns {Promise<{ existed: boolean, text: string, rev: string, value: any }>}
 */
async function filmAt(root) {
  const existed = (await readText(join(root, FILM_FILE))) !== null;
  const film = await readFilmAt(root);
  return { existed, ...film };
}

/**
 * Assemble `manifest` into the project's `film.html`: write the shots' takes, their voiceovers, the music bed and the
 * captions, then record `assembly` (`film_rev`, `at`, `placed`).
 *
 * The film is written only when the text it would have differs from the text on disk, and only after the text is
 * proved to be a fixed point of `filmHtml` (`assertStable`): assembling twice is byte-identical, which is what makes
 * `film_rev` able to tell a person's edit from the Adapter's own writing.
 *
 * @param {string} root the project folder
 * @param {Record<string, any>} manifest the manifest, read with `readManifest`; its `assembly` is updated in place
 * @param {{ now?: string, fade?: number }} [options] `fade`: seconds at each end of a placed clip (0 for a hard cut)
 * @returns {Promise<{
 *   film_rev: string, at: string, placed: Record<string, string[]>,
 *   added: string[], retaken: string[], levelled: string[], captions: string[], tracks: string[],
 *   skipped: { shot_id: string, reason: string }[], edited: boolean, written: boolean,
 *   manifest: Record<string, any>,
 * }>}
 */
export async function assemble(root, manifest, { now = new Date().toISOString(), fade = FADE_SEC } = {}) {
  const film = await filmAt(root);
  if (film.value == null) {
    const problems = readFilmFile(film.text).problems;
    throw new ManifestError({
      code: 'invalid_request',
      message: `${FILM_FILE} does not read, so the manifest cannot be assembled into it: ${problems.join('; ')}`,
      retryable: false,
    }, join(root, FILM_FILE));
  }
  /* the person's film, not ours: it is not what the last assembly wrote, so nothing in it may be moved or removed */
  const edited = film.existed && manifest.assembly?.film_rev !== film.rev;

  const value = film.value;
  /* video.width/height are the viewport: the stage (SPEC §1) */
  const width = manifest.video?.width;
  const height = manifest.video?.height;
  if (Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0) {
    value.stage = { w: width, h: height };
  }
  const { placed: plan, skipped } = planShots(manifest);
  /** @type {Changes} */
  const changed = noChanges();
  const before = new Set((value.tracks ?? []).map((/** @type {any} */ t) => t.attrs?.['data-framino-track']).filter(Boolean));

  /* a shot whose clips the person took out stays out: a deletion is an edit like any other */
  /** @type {Set<string>} */
  const removed = new Set();
  if (edited) {
    for (const [shot, ids] of Object.entries(manifest.assembly?.placed ?? {})) {
      if (Array.isArray(ids) && ids.length && clipsOfShot(value, shot).length === 0) removed.add(shot);
    }
  }

  for (const placement of plan) {
    placeVideo(value, placement, fade, changed, removed);
    const voice = voiceoverOf(manifest, placement.shot);
    if (voice) {
      placeSound(value, 'voiceover', {
        src: voice.path,
        wanted: `${placement.shot.shot_id}-vo`,
        at: placement.at,
        volume: manifest.audio?.voiceover_volume,
        attrs: {
          'data-shot-id': placement.shot.shot_id,
          'data-scene-id': placement.shot.scene_id,
          'data-asset-id': voice.asset_id,
          ...(voice.origin === 'agent-code' ? { 'data-framino-test': 'true' } : {}),
        },
      }, { ours: !edited, shot: placement.shot.shot_id }, changed, removed);
    }
  }

  /* the music bed: one sound for the whole film, at the manifest's level */
  const music = validAsset(manifest, manifest.audio?.music);
  if (music) {
    placeSound(value, 'music', {
      src: music.path,
      wanted: music.asset_id,
      volume: manifest.audio?.music_volume,
      attrs: {
        'data-asset-id': music.asset_id,
        ...(music.origin === 'agent-code' ? { 'data-framino-test': 'true' } : {}),
      },
    }, { ours: !edited, shot: null }, changed, removed);
  }

  /* captions: one cue per shot that has a subtitle, on the film second its picture really starts at */
  const atOf = new Map(plan.map((p) => [p.shot.shot_id, clipsOn(value, 'video', p.shot.shot_id)[0]?.at ?? p.at]));
  const captions = captionFile(plan.map((p) => ({ ...p, at: atOf.get(p.shot.shot_id) ?? p.at })), await readText(join(root, CAPTIONS_PATH)));
  changed.captions = captions.added;
  if (captions.text != null && (captions.added.length || trackOfRole(value, 'captions') >= 0)) {
    const track = ensureTrack(value, 'captions');
    const language = manifest.captions?.language;
    track.captions = {
      src: manifest.captions?.path ?? CAPTIONS_PATH,
      kind: 'captions',
      ...(isText(language) ? { srclang: language, label: manifest.captions?.label ?? language } : {}),
    };
  }

  for (const role of TRACK_ROLES) if (trackOfRole(value, role) >= 0 && !before.has(role)) changed.tracks.push(role);

  const text = filmHtml(value, film.text);
  const check = readFilmFile(text);
  if (check.problems.length || check.value == null) {
    throw new ManifestError({
      code: 'invalid_request',
      message: `the film this manifest makes does not read back, so it was not written: ${check.problems.join('; ')}`,
      retryable: false,
    }, join(root, FILM_FILE));
  }
  assertStable(check.value, text, 'the assembled film');

  const written = text !== film.text;
  if (written) await writeAtomic(join(root, FILM_FILE), text, 'utf8');
  const captionPath = join(root, manifest.captions?.path ?? CAPTIONS_PATH);
  if (captions.text != null && captions.text !== await readText(captionPath)) {
    await mkdir(dirname(captionPath), { recursive: true });
    await writeAtomic(captionPath, captions.text, 'utf8');
  }

  const rev = filmRev(text);
  const placed = placedIn(check.value, manifest);
  manifest.assembly = { ...(manifest.assembly ?? {}), film_rev: rev, at: now, placed };
  const saved = await writeManifest(root, manifest, { now });
  Object.assign(manifest, saved);

  return {
    film_rev: rev,
    at: now,
    placed,
    added: changed.added,
    retaken: changed.retaken,
    levelled: changed.levelled,
    captions: changed.captions,
    tracks: changed.tracks,
    skipped,
    edited,
    written,
    manifest: saved,
  };
}

/**
 * Read `film.html` back into `manifest.assembly`: `placed` is the clip ids each shot became, found by
 * `data-shot-id` (a Studio split leaves one shot with several clips), and `film_rev` is the film's current revision.
 * `edited` says whether the film had changed since the last assembly, which is the person's edit.
 * @param {string} root the project folder
 * @param {Record<string, any>} manifest the manifest; its `assembly` is updated in place
 * @param {{ now?: string, write?: boolean }} [options] `write: false` leaves the manifest on disk as it was
 * @returns {Promise<{ film_rev: string, at: string, placed: Record<string, string[]>, edited: boolean, manifest: Record<string, any> }>}
 */
export async function readAssembly(root, manifest, { now = new Date().toISOString(), write = true } = {}) {
  const film = await filmAt(root);
  if (film.value == null) {
    const problems = readFilmFile(film.text).problems;
    throw new ManifestError({
      code: 'invalid_request',
      message: `${FILM_FILE} does not read, so what it holds cannot be recorded: ${problems.join('; ')}`,
      retryable: false,
    }, join(root, FILM_FILE));
  }
  const edited = film.existed && manifest.assembly?.film_rev !== film.rev;
  const placed = placedIn(film.value, manifest);
  manifest.assembly = { ...(manifest.assembly ?? {}), film_rev: film.rev, at: now, placed };
  const saved = write ? await writeManifest(root, manifest, { now }) : manifest;
  if (write) Object.assign(manifest, saved);
  return { film_rev: film.rev, at: now, placed, edited, manifest: saved };
}
