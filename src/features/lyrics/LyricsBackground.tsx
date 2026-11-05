import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { Track } from "../../types";
import { useArtworkUrl } from "../../components/Artwork";
import { useSettingsStore } from "../../stores/settingsStore";
import { usePlaybackStore } from "../../stores/playbackStore";
import { useLibraryStore } from "../../stores/libraryStore";
import { nextIndex } from "../player/queue";
import {
  createFallbackPalette,
  detectInitialTier,
  extractPaletteFromImageUrl,
  getCachedPalette,
  scheduleNextTrackPrecompute,
  stepDownTier,
  type BackgroundTier,
  type LyricsPalette,
} from "./palette";
import "./lyricsBackground.css";

const GRAIN_DATA_URL =
  "data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)'/%3E%3C/svg%3E";

const RAPID_SKIP_DEBOUNCE_MS = 150;

type LayerState = {
  palette: LyricsPalette;
  key: string;
};

export type LyricsBackgroundProps = {
  track: Track | null | undefined;
  isPlaying: boolean;
  /** Controls Stage 1 <-> Stage 2 opacity fade while keeping the component mount-agnostic (PRD §1). */
  visible?: boolean;
};

export function LyricsBackground({ track, isPlaying, visible = true }: LyricsBackgroundProps) {
  const artworkUrl = useArtworkUrl(track);
  const trackId = track?.id ?? "none";
  const coverKey = track?.album ? `${track.album}-${track.artist}` : trackId;

  // Settings & motion preferences
  const animatedBgSetting = useSettingsStore(
    (state) => state.prefs.animatedLyricsBackground ?? true,
  );
  const reducedMotionSetting = useSettingsStore((state) => state.prefs.reducedMotion);

  // Capability tier (`full` | `lite` | `static`, PRD §8.1)
  const [tier, setTier] = useState<BackgroundTier>(() => detectInitialTier());

  // Initial palette (cached or fallback)
  const initialPalette = useMemo(() => {
    return (coverKey ? getCachedPalette(coverKey) : undefined) ?? createFallbackPalette(coverKey);
  }, [coverKey]);

  // A/B crossfade layers (PRD §3.2)
  const [layerA, setLayerA] = useState<LayerState>({ palette: initialPalette, key: coverKey });
  const [layerB, setLayerB] = useState<LayerState | null>(null);
  const [activeLayer, setActiveLayer] = useState<"A" | "B">("A");
  const currentKeyRef = useRef(coverKey);

  // Animation pause states (PRD §5)
  const [tabHidden, setTabHidden] = useState(
    () => typeof document !== "undefined" && document.hidden,
  );
  const [playbackPaused3s, setPlaybackPaused3s] = useState(!isPlaying);
  const [lowBattery, setLowBattery] = useState(false);
  const [systemReducedMotion, setSystemReducedMotion] = useState(false);

  // Monitor prefers-reduced-motion
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    setSystemReducedMotion(media.matches);
    const handler = (e: MediaQueryListEvent) => setSystemReducedMotion(e.matches);
    media.addEventListener("change", handler);
    return () => media.removeEventListener("change", handler);
  }, []);

  const isMotionReduced =
    reducedMotionSetting === "on" ||
    (reducedMotionSetting === "system" && systemReducedMotion);

  // Tab visibility listener
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisibilityChange = () => {
      setTabHidden(document.hidden);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  // 3-second paused debounce (PRD §5: pause keyframes after 3s of paused playback)
  useEffect(() => {
    if (isPlaying) {
      setPlaybackPaused3s(false);
      return;
    }
    const timer = setTimeout(() => {
      setPlaybackPaused3s(true);
    }, 3000);
    return () => clearTimeout(timer);
  }, [isPlaying]);

  // Low battery detection (PRD §5, §8.1)
  useEffect(() => {
    let unmounted = false;
    type BatteryManager = {
      level: number;
      charging: boolean;
      addEventListener: (type: string, listener: () => void) => void;
      removeEventListener: (type: string, listener: () => void) => void;
    };
    const nav = typeof navigator !== "undefined"
      ? (navigator as Navigator & { getBattery?: () => Promise<BatteryManager> })
      : null;

    if (nav && typeof nav.getBattery === "function") {
      let batteryRef: BatteryManager | null = null;
      const checkBattery = () => {
        if (!batteryRef || unmounted) return;
        setLowBattery(batteryRef.level <= 0.2 && !batteryRef.charging);
      };
      void nav
        .getBattery()
        .then((battery) => {
          if (unmounted) return;
          batteryRef = battery;
          checkBattery();
          battery.addEventListener("levelchange", checkBattery);
          battery.addEventListener("chargingchange", checkBattery);
        })
        .catch(() => {
          // Battery API unsupported or blocked
        });

      return () => {
        unmounted = true;
        if (batteryRef) {
          batteryRef.removeEventListener("levelchange", checkBattery);
          batteryRef.removeEventListener("chargingchange", checkBattery);
        }
      };
    }
    return () => {
      unmounted = true;
    };
  }, []);

  // Effective tier and pause decision
  const effectiveTier: BackgroundTier =
    !animatedBgSetting || isMotionReduced || lowBattery ? "static" : tier;

  const isPaused =
    !visible ||
    effectiveTier === "static" ||
    tabHidden ||
    playbackPaused3s;

  // Frame-drop monitor: if rAF delta > 24ms sustained for ~2 seconds while animating,
  // automatically step down one tier (`full` -> `lite` -> `static`) and remember it (PRD §5, §8.1).
  useEffect(() => {
    if (isPaused || typeof requestAnimationFrame === "undefined") {
      return;
    }

    let slowElapsedMs = 0;
    let lastTime = performance.now();
    let rafId = 0;

    const monitor = (now: number) => {
      const delta = now - lastTime;
      lastTime = now;
      // Ignore huge tab-switch gaps (> 500ms); count genuine slow frames (> 24ms)
      if (delta > 24 && delta < 500) {
        slowElapsedMs += delta;
        if (slowElapsedMs >= 2000) {
          setTier((prev) => stepDownTier(prev));
          return;
        }
      } else if (delta <= 24) {
        slowElapsedMs = Math.max(0, slowElapsedMs - delta * 0.5);
      }
      rafId = requestAnimationFrame(monitor);
    };

    rafId = requestAnimationFrame(monitor);
    return () => cancelAnimationFrame(rafId);
  }, [isPaused, effectiveTier]);

  // Load and apply new palette on artwork or track change with A/B crossfade
  // Debounces uncached cover extraction by 150ms so rapid skipping stays instant (PRD §3.2, §8.3).
  useEffect(() => {
    let cancelled = false;

    // Skip transition if coverKey is identical (same album or track)
    if (coverKey === currentKeyRef.current && (layerA.key === coverKey || layerB?.key === coverKey)) {
      return;
    }

    const applyPalette = (palette: LyricsPalette) => {
      if (cancelled) return;
      currentKeyRef.current = coverKey;

      if (activeLayer === "A") {
        setLayerB({ palette, key: coverKey });
        setActiveLayer("B");
      } else {
        setLayerA({ palette, key: coverKey });
        setActiveLayer("A");
      }
    };

    // Fast path: already in memory cache (e.g. same album or precomputed from queue)
    const cached = getCachedPalette(coverKey);
    if (cached) {
      applyPalette(cached);
      return () => {
        cancelled = true;
      };
    }

    if (!artworkUrl) {
      applyPalette(createFallbackPalette(coverKey));
      return () => {
        cancelled = true;
      };
    }

    // Debounce extraction by 150ms so rapid track skipping never blocks or wastes work (PRD §8.3)
    const debounceTimer = setTimeout(() => {
      const runExtraction = () => {
        if (cancelled) return;
        void extractPaletteFromImageUrl(artworkUrl, coverKey).then((palette) => {
          applyPalette(palette);
        });
      };

      if (typeof window !== "undefined" && "requestIdleCallback" in window) {
        (window as Window & { requestIdleCallback: (cb: () => void) => number }).requestIdleCallback(
          runExtraction,
        );
      } else {
        runExtraction();
      }
    }, RAPID_SKIP_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(debounceTimer);
    };
  }, [artworkUrl, coverKey, activeLayer, layerA.key, layerB?.key]);

  // Precompute palette for the next track in queue (PRD §4.1)
  const queueTrackIds = usePlaybackStore((state) => state.queueTrackIds);
  const queueIndex = usePlaybackStore((state) => state.queueIndex);
  const repeatMode = usePlaybackStore((state) => state.repeatMode);
  const tracks = useLibraryStore((state) => state.tracks);

  useEffect(() => {
    const nextIdx = nextIndex({ queueTrackIds, queueIndex, repeatMode });
    if (nextIdx !== null && nextIdx < queueTrackIds.length) {
      const nextId = queueTrackIds[nextIdx];
      const nextTrack = tracks.find((t) => t.id === nextId);
      if (nextTrack) {
        scheduleNextTrackPrecompute(nextTrack);
      }
    }
  }, [queueTrackIds, queueIndex, repeatMode, tracks]);

  return (
    <div
      className={`lyrics-bg-container lyrics-bg-tier-${effectiveTier} ${isPaused ? "lyrics-bg-paused" : ""}`}
      style={{ opacity: visible ? 1 : 0 }}
      data-tier={effectiveTier}
      aria-hidden="true"
    >
      {/* Layer A */}
      <LayerInstance
        state={layerA}
        active={activeLayer === "A"}
        tier={effectiveTier}
      />

      {/* Layer B (only mounted when crossfading) */}
      {layerB && (
        <LayerInstance
          state={layerB}
          active={activeLayer === "B"}
          tier={effectiveTier}
        />
      )}

      {/* Grain noise overlay at 3.5% opacity — only on 'full' tier (PRD §3.1, §8.1) */}
      {effectiveTier === "full" && (
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.035]"
          style={{
            backgroundImage: `url("${GRAIN_DATA_URL}")`,
            backgroundRepeat: "repeat",
          }}
        />
      )}
    </div>
  );
}

