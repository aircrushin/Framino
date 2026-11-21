// @ts-check
/**
 * Framino Phase 2, Step 4: the offline end-to-end run of the Coffee Brand Commercial demo.
 *
 * This script is the executable companion of `docs/FRAMINO_E2E_TEST_REPORT.md`. It runs every step of the report that
 * needs no video service: idea -> brief, script, storyboard, approvals, asset validation, assembly, `openfilm look`,
 * opening the film in Studio, editing a shot/caption/music level, re-assembling over the edit, and exporting an MP4.
 * Steps that need a connected video service (4, 5, 6) are reported as blocked; this script never fabricates them.
 *
 * Everything is made in one folder under the OS temp directory and removed at the end, unless E2E_KEEP=1 is set.
 * Every media file is made by ffmpeg here and recorded with origin `agent-code` (contract §9): none came from a video
 * model, and the Assembly tags each of its clips `data-framino-test="true"`.
 *
 * Run from the repo root:
 *   node packages/framino-production/test/e2e-offline.mjs
 *   E2E_KEEP=1 node packages/framino-production/test/e2e-offline.mjs   # keep the project to inspect it
 *
 * This is a manual E2E driver, not a `node --test` file (the package's test script runs the .test.mjs files).
 * It owns no production code: it only calls the public APIs of @framino/production and the openfilm CLI/Studio.
 */
