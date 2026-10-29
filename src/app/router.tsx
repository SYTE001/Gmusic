import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "../components/AppShell";
import { HomePage } from "../features/home/HomePage";
import { LibraryPage } from "../features/library/LibraryPage";
import { LikedPage } from "../features/liked/LikedPage";
import { PlaylistsPage } from "../features/playlists/PlaylistsPage";
import { PlaylistDetailPage } from "../features/playlists/PlaylistDetailPage";
import { RecentPage } from "../features/recent/RecentPage";
import { SettingsPage } from "../features/settings/SettingsPage";
import { NowPlayingPage } from "../features/player/NowPlayingPage";
import { EmptyState } from "../components/EmptyState";
import { Link } from "react-router-dom";
import { LibraryIcon } from "../components/Icons";

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
  );
}
