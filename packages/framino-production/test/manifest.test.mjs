import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MANIFEST_PATH, MANIFEST_VERSION, assetId, canonicalJson, lastTake, newManifest, problemsIn, projectAssetId,
  readManifest, requestKey, shotId, taskFor, taskId, toMs, updateManifest, videoPath, writeManifest, ManifestError,
} from '../src/manifest.mjs';

/** A project folder with a manifest in it, cleaned up after the test. */
async function project(t, manifest) {
  const root = await mkdtemp(join(tmpdir(), 'framino-manifest-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'production'), { recursive: true });
  if (manifest) await writeFile(join(root, MANIFEST_PATH), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return root;
}

/** A manifest with one scene and one shot, which validates. */
function planned() {
  const m = newManifest({ project_id: 'coffee-30s', title: 'Specialty coffee', now: '2026-11-14T08:00:00Z' });
  m.brief.idea = 'A 30-second cinematic commercial for a specialty coffee brand.';
  m.scenes = [{ scene_id: 'sc01', title: 'Morning ritual', shots: ['sh01'] }];
  m.shots = [{
    shot_id: 'sh01', scene_id: 'sc01', order: 1, duration_sec: 6,
    visual_description: 'Steam rising off a ceramic cup', camera_movement: 'slow push-in',
    camera_angle: 'eye level', lighting: 'soft window light', composition: 'cup on left third',
    generation_prompt: 'Steam rising off a ceramic cup in morning light, macro, shallow depth of field',
    reference_assets: [], voiceover: 'Every great day starts slow.', subtitle: 'Every great day starts slow.',
    aspect_ratio: '16:9', status: 'planned', takes: [], selected_take: null,
  }];
  return m;
}

test('the ids are the shapes the contract names', () => {
  assert.equal(shotId(3), 'sh03');
  assert.equal(shotId(12), 'sh12');
  assert.equal(assetId('video', 'sh03', 2), 'video-sh03-t2');
  assert.equal(projectAssetId('music', 'bed'), 'music-bed');
  assert.equal(taskId(2, 'sh03'), 't2-sh03');
  assert.equal(videoPath('sh03', 2), 'assets/video/sh03-t2.mp4');
  assert.equal(toMs(6.0419999), 6.042);
});

test('a new manifest validates, and so does one with a shot in it', () => {
  assert.deepEqual(problemsIn(newManifest({ project_id: 'coffee-30s' })), []);
  assert.deepEqual(problemsIn(planned()), []);
});

test('validation names the path of what is wrong, not just that something is', () => {
  const m = planned();
  m.shots[0].duration_sec = 0;
  m.brief.aspect_ratio = '5:4';
  m.project_id = 'Coffee 30s';
  const problems = problemsIn(m);
  const paths = problems.map((p) => p.path);
  assert.ok(paths.includes('shots[0].duration_sec'), `expected shots[0].duration_sec in ${paths}`);
  assert.ok(paths.includes('brief.aspect_ratio'), `expected brief.aspect_ratio in ${paths}`);
  assert.ok(paths.includes('project_id'), `expected project_id in ${paths}`);
});

test('a shot id used twice is refused: ids are never reused', () => {
  const m = planned();
  m.shots.push({ ...m.shots[0], order: 2 });
  assert.ok(problemsIn(m).some((p) => p.path === 'shots[1].shot_id' && /another shot/.test(p.message)));
});

test('an asset that names a shot which is not there is refused', () => {
  const m = planned();
  m.assets = [{
    asset_id: 'video-sh09-t1', kind: 'video', shot_id: 'sh09', take: 1, path: 'assets/video/sh09-t1.mp4',
    origin: 'provider:fal', status: 'valid',
  }];
  assert.ok(problemsIn(m).some((p) => p.path === 'assets[0].shot_id'));
});

test('an invalid asset has to say why it is invalid', () => {
  const m = planned();
  m.assets = [{
    asset_id: 'video-sh01-t1', kind: 'video', shot_id: 'sh01', take: 1, path: 'assets/video/sh01-t1.mp4',
    origin: 'agent-code', status: 'invalid',
  }];
  assert.ok(problemsIn(m).some((p) => p.path === 'assets[0].invalid_reason'));
});

test('a running task is a valid ledger entry: it is how a crash is recorded', () => {
  const m = planned();
  m.tasks = [{
    task_id: 't1-sh01', shot_id: 'sh01', asset_id: 'video-sh01-t1', request_key: 'a'.repeat(64),
    provider: 'fal', model: 'seedance-2.0', state: 'running', attempts: 1, error: null,
  }];
  assert.deepEqual(problemsIn(m), []);
});

test('an unknown field is kept and ignored, not a problem', () => {
  const m = planned();
  m.future_thing = { whatever: true };
  m.shots[0].not_in_the_contract = 'kept';
  assert.deepEqual(problemsIn(m), []);
});

test('the request key is stable across key order and changes with the take', () => {
  const request = {
    project_id: 'coffee-30s', shot_id: 'sh01', take: 1, provider: 'fal', model: 'seedance-2.0',
    prompt: 'steam', duration: 6, aspect_ratio: '16:9', resolution: '1080p',
  };
  const reordered = {
    resolution: '1080p', aspect_ratio: '16:9', duration: 6, prompt: 'steam',
    model: 'seedance-2.0', provider: 'fal', take: 1, shot_id: 'sh01', project_id: 'coffee-30s',
  };
  assert.equal(requestKey(request), requestKey(reordered), 'key order must not change the key');
  assert.notEqual(requestKey(request), requestKey({ ...request, take: 2 }), 'a new take is a new request');
  assert.notEqual(requestKey(request), requestKey({ ...request, prompt: 'steam ' }), 'a changed prompt is a new request');
});

test('canonical JSON sorts keys at every level and drops nothing but undefined', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } }), '{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}');
  assert.equal(canonicalJson({ a: undefined, b: null }), '{"b":null}');
});