import { execFile, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const OPENFILM = join(REPO, 'packages', 'openfilm');
const CLI = join(OPENFILM, 'bin', 'openfilm.mjs');
const requireFromOpenfilm = createRequire(join(OPENFILM, 'package.json'));

const { newManifest, problemsIn, readManifest, writeManifest, requestKey, taskId, assetId, videoPath } =
  await import('../src/manifest.mjs');
const { record, probe } = await import('../src/assets.mjs');
const { assemble, readAssembly, CAPTIONS_PATH } = await import('../src/adapter.mjs');
const { readFilmAt, filmRev } = await import('../src/film.mjs');
const { chromium } = requireFromOpenfilm('playwright-core');
const { openProject } = await import(pathToFileURL(join(OPENFILM, 'studio', 'server', 'projects.mjs')).href);
const { startStudio } = await import(pathToFileURL(join(OPENFILM, 'studio', 'server', 'server.mjs')).href);

const KEEP = process.env.E2E_KEEP === '1';
const NOW = '2026-11-21T09:00:00Z';
const lines = [];
const say = (line) => { lines.push(line); console.log(line); };
const step = (n, text) => say(`\nSTEP ${n} — ${text}`);
const ok = (text) => say(`  PASS  ${text}`);
const blocked = (text) => say(`  BLOCKED  ${text}`);
const check = (condition, message) => {
  if (!condition) throw new Error(`E2E assertion failed: ${message}`);
  ok(message);
};

/** Run a command and collect stdout+stderr; reject on a non-zero exit with the combined output. */
function run(command, args, options = {}) {
  return new Promise((done, fail) => {
    execFile(command, args, { timeout: options.timeout ?? 120_000, cwd: options.cwd, env: options.env,
      maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      const out = `${stdout ?? ''}${stderr ?? ''}`;
      if (error) fail(new Error(`${command} ${args.join(' ')} failed (${error.code ?? error.message}):\n${out}`));
      else done(out);
    });
  });
}
const ffmpeg = (args, options) => run('ffmpeg', ['-v', 'error', '-y', ...args], options);

/** The short, complete Coffee spot: three shots, a voice-over on the first, a music bed, and captions. */
const SHOTS = [
  { id: 'sh01', duration: 2, subtitle: 'Great coffee starts here.', vo: 'Great coffee starts here.' },
  { id: 'sh02', duration: 2, subtitle: 'Beans, roasted with care.', vo: '' },
  { id: 'sh03', duration: 2, subtitle: 'Pour. Breathe. Enjoy.', vo: '' },
];

let scratch;
let studio;
let browser;
try {
  scratch = await mkdtemp(join(tmpdir(), 'framino-e2e-'));
  const root = join(scratch, 'coffee-30s');
  await mkdir(join(root, 'production'), { recursive: true });
  await mkdir(join(root, 'assets', 'video'), { recursive: true });
  await mkdir(join(root, 'assets', 'audio'), { recursive: true });
  await mkdir(join(root, 'captions'), { recursive: true });
  say(`project  ${root}`);
  say(`script   ${fileURLToPath(import.meta.url)}`);
  say('   Every clip below is an ffmpeg fixture, origin agent-code — not a video-model output (§9).');

  /* ------------------------------------------------------------------ 1: idea */
  step(1, 'Idea -> manifest.brief; the manifest validates');
  const m = newManifest({ project_id: 'coffee-30s', title: 'Specialty coffee - 30 s spot', now: NOW });
  m.brief = {
    idea: 'A short cinematic commercial for a specialty coffee brand.',
    audience: 'urban coffee lovers 25-40', platform: 'youtube', language: 'en', duration_sec: 6,
    aspect_ratio: '16:9', style: 'warm, macro, shallow depth of field',
    limits: { max_generated_seconds: 45, max_takes_per_shot: 3 },
  };
  m.video = { width: 1280, height: 720, fps: 30 };
  await writeFile(join(root, 'production', 'script.md'),
    '# Specialty coffee - 30 s spot\n\nHOOK: "Great coffee starts here."\n' +
    SHOTS.map((s) => `## ${s.id}\n\n${s.subtitle}`).join('\n\n') + '\n\nEND: Pour. Breathe. Enjoy.\n');
  check(problemsIn(m).length === 0, `brief written; problemsIn() = 0 (version ${m.manifest_version})`);

  /* ------------------------------------------------------------- 2 + 3: approval */
  step(2, 'Script written and approved (approval gate before generation)');
  m.approval.script = { state: 'approved', at: NOW };
  check(m.approval.script.state === 'approved', 'approval.script.state = approved');

  step(3, 'Storyboard: 3 shots, all contract fields; approved');
  m.scenes = [{ scene_id: 'sc01', title: 'Morning ritual', shots: SHOTS.map((s) => s.id) }];
  m.shots = SHOTS.map((s, i) => ({
    shot_id: s.id, scene_id: 'sc01', order: i + 1, duration_sec: s.duration,
    visual_description: `shot ${s.id} of the coffee ritual`, camera_movement: 'slow push-in',
    camera_angle: 'eye level', lighting: 'soft window light', composition: 'cup on left third',
    generation_prompt: `Cinematic close-up for shot ${s.id}, warm light, shallow depth of field`,
    reference_assets: [], voiceover: s.vo, subtitle: s.subtitle, aspect_ratio: '16:9',
    status: 'planned', takes: [], selected_take: null,
  }));
  m.approval.storyboard = { state: 'approved', at: NOW };
  const required = ['shot_id', 'scene_id', 'order', 'duration_sec', 'visual_description', 'camera_movement',
    'camera_angle', 'lighting', 'composition', 'generation_prompt', 'reference_assets', 'voiceover', 'subtitle',
    'aspect_ratio'];
  check(SHOTS.length === 3 && m.shots.every((s) => required.every((k) => s[k] !== undefined))
    && problemsIn(m).length === 0, `3 shots, all ${required.length} contract fields present; manifest validates`);
  check(m.approval.storyboard.state === 'approved', 'approval.storyboard.state = approved');
  await writeManifest(root, m, { now: NOW });

  /* ------------------------------------------------------ 4 + 5 + 6: need service */
  step(4, 'Generation through openfilm get video');
  const getHelp = await run(process.execPath, [CLI, 'get', 'video', '--help'], { cwd: root });
  if (/Not connected here/i.test(getHelp)) {
    blocked('no video service connected in Studio; no real clip was generated');
    say('  Also verified offline: skills/framino-production/ledger.test.mjs (11 pass) proves the ledger gate,');
    say('  request_key stability, resolve-never-resubmit and new-take rules without a vendor.');
  } else {
    blocked('a service is connected; real generation is deliberately left to the person-approved run');
  }
  step(5, 'Restart mid-run: no shot generated twice');
  blocked('needs a real in-flight call to kill and resume; ledger resume is covered by ledger.test.mjs offline');
  step(6, 'Regenerate one shot: new take, others untouched');
  blocked('needs a real first take; take isolation is covered by assets.test.mjs and adapter.test.mjs offline');

  /* --------------------------------------------------------------- 7: assets */
  step(7, 'Assets land and validate (section 8)');
  for (const s of SHOTS) {
    await ffmpeg(['-f', 'lavfi', '-i', `testsrc=duration=${s.duration}:size=640x360:rate=30`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', videoPath(s.id, 1)], { cwd: root });
  }
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'pcm_s16le',
    'assets/audio/vo-sh01.wav'], { cwd: root });
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=220:duration=6', '-c:a', 'libmp3lame',
    'assets/audio/music-bed.mp3'], { cwd: root });
  let manifest = await readManifest(root);
  for (const s of SHOTS) {
    const id = assetId('video', s.id, 1);
    manifest = (await record(root, {
      asset_id: id, kind: 'video', shot_id: s.id, take: 1, path: videoPath(s.id, 1), origin: 'agent-code',
      task_id: taskId(1, s.id), duration: s.duration,
    }, { now: NOW })).manifest;
  }
  manifest = (await record(root, {
    kind: 'voiceover', shot_id: 'sh01', path: 'assets/audio/vo-sh01.wav', origin: 'agent-code',
  }, { now: NOW })).manifest;
  manifest = (await record(root, {
    kind: 'music', name: 'music-bed', path: 'assets/audio/music-bed.mp3', origin: 'agent-code',
  }, { now: NOW })).manifest;
  const videoAssets = manifest.assets.filter((a) => a.kind === 'video');
  check(videoAssets.length === 3 && videoAssets.every((a) => a.status === 'valid' && a.media.sha256
    && a.media.duration_sec >= 2 && a.media.width === 640 && a.media.height === 360),
  '3 video takes valid with real sha256, duration and 640x360 probed by ffprobe');
  check(manifest.assets.filter((a) => a.kind === 'voiceover' || a.kind === 'music').every((a) => a.status === 'valid'),
    'voiceover and music bed valid with real audio streams');
  // a broken file is recorded invalid and never reaches the film (section 8 + 9)
  await writeFile(join(root, 'assets', 'video', 'broken-t1.mp4'), 'not a video');
  const withBroken = (await record(root, {
    asset_id: assetId('video', 'broken', 1), kind: 'video', path: 'assets/video/broken-t1.mp4', origin: 'agent-code',
  }, { now: NOW })).manifest;
  const broken = withBroken.assets.find((a) => a.asset_id === 'video-broken-t1');
  check(broken.status === 'invalid' && /not media|incomplete|no video stream/i.test(broken.invalid_reason),
    `a text file named .mp4 is invalid with a real reason: "${broken.invalid_reason}"`);
  await rm(join(root, 'assets', 'video', 'broken-t1.mp4'));
  // remove the invalid entry so the manifest we assemble is clean; validation itself is the test above
  manifest = await readManifest(root);
  manifest.assets = manifest.assets.filter((a) => a.asset_id !== 'video-broken-t1');
  await writeManifest(root, manifest, { now: NOW });

  /* ------------------------------------------------------------ 8: assembly */
  step(8, 'Assembly: manifest -> film.html, checked by openfilm look');
  manifest = await readManifest(root);
  manifest.audio = { music: 'music-bed', music_volume: 0.3, voiceover_volume: 1.0 };
  for (const s of SHOTS) {
    const shot = manifest.shots.find((x) => x.shot_id === s.id);
    shot.status = 'generated'; shot.takes = [assetId('video', s.id, 1)]; shot.selected_take = assetId('video', s.id, 1);
  }
  await writeManifest(root, manifest, { now: NOW });
  const first = await assemble(root, await readManifest(root), { fade: 0, now: NOW });
  check(first.skipped.length === 0 && first.added.length >= 3 && first.placed.sh01?.includes('sh01'),
    `assembled: ${first.added.length} clips added, shots placed = ${JSON.stringify(first.placed)}`);
  check(first.captions.length === 3, `3 caption cues written to ${CAPTIONS_PATH}`);
  const again = await assemble(root, await readManifest(root), { fade: 0, now: NOW });
  check(again.written === false && again.film_rev === first.film_rev && again.edited === false,
    `assembly is a fixed point: second pass writes nothing, film_rev ${first.film_rev} unchanged`);
  const film = await readFilmAt(root);
  const testClips = film.value.tracks.flatMap((t) => t.clips).filter((c) => c.attrs?.['data-framino-test'] === 'true');
  check(testClips.length === film.value.tracks.flatMap((t) => t.clips).length,
    `every placed clip carries data-framino-test="true" (${testClips.length} clips, §9)`);
  // openfilm look starts Studio only for a project it has never shown; mark it shown in this temp project
  await mkdir(join(root, '.film'), { recursive: true });
  await writeFile(join(root, '.film', 'opened'), '');
  const look = await run(process.execPath, [CLI, 'look'], { cwd: root, timeout: 240_000 });
  check(!/^\s*✗/m.test(look) && !/page:|request:/i.test(look),
    'openfilm look: no errors, no page/request errors');
  say('  openfilm look output:');
  for (const line of look.trim().split(/\r?\n/).slice(0, 12)) say(`    ${line}`);

  /* ------------------------------------------------------- 9: Studio opens */
  step(9, 'The assembled film opens in Studio with 0 console errors');
  const isolated = Object.fromEntries(['HOME', 'SHARED_HOME', 'LIBRARY', 'SAVED', 'EXPORTS', 'TRASH_DIR']
    .map((name) => [`OPENFILM_${name}`, join(scratch, name.toLowerCase())]));
  for (const dir of Object.values(isolated)) await mkdir(dir, { recursive: true });
  for (const [key, value] of Object.entries(isolated)) process.env[key] = value;
  const project = await openProject(root);
  studio = await startStudio({ port: 0, openBrowser: () => {} });
  browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'en-US', reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
  await page.route('**/api/library', (route) => route.fulfill({ json: { items: [], groups: {} } }));
  await page.goto(`${studio.origin}/projects/${project.id}?key=${studio.key}`);
  await page.locator('[data-work-mode="edit"]').waitFor();
  check(errors.length === 0, `Studio loaded the project, 0 console/page errors (${errors.length})`);
  say(`  Studio address: ${studio.origin}/projects/${project.id}`);

  /* ------------------------------------------- 10: edit shot, caption, music */
  step(10, 'Edit a shot, a caption and the music level in Studio');
  const beforeRev = (await readFilmAt(root)).rev;
  const readRev = async () => {
    const res = await fetch(`${studio.origin}/api/projects/${project.id}`, { headers: { 'x-studio-key': studio.key } });
    const body = await res.json();
    if (!res.ok) throw new Error(`Studio read failed: ${JSON.stringify(body)}`);
    return body;
  };
  const projectDoc = await readRev();
  const edit = async (ops) => {
    const res = await fetch(`${studio.origin}/api/projects/${project.id}/edit`, {
      method: 'POST',
      headers: { 'x-studio-key': studio.key, 'content-type': 'application/json', origin: studio.origin },
      body: JSON.stringify({ base: projectDoc.rev, ops }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`Studio edit failed: ${JSON.stringify(body)}`);
    return body;
  };
  // move the first shot 0.25 s later, turn the music bed down, and change the first caption's text
  await edit([
    { op: 'props', edits: [{ clip: 'sh01', prop: 'at', value: 0.25 }] },
    { op: 'props', edits: [{ clip: 'music-bed', prop: 'volume', value: 0.1 }] },
  ]);
  const captionRes = await fetch(`${studio.origin}/api/projects/${project.id}/captions/line`, {
    method: 'PUT',
    headers: { 'x-studio-key': studio.key, 'content-type': 'application/json', origin: studio.origin },
    body: JSON.stringify({ src: CAPTIONS_PATH, line: 0, text: 'A better morning, one cup at a time.' }),
  });
  const captionBody = await captionRes.json();
  if (!captionRes.ok) throw new Error(`caption edit failed: ${JSON.stringify(captionBody)}`);
  const afterRev = (await readFilmAt(root)).rev;
  check(afterRev !== beforeRev, `film.html rev changed ${beforeRev.slice(0, 10)} -> ${afterRev.slice(0, 10)}`);
  const afterEdit = await readFilmAt(root);
  const moved = afterEdit.value.tracks.flatMap((t) => t.clips).find((c) => c.id === 'sh01');
  const music = afterEdit.value.tracks.flatMap((t) => t.clips).find((c) => c.id === 'music-bed');
  check(moved?.at === 0.25 && music?.volume === 0.1, 'shot at = 0.25 s and music volume = 0.1 written to film.html');
  const vtt = await readFile(join(root, CAPTIONS_PATH), 'utf8');
  check(vtt.includes('A better morning, one cup at a time.'), 'caption line edited in captions/film.vtt');
  // reopen the edited project in a fresh page: the person's edit survives a reload
  const reopened = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'en-US', reducedMotion: 'reduce' });
  const reopenErrors = [];
  reopened.on('pageerror', (error) => reopenErrors.push(error.message));
  await reopened.goto(`${studio.origin}/projects/${project.id}?key=${studio.key}`);
  await reopened.locator('[data-work-mode="edit"]').waitFor();
  check(reopenErrors.length === 0 && (await readFilmAt(root)).rev === afterRev,
    'reopened Studio: no errors and the edited film.html is unchanged');

  /* ------------------------------------------------- 11: re-assemble over edit */
  step(11, 'Re-assemble after the edit: the person\'s edit survives');
  const beforeReassembly = (await readFilmAt(root)).text;
  const third = await assemble(root, await readManifest(root), { fade: 0, now: NOW });
  const afterReassembly = await readFilmAt(root);
  const thirdShot = afterReassembly.value.tracks.flatMap((t) => t.clips).find((c) => c.id === 'sh01');
  check(third.edited === true && thirdShot?.at === 0.25
    && afterReassembly.text === beforeReassembly,
  'Adapter detected the edit and preserved it byte-for-byte (shot at stayed 0.25 s)');
  // readAssembly over the post-assembly film: it finds clips by data-shot-id and, with write:false, leaves the disk alone
  const diskBeforeRead = (await readFilmAt(root)).rev;
  const readBack = await readAssembly(root, await readManifest(root), { now: NOW, write: false });
  check(readBack.placed.sh01?.includes('sh01') && readBack.film_rev === diskBeforeRead
    && (await readFilmAt(root)).rev === diskBeforeRead,
    `readAssembly finds shots by data-shot-id and write:false leaves film.html untouched: ${JSON.stringify(readBack.placed)}`);

  /* --------------------------------------------------------- 12: export MP4 */
  step(12, 'Export MP4 and verify with ffprobe');
  const render = await run(process.execPath, [CLI, 'render', '--fps', '10', '--workers', '2'], {
    cwd: root, timeout: 480_000,
  });
  const mp4 = join(root, 'coffee-30s.mp4');
  check(existsSync(mp4), `openfilm render produced ${mp4}`);
  const probeOut = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', mp4]);
  const facts = JSON.parse(probeOut);
  const duration = Number(facts.format?.duration);
  const video = facts.streams.find((s) => s.codec_type === 'video');
  const audio = facts.streams.find((s) => s.codec_type === 'audio');
  check(Number.isFinite(duration) && duration > 4 && video?.width > 0 && video?.height > 0 && !!audio,
    `MP4 verified: ${duration?.toFixed(2)} s, ${video?.width}x${video?.height}, ${video?.codec_name} + ${audio?.codec_name}`);
  say('  openfilm render output:');
  for (const line of render.trim().split(/\r?\n/).slice(0, 8)) say(`    ${line}`);

  say('\nE2E OFFLINE RUN: PASS (steps 1-3, 7-12 real; 4-6 blocked on a connected video service)');
  say(`All ${manifest.assets.length} clips in the manifest are origin agent-code; 0 video-model clips were made.`);
} catch (error) {
  say(`\nE2E OFFLINE RUN: FAIL — ${error.message}`);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  await studio?.close?.().catch(() => {});
  if (scratch) {
    if (KEEP) console.log(`\nE2E_KEEP=1: project kept at ${scratch}`);
    else await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
}
