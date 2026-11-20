import type { FormEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { validateBookInput } from "../worker/book-input";

type ApiBooksResponse = {
  books: BookRecord[];
  persistence: "d1";
};

type ApiCreateBookResponse = {
  book: BookRecord;
  persistence: "d1";
};

type ApiPhotoResponse = {
  photoUrl: string;
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

const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];

function photoFileError(file: File) {
  if (!PHOTO_TYPES.includes(file.type)) return "JPEG・PNG・WebP形式の写真を選んでください。";
  if (file.size === 0 || file.size > MAX_PHOTO_BYTES) return "写真は5MB以下のファイルを選んでください。";
  return null;
}

type BookWorkspaceProps = {
  onSessionExpired: () => Promise<void>;
};

export function BookWorkspace({ onSessionExpired }: BookWorkspaceProps) {
  const [apiError, setApiError] = useState<string | null>(null);
  const [serverBooks, setServerBooks] = useState<BookRecord[]>([]);
  const [form, setForm] = useState<BookForm>(initialForm);
  const [selectedPhoto, setSelectedPhoto] = useState<File | null>(null);
  const [uploadingBookId, setUploadingBookId] = useState<string | null>(null);
  const [photoErrors, setPhotoErrors] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const photoInputRef = useRef<HTMLInputElement>(null);

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

  async function uploadPhoto(bookId: string, file: File) {
    const validationError = photoFileError(file);
    if (validationError) {
      setPhotoErrors((current) => ({ ...current, [bookId]: validationError }));
      return false;
    }

    setUploadingBookId(bookId);
    setPhotoErrors((current) => ({ ...current, [bookId]: "" }));
    try {
      const response = await fetch(`/api/books/${encodeURIComponent(bookId)}/photo`, {
        method: "PUT",
        headers: { "content-type": file.type },
        body: file,
      });
      if (response.status === 401) {
        await onSessionExpired();
        throw new Error("ログインの有効期限が切れました。再度ログインしてください。");
      }
      if (response.status === 413) throw new Error("写真は5MB以下のファイルを選んでください。");
      if (response.status === 415) throw new Error("JPEG・PNG・WebP形式の写真を選んでください。");
      if (response.status === 409) throw new Error("写真が同時に更新されました。もう一度選んでください。");
      if (!response.ok) throw new Error("写真を保存できませんでした。もう一度お試しください。");

      const result = (await response.json()) as ApiPhotoResponse;
      setServerBooks((current) => current.map((book) =>
        book.id === bookId ? { ...book, photoUrl: result.photoUrl } : book,
      ));
      return true;
    } catch (error) {
      setPhotoErrors((current) => ({
        ...current,
        [bookId]: error instanceof Error ? error.message : "写真を保存できませんでした。",
      }));
      return false;
    } finally {
      setUploadingBookId(null);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting) return;
    const validated = validateBookInput(form);
    if (!validated.ok) {
      setApiError(validated.message);
      return;
    }
    if (selectedPhoto) {
      const validationError = photoFileError(selectedPhoto);
      if (validationError) {
        setApiError(validationError);
        return;
      }
    }
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
      if (!response.ok) {
        const errorBody = await response.json().catch(() => null) as { message?: unknown } | null;
        throw new Error(typeof errorBody?.message === "string"
          ? errorBody.message
          : "読書記録を保存できませんでした。");
      }
      const result = (await response.json()) as ApiCreateBookResponse;
      setServerBooks((current) => [result.book, ...current]);
      setForm(initialForm);
      setSelectedPhoto(null);
      if (photoInputRef.current) photoInputRef.current.value = "";
      if (selectedPhoto && !await uploadPhoto(result.book.id, selectedPhoto)) {
        setApiError("読書記録は保存しましたが、写真は保存できませんでした。記録の写真欄から再試行できます。");
      } else {
        setApiError(null);
      }
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
          <span>本の写真ファイル（写真URLより優先して表示）</span>
          <input
            ref={photoInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={(event) => setSelectedPhoto(event.currentTarget.files?.[0] ?? null)}
          />
          <small className="field-hint">JPEG・PNG・WebP、5MB以下</small>
        </label>

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
                  <label className="record-photo-upload">
                    <span>写真をアップロード・変更</span>
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      disabled={uploadingBookId !== null || isSubmitting}
                      onChange={(event) => {
                        const file = event.currentTarget.files?.[0];
                        event.currentTarget.value = "";
                        if (file) void uploadPhoto(book.id, file);
                      }}
                    />
                  </label>
                  {uploadingBookId === book.id ? <p role="status">写真を保存しています…</p> : null}
                  {photoErrors[book.id] ? <p className="notice" role="alert">{photoErrors[book.id]}</p> : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
