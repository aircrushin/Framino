/**
 * The generation ledger: contract §6, §7.
 *
 * There is no server to be idempotent for. `openfilm get video` is synchronous, has no task id and no
 * de-duplication (--force is declared but no provider reads it). This module is the only thing between a
 * crash/restart and a second charge. It owns ONLY the tasks[] section and shots[].status (contract §4.1);
 * it reads the manifest through manifest.mjs and settles a running task against the disk through
 * assets.mjs. It never calls a vendor and never passes --force.
 *
 * The three rules, as functions:
 *   1. beginCall      - write the task (state: running, request_key) BEFORE the call, atomically.
 *   2. resolveRunning - on start, settle every task still running against the file on disk; never resubmit.
 *   3. abandonVanished- on start, mark a succeeded task whose clip vanished abandoned; the shot needs a new take.
 * planCall (pure) is the guard the Skill asks before every call. recover() runs 2 and 3 together at startup.
 */
import {
  ERROR_CODES, ManifestError, assetId, lastTake, readManifest, requestKey, taskFor, taskId, updateManifest,
  videoPath,
} from '../../packages/framino-production/src/manifest.mjs';
import { validate as probeAsset } from '../../packages/framino-production/src/assets.mjs';

/** The take a task targets, read from its asset_id (`video-sh03-t2` -> 2). */
export function takeOfTask(task) {
  const found = /-t(\d+)$/.exec(String(task?.asset_id ?? ''));
  return found ? Number(found[1]) : null;
}

/**
 * The next take for a shot: one more than the highest take in BOTH assets[] and tasks[].
 * lastTake() alone is not enough - a failed or abandoned take has no asset, so it would hand back the
 * same number and the same --out name, which is exactly the second charge §6 forbids.
 */
export function nextTake(manifest, shot) {
  const fromTasks = (manifest.tasks ?? [])
    .filter((t) => t.shot_id === shot)
    .map(takeOfTask)
    .filter((n) => Number.isInteger(n));
  const highest = Math.max(lastTake(manifest, shot), ...fromTasks, 0);
  return highest + 1;
}

/** The --out name for a take (get.mjs lands it as assets/video/<out>.mp4). */
export const outName = (shot, take) => `${shot}-t${take}`;

/** Both approvals must be `approved` before the Skill may spend (manifest §4). */
export function assertApproved(manifest) {
  for (const key of ['script', 'storyboard']) {
    if (manifest.approval?.[key]?.state !== 'approved') {
      throw new ManifestError({
        code: 'invalid_request',
        message: `${key} is not approved; the person must approve it before generation`,
        retryable: false,
      });
    }
  }
}

/**
 * The decision before a call, from manifest state only (no disk). Call recover() first so `running` and
 * vanished-succeeded tasks are settled; then this never hands back a take that was already paid for.
 * @returns {{ action: 'call'|'skip'|'resolve'|'new-take', task: any|null, shot: string, take: number,
 *   reason: string, next_take?: number }}
 */
export function planCall(manifest, shot, take) {
  const task = taskFor(manifest, shot, take);
  if (task?.state === 'succeeded') {
    return { action: 'skip', task, shot, take, reason: 'this take already succeeded; never send it again' };
  }
  if (task?.state === 'running') {
    return { action: 'resolve', task, shot, take, reason: 'a task is still running; recover it against the disk first' };
  }
  if (task?.state === 'failed' || task?.state === 'abandoned') {
    return {
      action: 'new-take', task, shot, take,
      reason: `this take is ${task.state}; retry it as a new take, not a resubmission`,
      next_take: nextTake(manifest, shot),
    };
  }
  return { action: 'call', task: null, shot, take, reason: 'no task for this take; write one before calling' };
}

/**
 * Rule 1: write the task (state: running) BEFORE the call, atomically. Refuses a second begin for the same
 * take, and refuses to begin before both approvals. `expectUpdatedAt` is taken from a fresh read so a
 * concurrent writer cannot be overwritten (contract §4.1).
 * @param {string} root
 * @param {{ shot: string, take: number, provider: string, model: string, request: Record<string, any> }} spec
 * @param {{ now?: string, validate?: Function }} [options] `validate` is accepted for symmetry, not used here.
 * @returns {Promise<Record<string, any>>} the task as written
 */
