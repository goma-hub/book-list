import { useEffect, useState } from "react";
import { authClient } from "./auth-client";
import { AuthForm } from "./AuthForm";
import { BookWorkspace } from "./BookWorkspace";
import "./App.css";

type ApiHealth = {
  app: string;
  status: "ok";
  runtime: string;
};

function App() {
  const { data: session, isPending, error: sessionError, refetch: refetchSession } = authClient.useSession();
  const [apiHealth, setApiHealth] = useState<ApiHealth | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [isSigningOut, setIsSigningOut] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    async function loadHealth() {
      try {
        const response = await fetch("/api/health", { signal: controller.signal });
        if (!response.ok) throw new Error("Worker APIの接続を確認できませんでした。");
        const health = (await response.json()) as ApiHealth;
        if (!controller.signal.aborted) setApiHealth(health);
      } catch (error) {
        if (!controller.signal.aborted) {
          setHealthError(error instanceof Error ? error.message : "API接続に失敗しました。");
        }
      }
    }
    void loadHealth();
    return () => controller.abort();
  }, []);

  async function handleSignOut() {
    if (isSigningOut) return;
    setIsSigningOut(true);
    setSignOutError(null);
    try {
      const result = await authClient.signOut();
      if (result.error) throw new Error("ログアウトできませんでした。再度お試しください。");
      await refetchSession();
    } catch (error) {
      setSignOutError(error instanceof Error ? error.message : "ログアウトできませんでした。");
    } finally {
      setIsSigningOut(false);
    }
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
                {apiHealth ? "接続済み" : healthError ? "確認失敗" : "確認中"}
              </dd>
            </div>
            <div>
              <dt>保存先</dt>
              <dd className={apiHealth ? "status-ok" : "status-waiting"}>
                {apiHealth ? "D1 接続済み" : "接続確認中"}
              </dd>
            </div>
            <div>
              <dt>認証</dt>
              <dd>{isPending ? "確認中" : sessionError ? "確認失敗" : session ? "ログイン済み" : "未ログイン"}</dd>
            </div>
          </dl>
          {session ? (
            <div className="account-info">
              <p><strong>{session.user.name}</strong><br />{session.user.email}</p>
              <button type="button" disabled={isSigningOut} onClick={() => void handleSignOut()}>
                {isSigningOut ? "ログアウト中…" : "ログアウト"}
              </button>
            </div>
          ) : null}
          {healthError ? <p className="notice" role="alert">{healthError}</p> : null}
          {signOutError ? <p className="notice" role="alert">{signOutError}</p> : null}
        </aside>

        {isPending ? (
          <section className="panel" role="status">ログイン状態を確認しています…</section>
        ) : sessionError ? (
          <section className="panel entry-form">
            <p className="notice" role="alert">ログイン状態を確認できませんでした。</p>
            <button type="button" onClick={() => void refetchSession()}>再試行</button>
          </section>
        ) : session ? (
          <BookWorkspace key={session.user.id} onSessionExpired={refetchSession} />
        ) : (
          <AuthForm onAuthenticated={refetchSession} />
        )}
      </section>
    </main>
  );
}

export default App;
