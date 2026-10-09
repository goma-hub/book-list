import type { FormEvent } from "react";
import { useEffect, useState } from "react";

type ApiBooksResponse = {
  books: BookRecord[];
  persistence: "d1";
};

type ApiCreateBookResponse = {
  book: BookRecord;
  persistence: "d1";
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

type BookWorkspaceProps = {
  onSessionExpired: () => Promise<void>;
};

export function BookWorkspace({ onSessionExpired }: BookWorkspaceProps) {
  const [apiError, setApiError] = useState<string | null>(null);
  const [serverBooks, setServerBooks] = useState<BookRecord[]>([]);
  const [form, setForm] = useState<BookForm>(initialForm);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();

    async function loadBooks() {
      try {
        const response = await fetch("/api/books", { signal: controller.signal });
        if (response.status === 401) {
          await onSessionExpired();
          throw new Error("ログインの有効期限が切れました。再度ログインしてください。");
        }
        if (!response.ok) throw new Error("読書記録を読み込めませんでした。");
        const result = (await response.json()) as ApiBooksResponse;
        if (!controller.signal.aborted) {
          setServerBooks(result.books);
          setApiError(null);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setApiError(error instanceof Error ? error.message : "読書記録を読み込めませんでした。");
        }
      } finally {
        if (!controller.signal.aborted) setIsLoading(false);
      }
    }

    void loadBooks();
    return () => controller.abort();
  }, [onSessionExpired]);

  function updateForm(field: keyof BookForm, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      const response = await fetch("/api/books", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(form),
      });
      if (response.status === 401) {
        await onSessionExpired();
        throw new Error("ログインの有効期限が切れました。再度ログインしてください。");
      }
      if (!response.ok) throw new Error("読書記録を保存できませんでした。");
      const result = (await response.json()) as ApiCreateBookResponse;
      setServerBooks((current) => [result.book, ...current]);
      setForm(initialForm);
      setApiError(null);
    } catch (error) {
      setApiError(error instanceof Error ? error.message : "読書記録の保存に失敗しました。");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
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

        {apiError ? <p className="notice" role="alert">{apiError}</p> : null}

        <button type="submit" disabled={isSubmitting || isLoading}>
          {isSubmitting ? "保存中" : "追加"}
        </button>
      </form>

      <section className="panel records-panel" aria-labelledby="records-title">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Records</p>
            <h2 id="records-title">読書リスト</h2>
          </div>
          <span className="counter">{serverBooks.length}件</span>
        </div>

        {isLoading ? (
          <div className="empty-state" role="status">読書記録を読み込んでいます…</div>
        ) : serverBooks.length === 0 ? (
          <div className="empty-state">
            <h3>まだ記録はありません</h3>
            <p>タイトルや作者が不明でも、この画面から読書記録を追加できます。</p>
          </div>
        ) : (
          <ul className="record-list">
            {serverBooks.map((book) => (
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
  );
}
