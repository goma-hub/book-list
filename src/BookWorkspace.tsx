import { useEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent, RefObject } from "react";
import { createPortal } from "react-dom";
import { validateBookInput } from "../worker/book-input";

type Book = { id: string; title: string | null; author: string | null; finishedOn: string | null; photoUrl: string | null; memo: string | null; createdAt: string };
type Home = { books: Book[]; totalCount: number; finishedThisYear: number };
type Listing = { books: Book[]; page: number; limit: number; totalCount: number; totalPages: number };
type BookForm = { title: string; author: string; finishedOn: string; photoUrl: string; memo: string };
type PhotoMode = "none" | "upload" | "url";
type Modal = "create" | "detail" | "edit" | null;
type ApiResult = { book?: Book; message?: string; saved?: boolean; deleted?: boolean; cleanupPending?: boolean; photoUrl?: string };
const emptyForm: BookForm = { title: "", author: "", finishedOn: "", photoUrl: "", memo: "" };
const photoPath = (id: string) => `/api/books/${encodeURIComponent(id)}/photo`;
const uploaded = (book: Book) => book.photoUrl?.startsWith(photoPath(book.id)) ?? false;
const fromBook = (book: Book): BookForm => ({ title: book.title ?? "", author: book.author ?? "", finishedOn: book.finishedOn ?? "", photoUrl: uploaded(book) ? "" : book.photoUrl ?? "", memo: book.memo ?? "" });
const modeFromBook = (book: Book): PhotoMode => !book.photoUrl ? "none" : uploaded(book) ? "upload" : "url";

function Cover({ url, large = false }: { url: string | null; large?: boolean }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  return <div className={large ? "book-cover book-cover-large" : "book-cover"}>
    {url && !failed ? <img src={url} alt="" loading={large ? "eager" : "lazy"} onError={() => setFailed(true)} /> : <span className="cover-placeholder" aria-hidden="true">▧</span>}
  </div>;
}

function Rows({ books, select }: { books: Book[]; select: (book: Book) => void }) {
  return <ul className="book-list">{books.map((book) => <li className="book-row" key={book.id}>
    <button className="book-row-button" type="button" aria-label={`${book.title ?? "タイトル未登録"}の詳細を開く`} onClick={() => select(book)}>
      <Cover url={book.photoUrl} />
      <span className="book-details"><strong>{book.title ?? "タイトル未登録"}</strong><span>作者：{book.author ?? "未登録"}{book.finishedOn ? <> <span className="metadata-divider" aria-hidden="true">｜</span> 読了日：<time dateTime={book.finishedOn}>{book.finishedOn}</time></> : null}</span></span>
      <span className="row-action">詳細 <span aria-hidden="true">›</span></span>
    </button>
  </li>)}</ul>;
}

function Fields({ form, change, mode, changeMode, setFile, fileRef, titleRef, existing }: {
  form: BookForm; change: (field: keyof BookForm, value: string) => void; mode: PhotoMode;
  changeMode: (mode: PhotoMode) => void; setFile: (file: File | null) => void;
  fileRef: RefObject<HTMLInputElement | null>; titleRef: RefObject<HTMLInputElement | null>; existing: string | null;
}) {
  return <div className="form-fields">
    <label className="field-row"><span>本のタイトル</span><input ref={titleRef} value={form.title} onChange={(event) => change("title", event.target.value)} placeholder="例：銀河鉄道の夜" /></label>
    <label className="field-row"><span>作者名</span><input value={form.author} onChange={(event) => change("author", event.target.value)} placeholder="例：宮沢賢治" /></label>
    <label className="field-row"><span>読了日</span><input type="date" value={form.finishedOn} onChange={(event) => change("finishedOn", event.target.value)} /></label>
    <div className="field-row photo-field"><span>本の写真</span><div className="photo-options" role="radiogroup" aria-label="本の写真">
      {([["none", "写真なし"], ["upload", "画像ファイルをアップロード"], ["url", "画像URLを入力"]] as const).map(([value, label]) =>
        <label className="radio-option" key={value}><input type="radio" name="photo-mode" checked={mode === value} onChange={() => changeMode(value)} />{label}</label>)}
      {existing ? <div className="existing-photo"><Cover url={existing} /><span>現在の写真</span></div> : null}
      {mode === "upload" ? <label className="photo-entry"><span>画像ファイル</span><input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => setFile(event.currentTarget.files?.[0] ?? null)} /><small className="field-hint">JPEG・PNG・WebP、5MB以下。保存済みの写真は再選択不要です。</small></label> : null}
      {mode === "url" ? <label className="photo-entry"><span>画像URL</span><input type="url" value={form.photoUrl} onChange={(event) => change("photoUrl", event.target.value)} placeholder="https://example.com/book.jpg" /></label> : null}
    </div></div>
    <label className="field-row"><span>メモ</span><textarea value={form.memo} onChange={(event) => change("memo", event.target.value)} placeholder="感想やあらすじのメモ" rows={4} /></label>
  </div>;
}

