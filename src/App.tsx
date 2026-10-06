import type { FormEvent } from "react";
import { useEffect, useMemo, useState } from "react";
import "./App.css";

type ApiHealth = {
  app: string;
  status: "ok";
  runtime: string;
};

type ApiBooksResponse = {
  books: BookRecord[];
  persistence: "not-configured";
};

type BookRecord = {
  id: string;
  title: string | null;
  author: string | null;
  finishedOn: string | null;
  photoUrl: string | null;
  memo: string | null;
  createdAt: string;
};

type BookForm = {
  title: string;
  author: string;
  finishedOn: string;
  photoUrl: string;
  memo: string;
};

const initialForm: BookForm = {
  title: "",
  author: "",
  finishedOn: "",
  photoUrl: "",
  memo: "",
};

function optionalText(value: string) {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function App() {
  const [apiHealth, setApiHealth] = useState<ApiHealth | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const [serverBooks, setServerBooks] = useState<BookRecord[]>([]);
  const [form, setForm] = useState<BookForm>(initialForm);
  const [draftBooks, setDraftBooks] = useState<BookRecord[]>([]);

  useEffect(() => {
    let ignore = false;

    async function loadApiStatus() {
      try {
        const [healthResponse, booksResponse] = await Promise.all([
          fetch("/api/health"),
          fetch("/api/books"),
        ]);

        if (!healthResponse.ok || !booksResponse.ok) {
          throw new Error("Worker APIから正常な応答がありませんでした。");
        }

        const health = (await healthResponse.json()) as ApiHealth;
        const books = (await booksResponse.json()) as ApiBooksResponse;

        if (!ignore) {
          setApiHealth(health);
          setServerBooks(books.books);
          setApiError(null);
        }
      } catch (error) {
        if (!ignore) {
          setApiHealth(null);
          setApiError(error instanceof Error ? error.message : "API接続に失敗しました。");
        }
      }
    }

    void loadApiStatus();

    return () => {
      ignore = true;
    };
  }, []);

  const visibleBooks = useMemo(
    () => [...draftBooks, ...serverBooks],
    [draftBooks, serverBooks],
  );

  function updateForm(field: keyof BookForm, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const nextBook: BookRecord = {
      id: crypto.randomUUID(),
      title: optionalText(form.title),
      author: optionalText(form.author),
      finishedOn: optionalText(form.finishedOn),
      photoUrl: optionalText(form.photoUrl),
      memo: optionalText(form.memo),
      createdAt: new Date().toISOString(),
    };

    setDraftBooks((current) => [nextBook, ...current]);
    setForm(initialForm);
  }

  return (
    <main className="app-shell">
      <section className="workspace">
        <aside className="sidebar" aria-label="アプリ情報">
          <div>
            <p className="eyebrow">Book List</p>
            <h1>読書記録</h1>
          </div>

          <dl className="status-list">
            <div>
              <dt>Worker API</dt>
              <dd className={apiHealth ? "status-ok" : "status-waiting"}>
                {apiHealth ? "接続済み" : apiError ? "確認失敗" : "確認中"}
              </dd>
            </div>
            <div>
              <dt>保存先</dt>
              <dd>D1 未接続</dd>
            </div>
            <div>
              <dt>認証</dt>
              <dd>未実装</dd>
            </div>
          </dl>

          {apiError ? <p className="notice">{apiError}</p> : null}
        </aside>

        <section className="content-grid">
          <form className="panel entry-form" onSubmit={handleSubmit}>
            <div className="panel-header">
              <div>
                <p className="eyebrow">New Record</p>
                <h2>読書記録を追加</h2>
              </div>
              <span className="pill">任意入力</span>
            </div>

            <label>
              <span>本のタイトル</span>
              <input
                value={form.title}
                onChange={(event) => updateForm("title", event.target.value)}
                placeholder="例: 銀河鉄道の夜"
              />
            </label>

            <label>
              <span>作者名</span>
              <input
                value={form.author}
                onChange={(event) => updateForm("author", event.target.value)}
                placeholder="例: 宮沢賢治"
              />
            </label>

            <div className="form-row">
              <label>
                <span>読了日</span>
                <input
                  type="date"
                  value={form.finishedOn}
                  onChange={(event) => updateForm("finishedOn", event.target.value)}
                />
              </label>

              <label>
                <span>本の写真URL</span>
                <input
                  type="url"
                  value={form.photoUrl}
                  onChange={(event) => updateForm("photoUrl", event.target.value)}
                  placeholder="https://example.com/book.jpg"
                />
              </label>
            </div>

            <label>
              <span>メモ</span>
              <textarea
                value={form.memo}
                onChange={(event) => updateForm("memo", event.target.value)}
                placeholder="感想やあらすじのメモ"
                rows={5}
              />
            </label>

            <button type="submit">追加</button>
          </form>

          <section className="panel records-panel" aria-labelledby="records-title">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Records</p>
                <h2 id="records-title">読書リスト</h2>
              </div>
              <span className="counter">{visibleBooks.length}件</span>
            </div>

            {visibleBooks.length === 0 ? (
              <div className="empty-state">
                <h3>まだ記録はありません</h3>
                <p>タイトルや作者が不明でも、この画面から読書記録を追加できます。</p>
              </div>
            ) : (
              <ul className="record-list">
                {visibleBooks.map((book) => (
                  <li key={book.id}>
                    {book.photoUrl ? (
                      <img src={book.photoUrl} alt="" loading="lazy" />
                    ) : (
                      <div className="cover-placeholder">No Image</div>
                    )}
                    <div>
                      <h3>{book.title ?? "タイトル未入力"}</h3>
                      <p>{book.author ?? "作者未入力"}</p>
                      <time dateTime={book.createdAt}>
                        {book.finishedOn ?? "読了日未入力"}
                      </time>
                      {book.memo ? <p className="memo">{book.memo}</p> : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </section>
      </section>
    </main>
  );
}

export default App;
