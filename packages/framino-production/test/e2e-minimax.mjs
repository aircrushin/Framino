// @ts-check
/**
 * Framino Phase 2: live closed-loop end-to-end test using the MiniMax H3 video provider.
 *
 * Runs all 12 steps of `docs/FRAMINO_E2E_TEST_REPORT.md` against the real MiniMax H3 API:
 *   1-3: idea -> brief, script, storyboard, approvals
 *   4:   real video generation through `openfilm get video --via minimax --model MiniMax-H3 --yes` + ledger
 *   5:   simulated crash mid-run + `recover()` proves settled-from-disk never double-charges
 *   6:   real regenerate of sh01 into take 2; verifies sh01-t1 and sh02-t1 remain byte-identical
 *   7:   ffprobe asset validation (`origin: provider:minimax` for clips, `origin: agent-code` for audio fixtures)
 *   8:   assembly into `film.html` (real clips untagged, test audio tagged `data-framino-test="true"`) + `openfilm look`
 *   9:   opens in Studio with 0 console/page errors
 *   10:  edits a shot, caption, and music level in Studio; verifies reload preserves edits
 *   11:  re-assembles after the person's edit and preserves `film.html` byte-for-byte
 *   12:  exports final MP4 via `openfilm render` and verifies streams with ffprobe
 *
 * Prerequisites:
 *   - `MINIMAX_API_KEY` set in the environment (never stored in repo code or logged)
 *   - Explicit user approval for spending / quota usage (`--yes` is passed to `openfilm get video`)
 *
 * Run from the repo root:
 *   node packages/framino-production/test/e2e-minimax.mjs
 *   E2E_KEEP=1 node packages/framino-production/test/e2e-minimax.mjs   # keep the generated project & MP4
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const OPENFILM = join(REPO, 'packages', 'openfilm');
const CLI = join(OPENFILM, 'bin', 'openfilm.mjs');
const requireFromOpenfilm = createRequire(join(OPENFILM, 'package.json'));

if (!process.env.MINIMAX_API_KEY?.trim()) {
  console.error('MINIMAX_API_KEY is required in the environment to run the live MiniMax E2E test.');
  process.exit(2);
}

const { newManifest, problemsIn, readManifest, writeManifest, updateManifest, assetId, videoPath } =
  await import('../src/manifest.mjs');
const { record } = await import('../src/assets.mjs');
const { assemble, readAssembly, CAPTIONS_PATH } = await import('../src/adapter.mjs');
const { readFilmAt } = await import('../src/film.mjs');
const { beginCall, nextTake, outName, planCall, recover, succeedCall } =
  await import(pathToFileURL(join(REPO, 'skills', 'framino-production', 'ledger.mjs')).href);
const { chromium } = requireFromOpenfilm('playwright-core');
const { openProject } = await import(pathToFileURL(join(OPENFILM, 'studio', 'server', 'projects.mjs')).href);
const { startStudio } = await import(pathToFileURL(join(OPENFILM, 'studio', 'server', 'server.mjs')).href);

const KEEP = process.env.E2E_KEEP === '1';
const RESUME_DIR = process.env.E2E_RESUME_DIR?.trim() || '';
const MODEL = process.env.MINIMAX_MODEL?.trim() || 'MiniMax-H3';
const NOW = new Date().toISOString();
const lines = [];
const say = (line) => { lines.push(line); console.log(line); };
const step = (n, text) => say(`\nSTEP ${n} — ${text}`);
const ok = (text) => say(`  PASS  ${text}`);
const check = (condition, message) => {
  if (!condition) throw new Error(`E2E assertion failed: ${message}`);
  ok(message);
};

function run(command, args, options = {}) {
  return new Promise((done, fail) => {
    execFile(command, args, {
      timeout: options.timeout ?? 600_000, cwd: options.cwd, env: options.env,
      maxBuffer: 32 * 1024 * 1024, windowsHide: true,
    }, (error, stdout, stderr) => {
      const out = `${stdout ?? ''}${stderr ?? ''}`;
      if (error) fail(new Error(`${command} ${args.join(' ')} failed (${error.code ?? error.message}):\n${out}`));
      else done(out);
    });
  });
}
const ffmpeg = (args, options) => run('ffmpeg', ['-v', 'error', '-y', ...args], options);
const sha256File = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');

const SHOTS = [
  {
    id: 'sh01', duration: 4, subtitle: 'Great coffee starts here.', vo: 'Great coffee starts here.',
    prompt: 'Cinematic macro close-up of dark roasted coffee beans tumbling into a matte ceramic dripper, warm morning window light, gentle steam, shallow depth of field, slow push-in, no text, no watermark',
    regenPrompt: 'Cinematic macro close-up of golden espresso crema pouring into a warm ceramic cup on a walnut table, soft morning sunlight rays, rising steam, slow smooth dolly-in, no text, no watermark',
  },
  {
    id: 'sh02', duration: 4, subtitle: 'Pour. Breathe. Enjoy.', vo: '',
    prompt: 'Cinematic side-angle shot of hot water pouring in a steady thin stream from a gooseneck kettle over freshly ground coffee, blooming crema, soft warm cafe lighting, slow pan, no text, no watermark',
  },
];

/** Run `openfilm get video --via minimax` and parse its receipt lines. */
async function generateViaCli(root, { shot, take, prompt, duration }) {
  const out = outName(shot, take);
  const args = [
    CLI, 'get', 'video', '--via', 'minimax', '--model', MODEL,
    '--prompt', prompt, '--duration', String(duration),
    '--resolution', '768p', '--aspect-ratio', '16:9',
    '--out', out, '--yes',
  ];
  const stdout = await run(process.execPath, args, { cwd: root, timeout: 900_000 });
  const rel = videoPath(shot, take);
  const abs = join(root, rel);
  if (!existsSync(abs)) throw new Error(`openfilm get video did not land ${rel}:\n${stdout}`);
  const taskMatch = /taskId\s+(\S+)/i.exec(stdout);
  return {
    stdout,
    receipt: {
      provider: 'minimax',
      model: MODEL,
      src: rel,
      dur: duration,
      hasAudio: true,
      ...(taskMatch ? { taskId: taskMatch[1] } : {}),
    },
  };
}

