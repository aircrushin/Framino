// @ts-check
/**
 * The asset pipeline: what makes every file a shot depends on trustworthy and addressable.
 *
 * Contract: `docs/FRAMINO_INTEGRATION_CONTRACT.md` §8 (asset validity, the spec this file implements), §4 (`assets[]`,
 * the shape it writes), §2 (asset ids), §7 (the one error shape), §9 (real vs test). Module brief:
 * `docs/FRAMINO_ASSET_PIPELINE.md`.
 *
 * Three things, and nothing else:
 *
 * - `probe(path)` asks ffprobe what a file is: its streams, codecs, picture size, frame rate, length.
 * - `validate(path, options)` decides `valid` or `invalid` by §8 and says why in a sentence a person can act on.
 * - `record(root, asset, options)` validates, hashes, and writes the entry into `manifest.assets[]` through
 *   `updateManifest`, so the ledger is never written by hand and never half-written.
 *
 * What it must not do, and does not: it never writes `film.html`, never writes `.film/`, never calls a vendor, and
 * never downloads. Files from `openfilm get` are already under `assets/` (Studio's `get.mjs` `land()`); this module
 * judges what landed. The Adapter places only `valid` assets (§8), so the `status` written here is what decides
 * whether a shot can reach the film.
 *
 * Why ffprobe is called here rather than through `studio/server/providers/common.mjs`: that file's `mediaSeconds`
 * (:328) is the same call (`execFile('ffprobe', ['-v', 'error', ...], { timeout: 15_000 })`) but asks only for
 * `format=duration` and answers `null` for both "not media" and "could not read it", and `mp4Facts` (:287) /
 * `wavSeconds` (:228) parse bytes already in memory rather than probing. §8 needs the stream kinds, the codecs, the
 * picture size and the reason a file does not decode, none of which those helpers give. `probe` therefore makes the
 * same call with `-show_format -show_streams` and the same 15 s timeout, and `common.mjs` is left untouched.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, sep } from 'node:path';
import { ASSET_KINDS, ManifestError, assetId, projectAssetId, readManifest, toMs, updateManifest } from './manifest.mjs';

/** The folder a shot's media lives in (§3). §8's "the file exists under `assets/`" is checked against this. */
export const ASSETS_DIR = 'assets';

/** §3 puts the caption track in `captions/`, not `assets/`. A subtitle is accepted in either place. */
export const CAPTIONS_DIR = 'captions';

/** §8: a video shorter than this is not a clip. */
export const MIN_VIDEO_SEC = 0.5;

/** §8: how far a clip's length may be from the length asked for before the difference has to be recorded. */
export const DURATION_TOLERANCE_SEC = 0.5;

/** ffprobe gets the same 15 s `mediaSeconds` gives it: a probe that hangs is a broken file, not a slow one. */
const PROBE_TIMEOUT_MS = 15_000;

/** A probe's JSON for a file with many streams is still small; this is a guard, not a limit in practice. */
const PROBE_MAX_BYTES = 8 * 1024 * 1024;

/** How much of a file is read to tell what container it is. */
const HEAD_BYTES = 4096;

/** Which stream family each asset kind has to decode as. ffprobe calls a picture's stream a video stream. */
const KIND_FAMILY = /** @type {Record<string, 'video' | 'image' | 'audio' | 'subtitle'>} */ ({
  video: 'video',
  image: 'image',
  voiceover: 'audio',
  music: 'audio',
  sfx: 'audio',
  subtitle: 'subtitle',
});

/** The family a file name alone can decide. An audio file cannot say voiceover from music from sfx. */
const EXTENSION_FAMILY = /** @type {Record<string, 'video' | 'image' | 'audio' | 'subtitle'>} */ ({
  '.mp4': 'video', '.m4v': 'video', '.mov': 'video', '.webm': 'video', '.mkv': 'video', '.avi': 'video',
  '.ogv': 'video', '.mpg': 'video', '.mpeg': 'video', '.ts': 'video',
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.webp': 'image', '.gif': 'image', '.bmp': 'image',
  '.tif': 'image', '.tiff': 'image', '.svg': 'image', '.avif': 'image',
  '.wav': 'audio', '.mp3': 'audio', '.m4a': 'audio', '.aac': 'audio', '.flac': 'audio', '.ogg': 'audio',
  '.oga': 'audio', '.opus': 'audio', '.aiff': 'audio', '.aif': 'audio',
  '.vtt': 'subtitle', '.srt': 'subtitle', '.ass': 'subtitle', '.ssa': 'subtitle',
});

