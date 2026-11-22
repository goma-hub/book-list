import type { FormEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { validateBookInput } from "../worker/book-input";

type BookRecord = {
  id: string;
  title: string | null;
  author: string | null;
  finishedOn: string | null;
  photoUrl: string | null;
  memo: string | null;
  createdAt: string;
};

type HomeResponse = {
  books: BookRecord[];
  totalCount: number;
  finishedThisYear: number;
};

type PageResponse = {
  books: BookRecord[];
  page: number;
  limit: number;
  totalCount: number;
  totalPages: number;
};

type BookForm = {
  title: string;
  author: string;
  finishedOn: string;
  photoUrl: string;
  memo: string;
};

const initialForm: BookForm = {
  title: "", author: "", finishedOn: "", photoUrl: "", memo: "",
};
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];

function photoFileError(file: File) {
  if (!PHOTO_TYPES.includes(file.type)) return "JPEG・PNG・WebP形式の写真を選んでください。";
  if (file.size === 0 || file.size > MAX_PHOTO_BYTES) return "写真は5MB以下のファイルを選んでください。";
  return null;
}

function BookCover({ photoUrl }: { photoUrl: string | null }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="book-cover">
      {photoUrl && !failed ? <img src={photoUrl} alt="" loading="lazy" onError={() => setFailed(true)} />
        : <span className="cover-placeholder" aria-hidden="true">▧</span>}
    </div>
  );
}