let scratch;
let studio;
let browser;
try {
  scratch = RESUME_DIR || await mkdtemp(join(tmpdir(), 'framino-e2e-minimax-'));
  const root = join(scratch, 'coffee-minimax');
  await mkdir(join(root, 'production'), { recursive: true });
  await mkdir(join(root, 'assets', 'video'), { recursive: true });
  await mkdir(join(root, 'assets', 'audio'), { recursive: true });
  await mkdir(join(root, 'captions'), { recursive: true });

  /* Isolate Studio home so the test does not touch the user's ~/.openfilm state */
  const isolated = Object.fromEntries(['HOME', 'SHARED_HOME', 'LIBRARY', 'SAVED', 'EXPORTS', 'TRASH_DIR']
    .map((name) => [`OPENFILM_${name}`, join(scratch, name.toLowerCase())]));
  for (const dir of Object.values(isolated)) await mkdir(dir, { recursive: true });
  for (const [key, value] of Object.entries(isolated)) process.env[key] = value;

  studio = await startStudio({ port: 0, openBrowser: () => {} });
  const project = await openProject(root);
  say(`project  ${root}`);
  say(`studio   ${studio.origin}/projects/${project.id}`);
  say(`provider minimax (${MODEL}, 768P, 4s shots)`);

  const manifestFile = join(root, 'production', 'manifest.json');
  const resuming = Boolean(RESUME_DIR && existsSync(manifestFile));
  let resumeRecovered = null;

  /* ------------------------------------------------------------------ 1: idea */
  step(1, 'Idea -> manifest.brief; the manifest validates');
  if (resuming) {
    const existing = await readManifest(root);
    check(problemsIn(existing).length === 0, `resumed existing manifest; problemsIn() = 0 (version ${existing.manifest_version})`);
    step(2, 'Script written and approved (approval gate before generation)');
    check(existing.approval.script.state === 'approved', 'approval.script.state = approved');
    step(3, 'Storyboard: 2 shots, all contract fields; approved');
    check(existing.shots.length === 2 && existing.approval.storyboard.state === 'approved', '2 shots approved in resumed manifest');
    resumeRecovered = await recover(root);
  } else {
    const m = newManifest({ project_id: 'coffee-minimax', title: 'Specialty coffee - MiniMax H3 E2E', now: NOW });
    m.brief = {
      idea: 'A short cinematic commercial for a specialty coffee brand.',
      audience: 'urban coffee lovers 25-40', platform: 'youtube', language: 'en', duration_sec: 8,
      aspect_ratio: '16:9', style: 'warm, macro, shallow depth of field',
      limits: { max_generated_seconds: 20, max_takes_per_shot: 3 },
    };
    m.video = { width: 1280, height: 720, fps: 24 };
    await writeFile(join(root, 'production', 'script.md'),
      '# Specialty coffee - MiniMax H3 E2E\n\nHOOK: "Great coffee starts here."\n'
      + SHOTS.map((s) => `## ${s.id}\n\n${s.subtitle}`).join('\n\n') + '\n\nEND: Pour. Breathe. Enjoy.\n');
    check(problemsIn(m).length === 0, `brief written; problemsIn() = 0 (version ${m.manifest_version})`);

    /* ------------------------------------------------------------- 2 + 3: approval */
    step(2, 'Script written and approved (approval gate before generation)');
    m.approval.script = { state: 'approved', at: NOW };
    check(m.approval.script.state === 'approved', 'approval.script.state = approved');

    step(3, 'Storyboard: 2 shots, all contract fields; approved');
    m.scenes = [{ scene_id: 'sc01', title: 'Morning ritual', shots: SHOTS.map((s) => s.id) }];
    m.shots = SHOTS.map((s, i) => ({
      shot_id: s.id, scene_id: 'sc01', order: i + 1, duration_sec: s.duration,
      visual_description: `shot ${s.id} of the coffee ritual`, camera_movement: 'slow push-in',
      camera_angle: 'eye level', lighting: 'soft window light', composition: 'cup on left third',
      generation_prompt: s.prompt, reference_assets: [], voiceover: s.vo, subtitle: s.subtitle,
      aspect_ratio: '16:9', status: 'planned', takes: [], selected_take: null,
    }));
    m.approval.storyboard = { state: 'approved', at: NOW };
    const required = ['shot_id', 'scene_id', 'order', 'duration_sec', 'visual_description', 'camera_movement',
      'camera_angle', 'lighting', 'composition', 'generation_prompt', 'reference_assets', 'voiceover', 'subtitle',
      'aspect_ratio'];
    check(SHOTS.length === 2 && m.shots.every((s) => required.every((k) => s[k] !== undefined))
      && problemsIn(m).length === 0, `2 shots, all ${required.length} contract fields present; manifest validates`);
    check(m.approval.storyboard.state === 'approved', 'approval.storyboard.state = approved');
    await writeManifest(root, m, { now: NOW });
  }

  /* ------------------------------------------------- 4: REAL MiniMax generation */
  step(4, 'Real generation through openfilm get video --via minimax');
  for (const s of SHOTS) {
    const current = await readManifest(root);
    const plan = planCall(current, s.id, 1);
    if (plan.action === 'skip') {
      ok(`ledger planCall(${s.id}, t1) = skip (already settled from disk; not re-submitted)`);
      continue;
    }
    check(plan.action === 'call', `ledger planCall(${s.id}, t1) = ${plan.action}`);
    const request = { prompt: s.prompt, duration: s.duration, resolution: '768p', aspect_ratio: '16:9' };
    await beginCall(root, { shot: s.id, take: 1, provider: 'minimax', model: MODEL, request });
    say(`  ... generating ${s.id}-t1 via MiniMax H3 (${s.duration}s 768P) ...`);
    const gen = await generateViaCli(root, { shot: s.id, take: 1, prompt: s.prompt, duration: s.duration });
    await succeedCall(root, { shot: s.id, take: 1, receipt: gen.receipt, provider: 'minimax', model: MODEL });
    check(existsSync(join(root, videoPath(s.id, 1))),
      `landed ${videoPath(s.id, 1)} via provider=minimax model=${MODEL}${gen.receipt.taskId ? ` taskId=${gen.receipt.taskId}` : ''}`);
  }

  /* ------------------------------------------- 5: crash-resume, no double charge */
  step(5, 'Restart mid-run: recover settles from disk, no shot generated twice');
  if (resumeRecovered && resumeRecovered.resolved.some((r) => r.to === 'succeeded')) {
    const afterRecover = await readManifest(root);
    const planSh01 = planCall(afterRecover, 'sh01', 1);
    check(planSh01.action === 'skip',
      `real crash recovery settled ${resumeRecovered.resolved.map((r) => `${r.task_id}->${r.to}`).join(', ')} from disk; planCall(sh01, t1) = ${planSh01.action} (no double charge)`);
  } else {
    await updateManifest(root, (doc) => {
      const t1 = doc.tasks.find((t) => t.shot_id === 'sh01' && t.asset_id === 'video-sh01-t1');
      t1.state = 'running';
      t1.receipt = null;
    });
    const recovered = await recover(root);
    const afterRecover = await readManifest(root);
    const planSh01 = planCall(afterRecover, 'sh01', 1);
    check(recovered.resolved.some((r) => r.to === 'succeeded') && planSh01.action === 'skip',
      `recover() settled sh01-t1 to succeeded from disk; planCall(sh01, t1) = ${planSh01.action} (no double charge)`);
  }

  /* -------------------------------------- 6: REAL regenerate one shot into take 2 */
  step(6, 'Regenerate sh01 into take 2: new take lands, other takes byte-identical');
  const hashSh01T1Before = await sha256File(join(root, videoPath('sh01', 1)));
  const hashSh02T1Before = await sha256File(join(root, videoPath('sh02', 1)));
  const next = nextTake(await readManifest(root), 'sh01');
  check(next === 2, `nextTake(sh01) = ${next}`);
  const regenReq = { prompt: SHOTS[0].regenPrompt, duration: SHOTS[0].duration, resolution: '768p', aspect_ratio: '16:9' };
  await beginCall(root, { shot: 'sh01', take: next, provider: 'minimax', model: MODEL, request: regenReq });
  say(`  ... regenerating sh01-t${next} via MiniMax H3 (${SHOTS[0].duration}s 768P) ...`);
  const regen = await generateViaCli(root, { shot: 'sh01', take: next, prompt: SHOTS[0].regenPrompt, duration: SHOTS[0].duration });
  await succeedCall(root, { shot: 'sh01', take: next, receipt: regen.receipt, provider: 'minimax', model: MODEL });
  const hashSh01T1After = await sha256File(join(root, videoPath('sh01', 1)));
  const hashSh02T1After = await sha256File(join(root, videoPath('sh02', 1)));
  const hashSh01T2 = await sha256File(join(root, videoPath('sh01', 2)));
  check(hashSh01T1Before === hashSh01T1After && hashSh02T1Before === hashSh02T1After && hashSh01T2 !== hashSh01T1Before,
    `sh01-t2 landed (${hashSh01T2.slice(0, 10)}); sh01-t1 and sh02-t1 byte-identical`);

  /* --------------------------------------------------------------- 7: assets */
  step(7, 'Assets land and validate (section 8)');
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'pcm_s16le',
    'assets/audio/vo-sh01.wav'], { cwd: root });
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=220:duration=8', '-c:a', 'libmp3lame',
    'assets/audio/music-bed.mp3'], { cwd: root });
  let manifest = await readManifest(root);
  for (const [shotId, take] of [['sh01', 1], ['sh01', 2], ['sh02', 1]]) {
    const task = manifest.tasks.find((t) => t.asset_id === assetId('video', shotId, take));
    manifest = (await record(root, {
      asset_id: assetId('video', shotId, take), kind: 'video', shot_id: shotId, take,
      path: videoPath(shotId, take), origin: 'provider:minimax', task_id: task?.task_id ?? null, duration: 4,
    })).manifest;
  }
  manifest = (await record(root, {
    kind: 'voiceover', shot_id: 'sh01', path: 'assets/audio/vo-sh01.wav', origin: 'agent-code',
  })).manifest;
  manifest = (await record(root, {
    kind: 'music', name: 'music-bed', path: 'assets/audio/music-bed.mp3', origin: 'agent-code',
  })).manifest;
  const realVideos = manifest.assets.filter((a) => a.kind === 'video' && a.origin === 'provider:minimax');
  check(realVideos.length === 3 && realVideos.every((a) => a.status === 'valid' && a.media?.sha256
    && a.media.duration_sec >= 3.5 && a.media.width > 0 && a.media.height > 0),
  `3 real MiniMax video takes valid (${realVideos.map((a) => `${a.media.width}x${a.media.height}@${a.media.duration_sec.toFixed(2)}s`).join(', ')})`);
  check(manifest.assets.filter((a) => a.kind === 'voiceover' || a.kind === 'music').every((a) => a.status === 'valid'),
    'voiceover and music bed valid (origin: agent-code)');
  await writeFile(join(root, 'assets', 'video', 'broken-t1.mp4'), 'not a video');
  const withBroken = (await record(root, {
    asset_id: assetId('video', 'broken', 1), kind: 'video', path: 'assets/video/broken-t1.mp4', origin: 'agent-code',
  })).manifest;
  const broken = withBroken.assets.find((a) => a.asset_id === 'video-broken-t1');
  check(broken.status === 'invalid' && /not media|incomplete|no video stream/i.test(broken.invalid_reason),
    `corrupt .mp4 rejected as invalid: "${broken.invalid_reason}"`);
  await rm(join(root, 'assets', 'video', 'broken-t1.mp4'));
  manifest = await readManifest(root);
  manifest.assets = manifest.assets.filter((a) => a.asset_id !== 'video-broken-t1');
  await writeManifest(root, manifest);

  /* ------------------------------------------------------------ 8: assembly */
  step(8, 'Assembly: manifest -> film.html, checked by openfilm look');
  manifest = await readManifest(root);
  manifest.audio = { music: 'music-bed', music_volume: 0.25, voiceover_volume: 1.0 };
  const sh01 = manifest.shots.find((x) => x.shot_id === 'sh01');
  sh01.status = 'generated'; sh01.takes = [assetId('video', 'sh01', 1), assetId('video', 'sh01', 2)];
  sh01.selected_take = assetId('video', 'sh01', 2);
  const sh02 = manifest.shots.find((x) => x.shot_id === 'sh02');
  sh02.status = 'generated'; sh02.takes = [assetId('video', 'sh02', 1)];
  sh02.selected_take = assetId('video', 'sh02', 1);
  await writeManifest(root, manifest);
  const first = await assemble(root, await readManifest(root), { fade: 0 });
  check(first.skipped.length === 0 && first.added.length >= 2 && first.placed.sh01?.includes('sh01'),
    `assembled: ${first.added.length} clips added, shots placed = ${JSON.stringify(first.placed)}`);
  check(first.captions.length === 2, `2 caption cues written to ${CAPTIONS_PATH}`);
  const again = await assemble(root, await readManifest(root), { fade: 0 });
  check(again.written === false && again.film_rev === first.film_rev && again.edited === false,
    `assembly is a fixed point: second pass writes nothing, film_rev ${first.film_rev.slice(0, 12)} unchanged`);
  const film = await readFilmAt(root);
  const allClips = film.value.tracks.flatMap((t) => t.clips);
  const videoClips = allClips.filter((c) => c.id === 'sh01' || c.id === 'sh02');
  const audioClips = allClips.filter((c) => c.id !== 'sh01' && c.id !== 'sh02');
  check(videoClips.every((c) => c.attrs?.['data-framino-test'] !== 'true')
    && audioClips.every((c) => c.attrs?.['data-framino-test'] === 'true'),
  `real MiniMax video clips (${videoClips.length}) untagged; synthetic audio clips (${audioClips.length}) tagged data-framino-test="true"`);
  await mkdir(join(root, '.film'), { recursive: true });
  await writeFile(join(root, '.film', 'opened'), '');
  const look = await run(process.execPath, [CLI, 'look'], { cwd: root, timeout: 240_000 });
  check(!/^\s*✗/m.test(look) && !/page:|request:/i.test(look),
    'openfilm look: no errors, no page/request errors');
  for (const line of look.trim().split(/\r?\n/).slice(0, 10)) say(`    ${line}`);

  /* ------------------------------------------------------- 9: Studio opens */
  step(9, 'The assembled film opens in Studio with 0 console errors');
  browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'en-US', reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
  await page.route('**/api/library', (route) => route.fulfill({ json: { items: [], groups: {} } }));
  await page.goto(`${studio.origin}/projects/${project.id}?key=${studio.key}`);
  await page.locator('[data-work-mode="edit"]').waitFor();
  check(errors.length === 0, `Studio loaded the project, 0 console/page errors (${errors.length})`);

  /* ------------------------------------------- 10: edit shot, caption, music */
  step(10, 'Edit a shot, a caption and the music level in Studio');
  const beforeRev = (await readFilmAt(root)).rev;
  const readRes = await fetch(`${studio.origin}/api/projects/${project.id}`, { headers: { 'x-studio-key': studio.key } });
  const projectDoc = await readRes.json();
  if (!readRes.ok) throw new Error(`Studio read failed: ${JSON.stringify(projectDoc)}`);
  const editRes = await fetch(`${studio.origin}/api/projects/${project.id}/edit`, {
    method: 'POST',
    headers: { 'x-studio-key': studio.key, 'content-type': 'application/json', origin: studio.origin },
    body: JSON.stringify({
      base: projectDoc.rev,
      ops: [
        { op: 'props', edits: [{ clip: 'sh01', prop: 'at', value: 0.25 }] },
        { op: 'props', edits: [{ clip: 'music-bed', prop: 'volume', value: 0.1 }] },
      ],
    }),
  });
  if (!editRes.ok) throw new Error(`Studio edit failed: ${await editRes.text()}`);
  const captionRes = await fetch(`${studio.origin}/api/projects/${project.id}/captions/line`, {
    method: 'PUT',
    headers: { 'x-studio-key': studio.key, 'content-type': 'application/json', origin: studio.origin },
    body: JSON.stringify({ src: CAPTIONS_PATH, line: 0, text: 'A better morning, one cup at a time.' }),
  });
  if (!captionRes.ok) throw new Error(`caption edit failed: ${await captionRes.text()}`);
  const afterRev = (await readFilmAt(root)).rev;
  check(afterRev !== beforeRev, `film.html rev changed ${beforeRev.slice(0, 10)} -> ${afterRev.slice(0, 10)}`);
  const afterEdit = await readFilmAt(root);
  const moved = afterEdit.value.tracks.flatMap((t) => t.clips).find((c) => c.id === 'sh01');
  const music = afterEdit.value.tracks.flatMap((t) => t.clips).find((c) => c.id === 'music-bed');
  check(moved?.at === 0.25 && music?.volume === 0.1, 'shot at = 0.25 s and music volume = 0.1 written to film.html');
  const vtt = await readFile(join(root, CAPTIONS_PATH), 'utf8');
  check(vtt.includes('A better morning, one cup at a time.'), 'caption line edited in captions/film.vtt');
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
  const third = await assemble(root, await readManifest(root), { fade: 0 });
  const afterReassembly = await readFilmAt(root);
  const thirdShot = afterReassembly.value.tracks.flatMap((t) => t.clips).find((c) => c.id === 'sh01');
  check(third.edited === true && thirdShot?.at === 0.25 && afterReassembly.text === beforeReassembly,
    'Adapter detected the edit and preserved it byte-for-byte (shot at stayed 0.25 s)');
  const diskBeforeRead = (await readFilmAt(root)).rev;
  const readBack = await readAssembly(root, await readManifest(root), { write: false });
  check(readBack.placed.sh01?.includes('sh01') && readBack.film_rev === diskBeforeRead
    && (await readFilmAt(root)).rev === diskBeforeRead,
  `readAssembly finds shots by data-shot-id and write:false leaves film.html untouched: ${JSON.stringify(readBack.placed)}`);

  /* --------------------------------------------------------- 12: export MP4 */
  step(12, 'Export MP4 and verify with ffprobe');
  const render = await run(process.execPath, [CLI, 'render', '--fps', '24', '--workers', '2'], {
    cwd: root, timeout: 480_000,
  });
  const mp4 = join(root, 'coffee-minimax.mp4');
  check(existsSync(mp4), `openfilm render produced ${mp4}`);
  const probeOut = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', mp4]);
  const facts = JSON.parse(probeOut);
  const duration = Number(facts.format?.duration);
  const video = facts.streams.find((s) => s.codec_type === 'video');
  const audio = facts.streams.find((s) => s.codec_type === 'audio');
  check(Number.isFinite(duration) && duration > 6 && video?.width === 1280 && video?.height === 720 && !!audio,
    `MP4 verified: ${duration?.toFixed(2)} s, ${video?.width}x${video?.height}, ${video?.codec_name} + ${audio?.codec_name}`);
  for (const line of render.trim().split(/\r?\n/).slice(0, 8)) say(`    ${line}`);

  say('\nE2E LIVE MINIMAX RUN: PASS (all 12 steps passed)');
  say(`Real video-model clips: ${realVideos.length} (provider:minimax / ${MODEL}); synthetic audio fixtures: 2 (agent-code).`);
} catch (error) {
  say(`\nE2E LIVE MINIMAX RUN: FAIL — ${error.message}`);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  await studio?.close?.().catch(() => {});
  if (scratch) {
    if (KEEP) console.log(`\nE2E_KEEP=1: project kept at ${scratch}`);
    else await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
}
