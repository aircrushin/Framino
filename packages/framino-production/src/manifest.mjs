// @ts-check
/**
 * The Production Manifest: `production/manifest.json`, the plan and the ledger that every Phase 2 module reads and
 * writes. Contract: `docs/FRAMINO_INTEGRATION_CONTRACT.md` §2 (ids), §4 (shape), §6 (the ledger), §7 (errors).
 *
 * This module owns the file itself: reading it, checking it, writing it atomically, and minting the ids the contract
 * names. It does not know what a film is and it does not call a provider. The Adapter and the asset pipeline both
 * import it, so the shape is decided once.
 *
 * Ownership (§4.1): a module reads, changes only its own sections, writes, and re-reads if `updated_at` moved under
 * it. `writeManifest` therefore takes the whole manifest and refuses to write one that does not validate.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeAtomic } from '../../openfilm/studio/server/atomic.mjs';

/** The version this module writes. A field renamed or removed is a bump (§10). */
export const MANIFEST_VERSION = '0.2';

/** Where the manifest lives, relative to the project folder. */
export const MANIFEST_PATH = 'production/manifest.json';

/** The folder Framino's production state lives in: not `assets/`, not `.film/` (§3). */
export const PRODUCTION_DIR = 'production';

/** The kinds an asset can be (§4). */
export const ASSET_KINDS = /** @type {const} */ (['video', 'image', 'voiceover', 'music', 'sfx', 'subtitle']);

/** An asset's state. Only `valid` may reach `film.html` (§8). */
export const ASSET_STATUSES = /** @type {const} */ (['pending', 'downloaded', 'valid', 'invalid']);

/** A task's state (§6). `running` is resolved against the disk on the next start, never resubmitted. */
export const TASK_STATES = /** @type {const} */ (['running', 'succeeded', 'failed', 'abandoned']);

/** A shot's state (§4). */
export const SHOT_STATUSES = /** @type {const} */ (['planned', 'generating', 'generated', 'failed', 'placed']);

/** Where an asset came from (§9). A fixture or hand-made file is `agent-code` and is tagged in the film. */
export const ORIGINS = /** @type {const} */ (
  ['provider', 'openfilm-service', 'local', 'library', 'person', 'agent-code']
);

/** The aspect ratios `openfilm get video --aspect-ratio` accepts, and so the only ones a brief may name. */
export const ASPECT_RATIOS = /** @type {const} */ (
  ['16:9', '9:16', '4:3', '3:4', '1:1', '21:9', '9:21', '3:2', '2:3', 'adaptive']
);

/** The error codes of §7. */
export const ERROR_CODES = /** @type {const} */ ([
  'invalid_request', 'content_rejected', 'balance', 'rate_limited',
  'provider_error', 'timeout', 'not_connected', 'asset_invalid',
]);

/**
 * A failure a caller can act on: one of §7's codes, a message for the person, and whether trying again could work.
 * @typedef {{ code: string, message: string, retryable: boolean }} ProductionError
 */

/** Thrown when the manifest cannot be read, parsed or validated. Carries a §7 error. */
export class ManifestError extends Error {
  /** @param {ProductionError} error @param {string} [where] */
  constructor(error, where) {
    super(where ? `${error.message} (${where})` : error.message);
    this.name = 'ManifestError';
    this.code = error.code;
    this.retryable = error.retryable;
    this.where = where ?? null;
  }
}

/** @param {string} message @param {string} [where] */
const invalid = (message, where) => new ManifestError({ code: 'invalid_request', message, retryable: false }, where);

/** Times are seconds rounded to milliseconds, like the format's `toMs`. */
export const toMs = (/** @type {number} */ seconds) => Math.round(seconds * 1000) / 1000;

/** @param {unknown} value @returns {value is Record<string, any>} */
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** @param {unknown} value */
const isText = (value) => typeof value === 'string' && value.length > 0;

/** @param {unknown} value */
const isCount = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/**
 * Whether a value is one of §9's origins: `provider:<id>` for a vendor, or one of the named ones. A fixture or a
 * hand-made file is `agent-code`, and the Adapter tags its clip `data-framino-test="true"`.
 * @param {unknown} value
 */
function isOrigin(value) {
  if (typeof value !== 'string') return false;
  if (value.startsWith('provider:')) return value.length > 'provider:'.length;
  return /** @type {readonly string[]} */ (ORIGINS).includes(value);
}

