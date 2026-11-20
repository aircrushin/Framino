import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readManifest, writeManifest } from '../src/manifest.mjs';
import { assemble, readAssembly } from '../src/adapter.mjs';
import { filmRev, readFilmAt, readFilmFile } from '../src/film.mjs';

/**
 * A project folder with a manifest in it, cleaned up after the test. `clips` are the files the manifest names, made
 * empty: the Adapter reads the manifest, not the media (validity is the asset pipeline's job, §8).
 */
async function project(t, manifest) {
  const root = await mkdtemp(join(tmpdir(), 'framino-adapter-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'production'), { recursive: true });
  if (manifest) await writeManifest(root, manifest, { now: manifest.updated_at });
  return root;
}

/** A shot. */
function shot(id, order, duration, take, extra = {}) {
  return {
    shot_id: id, scene_id: 'sc01', order, duration_sec: duration,
    visual_description: `shot ${id}`, generation_prompt: `a picture for ${id}`,
    status: 'generated', takes: take ? [take] : [], selected_take: take,
    ...extra,
  };
}

/** A per-shot video asset. */
function video(id, shotId, take, origin = 'provider:fal', status = 'valid', duration) {
  return {
    asset_id: id, kind: 'video', shot_id: shotId, take, path: `assets/video/${shotId}-t${take}.mp4`,
    origin, status, ...(status === 'invalid' ? { invalid_reason: 'it does not decode' } : {}),
    ...(duration ? { media: { duration_sec: duration } } : {}),
  };
}

/**
 * A hand-written manifest: two shots in one scene, a voiceover, a music bed, subtitles, and a 1080p stage. It is
 * written as JSON, not through `newManifest`, so the test is about the Adapter reading a manifest a person wrote.
 */
function handWritten() {
  return {
    manifest_version: '0.2',
    project_id: 'coffee-30s',
    title: 'Specialty coffee - 30 s spot',
    created_at: '2026-11-14T08:00:00Z',
    updated_at: '2026-11-14T08:42:10Z',
    brief: {
      idea: 'A 30-second cinematic commercial for a specialty coffee brand.',
      audience: 'urban coffee lovers 25-40',
      platform: 'youtube',
      language: 'en',
      duration_sec: 30,
      aspect_ratio: '16:9',
      style: 'warm, macro, shallow depth of field',
      limits: { max_generated_seconds: 45, max_takes_per_shot: 3 },
    },
    video: { width: 1080, height: 1920, fps: 30 },
    approval: {
      script: { state: 'approved', at: '2026-11-14T08:10:00Z' },
      storyboard: { state: 'approved', at: '2026-11-14T08:15:00Z' },
    },
    scenes: [{ scene_id: 'sc01', title: 'Morning ritual', shots: ['sh01', 'sh02'] }],
    shots: [
      shot('sh01', 1, 6, 'video-sh01-t1', {
        voiceover: 'Every great day starts slow.',
        subtitle: 'Every great day starts slow.',
      }),
      shot('sh02', 2, 4, 'video-sh02-t1', { subtitle: 'Pour, and breathe.' }),
    ],
    assets: [
      video('video-sh01-t1', 'sh01', 1, 'agent-code', 'valid', 6),
      video('video-sh02-t1', 'sh02', 1, 'provider:fal', 'valid', 4),
      {
        asset_id: 'voiceover-sh01', kind: 'voiceover', shot_id: 'sh01', path: 'assets/audio/vo-sh01.wav',
        origin: 'agent-code', status: 'valid',
      },
      {
        asset_id: 'music-bed', kind: 'music', path: 'assets/audio/music-bed.mp3',
        origin: 'library', status: 'valid',
      },
    ],
    tasks: [],
    audio: { music: 'music-bed', music_volume: 0.35, voiceover_volume: 1.0 },
    captions: { path: 'captions/film.vtt', language: 'en' },
    assembly: { film_rev: null, at: null, placed: {} },
  };
}

/** The film on disk, read strictly: every clip's `data-*` and the stage, or a failed assertion. */
async function filmOf(root) {
  const text = await readFile(join(root, 'film.html'), 'utf8');
  const read = readFilmFile(text);
  assert.deepEqual(read.problems, [], 'the film reads without a problem');
  assert.ok(read.value, 'the film has a value');
  return { text, value: read.value };
}

/** Every clip of the film, with the track it is on. */
function clips(value) {
  return value.tracks.flatMap((track, ti) => track.clips.map((clip) => ({ ti, track, clip })));
}

/** The clips carrying a shot id. */
function shotClips(value, shotId) {
  return clips(value).filter(({ clip }) => clip.attrs?.['data-shot-id'] === shotId);
}

test('a hand-written manifest becomes a film that reads back with every data-shot-id and the stage right', async (t) => {
  const root = await project(t, handWritten());
  const result = await assemble(root, await readManifest(root));

  const { value } = await filmOf(root);
  assert.deepEqual(value.stage, { w: 1080, h: 1920 }, 'video.width/height become the viewport');

  const sh01 = shotClips(value, 'sh01');
  assert.equal(sh01.length, 2, 'the shot has its picture and its voiceover');
  const picture = sh01.find(({ clip }) => clip.attrs?.['data-asset-id'] === 'video-sh01-t1').clip;
  assert.equal(picture.src, 'assets/video/sh01-t1.mp4');
  assert.deepEqual(picture.time, [0, 6], 'the take plays from 0 for the shot duration');
  assert.equal(picture.attrs['data-scene-id'], 'sc01');
  assert.equal(picture.attrs['data-asset-id'], 'video-sh01-t1');
  assert.equal(picture.at, undefined, 'the first shot starts at 0, which the format writes by leaving at out');

  const sh02 = shotClips(value, 'sh02').find(({ clip }) => clip.attrs?.['data-asset-id'] === 'video-sh02-t1').clip;
  assert.equal(sh02.at, 6, 'the second shot starts where the first ends');

  /* the tracks Framino made say which they are, top layer first */
  const roles = value.tracks.map((track) => track.attrs?.['data-framino-track']);
  assert.deepEqual(roles, ['captions', 'video', 'voiceover', 'music']);

  /* assembly says what each shot became, by clip id */
  assert.deepEqual(result.placed, { sh01: [picture.id, 'sh01-vo'], sh02: [sh02.id] });
  assert.equal(result.film_rev, filmRev(await readFile(join(root, 'film.html'), 'utf8')));
  const manifest = await readManifest(root);
  assert.deepEqual(manifest.assembly.placed, result.placed);
  assert.equal(manifest.assembly.film_rev, result.film_rev);
  assert.equal(manifest.assembly.at, result.at);
});

test('assembling twice is byte-identical and leaves film_rev unchanged', async (t) => {
  const root = await project(t, handWritten());
  const first = await assemble(root, await readManifest(root));
  const once = await readFile(join(root, 'film.html'), 'utf8');

  const second = await assemble(root, await readManifest(root));
  const twice = await readFile(join(root, 'film.html'), 'utf8');

  assert.equal(twice, once, 'the second assembly writes the same bytes');
  assert.equal(second.film_rev, first.film_rev, 'film_rev is unchanged');
  assert.equal(second.written, false, 'the second assembly does not write the film at all');
  assert.deepEqual(second.added, [], 'nothing is added the second time');
  assert.deepEqual(second.retaken, [], 'nothing is retaken the second time');
  assert.deepEqual(second.placed, first.placed, 'the same clips are recorded');

  /* and a third, from the manifest as it now is on disk: still the same */
  const third = await assemble(root, await readManifest(root));
  assert.equal(await readFile(join(root, 'film.html'), 'utf8'), once);
  assert.equal(third.film_rev, first.film_rev);
});

test('a shot with no selected take is not placed, and the film says why', async (t) => {
  const manifest = handWritten();
  manifest.shots[0].selected_take = null;
  const root = await project(t, manifest);
  const result = await assemble(root, await readManifest(root));

  const { value } = await filmOf(root);
  assert.deepEqual(shotClips(value, 'sh01'), [], 'nothing of sh01 is in the film');
  assert.ok(result.skipped.some((s) => s.shot_id === 'sh01' && /no selected take/.test(s.reason)));
  assert.deepEqual(result.placed.sh01, undefined);
  /* the shot that is placed starts at 0: a skipped shot leaves no hole in the film */
  const sh02 = shotClips(value, 'sh02')[0].clip;
  assert.equal(sh02.at, undefined);
});

test('an asset that is not valid is not placed (contract §8)', async (t) => {
  const manifest = handWritten();
  manifest.assets[1].status = 'invalid';
  manifest.assets[1].invalid_reason = 'it does not decode';
  const root = await project(t, manifest);
  const result = await assemble(root, await readManifest(root));

  const { value } = await filmOf(root);
  assert.deepEqual(shotClips(value, 'sh02'), [], 'an invalid take stays out of the film');
  assert.ok(result.skipped.some((s) => s.shot_id === 'sh02' && /not a valid asset/.test(s.reason)));
  assert.equal(shotClips(value, 'sh01').length, 2, 'the valid shot is still placed');
});

test('an agent-code asset tags its clip data-framino-test="true", and a real one does not', async (t) => {
  const root = await project(t, handWritten());
  await assemble(root, await readManifest(root));
  const { value } = await filmOf(root);

  const fixture = shotClips(value, 'sh01').find(({ clip }) => clip.attrs?.['data-asset-id'] === 'video-sh01-t1').clip;
  assert.equal(fixture.attrs['data-framino-test'], 'true', 'a hand-made clip says it is a test asset (§9)');
  const voice = shotClips(value, 'sh01').find(({ clip }) => clip.attrs?.['data-asset-id'] === 'voiceover-sh01').clip;
  assert.equal(voice.attrs['data-framino-test'], 'true');

  const real = shotClips(value, 'sh02')[0].clip;
  assert.equal(real.attrs['data-framino-test'], undefined, 'a provider take is not tagged as test');
});

test('the person edits the film, and re-assembling leaves their edit and their own clip alone', async (t) => {
  const root = await project(t, handWritten());
  await assemble(root, await readManifest(root));
  const before = await filmOf(root);

  /* the person moves the second shot and adds a title of their own on a track of their own */
  const value = before.value;
  const sh02 = shotClips(value, 'sh02')[0].clip;
  sh02.at = 9.5;
  value.tracks.push({
    clips: [{ src: 'scenes/title.html', id: 'my-title', at: 0, time: [0, 2] }],
    attrs: { 'data-framino-track': 'overlay' },
  });
  const { filmHtml } = await import('../src/film.mjs');
  const edited = filmHtml(value, before.text);
  assert.notEqual(edited, before.text, 'the edit really changed the film');
  await writeFile(join(root, 'film.html'), edited, 'utf8');

  const manifest = await readManifest(root);
  const result = await assemble(root, manifest);
  assert.equal(result.edited, true, 'the Adapter sees that the film is not the one it wrote');

  const after = await filmOf(root);
  const moved = shotClips(after.value, 'sh02')[0].clip;
  assert.equal(moved.at, 9.5, 'the person\'s at survives: the Adapter never retimes a clip');
  const mine = clips(after.value).find(({ clip }) => clip.id === 'my-title');
  assert.ok(mine, 'the person\'s own clip is still there');
  assert.equal(mine.clip.at, undefined, 'at 0, which the format writes by leaving at out');
  assert.deepEqual(mine.clip.time, [0, 2], 'and its length is as they set it');
  assert.equal(mine.track.attrs?.['data-framino-track'], 'overlay', 'and on their own track');
  assert.equal(result.added.length, 0, 'nothing is added');
  assert.equal(result.retaken.length, 0, 'no take changed');
  assert.equal(await readFile(join(root, 'film.html'), 'utf8'), edited, 'the film is not rewritten at all');
});

test('a shot added to the manifest after the first assembly is placed without disturbing the existing clips', async (t) => {
  const root = await project(t, handWritten());
  await assemble(root, await readManifest(root));
  const before = await filmOf(root);
  const wasSh01 = shotClips(before.value, 'sh01').map(({ clip }) => ({ ...clip }));
  const wasSh02 = shotClips(before.value, 'sh02').map(({ clip }) => ({ ...clip }));

  const manifest = await readManifest(root);
  manifest.shots.push(shot('sh03', 3, 3, 'video-sh03-t1', { subtitle: 'And then, the day.' }));
  manifest.scenes[0].shots.push('sh03');
  manifest.assets.push(video('video-sh03-t1', 'sh03', 1, 'provider:fal', 'valid', 3));
  await writeManifest(root, manifest, { now: '2026-11-14T09:00:00Z' });

  const result = await assemble(root, await readManifest(root));
  assert.deepEqual(result.added, ['sh03'], 'only the new shot is added');
  assert.equal(result.edited, false, 'the film was still the one the Adapter wrote');

  const after = await filmOf(root);
  assert.deepEqual(shotClips(after.value, 'sh01').map(({ clip }) => clip), wasSh01, 'sh01 is untouched');
  assert.deepEqual(shotClips(after.value, 'sh02').map(({ clip }) => clip), wasSh02, 'sh02 is untouched');
  const sh03 = shotClips(after.value, 'sh03')[0].clip;
  assert.equal(sh03.at, 10, 'the new shot starts after the two that were there');

  /* the caption file gains its cue and keeps the ones it had */
  const vtt = await readFile(join(root, 'captions', 'film.vtt'), 'utf8');
  assert.match(vtt, /^sh01\n/m);
  assert.match(vtt, /^sh02\n/m);
  assert.match(vtt, /^sh03\n/m);
  assert.match(vtt, /00:00:10\.000 --> 00:00:13\.000\nAnd then, the day\./);
});

test('readAssembly recovers placed from a film that already exists', async (t) => {
  const root = await project(t, handWritten());
  const assembled = await assemble(root, await readManifest(root));

  /* the manifest loses what the Adapter recorded, as a fresh checkout of the plan would */
  const manifest = await readManifest(root);
  manifest.assembly = { film_rev: null, at: null, placed: {} };
  await writeManifest(root, manifest, { now: '2026-11-14T09:00:00Z' });

  const read = await readAssembly(root, await readManifest(root));
  assert.deepEqual(read.placed, assembled.placed, 'the same clips are found again, by data-shot-id');
  assert.equal(read.film_rev, assembled.film_rev);
  assert.equal(read.edited, true, 'a film whose revision was never recorded counts as the person\'s');
  const back = await readManifest(root);
  assert.deepEqual(back.assembly.placed, assembled.placed);
  assert.equal(back.assembly.film_rev, assembled.film_rev);

  /* a split leaves one shot with two clips, and both are found */
  const { text, value } = await filmOf(root);
  const sh02 = shotClips(value, 'sh02')[0].clip;
  const copy = { ...sh02, id: 'sh02-b', at: 8, time: [2, 4], attrs: { ...sh02.attrs } };
  value.tracks.find((tr) => tr.attrs?.['data-framino-track'] === 'video').clips.push(copy);
  const { filmHtml } = await import('../src/film.mjs');
  await writeFile(join(root, 'film.html'), filmHtml(value, text), 'utf8');
  const split = await readAssembly(root, await readManifest(root), { write: false });
  assert.deepEqual(split.placed.sh02, ['sh02', 'sh02-b'], 'a shot is found by data-shot-id, not by clip id');
});

test('music and voiceover land on their own tracks with the right volume', async (t) => {
  const root = await project(t, handWritten());
  await assemble(root, await readManifest(root));
  const { value } = await filmOf(root);

  const music = value.tracks.find((track) => track.attrs?.['data-framino-track'] === 'music');
  assert.ok(music, 'there is a music track');
  assert.equal(music.clips.length, 1);
  assert.equal(music.clips[0].src, 'assets/audio/music-bed.mp3');
  assert.equal(music.clips[0].volume, 0.35, 'volume is music_volume');
  assert.equal(music.clips[0].at, undefined, 'the bed starts at 0');

  const voice = value.tracks.find((track) => track.attrs?.['data-framino-track'] === 'voiceover');
  assert.ok(voice, 'there is a voiceover track');
  assert.equal(voice.clips.length, 1);
  assert.equal(voice.clips[0].src, 'assets/audio/vo-sh01.wav');
  assert.equal(voice.clips[0].at, undefined, 'the voiceover starts where its shot does');
  assert.equal(voice.clips[0].volume, undefined, 'volume 1 is the file\'s own level, which the format leaves out');

  /* a level other than 1 is written */
  const manifest = await readManifest(root);
  manifest.audio.voiceover_volume = 0.8;
  await writeManifest(root, manifest, { now: '2026-11-14T09:00:00Z' });
  await assemble(root, await readManifest(root));
  const again = await filmOf(root);
  const voice2 = again.value.tracks.find((track) => track.attrs?.['data-framino-track'] === 'voiceover');
  assert.equal(voice2.clips[0].volume, 0.8);
});

test('a changed take rewrites that clip\'s src and leaves every other clip as it was', async (t) => {
  const root = await project(t, handWritten());
  await assemble(root, await readManifest(root));

  const manifest = await readManifest(root);
  manifest.assets.push(video('video-sh02-t2', 'sh02', 2, 'provider:fal', 'valid', 4));
  manifest.shots[1].takes.push('video-sh02-t2');
  manifest.shots[1].selected_take = 'video-sh02-t2';
  await writeManifest(root, manifest, { now: '2026-11-14T09:00:00Z' });

  const result = await assemble(root, await readManifest(root));
  assert.deepEqual(result.retaken, ['sh02'], 'only the shot whose take changed is rewritten');
  const { value } = await filmOf(root);
  const sh02 = shotClips(value, 'sh02')[0].clip;
  assert.equal(sh02.src, 'assets/video/sh02-t2.mp4');
  assert.equal(sh02.attrs['data-asset-id'], 'video-sh02-t2');
  assert.equal(sh02.id, 'sh02', 'the clip keeps its id: the person may have edited it');
  assert.equal(sh02.at, 6, 'and its place');
});

test('the film is only ever written through film-doc: assembling a project with no film.html starts from the empty film', async (t) => {
  const root = await project(t, handWritten());
  const result = await assemble(root, await readManifest(root));
  const text = await readFile(join(root, 'film.html'), 'utf8');
  assert.ok(text.startsWith('<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n'), 'the full document form, never the fragment');
  assert.ok(text.endsWith('</html>\n'));
  assert.equal(result.film_rev, filmRev(text));
  /* and what is on disk reads as what the Adapter said it wrote */
  const at = await readFilmAt(root);
  assert.equal(at.rev, result.film_rev);
});

test('a shot whose clips the person deleted is not added again', async (t) => {
  const root = await project(t, handWritten());
  await assemble(root, await readManifest(root));
  const { text, value } = await filmOf(root);

  const videoTrack = value.tracks.find((track) => track.attrs?.['data-framino-track'] === 'video');
  videoTrack.clips = videoTrack.clips.filter((clip) => clip.attrs?.['data-shot-id'] !== 'sh02');
  const { filmHtml } = await import('../src/film.mjs');
  await writeFile(join(root, 'film.html'), filmHtml(value, text), 'utf8');

  const result = await assemble(root, await readManifest(root));
  assert.deepEqual(result.added, [], 'the deletion is an edit, so the shot stays out');
  const after = await filmOf(root);
  assert.deepEqual(shotClips(after.value, 'sh02'), []);
});
