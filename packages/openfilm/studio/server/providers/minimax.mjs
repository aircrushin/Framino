// @ts-check
/**
 * MiniMax H3 video generation with the person's own key: text-to-video, first/last-frame video, and multimodal
 * reference video through `/v2/video_generation` and `/v2/query/video_generation/{task_id}`.
 *
 * M Plan subscription keys (`sk-cp-...`) talk to `https://api.minimax.cn`; international keys default to
 * `https://api.minimax.io`. `MINIMAX_API_HOST` or `OPENFILM_MINIMAX_URL` overrides the base URL.
 */
import { billedBy, call, clamp, download, landing, list, mimeOf, modelOf, needed, noBalance, notes, number, serviceUrl, sleep, text } from './common.mjs';

/** @typedef {import('./contract.mjs').Provider} Provider @typedef {import('./contract.mjs').RunContext} RunContext */

const NAME = 'MiniMax';
const RATIOS = ['16:9', '9:16', '4:3', '3:4', '1:1', '21:9'];
const MODELS = {
  video: [
    {
      id: 'MiniMax-H3',
      name: 'MiniMax H3',
      spec: {
        ratios: RATIOS,
        seconds: /** @type {[number, number]} */ ([4, 15]),
        refs: 9,
        frames: /** @type {const} */ (true),
        sizes: ['768p', '2K'],
      },
    },
  ],
};

/** How long to wait between polling a video task (tests make it short). */
export const polling = { ms: { video: 5000 } };

/**
 * Which MiniMax host a key belongs to when `OPENFILM_MINIMAX_URL` is not set.
 * `MINIMAX_API_HOST` overrides; otherwise `sk-cp-` (M Plan CN) goes to `api.minimax.cn` and others to `api.minimax.io`.
 * @param {string} key
 */
export function baseFor(key) {
  const host = process.env.MINIMAX_API_HOST?.trim();
  if (host) return host.replace(/\/+$/, '');
  return key.startsWith('sk-cp-') ? 'https://api.minimax.cn' : 'https://api.minimax.io';
}

/**
 * Sniff the MIME type from the file's leading bytes so a JPEG saved with a `.png` extension is still sent with its
 * real MIME type in a `data:` URI.
 * @param {Uint8Array} bytes @param {string} path
 */
export function sniffMime(bytes, path) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif';
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  if (bytes.length >= 8 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return 'video/mp4';
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45) return 'audio/wav';
  if (bytes.length >= 3 && ((bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33)
    || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0))) return 'audio/mpeg';
  return mimeOf(path);
}

/** @param {string} path @param {RunContext} ctx */
async function inlineMedia(path, ctx) {
  const bytes = await ctx.read(path);
  const mime = sniffMime(bytes, path);
  return `data:${mime};base64,${Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')}`;
}

/**
 * Translate OpenFilm `--resolution` values to MiniMax H3's `480P` / `768P` / `2K`.
 * @param {string} raw @param {string[]} said
 */
function resolutionOf(raw, said) {
  if (!raw) return '768P';
  const lower = raw.toLowerCase();
  if (lower === '480p') return '480P';
  if (lower === '768p') return '768P';
  if (lower === '720p') { said.push('--resolution 720p: MiniMax H3 uses 768P'); return '768P'; }
  if (lower === '2k') return '2K';
  if (lower === '1080p' || lower === '4k') { said.push(`--resolution ${raw}: MiniMax H3 uses 2K`); return '2K'; }
  said.push(`--resolution ${raw}: MiniMax H3 uses 768P or 2K: 768P`);
  return '768P';
}

/**
 * Map OpenFilm `--aspect-ratio` to one of MiniMax H3's supported ratios.
 * @param {string} raw @param {string[]} said
 */
function ratioOf(raw, said) {
  if (!raw || raw === 'adaptive') return '16:9';
  if (RATIOS.includes(raw)) return raw;
  const tall = ['9:21', '2:3'].includes(raw);
  const mapped = tall ? '9:16' : '16:9';
  said.push(`MiniMax H3 makes ${RATIOS.join(', ')} clips: ${mapped}`);
  return mapped;
}

/**
 * Inspect MiniMax's `base_resp` envelope (MiniMax can return HTTP 200 with a non-zero `status_code`).
 * @param {any} body @param {RunContext} ctx
 */
function checkBaseResp(body, ctx) {
  const resp = body?.base_resp;
  if (!resp || resp.status_code === 0 || resp.status_code === undefined) return;
  const code = Number(resp.status_code);
  const rawMsg = typeof resp.status_msg === 'string' ? resp.status_msg : JSON.stringify(resp);
  const msg = (ctx.key ? rawMsg.split(ctx.key).join('•••') : rawMsg).slice(0, 400);
  if (code === 1008 || /insufficient|balance|quota|credit/i.test(msg)) throw noBalance(NAME);
  if (code === 1004 || code === 2049) {
    throw new Error(`${NAME} did not accept your key (${code}: ${msg}). Check it in Studio: Settings → Services.`);
  }
  throw new Error(`${NAME} returned error ${code}${msg ? `: ${msg}` : ''}`);
}

