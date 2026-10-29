/**
 * Worker bindings and secrets.
 *
 * Secrets (`wrangler secret put`) are injected at deploy time and are never
 * present in the repository, in the frontend, or in `VITE_*` variables.
 */
export interface Env {
  /** R2 bucket binding — direct object ops, no credentials required. */
  R2_BUCKET: R2Bucket;

  // ---- Secrets ----

  /** Cloudflare account ID; forms the S3 endpoint host. */
  R2_ACCOUNT_ID: string;
  /** R2 API token access key ID. */
  R2_ACCESS_KEY_ID: string;
  /** R2 API token secret. */
  R2_SECRET_ACCESS_KEY: string;

  /** Supabase project URL, e.g. https://<project-ref>.supabase.co. Required. */
  SUPABASE_URL: string;
  /** Supabase project JWT secret (HS256). Optional legacy verification path. */
  SUPABASE_JWT_SECRET?: string;
  /** Supabase anon/public key. Optional: used for the auth-service fallback. */
  SUPABASE_ANON_KEY?: string;
  /** Optional dedicated secret for signing upload intent tokens. */
  INTENT_SECRET?: string;
  /** Optional: audience claim every token must carry. Defaults to unset. */
  SUPABASE_JWT_AUDIENCE?: string;
  /** Optional custom JWKS URL (defaults to ${SUPABASE_URL}/auth/v1/.well-known/jwks.json). */
  SUPABASE_JWKS_URL?: string;

  // ---- Non-secret vars (wrangler.toml [vars]) ----

  /** Bucket name as addressed over the S3 API. */
  R2_BUCKET_NAME: string;
  /** Single allowed browser origin for CORS. */
  ALLOWED_ORIGIN: string;
  /** Max accepted upload size in bytes. */
  MAX_UPLOAD_BYTES: string;
  /** Presigned URL lifetimes in seconds. */
  PUT_URL_TTL_SECONDS: string;
  GET_URL_TTL_SECONDS: string;
}
