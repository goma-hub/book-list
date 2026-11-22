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
  const insert = sqlite.prepare(`INSERT INTO books
    (id, user_id, title, author, finished_on, photo_url, photo_key, memo, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const book of Array.isArray(initial) ? initial : [initial]) {
    insert.run(book.id, book.userId, book.title, book.author, book.finishedOn,
      book.photoUrl, book.photoKey, book.memo, book.createdAt);
  }
  const rows = {
    get(id) {
      return sqlite.prepare(`SELECT id, user_id AS userId, title, author,
        finished_on AS finishedOn, photo_url AS photoUrl, photo_key AS photoKey,
        memo, created_at AS createdAt FROM books WHERE id = ?`).get(id);
    },
    has(id) { return Boolean(this.get(id)); },
  };
  const objects = new Map();
  const queries = [];
  const fail = { update: false, remove: false, upload: false, cleanup: false, conflict: false };

  const DB = {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      return {
        bind(...params) {
          queries.push({ sql, params });
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

  async function request(path, method = 'GET', body, user = 'owner', options = {}) {
    const headers = new Headers(options.headers);
    if (user) headers.set('x-test-user', user);
    if (body !== undefined) headers.set('content-type', body instanceof Uint8Array ? 'image/png' : 'application/json');
    const request = new Request(`http://localhost${path}`, {
      method, headers,
      ...(body === undefined ? {} : { body: body instanceof Uint8Array || options.raw ? body : JSON.stringify(body) }),
      ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
    });
    const response = await worker.fetch(request, env);
    return {
      status: response.status,
      body: response.headers.get('content-type')?.startsWith('application/json') ? await response.json() : null,
    };
  }

  return { rows, objects, queries, fail, request };
}