/** @type {Provider} */
export default {
  id: 'minimax',
  name: NAME,
  env: 'MINIMAX_API_KEY',
  keysUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
  billingUrl: 'https://platform.minimaxi.com/user-center/payment/balance',
  pricingUrl: 'https://platform.minimaxi.com/document/Price',
  verbs: ['video'],
  models: MODELS,
  async run(verb, args, ctx) {
    if (verb !== 'video') throw new Error(`${NAME} does not do ${verb}.`);
    const prompt = needed(args, 'prompt');
    const path = landing('video', args.out, 'mp4');
    const model = modelOf(MODELS, 'video', ctx);
    const base = serviceUrl('MINIMAX', baseFor(ctx.key));
    const said = [];

    const first = text(args['first-frame']);
    const last = text(args['last-frame']);
    let refs = list(args['input-reference']);
    const refVideo = text(args.video);
    const refAudio = text(args.audio);
    if (text(args.voice)) said.push('--voice: MiniMax H3 takes --audio for reference audio instead');

    const hasFrames = Boolean(first || last);
    const hasRefs = Boolean(refs.length || refVideo || refAudio);
    if (hasFrames && hasRefs) {
      throw new Error('MiniMax H3 cannot mix --first-frame/--last-frame with --input-reference/--video/--audio.');
    }
    if (refs.length > 9) {
      said.push('MiniMax H3 takes at most 9 reference pictures: the rest were left out');
      refs = refs.slice(0, 9);
    }

    const asked = number(args.duration) ?? 5;
    const seconds = clamp(Math.round(asked), 4, 15);
    if (seconds !== asked) said.push(`MiniMax H3 makes 4 to 15 second clips: ${seconds} s`);
    const resolution = resolutionOf(text(args.resolution), said);

    /** @type {Record<string, unknown>[]} */
    const content = [{ type: 'text', text: prompt }];
    if (first) content.push({ type: 'image_url', image_url: { url: await inlineMedia(first, ctx) }, role: 'first_frame' });
    if (last) content.push({ type: 'image_url', image_url: { url: await inlineMedia(last, ctx) }, role: 'last_frame' });
    for (const ref of refs) {
      content.push({ type: 'image_url', image_url: { url: await inlineMedia(ref, ctx) }, role: 'reference_image' });
    }
    if (refVideo) content.push({ type: 'video_url', video_url: { url: await inlineMedia(refVideo, ctx) }, role: 'reference_video' });
    if (refAudio) content.push({ type: 'audio_url', audio_url: { url: await inlineMedia(refAudio, ctx) }, role: 'reference_audio' });

    /** @type {Record<string, unknown>} */
    const payload = { model, content, duration: seconds, resolution };
    if (!hasFrames && !hasRefs) payload.ratio = ratioOf(text(args['aspect-ratio']), said);
    else if (text(args['aspect-ratio']) && text(args['aspect-ratio']) !== 'adaptive') {
      said.push('--aspect-ratio: omitted because MiniMax H3 follows the input media aspect ratio');
    }

    const authHeaders = { Authorization: `Bearer ${ctx.key}`, 'Content-Type': 'application/json' };
    const submitRes = await call(NAME, `${base}/v2/video_generation`, {
      method: 'POST', headers: authHeaders, body: JSON.stringify(payload),
    }, ctx);
    const submitBody = await submitRes.json();
    checkBaseResp(submitBody, ctx);
    const taskId = text(submitBody?.task_id);
    if (!taskId) throw new Error(`${NAME} answered without a task_id.`);

    const queryUrl = `${base}/v2/query/video_generation/${encodeURIComponent(taskId)}`;
    let videoUrl = '';
    while (true) {
      const pollRes = await call(NAME, queryUrl, { headers: { Authorization: `Bearer ${ctx.key}` } }, ctx);
      const pollBody = await pollRes.json();
      checkBaseResp(pollBody, ctx);
      const task = pollBody?.task ?? pollBody;
      const status = text(task?.status).toLowerCase();
      if (status === 'succeeded') {
        videoUrl = text(task?.content?.url);
        if (!videoUrl) throw new Error(`${NAME} task ${taskId} succeeded without a video URL.`);
        break;
      }
      if (status === 'failed' || status === 'cancelled') {
        const err = task?.error;
        const detail = typeof err === 'string' ? err : err?.message ?? (err ? JSON.stringify(err) : status);
        if (/insufficient|balance|quota|credit/i.test(detail)) throw noBalance(NAME);
        throw new Error(`${NAME} task ${taskId} ${status}: ${detail}`);
      }
      await sleep(polling.ms.video, ctx.signal);
    }

    const { bytes } = await download(NAME, videoUrl, ctx);
    return {
      files: [{ path, bytes }],
      index: [{
        src: path, kind: 'video', dur: seconds, hasAudio: true,
        from: {
          mode: 'generate', prompt, provider: 'minimax', model, resolution, sec: seconds,
          ...(first ? { firstFrame: first } : {}), ...(last ? { lastFrame: last } : {}),
          ...(refs.length ? { refs } : {}), ...(refVideo ? { clip: refVideo } : {}),
        },
      }],
      receipt: { provider: 'minimax', model, src: path, dur: seconds, hasAudio: true, resolution, taskId, ...notes(said) },
      cost: billedBy(NAME),
    };
  },
};
