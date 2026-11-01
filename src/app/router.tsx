import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "../components/AppShell";
import { EmptyState } from "../components/EmptyState";
import { Link } from "react-router-dom";
import { LibraryIcon } from "../components/Icons";

/**
 * Route-level code splitting (PRD §12: fast usable shell). The shell —
 * sidebar, player bar, queue — stays in the entry chunk so the frame paints
 * immediately; each page streams in on demand. No behavior change: the
 * fallback only shows while a page chunk loads.
 */
const HomePage = lazy(() => import("../features/home/HomePage").then((m) => ({ default: m.HomePage })));
const LibraryPage = lazy(() => import("../features/library/LibraryPage").then((m) => ({ default: m.LibraryPage })));
const LikedPage = lazy(() => import("../features/liked/LikedPage").then((m) => ({ default: m.LikedPage })));
const PlaylistsPage = lazy(() => import("../features/playlists/PlaylistsPage").then((m) => ({ default: m.PlaylistsPage })));
const PlaylistDetailPage = lazy(() => import("../features/playlists/PlaylistDetailPage").then((m) => ({ default: m.PlaylistDetailPage })));
const RecentPage = lazy(() => import("../features/recent/RecentPage").then((m) => ({ default: m.RecentPage })));
const SettingsPage = lazy(() => import("../features/settings/SettingsPage").then((m) => ({ default: m.SettingsPage })));
const NowPlayingPage = lazy(() => import("../features/player/NowPlayingPage").then((m) => ({ default: m.NowPlayingPage })));

/** Quiet, layout-stable placeholder shown only while a page chunk loads. */
function PageFallback() {
  return (
    <div className="grid min-h-[40vh] place-items-center" role="status" aria-label="Loading page">
      <span className="size-2.5 animate-pulse rounded-full bg-accent" aria-hidden />
    </div>
  );
}

function NotFoundPage() {
  return (
    <EmptyState
      icon={<LibraryIcon size={28} />}
      title="Page not found"
      description="That route doesn't exist in this app."
      action={
        <Link to="/" className="rounded-lg bg-accent-strong px-4 py-2 text-sm font-medium text-accent-contrast">
          Go home
        </Link>
      }
    />
  );
}

export function AppRoutes() {
  return (
    <Suspense fallback={<PageFallback />}>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<HomePage />} />
          <Route path="library" element={<LibraryPage />} />
          <Route path="liked" element={<LikedPage />} />
          <Route path="playlists" element={<PlaylistsPage />} />
          <Route path="playlist/:id" element={<PlaylistDetailPage />} />
          <Route path="recent" element={<RecentPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
        {/* Overlay routes: playback is owned by the engine, unaffected by routing */}
        <Route path="/now-playing" element={<NowPlayingPage />} />
        <Route path="/lyrics" element={<Navigate to="/now-playing?lyrics=1" replace />} />
      </Routes>
    </Suspense>
  );
}
