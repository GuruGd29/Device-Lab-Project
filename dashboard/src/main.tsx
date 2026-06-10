// Entry point. Providers order: auth (owns token + WS connect) wraps the pool store (consumes
// the WS pushes) wraps the app.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AuthProvider } from "./store/authStore.js";
import { PoolStoreProvider } from "./store/poolStore.js";
import { InstallStoreProvider } from "./store/installStore.js";
import { App } from "./App.js";
import "./styles.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("missing #root element");

createRoot(rootEl).render(
  <StrictMode>
    <AuthProvider>
      <PoolStoreProvider>
        <InstallStoreProvider>
          <App />
        </InstallStoreProvider>
      </PoolStoreProvider>
    </AuthProvider>
  </StrictMode>,
);