/** How a family is named in a sentence. ffprobe calls a picture a video stream; a person calls it a picture. */
const FAMILY_WORD = /** @type {Record<string, string>} */ ({
  video: 'video', image: 'picture', audio: 'audio', subtitle: 'subtitle',
});

/**
 * What ffprobe can tell about a file. Every field is null when ffprobe could not tell it, so a caller never has to
 * ask whether a key exists.
 * @typedef {{
 *   duration_sec: number | null, width: number | null, height: number | null, fps: number | null,
 *   video_codec: string | null, audio_codec: string | null, audio_channels: number | null,
 *   sample_rate: number | null, format: string | null,
 * }} ProbeFacts
 */

/**
 * The `media` object of an `assets[]` entry (§4): what ffprobe said, plus the bytes on disk and, when a length was
 * asked for, how far the file is from it. §8's "or the difference is recorded" is `duration_delta_sec`.
 * @typedef {ProbeFacts & {
 *   size_bytes: number | null, sha256: string | null,
 *   duration_requested_sec: number | null, duration_delta_sec: number | null,
 *   duration_within_tolerance: boolean | null,
 * }} MediaFacts
 */

/**
 * What `validate` answers. `invalid_reason` is null exactly when `status` is `valid`. `kind` is what it judged the
 * file as: the kind passed in, or the family its name implied (`video`, `image`, `audio`, `subtitle`).
 * @typedef {{ status: 'valid' | 'invalid', invalid_reason: string | null, media: MediaFacts, path: string, kind: string | null }} Validation
 */

/** What `probe` answers: ffprobe's verdict, the facts it gave, and the streams behind them. */
/** @typedef {{ ok: boolean, error: string | null, facts: ProbeFacts, streams: Record<string, any>[] }} Probe */

/** @param {unknown} value @returns {value is Record<string, any>} */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A number ffprobe printed, or null. ffprobe prints everything as a string. */
function numberOf(/** @type {unknown} */ value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** A whole number ffprobe printed, or null. */
function wholeOf(/** @type {unknown} */ value) {
  const n = numberOf(value);
  return n === null ? null : Math.round(n);
}

/** `30/1` to 30, `30000/1001` to 29.97, null when it is not a rate. */
function rateOf(/** @type {unknown} */ value) {
  if (typeof value !== 'string') return null;
  const [n, d] = value.split('/').map(Number);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0 || n <= 0) return null;
  return toMs(n / d);
}

/** An error a caller can act on, in §7's shape. */
function invalidRequest(/** @type {string} */ message) {
  return new ManifestError({ code: 'invalid_request', message, retryable: false });
}

/** The first useful line of ffprobe's complaint, without its `[demuxer @ 0x...]` prefix. */
function reasonOf(/** @type {string} */ stderr) {
  const line = stderr.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';
  /* ffprobe prints the demuxer's address as `0x1a2b` on Unix and as a bare hex run on Windows */
  return line.replace(/^\[[^\]]*@\s*(?:0x)?[0-9a-f]+\]\s*/i, '').trim();
}

/**
 * What a file is, from its first bytes: a container name, or null when nothing here recognises it.
 *
 * This is not a media parser and it does not decide validity. It only separates "this file is not media at all" (a
 * text file named `.mp4`) from "this file is media that did not finish arriving" (an MP4 cut in half), because those
 * are two different things for the person to do something about, and ffprobe says "moov atom not found" for both.
 * @param {Buffer} b
 * @returns {string | null}
 */