const PROJECT_ID = /^[a-z0-9-]{1,64}$/;
const SCENE_ID = /^sc\d{2}$/;
const SHOT_ID = /^sh\d{2}$/;

/** `sh03` for 3. Ids are minted once and never reused (§2). */
export const shotId = (/** @type {number} */ n) => `sh${String(n).padStart(2, '0')}`;

/** `sc01` for 1. */
export const sceneId = (/** @type {number} */ n) => `sc${String(n).padStart(2, '0')}`;

/** `video-sh03-t2` for a per-shot asset; `music-bed` for a project-wide one (§2). */
export const assetId = (/** @type {string} */ kind, /** @type {string} */ shot, /** @type {number} */ take) =>
  `${kind}-${shot}-t${take}`;

/** `music-bed`: an asset that belongs to no shot. */
export const projectAssetId = (/** @type {string} */ kind, /** @type {string} */ name) => `${kind}-${name}`;

/** `t2-sh03`: one generation run (§2). */
export const taskId = (/** @type {number} */ take, /** @type {string} */ shot) => `t${take}-${shot}`;

/** `assets/video/sh03-t2.mp4`: the file name carries the take, which is what makes a retry unable to overwrite. */
export const videoPath = (/** @type {string} */ shot, /** @type {number} */ take) =>
  `assets/video/${shot}-t${take}.mp4`;

/**
 * The canonical JSON of a value: keys sorted at every level, no whitespace. What a hash is taken of.
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isObject(value)) {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * `request_key` per §6: what makes two calls the same request. A new take is a new key, so nothing is ever forced.
 * @param {{
 *   project_id: string, shot_id: string, take: number, provider: string, model: string, prompt: string,
 *   duration: number, aspect_ratio: string, resolution: string,
 *   first_frame_sha256?: string | null, last_frame_sha256?: string | null,
 *   reference_sha256s?: string[],
 * }} request
 */
