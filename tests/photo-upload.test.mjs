import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { File } from 'node:buffer';
import { transform } from 'esbuild';

const source = readFileSync(new URL('../src/photo-upload.ts', import.meta.url), 'utf8');
const compiled = (await transform(source, { loader: 'ts', format: 'esm', target: 'es2022' })).code;
const { preparePhoto } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

function jpeg(width, height, padding = 0) {
  const header = Uint8Array.from([
    0xff, 0xd8, 0xff, 0xc0, 0, 11, 8,
    height >> 8, height & 255, width >> 8, width & 255,
    3, 1, 0x11, 0, 2, 0x11, 0,
  ]);
  return new File([header, new Uint8Array(padding)], 'photo.jpg', { type: 'image/jpeg' });
}

function png(width, height, padding = 0) {
  const header = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0, 0, 0, 13, 73, 72, 68, 82,
    width >>> 24, width >>> 16, width >>> 8, width,
    height >>> 24, height >>> 16, height >>> 8, height,
  ]);
  return new File([header, new Uint8Array(padding)], 'photo.png', { type: 'image/png' });
}

function webp(width, height) {
  const bytes = Uint8Array.from([
    82, 73, 70, 70, 22, 0, 0, 0, 87, 69, 66, 80,
    86, 80, 56, 88, 10, 0, 0, 0, 0, 0, 0, 0,
    (width - 1) & 255, ((width - 1) >> 8) & 255, ((width - 1) >> 16) & 255,
    (height - 1) & 255, ((height - 1) >> 8) & 255, ((height - 1) >> 16) & 255,
  ]);
  return new File([bytes], 'photo.webp', { type: 'image/webp' });
}

function simpleWebp(width, height, lossless) {
  const w = width - 1, h = height - 1;
  const payload = lossless
    ? [0x2f, w & 255, ((w >> 8) & 63) | ((h & 3) << 6), (h >> 2) & 255, (h >> 10) & 15]
    : [0, 0, 0, 0x9d, 0x01, 0x2a, width & 255, width >> 8, height & 255, height >> 8];
  const chunk = lossless ? [86, 80, 56, 76] : [86, 80, 56, 32];
  return new File([Uint8Array.from([82, 73, 70, 70, 22, 0, 0, 0, 87, 69, 66, 80, ...chunk, 10, 0, 0, 0, ...payload])],
    'photo.webp', { type: 'image/webp' });
}

function mockBrowser({ width, height, blobs = [] }) {
  const originalBitmap = globalThis.createImageBitmap;
  const originalDocument = globalThis.document;
  const draws = [];
  const encodes = [];
  let closed = false;
  globalThis.createImageBitmap = async (_file, options) => {
    assert.equal(options.imageOrientation, 'from-image');
    return { width, height, close() { closed = true; } };
  };
  globalThis.document = {
    createElement(name) {
      assert.equal(name, 'canvas');
      return {
        width: 0, height: 0,
        getContext() { return { drawImage(...args) { draws.push(args); } }; },
        toBlob(callback, type, quality) {
          encodes.push({ type, quality });
          callback(blobs.shift() ?? new Blob(['encoded'], { type }));
        },
      };
    },
  };
  return { draws, encodes, get closed() { return closed; }, restore() {
    globalThis.createImageBitmap = originalBitmap;
    globalThis.document = originalDocument;
  } };
}

test('keeps a small image unchanged after checking its dimensions', async () => {
  const browser = mockBrowser({ width: 1200, height: 800 });
  try {
    const file = jpeg(1200, 800);
    assert.equal(await preparePhoto(file), file);
    assert.equal(browser.draws.length, 0);
    assert.equal(browser.closed, true);
  } finally { browser.restore(); }
});

test('reads the dimensions of extended, lossy and lossless WebP', async () => {
  const browser = mockBrowser({ width: 800, height: 600 });
  try {
    for (const file of [webp(800, 600), simpleWebp(800, 600, false), simpleWebp(800, 600, true)]) {
      assert.equal(await preparePhoto(file), file);
    }
  } finally { browser.restore(); }
});

test('rejects files over 20 MiB and excessive pixels before decoding', async () => {
  const file = jpeg(1200, 800, 20 * 1024 * 1024);
  await assert.rejects(preparePhoto(file), /20MiB/);
  await assert.rejects(preparePhoto(jpeg(9000, 7000)), /縦横サイズ/);
  await assert.rejects(preparePhoto(webp(10001, 100)), /縦横サイズ/);
  await assert.rejects(preparePhoto(png(0, 100)), /サイズを確認/);
});

test('uses oriented dimensions and keeps the aspect ratio when shrinking JPEG', async () => {
  const browser = mockBrowser({ width: 3000, height: 4000 });
  try {
    const result = await preparePhoto(jpeg(4000, 3000));
    assert.equal(result.type, 'image/jpeg');
    assert.deepEqual(browser.draws[0].slice(1), [0, 0, 900, 1200]);
    assert.deepEqual(browser.encodes, [{ type: 'image/jpeg', quality: 0.82 }]);
    assert.equal(browser.closed, true);
  } finally { browser.restore(); }
});

test('tries WebP for a large transparent PNG without painting a background', async () => {
  const browser = mockBrowser({ width: 2400, height: 1200, blobs: [
    new Blob([new Uint8Array(3 * 1024 * 1024)], { type: 'image/png' }),
    new Blob([new Uint8Array(500_000)], { type: 'image/webp' }),
  ] });
  try {
    const result = await preparePhoto(png(2400, 1200));
    assert.equal(result.type, 'image/webp');
    assert.deepEqual(browser.draws[0].slice(1), [0, 0, 1200, 600]);
    assert.deepEqual(browser.encodes.map(({ type }) => type), ['image/png', 'image/webp']);
  } finally { browser.restore(); }
});

test('uses the actual encoded type when WebP export falls back to PNG', async () => {
  const browser = mockBrowser({ width: 2400, height: 1200, blobs: [
    new Blob([new Uint8Array(3 * 1024 * 1024)], { type: 'image/png' }),
    new Blob([new Uint8Array(400_000)], { type: 'image/png' }),
  ] });
  try {
    const result = await preparePhoto(png(2400, 1200));
    assert.equal(result.type, 'image/png');
    assert.equal(browser.encodes[1].type, 'image/webp');
  } finally { browser.restore(); }
});

test('rejects an output that remains over 5 MiB', async () => {
  const browser = mockBrowser({ width: 2000, height: 1500, blobs: Array.from({ length: 3 }, () =>
    new Blob([new Uint8Array(6 * 1024 * 1024)], { type: 'image/jpeg' })) });
  try {
    await assert.rejects(preparePhoto(jpeg(2000, 1500)), /圧縮後も写真が5MiB/);
    assert.equal(browser.encodes.length, 3);
    assert.equal(browser.closed, true);
  } finally { browser.restore(); }
});