function containerOf(b) {
  const ascii = (/** @type {number} */ at, /** @type {number} */ len) => b.toString('latin1', at, at + len);
  if (b.length >= 12 && ascii(4, 4) === 'ftyp') return 'mp4';
  if (b.length >= 12 && ['moov', 'mdat', 'wide', 'free', 'skip'].includes(ascii(4, 4))) return 'mp4';
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'matroska';
  if (b.length >= 12 && ascii(0, 4) === 'RIFF') {
    const kind = ascii(8, 4);
    if (kind === 'WAVE') return 'wav';
    if (kind === 'AVI ') return 'avi';
    if (kind === 'WEBP') return 'webp';
    return 'riff';
  }
  if (b.length >= 12 && ascii(0, 4) === 'FORM' && ['AIFF', 'AIFC'].includes(ascii(8, 4))) return 'aiff';
  if (b.length >= 4 && ascii(0, 4) === 'OggS') return 'ogg';
  if (b.length >= 4 && ascii(0, 4) === 'fLaC') return 'flac';
  if (b.length >= 3 && ascii(0, 3) === 'ID3') return 'mp3';
  if (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return 'mpeg-audio';
  if (b.length >= 2 && b[0] === 0x0b && b[1] === 0x77) return 'ac3';
  if (b.length >= 8 && b[0] === 0x89 && ascii(1, 3) === 'PNG') return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 4 && ascii(0, 4) === 'GIF8') return 'gif';
  if (b.length >= 2 && ascii(0, 2) === 'BM') return 'bmp';
  if (b.length >= 4 && (ascii(0, 4) === 'II*\u0000' || ascii(0, 4) === 'MM\u0000*')) return 'tiff';
  if (b.length >= 3 && ascii(0, 3) === 'FLV') return 'flv';
  if (b.length >= 1 && b[0] === 0x47 && (b.length < 189 || b[188] === 0x47)) return 'mpeg-ts';
  const text = b.toString('utf8', 0, Math.min(b.length, 1024)).replace(/^\uFEFF/, '').trimStart();
  if (/^WEBVTT\b/i.test(text)) return 'webvtt';
  if (/^(?:\d+\s*\r?\n)?\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->/.test(text)) return 'srt';
  if (/^(?:<\?xml\b|<svg\b)/i.test(text)) return 'svg';
  return null;
}

/** The first bytes of a file, for `containerOf`. */
async function headOf(/** @type {string} */ path) {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * The sha256 of a file, streamed so a long clip does not have to fit in memory. §8: an asset is valid only when its
 * `sha256` is recorded, and §6's `request_key` is built from hashes of files, so this is the one hash everything uses.
 * @param {string} path
 * @returns {Promise<string>}
 */
export function sha256File(path) {
  return new Promise((done, fail) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', fail);
    stream.on('end', () => done(hash.digest('hex')));
  });
}

/** Every field of `ProbeFacts`, null: what a probe that could not read the file answers. */
function noFacts() {
  return /** @type {ProbeFacts} */ ({
    duration_sec: null, width: null, height: null, fps: null,
    video_codec: null, audio_codec: null, audio_channels: null, sample_rate: null, format: null,
  });
}

/**
 * What ffprobe says a file is. Never throws for a file it cannot read: a broken file is an answer, not an error.
 *
 * The call is `mediaSeconds`' (`providers/common.mjs` :328) with the entries §8 needs added: `-v error`, JSON, a 15 s
 * timeout. `ok` is false when ffprobe failed or found no stream at all, and `error` then carries its own words.
 * @param {string} path
 * @returns {Promise<Probe>}
 */
export function probe(path) {
  return new Promise((done) => {
    execFile(
      'ffprobe',
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path],
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: PROBE_MAX_BYTES },
      (error, stdout, stderr) => {
        /** @type {Record<string, any> | null} */
        let parsed = null;
        try {
          parsed = JSON.parse(String(stdout));
        } catch {
          parsed = null;
        }
        const streams = Array.isArray(parsed?.streams) ? parsed.streams.filter(isObject) : [];
        const format = isObject(parsed?.format) ? parsed.format : {};
        const said = reasonOf(String(stderr ?? ''));
        if (error || !streams.length) {
          const why = said || (error ? error.message : 'ffprobe found no stream');
          done({ ok: false, error: why, facts: noFacts(), streams: [] });
          return;
        }
        /* a still picture has no length and a container may not either: fall back to the longest stream */
        const streamSeconds = streams
          .map((s) => numberOf(s.duration))
          .filter((/** @type {number | null} */ n) => n !== null);
        const duration = numberOf(format.duration)
          ?? (streamSeconds.length ? Math.max(.../** @type {number[]} */ (streamSeconds)) : null);
        const video = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1) ?? null;
        const audio = streams.find((s) => s.codec_type === 'audio') ?? null;
        done({
          ok: true,
          error: null,
          streams,
          facts: {
            duration_sec: duration === null ? null : toMs(duration),
            width: video ? wholeOf(video.width) : null,
            height: video ? wholeOf(video.height) : null,
            fps: video ? (rateOf(video.avg_frame_rate) ?? rateOf(video.r_frame_rate)) : null,
            video_codec: video && typeof video.codec_name === 'string' ? video.codec_name : null,
            audio_codec: audio && typeof audio.codec_name === 'string' ? audio.codec_name : null,
            audio_channels: audio ? wholeOf(audio.channels) : null,
            sample_rate: audio ? wholeOf(audio.sample_rate) : null,
            format: typeof format.format_name === 'string' ? format.format_name : null,
          },
        });
      },
    );
  });
}

