/**
 * Every icon the desktop app ships, from the two SVG masters beside this script:
 *
 *   build/logo-1024.png   1024 px, the master the other sizes are measured against
 *   build/icon.png        256 px, the window icon Electron uses on Windows
 *   build/icon-dev.png    256 px with the DEV pill, for a local build
 *   build/icon.ico        16, 24, 32, 48, 64 and 256 px, as PNG payloads (Vista and later read them)
 *   build/icon.icns       the eleven representations macOS asks for
 *   build/icon-dev.icns   the same, with the DEV pill
 *
 * Chrome does the rasterising, so this runs on any platform and needs no image library: `node scripts/make-icons.mjs`.
 * It replaces make-ico.mjs, which shelled out to sips and could only run on macOS.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const build = resolve(dirname(fileURLToPath(import.meta.url)), '../build');

/** The master as a page that is exactly `size` square, transparent everywhere the tile is not. */
const page = (svg, size) => `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:transparent}svg{display:block}</style>
${svg.replace(/width="1024" height="1024"/, `width="${size}" height="${size}"`)}`;

/* a stock Chrome if there is one (that is what the app's own tests use), otherwise whatever playwright-core finds */
const open = async () => {
  try {
    return await chromium.launch({ channel: 'chrome', headless: true });
  } catch {
    return chromium.launch({ headless: true });
  }
};

const browser = await open();
const shot = async (svg, size) => {
  const tab = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await tab.setContent(page(svg, size), { waitUntil: 'load' });
  const png = await tab.screenshot({ clip: { x: 0, y: 0, width: size, height: size }, omitBackground: true });
  await tab.close();
  return png;
};

const render = async (svg, sizes) => {
  const out = new Map();
  for (const size of sizes) out.set(size, await shot(svg, size));
  return out;
};

const SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const mark = readFileSync(join(build, 'icon-source.svg'), 'utf8');
const dev = readFileSync(join(build, 'icon-source-dev.svg'), 'utf8');
const png = await render(mark, SIZES);
const devPng = await render(dev, SIZES);
await browser.close();

/* --- .ico: a directory of PNG files, 256 written as 0 because that field is a single byte --- */
const ico = (sizes) => {
  const images = sizes.map((size) => png.get(size));
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach((image, i) => {
    const size = sizes[i];
    const at = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, at);
    header.writeUInt8(size >= 256 ? 0 : size, at + 1);
    header.writeUInt8(0, at + 2);
    header.writeUInt8(0, at + 3);
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(image.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += image.length;
  });
  return Buffer.concat([header, ...images]);
};

/* --- .icns: `icns` + total length, then one chunk per representation; these PNG types are read on 10.7 and later --- */
const ICNS = [
  ['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024],
  ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512],
];
const icns = (images) => {
  const chunks = ICNS.map(([type, size]) => {
    const image = images.get(size);
    const head = Buffer.alloc(8);
    head.write(type, 0, 4, 'ascii');
    head.writeUInt32BE(image.length + 8, 4);
    return Buffer.concat([head, image]);
  });
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 4, 'ascii');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
};

const files = {
  'logo-1024.png': png.get(1024),
  'icon.png': png.get(256),
  'icon.ico': ico([16, 24, 32, 48, 64, 256]),
  'icon.icns': icns(png),
  'icon-dev.png': devPng.get(256),
  'icon-dev.icns': icns(devPng),
};
for (const [name, data] of Object.entries(files)) {
  writeFileSync(join(build, name), data);
  console.log(`${name} ${data.length} bytes`);
}