export async function beginCall(root, { shot, take, provider, model, request }, { now = new Date().toISOString() } = {}) {
  const before = await readManifest(root);
  assertApproved(before);
  if (!(before.shots ?? []).some((s) => s.shot_id === shot)) {
    throw new ManifestError({ code: 'invalid_request', message: `no such shot: ${shot}`, retryable: false });
  }
  if (taskFor(before, shot, take)) {
    throw new ManifestError({
      code: 'invalid_request',
      message: `task ${taskId(take, shot)} already exists; resolve it, do not begin it again`,
      retryable: false,
    });
  }
  if (!request || typeof request.prompt !== 'string' || !request.prompt) {
    throw new ManifestError({ code: 'invalid_request', message: 'a request needs a prompt', retryable: false });
  }
  const task = {
    task_id: taskId(take, shot),
    shot_id: shot,
    asset_id: assetId('video', shot, take),
    request_key: requestKey({ ...request, project_id: before.project_id, shot_id: shot, take }),
    provider,
    model,
    request,
    state: 'running',
    attempts: 1,
    error: null,
    receipt: null,
    created_at: now,
    updated_at: now,
  };
  await updateManifest(root, (m) => {
    m.tasks.push(task);
    const target = m.shots.find((s) => s.shot_id === shot);
    if (target) target.status = 'generating';
  }, { expectUpdatedAt: before.updated_at, now });
  return task;
}

/** Map a §8 validation to the receipt §4 stores on a succeeded task. */
const receiptOf = (v) => ({
  src: v.path,
  dur: v.media?.duration_sec ?? null,
  hasAudio: v.media?.audio_codec != null,
});

/**
 * Rule 2: settle every `running` task against the disk. A clip that exists and validates is `succeeded`
 * with a receipt; anything else is `failed` with `error.code = 'timeout'` (§6's exact wording) - a timeout
 * may be retried, but only as a NEW take. All decisions are probed before one atomic write.
 * @param {string} root
 * @param {{ now?: string, validate?: Function }} [options] injectable for tests; default is assets.validate
 * @returns {Promise<{ task_id: string, to: string, reason: string }[]>}
 */
export async function resolveRunning(root, { now = new Date().toISOString(), validate = probeAsset } = {}) {
  const before = await readManifest(root);
  const shots = new Map((before.shots ?? []).map((s) => [s.shot_id, s]));
  /** @type {{ task_id: string, ok: boolean, validation: any }[]} */
  const decisions = [];
  for (const task of before.tasks ?? []) {
    if (task.state !== 'running') continue;
    const take = takeOfTask(task);
    const rel = Number.isInteger(take) ? videoPath(task.shot_id, take) : task.receipt?.src ?? null;
    const validation = rel
      ? await validate(rel, { root, kind: 'video', duration: shots.get(task.shot_id)?.duration_sec ?? null })
      : { status: 'invalid', invalid_reason: 'the task names no clip path', media: null, path: null };
    decisions.push({ task_id: task.task_id, ok: validation.status === 'valid', validation });
  }
  await updateManifest(root, (m) => {
    for (const d of decisions) {
      const task = m.tasks.find((t) => t.task_id === d.task_id);
      if (!task || task.state !== 'running') continue; // another writer settled it meanwhile
      const shot = m.shots.find((s) => s.shot_id === task.shot_id);
      if (d.ok) {
        task.state = 'succeeded';
        task.error = null;
        task.receipt = receiptOf(d.validation);
        if (shot) shot.status = 'generated';
      } else {
        task.state = 'failed';
        task.error = {
          code: 'timeout',
          message: `no valid clip on disk after the run stopped: ${d.validation.invalid_reason ?? 'unknown'}`,
          retryable: true,
        };
        if (shot) shot.status = 'failed';
      }
      task.updated_at = now;
    }
  }, { expectUpdatedAt: before.updated_at, now });
  return decisions.map((d) => ({ task_id: d.task_id, to: d.ok ? 'succeeded' : 'failed', reason: d.ok ? 'clip on disk validates' : String(d.validation.invalid_reason ?? 'no clip') }));
}

