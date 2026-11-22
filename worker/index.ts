import { createAuth } from "./auth";
import type { AuthBindings } from "./auth";
import { validateBookInput } from "./book-input";

type AppBindings = AuthBindings & { BOOK_PHOTOS: R2Bucket };

type ApiBook = {
  id: string;
  title: string | null;
  author: string | null;
  finishedOn: string | null;
  photoUrl: string | null;
  memo: string | null;
  createdAt: string;
};

type BookRow = ApiBook & { photoKey: string | null };

const BOOK_COLUMNS = `
  id, title, author, finished_on AS finishedOn,
  photo_url AS photoUrl, photo_key AS photoKey, memo, created_at AS createdAt
`;
const PAGE_SIZE = 20;
const MAX_BOOK_JSON_BYTES = 64 * 1024;

function positiveInteger(value: string | null): number | null {
  if (value === null || !/^[1-9]\d*$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const PHOTO_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

function photoPath(bookId: string) {
  return `/api/books/${encodeURIComponent(bookId)}/photo`;
}

function toApiBook(row: BookRow): ApiBook {
  const { photoKey, ...book } = row;
  return { ...book, photoUrl: photoKey ? photoPath(book.id) : book.photoUrl };
}

function matchesPhotoType(bytes: Uint8Array, contentType: string) {
  if (contentType === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (contentType === "image/png") {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return signature.every((byte, index) => bytes[index] === byte);
  }
  if (contentType === "image/webp") {
    return bytes.length >= 12 &&
      String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
      String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP";
  }
  return false;
}

async function readPhoto(request: Request) {
  if (!request.body) return null;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PHOTO_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (size === 0) return null;
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function jsonResponse(data: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=UTF-8");

  return new Response(JSON.stringify(data), {
    ...init,
    headers,
  });
}

async function readBookJson(request: Request): Promise<
  { ok: true; input: unknown } | { ok: false; response: Response }
> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return { ok: false, response: jsonResponse({
      error: "invalid_json",
      message: "Content-Typeをapplication/jsonにして送信してください。",
    }, { status: 415 }) };
  }

  const tooLarge = () => ({ ok: false as const, response: jsonResponse({
    error: "book_json_too_large",
    message: "書籍データは64 KiB以下で送信してください。",
  }, { status: 413 }) });
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && /^\d+$/.test(contentLength) &&
    Number(contentLength) > MAX_BOOK_JSON_BYTES) return tooLarge();

  try {
    const reader = request.body?.getReader();
    if (!reader) throw new Error("Missing JSON body");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.byteLength > MAX_BOOK_JSON_BYTES - size) {
          await reader.cancel().catch(() => {});
          return tooLarge();
        }
        size += value.byteLength;
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { ok: true, input: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { ok: false, response: jsonResponse({
      error: "invalid_json",
      message: "正しいJSON形式で送信してください。",
    }, { status: 400 }) };
  }
}

async function findOwnedBook(db: D1Database, bookId: string, userId: string) {
  return db.prepare(`
    SELECT id, title, author, finished_on AS finishedOn,
      photo_url AS photoUrl, photo_key AS photoKey, memo, created_at AS createdAt
    FROM books
    WHERE id = ? AND user_id = ?
  `).bind(bookId, userId).first<BookRow>();
}

function invalidOrigin(request: Request, origin: string) {
  return Boolean(request.headers.get("origin") && request.headers.get("origin") !== origin);
}

function photoCleanupFailed(book: ApiBook | null, removed: boolean) {
  return jsonResponse({
    error: "photo_cleanup_failed",
    message: removed
      ? "読書記録は削除されましたが、写真の削除が完了していません。"
      : "変更は保存されましたが、古い写真の削除が完了していません。",
    cleanupPending: true,
    ...(removed ? { deleted: true } : { saved: true }),
    ...(book ? { book } : {}),
  }, { status: 500 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const photoMatch = /^\/api\/books\/([^/]+)\/photo$/.exec(url.pathname);
    const bookMatch = /^\/api\/books\/([^/]+)$/.exec(url.pathname);

    if (url.pathname === "/api/auth" || url.pathname.startsWith("/api/auth/")) {
      return createAuth(env).handler(request);
    }

    if (url.pathname === "/api/health" && request.method === "GET") {
      const result = await env.DB.prepare("SELECT 1 AS ok").first();

      return jsonResponse({
        app: "book-list",
        status: "ok",
        runtime: "cloudflare-workers",
        database: result,
      });
    }

    if (url.pathname === "/api/books" || url.pathname === "/api/books/home" || photoMatch || bookMatch) {
      const session = await createAuth(env).api.getSession({
        headers: request.headers,
      });

      if (!session) {
        return jsonResponse({ error: "unauthorized" }, { status: 401 });
      }

      if (url.pathname === "/api/books/home") {
        if (request.method !== "GET") {
          return jsonResponse({ error: "method_not_allowed" }, {
            status: 405, headers: { Allow: "GET" },
          });
        }

        const year = Number(new Intl.DateTimeFormat("en-US", {
          year: "numeric", timeZone: "Asia/Tokyo",
        }).format(new Date()));
        const counts = await env.DB.prepare(`
          SELECT COUNT(*) AS totalCount,
            COUNT(CASE WHEN finished_on >= ? AND finished_on < ? THEN 1 END) AS finishedThisYear
          FROM books WHERE user_id = ?
        `).bind(`${year}-01-01`, `${year + 1}-01-01`, session.user.id)
          .first<{ totalCount: number; finishedThisYear: number }>();
        const latest = await env.DB.prepare(`
          SELECT ${BOOK_COLUMNS} FROM books
          WHERE user_id = ?
          ORDER BY created_at DESC, id DESC
          LIMIT 5
        `).bind(session.user.id).all<BookRow>();

        return jsonResponse({
          totalCount: counts?.totalCount ?? 0,
          finishedThisYear: counts?.finishedThisYear ?? 0,
          books: latest.results.map(toApiBook),
          persistence: "d1",
        });
      }

      if (photoMatch) {
        if (request.method !== "GET" && request.method !== "PUT" && request.method !== "DELETE") {
          return jsonResponse({ error: "method_not_allowed" }, {
            status: 405,
            headers: { Allow: "GET, PUT, DELETE" },
          });
        }

        const bookId = photoMatch[1];
        const ownerBook = await findOwnedBook(env.DB, bookId, session.user.id);

        if (!ownerBook) {
          return jsonResponse({ error: "not_found" }, { status: 404 });
        }

        if (request.method === "GET") {
          if (!ownerBook.photoKey) {
            return jsonResponse({ error: "not_found" }, { status: 404 });
          }
          const object = await env.BOOK_PHOTOS.get(ownerBook.photoKey);
          if (!object) {
            return jsonResponse({ error: "not_found" }, { status: 404 });
          }
          const headers = new Headers({
            "x-content-type-options": "nosniff",
          });
          object.writeHttpMetadata(headers);
          headers.set("cache-control", "private, no-store");
          return new Response(object.body, { headers });
        }

        if (invalidOrigin(request, url.origin)) {
          return jsonResponse({ error: "invalid_origin" }, { status: 403 });
        }
        if (request.method === "DELETE") {
          if (!ownerBook.photoKey && !ownerBook.photoUrl) {
            return jsonResponse({ photoUrl: null });
          }
          const validBook = validateBookInput({
            title: ownerBook.title,
            author: ownerBook.author,
            finishedOn: ownerBook.finishedOn,
            memo: ownerBook.memo,
          });
          if (!validBook.ok) return jsonResponse(validBook, { status: 400 });

          let result: D1Result;
          try {
            result = await env.DB.prepare(`
              UPDATE books SET photo_url = NULL, photo_key = NULL
              WHERE id = ? AND user_id = ? AND photo_url IS ? AND photo_key IS ?
            `).bind(bookId, session.user.id, ownerBook.photoUrl, ownerBook.photoKey).run();
          } catch (error) {
            console.error("Failed to remove book photo reference", error);
            return jsonResponse({ error: "photo_save_failed", message: "写真を削除できませんでした。" }, { status: 500 });
          }
          if (result.meta.changes !== 1) {
            return jsonResponse({ error: "book_conflict", message: "記録が更新されました。読み込み直して再試行してください。" }, { status: 409 });
          }
          const updated = toApiBook({ ...ownerBook, photoUrl: null, photoKey: null });
          if (ownerBook.photoKey) {
            try {
              await env.BOOK_PHOTOS.delete(ownerBook.photoKey);
            } catch (error) {
              console.error("Failed to remove book photo", ownerBook.photoKey, error);
              return photoCleanupFailed(updated, false);
            }
          }
          return jsonResponse({ photoUrl: null, book: updated });
        }

        const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
        const extension = PHOTO_EXTENSIONS[contentType];
        if (!extension) {
          return jsonResponse({ error: "unsupported_photo_type" }, { status: 415 });
        }
        const contentLength = request.headers.get("content-length");
        if (contentLength && Number(contentLength) > MAX_PHOTO_BYTES) {
          return jsonResponse({ error: "photo_too_large" }, { status: 413 });
        }
        const bytes = await readPhoto(request);
        if (!bytes) {
          return jsonResponse({ error: "invalid_photo_size" }, { status: 413 });
        }
        if (!matchesPhotoType(bytes, contentType)) {
          return jsonResponse({ error: "invalid_photo" }, { status: 415 });
        }

        const validBook = validateBookInput({
          title: ownerBook.title,
          author: ownerBook.author,
          finishedOn: ownerBook.finishedOn,
          memo: ownerBook.memo,
        });
        if (!validBook.ok) return jsonResponse(validBook, { status: 400 });

        const key = `books/${bookId}/${crypto.randomUUID()}.${extension}`;
        try {
          await env.BOOK_PHOTOS.put(key, bytes, { httpMetadata: { contentType } });
        } catch (error) {
          console.error("Failed to upload book photo", error);
          return jsonResponse({ error: "photo_upload_failed", message: "写真を保存できませんでした。" }, { status: 500 });
        }

        let result: D1Result;
        try {
          result = await env.DB.prepare(`
            UPDATE books SET photo_key = ?, photo_url = NULL
            WHERE id = ? AND user_id = ? AND photo_key IS ? AND photo_url IS ?
          `).bind(key, bookId, session.user.id, ownerBook.photoKey, ownerBook.photoUrl).run();
        } catch (error) {
          try {
            await env.BOOK_PHOTOS.delete(key);
          } catch (cleanupError) {
            console.error("Failed to remove unreferenced photo", key, cleanupError);
            return jsonResponse({ error: "photo_cleanup_failed", message: "写真の保存に失敗し、アップロード済みファイルの削除も完了していません。", cleanupPending: true }, { status: 500 });
          }
          console.error("Failed to save photo reference", error);
          return jsonResponse({ error: "photo_save_failed" }, { status: 500 });
        }
        if (result.meta.changes !== 1) {
          try {
            await env.BOOK_PHOTOS.delete(key);
          } catch (error) {
            console.error("Failed to remove conflicting photo", key, error);
            return jsonResponse({ error: "photo_cleanup_failed", message: "写真の競合後、アップロード済みファイルの削除が完了していません。", cleanupPending: true }, { status: 500 });
          }
          return jsonResponse({ error: "photo_conflict", message: "写真が更新されました。読み込み直して再試行してください。" }, { status: 409 });
        }

        if (ownerBook.photoKey) {
          try {
            await env.BOOK_PHOTOS.delete(ownerBook.photoKey);
          } catch (error) {
            console.error("Failed to remove previous photo", ownerBook.photoKey, error);
            return photoCleanupFailed(toApiBook({ ...ownerBook, photoUrl: null, photoKey: key }), false);
          }
        }
        return jsonResponse({ photoUrl: `${photoPath(bookId)}?v=${crypto.randomUUID()}` });
      }

      if (bookMatch) {
        if (request.method !== "GET" && request.method !== "PUT" && request.method !== "DELETE") {
          return jsonResponse({ error: "method_not_allowed" }, {
            status: 405,
            headers: { Allow: "GET, PUT, DELETE" },
          });
        }

        const bookId = bookMatch[1];
        const ownerBook = await findOwnedBook(env.DB, bookId, session.user.id);
        if (!ownerBook) {
          return jsonResponse({ error: "not_found" }, { status: 404 });
        }
        if (request.method === "GET") {
          return jsonResponse({ book: toApiBook(ownerBook), persistence: "d1" });
        }
        if (invalidOrigin(request, url.origin)) {
          return jsonResponse({ error: "invalid_origin" }, { status: 403 });
        }

        if (request.method === "DELETE") {
          let result: D1Result;
          try {
            result = await env.DB.prepare(`
              DELETE FROM books
              WHERE id = ? AND user_id = ?
                AND title IS ? AND author IS ? AND finished_on IS ?
                AND photo_url IS ? AND photo_key IS ? AND memo IS ?
            `).bind(
              bookId, session.user.id, ownerBook.title, ownerBook.author,
              ownerBook.finishedOn, ownerBook.photoUrl, ownerBook.photoKey, ownerBook.memo,
            ).run();
          } catch (error) {
            console.error("Failed to delete book", error);
            return jsonResponse({ error: "book_delete_failed", message: "読書記録を削除できませんでした。" }, { status: 500 });
          }
          if (result.meta.changes !== 1) {
            return jsonResponse({ error: "book_conflict", message: "記録が更新されました。読み込み直して再試行してください。" }, { status: 409 });
          }
          if (ownerBook.photoKey) {
            try {
              await env.BOOK_PHOTOS.delete(ownerBook.photoKey);
            } catch (error) {
              console.error("Failed to remove deleted book photo", ownerBook.photoKey, error);
              return photoCleanupFailed(null, true);
            }
          }
          return jsonResponse({ deleted: true });
        }

        const parsed = await readBookJson(request);
        if (!parsed.ok) return parsed.response;
        if (parsed.input === null || typeof parsed.input !== "object" || Array.isArray(parsed.input)) {
          return jsonResponse(validateBookInput(parsed.input), { status: 400 });
        }
        const changes = parsed.input as Record<string, unknown>;
        const validated = validateBookInput({
          title: ownerBook.title,
          author: ownerBook.author,
          finishedOn: ownerBook.finishedOn,
          photoUrl: ownerBook.photoUrl,
          memo: ownerBook.memo,
          ...changes,
        });
        if (!validated.ok) return jsonResponse(validated, { status: 400 });

        // Omission keeps the current photo; null or an empty string removes it; a URL replaces it.
        const photoChanged = Object.prototype.hasOwnProperty.call(changes, "photoUrl");
        const updated: BookRow = {
          ...ownerBook,
          ...validated.value,
          photoKey: photoChanged ? null : ownerBook.photoKey,
        };
        let result: D1Result;
        try {
          result = await env.DB.prepare(`
            UPDATE books SET title = ?, author = ?, finished_on = ?,
              photo_url = ?, photo_key = ?, memo = ?
            WHERE id = ? AND user_id = ?
              AND title IS ? AND author IS ? AND finished_on IS ?
              AND photo_url IS ? AND photo_key IS ? AND memo IS ?
          `).bind(
            updated.title, updated.author, updated.finishedOn,
            updated.photoUrl, updated.photoKey, updated.memo,
            bookId, session.user.id,
            ownerBook.title, ownerBook.author, ownerBook.finishedOn,
            ownerBook.photoUrl, ownerBook.photoKey, ownerBook.memo,
          ).run();
        } catch (error) {
          console.error("Failed to update book", error);
          return jsonResponse({ error: "book_save_failed", message: "読書記録を保存できませんでした。" }, { status: 500 });
        }
        if (result.meta.changes !== 1) {
          return jsonResponse({ error: "book_conflict", message: "記録が更新されました。読み込み直して再試行してください。" }, { status: 409 });
        }
        const book = toApiBook(updated);
        if (photoChanged && ownerBook.photoKey) {
          try {
            await env.BOOK_PHOTOS.delete(ownerBook.photoKey);
          } catch (error) {
            console.error("Failed to remove previous book photo", ownerBook.photoKey, error);
            return photoCleanupFailed(book, false);
          }
        }
        return jsonResponse({ book, persistence: "d1" });
      }

      if (request.method === "GET") {
        const params = url.searchParams;
        if (params.has("page") || params.has("limit")) {
          const page = positiveInteger(params.get("page") ?? "1");
          const limit = positiveInteger(params.get("limit") ?? String(PAGE_SIZE));
          if (params.getAll("page").length > 1 || params.getAll("limit").length > 1 ||
            page === null || limit === null || limit > PAGE_SIZE) {
            return jsonResponse({
              error: "invalid_pagination",
              message: "ページ番号は1以上の整数、取得件数は1〜20の整数で指定してください。",
            }, { status: 400 });
          }

          const count = await env.DB.prepare(
            "SELECT COUNT(*) AS totalCount FROM books WHERE user_id = ?",
          ).bind(session.user.id).first<{ totalCount: number }>();
          const totalCount = count?.totalCount ?? 0;
          const totalPages = Math.max(1, Math.ceil(totalCount / limit));
          if (page > totalPages) {
            return jsonResponse({
              error: "page_out_of_range",
              message: "指定されたページは存在しません。",
              totalCount,
              totalPages,
            }, { status: 400 });
          }

          const result = await env.DB.prepare(`
            SELECT ${BOOK_COLUMNS} FROM books
            WHERE user_id = ?
            ORDER BY created_at DESC, id DESC
            LIMIT ? OFFSET ?
          `).bind(session.user.id, limit, (page - 1) * limit).all<BookRow>();
          return jsonResponse({
            books: result.results.map(toApiBook),
            page,
            limit,
            totalCount,
            totalPages,
            persistence: "d1",
          });
        }

        const result = await env.DB.prepare(`
          SELECT ${BOOK_COLUMNS}
          FROM books
          WHERE user_id = ?
          ORDER BY created_at DESC, id DESC
        `).bind(session.user.id).all<BookRow>();

        return jsonResponse({
          books: result.results.map(toApiBook),
          persistence: "d1",
        });
      }

      if (request.method === "POST") {
        const parsed = await readBookJson(request);
        if (!parsed.ok) return parsed.response;
        const validated = validateBookInput(parsed.input);
        if (!validated.ok) {
          return jsonResponse(validated, { status: 400 });
        }

        const book: ApiBook = {
          id: crypto.randomUUID(),
          ...validated.value,
          createdAt: new Date().toISOString(),
        };

        await env.DB.prepare(
          `
            INSERT INTO books (
              id,
              user_id,
              title,
              author,
              finished_on,
              photo_url,
              memo,
              created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `,
        ).bind(
          book.id,
          session.user.id,
          book.title,
          book.author,
          book.finishedOn,
          book.photoUrl,
          book.memo,
          book.createdAt,
        ).run();

        return jsonResponse(
          {
            book,
            persistence: "d1",
          },
          { status: 201 },
        );
      }
    }

    if (url.pathname.startsWith("/api/")) {
      return jsonResponse({ error: "not_found" }, { status: 404 });
    }

    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<AppBindings>;
