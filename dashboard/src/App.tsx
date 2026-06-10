// App shell. Routes between the login screen and the lab overview based on auth state, and
// renders the header with the live WS connection badge + the signed-in user.
import { useAuth } from "./store/authStore.js";
import { usePools } from "./store/poolStore.js";
import { Login } from "./components/Login.js";
import { LabOverview } from "./components/LabOverview.js";

export function App(): JSX.Element {
  const { user, logout, isAdmin } = useAuth();
  const { connected } = usePools();

  if (!user) return <Login />;

  return (
    <>
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <div className="brand-text">
            <span className="brand-name">Device Lab</span>
            <span className="brand-sub">Operator Console</span>
          </div>
        </div>
        <div className="header-right">
          <span
            className={`conn-badge ${connected ? "on" : "off"}`}
            title={connected ? "Live updates connected" : "Reconnecting to the control plane…"}
          >
            <span className={`dot ${connected ? "on" : "off"}`} />
            {connected ? "Live" : "Reconnecting…"}
          </span>
          <div className="user-chip">
            <span className="user-name">{user.name}</span>
            <span className={`role-badge ${isAdmin ? "admin" : "operator"}`}>
              {isAdmin ? "Admin" : "Operator"}
            </span>
          </div>
          <button onClick={logout}>Sign out</button>
        </div>
      </header>
      <LabOverview />
    </>
  );
}
