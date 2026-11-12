import type { RepeatMode, Track } from "../../types";

export type CommandCategory = "Navigation" | "Playback" | "Library";

export type CommandActionContext = {
  navigate: (to: string) => void;
  toggleQueue: () => void;
  openCreatePlaylist: () => void;
  currentTrack: Track | null;
  tracks: Track[];
  isPlaying: boolean;
  isMuted: boolean;
  shuffleEnabled: boolean;
  repeatMode: RepeatMode;
  queueOpen: boolean;
  togglePlay: () => void;
  nextTrack: () => void;
  previousTrack: () => void;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
  toggleMute: () => void;
  toggleLike: (trackId: string) => Promise<void> | void;
  playTrackFromContext: (trackId: string, contextTrackIds: string[], context: { type: "library"; label: string }) => void;
  notifyInfo: (message: string) => void;
};

export type CommandDefinition = {
  id: string;
  label: string;
  category: CommandCategory;
  keywords: string[];
  shortcut?: string;
  disabled?: boolean;
  disabledReason?: string;
  execute: () => void | Promise<void>;
};

export function buildCommandCatalog(ctx: CommandActionContext): CommandDefinition[] {
  const hasCurrentTrack = Boolean(ctx.currentTrack);
  const playableTracks = ctx.tracks.filter(
    (t) => !t.broken?.isBroken && t.availability !== "broken" && t.availability !== "unsupported",
  );
  const candidatePool = playableTracks.length > 0 ? playableTracks : ctx.tracks;
  const hasAnyTracks = candidatePool.length > 0;

  const repeatLabel =
    ctx.repeatMode === "one"
      ? "Cycle Repeat Mode (One → Off)"
      : ctx.repeatMode === "all"
        ? "Cycle Repeat Mode (All → One)"
        : "Cycle Repeat Mode (Off → All)";

  return [
    // Navigation
    {
      id: "nav-home",
      label: "Go to Home",
      category: "Navigation",
      keywords: ["home", "overview", "start", "main", "dashboard"],
      execute: () => ctx.navigate("/"),
    },
    {
      id: "nav-library",
      label: "Open Library",
      category: "Navigation",
      keywords: ["library", "songs", "tracks", "collection", "all music"],
      execute: () => ctx.navigate("/library"),
    },
    {
      id: "nav-liked",
      label: "Open Liked Songs",
      category: "Navigation",
      keywords: ["liked", "favorites", "heart", "loved", "saved"],
      execute: () => ctx.navigate("/liked"),
    },
    {
      id: "nav-playlists",
      label: "Open Playlists",
      category: "Navigation",
      keywords: ["playlists", "collections", "folders"],
      execute: () => ctx.navigate("/playlists"),
    },
    {
      id: "nav-recent",
      label: "Open Recent",
      category: "Navigation",
      keywords: ["recent", "history", "recently played"],
      execute: () => ctx.navigate("/recent"),
    },
    {
      id: "nav-broken",
      label: "Open Broken",
      category: "Navigation",
      keywords: ["broken", "missing", "unavailable", "errors", "fix", "relink"],
      execute: () => ctx.navigate("/broken"),
    },
    {
      id: "nav-settings",
      label: "Open Settings",
      category: "Navigation",
      keywords: ["settings", "preferences", "theme", "appearance", "backup", "cloud", "storage"],
      execute: () => ctx.navigate("/settings"),
    },
    {
      id: "nav-now-playing",
      label: "Open Now Playing",
      category: "Navigation",
      keywords: ["now playing", "player", "fullscreen", "lyrics", "cover"],
      disabled: !hasCurrentTrack,
      disabledReason: "No track is currently loaded",
      execute: () => {
        if (!ctx.currentTrack) {
          ctx.notifyInfo("Play a song first to open Now Playing.");
          return;
        }
        ctx.navigate("/now-playing");
      },
    },

    // Playback
    {
      id: "playback-toggle",
      label: ctx.isPlaying ? "Pause" : "Play",
      category: "Playback",
      keywords: ["play", "pause", "resume", "stop", "toggle playback"],
      shortcut: "Space",
      disabled: !hasCurrentTrack,
      disabledReason: "No track is currently loaded",
      execute: () => {
        if (!ctx.currentTrack) {
          ctx.notifyInfo("No track is currently loaded.");
          return;
        }
        ctx.togglePlay();
      },
    },
    {
      id: "playback-next",
      label: "Next Track",
      category: "Playback",
      keywords: ["next", "skip", "forward", "track"],
      shortcut: "Shift+→",
      disabled: !hasCurrentTrack,
      disabledReason: "No track is currently loaded",
      execute: () => {
        if (!ctx.currentTrack) {
          ctx.notifyInfo("No track is currently loaded.");
          return;
        }
        ctx.nextTrack();
      },
    },
    {
      id: "playback-previous",
      label: "Previous Track",
      category: "Playback",
      keywords: ["previous", "back", "rewind", "track"],
      shortcut: "Shift+←",
      disabled: !hasCurrentTrack,
      disabledReason: "No track is currently loaded",
      execute: () => {
        if (!ctx.currentTrack) {
          ctx.notifyInfo("No track is currently loaded.");
          return;
        }
        ctx.previousTrack();
      },
    },
    {
      id: "playback-shuffle",
      label: ctx.shuffleEnabled ? "Disable Shuffle" : "Enable Shuffle",
      category: "Playback",
      keywords: ["shuffle", "toggle shuffle", "random order"],
      shortcut: "S",
      execute: () => ctx.toggleShuffle(),
    },
    {
      id: "playback-repeat",
      label: repeatLabel,
      category: "Playback",
      keywords: ["repeat", "loop", "cycle repeat", "repeat mode"],
      shortcut: "R",
      execute: () => ctx.cycleRepeat(),
    },
    {
      id: "playback-queue",
      label: ctx.queueOpen ? "Close Queue" : "Open Queue",
      category: "Playback",
      keywords: ["queue", "up next", "open queue", "close queue"],
      shortcut: "Q",
      execute: () => ctx.toggleQueue(),
    },
    {
      id: "playback-mute",
      label: ctx.isMuted ? "Unmute" : "Mute",
      category: "Playback",
      keywords: ["mute", "unmute", "volume", "silence", "audio"],
      shortcut: "M",
      execute: () => ctx.toggleMute(),
    },
    {
      id: "playback-random",
      label: "Play Random Track",
      category: "Playback",
      keywords: ["random", "surprise", "shuffle play", "pick a song"],
      disabled: !hasAnyTracks,
      disabledReason: "Your library is empty",
      execute: () => {
        if (!hasAnyTracks) {
          ctx.notifyInfo("Add songs to your library first.");
          return;
        }
        const randomIndex = Math.floor(Math.random() * candidatePool.length);
        const picked = candidatePool[randomIndex] ?? candidatePool[0];
        ctx.playTrackFromContext(
          picked.id,
          candidatePool.map((t) => t.id),
          { type: "library", label: "All songs" },
        );
      },
    },
    {
      id: "playback-like-current",
      label: ctx.currentTrack?.isLiked ? "Unlike Current Track" : "Like Current Track",
      category: "Playback",
      keywords: ["like", "unlike", "favorite", "heart", "current track", "save song"],
      shortcut: "L",
      disabled: !hasCurrentTrack,
      disabledReason: "No track is currently loaded",
      execute: async () => {
        if (!ctx.currentTrack) {
          ctx.notifyInfo("No track is currently loaded.");
          return;
        }
        await ctx.toggleLike(ctx.currentTrack.id);
      },
    },

    // Library
    {
      id: "library-create-playlist",
      label: "Create Playlist",
      category: "Library",
      keywords: ["create playlist", "new playlist", "add playlist", "make playlist"],
      execute: () => ctx.openCreatePlaylist(),
    },
  ];
}
