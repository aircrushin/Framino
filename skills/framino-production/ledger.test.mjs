/**
 * The generation ledger's tests: contract §6 and §7, offline and with no spend.
 *
 * Every clip is made here by ffmpeg at test time, in a temp folder removed afterwards, and is a hand-made
 * fixture: `origin: 'agent-code'` (§9). No video model is called, no Service is connected, no --yes or
 * --force is passed. What is proved is the property that matters before a real call exists: a crash and
 * restart never generates the same take twice.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newManifest, readManifest, writeManifest, requestKey } from '../../packages/framino-production/src/manifest.mjs';
import { validate } from '../../packages/framino-production/src/assets.mjs';
import {
  beginCall, planCall, nextTake, takeOfTask, resolveRunning, abandonVanished, recover,
  succeedCall, failCall, assertApproved, outName,
} from './ledger.mjs';

/** ffmpeg, waited on; a failure is this test's failure with ffmpeg's own words. */
function ffmpeg(args) {
  return new Promise((done, fail) => {
    execFile('ffmpeg', ['-v', 'error', '-y', ...args], { timeout: 120_000 }, (error, _out, err) => {
      if (error) fail(new Error(`ffmpeg failed: ${String(err || error.message).trim()}`));
      else done();
    });
  });
}

/** A valid 2 s clip at the path a take lands at. */
function makeClip(path) {
  return ffmpeg(['-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x180:rate=30', '-pix_fmt', 'yuv420p', path]);
}

