/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Supabase project URL. Safe for the browser: it only identifies the project.
   */
  readonly VITE_SUPABASE_URL: string;
  /**
   * Supabase anon/public key. This is the publishable key designed for browser
   * use; Row Level Security is what actually protects the data.
   */
  readonly VITE_SUPABASE_ANON_KEY: string;
  /**
   * Origin of the Cloudflare Worker that issues presigned R2 URLs.
   */
  readonly VITE_WORKER_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
