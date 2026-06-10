// LOGIN screen (spec §10). POST /auth/login {username,password} -> {token,user}; the auth
// store persists the token and opens the WS. Dev users: operator/operator, admin/admin.
import { useState, type FormEvent } from "react";
import { useAuth } from "../store/authStore.js";

export function Login(): JSX.Element {
  const { login } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(username.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        <h2>Device Lab</h2>
        <p className="hint">Operator dashboard — sign in to continue.</p>
        <form onSubmit={onSubmit}>
          <input
            placeholder="username"
            value={username}
            autoFocus
            autoComplete="username"
            onChange={(e) => setUsername(e.target.value)}
          />
          <input
            type="password"
            placeholder="password"
            value={password}
            autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)}
          />
          {error && <div className="error-text">{error}</div>}
          <button className="primary" type="submit" disabled={busy || !username || !password}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
          <div className="hint">Dev users: operator / operator · admin / admin</div>
        </form>
      </div>
    </div>
  );
}
