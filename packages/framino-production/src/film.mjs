// @ts-check
/**
 * The one bridge between Framino's production layer and a film on disk.
 *
 * Why this file exists: `packages/openfilm` is not linked into `node_modules` (a clean `pnpm install` leaves no
 * `node_modules/openfilm`), so `import 'openfilm/film-doc'` fails with ERR_MODULE_NOT_FOUND. Rather than add a
 * workspace dependency and a build step, every Framino module imports `film-doc` through here, by relative path.
 * One import site, one place to change if that ever stops being true.
 *
 * The rule it enforces (hard rule 3): `film.html` is written only through `film-doc.mjs` — `readFilmFile` to read,
 * change the value, `filmHtml(value, before)` to write. Never string-templated HTML.
 *
 * The property it exists to prove: **assembling twice changes nothing.** `manifest.assembly.film_rev` is a hash of
 * `film.html`; if a second assembly rewrote the file, the Adapter could never tell "the person edited this" from
 * "I wrote it again", and the re-assembly rule would silently break. `assertStable` is that check, and the Adapter
 * runs it before it writes anything.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FILM_FILE, filmHtml, readFilmFile } from '../../openfilm/src/film-doc.mjs';
import { writeAtomic } from '../../openfilm/studio/server/atomic.mjs';

export { FILM_FILE, filmHtml, readFilmFile };

/** A film with no tracks: what `openfilm open` writes for a new project (`projects.mjs`, `EMPTY_FILM`). */
export const EMPTY_FILM = Object.freeze({ stage: Object.freeze({ w: 1920, h: 1080 }), tracks: Object.freeze([]) });

/**
 * The revision of a film text: its sha256.
 *
 * Studio's own `revOf` (`studio/server/film.mjs`) is the first 16 characters of this same hash, so a `film_rev`
 * recorded here can be compared against a revision Studio reports without converting anything.
 * @param {string} text
 */
export const filmRev = (text) => createHash('sha256').update(text).digest('hex');

/** The text a new project's `film.html` has, before any track is added. */
export const emptyFilmText = () => filmHtml(EMPTY_FILM);

/**
 * A film as it is on disk: its text, its revision, and the value `film-doc` read from it.
 * @typedef {{ text: string, rev: string, value: any }} Film
 */

/**
 * Read the film in `root`. A project with no `film.html` reads as the empty film, which is what `openfilm open`
 * would have written there.
 * @param {string} root the project folder
 * @returns {Promise<Film>}
 */
export async function readFilmAt(root) {
  let text;
  try {
    text = await readFile(join(root, FILM_FILE), 'utf8');
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'ENOENT') throw e;
    text = emptyFilmText();
  }
  if (!text.trim()) text = emptyFilmText();
  const { value } = readFilmFile(text);
  return { text, rev: filmRev(text), value };
}

/**
 * Write `value` over the film in `root`, atomically, keeping the text of everything that did not change.
 * @param {string} root @param {any} value @param {string} before the text the value was made from
 * @returns {Promise<Film>}
 */
export async function writeFilmAt(root, value, before) {
  const text = filmHtml(value, before);
  await writeAtomic(join(root, FILM_FILE), text, 'utf8');
  return { text, rev: filmRev(text), value };
}

/**
 * Whether writing `value` over `before` would change the file at all. The fixed-point check: a value read from a
 * film and written straight back has to produce the same text, or the Adapter cannot use `film_rev` to detect a
 * person's edit.
 * @param {any} value @param {string} before
 * @returns {{ stable: boolean, text: string }}
 */
export function writesCleanly(value, before) {
  const text = filmHtml(value, before);
  return { stable: text === before, text };
}

/**
 * Throw unless writing `value` over `before` leaves the file byte-identical. Called by the Adapter before it writes:
 * a film that would drift on every assembly is a bug to fix, not a file to save.
 * @param {any} value @param {string} before @param {string} [what]
 */
export function assertStable(value, before, what = 'the film') {
  const { stable, text } = writesCleanly(value, before);
  if (stable) return;
  const at = firstDifference(before, text);
  throw new Error(
    `${what} would change on a second assembly, so film_rev could not tell a person's edit from a rewrite: `
    + `first difference at character ${at}, ${JSON.stringify(before.slice(Math.max(0, at - 30), at + 30))} `
    + `would become ${JSON.stringify(text.slice(Math.max(0, at - 30), at + 30))}`,
  );
}

/**
 * Where two texts first differ, or the shorter length when one is a prefix of the other.
 * @param {string} a @param {string} b
 */
export function firstDifference(a, b) {
  const end = Math.min(a.length, b.length);
  for (let i = 0; i < end; i++) if (a[i] !== b[i]) return i;
  return end;
}

/**
 * The clips of a shot, found by `data-shot-id` and never by clip id: a Studio split copies the clip including its
 * `data-*` and gives the right half a new id, so one shot can be several clips (§2.1).
 * @param {any} value @param {string} shot
 * @returns {{ track: number, clip: any }[]}
 */
export function clipsOfShot(value, shot) {
  /** @type {{ track: number, clip: any }[]} */
  const found = [];
  (value.tracks ?? []).forEach((/** @type {any} */ track, /** @type {number} */ ti) => {
    for (const clip of track.clips ?? []) {
      if (clip.attrs?.['data-shot-id'] === shot) found.push({ track: ti, clip });
    }
  });
  return found;
}

/**
 * The track Framino made for a role, by `data-framino-track`, or -1.
 * @param {any} value @param {string} role
 */
export function trackOfRole(value, role) {
  return (value.tracks ?? []).findIndex((/** @type {any} */ t) => t.attrs?.['data-framino-track'] === role);
}

/**
 * A clip id that is not taken: `sh03`, then `sh03-2`, `sh03-3`. Clip ids are `^[A-Za-z][\w-]*$` (`ops.mjs`).
 * @param {any} value @param {string} wanted
 */
export function freeClipId(value, wanted) {
  const taken = new Set();
  for (const track of value.tracks ?? []) for (const clip of track.clips ?? []) taken.add(clip.id);
  if (!taken.has(wanted)) return wanted;
  for (let n = 2; ; n++) {
    const id = `${wanted}-${n}`;
    if (!taken.has(id)) return id;
  }
}
