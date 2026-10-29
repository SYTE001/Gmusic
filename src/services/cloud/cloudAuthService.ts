import { createClient, type Session, type SupabaseClient, type User } from "@supabase/supabase-js";

/**
 * CloudAuthService — the only module that talks to Supabase Auth (rules §5:
 * one owner per external boundary).
 *
 * The anon key used here is the publishable browser key; everything sensitive
 * (the service-role key, JWT secrets, R2 credentials) stays server-side.
 * Access to user data is enforced by Postgres Row Level Security, not by this
 * key. If the project is not configured, every downstream feature degrades to
 * the existing local-only behaviour instead of breaking.
 */

export type CloudAuthState = {
  status: "unconfigured" | "anonymous" | "authenticated";
  user: User | null;
  session: Session | null;
};

let client: SupabaseClient | null = null;

export function cloudConfigured(): boolean {
  return Boolean(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY);
}

export function workerUrl(): string {
  return (import.meta.env.VITE_WORKER_URL ?? "").replace(/\/$/, "");
}

export function workerConfigured(): boolean {
  return workerUrl().length > 0;
}

/**
 * Returns the shared Supabase client, creating it on first use. Returns null
 * when the project is not configured, so callers can skip cloud work rather
 * than throwing in a local-only install.
 */
export function getSupabaseClient(): SupabaseClient | null {
  if (!cloudConfigured()) return null;
  if (!client) {
    client = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY, {
      auth: {
        // The library persists sessions itself; the app never stores tokens.
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });
  }
  return client;
}

export function snapshotAuth(session: Session | null): CloudAuthState {
  if (!cloudConfigured()) return { status: "unconfigured", user: null, session: null };
  if (!session) return { status: "anonymous", user: null, session: null };
  return { status: "authenticated", user: session.user, session };
}

export async function currentAuthState(): Promise<CloudAuthState> {
  const supabase = getSupabaseClient();
  if (!supabase) return snapshotAuth(null);
  const { data } = await supabase.auth.getSession();
  return snapshotAuth(data.session);
}

/**
 * Short-lived access token for authenticated Worker calls. The Worker verifies
 * this token's signature; it never accepts an id from the browser.
 * Returns null when there is no session so callers can fail closed.
 */
export async function getAccessToken(): Promise<string | null> {
  const supabase = getSupabaseClient();
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

/**
 * Returns the verified authenticated user's ID from Supabase Auth.
 * Prefers `auth.getUser()`, falling back to `auth.getSession()` if needed.
 * Fails closed if not authenticated.
 */
export async function getAuthenticatedUserId(): Promise<string> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new CloudAuthError("unconfigured", "Cloud library is not configured on this build.");

  try {
    const { data, error } = await supabase.auth.getUser();
    if (!error && data?.user?.id) {
      return data.user.id;
    }
  } catch {
    // If getUser fails or is offline, check active session
  }

  const { data: sessionData } = await supabase.auth.getSession();
  const sessionUser = sessionData?.session?.user;
  if (sessionUser?.id) {
    return sessionUser.id;
  }
  throw new CloudAuthError("unauthorized", "User is not authenticated.");
}

export async function signInWithEmail(email: string, password: string): Promise<void> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new CloudAuthError("unconfigured", "Cloud sign-in is not configured on this build.");
  const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
  if (error) throw new CloudAuthError("invalid-credentials", error.message);
}

export async function signUpWithEmail(email: string, password: string): Promise<void> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new CloudAuthError("unconfigured", "Cloud sign-in is not configured on this build.");
  const { data, error } = await supabase.auth.signUp({ email: email.trim(), password });
  if (error) throw new CloudAuthError("sign-up-failed", error.message);
  if (data.user && !data.session) {
    throw new CloudAuthError("confirmation-required", "Check your email to confirm the account, then sign in.");
  }
}

export async function signOutCloud(): Promise<void> {
  const supabase = getSupabaseClient();
  if (!supabase) return;
  await supabase.auth.signOut();
}

export function subscribeToAuthChanges(listener: (state: CloudAuthState) => void): () => void {
  const supabase = getSupabaseClient();
  if (!supabase) return () => undefined;
  const { data } = supabase.auth.onAuthStateChange((_event, session) => listener(snapshotAuth(session)));
  return () => data.subscription.unsubscribe();
}

export class CloudAuthError extends Error {
  readonly kind: string;
  constructor(kind: string, message: string) {
    super(message);
    this.name = "CloudAuthError";
    this.kind = kind;
  }
}
