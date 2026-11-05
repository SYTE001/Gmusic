import { create } from "zustand";
import type { AppPreferences } from "../types";
import { DB_SCHEMA_VERSION } from "../types";
import { repository } from "../services/indexeddb/LibraryRepository";
import { fileSystemAccessSupported } from "../services/file-access/FileAccessService";
import { debounce } from "../utils/misc";

export const DEFAULT_PREFERENCES: AppPreferences = {
  theme: "dark",
  volume: 0.9,
  shuffle: false,
  repeatMode: "off",
  reducedMotion: "system",
  artworkTint: true,
  ambientRainDrops: false,
  lyricsStyle: "line",
  lyricFontSize: "md",
  lyricAlignment: "center",
  lyricLineSpacing: 1.5,
  // Without the File System Access API the only way to keep files playable
  // across reloads is storing a copy; default it on there, off elsewhere.
  storeAudioCopies: !fileSystemAccessSupported(),
  // Online lyrics discovery via lrcmux (metadata only, never audio).
  autoFetchLyrics: true,
  schemaVersion: DB_SCHEMA_VERSION,
};

type SettingsState = {
  prefs: AppPreferences;
  loaded: boolean;
  /** The theme actually applied (system preference resolved). */
  resolvedTheme: "dark" | "light";
  init: () => Promise<void>;
  update: (patch: Partial<AppPreferences>) => void;
};

const persist = debounce((prefs: AppPreferences) => {
  void repository.putPreferences(prefs).catch(() => {
    // Storage failures here are non-fatal; settings simply won't persist.
    console.warn("Could not save preferences.");
  });
}, 400);

/**
 * Synchronous cache of the theme choice so the startup script in index.html
 * can apply it before first paint (redesign PRD §4: no theme flash). The
 * authoritative copy stays in IndexedDB; this mirror only carries one
 * short string, never large data (rules §6).
 */
export const THEME_CACHE_KEY = "lm-theme";
const MOTION_CACHE_KEY = "lm-motion";

/** Theme-color meta values, kept in sync with the --theme-color CSS token. */
const THEME_COLORS: Record<"dark" | "light", string> = { dark: "#09090b", light: "#f5f5f7" };

export function flushSettingsPersistence(): void {
  persist.cancel();
}

function applyThemeToDocument(theme: AppPreferences["theme"], motion: AppPreferences["reducedMotion"]): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const prefersLight = window.matchMedia("(prefers-color-scheme: light)").matches;
  const resolved = theme === "system" ? (prefersLight ? "light" : "dark") : theme;
  root.dataset.theme = resolved;
  if (motion === "system") delete root.dataset.motion;
  else root.dataset.motion = motion === "on" ? "on" : "off";
  // Match the browser chrome / taskbar tint to the active surface.
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLORS[resolved]);
  // Keep the pre-paint cache in step so reloads never flash the wrong theme.
  try {
    localStorage.setItem(THEME_CACHE_KEY, theme);
    localStorage.setItem(MOTION_CACHE_KEY, motion);
  } catch {
    // Private-mode or disabled storage: the IndexedDB copy still works.
  }
  // Components that derive colors from artwork read the resolved theme.
  useSettingsStore.setState({ resolvedTheme: resolved });
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  prefs: DEFAULT_PREFERENCES,
  loaded: false,
  resolvedTheme: "dark",

  init: async () => {
    try {
      const stored = await repository.getPreferences();
      const prefs = stored ? { ...DEFAULT_PREFERENCES, ...stored, schemaVersion: DB_SCHEMA_VERSION } : DEFAULT_PREFERENCES;
      set({ prefs, loaded: true });
      applyThemeToDocument(prefs.theme, prefs.reducedMotion);
      // Track system theme changes while in "system" mode.
      window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
        const current = get().prefs;
        if (current.theme === "system") applyThemeToDocument("system", current.reducedMotion);
      });
    } catch {
      set({ prefs: DEFAULT_PREFERENCES, loaded: true });
      applyThemeToDocument(DEFAULT_PREFERENCES.theme, DEFAULT_PREFERENCES.reducedMotion);
    }
  },

  update: (patch) => {
    const prefs = { ...get().prefs, ...patch };
    set({ prefs });
    if (patch.theme !== undefined || patch.reducedMotion !== undefined) {
      applyThemeToDocument(prefs.theme, prefs.reducedMotion);
    }
    persist(prefs);
  },
}));
