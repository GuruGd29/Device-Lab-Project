import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Operator dashboard dev server. The REST/WS base URL is read at runtime from
// import.meta.env.VITE_API_URL (see src/lib/config.ts), so no proxy is needed —
// the cloud control plane already enables permissive CORS (origin: true).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: false,
  },
});
