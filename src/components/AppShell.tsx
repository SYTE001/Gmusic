import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { SidebarContent } from "./Sidebar";
import { CloudBadge, MobileTopBar, OfflineBadge } from "./TopBar";
import { MiniPlayer } from "./MiniPlayer";
import { QueuePanel } from "./QueuePanel";
import { usePlaybackStore } from "../stores/playbackStore";
import { useLibraryStore } from "../stores/libraryStore";
import { useToastStore } from "../stores/toastStore";
import { CloseIcon, HeartIcon, HomeIcon, LibraryIcon, PlaylistIcon, SettingsIcon } from "./Icons";
import { APP_NAME } from "../types";

const mobileNavClass = ({ isActive }: { isActive: boolean }) =>
  `flex flex-1 flex-col items-center justify-center gap-0.5 py-1 text-[10px] ${
    isActive ? "text-accent" : "text-text-secondary"
  }`;

/**
 * Two-column shell: fixed sidebar (240px) + independently scrolling main
 * content, with the full-width player bar docked at the bottom. Below 900px
 * the sidebar gives way to a top bar + bottom tab bar, and the player bar
 * becomes a compact mini-player that expands to the full Now Playing view.
 */
export function AppShell() {
  const [queueOpen, setQueueOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const location = useLocation();

  // Close the mobile drawer on navigation.
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  useGlobalKeyboardShortcuts(() => setQueueOpen((open) => !open));

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-app-bg text-text-primary">
      <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-surface-raised focus:px-4 focus:py-2 focus:text-sm">
        Skip to content
      </a>

      <div className="flex min-h-0 flex-1">
        {/* Desktop sidebar */}
        <aside className="hidden w-60 shrink-0 flex-col border-r bg-surface min-[900px]:flex" style={{ borderColor: "var(--border-subtle)" }}>
          <Link to="/" className="flex items-center gap-2.5 px-5 pb-3 pt-5" aria-label={`${APP_NAME} home`}>
            <span className="grid size-8 place-items-center rounded-lg bg-accent text-accent-contrast" aria-hidden>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M9 4.5v11.2a3.3 3.3 0 1 0 1.8 2.95V8.1l8-1.8v7.4a3.3 3.3 0 1 0 1.8 2.95V4z" />
              </svg>
            </span>
            <span className="text-[15px] font-semibold tracking-tight">{APP_NAME}</span>
          </Link>
          <div className="flex min-h-0 flex-1 flex-col">
            <SidebarContent />
          </div>
          <div className="border-t" style={{ borderColor: "var(--border-subtle)" }}>
            <CloudBadge compact />
            <OfflineBadge compact />
            <InstallHint />
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <MobileTopBar onOpenSidebar={() => setDrawerOpen(true)} />
          <main id="main-content" className="min-h-0 flex-1 overflow-y-auto" tabIndex={-1}>
            <div className="mx-auto w-full max-w-[1400px] px-4 pb-8 pt-5 md:px-8 md:pt-7 lg:pb-10">
              <Outlet />
            </div>
          </main>
        </div>

        <QueuePanel open={queueOpen} onClose={() => setQueueOpen(false)} />
      </div>

      <MiniPlayer onToggleQueue={() => setQueueOpen((open) => !open)} queueOpen={queueOpen} />

      {/* Mobile bottom navigation */}
      <nav
        aria-label="Primary"
        className="flex h-14 min-[900px]:hidden items-stretch border-t bg-app-bg"
        style={{ borderColor: "var(--border-subtle)" }}
      >
        <NavLink to="/" className={mobileNavClass} end>
          <HomeIcon size={20} />
          Home
        </NavLink>
        <NavLink to="/library" className={mobileNavClass}>
          <LibraryIcon size={20} />
          Library
        </NavLink>
        <NavLink to="/liked" className={mobileNavClass}>
          <HeartIcon size={20} />
          Liked
        </NavLink>
        <NavLink to="/playlists" className={mobileNavClass}>
          <PlaylistIcon size={20} />
          Playlists
        </NavLink>
        <NavLink to="/settings" className={mobileNavClass}>
          <SettingsIcon size={20} />
          Settings
        </NavLink>
      </nav>

      {/* Mobile navigation drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="absolute inset-0 animate-overlay-in" style={{ background: "var(--scrim)" }} onClick={() => setDrawerOpen(false)} />
          <div className="absolute inset-y-0 left-0 flex w-[280px] flex-col animate-fade-in border-r bg-surface" style={{ borderColor: "var(--border-subtle)" }}>
            <div className="flex items-center justify-between px-4 py-3.5">
              <span className="text-sm font-semibold">{APP_NAME}</span>
              <button type="button" className="icon-btn size-8" aria-label="Close navigation" onClick={() => setDrawerOpen(false)}>
                <CloseIcon size={16} />
              </button>
            </div>
            <div className="min-h-0 flex-1">
              <SidebarContent showSearch={false} />
            </div>
          </div>
        </div>
      )}

      <Toasts />
      <AriaLiveAnnouncer />
    </div>
  );
}

/**
 * Global playback keyboard shortcuts (PRD §7.6). Never hijacks typing in
 * inputs, textareas, selects, or editable content (rules §10).
 */
function useGlobalKeyboardShortcuts(toggleQueue: () => void) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable ||
          target.role === "slider")
      ) {
        return;
      }
      if (event.metaKey || event.altKey) return;
      const playback = usePlaybackStore.getState();
      const library = useLibraryStore.getState();

      switch (event.key) {
        case " ":
          event.preventDefault();
          playback.togglePlay();
          break;
        case "ArrowRight":
          event.preventDefault();
          if (event.shiftKey) playback.next(true);
          else playback.seekBy(5000);
          break;
        case "ArrowLeft":
          event.preventDefault();
          if (event.shiftKey) playback.previous();
          else playback.seekBy(-5000);
          break;
        case "ArrowUp":
          event.preventDefault();
          playback.setVolume(Math.min(1, playback.volume + 0.05));
          break;
        case "ArrowDown":
          event.preventDefault();
          playback.setVolume(Math.max(0, playback.volume - 0.05));
          break;
        case "m":
        case "M":
          playback.toggleMute();
          break;
        case "s":
        case "S":
          playback.toggleShuffle();
          break;
        case "r":
        case "R":
          playback.cycleRepeat();
          break;
        case "q":
        case "Q":
          toggleQueue();
          break;
        case "l":
        case "L":
          if (playback.currentTrackId) void library.toggleLike(playback.currentTrackId);
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleQueue]);
}