test('a manifest round-trips through the disk with two-space indent and a trailing newline', async (t) => {
  const root = await project(t);
  const written = await writeManifest(root, planned(), { now: '2026-11-14T08:42:10Z' });
  assert.equal(written.updated_at, '2026-11-14T08:42:10Z');
  const text = await readFile(join(root, MANIFEST_PATH), 'utf8');
  assert.ok(text.endsWith('\n'), 'the file ends with a newline');
  assert.ok(text.includes('\n  "manifest_version"'), 'two-space indent');
  const back = await readManifest(root);
  assert.deepEqual(back, written);
});

test('writing a manifest that does not validate is refused, and nothing is written', async (t) => {
  const root = await project(t);
  const m = planned();
  m.shots[0].generation_prompt = '';
  await assert.rejects(() => writeManifest(root, m), (e) => e instanceof ManifestError && e.code === 'invalid_request');
  await assert.rejects(() => readFile(join(root, MANIFEST_PATH), 'utf8'), /ENOENT/);
});

test('reading a missing manifest says so instead of guessing', async (t) => {
  const root = await project(t);
  await assert.rejects(() => readManifest(root), (e) => e instanceof ManifestError && /there is no/.test(e.message));
});

test('reading a manifest that is not JSON says so', async (t) => {
  const root = await project(t);
  await writeFile(join(root, MANIFEST_PATH), '{ not json', 'utf8');
  await assert.rejects(() => readManifest(root), (e) => e instanceof ManifestError && /not valid JSON/.test(e.message));
});

test('updateManifest refuses to overwrite a writer that moved updated_at under it', async (t) => {
  const root = await project(t);
  const first = await writeManifest(root, planned(), { now: '2026-11-14T08:00:00Z' });
  /* another module writes in between */
  await writeManifest(root, { ...first, title: 'changed by someone else' }, { now: '2026-11-14T08:05:00Z' });
  await assert.rejects(
    () => updateManifest(root, (m) => { m.title = 'mine'; }, { expectUpdatedAt: first.updated_at }),
    (e) => e instanceof ManifestError && e.retryable === true,
  );
  const after = await readManifest(root);
  assert.equal(after.title, 'changed by someone else', 'the other writer\'s change survives');
});

test('the next take is one past the highest, so a take number only grows', () => {
  const m = planned();
  assert.equal(lastTake(m, 'sh01'), 0);
  m.assets = [
    { asset_id: 'video-sh01-t1', kind: 'video', shot_id: 'sh01', take: 1, path: 'assets/video/sh01-t1.mp4', origin: 'agent-code', status: 'valid' },
    { asset_id: 'video-sh01-t3', kind: 'video', shot_id: 'sh01', take: 3, path: 'assets/video/sh01-t3.mp4', origin: 'agent-code', status: 'valid' },
    { asset_id: 'video-sh02-t9', kind: 'video', shot_id: 'sh02', take: 9, path: 'assets/video/sh02-t9.mp4', origin: 'agent-code', status: 'valid' },
  ];
  assert.equal(lastTake(m, 'sh01'), 3, 'another shot\'s take does not count');
});

test('taskFor finds the ledger entry for a take, and nothing for one that was never made', () => {
  const m = planned();
  m.tasks = [{ task_id: 't1-sh01', shot_id: 'sh01', asset_id: 'video-sh01-t1', request_key: 'a'.repeat(64), state: 'succeeded', attempts: 1 }];
  assert.equal(taskFor(m, 'sh01', 1)?.state, 'succeeded');
  assert.equal(taskFor(m, 'sh01', 2), null);
});

test('the version this module writes is the one the contract names', () => {
  assert.equal(MANIFEST_VERSION, '0.2');
});