export function BookWorkspace({ onSessionExpired }: { onSessionExpired: () => Promise<void> }) {
  const [view, setView] = useState<"home" | "list">("home");
  const [page, setPage] = useState(1);
  const [home, setHome] = useState<Home | null>(null);
  const [listing, setListing] = useState<Listing | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [refresh, setRefresh] = useState(0);
  const [modal, setModal] = useState<Modal>(null);
  const [book, setBook] = useState<Book | null>(null);
  const [detailState, setDetailState] = useState<"loading" | "ready" | "error">("loading");
  const [form, setForm] = useState<BookForm>(emptyForm);
  const [mode, setMode] = useState<PhotoMode>("none");
  const [file, setFile] = useState<File | null>(null);
  const [pendingPhoto, setPendingPhoto] = useState<{ id: string; file: File } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const modalTitleRef = useRef<HTMLHeadingElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const originalForm = useRef("");
  const detailRequest = useRef(0);
  const homeTitleRef = useRef<HTMLHeadingElement>(null);
  const listTitleRef = useRef<HTMLHeadingElement>(null);
  const navigationFocus = useRef<"home" | "list" | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoadState("loading");
    async function load() {
      try {
        const response = await fetch(view === "home" ? "/api/books/home" : `/api/books?page=${page}&limit=20`, { signal: controller.signal });
        if (response.status === 401) { await onSessionExpired(); throw new Error("ログインの有効期限が切れました。"); }
        if (view === "list" && response.status === 400) {
          const result = await response.json() as { error?: string; totalPages?: number };
          if (result.error === "page_out_of_range" && result.totalPages && page > result.totalPages) { if (!controller.signal.aborted) setPage(result.totalPages); return; }
        }
        if (!response.ok) throw new Error("読書記録を読み込めませんでした。");
        if (view === "home") { const result = await response.json() as Home; if (!controller.signal.aborted) setHome(result); }
        else { const result = await response.json() as Listing; if (!controller.signal.aborted) setListing(result); }
        if (!controller.signal.aborted) setLoadState("ready");
      } catch (error) { if (!controller.signal.aborted) { setLoadState("error"); console.error("Failed to load books", error); } }
    }
    void load();
    return () => controller.abort();
  }, [view, page, refresh, onSessionExpired]);

  useEffect(() => {
    if (loadState === "ready" && navigationFocus.current === view) {
      (view === "home" ? homeTitleRef : listTitleRef).current?.focus();
      navigationFocus.current = null;
    }
  }, [loadState, view]);
  useEffect(() => {
    if (!modal) return;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    (modal === "detail" ? modalTitleRef : titleRef).current?.focus();
    return () => { document.body.style.overflow = overflow; };
  }, [modal]);

  function close() {
    detailRequest.current += 1;
    setModal(null); setBook(null); setFormError(null);
    requestAnimationFrame(() => returnFocus.current?.focus());
  }
  function dirty() { return JSON.stringify({ form, mode }) !== originalForm.current || file !== null; }
  function cancel() {
    if (busy) return;
    if (dirty() && !window.confirm("入力中の変更を破棄しますか？")) return;
    if (modal === "edit") { setFormError(null); setModal("detail"); } else close();
  }
  function modalKeys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") { event.preventDefault(); if (modal === "edit" || modal === "create") cancel(); else if (!busy) close(); }
    if (event.key !== "Tab") return;
    const items = Array.from(modalRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])") ?? []).filter((item) => item.getClientRects().length > 0);
    if (!items.length) { event.preventDefault(); modalRef.current?.focus(); return; }
    if (!items.includes(document.activeElement as HTMLElement)) { event.preventDefault(); (event.shiftKey ? items[items.length - 1] : items[0])?.focus(); }
    else if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items[items.length - 1]?.focus(); }
    else if (!event.shiftKey && document.activeElement === items[items.length - 1]) { event.preventDefault(); items[0]?.focus(); }
  }
  function changeView(next: "home" | "list") {
    navigationFocus.current = next; setLoadState("loading"); if (next === "list") setPage(1); setView(next); window.scrollTo({ top: 0, behavior: "auto" });
  }
  function changePage(next: number) {
    if (next === page || loadState === "loading") return;
    navigationFocus.current = "list"; setLoadState("loading"); setPage(next); window.scrollTo({ top: 0, behavior: "auto" });
  }
  function openCreate() {
    returnFocus.current = document.activeElement as HTMLElement;
    setForm({ ...emptyForm }); setMode("none"); setFile(null); setFormError(null);
    originalForm.current = JSON.stringify({ form: emptyForm, mode: "none" }); setModal("create");
  }
  async function openDetail(selected: Book) {
    const requestId = ++detailRequest.current;
    returnFocus.current = document.activeElement as HTMLElement;
    setBook(selected); setDetailState("loading"); setFormError(null); setModal("detail");
    try {
      const response = await fetch(`/api/books/${encodeURIComponent(selected.id)}`);
      if (response.status === 401) { await onSessionExpired(); throw new Error("ログインの有効期限が切れました。再度ログインしてください。"); }
      if (!response.ok) throw new Error("本の詳細を読み込めませんでした。");
      const result = await response.json() as { book: Book };
      if (detailRequest.current === requestId) { setBook(result.book); setDetailState("ready"); }
    } catch (error) { if (detailRequest.current === requestId) { setDetailState("error"); setFormError(error instanceof Error ? error.message : "本の詳細を読み込めませんでした。"); } }
  }
  function startEdit() {
    if (!book) return;
    const nextForm = fromBook(book), nextMode = modeFromBook(book);
    setForm(nextForm); setMode(nextMode); setFile(null); setFormError(null);
    originalForm.current = JSON.stringify({ form: nextForm, mode: nextMode }); setModal("edit");
  }
  function changeMode(next: PhotoMode) {
    setMode(next); setFile(null); setForm((current) => ({ ...current, photoUrl: "" }));
    if (fileRef.current) fileRef.current.value = "";
  }
  async function json(path: string, method: "POST" | "PUT" | "DELETE", body?: unknown) {
    const response = await fetch(path, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
    const result = await response.json().catch(() => ({})) as ApiResult;
    if (response.status === 401) { await onSessionExpired(); throw new Error("ログインの有効期限が切れました。再度ログインしてください。"); }
    return { response, result };
  }
  async function putPhoto(id: string, selected: File) {
    const response = await fetch(photoPath(id), { method: "PUT", headers: { "content-type": selected.type }, body: selected });
    const result = await response.json().catch(() => ({})) as ApiResult;
    if (response.status === 401) { await onSessionExpired(); throw new Error("ログインの有効期限が切れました。再度ログインしてください。"); }
    if (response.status === 413) throw new Error("写真は5MB以下のファイルを選んでください。");
    if (response.status === 415) throw new Error("JPEG・PNG・WebP形式の写真を選んでください。");
    if (!response.ok && !(result.saved && result.book)) throw new Error(result.message ?? "写真を保存できませんでした。再試行してください。");
    return { url: result.photoUrl ?? `${photoPath(id)}?v=${Date.now()}`, warning: result.cleanupPending ? result.message ?? "古い写真の削除が完了していません。" : null };
  }
  async function retryPhoto() {
    if (!pendingPhoto || uploading) return;
    setUploading(true);
    try { const photo = await putPhoto(pendingPhoto.id, pendingPhoto.file); setPendingPhoto(null); setMessage(photo.warning ?? "写真を保存しました。"); setRefresh((value) => value + 1); }
    catch (error) { setMessage(`記録は保存済みです。写真のみ失敗しました。${error instanceof Error ? error.message : ""}`); }
    finally { setUploading(false); }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return;
    const validated = validateBookInput({ ...form, photoUrl: mode === "url" ? form.photoUrl : null });
    if (!validated.ok) { setFormError(validated.message); return; }
    if (mode === "url" && !validated.value.photoUrl) { setFormError("画像URLを入力してください。"); return; }
    if (mode === "upload" && !file && !(modal === "edit" && book && uploaded(book))) { setFormError("画像ファイルを選んでください。"); return; }
    if (mode === "upload" && file) {
      if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) { setFormError("JPEG・PNG・WebP形式の写真を選んでください。"); return; }
      if (!file.size || file.size > 5 * 1024 * 1024) { setFormError("写真は5MB以下のファイルを選んでください。"); return; }
    }
    setBusy(true); setFormError(null);
    try {
      if (modal === "create") {
        const { response, result } = await json("/api/books", "POST", { ...form, photoUrl: mode === "url" ? form.photoUrl : null });
        if (!response.ok || !result.book) throw new Error(result.message ?? "読書記録を保存できませんでした。");
        close(); setPage(1); setRefresh((value) => value + 1); setMessage("読書記録を保存しました。"); setPendingPhoto(null);
        if (mode === "upload" && file) {
          try { const photo = await putPhoto(result.book.id, file); setMessage(photo.warning ?? "読書記録と写真を保存しました。"); setRefresh((value) => value + 1); }
          catch (error) { setPendingPhoto({ id: result.book.id, file }); setMessage(`記録は保存済みです。写真のみ失敗しました。${error instanceof Error ? error.message : ""}`); }
        }
      } else if (modal === "edit" && book) {
        const photo = mode === "none" ? { photoUrl: null } : mode === "url" ? { photoUrl: form.photoUrl } : {};
        const { response, result } = await json(`/api/books/${encodeURIComponent(book.id)}`, "PUT", { title: form.title, author: form.author, finishedOn: form.finishedOn, memo: form.memo, ...photo });
        if (!response.ok && !(result.saved && result.book)) throw new Error(result.message ?? "読書記録を保存できませんでした。");
        if (!result.book) throw new Error("更新結果を確認できませんでした。");
        let updated = result.book;
        if (result.cleanupPending) {
          setBook(updated); setDetailState("ready"); setModal("detail"); setRefresh((value) => value + 1);
          setFormError(result.message ?? "変更は保存されましたが、古い写真の削除が完了していません。");
          return;
        }
        if (mode === "upload" && file) {
          try {
            const photo = await putPhoto(book.id, file);
            updated = { ...updated, photoUrl: photo.url };
            if (photo.warning) {
              setBook(updated); setDetailState("ready"); setModal("detail"); setRefresh((value) => value + 1);
              setFormError(photo.warning); return;
            }
          }
          catch (error) { setBook(updated); setRefresh((value) => value + 1); setFormError(`書籍情報は保存済みです。写真のみ失敗しました。再度「保存する」で写真を再試行できます。${error instanceof Error ? error.message : ""}`); return; }
        }
        setBook(updated); setDetailState("ready"); setModal("detail"); setMessage("読書記録を更新しました。"); setRefresh((value) => value + 1);
      }
    } catch (error) { setFormError(error instanceof Error ? error.message : "読書記録の保存に失敗しました。"); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!book || busy || !window.confirm("この読書記録を削除しますか？")) return;
    setBusy(true); setFormError(null);
    try {
      const { response, result } = await json(`/api/books/${encodeURIComponent(book.id)}`, "DELETE");
      if (!response.ok && !result.deleted) throw new Error(result.message ?? "読書記録を削除できませんでした。");
      close(); setRefresh((value) => value + 1);
      setMessage(result.cleanupPending ? result.message ?? "記録は削除済みですが、写真の後片付けが完了していません。" : "読書記録を削除しました。");
    } catch (error) { setFormError(error instanceof Error ? error.message : "読書記録を削除できませんでした。"); }
    finally { setBusy(false); }
  }

  return <div className="book-workspace">
    {message ? <div className="save-feedback" role="status"><span>{message}</span>{pendingPhoto ? <button type="button" className="text-button" disabled={uploading} onClick={() => void retryPhoto()}>{uploading ? "写真を保存中…" : "写真を再試行"}</button> : null}</div> : null}
    {view === "home" ? <>
      <section className="summary-row" aria-label="読書状況">
        <button className="add-book-button" type="button" onClick={openCreate}>＋ 記録を追加</button>
        <div className="stat-card"><span>登録した本</span><strong>{loadState === "ready" && home ? home.totalCount : "—"}<small>冊</small></strong></div>
        <div className="stat-card"><span>今年の読了数</span><strong>{loadState === "ready" && home ? home.finishedThisYear : "—"}<small>冊</small></strong></div>
      </section>
      <section className="records-section" aria-labelledby="recent-title">
        <div className="section-heading"><h2 id="recent-title" ref={homeTitleRef} tabIndex={-1}>最近の読書記録</h2><button className="text-button view-all" type="button" onClick={() => changeView("list")}>すべて見る <span aria-hidden="true">›</span></button></div>
        {loadState === "loading" ? <p className="loading-state" role="status">読書記録を読み込んでいます…</p> : loadState === "error" ? <div className="failure-state" role="alert"><p>読書記録を読み込めませんでした。</p><button type="button" onClick={() => setRefresh((value) => value + 1)}>再読み込み</button></div> : home && home.totalCount === 0 ? <div className="empty-state"><h3>まだ読書記録がありません</h3><p>「記録を追加」から最初の1冊を登録できます。</p></div> : <Rows books={home?.books ?? []} select={(item) => void openDetail(item)} />}
      </section>
    </> : <section className="records-section all-records" aria-labelledby="list-title">
      <button className="text-button back-button" type="button" onClick={() => changeView("home")}>← ホームに戻る</button>
      <div className="section-heading list-heading"><h2 id="list-title" ref={listTitleRef} tabIndex={-1}>全件一覧</h2>{loadState === "ready" && listing ? <p>全{listing.totalCount}冊{listing.totalCount > 0 ? `　｜　${(listing.page - 1) * listing.limit + 1}〜${(listing.page - 1) * listing.limit + listing.books.length}冊目を表示` : ""}</p> : null}</div>
      {loadState === "loading" ? <p className="loading-state" role="status">読書記録を読み込んでいます…</p> : loadState === "error" ? <div className="failure-state" role="alert"><p>読書記録を読み込めませんでした。</p><button type="button" onClick={() => setRefresh((value) => value + 1)}>再読み込み</button></div> : listing && listing.totalCount === 0 ? <div className="empty-state"><h3>まだ読書記録がありません</h3><p>ホームから最初の1冊を登録できます。</p></div> : <Rows books={listing?.books ?? []} select={(item) => void openDetail(item)} />}
      {loadState === "ready" && listing ? <nav className="pagination" aria-label="ページ番号">{Array.from({ length: listing.totalPages }, (_, index) => index + 1).map((number) => <button type="button" key={number} aria-label={`${number}ページ目`} aria-current={number === listing.page ? "page" : undefined} className={number === listing.page ? "current" : ""} onClick={() => changePage(number)}>{number}</button>)}</nav> : null}
    </section>}
    {modal ? createPortal(<div className="modal-backdrop"><div className="book-modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" ref={modalRef} tabIndex={-1} onKeyDown={modalKeys}>
      {modal === "detail" ? <>
        <div className="modal-header"><h2 id="modal-title" ref={modalTitleRef} tabIndex={-1}>本の詳細</h2></div>
        <div className="modal-scroll detail-scroll">{detailState === "loading" ? <p role="status">本の詳細を読み込んでいます…</p> : detailState === "error" ? <p className="notice" role="alert">{formError}</p> : book ? <>
          <div className="detail-top"><Cover key={book.photoUrl} url={book.photoUrl} large /><div className="detail-facts">
            <div><span>本のタイトル</span><strong>{book.title ?? "未登録"}</strong></div>
            <div><span>作者名</span><strong>{book.author ?? "未登録"}</strong></div>
            <div><span>読了日</span><strong>{book.finishedOn ?? "未登録"}</strong></div>
          </div></div>
          <div className="memo-detail"><h3>メモ</h3><div className="memo-box">{book.memo ?? "未登録"}</div></div>
          <button className="delete-link" type="button" disabled={busy} onClick={() => void remove()}><span aria-hidden="true">🗑</span> この記録を削除</button>
          {formError ? <p className="notice" role="alert">{formError}</p> : null}
        </> : null}</div>
        <div className="modal-actions"><button className="outline-button" type="button" disabled={busy} onClick={close}>閉じる</button><button type="button" disabled={busy || detailState !== "ready"} onClick={startEdit}>編集する</button></div>
      </> : <form className="modal-form" onSubmit={(event) => void submit(event)}>
        <div className="modal-header"><h2 id="modal-title">{modal === "create" ? "新しい読書記録" : "読書記録を編集"}</h2><p>※タイトル・作者名・読了日・メモのうち、1項目以上入力してください。写真だけでは登録できません。</p></div>
        <div className="modal-scroll"><Fields form={form} change={(field, value) => setForm((current) => ({ ...current, [field]: value }))} mode={mode} changeMode={changeMode} setFile={setFile} fileRef={fileRef} titleRef={titleRef} existing={modal === "edit" ? book?.photoUrl ?? null : null} />{formError ? <p className="notice" role="alert">{formError}</p> : null}</div>
        <div className="modal-actions"><button className="outline-button" type="button" disabled={busy} onClick={cancel}>キャンセル</button><button type="submit" disabled={busy}>{busy ? "保存中…" : modal === "create" ? "登録する" : "保存する"}</button></div>
      </form>}
    </div></div>, document.body) : null}
  </div>;
}