/** Visible toast stack. Errors also reach screen readers via role=alert. */
function Toasts() {
  const toasts = useToastStore((state) => state.toasts);
  const dismiss = useToastStore((state) => state.dismiss);
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-24 left-1/2 z-50 flex w-full max-w-sm -translate-x-1/2 flex-col gap-2 px-4 lg:bottom-28">
      {toasts.map((toastEntry) => (
        <div
          key={toastEntry.id}
          role={toastEntry.kind === "error" ? "alert" : "status"}
          className="pointer-events-auto flex items-start gap-2.5 rounded-xl border bg-surface-raised px-4 py-3 text-sm shadow-[var(--shadow-overlay)] animate-fade-in"
          style={{
            borderColor: toastEntry.kind === "error" ? "color-mix(in srgb, var(--danger) 40%, transparent)" : "var(--border-subtle)",
          }}
        >
          <span className={toastEntry.kind === "error" ? "text-danger" : toastEntry.kind === "success" ? "text-success" : "text-accent"} aria-hidden>
            ●
          </span>
          <span className="flex-1 text-text-primary">{toastEntry.message}</span>
          <button type="button" className="text-text-muted hover:text-text-primary" aria-label="Dismiss" onClick={() => dismiss(toastEntry.id)}>
            <CloseIcon size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** Restrained polite announcer for track changes and playback errors (rules §11). */
function AriaLiveAnnouncer() {
  const announcement = usePlaybackStore((state) => state.announcement);
  return (
    <div aria-live="polite" aria-atomic="true" className="sr-only">
      {announcement}
    </div>
  );
}

type BeforeInstallPromptEvent = Event & { prompt: () => Promise<void> };

/** Install hint shown only when the browser supports installation (PRD §7.12). */
function InstallHint() {
  const [promptEvent, setPromptEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState(() => localStorage.getItem("lm-install-hint-dismissed") === "1");

  useEffect(() => {
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setPromptEvent(event as BeforeInstallPromptEvent);
    };
    const onInstalled = () => setPromptEvent(null);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (!promptEvent || dismissed) return null;
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches;
  if (isStandalone) return null;

  return (
    <div className="m-3 rounded-xl border p-3 text-xs" style={{ borderColor: "var(--border-subtle)" }}>
      <p className="mb-2 text-text-secondary">Install this app for a window of its own and offline access.</p>
      <div className="flex gap-2">
        <button
          type="button"
          className="flex-1 rounded-lg bg-accent-strong px-2 py-1.5 font-medium text-accent-contrast"
          onClick={() => void promptEvent.prompt()}
        >
          Install
        </button>
        <button
          type="button"
          className="rounded-lg px-2 py-1.5 text-text-muted hover:text-text-primary"
          onClick={() => {
            localStorage.setItem("lm-install-hint-dismissed", "1");
            setDismissed(true);
          }}
        >
          Later
        </button>
      </div>
    </div>
  );
}