/** `1 stream: audio`, for a sentence about what ffprobe did find. */
function streamsSaid(/** @type {Record<string, any>[]} */ streams) {
  if (!streams.length) return 'no streams';
  const kinds = streams.map((s) => String(s.codec_type ?? 'unknown'));
  return `${streams.length} stream${streams.length === 1 ? '' : 's'}: ${kinds.join(', ')}`;
}

/** The family a file name implies, or null. */
function familyOfPath(/** @type {string} */ rel) {
  return EXTENSION_FAMILY[extname(rel).toLowerCase()] ?? null;
}

/** The family an asset kind has to decode as, or null when the kind is not one of §4's. */
function familyOfKind(/** @type {string} */ kind) {
  return KIND_FAMILY[kind] ?? null;
}

/**
 * Whether a path is where §8 says an asset lives: under `assets/`.
 *
 * §3 puts the caption track in `captions/` (`captions/film.vtt`), not in `assets/`, so a subtitle is accepted in
 * either place. Every other kind has to be under `assets/`.
 * @param {string} rel a path relative to the project, with forward slashes
 * @param {string | null} family
 */
function underAssets(rel, family) {
  if (rel.startsWith(`${ASSETS_DIR}/`)) return true;
  return family === 'subtitle' && rel.startsWith(`${CAPTIONS_DIR}/`);
}

/** A path relative to the project, with forward slashes, as the manifest stores it. */
function relativeTo(/** @type {string} */ root, /** @type {string} */ path) {
  const abs = isAbsolute(path) ? path : join(root, path);
  return relative(root, abs).split(sep).join('/');
}

/** Every field of `MediaFacts` that is not a probe fact, null. */
function noFileFacts() {
  return {
    size_bytes: /** @type {number | null} */ (null),
    sha256: /** @type {string | null} */ (null),
    duration_requested_sec: /** @type {number | null} */ (null),
    duration_delta_sec: /** @type {number | null} */ (null),
    duration_within_tolerance: /** @type {boolean | null} */ (null),
  };
}

/**
 * The `media` object for a file, from whatever is known about it. §8's duration rule is applied here: the difference
 * from the length asked for is recorded, and `duration_within_tolerance` says whether it is inside ±0.5 s.
 * @param {ProbeFacts} facts
 * @param {{ size_bytes?: number | null, sha256?: string | null, duration?: number | null }} [known]
 * @returns {MediaFacts}
 */
function mediaOf(facts, known = {}) {
  const media = /** @type {MediaFacts} */ ({ ...facts, ...noFileFacts() });
  media.size_bytes = known.size_bytes ?? null;
  media.sha256 = known.sha256 ?? null;
  if (typeof known.duration === 'number' && Number.isFinite(known.duration)) {
    media.duration_requested_sec = toMs(known.duration);
    if (media.duration_sec !== null) {
      const delta = toMs(media.duration_sec - known.duration);
      media.duration_delta_sec = delta;
      media.duration_within_tolerance = Math.abs(delta) <= DURATION_TOLERANCE_SEC;
    }
  }
  return media;
}

/**
 * Whether a file is a usable asset, by §8, and why not when it is not.
 *
 * An asset is `valid` only when all of these hold:
 *
 * - the file exists under `assets/`, its size is above 0, and its `sha256` is recorded;
 * - it decodes: ffprobe returns a stream of the expected kind;
 * - video: at least 0.5 s long and within ±0.5 s of the length asked for, or the difference is recorded; width and
 *   height above 0;
 * - audio: at least one audio stream, and a length above 0;
 * - it is not a partial download: the HTTP `Content-Length`, when given, equals the bytes on disk.
 *
 * The expected kind is `options.kind` when given, else what the file name implies (`.mp4` is a video, `.vtt` is a
 * subtitle, `.wav` is audio). A name that implies nothing is `invalid`: this module will not guess.
 *
 * @param {string} path absolute, or relative to `options.root` (or to the working folder when there is no root)
 * @param {{ root?: string | null, kind?: string | null, duration?: number | null, contentLength?: number | null }} [options]
 *   `root` is the project folder: when it is given the file has to be inside it, under `assets/`. `duration` is the
 *   length asked for, in seconds. `contentLength` is the HTTP `Content-Length` the download reported, when it did.
 * @returns {Promise<Validation>}
 */