/**
 * Rule 3: a succeeded task whose clip is gone is `abandoned`; its shot needs a new take. Runs at startup
 * with resolveRunning. A succeeded task whose clip is still valid is left untouched, so planCall says skip.
 */
export async function abandonVanished(root, { now = new Date().toISOString(), validate = probeAsset } = {}) {
  const before = await readManifest(root);
  const shots = new Map((before.shots ?? []).map((s) => [s.shot_id, s]));
  /** @type {{ task_id: string, ok: boolean }[]} */
  const decisions = [];
  for (const task of before.tasks ?? []) {
    if (task.state !== 'succeeded') continue;
    const take = takeOfTask(task);
    const rel = task.receipt?.src ?? (Number.isInteger(take) ? videoPath(task.shot_id, take) : null);
    const validation = rel
      ? await validate(rel, { root, kind: 'video', duration: shots.get(task.shot_id)?.duration_sec ?? null })
      : { status: 'invalid' };
    if (validation.status !== 'valid') decisions.push({ task_id: task.task_id, ok: false });
  }
  await updateManifest(root, (m) => {
    for (const d of decisions) {
      const task = m.tasks.find((t) => t.task_id === d.task_id);
      if (!task || task.state !== 'succeeded') continue;
      task.state = 'abandoned';
      task.error = { code: 'asset_invalid', message: 'the clip from this succeeded task is no longer on disk', retryable: true };
      const shot = m.shots.find((s) => s.shot_id === task.shot_id);
      if (shot) shot.status = 'failed';
      task.updated_at = now;
    }
  }, { expectUpdatedAt: before.updated_at, now });
  return decisions.map((d) => ({ task_id: d.task_id, to: 'abandoned', reason: 'the clip vanished from disk' }));
}

/** Startup: settle running tasks, then abandon succeeded tasks whose clip vanished. */
export async function recover(root, options = {}) {
  return {
    resolved: await resolveRunning(root, options),
    abandoned: await abandonVanished(root, options),
  };
}

/**
 * Record the receipt a successful `get video` returned. Records provider and model FROM THE RECEIPT (§4.1),
 * not what was asked, and refuses to write if the task is no longer `running`.
 */
export async function succeedCall(root, { shot, take, receipt, provider, model }, { now = new Date().toISOString() } = {}) {
  const id = taskId(take, shot);
  await updateManifest(root, (m) => {
    const task = m.tasks.find((t) => t.task_id === id);
    if (!task) throw new ManifestError({ code: 'invalid_request', message: `no task ${id} in the ledger`, retryable: false });
    if (task.state !== 'running') {
      throw new ManifestError({ code: 'invalid_request', message: `task ${id} is ${task.state}, not running; refusing to record success`, retryable: false });
    }
    task.state = 'succeeded';
    task.error = null;
    task.receipt = { src: receipt?.src ?? videoPath(shot, take), dur: receipt?.dur ?? null, hasAudio: Boolean(receipt?.hasAudio) };
    if (provider) task.provider = provider;
    if (model) task.model = model;
    const target = m.shots.find((s) => s.shot_id === shot);
    if (target) target.status = 'generated';
    task.updated_at = now;
  }, { now });
}

/** Record a failed call as a §7 error. A failed take is never retried under the same number. */
export async function failCall(root, { shot, take, error }, { now = new Date().toISOString() } = {}) {
  const code = error?.code;
  if (!ERROR_CODES.includes(code)) {
    throw new ManifestError({ code: 'invalid_request', message: `unknown error code: ${code}`, retryable: false });
  }
  const id = taskId(take, shot);
  await updateManifest(root, (m) => {
    const task = m.tasks.find((t) => t.task_id === id);
    if (!task) throw new ManifestError({ code: 'invalid_request', message: `no task ${id} in the ledger`, retryable: false });
    if (task.state !== 'running') {
      throw new ManifestError({ code: 'invalid_request', message: `task ${id} is ${task.state}, not running; refusing to record failure`, retryable: false });
    }
    task.state = 'failed';
    task.error = { code, message: String(error.message ?? code), retryable: Boolean(error.retryable) };
    const target = m.shots.find((s) => s.shot_id === shot);
    if (target) target.status = 'failed';
    task.updated_at = now;
  }, { now });
}
