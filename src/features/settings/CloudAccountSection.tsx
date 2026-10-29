import { useState } from "react";
import { useCloudStore } from "../../stores/cloudStore";
import { toast } from "../../stores/toastStore";
import { cloudConfigured, workerConfigured } from "../../services/cloud/cloudAuthService";
import { CloudIcon, CloudCheckIcon } from "../../components/Icons";

/**
 * Settings → Cloud: sign in/out, sync status, and the honest explanation of
 * what cloud storage does and does not change about the local-first app.
 */
export function CloudAccountSection() {
  const cloud = useCloudStore();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");

  if (!cloudConfigured()) {
    return (
      <Section title="Cloud">
        <div className="space-y-2 rounded-xl border p-4 text-sm text-text-secondary" style={{ borderColor: "var(--border-subtle)" }}>
          <p>Cloud library sync is not configured in this build.</p>
          <p className="text-text-muted">
            Everything keeps working from this device, exactly as before. See <span className="tabular-nums">README</span> for the
            optional Supabase and Cloudflare R2 setup.
          </p>
        </div>
      </Section>
    );
  }

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!email.trim() || !password) {
      toast("error", "Enter your email and password.");
      return;
    }
    try {
      if (mode === "sign-in") {
        await cloud.signIn(email, password);
        toast("success", "Signed in. Syncing your cloud library…");
        void cloud.syncNow();
      } else {
        await cloud.signUp(email, password);
        toast("success", "Account created. Syncing your cloud library…");
        void cloud.syncNow();
      }
      setEmail("");
      setPassword("");
    } catch {
      // The store records the message; the toast comes from there.
    }
  };

  return (
    <Section title="Cloud">
      {cloud.status === "authenticated" && cloud.user ? (
        <div className="space-y-3 rounded-xl border p-4 text-sm" style={{ borderColor: "var(--border-subtle)" }}>
          <div className="flex items-center gap-2 text-text-primary">
            <CloudCheckIcon size={16} />
            <span className="truncate">Signed in as {cloud.user.email}</span>
          </div>
          <p className="text-text-secondary">
            {cloud.syncStatus === "syncing"
              ? "Syncing…"
              : cloud.syncStatus === "error"
                ? cloud.syncError?.message ?? "Sync failed."
                : cloud.syncStatus === "synced"
                  ? "Library synced."
                  : "Changes sync automatically."}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="rounded-lg border px-3.5 py-1.5 text-sm text-text-primary transition-colors hover:bg-surface-hover disabled:opacity-50"
              style={{ borderColor: "var(--border-strong)" }}
              disabled={cloud.syncStatus === "syncing"}
              onClick={() => void cloud.syncNow()}
            >
              Sync now
            </button>
            <button
              type="button"
              className="rounded-lg border px-3.5 py-1.5 text-sm text-text-secondary transition-colors hover:bg-surface-hover disabled:opacity-50"
              style={{ borderColor: "var(--border-strong)" }}
              disabled={cloud.busy}
              onClick={() => void cloud.signOut()}
            >
              Sign out
            </button>
          </div>
        </div>
      ) : (
        <form className="space-y-3 rounded-xl border p-4" style={{ borderColor: "var(--border-subtle)" }} onSubmit={onSubmit}>
          <div className="flex items-center gap-2 text-sm text-text-primary">
            <CloudIcon size={16} />
            <span>{mode === "sign-in" ? "Sign in to sync your library" : "Create a cloud account"}</span>
          </div>
          <input
            type="email"
            autoComplete="email"
            placeholder="Email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="w-full rounded-lg border bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
            style={{ borderColor: "var(--border-subtle)" }}
            aria-label="Email"
          />
          <input
            type="password"
            autoComplete="current-password"
            placeholder="Password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="w-full rounded-lg border bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
            style={{ borderColor: "var(--border-subtle)" }}
            aria-label="Password"
          />
          {cloud.authError && <p className="text-xs text-danger">{cloud.authError}</p>}
          <div className="flex items-center gap-3">
            <button
              type="submit"
              className="rounded-lg bg-accent-strong px-4 py-2 text-sm font-medium text-accent-contrast disabled:opacity-50"
              disabled={cloud.busy}
            >
              {mode === "sign-in" ? "Sign in" : "Create account"}
            </button>
            <button
              type="button"
              className="text-xs text-accent underline underline-offset-2"
              onClick={() => setMode(mode === "sign-in" ? "sign-up" : "sign-in")}
            >
              {mode === "sign-in" ? "No account? Sign up" : "Already have an account? Sign in"}
            </button>
          </div>
        </form>
      )}
      <p className="px-1 text-xs text-text-muted">
        Audio is stored privately in Cloudflare R2 and reachable only through short-lived, per-request links that the Worker
        issues after verifying your sign-in. Your local library, files, and offline playback keep working without an account.
      </p>
      {!workerConfigured() && (
        <p className="px-1 text-xs text-warning">Cloud playback is configured for metadata only — the R2 Worker URL is missing from this build.</p>
      )}
    </Section>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section aria-label={title}>
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-text-muted">{title}</h2>
      <div className="space-y-2">{children}</div>
    </section>
  );
}
