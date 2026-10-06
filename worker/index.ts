type ApiBook = {
  id: string;
  title: string | null;
  author: string | null;
  finishedOn: string | null;
  photoUrl: string | null;
  memo: string | null;
  createdAt: string;
};

function jsonResponse(data: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=UTF-8");

  return new Response(JSON.stringify(data), {
    ...init,
    headers,
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health" && request.method === "GET") {
      return jsonResponse({
        app: "book-list",
        status: "ok",
        runtime: "cloudflare-workers",
      });
    }

    if (url.pathname === "/api/books" && request.method === "GET") {
      const books: ApiBook[] = [];

      return jsonResponse({
        books,
        persistence: "not-configured",
      });
    }

    if (url.pathname === "/api/books" && request.method === "POST") {
      return jsonResponse(
        {
          error: "persistence_not_configured",
          message: "D1と認証の実装後に保存APIを有効化します。",
        },
        { status: 501 },
      );
    }

    if (url.pathname.startsWith("/api/")) {
      return jsonResponse({ error: "not_found" }, { status: 404 });
    }

    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler;