export function requestKey(request) {
  const canonical = canonicalJson({
    project_id: request.project_id,
    shot_id: request.shot_id,
    take: request.take,
    provider: request.provider,
    model: request.model,
    prompt: request.prompt,
    duration: toMs(request.duration),
    aspect_ratio: request.aspect_ratio,
    resolution: request.resolution,
    first_frame_sha256: request.first_frame_sha256 ?? null,
    last_frame_sha256: request.last_frame_sha256 ?? null,
    reference_sha256s: [...(request.reference_sha256s ?? [])].sort(),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * A manifest that validates, with nothing planned in it yet. The Skill fills `brief`, `scenes` and `shots`; the
 * Adapter fills `assembly`; the pipeline fills `assets`.
 * @param {{ project_id: string, title?: string, now?: string }} about
 */
export function newManifest({ project_id, title, now = new Date().toISOString() }) {
  return {
    manifest_version: MANIFEST_VERSION,
    project_id,
    title: title ?? project_id,
    created_at: now,
    updated_at: now,
    brief: {
      idea: '',
      audience: '',
      platform: 'youtube',
      language: 'en',
      duration_sec: 30,
      aspect_ratio: '16:9',
      style: '',
      limits: { max_generated_seconds: 45, max_takes_per_shot: 3 },
    },
    video: { width: 1920, height: 1080, fps: 30 },
    approval: {
      script: { state: 'draft', at: null },
      storyboard: { state: 'draft', at: null },
    },
    scenes: [],
    shots: [],
    assets: [],
    tasks: [],
    audio: { music: null, music_volume: 0.35, voiceover_volume: 1.0 },
    captions: { path: 'captions/film.vtt', language: 'en' },
    assembly: { film_rev: null, at: null, placed: {} },
  };
}

/**
 * Every problem in a manifest, as a dotted path and a sentence. Empty means it validates. Unknown fields are kept and
 * ignored (§4.2), so they are never a problem.
 * @param {unknown} manifest
 * @returns {{ path: string, message: string }[]}
 */
export function problemsIn(manifest) {
  /** @type {{ path: string, message: string }[]} */
  const problems = [];
  const need = (/** @type {boolean} */ ok, /** @type {string} */ path, /** @type {string} */ message) => {
    if (!ok) problems.push({ path, message });
  };

  if (!isObject(manifest)) {
    problems.push({ path: '', message: 'the manifest has to be an object' });
    return problems;
  }
  const m = /** @type {Record<string, any>} */ (manifest);

  need(m.manifest_version === MANIFEST_VERSION, 'manifest_version',
    `has to be "${MANIFEST_VERSION}" (a renamed or removed field is a version bump, §10)`);
  need(typeof m.project_id === 'string' && PROJECT_ID.test(m.project_id), 'project_id',
    'has to be the project folder name: [a-z0-9-], 1 to 64 characters');
  need(isText(m.title), 'title', 'has to be text');
  need(isText(m.created_at), 'created_at', 'has to be an ISO time');
  need(isText(m.updated_at), 'updated_at', 'has to be an ISO time');

  /* brief */
  if (!isObject(m.brief)) problems.push({ path: 'brief', message: 'has to be an object' });
  else {
    const b = m.brief;
    need(typeof b.idea === 'string', 'brief.idea', 'has to be text (empty before the Skill writes it)');
    need(ASPECT_RATIOS.includes(b.aspect_ratio), 'brief.aspect_ratio',
      `has to be one of ${ASPECT_RATIOS.join(', ')}`);
    need(isCount(b.duration_sec) && b.duration_sec > 0, 'brief.duration_sec', 'has to be a positive number of seconds');
    need(isText(b.language), 'brief.language', 'has to be a BCP 47 tag');
    if (b.limits !== undefined) {
      need(isObject(b.limits), 'brief.limits', 'has to be an object');
      if (isObject(b.limits) && b.limits.max_takes_per_shot !== undefined) {
        need(Number.isInteger(b.limits.max_takes_per_shot) && b.limits.max_takes_per_shot > 0,
          'brief.limits.max_takes_per_shot', 'has to be a positive whole number');
      }
    }
  }

  /* video: what becomes film.html's viewport */
  if (!isObject(m.video)) problems.push({ path: 'video', message: 'has to be an object' });
  else {
    need(Number.isInteger(m.video.width) && m.video.width > 0, 'video.width', 'has to be a positive whole number');
    need(Number.isInteger(m.video.height) && m.video.height > 0, 'video.height', 'has to be a positive whole number');
    need(isCount(m.video.fps) && m.video.fps > 0, 'video.fps', 'has to be a positive number');
  }

  /* approval: the Skill may not generate before both are approved (§4) */
  if (!isObject(m.approval)) problems.push({ path: 'approval', message: 'has to be an object' });
  else {
    for (const step of ['script', 'storyboard']) {
      const a = m.approval[step];
      need(isObject(a) && ['draft', 'approved'].includes(a.state), `approval.${step}.state`,
        'has to be "draft" or "approved"');
    }
  }

  /* scenes */
  if (!Array.isArray(m.scenes)) problems.push({ path: 'scenes', message: 'has to be an array' });
  else {
    const seen = new Set();
    m.scenes.forEach((/** @type {any} */ scene, /** @type {number} */ i) => {
      const at = `scenes[${i}]`;
      if (!isObject(scene)) return problems.push({ path: at, message: 'has to be an object' });
      need(typeof scene.scene_id === 'string' && SCENE_ID.test(scene.scene_id), `${at}.scene_id`,
        'has to be sc + two digits');
      need(!seen.has(scene.scene_id), `${at}.scene_id`, 'is used by another scene');
      seen.add(scene.scene_id);
      need(Array.isArray(scene.shots), `${at}.shots`, 'has to be an array of shot ids');
    });
  }

  /* shots */
  const shotIds = new Set();
  if (!Array.isArray(m.shots)) problems.push({ path: 'shots', message: 'has to be an array' });
  else {
    const orders = new Set();
    m.shots.forEach((/** @type {any} */ shot, /** @type {number} */ i) => {
      const at = `shots[${i}]`;
      if (!isObject(shot)) return problems.push({ path: at, message: 'has to be an object' });
      need(typeof shot.shot_id === 'string' && SHOT_ID.test(shot.shot_id), `${at}.shot_id`,
        'has to be sh + two digits');
      need(!shotIds.has(shot.shot_id), `${at}.shot_id`, 'is used by another shot; a shot id is never reused');
      shotIds.add(shot.shot_id);
      need(typeof shot.scene_id === 'string' && SCENE_ID.test(shot.scene_id), `${at}.scene_id`,
        'has to be sc + two digits');
      need(Number.isInteger(shot.order) && shot.order > 0, `${at}.order`, 'has to be a positive whole number');
      need(!orders.has(shot.order), `${at}.order`, 'is used by another shot');
      orders.add(shot.order);
      need(isCount(shot.duration_sec) && shot.duration_sec > 0, `${at}.duration_sec`,
        'has to be a positive number of seconds');
      need(isText(shot.generation_prompt), `${at}.generation_prompt`, 'has to be text: the call needs one');
      if (shot.status !== undefined) {
        need(SHOT_STATUSES.includes(shot.status), `${at}.status`, `has to be one of ${SHOT_STATUSES.join(', ')}`);
      }
      if (shot.takes !== undefined) need(Array.isArray(shot.takes), `${at}.takes`, 'has to be an array of asset ids');
      if (shot.reference_assets !== undefined) {
        need(Array.isArray(shot.reference_assets), `${at}.reference_assets`, 'has to be an array of asset ids');
      }
    });
  }

  /* assets */
  const assetIds = new Set();
  if (!Array.isArray(m.assets)) problems.push({ path: 'assets', message: 'has to be an array' });
  else {
    m.assets.forEach((/** @type {any} */ asset, /** @type {number} */ i) => {
      const at = `assets[${i}]`;
      if (!isObject(asset)) return problems.push({ path: at, message: 'has to be an object' });
      need(isText(asset.asset_id), `${at}.asset_id`, 'has to be text');
      need(!assetIds.has(asset.asset_id), `${at}.asset_id`, 'is used by another asset');
      assetIds.add(asset.asset_id);
      need(ASSET_KINDS.includes(asset.kind), `${at}.kind`, `has to be one of ${ASSET_KINDS.join(', ')}`);
      need(ASSET_STATUSES.includes(asset.status), `${at}.status`, `has to be one of ${ASSET_STATUSES.join(', ')}`);
      need(isText(asset.path), `${at}.path`, 'has to be a path under assets/');
      need(isOrigin(asset.origin), `${at}.origin`,
        `has to be provider:<id> or one of ${ORIGINS.join(', ')}`);
      if (asset.status === 'invalid') {
        need(isText(asset.invalid_reason), `${at}.invalid_reason`, 'an invalid asset has to say why');
      }
      if (asset.shot_id !== undefined && asset.shot_id !== null) {
        need(shotIds.has(asset.shot_id), `${at}.shot_id`, 'names a shot that is not in shots[]');
      }
    });
  }

  /* tasks: the ledger (§6) */
  const taskIds = new Set();
  if (!Array.isArray(m.tasks)) problems.push({ path: 'tasks', message: 'has to be an array' });
  else {
    m.tasks.forEach((/** @type {any} */ task, /** @type {number} */ i) => {
      const at = `tasks[${i}]`;
      if (!isObject(task)) return problems.push({ path: at, message: 'has to be an object' });
      need(isText(task.task_id), `${at}.task_id`, 'has to be text');
      need(!taskIds.has(task.task_id), `${at}.task_id`, 'is used by another task');
      taskIds.add(task.task_id);
      need(typeof task.shot_id === 'string' && shotIds.has(task.shot_id), `${at}.shot_id`,
        'has to name a shot in shots[]');
      need(isText(task.asset_id), `${at}.asset_id`, 'has to name the take this task makes');
      need(isText(task.request_key), `${at}.request_key`, 'has to be the sha256 of the canonical request');
      need(TASK_STATES.includes(task.state), `${at}.state`, `has to be one of ${TASK_STATES.join(', ')}`);
      need(Number.isInteger(task.attempts) && task.attempts >= 1, `${at}.attempts`, 'has to be 1 or more');
      if (task.state === 'failed' && task.error !== undefined && task.error !== null) {
        need(isObject(task.error) && ERROR_CODES.includes(task.error.code), `${at}.error.code`,
          `has to be one of ${ERROR_CODES.join(', ')}`);
      }
    });
  }

  /* assembly: written by the Adapter */
  if (m.assembly !== undefined) {
    if (!isObject(m.assembly)) problems.push({ path: 'assembly', message: 'has to be an object' });
    else if (m.assembly.placed !== undefined) {
      need(isObject(m.assembly.placed), 'assembly.placed', 'has to map a shot id to the clip ids it became');
      if (isObject(m.assembly.placed)) {
        for (const [shot, clips] of Object.entries(m.assembly.placed)) {
          need(shotIds.has(shot), `assembly.placed.${shot}`, 'names a shot that is not in shots[]');
          need(Array.isArray(clips) && clips.every(isText), `assembly.placed.${shot}`,
            'has to be an array of clip ids');
        }
      }
    }
  }

  return problems;
}

/**
 * The manifest at `root`, parsed. Throws a `ManifestError` when it is missing, is not JSON, or does not validate:
 * a module that cannot read the ledger stops rather than guessing (§6).
 * @param {string} root the project folder
 * @returns {Promise<Record<string, any>>}
 */
export async function readManifest(root) {
  const path = join(root, MANIFEST_PATH);
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    const code = /** @type {NodeJS.ErrnoException} */ (e).code;
    if (code === 'ENOENT') {
      throw new ManifestError({ code: 'invalid_request', message: `there is no ${MANIFEST_PATH} in this project`, retryable: false }, path);
    }
    throw e;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new ManifestError({ code: 'invalid_request', message: `${MANIFEST_PATH} is not valid JSON: ${/** @type {Error} */ (e).message}`, retryable: false }, path);
  }
  const problems = problemsIn(parsed);
  if (problems.length) {
    const first = problems[0];
    throw new ManifestError({
      code: 'invalid_request',
      message: `${MANIFEST_PATH} does not validate: ${problems.length} problem${problems.length === 1 ? '' : 's'}, first at ${first.path || '(root)'}: ${first.message}`,
      retryable: false,
    }, path);
  }
  return parsed;
}

/**
 * Write the manifest atomically, stamped with the time it was written. Refuses a manifest that does not validate, so
 * a broken ledger never reaches the disk. Two-space indent, UTF-8, trailing newline (§4).
 * @param {string} root the project folder
 * @param {Record<string, any>} manifest
 * @param {{ now?: string }} [options]
 * @returns {Promise<Record<string, any>>} the manifest as written
 */
export async function writeManifest(root, manifest, { now = new Date().toISOString() } = {}) {
  const problems = problemsIn(manifest);
  if (problems.length) {
    const first = problems[0];
    throw new ManifestError({
      code: 'invalid_request',
      message: `refusing to write a manifest that does not validate: ${problems.length} problem${problems.length === 1 ? '' : 's'}, first at ${first.path || '(root)'}: ${first.message}`,
      retryable: false,
    }, join(root, MANIFEST_PATH));
  }
  const written = { ...manifest, updated_at: now };
  await writeAtomic(join(root, MANIFEST_PATH), `${JSON.stringify(written, null, 2)}\n`, 'utf8');
  return written;
}

/**
 * Re-read the manifest and hand it to `change`, then write it back. The one safe way to edit a section: it refuses
 * when another writer moved `updated_at` under it (§4.1), instead of overwriting that writer's work.
 * @param {string} root
 * @param {(manifest: Record<string, any>) => void | Promise<void>} change
 * @param {{ expectUpdatedAt?: string, now?: string }} [options]
 * @returns {Promise<Record<string, any>>}
 */
export async function updateManifest(root, change, { expectUpdatedAt, now = new Date().toISOString() } = {}) {
  const manifest = await readManifest(root);
  if (expectUpdatedAt !== undefined && manifest.updated_at !== expectUpdatedAt) {
    throw new ManifestError({
      code: 'invalid_request',
      message: `the manifest changed since it was read (updated_at is ${manifest.updated_at}, expected ${expectUpdatedAt}); re-read it and try again`,
      retryable: true,
    }, join(root, MANIFEST_PATH));
  }
  await change(manifest);
  return writeManifest(root, manifest, { now });
}

/**
 * The task for a shot's take, if the ledger already has one. What the Skill asks before every call (§6).
 * @param {Record<string, any>} manifest
 * @param {string} shot
 * @param {number} take
 * @returns {Record<string, any> | null}
 */
export function taskFor(manifest, shot, take) {
  const id = taskId(take, shot);
  return (manifest.tasks ?? []).find((/** @type {any} */ t) => t.task_id === id) ?? null;
}

/**
 * The highest take number a shot has, 0 when it has none. The next take is this plus one, so a take number only
 * grows and no file is ever overwritten (§2 rule 4).
 * @param {Record<string, any>} manifest
 * @param {string} shot
 */
export function lastTake(manifest, shot) {
  const takes = (manifest.assets ?? [])
    .filter((/** @type {any} */ a) => a.shot_id === shot && Number.isInteger(a.take))
    .map((/** @type {any} */ a) => /** @type {number} */ (a.take));
  return takes.length ? Math.max(...takes) : 0;
}
