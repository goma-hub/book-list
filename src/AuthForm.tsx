import type { FormEvent } from "react";
import { useState } from "react";
import { authClient } from "./auth-client";

type AuthFormProps = {
  onAuthenticated: () => Promise<void>;
};

function authErrorMessage(code: string | undefined, isSignUp: boolean) {
  switch (code) {
    case "INVALID_EMAIL_OR_PASSWORD":
      return "メールアドレスまたはパスワードが違います。";
    case "USER_ALREADY_EXISTS":
    case "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL":
      return "このメールアドレスは登録済みです。ログインしてください。";
    case "INVALID_EMAIL":
      return "メールアドレスを確認してください。";
    case "PASSWORD_TOO_SHORT":
      return "パスワードは8文字以上で入力してください。";
    case "PASSWORD_TOO_LONG":
      return "パスワードは128文字以内で入力してください。";
    default:
      return isSignUp
        ? "登録できませんでした。入力内容を確認して再度お試しください。"
        : "ログインできませんでした。入力内容を確認して再度お試しください。";
  }
}

export function AuthForm({ onAuthenticated }: AuthFormProps) {
  const [isSignUp, setIsSignUp] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  function changeMode(signUp: boolean) {
    setIsSignUp(signUp);
    setError(null);
    setPassword("");
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting) return;
    setError(null);

    if (isSignUp && !name.trim()) {
      setError("表示名を入力してください。");
      return;
    }

    setIsSubmitting(true);
    try {
      const result = isSignUp
        ? await authClient.signUp.email({ name: name.trim(), email: email.trim(), password })
        : await authClient.signIn.email({ email: email.trim(), password });

      if (result.error) {
        setError(authErrorMessage(result.error.code, isSignUp));
        return;
      }

      setPassword("");
      await onAuthenticated();
    } catch {
      setError("接続できませんでした。少し待ってから再度お試しください。");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <section className="panel auth-panel" aria-labelledby="auth-title">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Account</p>
          <h2 id="auth-title">{isSignUp ? "アカウントを作成" : "ログイン"}</h2>
        </div>
      </div>

      <p>ログインすると、自分の読書記録を保存・閲覧できます。</p>

      <div className="auth-mode" aria-label="ログインと新規登録の切り替え">
        <button type="button" aria-pressed={!isSignUp} disabled={isSubmitting} onClick={() => changeMode(false)}>
          ログイン
        </button>
        <button type="button" aria-pressed={isSignUp} disabled={isSubmitting} onClick={() => changeMode(true)}>
          新規登録
        </button>
      </div>

      <form className="entry-form" onSubmit={handleSubmit}>
        {isSignUp ? (
          <label>
            <span>表示名</span>
            <input name="name" autoComplete="name" required value={name} disabled={isSubmitting} onChange={(event) => setName(event.target.value)} />
          </label>
        ) : null}
        <label>
          <span>メールアドレス</span>
          <input name="email" type="email" autoComplete="username" required value={email} disabled={isSubmitting} onChange={(event) => setEmail(event.target.value)} />
        </label>
        <label>
          <span>パスワード</span>
          <input name="password" type="password" autoComplete={isSignUp ? "new-password" : "current-password"} minLength={8} maxLength={128} required value={password} disabled={isSubmitting} onChange={(event) => setPassword(event.target.value)} />
          {isSignUp ? <span className="field-hint">8〜128文字で入力してください。</span> : null}
        </label>
        {error ? <p className="notice" role="alert">{error}</p> : null}
        <button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "処理中…" : isSignUp ? "登録する" : "ログインする"}
        </button>
      </form>
    </section>
  );
}