export async function validate(path, options = {}) {
  const { root = null, kind = null, duration = null, contentLength = null } = options;
  const rel = root ? relativeTo(root, path) : path.split(sep).join('/');
  const abs = root ? join(root, rel) : (isAbsolute(path) ? path : join(process.cwd(), path));

  /* the kind this call judges against: the one asked for, or the family the name implies. Reported back either way,
     so a caller that passed none still learns what it was judged as. */
  let judged = kind;
  /** @type {(reason: string, media?: MediaFacts) => Validation} */
  const no = (reason, media) => ({
    status: 'invalid', invalid_reason: reason, media: media ?? mediaOf(noFacts()), path: rel, kind: judged,
  });

  if (kind !== null && familyOfKind(kind) === null) {
    return no(`"${kind}" is not a kind of asset: one of ${ASSET_KINDS.join(', ')}`);
  }
  const family = kind === null ? familyOfPath(rel) : familyOfKind(kind);
  if (family === null) {
    return no(`the kind of this file cannot be told from its name (${extname(rel) || 'no extension'}); pass one`);
  }
  /* an audio file cannot say which of the three audio kinds it is, so it is judged as audio and reported as such */
  judged = kind ?? family;
  if (root !== null) {
    if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
      return no(`the file is not in this project: ${rel}`);
    }
    if (!underAssets(rel, family)) {
      return no(`the file is not under ${ASSETS_DIR}/: ${rel}`);
    }
  }

  /** @type {import('node:fs').Stats} */
  let stats;
  try {
    stats = await stat(abs);
  } catch (e) {
    const code = /** @type {NodeJS.ErrnoException} */ (e).code;
    return no(code === 'ENOENT' || code === 'ENOTDIR'
      ? `the file is not there: ${rel}`
      : `the file cannot be read (${code}): ${rel}`);
  }
  if (!stats.isFile()) return no(`the path is not a file: ${rel}`);

  const size = stats.size;
  const sha256 = await sha256File(abs);
  if (size === 0) {
    return no(`the file is empty (0 bytes): ${rel}`, mediaOf(noFacts(), { size_bytes: 0, sha256, duration }));
  }
  if (typeof contentLength === 'number' && Number.isFinite(contentLength) && contentLength !== size) {
    return no(
      `the download is partial: Content-Length is ${contentLength} bytes but the file is ${size}: ${rel}`,
      mediaOf(noFacts(), { size_bytes: size, sha256, duration }),
    );
  }

  const probed = await probe(abs);
  if (!probed.ok) {
    const container = containerOf(await headOf(abs));
    return no(
      container === null
        ? `the file is not media: nothing in it is a video, picture, audio or subtitle container: ${rel}`
        : `the file is incomplete: it starts like ${container} but ffprobe could not read it (${probed.error}): ${rel}`,
      mediaOf(noFacts(), { size_bytes: size, sha256, duration }),
    );
  }

  const media = mediaOf(probed.facts, { size_bytes: size, sha256, duration });
  const word = FAMILY_WORD[family];
  const has = family === 'image'
    ? probed.streams.some((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1)
    : probed.streams.some((s) => s.codec_type === family);
  if (!has) {
    return no(`it has no ${word} stream: ffprobe found ${streamsSaid(probed.streams)}: ${rel}`, media);
  }

  if (family === 'video' || family === 'image') {
    const sized = typeof media.width === 'number' && media.width > 0
      && typeof media.height === 'number' && media.height > 0;
    if (!sized) {
      return no(`the ${word} has no size: ffprobe reports ${media.width ?? 0} by ${media.height ?? 0}: ${rel}`, media);
    }
  }
  if (family === 'video' && (media.duration_sec === null || media.duration_sec < MIN_VIDEO_SEC)) {
    const said = media.duration_sec === null ? 'ffprobe reports no length' : `${media.duration_sec} s`;
    return no(`the video is too short: ${said}, under the ${MIN_VIDEO_SEC} s minimum: ${rel}`, media);
  }
  if (family === 'audio' && (media.duration_sec === null || media.duration_sec <= 0)) {
    const said = media.duration_sec === null ? 'none' : `${media.duration_sec} s`;
    return no(`the audio has no length: ffprobe reports ${said}: ${rel}`, media);
  }

  /* §8: a length more than ±0.5 s from the one asked for is not a failure, it is a fact to record. `media` already
     carries `duration_delta_sec` and `duration_within_tolerance`. */
  return { status: 'valid', invalid_reason: null, media, path: rel, kind: judged };
}

