import { useState } from "react";
import { authClient } from "./auth-client";
import { AuthForm } from "./AuthForm";
import { BookWorkspace } from "./BookWorkspace";
import "./App.css";

function App() {
  const { data: session, isPending, error: sessionError, refetch: refetchSession } = authClient.useSession();
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [isSigningOut, setIsSigningOut] = useState(false);

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
    <div className="app-shell">
      <div className="app-frame">
        <header className="site-header">
          <h1>読書記録</h1>
          {session ? (
            <div className="header-account">
              <span className="avatar" aria-hidden="true">{session.user.name.slice(0, 1)}</span>
              <span className="account-name">{session.user.name} さん <span>（ログイン中）</span></span>
              <button className="outline-button" type="button" disabled={isSigningOut} onClick={() => void handleSignOut()}>
                {isSigningOut ? "ログアウト中…" : "ログアウト"}
              </button>
            </div>
          ) : null}
        </header>
        <main className="workspace">
          {signOutError ? <p className="notice" role="alert">{signOutError}</p> : null}
          {isPending ? (
            <p className="loading-state" role="status">ログイン状態を確認しています…</p>
          ) : sessionError ? (
            <section className="panel auth-panel">
              <p className="notice" role="alert">ログイン状態を確認できませんでした。</p>
              <button type="button" onClick={() => void refetchSession()}>再試行</button>
            </section>
          ) : session ? (
            <BookWorkspace key={session.user.id} onSessionExpired={refetchSession} />
          ) : (
            <AuthForm onAuthenticated={refetchSession} />
          )}
        </main>
      </div>
    </div>
  );
}

export default App;
