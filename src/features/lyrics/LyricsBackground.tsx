import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { Track } from "../../types";
import { useArtworkUrl } from "../../components/Artwork";
import { useSettingsStore } from "../../stores/settingsStore";
import { usePlaybackStore } from "../../stores/playbackStore";
import { useLibraryStore } from "../../stores/libraryStore";
import { nextIndex } from "../player/queue";
import {
  createFallbackPalette,
  extractPaletteFromImageUrl,
  getCachedPalette,
  scheduleNextTrackPrecompute,
  type LyricsPalette,
} from "./palette";
import "./lyricsBackground.css";

const GRAIN_DATA_URL =
  "data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)'/%3E%3C/svg%3E";

type LayerState = {
  palette: LyricsPalette;
  key: string;
};

type LyricsBackgroundProps = {
  track: Track | null | undefined;
  isPlaying: boolean;
};

export function LyricsBackground({ track, isPlaying }: LyricsBackgroundProps) {
  const artworkUrl = useArtworkUrl(track);
  const trackId = track?.id ?? "none";
  const coverKey = track?.album ? `${track.album}-${track.artist}` : trackId;

  // Settings & motion preferences
  const animatedBgSetting = useSettingsStore(
    (state) => state.prefs.animatedLyricsBackground ?? true,
  );
  const reducedMotionSetting = useSettingsStore((state) => state.prefs.reducedMotion);

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
  const [lowPowerMode, setLowPowerMode] = useState(false);
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

  // Low power detection: Battery API + frame drops
  useEffect(() => {
    let unmounted = false;

    // Check battery level if available
    type BatteryManager = {
      level: number;
      charging: boolean;
      addEventListener: (type: string, listener: () => void) => void;
      removeEventListener: (type: string, listener: () => void) => void;
    };
    const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryManager> };

    if (typeof nav.getBattery === "function") {
      void nav.getBattery().then((battery) => {
        if (unmounted) return;
        const checkBattery = () => {
          if (battery.level <= 0.2 && !battery.charging) {
            setLowPowerMode(true);
          } else {
            setLowPowerMode(false);
          }
        };
        checkBattery();
        battery.addEventListener("levelchange", checkBattery);
        battery.addEventListener("chargingchange", checkBattery);
      }).catch(() => {
        // Battery API not supported or rejected
      });
    }

    // Frame-drop monitor for low-end devices (hardwareConcurrency <= 4)
    if (typeof navigator !== "undefined" && (navigator.hardwareConcurrency ?? 8) <= 4) {
      let consecutiveSlowFrames = 0;
      let lastTime = performance.now();
      let rafId = 0;

      const checkFrame = (now: number) => {
        const delta = now - lastTime;
        lastTime = now;
        if (delta > 25) {
          consecutiveSlowFrames++;
          if (consecutiveSlowFrames >= 60) {
            // Sustained slow frames for >1.5-2 seconds -> switch to static mode
            setLowPowerMode(true);
            return;
          }
        } else {
          consecutiveSlowFrames = Math.max(0, consecutiveSlowFrames - 1);
        }
        rafId = requestAnimationFrame(checkFrame);
      };

      rafId = requestAnimationFrame(checkFrame);
      return () => {
        unmounted = true;
        cancelAnimationFrame(rafId);
      };
    }

    return () => {
      unmounted = true;
    };
  }, []);

  // Load and apply new palette on artwork or track change with crossfade
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

    if (artworkUrl) {
      void extractPaletteFromImageUrl(artworkUrl, coverKey).then((palette) => {
        applyPalette(palette);
      });
    } else {
      applyPalette(createFallbackPalette(coverKey));
    }

    return () => {
      cancelled = true;
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

  // Overall pause decision
  const isPaused =
    !animatedBgSetting ||
    isMotionReduced ||
    tabHidden ||
    playbackPaused3s ||
    lowPowerMode;

  return (
    <div
      className={`lyrics-bg-container ${isPaused ? "lyrics-bg-paused" : ""}`}
      aria-hidden="true"
    >
      {/* Layer A */}
      <LayerInstance
        state={layerA}
        active={activeLayer === "A"}
        isStatic={isMotionReduced || !animatedBgSetting}
      />

      {/* Layer B (only mounted when crossfading) */}
      {layerB && (
        <LayerInstance
          state={layerB}
          active={activeLayer === "B"}
          isStatic={isMotionReduced || !animatedBgSetting}
        />
      )}

      {/* Grain noise overlay at 3.5% opacity (PRD §3.1) */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.035]"
        style={{
          backgroundImage: `url("${GRAIN_DATA_URL}")`,
          backgroundRepeat: "repeat",
        }}
      />
    </div>
  );
}

function LayerInstance({
  state,
  active,
  isStatic,
}: {
  state: LayerState;
  active: boolean;
  isStatic: boolean;
}) {
  const { palette } = state;
  const { presetConfig } = palette;

  // Blob CSS custom properties
  const layerStyle: CSSProperties = {
    opacity: active ? 1 : 0,
    transition: "opacity 900ms ease-in-out",
    backgroundColor: palette.baseColor,
    willChange: "opacity",
    // Type casting CSS variables for React
    ["--blob-1" as string]: palette.blobColors[0],
    ["--blob-2" as string]: palette.blobColors[1],
    ["--blob-3" as string]: palette.blobColors[2],
    ["--blob-4" as string]: palette.blobColors[3],
    ["--blob-duration" as string]: `${presetConfig.duration}s`,
  };

  const blobOpacity = presetConfig.blobOpacity;
  const is3Blobs = presetConfig.blobCount === 3;

  return (
    <div className="absolute inset-0 overflow-hidden" style={layerStyle}>
      {/* Base solid background */}
      <div
        className="absolute inset-0"
        style={{ backgroundColor: palette.baseColor }}
      />

      {/* Static blur container (PRD §2.3: filter: blur() applied once on container) */}
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

      {/* Scrim: vertical gradient overlay for guaranteed text legibility (PRD §3.1) */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background: `linear-gradient(to bottom, rgba(0, 0, 0, ${palette.scrimTop}) 0%, rgba(0, 0, 0, ${palette.scrimBottom}) 100%)`,
        }}
      />
    </div>
  );
}
