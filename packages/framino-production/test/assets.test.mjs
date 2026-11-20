/**
 * The asset pipeline's tests: contract §8, one test per clause, plus the ledger rules of §2 and §4.
 *
 * Every fixture is made by ffmpeg here, at test time, in a folder under the system temp directory that is removed
 * afterwards. No binary is committed, and every fixture is `origin: 'agent-code'` (§9): none of these clips came from
 * a video model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MANIFEST_PATH, newManifest, problemsIn, readManifest, writeManifest } from '../src/manifest.mjs';
import { MIN_VIDEO_SEC, probe, record, sha256File, validate, validateEntry } from '../src/assets.mjs';

/* ---------------------------------------------------------------------------------------------------------------- */
/* fixtures                                                                                                          */
/* ---------------------------------------------------------------------------------------------------------------- */

/** Run ffmpeg and wait for it; a failure is the test's failure, with ffmpeg's own words. */
function ffmpeg(args) {
  return new Promise((done, fail) => {
    execFile('ffmpeg', ['-v', 'error', '-y', ...args], { timeout: 120_000 }, (error, out, err) => {
      if (error) fail(new Error(`ffmpeg ${args.join(' ')} failed: ${String(err || error.message).trim()}`));
      else done();
    });
  });
}

/** Ask ffprobe directly, the way a person checking the test would, not through the module under test. */
function ffprobeJson(path, entries) {
  return new Promise((done, fail) => {
    execFile(
      'ffprobe',
      ['-v', 'error', '-print_format', 'json', ...entries, path],
      { timeout: 60_000 },
      (error, out, err) => {
        if (error) fail(new Error(`ffprobe ${path} failed: ${String(err || error.message).trim()}`));
        else done(JSON.parse(String(out)));
      },
    );
  });
}

