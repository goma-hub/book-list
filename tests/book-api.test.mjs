import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { transform } from 'esbuild';

const authStub = `function createAuth() {
  return { api: { getSession: async ({ headers }) => {
    const id = headers.get('x-test-user');
    return id ? { user: { id } } : null;
  } } };
}`;
const inputSource = readFileSync(new URL('../worker/book-input.ts', import.meta.url), 'utf8');
const workerSource = readFileSync(new URL('../worker/index.ts', import.meta.url), 'utf8')
  .replace(/^import .*\r?\n/gm, '');
const compiled = (await transform(`${authStub}\n${inputSource}\n${workerSource}`, {
  loader: 'ts', format: 'esm', target: 'es2022',
})).code;
const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function fixture(overrides = {}) {
  return {
    id: 'book-1', userId: 'owner', title: 'Book', author: null,
    finishedOn: null, photoUrl: null, photoKey: null,
    memo: null, createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function harness(initial = fixture()) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE books (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT, author TEXT,
    finished_on TEXT, photo_url TEXT, photo_key TEXT, memo TEXT, created_at TEXT NOT NULL
  )`);
  sqlite.prepare(`INSERT INTO books
    (id, user_id, title, author, finished_on, photo_url, photo_key, memo, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(initial.id, initial.userId, initial.title, initial.author, initial.finishedOn,
      initial.photoUrl, initial.photoKey, initial.memo, initial.createdAt);
  const rows = {
    get(id) {
      return sqlite.prepare(`SELECT id, user_id AS userId, title, author,
        finished_on AS finishedOn, photo_url AS photoUrl, photo_key AS photoKey,
        memo, created_at AS createdAt FROM books WHERE id = ?`).get(id);
    },
    has(id) { return Boolean(this.get(id)); },
  };
  const objects = new Map();
  const fail = { update: false, remove: false, upload: false, cleanup: false, conflict: false };

  const DB = {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      return {
        bind(...params) {
          return {
            async first() { return statement.get(...params) ?? null; },
            async all() { return { results: statement.all(...params) }; },
            async run() {
              if (fail.update && sql.includes('UPDATE books')) throw new Error('D1 update failed');
              if (fail.remove && sql.includes('DELETE FROM books')) throw new Error('D1 delete failed');
              if (fail.conflict) return { meta: { changes: 0 } };
              return { meta: { changes: Number(statement.run(...params).changes) } };
            },
          };
        },
      };
    },
  };
  const BOOK_PHOTOS = {
    async put(key, bytes) {
      if (fail.upload) throw new Error('R2 upload failed');
      objects.set(key, bytes);
    },
    async get(key) {
      if (!objects.has(key)) return null;
      return {
        body: new Blob([objects.get(key)]),
        writeHttpMetadata(headers) { headers.set('content-type', 'image/png'); },
      };
    },
    async delete(key) {
      if (fail.cleanup) throw new Error('R2 delete failed');
      objects.delete(key);
    },
  };
  const env = { DB, BOOK_PHOTOS };

  async function request(path, method = 'GET', body, user = 'owner') {
    const headers = new Headers();
    if (user) headers.set('x-test-user', user);
    if (body !== undefined) headers.set('content-type', body instanceof Uint8Array ? 'image/png' : 'application/json');
    const request = new Request(`http://localhost${path}`, {
      method, headers,
      ...(body === undefined ? {} : { body: body instanceof Uint8Array ? body : JSON.stringify(body) }),
    });
    const response = await worker.fetch(request, env);
    return {
      status: response.status,
      body: response.headers.get('content-type')?.startsWith('application/json') ? await response.json() : null,
    };
  }

  return { rows, objects, fail, request };
}

test('detail and all mutations require authentication and ownership', async () => {
  const h = harness();
  for (const [path, method, body] of [
    ['/api/books/book-1', 'GET'],
    ['/api/books/book-1', 'PUT', { memo: 'Updated' }],
    ['/api/books/book-1', 'DELETE'],
    ['/api/books/book-1/photo', 'PUT', png],
    ['/api/books/book-1/photo', 'DELETE'],
  ]) {
    assert.equal((await h.request(path, method, body, null)).status, 401);
    assert.equal((await h.request(path, method, body, 'other')).status, 404);
  }
  assert.equal(h.rows.get('book-1').memo, null);
});

test('existing creation and list responses still work', async () => {
  const h = harness();
  const create = await h.request('/api/books', 'POST', { title: ' New book ', photoUrl: 'https://example.com/cover.jpg' });
  assert.equal(create.status, 201);
  assert.equal(create.body.book.title, 'New book');
  const list = await h.request('/api/books');
  assert.equal(list.status, 200);
  assert.equal(list.body.books.length, 2);
  assert.equal((await h.request('/api/books', 'GET', undefined, 'other')).body.books.length, 0);
});

test('detail returns the owned record and editing keeps an existing R2 photo', async () => {
  const h = harness(fixture({ memo: 'Original', photoKey: 'books/book-1/old.png' }));
  h.objects.set('books/book-1/old.png', png);
  const detail = await h.request('/api/books/book-1');
  assert.equal(detail.status, 200);
  assert.equal(detail.body.book.memo, 'Original');
  assert.equal(detail.body.book.photoUrl, '/api/books/book-1/photo');
  const edit = await h.request('/api/books/book-1', 'PUT', { memo: 'Updated' });
  assert.equal(edit.status, 200);
  assert.equal(edit.body.book.memo, 'Updated');
  assert.equal(h.rows.get('book-1').photoKey, 'books/book-1/old.png');
  assert.equal(h.objects.has('books/book-1/old.png'), true);
});

test('editing validates merged fields and rejects malformed input', async () => {
  const h = harness();
  assert.equal((await h.request('/api/books/book-1', 'PUT', { title: '  ' })).status, 400);
  assert.equal((await h.request('/api/books/book-1', 'PUT', { finishedOn: '2023-02-29' })).status, 400);
  assert.equal((await h.request('/api/books/book-1', 'PUT', { photoUrl: 'file:///x' })).status, 400);
  assert.equal((await h.request('/api/books/book-1', 'PUT', [])).status, 400);
  assert.equal(h.rows.get('book-1').title, 'Book');
});

test('URL replacement, photo-only removal, and R2 upload keep one active photo', async () => {
  const h = harness(fixture({ photoKey: 'books/book-1/old.png' }));
  h.objects.set('books/book-1/old.png', png);
  const urlEdit = await h.request('/api/books/book-1', 'PUT', { photoUrl: 'https://example.com/new.jpg' });
  assert.equal(urlEdit.status, 200);
  assert.equal(h.rows.get('book-1').photoKey, null);
  assert.equal(h.objects.has('books/book-1/old.png'), false);
  const upload = await h.request('/api/books/book-1/photo', 'PUT', png);
  assert.equal(upload.status, 200);
  assert.equal(h.rows.get('book-1').photoUrl, null);
  assert.ok(h.rows.get('book-1').photoKey);
  const firstKey = h.rows.get('book-1').photoKey;
  assert.equal((await h.request('/api/books/book-1/photo', 'PUT', png)).status, 200);
  assert.equal(h.objects.has(firstKey), false);
  assert.equal((await h.request('/api/books/book-1/photo')).status, 200);
  const key = h.rows.get('book-1').photoKey;
  const remove = await h.request('/api/books/book-1/photo', 'DELETE');
  assert.equal(remove.status, 200);
  assert.equal(h.rows.get('book-1').photoKey, null);
  assert.equal(h.objects.has(key), false);
  assert.equal(h.rows.has('book-1'), true);
  assert.equal((await h.request('/api/books/book-1', 'PUT', { photoUrl: 'https://example.com/again.jpg' })).status, 200);
  assert.equal((await h.request('/api/books/book-1', 'PUT', { photoUrl: null })).status, 200);
  assert.equal(h.rows.get('book-1').photoUrl, null);
});

test('record deletion removes D1 row and its R2 photo', async () => {
  const h = harness(fixture({ photoKey: 'books/book-1/old.png' }));
  h.objects.set('books/book-1/old.png', png);
  assert.equal((await h.request('/api/books/book-1', 'DELETE')).status, 200);
  assert.equal(h.rows.has('book-1'), false);
  assert.equal(h.objects.size, 0);
});

test('D1 and R2 failures avoid dangling references and report partial cleanup', async () => {
  const h = harness(fixture({ photoKey: 'books/book-1/old.png' }));
  h.objects.set('books/book-1/old.png', png);
  const originalError = console.error;
  console.error = () => {};
  try {
    h.fail.upload = true;
    assert.equal((await h.request('/api/books/book-1/photo', 'PUT', png)).status, 500);
    assert.equal(h.rows.get('book-1').photoKey, 'books/book-1/old.png');
    h.fail.upload = false;
    h.fail.update = true;
    assert.equal((await h.request('/api/books/book-1/photo', 'PUT', png)).status, 500);
    assert.equal(h.objects.size, 1);
    assert.equal((await h.request('/api/books/book-1/photo', 'DELETE')).status, 500);
    assert.equal(h.rows.get('book-1').photoKey, 'books/book-1/old.png');
    h.fail.update = false;
    h.fail.cleanup = true;
    const partial = await h.request('/api/books/book-1', 'PUT', { photoUrl: 'https://example.com/new.jpg' });
    assert.equal(partial.status, 500);
    assert.equal(partial.body.saved, true);
    assert.equal(partial.body.cleanupPending, true);
    assert.equal(h.rows.get('book-1').photoKey, null);
    assert.equal(h.objects.has('books/book-1/old.png'), true);
  } finally {
    console.error = originalError;
  }
});

test('delete failure keeps the record; R2 cleanup failure reports a completed D1 deletion', async () => {
  const h = harness(fixture({ photoKey: 'books/book-1/old.png' }));
  h.objects.set('books/book-1/old.png', png);
  const originalError = console.error;
  console.error = () => {};
  try {
    h.fail.remove = true;
    assert.equal((await h.request('/api/books/book-1', 'DELETE')).status, 500);
    assert.equal(h.rows.has('book-1'), true);
    assert.equal(h.objects.has('books/book-1/old.png'), true);
    h.fail.remove = false;
    h.fail.cleanup = true;
    const partial = await h.request('/api/books/book-1', 'DELETE');
    assert.equal(partial.status, 500);
    assert.equal(partial.body.deleted, true);
    assert.equal(partial.body.cleanupPending, true);
    assert.equal(h.rows.has('book-1'), false);
    assert.equal(h.objects.has('books/book-1/old.png'), true);
  } finally {
    console.error = originalError;
  }
});

test('a concurrent edit is rejected without changing the current record', async () => {
  const h = harness();
  h.fail.conflict = true;
  const response = await h.request('/api/books/book-1', 'PUT', { title: 'Changed' });
  assert.equal(response.status, 409);
  assert.equal(h.rows.get('book-1').title, 'Book');
});
