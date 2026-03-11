/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_M2M_QUERY_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
