/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the cloud control plane (REST + WS host). */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