function BookRows({ books }: { books: BookRecord[] }) {
  return (
    <ul className="book-list">
      {books.map((book) => (
        <li className="book-row" key={book.id}>
          <BookCover key={book.photoUrl} photoUrl={book.photoUrl} />
          <div className="book-details">
            <h3>{book.title ?? "タイトル未登録"}</h3>
            <p>
              <span>作者：{book.author ?? "未登録"}</span>
              {book.finishedOn ? <><span className="metadata-divider" aria-hidden="true">｜</span><span>読了日：<time dateTime={book.finishedOn}>{book.finishedOn}</time></span></> : null}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}

type BookWorkspaceProps = { onSessionExpired: () => Promise<void> };

export function BookWorkspace({ onSessionExpired }: BookWorkspaceProps) {
  const [view, setView] = useState<"home" | "list">("home");
  const [page, setPage] = useState(1);
  const [home, setHome] = useState<HomeResponse | null>(null);
  const [listing, setListing] = useState<PageResponse | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [refreshKey, setRefreshKey] = useState(0);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [form, setForm] = useState<BookForm>(initialForm);
  const [selectedPhoto, setSelectedPhoto] = useState<File | null>(null);
  const [pendingPhoto, setPendingPhoto] = useState<{ bookId: string; file: File } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const homeTitleRef = useRef<HTMLHeadingElement>(null);
  const listTitleRef = useRef<HTMLHeadingElement>(null);
  const navigationFocusRef = useRef<"home" | "list" | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoadState("loading");

    async function load() {
      try {
        const path = view === "home" ? "/api/books/home" : `/api/books?page=${page}&limit=20`;
        const response = await fetch(path, { signal: controller.signal });
        if (response.status === 401) {
          await onSessionExpired();
          throw new Error("ログインの有効期限が切れました。再度ログインしてください。");
        }
        if (view === "list" && response.status === 400) {
          const error = await response.json() as { error?: string; totalPages?: number };
          if (error.error === "page_out_of_range" && error.totalPages && page > error.totalPages) {
            if (!controller.signal.aborted) setPage(error.totalPages);
            return;
          }
        }
        if (!response.ok) throw new Error("読書記録を読み込めませんでした。");
        if (view === "home") {
          const result = await response.json() as HomeResponse;
          if (!controller.signal.aborted) setHome(result);
        } else {
          const result = await response.json() as PageResponse;
          if (!controller.signal.aborted) setListing(result);
        }
        if (!controller.signal.aborted) setLoadState("ready");
      } catch (error) {
        if (!controller.signal.aborted) {
          setLoadState("error");
          console.error("Failed to load books", error);
        }
      }
    }

    void load();
    return () => controller.abort();
  }, [view, page, refreshKey, onSessionExpired]);

  useEffect(() => {
    if (isFormOpen) titleInputRef.current?.focus();
  }, [isFormOpen]);

  useEffect(() => {
    if (loadState === "ready" && navigationFocusRef.current === view) {
      (view === "home" ? homeTitleRef : listTitleRef).current?.focus();
      navigationFocusRef.current = null;
    }
  }, [loadState, view]);

  function changeView(next: "home" | "list") {
    navigationFocusRef.current = next;
    setLoadState("loading");
    if (next === "list") setPage(1);
    setView(next);
    window.scrollTo({ top: 0, behavior: "auto" });
  }

  function changePage(next: number) {
    if (next === page || loadState === "loading") return;
    navigationFocusRef.current = "list";
    setLoadState("loading");
    setPage(next);
    window.scrollTo({ top: 0, behavior: "auto" });
  }

  function updateForm(field: keyof BookForm, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function uploadPhoto(bookId: string, file: File) {
    setIsUploading(true);
    try {
      const response = await fetch(`/api/books/${encodeURIComponent(bookId)}/photo`, {
        method: "PUT", headers: { "content-type": file.type }, body: file,
      });
      if (response.status === 401) {
        await onSessionExpired();
        throw new Error("ログインの有効期限が切れました。再度ログインしてください。");
      }
      if (response.status === 413) throw new Error("写真は5MB以下のファイルを選んでください。");
      if (response.status === 415) throw new Error("JPEG・PNG・WebP形式の写真を選んでください。");
      if (!response.ok) throw new Error("写真を保存できませんでした。再試行してください。");
      setPendingPhoto(null);
      setSaveMessage("読書記録と写真を保存しました。");
      setRefreshKey((current) => current + 1);
    } catch (error) {
      setPendingPhoto({ bookId, file });
      setSaveMessage(error instanceof Error ? `記録は保存済みです。${error.message}` : "記録は保存済みですが、写真を保存できませんでした。");
    } finally {
      setIsUploading(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting) return;
    const validated = validateBookInput(form);
    if (!validated.ok) { setFormError(validated.message); return; }
    if (selectedPhoto) {
      const error = photoFileError(selectedPhoto);
      if (error) { setFormError(error); return; }
    }
    setIsSubmitting(true);
    setFormError(null);
    try {
      const response = await fetch("/api/books", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(form),
      });
      if (response.status === 401) {
        await onSessionExpired();
        throw new Error("ログインの有効期限が切れました。再度ログインしてください。");
      }
      if (!response.ok) {
        const errorBody = await response.json().catch(() => null) as { message?: unknown } | null;
        throw new Error(typeof errorBody?.message === "string" ? errorBody.message : "読書記録を保存できませんでした。");
      }
      const result = await response.json() as { book: BookRecord };
      const photo = selectedPhoto;
      setForm(initialForm);
      setSelectedPhoto(null);
      if (photoInputRef.current) photoInputRef.current.value = "";
      setIsFormOpen(false);
      setSaveMessage("読書記録を保存しました。");
      setRefreshKey((current) => current + 1);
      if (photo) await uploadPhoto(result.book.id, photo);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "読書記録の保存に失敗しました。");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="book-workspace">
      {saveMessage ? (
        <div className="save-feedback" role="status">
          <span>{saveMessage}</span>
          {pendingPhoto ? <button type="button" className="text-button" disabled={isUploading} onClick={() => void uploadPhoto(pendingPhoto.bookId, pendingPhoto.file)}>{isUploading ? "写真を保存中…" : "写真を再試行"}</button> : null}
        </div>
      ) : null}

      {view === "home" ? (
        <>
          <section className="summary-row" aria-label="読書状況">
            <button className="add-book-button" type="button" onClick={() => { setFormError(null); setIsFormOpen(true); }}>＋ 記録を追加</button>
            <div className="stat-card"><span>登録した本</span><strong>{loadState === "ready" && home ? home.totalCount : "—"}<small>冊</small></strong></div>
            <div className="stat-card"><span>今年の読了数</span><strong>{loadState === "ready" && home ? home.finishedThisYear : "—"}<small>冊</small></strong></div>
          </section>

          {isFormOpen ? (
            <form className="panel entry-form" onSubmit={handleSubmit} aria-label="読書記録を追加">
              <div className="form-heading"><h2>読書記録を追加</h2><button className="text-button" type="button" onClick={() => setIsFormOpen(false)} disabled={isSubmitting}>閉じる</button></div>
              <p className="field-hint">タイトル・作者名・読了日・メモのうち、1項目以上入力してください。写真だけでは登録できません。</p>
              <label><span>本のタイトル</span><input ref={titleInputRef} value={form.title} onChange={(event) => updateForm("title", event.target.value)} placeholder="例：銀河鉄道の夜" /></label>
              <label><span>作者名</span><input value={form.author} onChange={(event) => updateForm("author", event.target.value)} placeholder="例：宮沢賢治" /></label>
              <div className="form-row">
                <label><span>読了日</span><input type="date" value={form.finishedOn} onChange={(event) => updateForm("finishedOn", event.target.value)} /></label>
                <label><span>本の写真URL</span><input type="url" value={form.photoUrl} onChange={(event) => updateForm("photoUrl", event.target.value)} placeholder="https://example.com/book.jpg" /></label>
              </div>
              <label><span>本の写真ファイル（写真URLより優先）</span><input ref={photoInputRef} type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => setSelectedPhoto(event.currentTarget.files?.[0] ?? null)} /><small className="field-hint">JPEG・PNG・WebP、5MB以下</small></label>
              <label><span>メモ</span><textarea value={form.memo} onChange={(event) => updateForm("memo", event.target.value)} placeholder="感想やあらすじのメモ" rows={4} /></label>
              {formError ? <p className="notice" role="alert">{formError}</p> : null}
              <button type="submit" disabled={isSubmitting}>{isSubmitting ? "保存中…" : "追加"}</button>
            </form>
          ) : null}

          <section className="records-section" aria-labelledby="recent-title">
            <div className="section-heading"><h2 id="recent-title" ref={homeTitleRef} tabIndex={-1}>最近の読書記録</h2><button className="text-button view-all" type="button" onClick={() => changeView("list")}>すべて見る <span aria-hidden="true">›</span></button></div>
            {loadState === "loading" ? <p className="loading-state" role="status">読書記録を読み込んでいます…</p>
              : loadState === "error" ? <div className="failure-state" role="alert"><p>読書記録を読み込めませんでした。</p><button type="button" onClick={() => setRefreshKey((current) => current + 1)}>再読み込み</button></div>
              : home && home.totalCount === 0 ? <div className="empty-state"><h3>まだ読書記録がありません</h3><p>「記録を追加」から最初の1冊を登録できます。</p></div>
              : <BookRows books={home?.books ?? []} />}
          </section>
        </>
      ) : (
        <section className="records-section all-records" aria-labelledby="list-title">
          <button className="text-button back-button" type="button" onClick={() => changeView("home")}>← ホームに戻る</button>
          <div className="section-heading list-heading">
            <h2 id="list-title" ref={listTitleRef} tabIndex={-1}>全件一覧</h2>
            {loadState === "ready" && listing ? <p>全{listing.totalCount}冊{listing.totalCount > 0 ? `　｜　${(listing.page - 1) * listing.limit + 1}〜${(listing.page - 1) * listing.limit + listing.books.length}冊目を表示` : ""}</p> : null}
          </div>
          {loadState === "loading" ? <p className="loading-state" role="status">読書記録を読み込んでいます…</p>
            : loadState === "error" ? <div className="failure-state" role="alert"><p>読書記録を読み込めませんでした。</p><button type="button" onClick={() => setRefreshKey((current) => current + 1)}>再読み込み</button></div>
            : listing && listing.totalCount === 0 ? <div className="empty-state"><h3>まだ読書記録がありません</h3><p>ホームから最初の1冊を登録できます。</p></div>
            : <BookRows books={listing?.books ?? []} />}
          {loadState === "ready" && listing ? (
            <nav className="pagination" aria-label="ページ番号">
              {Array.from({ length: listing.totalPages }, (_, index) => index + 1).map((number) => (
                <button type="button" key={number} aria-label={`${number}ページ目`} aria-current={number === listing.page ? "page" : undefined} className={number === listing.page ? "current" : ""} onClick={() => changePage(number)}>{number}</button>
              ))}
            </nav>
          ) : null}
        </section>
      )}
    </div>
  );
}
