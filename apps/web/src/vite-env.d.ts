/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_WS_URLS?: string;
  readonly VITE_RECONNECT_BASE_MS?: string;
  readonly VITE_RECONNECT_MAX_MS?: string;
  readonly VITE_CONNECTION_TIMEOUT_MS?: string;
}