function LayerInstance({
  state,
  active,
  tier,
}: {
  state: LayerState;
  active: boolean;
  tier: BackgroundTier;
}) {
  const { palette } = state;
  const { presetConfig } = palette;
  const isStatic = tier === "static";
  const isLite = tier === "lite";

  // Lite tier runs slower loops (PRD §8.1)
  const durationSec = isLite ? Math.round(presetConfig.duration * 1.25) : presetConfig.duration;

  // CSS custom properties fed by the palette (`--bg-base`, `--blob-1..4`, PRD §6.4)
  const layerStyle: CSSProperties = {
    opacity: active ? 1 : 0,
    transition: isStatic ? "none" : "opacity 900ms ease-in-out",
    backgroundColor: palette.baseColor,
    willChange: isStatic ? "auto" : "opacity",
    ["--bg-base" as string]: palette.baseColor,
    ["--blob-1" as string]: palette.blobColors[0],
    ["--blob-2" as string]: palette.blobColors[1],
    ["--blob-3" as string]: palette.blobColors[2],
    ["--blob-4" as string]: palette.blobColors[3],
    ["--accent-color" as string]: palette.accentColor,
    ["--blob-duration" as string]: `${durationSec}s`,
  };

  const blobOpacity = presetConfig.blobOpacity;
  // Lite tier and calm preset use 3 blobs (PRD §4.3, §8.1)
  const is3Blobs = presetConfig.blobCount === 3 || isLite;

  return (
    <div className="absolute inset-0 overflow-hidden" style={layerStyle}>
      {/* Base solid background */}
      <div
        className="absolute inset-0"
        style={{ backgroundColor: "var(--bg-base)" }}
      />

      {/* Static blur container (PRD §2.3, §8.2: 50% scale upscaled via transform) */}
      <div className="lyrics-bg-blur-stage">
        <div
          className={`lyrics-blob lyrics-blob-1 ${isStatic ? "!animation-none" : ""}`}
          style={{ opacity: blobOpacity }}
        />
        <div
          className={`lyrics-blob lyrics-blob-2 ${isStatic ? "!animation-none" : ""}`}
          style={{ opacity: blobOpacity }}
        />
        <div
          className={`lyrics-blob lyrics-blob-3 ${isStatic ? "!animation-none" : ""}`}
          style={{ opacity: blobOpacity * 0.9 }}
        />
        {!is3Blobs && (
          <div
            className={`lyrics-blob lyrics-blob-4 ${isStatic ? "!animation-none" : ""}`}
            style={{ opacity: blobOpacity * 0.85 }}
          />
        )}
      </div>

      {/* Scrim: vertical gradient overlay for guaranteed full-screen legibility (PRD §1, §3.1) */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background: `linear-gradient(to bottom, rgba(0, 0, 0, ${palette.scrimTop}) 0%, rgba(0, 0, 0, ${palette.scrimBottom}) 100%)`,
        }}
      />
    </div>
  );
}
