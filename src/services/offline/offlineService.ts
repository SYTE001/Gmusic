/**
 * Service worker registration (PRD §7.12). The worker precaches the app
 * shell; it never caches arbitrary audio (rules §11). Registration happens
 * only for production builds — dev servers change assets too fast.
 */

export type OfflineStatus = "unsupported" | "registering" | "cached" | "failed";

let lastStatus: OfflineStatus = "unsupported";

const statusListeners = new Set<(status: OfflineStatus) => void>();

export function onOfflineStatusChange(listener: (status: OfflineStatus) => void): () => void {
  statusListeners.add(listener);
  listener(lastStatus);
  return () => statusListeners.delete(listener);
}

function setStatus(status: OfflineStatus): void {
  lastStatus = status;
  for (const listener of statusListeners) listener(status);
}

export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  if (!window.isSecureContext) {
    // Service workers require HTTPS or localhost; report honestly.
    console.info("Service worker skipped: this context is not secure (needs HTTPS or localhost).");
    setStatus("failed");
    return;
  }
  setStatus("registering");
  void navigator.serviceWorker
    .register("/service-worker.js")
    .then((registration) => {
      // "cached" here means the shell worker is active; assets precache during install.
      if (registration.active) setStatus("cached");
      registration.addEventListener("updatefound", () => {
        const installing = registration.installing;
        installing?.addEventListener("statechange", () => {
          if (installing.state === "activated") setStatus("cached");
        });
      });
    })
    .catch(() => setStatus("failed"));
}