/**
 * Re-check an entry already in `manifest.assets[]` against the disk, the way §6's resume rule does ("if
 * `assets/video/<shot_id>-t<take>.mp4` exists and validates (§8), it is `succeeded`"). `validate` cannot read the
 * manifest, so pass the length the shot asked for when the caller has it.
 * @param {string} root the project folder
 * @param {Record<string, any>} entry an `assets[]` entry
 * @param {{ duration?: number | null }} [options]
 * @returns {Promise<Validation>}
 */
export function validateEntry(root, entry, { duration = null } = {}) {
  return validate(entry.path, {
    root,
    kind: entry.kind ?? null,
    duration: duration ?? entry.media?.duration_requested_sec ?? null,
    contentLength: entry.content_length ?? null,
  });
}

/** `video-sh01-t1` to 1, null when the id does not carry a take. */
function takeOfId(/** @type {string} */ id) {
  const found = /-t(\d+)$/.exec(id);
  return found ? Number(found[1]) : null;
}

/**
 * The kind of an asset the caller did not name, from its file name. A video, a picture or a subtitle is decided by
 * its extension; an audio file is not, because `voiceover`, `music` and `sfx` are three different kinds of audio and
 * the file name cannot say which. That one has to be named.
 * @param {string} rel
 */
function kindOfPath(/** @type {string} */ rel) {
  const family = familyOfPath(rel);
  if (family === null) {
    throw invalidRequest(`an asset needs a kind: ${extname(rel) || 'the file name'} does not say what it is, and one of ${ASSET_KINDS.join(', ')} is required`);
  }
  if (family === 'audio') {
    throw invalidRequest(`an asset needs a kind: ${rel} is audio, and voiceover, music and sfx are all audio`);
  }
  return family;
}

/**
 * The id an asset gets when the caller did not mint one, by §2's rule: `<kind>-<shot_id>-t<take>` for a shot's take,
 * `<kind>-<shot_id>` for a per-shot asset that has no takes (§3's `audio/vo-<shot_id>.wav`), and `<kind>-<name>` for
 * anything project-wide. The name is the file's stem, and a stem that already begins with the kind is used as it is,
 * so `assets/audio/music-bed.mp3` is `music-bed` and not `music-music-bed`.
 *
 * Two assets that would mint the same id are refused by `record` rather than merged, because a take's file name is
 * what makes a retry unable to overwrite anything (§2 rule 4).
 * @param {string} kind @param {Record<string, any>} asset @param {string} rel
 */
function mintId(kind, asset, rel) {
  if (asset.shot_id) {
    if (Number.isInteger(asset.take) && asset.take >= 1) return assetId(kind, asset.shot_id, asset.take);
    if (asset.take !== undefined && asset.take !== null) {
      throw invalidRequest(`a take is a whole number from 1: ${rel} names take ${asset.take}`);
    }
    return projectAssetId(kind, asset.shot_id);
  }
  const name = typeof asset.name === 'string' && asset.name ? asset.name : basename(rel, extname(rel));
  return name.startsWith(`${kind}-`) ? name : projectAssetId(kind, name);
}