/** A project folder with a manifest and the asset folders, removed when the test ends. */
async function project(t) {
  const root = await mkdtemp(join(tmpdir(), 'framino-assets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'production'), { recursive: true });
  await mkdir(join(root, 'assets', 'video'), { recursive: true });
  await mkdir(join(root, 'assets', 'audio'), { recursive: true });
  await mkdir(join(root, 'assets', 'image'), { recursive: true });
  await mkdir(join(root, 'captions'), { recursive: true });
  const manifest = planned();
  await writeManifest(root, manifest, { now: '2026-11-14T08:00:00Z' });
  return root;
}

/** A manifest with two shots, which validates. */
function planned() {
  const m = newManifest({ project_id: 'coffee-30s', title: 'Specialty coffee', now: '2026-11-14T08:00:00Z' });
  m.brief.idea = 'A 30-second cinematic commercial for a specialty coffee brand.';
  m.scenes = [{ scene_id: 'sc01', title: 'Morning ritual', shots: ['sh01', 'sh02'] }];
  m.shots = [
    {
      shot_id: 'sh01', scene_id: 'sc01', order: 1, duration_sec: 6,
      visual_description: 'Steam rising off a ceramic cup', camera_movement: 'slow push-in',
      camera_angle: 'eye level', lighting: 'soft window light', composition: 'cup on left third',
      generation_prompt: 'Steam rising off a ceramic cup in morning light, macro, shallow depth of field',
      reference_assets: [], voiceover: 'Every great day starts slow.', subtitle: 'Every great day starts slow.',
      aspect_ratio: '16:9', status: 'planned', takes: [], selected_take: null,
    },
    {
      shot_id: 'sh02', scene_id: 'sc01', order: 2, duration_sec: 4,
      visual_description: 'Beans falling into a grinder', camera_movement: 'static',
      camera_angle: 'top down', lighting: 'hard side light', composition: 'centred',
      generation_prompt: 'Coffee beans falling into a grinder, top down, hard side light',
      reference_assets: [], voiceover: '', subtitle: '',
      aspect_ratio: '16:9', status: 'planned', takes: [], selected_take: null,
    },
  ];
  return m;
}

/** A real 6 s clip, 320x180 at 30 fps: `testsrc`, exactly the command the plan names. */
async function makeClip(path, { seconds = 6, size = '320x180', rate = 30 } = {}) {
  await ffmpeg(['-f', 'lavfi', '-i', `testsrc=duration=${seconds}:size=${size}:rate=${rate}`, '-pix_fmt', 'yuv420p', path]);
  return path;
}

/** The first `fraction` of a file, written back: what a download that stopped halfway leaves on disk. */
async function truncate(from, to, fraction = 0.5) {
  const bytes = await readFile(from);
  await writeFile(to, bytes.subarray(0, Math.floor(bytes.length * fraction)));
  return to;
}

/** An independent sha256, not the module's. */
async function sha256Of(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* §8: a valid clip                                                                                                  */
/* ---------------------------------------------------------------------------------------------------------------- */

test('a valid clip is recorded valid, with media facts that match what ffprobe says', async (t) => {
  const root = await project(t);
  const path = await makeClip(join(root, 'assets', 'video', 'sh01-t1.mp4'));

  const { asset } = await record(root, {
    asset_id: 'video-sh01-t1', kind: 'video', shot_id: 'sh01', take: 1,
    path: 'assets/video/sh01-t1.mp4', origin: 'agent-code',
  });

  assert.equal(asset.status, 'valid');
  assert.equal(asset.invalid_reason, null);

  /* what ffprobe says, asked directly */
  const said = await ffprobeJson(path, ['-show_streams', '-show_format']);
  const stream = said.streams.find((s) => s.codec_type === 'video');
  assert.equal(asset.media.duration_sec, Number(said.format.duration));
  assert.equal(asset.media.width, stream.width);
  assert.equal(asset.media.height, stream.height);
  assert.equal(asset.media.video_codec, stream.codec_name);
  assert.equal(asset.media.fps, 30);
  assert.equal(asset.media.format, said.format.format_name);

  /* the facts are real, not the zeroes of a file nobody looked at */
  assert.equal(asset.media.duration_sec, 6);
  assert.equal(asset.media.width, 320);
  assert.equal(asset.media.height, 180);
  assert.equal(asset.media.video_codec, 'h264');
  assert.equal(asset.media.size_bytes, (await stat(path)).size);
  assert.ok(asset.media.size_bytes > 0);

  /* §8's duration rule: 6 s asked for, 6 s on disk, so the difference is 0 and it is inside the tolerance */
  assert.equal(asset.media.duration_requested_sec, 6, 'the shot\'s duration_sec is the length asked for');
  assert.equal(asset.media.duration_delta_sec, 0);
  assert.equal(asset.media.duration_within_tolerance, true);
});

test('a clip shorter than the 0.5 s minimum is invalid', async (t) => {
  const root = await project(t);
  await makeClip(join(root, 'assets', 'video', 'sh02-t1.mp4'), { seconds: 0.2, rate: 10 });
  const checked = await validate('assets/video/sh02-t1.mp4', { root, kind: 'video' });
  assert.equal(checked.status, 'invalid');
  assert.match(checked.invalid_reason, /too short/);
  assert.ok(checked.media.duration_sec < MIN_VIDEO_SEC);
});

test('a valid audio file is valid, and a video is not required to have an audio stream', async (t) => {
  const root = await project(t);
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:a', 'pcm_s16le', join(root, 'assets', 'audio', 'vo-sh01.wav')]);
  const voice = await validate('assets/audio/vo-sh01.wav', { root, kind: 'voiceover' });
  assert.equal(voice.status, 'valid');
  assert.equal(voice.media.audio_codec, 'pcm_s16le');
  assert.equal(voice.media.duration_sec, 3);
  assert.ok(voice.media.sample_rate > 0);
  assert.ok(voice.media.audio_channels > 0);
  assert.equal(voice.media.video_codec, null);

  /* the clip above has no audio stream at all and is still a valid video */
  const clip = await makeClip(join(root, 'assets', 'video', 'sh01-t1.mp4'));
  const video = await validate(clip, { root, kind: 'video' });
  assert.equal(video.status, 'valid');
  assert.equal(video.media.audio_codec, null);
});

test('a still picture is valid, and a subtitle is valid in captions/ where §3 puts it', async (t) => {
  const root = await project(t);
  await ffmpeg(['-f', 'lavfi', '-i', 'testsrc=duration=1:size=64x64:rate=10', '-frames:v', '1', join(root, 'assets', 'image', 'sh01-ref1.png')]);
  const picture = await validate('assets/image/sh01-ref1.png', { root, kind: 'image' });
  assert.equal(picture.status, 'valid');
  assert.equal(picture.media.width, 64);
  assert.equal(picture.media.height, 64);
  assert.equal(picture.media.video_codec, 'png');

  await writeFile(join(root, 'captions', 'film.vtt'), 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nEvery great day starts slow.\n', 'utf8');
  const subtitle = await validate('captions/film.vtt', { root, kind: 'subtitle' });
  assert.equal(subtitle.status, 'valid', subtitle.invalid_reason ?? '');
});

/* ---------------------------------------------------------------------------------------------------------------- */
/* §8: the three broken files                                                                                        */
/* ---------------------------------------------------------------------------------------------------------------- */

test('a truncated file is invalid: it starts like an MP4 but does not decode', async (t) => {
  const root = await project(t);
  const whole = await makeClip(join(root, 'assets', 'video', 'whole.mp4'));
  const cut = await truncate(whole, join(root, 'assets', 'video', 'sh01-t2.mp4'), 0.5);

  const checked = await validate('assets/video/sh01-t2.mp4', { root, kind: 'video' });
  assert.equal(checked.status, 'invalid');
  assert.ok(checked.invalid_reason, 'an invalid asset has to say why');
  assert.match(checked.invalid_reason, /incomplete/);
  assert.match(checked.invalid_reason, /mp4/);
  assert.equal(checked.media.duration_sec, null, 'nothing about a file that does not decode is reported as a fact');
  assert.ok(checked.media.size_bytes > 0, 'it is not empty: it is cut short');
  assert.equal(checked.media.sha256, await sha256Of(cut), 'the hash of what is there is still recorded');
});

test('a zero-byte file is invalid', async (t) => {
  const root = await project(t);
  await writeFile(join(root, 'assets', 'video', 'sh01-t3.mp4'), '');

  const checked = await validate('assets/video/sh01-t3.mp4', { root, kind: 'video' });
  assert.equal(checked.status, 'invalid');
  assert.match(checked.invalid_reason, /empty/);
  assert.equal(checked.media.size_bytes, 0);
});

test('a non-media file named .mp4 is invalid', async (t) => {
  const root = await project(t);
  await writeFile(join(root, 'assets', 'video', 'sh01-t4.mp4'), 'This is not a video. It is a note about one.\n', 'utf8');

  const checked = await validate('assets/video/sh01-t4.mp4', { root, kind: 'video' });
  assert.equal(checked.status, 'invalid');
  assert.match(checked.invalid_reason, /not media/);
  assert.equal(checked.media.duration_sec, null);
});

test('a file that is the wrong kind of media is invalid: an audio file named .mp4 has no video stream', async (t) => {
  const root = await project(t);
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'aac', join(root, 'assets', 'video', 'sh01-t5.mp4')]);

  const checked = await validate('assets/video/sh01-t5.mp4', { root, kind: 'video' });
  assert.equal(checked.status, 'invalid');
  assert.match(checked.invalid_reason, /no video stream/);
  assert.match(checked.invalid_reason, /audio/, 'it says what ffprobe did find');
});

/* ---------------------------------------------------------------------------------------------------------------- */
/* §8: the other clauses                                                                                             */
/* ---------------------------------------------------------------------------------------------------------------- */

test('a partial download is invalid: Content-Length does not match the bytes on disk', async (t) => {
  const root = await project(t);
  const path = await makeClip(join(root, 'assets', 'video', 'sh01-t1.mp4'));
  const size = (await stat(path)).size;

  const short = await validate('assets/video/sh01-t1.mp4', { root, kind: 'video', contentLength: size + 1024 });
  assert.equal(short.status, 'invalid');
  assert.match(short.invalid_reason, /partial/);
  assert.match(short.invalid_reason, new RegExp(String(size + 1024)));

  const exact = await validate('assets/video/sh01-t1.mp4', { root, kind: 'video', contentLength: size });
  assert.equal(exact.status, 'valid', 'a Content-Length that matches is not a problem');
});

test('a file outside assets/ is invalid, and so is one that is not there', async (t) => {
  const root = await project(t);
  await writeFile(join(root, 'notes.mp4'), 'not under assets\n', 'utf8');
  const outside = await validate('notes.mp4', { root, kind: 'video' });
  assert.equal(outside.status, 'invalid');
  assert.match(outside.invalid_reason, /not under assets\//);

  const missing = await validate('assets/video/sh09-t1.mp4', { root, kind: 'video' });
  assert.equal(missing.status, 'invalid');
  assert.match(missing.invalid_reason, /not there/);
});

test('a name that says nothing about what it is is invalid rather than guessed at', async (t) => {
  const root = await project(t);
  await writeFile(join(root, 'assets', 'video', 'sh01-t1.bin'), 'whatever', 'utf8');
  const checked = await validate('assets/video/sh01-t1.bin', { root });
  assert.equal(checked.status, 'invalid');
  assert.match(checked.invalid_reason, /cannot be told from its name/);

  const wrongKind = await validate('assets/video/sh01-t1.mp4', { root, kind: 'song' });
  assert.equal(wrongKind.status, 'invalid');
  assert.match(wrongKind.invalid_reason, /not a kind of asset/);
});

test('probe answers the facts and never throws for a file it cannot read', async (t) => {
  const root = await project(t);
  const path = await makeClip(join(root, 'assets', 'video', 'sh01-t1.mp4'));
  const facts = await probe(path);
  assert.equal(facts.ok, true);
  assert.equal(facts.error, null);
  assert.equal(facts.facts.width, 320);
  assert.equal(facts.facts.height, 180);
  assert.equal(facts.facts.duration_sec, 6);
  assert.ok(facts.streams.length >= 1);

  const broken = await probe(join(root, 'assets', 'video', 'nothing.mp4'));
  assert.equal(broken.ok, false);
  assert.ok(broken.error, 'it says why');
  assert.equal(broken.facts.duration_sec, null);
});

/* ---------------------------------------------------------------------------------------------------------------- */
/* §8: the duration rule                                                                                             */
/* ---------------------------------------------------------------------------------------------------------------- */

test('a duration more than 0.5 s from the one asked for is recorded with the difference, and stays valid', async (t) => {
  const root = await project(t);
  await makeClip(join(root, 'assets', 'video', 'sh01-t1.mp4'), { seconds: 6 });

  /* the shot asks for 7 s and the file is 6 s: 1 s short, outside the ±0.5 s tolerance */
  const { asset } = await record(root, {
    asset_id: 'video-sh01-t1', kind: 'video', shot_id: 'sh01', take: 1,
    path: 'assets/video/sh01-t1.mp4', origin: 'agent-code', duration: 7,
  });
  assert.equal(asset.status, 'valid', '§8 makes the difference a fact to record, not a failure');
  assert.equal(asset.media.duration_sec, 6);
  assert.equal(asset.media.duration_requested_sec, 7);
  assert.equal(asset.media.duration_delta_sec, -1);
  assert.equal(asset.media.duration_within_tolerance, false);

  /* inside the tolerance the difference is recorded too, and says it is inside */
  const close = await validate('assets/video/sh01-t1.mp4', { root, kind: 'video', duration: 6.4 });
  assert.equal(close.media.duration_delta_sec, -0.4);
  assert.equal(close.media.duration_within_tolerance, true);
});

/* ---------------------------------------------------------------------------------------------------------------- */
/* §4: the ledger                                                                                                    */
/* ---------------------------------------------------------------------------------------------------------------- */

test('sha256 is recorded and matches an independent computation', async (t) => {
  const root = await project(t);
  const path = await makeClip(join(root, 'assets', 'video', 'sh01-t1.mp4'));
  const { asset } = await record(root, {
    asset_id: 'video-sh01-t1', kind: 'video', shot_id: 'sh01', take: 1,
    path: 'assets/video/sh01-t1.mp4', origin: 'agent-code',
  });
  const expected = await sha256Of(path);
  assert.equal(asset.media.sha256, expected);
  assert.match(expected, /^[0-9a-f]{64}$/);
  assert.equal(await sha256File(path), expected, 'the exported helper agrees');

  /* and it is on disk, in the manifest, not only in the return value */
  const onDisk = await readManifest(root);
  assert.equal(onDisk.assets[0].media.sha256, expected);
});

test('recording take 2 does not overwrite take 1', async (t) => {
  const root = await project(t);
  await makeClip(join(root, 'assets', 'video', 'sh01-t1.mp4'), { seconds: 6 });
  await makeClip(join(root, 'assets', 'video', 'sh01-t2.mp4'), { seconds: 6, size: '160x90' });

  const first = await record(root, {
    asset_id: 'video-sh01-t1', kind: 'video', shot_id: 'sh01', take: 1,
    path: 'assets/video/sh01-t1.mp4', origin: 'agent-code',
  });
  const second = await record(root, {
    asset_id: 'video-sh01-t2', kind: 'video', shot_id: 'sh01', take: 2,
    path: 'assets/video/sh01-t2.mp4', origin: 'agent-code',
  });

  const manifest = await readManifest(root);
  assert.equal(manifest.assets.length, 2, 'two takes, two entries');
  const one = manifest.assets.find((a) => a.asset_id === 'video-sh01-t1');
  const two = manifest.assets.find((a) => a.asset_id === 'video-sh01-t2');
  assert.equal(one.path, 'assets/video/sh01-t1.mp4');
  assert.equal(two.path, 'assets/video/sh01-t2.mp4');
  assert.equal(one.media.width, 320, 'take 1 still describes take 1\'s file');
  assert.equal(two.media.width, 160, 'take 2 describes take 2\'s file');
  assert.equal(one.media.sha256, first.asset.media.sha256);
  assert.equal(two.media.sha256, second.asset.media.sha256);
  assert.notEqual(one.media.sha256, two.media.sha256);
  assert.equal(one.created_at, first.asset.created_at);
});

test('a second file cannot take over another take\'s entry, and an entry cannot be moved', async (t) => {
  const root = await project(t);
  await makeClip(join(root, 'assets', 'video', 'sh01-t1.mp4'));
  await makeClip(join(root, 'assets', 'video', 'sh01-t2.mp4'), { size: '160x90' });
  await record(root, {
    asset_id: 'video-sh01-t1', kind: 'video', shot_id: 'sh01', take: 1,
    path: 'assets/video/sh01-t1.mp4', origin: 'agent-code',
  });

  await assert.rejects(
    () => record(root, {
      asset_id: 'video-sh01-t9', kind: 'video', shot_id: 'sh01', take: 9,
      path: 'assets/video/sh01-t1.mp4', origin: 'agent-code',
    }),
    /already recorded as video-sh01-t1/,
  );
  await assert.rejects(
    () => record(root, {
      asset_id: 'video-sh01-t1', kind: 'video', shot_id: 'sh01', take: 1,
      path: 'assets/video/sh01-t2.mp4', origin: 'agent-code',
    }),
    /already recorded at/,
  );

  const manifest = await readManifest(root);
  assert.equal(manifest.assets.length, 1);
  assert.equal(manifest.assets[0].path, 'assets/video/sh01-t1.mp4');
});

test('none of the broken files reaches the manifest as valid, and the manifest still validates', async (t) => {
  const root = await project(t);
  const whole = await makeClip(join(root, 'assets', 'video', 'whole.mp4'));
  await truncate(whole, join(root, 'assets', 'video', 'sh01-t2.mp4'), 0.5);
  await writeFile(join(root, 'assets', 'video', 'sh01-t3.mp4'), '');
  await writeFile(join(root, 'assets', 'video', 'sh01-t4.mp4'), 'not a video\n', 'utf8');

  for (const take of [2, 3, 4]) {
    await record(root, {
      asset_id: `video-sh01-t${take}`, kind: 'video', shot_id: 'sh01', take,
      path: `assets/video/sh01-t${take}.mp4`, origin: 'agent-code',
    });
  }

  /* readManifest throws unless the manifest validates, so this is the validation */
  const manifest = await readManifest(root);
  assert.deepEqual(problemsIn(manifest), []);
  assert.equal(manifest.assets.length, 3);
  for (const asset of manifest.assets) {
    assert.equal(asset.status, 'invalid', `${asset.asset_id} must not be valid`);
    assert.ok(asset.invalid_reason, `${asset.asset_id} has to say why`);
    assert.equal(asset.media.sha256.length, 64, `${asset.asset_id} still records the hash of what landed`);
  }
  assert.equal(manifest.assets.filter((a) => a.status === 'valid').length, 0);
});

test('the asset id and take are minted from the shot when the caller does not give them', async (t) => {
  const root = await project(t);
  await makeClip(join(root, 'assets', 'video', 'sh02-t1.mp4'), { seconds: 4 });

  const { asset } = await record(root, {
    kind: 'video', shot_id: 'sh02', take: 1, path: 'assets/video/sh02-t1.mp4', origin: 'agent-code',
  });
  assert.equal(asset.asset_id, 'video-sh02-t1');
  assert.equal(asset.take, 1);
  assert.equal(asset.media.duration_requested_sec, 4, 'the shot\'s own duration_sec is used');
  assert.equal(asset.media.duration_delta_sec, 0);

  /* an audio file cannot say which of the three audio kinds it is, so a kind is required */
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', join(root, 'assets', 'audio', 'music-bed.mp3')]);
  await assert.rejects(
    () => record(root, { path: 'assets/audio/music-bed.mp3', origin: 'agent-code' }),
    /voiceover, music and sfx are all audio/,
  );
  const music = await record(root, { kind: 'music', path: 'assets/audio/music-bed.mp3', origin: 'agent-code' });
  assert.equal(music.asset.asset_id, 'music-bed', 'a name that already starts with the kind is not doubled');
  assert.equal(music.asset.shot_id, undefined, 'a project-wide asset belongs to no shot');
  assert.equal(music.asset.status, 'valid');
});

test('a per-shot asset with no takes is named by §3\'s rule, and a bad take number is refused', async (t) => {
  const root = await project(t);
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'pcm_s16le', join(root, 'assets', 'audio', 'vo-sh01.wav')]);

  /* §3: `audio/vo-<shot_id>.wav`. A voice-over is one per shot, so it has no take. */
  const voice = await record(root, { kind: 'voiceover', shot_id: 'sh01', path: 'assets/audio/vo-sh01.wav', origin: 'agent-code' });
  assert.equal(voice.asset.asset_id, 'voiceover-sh01');
  assert.equal(voice.asset.take, undefined);
  assert.equal(voice.asset.status, 'valid');

  await assert.rejects(
    () => record(root, { kind: 'voiceover', shot_id: 'sh01', take: 0, path: 'assets/audio/vo-sh01.wav', origin: 'agent-code' }),
    /take is a whole number from 1/,
  );
});

test('an asset for a shot that does not exist is refused, and so is one with no origin', async (t) => {
  const root = await project(t);
  await makeClip(join(root, 'assets', 'video', 'sh09-t1.mp4'));
  await assert.rejects(
    () => record(root, {
      kind: 'video', shot_id: 'sh09', take: 1, path: 'assets/video/sh09-t1.mp4', origin: 'agent-code',
    }),
    /shot sh09 is not in shots\[\]/,
  );
  await assert.rejects(
    () => record(root, { kind: 'video', shot_id: 'sh01', take: 1, path: 'assets/video/sh01-t1.mp4' }),
    /origin/,
  );
  const manifest = await readManifest(root);
  assert.equal(manifest.assets.length, 0, 'a refused record writes nothing');
});

test('re-recording the same take updates its entry in place and keeps created_at', async (t) => {
  const root = await project(t);
  const path = await makeClip(join(root, 'assets', 'video', 'sh01-t1.mp4'));

  const first = await record(root, {
    asset_id: 'video-sh01-t1', kind: 'video', shot_id: 'sh01', take: 1,
    path: 'assets/video/sh01-t1.mp4', origin: 'agent-code',
  }, { now: '2026-11-14T08:10:00Z' });

  /* the same file, now with the provider that made it: one entry, not two */
  const again = await record(root, {
    asset_id: 'video-sh01-t1', kind: 'video', shot_id: 'sh01', take: 1,
    path: 'assets/video/sh01-t1.mp4', origin: 'provider:fal', provider: 'fal', model: 'seedance-2.0',
    task_id: 't1-sh01',
  }, { now: '2026-11-14T08:20:00Z' });

  const manifest = await readManifest(root);
  assert.equal(manifest.assets.length, 1);
  assert.equal(again.asset.origin, 'provider:fal');
  assert.equal(again.asset.provider, 'fal');
  assert.equal(again.asset.created_at, first.asset.created_at, 'the first sighting is when it was created');
  assert.equal(again.asset.media.sha256, await sha256Of(path));
  assert.equal(manifest.updated_at, '2026-11-14T08:20:00Z');
});

test('validateEntry re-checks an entry already in the ledger, the way §6 resume does', async (t) => {
  const root = await project(t);
  await makeClip(join(root, 'assets', 'video', 'sh01-t1.mp4'), { seconds: 6 });
  const { asset } = await record(root, {
    asset_id: 'video-sh01-t1', kind: 'video', shot_id: 'sh01', take: 1,
    path: 'assets/video/sh01-t1.mp4', origin: 'agent-code',
  });

  const again = await validateEntry(root, asset);
  assert.equal(again.status, 'valid');
  assert.equal(again.media.sha256, asset.media.sha256);
  assert.equal(again.media.duration_delta_sec, 0, 'the length asked for is kept in the entry');

  /* §6: a succeeded task whose asset vanished needs a new take */
  await rm(join(root, 'assets', 'video', 'sh01-t1.mp4'));
  const gone = await validateEntry(root, asset);
  assert.equal(gone.status, 'invalid');
  assert.match(gone.invalid_reason, /not there/);
});

test('the manifest path this module writes through is the contract\'s', async (t) => {
  const root = await project(t);
  await makeClip(join(root, 'assets', 'video', 'sh01-t1.mp4'));
  await record(root, {
    asset_id: 'video-sh01-t1', kind: 'video', shot_id: 'sh01', take: 1,
    path: 'assets/video/sh01-t1.mp4', origin: 'agent-code',
  });
  const text = await readFile(join(root, MANIFEST_PATH), 'utf8');
  assert.ok(text.includes('"asset_id": "video-sh01-t1"'));
  assert.ok(text.endsWith('\n'));
});
