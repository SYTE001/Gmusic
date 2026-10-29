import { Component, useEffect, useRef, type ReactNode } from "react";
import { BrowserRouter } from "react-router-dom";
import { AppRoutes } from "./router";
import { useSettingsStore } from "../stores/settingsStore";
import { useLibraryStore, flushPlaybackSessionNow } from "../stores/libraryStore";
import { usePlaybackStore } from "../stores/playbackStore";
import { useCloudStore } from "../stores/cloudStore";
import { startLyricsPrefetch } from "../stores/lyricsStore";
import { registerServiceWorker } from "../services/offline/offlineService";

/** Top-level error boundary: a crash shows a recoverable message, not a blank page. */
export class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="grid min-h-dvh place-items-center bg-app-bg p-6 text-center">
          <div className="max-w-md space-y-3">
            <h1 className="text-lg font-semibold text-text-primary">Something went wrong</h1>
            <p className="text-sm text-text-secondary">
              The app hit an unexpected error. Your library data is stored locally and is not affected. Reloading usually fixes
              this.
            </p>
            <button
              type="button"
              className="rounded-lg bg-accent-strong px-4 py-2 text-sm font-medium text-accent-contrast"
              onClick={() => window.location.reload()}
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export function App() {
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return; // React StrictMode double-invocation guard
    startedRef.current = true;

    void useSettingsStore
      .getState()
      .init()
      .then(() => {
        // Apply persisted playback preferences once settings are loaded.
        const { prefs } = useSettingsStore.getState();
        usePlaybackStore.setState({ volume: prefs.volume, shuffleEnabled: prefs.shuffle, repeatMode: prefs.repeatMode });
        const playback = usePlaybackStore.getState();
        playback.init();
        // Cloud auth restores its own session; it never blocks the local app.
        void useCloudStore.getState().init().then(() => {
          const cloud = useCloudStore.getState();
          if (cloud.status === "authenticated") void cloud.syncNow();
        });
        return useLibraryStore.getState().init();
      });

    registerServiceWorker();

    // Auto-discover lyrics when a track starts (respects the settings toggle;
    // never blocks playback — resolution is fully backgrounded).
    const stopLyricsPrefetch = startLyricsPrefetch();

    // Audio keeps playing while the tab is hidden, but animation frames and
    // timers are throttled there. On return, re-read the audio clock so the
    // seek bar and lyrics resume from the true position immediately.
    const resyncOnWake = () => {
      if (document.visibilityState === "visible") usePlaybackStore.getState().syncFromEngine();
    };
    document.addEventListener("visibilitychange", resyncOnWake);
    window.addEventListener("focus", resyncOnWake);
    window.addEventListener("pageshow", resyncOnWake);

    // Drift watchdog: while audio plays, re-read the element's clock once a
    // second so the store can never fall behind real playback (background
    // tabs throttle both rAF and timeupdate). It only *corrects* the store —
    // the audio element remains the sole timing authority.
    const driftWatchdog = window.setInterval(() => {
      if (usePlaybackStore.getState().isPlaying) {
        usePlaybackStore.getState().syncFromEngine();
      }
    }, 1000);

    const onPageHide = () => {
      flushPlaybackSessionNow();
    };
    window.addEventListener("pagehide", onPageHide);
    return () => {
      stopLyricsPrefetch();
      window.clearInterval(driftWatchdog);
      document.removeEventListener("visibilitychange", resyncOnWake);
      window.removeEventListener("focus", resyncOnWake);
      window.removeEventListener("pageshow", resyncOnWake);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, []);

  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}