/**
 * Add or update one entry in `manifest.assets[]`, with the `sha256` and the `media` facts §8 requires.
 *
 * The entry is built from what is on disk, never from what the caller says about it: `status` and `invalid_reason`
 * come from `validate`, `media.sha256` from the file, `media.duration_delta_sec` from the shot's `duration_sec` when
 * the caller does not pass `duration`. A file that fails §8 is still recorded, as `invalid` with its reason: the
 * ledger is where a broken take is listed for the report, and §8 keeps it out of `film.html` by its `status`.
 *
 * It never overwrites another take's entry. Recording `video-sh01-t2` leaves `video-sh01-t1` alone; a path already
 * recorded under a different `asset_id`, or an `asset_id` already recorded at a different path, is refused, because
 * a take's file name is what makes a retry unable to overwrite anything (§2 rule 4).
 *
 * @param {string} root the project folder
 * @param {{
 *   asset_id?: string, kind?: string, shot_id?: string, take?: number, path: string, origin: string,
 *   provider?: string, model?: string, task_id?: string, thumbnail?: string, name?: string,
 *   content_length?: number, duration?: number,
 * }} asset `path` is relative to `root` (or absolute), `origin` is §9's (`provider:<id>`, `agent-code`, ...)
 * @param {{ now?: string, expectUpdatedAt?: string }} [options]
 * @returns {Promise<{ manifest: Record<string, any>, asset: Record<string, any> }>}
 */
export async function record(root, asset, { now = new Date().toISOString(), expectUpdatedAt } = {}) {
  if (!isObject(asset) || typeof asset.path !== 'string' || !asset.path) {
    throw invalidRequest('an asset needs a path');
  }
  if (typeof asset.origin !== 'string' || !asset.origin) {
    throw invalidRequest('an asset has to say where it came from: origin is provider:<id> or one of openfilm-service, local, library, person, agent-code (§9)');
  }
  const rel = relativeTo(root, asset.path);
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
    throw invalidRequest(`the asset is not in this project: ${asset.path}`);
  }
  if (asset.kind !== undefined && asset.kind !== null && familyOfKind(asset.kind) === null) {
    throw invalidRequest(`"${asset.kind}" is not a kind of asset: one of ${ASSET_KINDS.join(', ')}`);
  }
  const kind = typeof asset.kind === 'string' && asset.kind ? asset.kind : kindOfPath(rel);

  const before = await readManifest(root);
  const shot = asset.shot_id
    ? (before.shots ?? []).find((/** @type {any} */ s) => s.shot_id === asset.shot_id) ?? null
    : null;
  if (asset.shot_id && !shot) {
    throw invalidRequest(`shot ${asset.shot_id} is not in shots[]: an asset cannot belong to a shot that does not exist`);
  }
  const id = asset.asset_id ?? mintId(kind, asset, rel);
  const take = Number.isInteger(asset.take) ? asset.take : takeOfId(id);
  const duration = asset.duration ?? (shot ? shot.duration_sec : null) ?? null;

  const checked = await validate(rel, { root, kind, duration, contentLength: asset.content_length ?? null });

  /** @type {Record<string, any>} */
  const fields = {
    asset_id: id,
    kind,
    path: rel,
    origin: asset.origin,
    status: checked.status,
    invalid_reason: checked.invalid_reason,
    media: checked.media,
  };
  if (asset.shot_id) fields.shot_id = asset.shot_id;
  if (take !== null) fields.take = take;
  for (const key of /** @type {const} */ (['provider', 'model', 'task_id', 'thumbnail'])) {
    const value = asset[key];
    if (typeof value === 'string' && value) fields[key] = value;
  }
  if (typeof asset.content_length === 'number') fields.content_length = asset.content_length;

  /** @type {Record<string, any>} */
  let written = {};
  const manifest = await updateManifest(root, (m) => {
    const assets = Array.isArray(m.assets) ? m.assets : (m.assets = []);
    const at = assets.findIndex((/** @type {any} */ a) => a.asset_id === id);
    const clash = assets.find((/** @type {any} */ a) => a.asset_id !== id && a.path === rel);
    if (clash) {
      throw invalidRequest(`${rel} is already recorded as ${clash.asset_id}: a take's file name does not change, so this would overwrite another take`);
    }
    const existing = at >= 0 ? assets[at] : null;
    if (existing && existing.path !== rel) {
      throw invalidRequest(`${id} is already recorded at ${existing.path}: a take's file name does not change, so this would move another take`);
    }
    written = { ...existing, ...fields, created_at: existing?.created_at ?? now };
    if (at >= 0) assets[at] = written;
    else assets.push(written);
  }, { expectUpdatedAt: expectUpdatedAt ?? before.updated_at, now });

  return { manifest, asset: written };
}
