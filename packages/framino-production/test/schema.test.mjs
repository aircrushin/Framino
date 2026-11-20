// @ts-check
/**
 * Contract §4.2: production/manifest.schema.json is the JSON Schema of the Production Manifest. This test proves two
 * things without adding a dependency: the schema is valid JSON Schema 2020-12 that accepts a real manifest, and it
 * agrees with problemsIn() (src/manifest.mjs) on the cases they can both express.
 *
 * Why a small validator here instead of ajv: ajv is not in the dependency tree, and adding it would touch
 * package.json and the lockfile, which Agent 5 owns (AGENTS.md file ownership). The schema below uses a closed set of
 * keywords, so a ~90-line checker that implements exactly those keywords is enough to test the schema honestly. It is
 * test-only; production validation stays in problemsIn().
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { newManifest, problemsIn, MANIFEST_VERSION } from '../src/manifest.mjs';

const SCHEMA_PATH = fileURLToPath(new URL('../production/manifest.schema.json', import.meta.url));

/** The keywords the schema uses. A keyword outside this list is a test bug: fail loudly rather than silently pass. */
const SUPPORTED = new Set([
  '$schema', '$id', 'title', 'description', 'type', 'additionalProperties', 'required', 'properties', 'items',
  'const', 'enum', 'pattern', 'minLength', 'minimum', 'exclusiveMinimum',
]);

/** Collect every keyword key in a schema, recursively. */
function keywords(node, found) {
  if (!node || typeof node !== 'object') return found;
  for (const [key, value] of Object.entries(node)) {
    found.add(key);
    if (key === 'properties' && value && typeof value === 'object') {
      for (const sub of Object.values(value)) keywords(sub, found);
    } else if ((key === 'items' || key === 'additionalProperties') && value && typeof value === 'object') {
      keywords(value, found);
    }
  }
  return found;
}

const typeOf = (value) => Array.isArray(value) ? 'array'
  : value === null ? 'null'
  : Number.isInteger(value) ? 'integer'
  : typeof value === 'number' ? 'number'
  : typeof value;

const matchesType = (value, want) => {
  if (Array.isArray(want)) return want.some((t) => matchesType(value, t));
  if (want === 'integer') return Number.isInteger(value);
  if (want === 'number') return typeof value === 'number';
  if (want === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (want === 'null') return value === null;
  return typeOf(value) === want;
};

/**
 * Validate `value` against `schema`, returning error strings. Only the keywords in SUPPORTED are interpreted.
 * @param {unknown} value @param {any} schema @param {string} at
 */
function check(value, schema, at = '$') {
  /** @type {string[]} */
  const errors = [];
  if (schema.type !== undefined && !matchesType(value, schema.type)) {
    return [`${at}: expected ${JSON.stringify(schema.type)}`];
  }
  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${at}: expected const ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    errors.push(`${at}: not one of ${schema.enum.map((/** @type {unknown} */ x) => JSON.stringify(x)).join(', ')}`);
  }
  if (typeof value === 'string') {
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${at}: does not match ${schema.pattern}`);
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${at}: shorter than ${schema.minLength}`);
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: below ${schema.minimum}`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
      errors.push(`${at}: not above ${schema.exclusiveMinimum}`);
    }
  }
  if (value !== null && typeof value === 'object') {
    const object = /** @type {Record<string, unknown>} */ (value);
    for (const key of schema.required ?? []) {
      if (!(key in object)) errors.push(`${at}.${key}: required`);
    }
    const props = schema.properties ?? {};
    for (const [key, child] of Object.entries(object)) {
      if (key in props) errors.push(...check(child, /** @type {any} */ (props[key]), `${at}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${at}.${key}: unexpected`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        errors.push(...check(child, schema.additionalProperties, `${at}.${key}`));
      }
    }
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => errors.push(...check(item, schema.items, `${at}[${i}]`)));
  }
  return errors;
}

/** The same manifest fixture the other module tests use, built without importing their helpers. */
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

let schemaPromise;
const schemaOf = () => (schemaPromise ??= readFile(SCHEMA_PATH, 'utf8').then((text) => {
  const parsed = JSON.parse(text);
  assert.equal(parsed.$schema, 'https://json-schema.org/draft/2020-12/schema');
  return parsed;
}));

test('the schema is valid JSON Schema 2020-12 and uses only the keywords the test understands', async () => {
  const schema = await schemaOf();
  const used = keywords(schema, new Set());
  const unknown = [...used].filter((k) => !SUPPORTED.has(k));
  assert.deepEqual(unknown, [], `schema uses unsupported keywords: ${unknown.join(', ')}`);
  assert.equal(schema.properties.manifest_version.const, MANIFEST_VERSION);
});

test('a new manifest and a manifest with a shot validate against the schema and problemsIn()', async () => {
  const schema = await schemaOf();
  for (const manifest of [newManifest({ project_id: 'coffee-30s' }), planned()]) {
    assert.deepEqual(check(manifest, schema), [], 'schema accepts the manifest');
    assert.deepEqual(problemsIn(manifest), [], 'problemsIn accepts the same manifest');
  }
});

test('fields the schema and problemsIn can both check agree on what is invalid', async () => {
  const schema = await schemaOf();
  /** @type {[string, (m: any) => void][]} */
  const cases = [
    ['bad project_id', (m) => { m.project_id = 'Coffee 30s'; }],
    ['wrong manifest_version', (m) => { m.manifest_version = '0.1'; }],
    ['bad aspect ratio', (m) => { m.brief.aspect_ratio = '5:4'; }],
    ['zero duration', (m) => { m.shots[0].duration_sec = 0; }],
    ['bad shot id', (m) => { m.shots[0].shot_id = 'shot1'; }],
    ['missing generation prompt', (m) => { delete m.shots[0].generation_prompt; }],
    ['bad asset kind', (m) => { m.assets.push({ asset_id: 'x', kind: 'clip', status: 'valid', path: 'assets/x', origin: 'local' }); }],
    ['bad origin', (m) => { m.assets.push({ asset_id: 'x', kind: 'video', status: 'valid', path: 'assets/x', origin: 'made-up' }); }],
    ['bad task state', (m) => { m.tasks.push({ task_id: 't1-sh01', shot_id: 'sh01', asset_id: 'a', request_key: 'k', state: 'done', attempts: 1 }); }],
    ['zero attempts', (m) => { m.tasks.push({ task_id: 't1-sh01', shot_id: 'sh01', asset_id: 'a', request_key: 'k', state: 'running', attempts: 0 }); }],
  ];
  for (const [name, breakIt] of cases) {
    const manifest = planned();
    breakIt(manifest);
    assert.ok(check(manifest, schema).length, `schema refuses: ${name}`);
    assert.ok(problemsIn(manifest).length, `problemsIn refuses: ${name}`);
  }
});

test('the schema keeps unknown fields, matching §4.2', async () => {
  const schema = await schemaOf();
  const manifest = planned();
  manifest.some_future_field = { nested: true };
  manifest.shots[0].another_new_field = 42;
  assert.deepEqual(check(manifest, schema), [], 'unknown fields are kept and ignored');
  assert.deepEqual(problemsIn(manifest), [], 'problemsIn ignores them too');
});