function books(count, overrides = {}) {
  return Array.from({ length: count }, (_, index) => fixture({
    id: `book-${String(index + 1).padStart(3, '0')}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }));
}

test('home returns owned counts and only the latest five records', async () => {
  const year = Number(new Intl.DateTimeFormat('en-US', {
    year: 'numeric', timeZone: 'Asia/Tokyo',
  }).format(new Date()));
  const h = harness([
    ...books(7).map((book, index) => ({
      ...book,
      createdAt: new Date(Date.UTC(year, 5, 1)).toISOString(),
      finishedOn: index < 3 ? `${year}-04-01` : index === 3 ? `${year - 1}-12-31` : null,
      ...(index === 6 ? { photoKey: 'books/book-007/cover.png' } : {}),
    })),
    fixture({ id: 'other-book', userId: 'other', finishedOn: `${year}-02-01` }),
  ]);
  assert.equal((await h.request('/api/books/home', 'GET', undefined, null)).status, 401);
  const home = await h.request('/api/books/home');
  assert.equal(home.status, 200);
  assert.equal(home.body.totalCount, 7);
  assert.equal(home.body.finishedThisYear, 6);
  assert.deepEqual(home.body.books.map((book) => book.id),
    ['book-007', 'book-006', 'book-005', 'book-004', 'book-003']);
  assert.equal(home.body.books[0].photoUrl, '/api/books/book-007/photo');
  assert.equal((await h.request('/api/books/home', 'GET', undefined, 'other')).body.totalCount, 1);
  assert.ok(h.queries.some(({ sql }) => sql.includes('COUNT(CASE WHEN') && sql.includes("NULLIF(TRIM(finished_on), '')")));
  assert.ok(h.queries.some(({ sql }) => sql.includes('LIMIT 5')));
  assert.equal((await h.request('/api/books/home', 'POST')).status, 405);
});

test('home uses the finished year first and falls back to Tokyo registration year only for missing dates', async () => {
  const year = Number(new Intl.DateTimeFormat('en-US', {
    year: 'numeric', timeZone: 'Asia/Tokyo',
  }).format(new Date()));
  const start = Date.UTC(year, 0, 1) - 9 * 60 * 60 * 1000;
  const end = Date.UTC(year + 1, 0, 1) - 9 * 60 * 60 * 1000;
  const old = new Date(start - 1).toISOString();
  const current = new Date(start).toISOString();
  const h = harness([
    fixture({ id: 'year', finishedOn: `${year}`, createdAt: old }),
    fixture({ id: 'month', finishedOn: `${year}-01`, createdAt: old }),
    fixture({ id: 'day', finishedOn: `${year}-12-31`, createdAt: old }),
    fixture({ id: 'previous', finishedOn: `${year - 1}-12-31`, createdAt: current }),
    fixture({ id: 'missing-start', finishedOn: null, createdAt: current }),
    fixture({ id: 'missing-end', finishedOn: '', createdAt: new Date(end - 1).toISOString() }),
    fixture({ id: 'before-start', finishedOn: null, createdAt: old }),
    fixture({ id: 'at-end', finishedOn: null, createdAt: new Date(end).toISOString() }),
    fixture({ id: 'next-year', finishedOn: `${year + 1}`, createdAt: current }),
    fixture({ id: 'other-user', userId: 'other', finishedOn: `${year}`, createdAt: current }),
  ]);
  const home = await h.request('/api/books/home');
  assert.equal(home.status, 200);
  assert.equal(home.body.totalCount, 9);
  assert.equal(home.body.finishedThisYear, 5);
  assert.equal((await h.request('/api/books/home', 'GET', undefined, 'other')).body.finishedThisYear, 1);
  assert.equal((await h.request('/api/books/missing-end')).body.book.finishedOn, '');
});

test('page lookup fetches only the requested twenty with stable order and owner counts', async () => {
  const h = harness([...books(80), fixture({ id: 'other-book', userId: 'other' })]);
  assert.equal((await h.request('/api/books?page=3&limit=20', 'GET', undefined, null)).status, 401);
  const third = await h.request('/api/books?page=3&limit=20');
  assert.equal(third.status, 200);
  assert.deepEqual(
    [third.body.page, third.body.limit, third.body.totalCount, third.body.totalPages],
    [3, 20, 80, 4],
  );
  assert.deepEqual(third.body.books.map((book) => book.id),
    books(80).reverse().slice(40, 60).map((book) => book.id));
  const listQuery = h.queries.find(({ sql }) => sql.includes('LIMIT ? OFFSET ?'));
  assert.deepEqual(listQuery.params, ['owner', 20, 40]);
  assert.match(listQuery.sql, /ORDER BY created_at DESC, id DESC/);
  assert.equal((await h.request('/api/books?page=1')).body.books[0].id, 'book-080');
  assert.equal((await h.request('/api/books?page=4')).body.books.length, 20);
  assert.equal((await h.request('/api/books?page=1', 'GET', undefined, 'other')).body.totalCount, 1);
});

test('empty, boundary, and deleted final pages report usable page counts', async () => {
  for (const [count, pages, lastCount] of [[0, 1, 0], [20, 1, 20], [21, 2, 1]]) {
    const h = harness(books(count));
    const response = await h.request(`/api/books?page=${pages}`);
    assert.equal(response.status, 200);
    assert.equal(response.body.totalCount, count);
    assert.equal(response.body.totalPages, pages);
    assert.equal(response.body.books.length, lastCount);
    assert.equal((await h.request(`/api/books?page=${pages + 1}`)).body.totalPages, pages);
    if (count === 21) {
      assert.equal((await h.request('/api/books/book-001', 'DELETE')).status, 200);
      const gone = await h.request('/api/books?page=2');
      assert.equal(gone.status, 400);
      assert.equal(gone.body.error, 'page_out_of_range');
      assert.equal(gone.body.totalPages, 1);
    }
  }
});

test('invalid pagination is rejected before a row query', async () => {
  const h = harness(books(2));
  for (const query of [
    'page=0', 'page=-1', 'page=1.5', 'page=abc', 'page=1e2', 'page=',
    'page=99999999999999999999', 'page=2', 'page=1&page=2',
    'limit=0', 'limit=21', 'limit=abc', 'limit=1&limit=20',
  ]) {
    assert.equal((await h.request(`/api/books?${query}`)).status, 400, query);
  }
  assert.equal(h.queries.filter(({ sql }) => sql.includes('LIMIT ? OFFSET ?')).length, 0);
  const smaller = await h.request('/api/books?limit=1');
  assert.equal(smaller.body.totalPages, 2);
  assert.equal(smaller.body.books.length, 1);
});

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

test('finished dates retain their entered precision through create, edit, detail and list', async () => {
  const h = harness();
  for (const finishedOn of ['0001', '2024-02', '2024-02-29']) {
    const create = await h.request('/api/books', 'POST', { title: 'Dated book', finishedOn });
    assert.equal(create.status, 201);
    assert.equal(create.body.book.finishedOn, finishedOn);
    const id = create.body.book.id;
    assert.equal((await h.request(`/api/books/${id}`)).body.book.finishedOn, finishedOn);
    assert.equal((await h.request(`/api/books/${id}`, 'PUT', { memo: 'Edited' })).body.book.finishedOn, finishedOn);
    assert.equal((await h.request('/api/books')).body.books.find((book) => book.id === id).finishedOn, finishedOn);
  }
  const id = (await h.request('/api/books')).body.books[0].id;
  const edit = await h.request(`/api/books/${id}`, 'PUT', { finishedOn: '2026-01' });
  assert.equal(edit.status, 200);
  assert.equal(edit.body.book.finishedOn, '2026-01');
});

test('finished dates reject invalid precision, calendar dates and leap days on create and edit', async () => {
  const h = harness();
  for (const finishedOn of [
    '0000', '202', '2026-1', '2026-001', '2026-00', '2026-13',
    '2026-02-29', '2024-02-30', '2026-04-31', '2026-01-1',
    '2026-01-00', '2026-01-32', '2026/01', '2026-01-01T00:00:00Z',
  ]) {
    const create = await h.request('/api/books', 'POST', { title: 'Dated book', finishedOn });
    const edit = await h.request('/api/books/book-1', 'PUT', { finishedOn });
    assert.equal(create.status, 400, finishedOn);
    assert.equal(edit.status, 400, finishedOn);
    assert.equal(create.body.field, 'finishedOn');
    assert.equal(edit.body.field, 'finishedOn');
    const message = '読了日は半角数字で入力し、年月の区切りにはハイフン（-）を使ってください。実際に存在する日付を入力してください。';
    assert.equal(create.body.message, message);
    assert.equal(edit.body.message, message);
  }
  assert.equal(h.rows.get('book-1').finishedOn, null);
});

test('book JSON enforces the byte limit for POST and PUT regardless of Content-Length', async () => {
  const h = harness();
  const limit = 64 * 1024;
  const padded = (value, bytes) => {
    const json = JSON.stringify(value);
    assert.ok(Buffer.byteLength(json) <= bytes);
    return json + ' '.repeat(bytes - Buffer.byteLength(json));
  };

  assert.equal((await h.request('/api/books', 'POST', padded({ title: 'Within limit' }, limit), 'owner', { raw: true })).status, 201);
  const oversizedPost = await h.request('/api/books', 'POST', padded({ title: 'Too large' }, limit + 1), 'owner', { raw: true });
  assert.equal(oversizedPost.status, 413);
  assert.equal(oversizedPost.body.error, 'book_json_too_large');
  assert.equal((await h.request('/api/books')).body.books.length, 2);

  assert.equal((await h.request('/api/books/book-1', 'PUT', padded({ memo: 'Updated' }, limit), 'owner', { raw: true })).status, 200);
  const oversizedPut = await h.request('/api/books/book-1', 'PUT', padded({ memo: 'Rejected' }, limit + 1), 'owner', {
    raw: true, headers: { 'content-length': '10' },
  });
  assert.equal(oversizedPut.status, 413);
  assert.equal(oversizedPut.body.error, 'book_json_too_large');
  assert.equal(h.rows.get('book-1').memo, 'Updated');

  const declaredOversize = await h.request('/api/books/book-1', 'PUT', { memo: 'Rejected' }, 'owner', {
    headers: { 'content-length': String(limit + 1) },
  });
  assert.equal(declaredOversize.status, 413);
  assert.equal(h.rows.get('book-1').memo, 'Updated');
  assert.equal((await h.request('/api/books/book-1', 'PUT', '{', 'owner', { raw: true })).status, 400);

  let pulls = 0;
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new Uint8Array(pulls <= 2 ? limit / 2 : 1));
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const streamedOversize = await h.request('/api/books', 'POST', stream, 'owner', { raw: true });
  assert.equal(streamedOversize.status, 413);
  assert.equal(pulls, 3);
  assert.equal(cancelled, true);
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
    assert.equal(partial.body.message, '変更は保存されましたが、古い写真の削除が完了していません。');
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
    assert.equal(partial.body.message, '読書記録は削除されましたが、写真の削除が完了していません。');
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
