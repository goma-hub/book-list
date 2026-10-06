type ApiBook = {
  id: string;
  title: string | null;
  author: string | null;
  finishedOn: string | null;
  photoUrl: string | null;
  memo: string | null;
  createdAt: string;
};

type BookInput = {
  title?: unknown;
  author?: unknown;
  finishedOn?: unknown;
  photoUrl?: unknown;
  memo?: unknown;
};

const DEV_USER_ID = "dev-user";

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

    if (url.pathname === "/api/health" && request.method === "GET") {
      const result = await env.DB.prepare("SELECT 1 AS ok").first();

      return jsonResponse({
        app: "book-list",
        status: "ok",
        runtime: "cloudflare-workers",
        database: result,
      });
    }

    if (url.pathname === "/api/books" && request.method === "GET") {
      const result = await env.DB.prepare(`
        SELECT
          id,
          title,
          author,
          finished_on AS finishedOn,
          photo_url AS photoUrl,
          memo,
          created_at AS createdAt
        FROM books
        ORDER BY created_at DESC
      `).all<ApiBook>();

      return jsonResponse({
        books: result.results,
        persistence: "d1",
      });
    }

    if (url.pathname === "/api/books" && request.method === "POST") {
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

      await env.DB.batch([
        env.DB.prepare(
          `
            INSERT OR IGNORE INTO users (id, email, password_hash, created_at)
            VALUES (?, ?, ?, ?)
          `,
        ).bind(DEV_USER_ID, "dev-user@example.invalid", "dev-password-placeholder", book.createdAt),
        env.DB.prepare(
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
          DEV_USER_ID,
          book.title,
          book.author,
          book.finishedOn,
          book.photoUrl,
          book.memo,
          book.createdAt,
        ),
      ]);

      return jsonResponse(
        {
          book,
          persistence: "d1",
        },
        { status: 201 },
      );
    }

    if (url.pathname.startsWith("/api/")) {
      return jsonResponse({ error: "not_found" }, { status: 404 });
    }

    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
