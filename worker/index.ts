import { createAuth } from "./auth";
import type { AuthBindings } from "./auth";

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

type BookInput = {
  title?: unknown;
  author?: unknown;
  finishedOn?: unknown;
  photoUrl?: unknown;
  memo?: unknown;
};

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

function optionalText(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function jsonResponse(data: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=UTF-8");

  return new Response(JSON.stringify(data), {
    ...init,
    headers,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const photoMatch = /^\/api\/books\/([^/]+)\/photo$/.exec(url.pathname);

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

    if (url.pathname === "/api/books" || photoMatch) {
      const session = await createAuth(env).api.getSession({
        headers: request.headers,
      });

      if (!session) {
        return jsonResponse({ error: "unauthorized" }, { status: 401 });
      }

      if (photoMatch) {
        if (request.method !== "GET" && request.method !== "PUT") {
          return jsonResponse({ error: "method_not_allowed" }, {
            status: 405,
            headers: { Allow: "GET, PUT" },
          });
        }

        const bookId = photoMatch[1];
        const ownerBook = await env.DB.prepare(`
          SELECT photo_key AS photoKey
          FROM books
          WHERE id = ? AND user_id = ?
        `).bind(bookId, session.user.id).first<{ photoKey: string | null }>();

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

        if (request.headers.get("origin") && request.headers.get("origin") !== url.origin) {
          return jsonResponse({ error: "invalid_origin" }, { status: 403 });
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

        const key = `books/${bookId}/${crypto.randomUUID()}.${extension}`;
        await env.BOOK_PHOTOS.put(key, bytes, { httpMetadata: { contentType } });

        try {
          const result = await env.DB.prepare(`
            UPDATE books SET photo_key = ?
            WHERE id = ? AND user_id = ? AND photo_key IS ?
          `).bind(key, bookId, session.user.id, ownerBook.photoKey).run();
          if (result.meta.changes !== 1) {
            await env.BOOK_PHOTOS.delete(key);
            return jsonResponse({ error: "photo_conflict" }, { status: 409 });
          }
        } catch (error) {
          try {
            await env.BOOK_PHOTOS.delete(key);
          } catch (cleanupError) {
            console.error("Failed to remove unreferenced photo", cleanupError);
          }
          console.error("Failed to save photo reference", error);
          return jsonResponse({ error: "photo_save_failed" }, { status: 500 });
        }

        if (ownerBook.photoKey) {
          try {
            await env.BOOK_PHOTOS.delete(ownerBook.photoKey);
          } catch (error) {
            console.error("Failed to remove previous photo", error);
          }
        }
        return jsonResponse({ photoUrl: `${photoPath(bookId)}?v=${crypto.randomUUID()}` });
      }

      if (request.method === "GET") {
        const result = await env.DB.prepare(`
          SELECT
            id,
            title,
            author,
            finished_on AS finishedOn,
            photo_url AS photoUrl,
            photo_key AS photoKey,
            memo,
            created_at AS createdAt
          FROM books
          WHERE user_id = ?
          ORDER BY created_at DESC
        `).bind(session.user.id).all<BookRow>();

        return jsonResponse({
          books: result.results.map(toApiBook),
          persistence: "d1",
        });
      }

      if (request.method === "POST") {
        let input: BookInput;

        try {
          input = (await request.json()) as BookInput;
        } catch {
          return jsonResponse({ error: "invalid_json" }, { status: 400 });
        }

        const book: ApiBook = {
          id: crypto.randomUUID(),
          title: optionalText(input.title),
          author: optionalText(input.author),
          finishedOn: optionalText(input.finishedOn),
          photoUrl: optionalText(input.photoUrl),
          memo: optionalText(input.memo),
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