/** A project folder with an approved, planned manifest and the asset folders. Removed when the test ends. */
async function project(t) {
  const root = await mkdtemp(join(tmpdir(), 'framino-ledger-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'production'), { recursive: true });
  await mkdir(join(root, 'assets', 'video'), { recursive: true });
  const m = newManifest({ project_id: 'coffee-30s', title: 'Specialty coffee', now: '2026-11-14T08:00:00Z' });
  m.brief.idea = 'A short specialty coffee spot.';
  m.approval.script = { state: 'approved', at: '2026-11-14T08:10:00Z' };
  m.approval.storyboard = { state: 'approved', at: '2026-11-14T08:15:00Z' };
  m.scenes = [{ scene_id: 'sc01', title: 'Morning', shots: ['sh01'] }];
  m.shots = [{
    shot_id: 'sh01', scene_id: 'sc01', order: 1, duration_sec: 2,
    visual_description: 'Steam off a cup', camera_movement: 'push-in', camera_angle: 'eye level',
    lighting: 'warm', composition: 'left third',
    generation_prompt: 'Steam rising off a ceramic cup, morning light',
    reference_assets: [], voiceover: '', subtitle: '', aspect_ratio: '16:9',
    status: 'planned', takes: [], selected_take: null,
  }];
  await writeManifest(root, m, { now: '2026-11-14T08:00:00Z' });
  return root;
}

const request = {
  prompt: 'Steam rising off a ceramic cup, morning light', duration: 2,
  aspect_ratio: '16:9', resolution: '1080p', first_frame_sha256: null,
  last_frame_sha256: null, reference_sha256s: [],
};

/* ---------------------------------------------------------------------------------------------------------------- */
/* planCall: the guard before every call                                                                             */
/* ---------------------------------------------------------------------------------------------------------------- */

test('planCall: no task means call, and beginCall writes it as running before the call', async (t) => {
  const root = await project(t);
  const m = await readManifest(root);
  assert.deepEqual(planCall(m, 'sh01', 1).action, 'call');
  const task = await beginCall(root, { shot: 'sh01', take: 1, provider: 'fal', model: 'seedance-2.0', request });
  assert.equal(task.state, 'running');
  assert.equal(task.asset_id, 'video-sh01-t1');
  assert.equal(outName('sh01', 1), 'sh01-t1');
  const after = await readManifest(root);
  assert.equal(planCall(after, 'sh01', 1).action, 'resolve');
  assert.equal(after.shots[0].status, 'generating');
});

test('beginCall refuses a second begin for the same take, and refuses before approval', async (t) => {
  const root = await project(t);
  await beginCall(root, { shot: 'sh01', take: 1, provider: 'fal', model: 'seedance-2.0', request });
  await assert.rejects(
    beginCall(root, { shot: 'sh01', take: 1, provider: 'fal', model: 'seedance-2.0', request }),
    /already exists/,
  );
  const m = await readManifest(root);
  m.approval.storyboard.state = 'draft';
  await writeManifest(root, m);
  await assert.rejects(
    beginCall(root, { shot: 'sh01', take: 2, provider: 'fal', model: 'seedance-2.0', request }),
    /storyboard is not approved/,
  );
  assert.throws(() => assertApproved(m), /storyboard is not approved/);
});

/* ---------------------------------------------------------------------------------------------------------------- */
/* §6 rule 2: resolve a running task against the disk, never resubmit                                                 */
/* ---------------------------------------------------------------------------------------------------------------- */

test('resolveRunning: a clip on disk settles a running task to succeeded, and planCall then says skip', async (t) => {
  const root = await project(t);
  await beginCall(root, { shot: 'sh01', take: 1, provider: 'fal', model: 'seedance-2.0', request });

  // The process dies here. On restart the clip is on disk (the call did finish) but nothing recorded it.
  await makeClip(join(root, 'assets', 'video', 'sh01-t1.mp4'));

  const report = await resolveRunning(root, { validate });
  assert.equal(report.length, 1);
  assert.equal(report[0].to, 'succeeded');
  const m = await readManifest(root);
  assert.equal(m.tasks[0].state, 'succeeded');
  assert.equal(m.tasks[0].receipt.src, 'assets/video/sh01-t1.mp4');
  assert.equal(typeof m.tasks[0].receipt.dur, 'number');
  assert.equal(m.shots[0].status, 'generated');
  assert.equal(planCall(m, 'sh01', 1).action, 'skip', 'a succeeded take is never sent again');
});

test('resolveRunning: no clip on disk settles a running task to failed with timeout', async (t) => {
  const root = await project(t);
  await beginCall(root, { shot: 'sh01', take: 1, provider: 'fal', model: 'seedance-2.0', request });

  const report = await resolveRunning(root, { validate });
  assert.equal(report[0].to, 'failed');
  const m = await readManifest(root);
  assert.equal(m.tasks[0].state, 'failed');
  assert.equal(m.tasks[0].error.code, 'timeout');
  assert.equal(m.tasks[0].error.retryable, true);
  assert.equal(planCall(m, 'sh01', 1).action, 'new-take');
});

/* ---------------------------------------------------------------------------------------------------------------- */
/* §6 rule 3: vanished clip -> abandoned; next take is a new number                                                   */
/* ---------------------------------------------------------------------------------------------------------------- */

test('abandonVanished: a succeeded task whose clip vanished is abandoned, and the next take is a new number', async (t) => {
  const root = await project(t);
  await beginCall(root, { shot: 'sh01', take: 1, provider: 'fal', model: 'seedance-2.0', request });
  await makeClip(join(root, 'assets', 'video', 'sh01-t1.mp4'));
  await succeedCall(root, { shot: 'sh01', take: 1, receipt: { src: 'assets/video/sh01-t1.mp4', dur: 2, hasAudio: false }, provider: 'fal', model: 'seedance-2.0' });

  // The clip is deleted after a successful, recorded generation.
  await rm(join(root, 'assets', 'video', 'sh01-t1.mp4'));
  const report = await abandonVanished(root, { validate });
  assert.equal(report[0].to, 'abandoned');
  const m = await readManifest(root);
  assert.equal(m.tasks[0].state, 'abandoned');
  assert.equal(m.tasks[0].error.code, 'asset_invalid');
  assert.equal(planCall(m, 'sh01', 1).action, 'new-take');
  assert.equal(nextTake(m, 'sh01'), 2, 'a failed/abandoned take must not be retried under the same number');
});

test('nextTake counts takes that have no asset, so a failed take is never retried', async (t) => {
  const root = await project(t);
  await beginCall(root, { shot: 'sh01', take: 1, provider: 'fal', model: 'seedance-2.0', request });
  await resolveRunning(root, { validate }); // no clip -> failed, no asset recorded
  const m = await readManifest(root);
  assert.equal(m.assets.length, 0);
  assert.equal(nextTake(m, 'sh01'), 2, 'lastTake alone would wrongly say 1 here');
});

test('abandonVanished leaves a still-valid succeeded task alone', async (t) => {
  const root = await project(t);
  await beginCall(root, { shot: 'sh01', take: 1, provider: 'fal', model: 'seedance-2.0', request });
  await makeClip(join(root, 'assets', 'video', 'sh01-t1.mp4'));
  await succeedCall(root, { shot: 'sh01', take: 1, receipt: { src: 'assets/video/sh01-t1.mp4', dur: 2, hasAudio: false } });
  const report = await abandonVanished(root, { validate });
  assert.equal(report.length, 0, 'a clip that is still there is not abandoned');
  const m = await readManifest(root);
  assert.equal(planCall(m, 'sh01', 1).action, 'skip');
});

/* ---------------------------------------------------------------------------------------------------------------- */
/* recover() and the success/failure writers                                                                         */
/* ---------------------------------------------------------------------------------------------------------------- */

test('recover() settles both kinds in one startup pass', async (t) => {
  const root = await project(t);
  await beginCall(root, { shot: 'sh01', take: 1, provider: 'fal', model: 'seedance-2.0', request });
  await makeClip(join(root, 'assets', 'video', 'sh01-t1.mp4'));
  await succeedCall(root, { shot: 'sh01', take: 1, receipt: { src: 'assets/video/sh01-t1.mp4', dur: 2, hasAudio: false } });
  await beginCall(root, { shot: 'sh01', take: 2, provider: 'fal', model: 'seedance-2.0', request });

  const out = await recover(root, { validate });
  assert.equal(out.resolved[0].to, 'failed', 'take 2 has no clip');
  assert.equal(out.abandoned.length, 0, 'take 1 clip is still present');
  const m = await readManifest(root);
  assert.equal(m.tasks.find((x) => x.task_id === 't1-sh01').state, 'succeeded');
  assert.equal(m.tasks.find((x) => x.task_id === 't2-sh01').state, 'failed');
});

test('succeedCall records provider and model from the receipt, not from what was asked', async (t) => {
  const root = await project(t);
  await beginCall(root, { shot: 'sh01', take: 1, provider: 'fal', model: 'seedance-2.0', request });
  await succeedCall(root, {
    shot: 'sh01', take: 1,
    receipt: { src: 'assets/video/sh01-t1.mp4', dur: 2.04, hasAudio: true },
    provider: 'openfilm-service', model: 'actual-model-from-receipt',
  });
  const m = await readManifest(root);
  assert.equal(m.tasks[0].provider, 'openfilm-service');
  assert.equal(m.tasks[0].model, 'actual-model-from-receipt');
  await assert.rejects(
    succeedCall(root, { shot: 'sh01', take: 1, receipt: {} }),
    /not running/,
    'a succeeded task cannot be written as succeeded twice',
  );
});

test('failCall records a §7 error and stops the shot', async (t) => {
  const root = await project(t);
  await beginCall(root, { shot: 'sh01', take: 1, provider: 'fal', model: 'seedance-2.0', request });
  await failCall(root, { shot: 'sh01', take: 1, error: { code: 'balance', message: 'out of credit', retryable: false } });
  const m = await readManifest(root);
  assert.equal(m.tasks[0].state, 'failed');
  assert.equal(m.tasks[0].error.code, 'balance');
  assert.equal(m.shots[0].status, 'failed');
  await assert.rejects(
    failCall(root, { shot: 'sh01', take: 1, error: { code: 'nonsense', message: 'x', retryable: false } }),
    /unknown error code/,
  );
});

test('request_key is stable across restarts and changes with the take', async (t) => {
  const root = await project(t);
  const a = await beginCall(root, { shot: 'sh01', take: 1, provider: 'fal', model: 'm', request });
  const again = requestKey({ ...request, project_id: 'coffee-30s', shot_id: 'sh01', take: 1 });
  assert.equal(a.request_key, again, 'a restart computes the same key for the same request');
  assert.notEqual(a.request_key, requestKey({ ...request, project_id: 'coffee-30s', shot_id: 'sh01', take: 2 }), 'a new take is a new request');
  assert.equal(takeOfTask(a), 1);
});
