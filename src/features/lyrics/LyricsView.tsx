import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { usePlaybackStore } from "../../stores/playbackStore";
import { useLibraryStore } from "../../stores/libraryStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useLyricsStore } from "../../stores/lyricsStore";
import { repository } from "../../services/indexeddb/LibraryRepository";
import { DB_SCHEMA_VERSION } from "../../types";
import {
  clampLyricOffset,
  findActiveLineIndex,
  findActiveWordIndex,
  hasWordTimestamps,
  parseLyricFile,
  readLyricFileText,
} from "../../services/lyrics/lyricsService";
import type { TrackLyrics } from "../../types";
import { formatClock } from "../../utils/misc";
import { ImportIcon, LyricsIcon, OfflineIcon, WarningIcon } from "../../components/Icons";
import { MatchPickerDialog } from "./MatchPickerDialog";
import { LyricLineItem } from "./LyricLineItem";

const FONT_SIZES = {
  sm: "clamp(1.1rem, 2.6vw, 1.6rem)",
  md: "clamp(1.35rem, 3.2vw, 2.1rem)",
  lg: "clamp(1.6rem, 3.8vw, 2.7rem)",
} as const;

const FOLLOW_TRANSITION = "transform 360ms cubic-bezier(0.22, 1, 0.36, 1)";
const USER_SCROLL_IDLE_MS = 2500;

/**
 * Synchronized lyrics view (feature spec §3, §7). The audio element's current
 * time is the timing authority; rAF is used only for visual interpolation
 * while playing, and stops when paused, hidden, or unmounted — so pausing,
 * seeking, background throttling, and stalls can never make lyrics drift on
 * an independent clock.
 */
export function LyricsView() {
  const currentTrackId = usePlaybackStore((state) => state.currentTrackId);
  const track = useLibraryStore((state) => state.tracks.find((item) => item.id === currentTrackId) ?? null);
  const [lyrics, setLyrics] = useState<TrackLyrics | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [activeWordIndex, setActiveWordIndex] = useState(-1);
  const [editorOpen, setEditorOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isPlaying = usePlaybackStore((state) => state.isPlaying);
  const lyricsStyle = useSettingsStore((state) => state.prefs.lyricsStyle);
  const lyricFontSize = useSettingsStore((state) => state.prefs.lyricFontSize);
  const lyricAlignment = useSettingsStore((state) => state.prefs.lyricAlignment);
  const lyricLineSpacing = useSettingsStore((state) => state.prefs.lyricLineSpacing);
  const discoveryStatus = useLyricsStore((state) => state.status);
  const discoveryTrackId = useLyricsStore((state) => state.trackId);
  const discoveryVersion = useLyricsStore((state) => state.lyricsVersion);
  const candidates = useLyricsStore((state) => state.candidates);
  const errorMessage = useLyricsStore((state) => state.errorMessage);
  const resolveForTrack = useLyricsStore((state) => state.resolveForTrack);

  const lastUserScrollTimeRef = useRef<number>(-10000);
  const currentYRef = useRef<number>(0);
  const lastTransitionRef = useRef<string>("none");
  const prevActiveIndexRef = useRef<number>(-1);
  const touchStartYRef = useRef<number | null>(null);
  const pointerDragRef = useRef<{ active: boolean; pointerId: number; lastY: number; moved: boolean }>({
    active: false,
    pointerId: -1,
    lastY: 0,
    moved: false,
  });
  const geometryRef = useRef<{
    containerHeight: number;
    maxScroll: number;
    tops: Float64Array;
    heights: Float64Array;
  } | null>(null);

  const applyTransform = useCallback((y: number, animate: boolean) => {
    const list = listRef.current;
    const geom = geometryRef.current;
    const maxScroll = geom ? geom.maxScroll : 0;
    const clamped = Math.round(Math.max(0, maxScroll > 0 ? Math.min(maxScroll, y) : y));
    const prevY = currentYRef.current;
    currentYRef.current = clamped;
    if (list) {
      const nextTransition = animate ? FOLLOW_TRANSITION : "none";
      if (lastTransitionRef.current !== nextTransition) {
        lastTransitionRef.current = nextTransition;
        list.style.transition = nextTransition;
      }
      if (clamped !== prevY || !animate) {
        list.style.transform = `translate3d(0, -${clamped}px, 0)`;
      }
    }
  }, []);

  // Load the lyrics document whenever the track changes or discovery writes
  // a new one (lyricsVersion).
  useEffect(() => {
    let cancelled = false;
    setActiveIndex(-1);
    setActiveWordIndex(-1);
    prevActiveIndexRef.current = -1;
    lastUserScrollTimeRef.current = -10000;
    currentYRef.current = 0;
    lastTransitionRef.current = "none";
    if (listRef.current) {
      listRef.current.style.transition = "none";
      listRef.current.style.transform = "translate3d(0, 0px, 0)";
    }
    if (!currentTrackId) {
      setLyrics(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    void repository
      .getLyrics(currentTrackId)
      .then((loaded) => {
        if (!cancelled) {
          setLyrics(loaded ?? null);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLyrics(null);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [currentTrackId, discoveryVersion]);

  // Trigger discovery when the view opens for a track nothing has resolved
  // yet (covers first open and the auto-fetch setting being off at start).
  useEffect(() => {
    if (!track || loading) return;
    if (lyrics) return;
    if (discoveryTrackId === track.id && discoveryStatus !== "idle" && discoveryStatus !== "error") return;
    void resolveForTrack(track);
  }, [track, loading, lyrics, discoveryTrackId, discoveryStatus, resolveForTrack]);

  const timedLines = lyrics?.format === "lrc";
  const wordTimed = useMemo(() => (lyrics ? hasWordTimestamps(lyrics.lines) : false), [lyrics]);
  const effectiveWordTimed = wordTimed && lyricsStyle === "word";

  // Maintain line-geometry cache with zero layout reads in the hot path.
  const updateGeometryCache = useCallback(() => {
    const container = containerRef.current;
    const list = listRef.current;
    if (!container || !list || !lyrics) {
      geometryRef.current = null;
      return;
    }
    const cRect = container.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    const count = lyrics.lines.length;
    const tops = new Float64Array(count);
    const heights = new Float64Array(count);
    const children = list.children;

    for (let i = 0; i < count; i++) {
      const el = children[i] as HTMLElement | undefined;
      if (el) {
        const elRect = el.getBoundingClientRect();
        tops[i] = elRect.top - listRect.top;
        heights[i] = elRect.height;
      }
    }

    const containerHeight = container.clientHeight || cRect.height;
    const maxScroll = Math.max(0, listRect.height - containerHeight);

    geometryRef.current = {
      containerHeight,
      maxScroll,
      tops,
      heights,
    };
  }, [lyrics]);

  // Measure geometry after DOM changes or typography setting changes
  useLayoutEffect(() => {
    updateGeometryCache();
  }, [lyrics, loading, lyricFontSize, lyricLineSpacing, lyricAlignment, updateGeometryCache]);

  // Update geometry cache on container resize (debounced via rAF)
  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    let rafId = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        updateGeometryCache();
      });
    });
    observer.observe(container);
    return () => {
      cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }, [updateGeometryCache]);

  const scrollToLine = useCallback(
    (index: number, forceInstant = false) => {
      const geom = geometryRef.current;
      if (!geom || index < 0 || index >= geom.tops.length) return;

      const rawTarget = geom.tops[index] - geom.containerHeight / 2 + geom.heights[index] / 2;
      const target = Math.round(Math.max(0, geom.maxScroll > 0 ? Math.min(geom.maxScroll, rawTarget) : rawTarget));
      const distance = Math.abs(target - currentYRef.current);

      // Do not fight the user: skip auto-follow if manually scrolled in the last 2.5s
      if (!forceInstant && performance.now() - lastUserScrollTimeRef.current < USER_SCROLL_IDLE_MS) {
        return;
      }

      // Reduced motion (system or manual override) or far jumps (>1.5 viewport heights) snap instantly.
      const override = document.documentElement.dataset.motion;
      const reduced =
        override === "on" || (override !== "off" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
      const isFarJump = geom.containerHeight > 0 && distance > geom.containerHeight * 1.5;
      const snap = forceInstant || reduced || isFarJump;

      applyTransform(target, !snap);
    },
    [applyTransform],
  );

  const nudgeManualScroll = useCallback(
    (deltaY: number) => {
      lastUserScrollTimeRef.current = performance.now();
      applyTransform(currentYRef.current + deltaY, false);
    },
    [applyTransform],
  );

  const onWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      if (!lyrics) return;
      nudgeManualScroll(e.deltaY);
    },
    [lyrics, nudgeManualScroll],
  );

  const onTouchStart = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length === 1) {
      touchStartYRef.current = e.touches[0].clientY;
      lastUserScrollTimeRef.current = performance.now();
    }
  }, []);

  const onTouchMove = useCallback(
    (e: React.TouchEvent<HTMLDivElement>) => {
      if (e.touches.length === 1 && touchStartYRef.current !== null) {
        const y = e.touches[0].clientY;
        const dy = touchStartYRef.current - y;
        touchStartYRef.current = y;
        nudgeManualScroll(dy);
      }
    },
    [nudgeManualScroll],
  );

  const onTouchEnd = useCallback(() => {
    touchStartYRef.current = null;
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "touch" || e.button !== 0) return;
    pointerDragRef.current = {
      active: true,
      pointerId: e.pointerId,
      lastY: e.clientY,
      moved: false,
    };
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = pointerDragRef.current;
      if (!drag.active || drag.pointerId !== e.pointerId) return;
      const dy = drag.lastY - e.clientY;
      if (!drag.moved && Math.abs(dy) < 4) return;
      drag.moved = true;
      drag.lastY = e.clientY;
      nudgeManualScroll(dy);
    },
    [nudgeManualScroll],
  );

  const onPointerUpOrCancel = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (pointerDragRef.current.pointerId === e.pointerId) {
      pointerDragRef.current.active = false;
    }
  }, []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const geom = geometryRef.current;
      const pageStep = geom && geom.containerHeight > 0 ? geom.containerHeight * 0.8 : 300;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        nudgeManualScroll(60);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        nudgeManualScroll(-60);
      } else if (e.key === "PageDown") {
        e.preventDefault();
        nudgeManualScroll(pageStep);
      } else if (e.key === "PageUp") {
        e.preventDefault();
        nudgeManualScroll(-pageStep);
      } else if (e.key === "Home") {
        e.preventDefault();
        lastUserScrollTimeRef.current = performance.now();
        applyTransform(0, false);
      } else if (e.key === "End" && geom) {
        e.preventDefault();
        lastUserScrollTimeRef.current = performance.now();
        applyTransform(geom.maxScroll, false);
      }
    },
    [nudgeManualScroll, applyTransform],
  );

  // Keep keyboard-focused lyric buttons in view within the overflow-hidden container
  const onFocusCapture = useCallback(
    (e: React.FocusEvent<HTMLDivElement>) => {
      if (containerRef.current && containerRef.current.scrollTop !== 0) {
        containerRef.current.scrollTop = 0;
      }
      const target = e.target as HTMLElement | null;
      if (!target || typeof target.matches !== "function" || !target.matches(":focus-visible")) return;
      const indexAttr = target.getAttribute("data-line-index");
      if (indexAttr === null || indexAttr === undefined) return;
      const index = Number(indexAttr);
      const geom = geometryRef.current;
      if (!geom || Number.isNaN(index) || index < 0 || index >= geom.tops.length) return;

      const lineTop = geom.tops[index];
      const lineBottom = lineTop + geom.heights[index];
      const viewTop = currentYRef.current;
      const viewBottom = viewTop + geom.containerHeight;
      if (geom.containerHeight > 0 && (lineTop < viewTop + 24 || lineBottom > viewBottom - 24)) {
        lastUserScrollTimeRef.current = performance.now();
        const centered = lineTop - geom.containerHeight / 2 + geom.heights[index] / 2;
        applyTransform(centered, false);
      }
    },
    [applyTransform],
  );

  const rafAliveRef = useRef(0);

  // Commit the compositor transform in the exact same synchronous layout pass
  // as the activeIndex DOM update so the browser never receives two separate
  // commits on consecutive frames for a single line change.
  useLayoutEffect(() => {
    if (activeIndex >= 0) {
      const wasUnset = prevActiveIndexRef.current === -1;
      prevActiveIndexRef.current = activeIndex;
      scrollToLine(activeIndex, wasUnset && activeIndex > 0);
    } else {
      prevActiveIndexRef.current = activeIndex;
    }
  }, [activeIndex, scrollToLine]);

  // Timing loop: read the audio clock while playing. Covers seek, resume,
  // rate changes, and stalls — every frame recomputes from currentTime.
  useEffect(() => {
    if (!isPlaying || !timedLines || !lyrics) return;
    let frame = 0;
    let lastIndex = -2;
    let lastWord = -1;
    const tick = () => {
      rafAliveRef.current = Date.now();
      const engine = usePlaybackStore.getState().getEngine();
      const positionMs = engine.element ? engine.currentTimeSec * 1000 : usePlaybackStore.getState().currentTimeMs;
      const index = findActiveLineIndex(lyrics.lines, positionMs, lyrics.offsetMs);
      if (index !== lastIndex) {
        lastIndex = index;
        setActiveIndex(index);
        if (effectiveWordTimed) {
          const line = lyrics.lines[index];
          const nextWord = line && line.words ? findActiveWordIndex(line, positionMs, lyrics.offsetMs) : -1;
          lastWord = nextWord;
          setActiveWordIndex(nextWord);
        } else if (lastWord !== -1) {
          lastWord = -1;
          setActiveWordIndex(-1);
        }
      } else if (effectiveWordTimed) {
        const line = lyrics.lines[index];
        if (line?.words) {
          const wordIndex = findActiveWordIndex(line, positionMs, lyrics.offsetMs);
          if (wordIndex !== lastWord) {
            lastWord = wordIndex;
            setActiveWordIndex(wordIndex);
          }
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [isPlaying, timedLines, lyrics, effectiveWordTimed]);

  // Store-time fallback: keeps the highlighted line correct while paused or
  // ended (seeking updates the store), and when rAF is throttled in
  // unfocused/background windows while audio keeps playing — without subscribing
  // LyricsView render state to 200ms timeupdate ticks.
  useEffect(() => {
    if (!timedLines || !lyrics) return;
    const syncFromTime = (timeMs: number, playing: boolean) => {
      if (playing && Date.now() - rafAliveRef.current < 500) return;
      const nextIndex = findActiveLineIndex(lyrics.lines, timeMs, lyrics.offsetMs);
      setActiveIndex((prev) => (prev === nextIndex ? prev : nextIndex));
      if (effectiveWordTimed) {
        const line = lyrics.lines[nextIndex];
        const nextWord = line && line.words ? findActiveWordIndex(line, timeMs, lyrics.offsetMs) : -1;
        setActiveWordIndex((prev) => (prev === nextWord ? prev : nextWord));
      } else {
        setActiveWordIndex((prev) => (prev === -1 ? prev : -1));
      }
    };

    const initial = usePlaybackStore.getState();
    syncFromTime(initial.currentTimeMs, initial.isPlaying);

    return usePlaybackStore.subscribe((state) => {
      syncFromTime(state.currentTimeMs, state.isPlaying);
    });
  }, [timedLines, lyrics, effectiveWordTimed]);

  const seekToLine = useCallback(
    (index: number) => {
      if (pointerDragRef.current.moved) {
        pointerDragRef.current.moved = false;
        return;
      }
      if (!lyrics || !timedLines) return;
      const line = lyrics.lines[index];
      if (!line || line.timeMs === null) return;
      lastUserScrollTimeRef.current = -10000;
      usePlaybackStore.getState().seek(Math.max(0, line.timeMs + lyrics.offsetMs));
    },
    [lyrics, timedLines],
  );

  const adjustOffset = async (deltaMs: number) => {
    if (!lyrics || !currentTrackId) return;
    const next = clampLyricOffset(lyrics.offsetMs + deltaMs);
    const updated = { ...lyrics, offsetMs: next, updatedAt: Date.now() };
    setLyrics(updated);
    try {
      await repository.putLyrics(updated);
    } catch {
      return;
    }
    // Re-evaluate immediately under the new offset.
    const positionMs = usePlaybackStore.getState().currentTimeMs;
    setActiveIndex(findActiveLineIndex(updated.lines, positionMs, next));
  };

  const importLyricFile = async (file: File) => {
    if (!currentTrackId) {
      return;
    }
    const isLrc = /\.lrc$/i.test(file.name);
    const isTxt = /\.txt$/i.test(file.name);
    if (!isLrc && !isTxt) {
      return;
    }
    try {
      const text = await readLyricFileText(file);
      const existing = await repository.getLyrics(currentTrackId);
      const parsed = parseLyricFile(currentTrackId, file.name, text);
      const withOrigin: TrackLyrics = {
        ...parsed.lyrics,
        offsetMs: existing?.offsetMs ?? 0,
        origin: {
          kind: "manual",
          recordId: null,
          fetchedAt: Date.now(),
          capability:
            parsed.lyrics.format === "lrc" && hasWordTimestamps(parsed.lyrics.lines)
              ? "word"
              : parsed.lyrics.format === "lrc"
                ? "line"
                : "plain",
        },
        schemaVersion: DB_SCHEMA_VERSION,
      };
      await repository.putLyrics(withOrigin);
      await repository.putLyricsCacheMeta({
        trackId: currentTrackId,
        status: "accepted",
        checkedAt: Date.now(),
        recordId: null,
        schemaVersion: DB_SCHEMA_VERSION,
      });
      setLyrics(withOrigin);
      useLyricsStore.setState({ trackId: currentTrackId, status: "ready", fromCache: true, candidates: [] });
    } catch {
      // Reading or parsing failed; keep prior state.
    }
  };

  if (!track) {
    return (
      <div className="grid h-full place-items-center text-sm text-text-muted">Play a song to see its lyrics here.</div>
    );
  }

  const alignClass = lyricAlignment === "center" ? "text-center mx-auto" : "text-left";
  const checking = discoveryTrackId === track.id && discoveryStatus === "checking";
  const showPickerTrigger = discoveryTrackId === track.id && discoveryStatus === "needs-selection" && candidates.length > 0;
  const isInstrumental = lyrics?.origin?.capability === "instrumental";
  const sourceBadge = lyrics?.origin
    ? lyrics.origin.kind === "lrclib" || lyrics.origin.kind === "lrcmux"
      ? "lrcmux"
      : "Manual import"
    : null;
  const capabilityBadge =
    lyrics?.origin?.capability === "word"
      ? "word sync"
      : lyrics?.origin?.capability === "line" || (timedLines && lyrics)
        ? "line sync"
        : isInstrumental
          ? "instrumental"
          : "plain text";

  return (
    <div className="group/lyrics relative flex h-full min-h-0 flex-col">
      {/* Body — the top area stays completely clean */}
      {loading ? (
        <div className="grid flex-1 place-items-center text-sm text-text-muted">Loading…</div>
      ) : isInstrumental ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
          <div className="grid size-14 place-items-center rounded-2xl bg-surface-raised text-text-muted" aria-hidden>
            <LyricsIcon size={24} />
          </div>
          <p className="text-sm font-medium text-text-primary">Instrumental</p>
          <p className="max-w-sm text-xs text-text-secondary">
            This track is registered as instrumental on lrcmux — there are no lyrics to show.
          </p>
        </div>
      ) : !lyrics ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <div className="grid size-14 place-items-center rounded-2xl bg-surface-raised text-text-muted" aria-hidden>
            <LyricsIcon size={24} />
          </div>
          <div>
            <p className="text-sm font-medium text-text-primary">
              {checking
                ? "Searching lrcmux…"
                : discoveryTrackId === track.id && discoveryStatus === "error"
                  ? "Couldn’t load lyrics"
                  : discoveryTrackId === track.id && discoveryStatus === "offline"
                    ? "Offline — nothing cached for this song"
                    : "No lyrics yet"}
            </p>
            <p className="mt-1 max-w-sm text-xs text-text-secondary">
              Import an <code>.lrc</code> file with timestamps for synced lyrics, or a <code>.txt</code> for plain text.
              Online, matching lyrics from lrcmux are found automatically.
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-lg bg-accent-strong px-4 py-2 text-sm font-medium text-accent-contrast"
              onClick={() => fileInputRef.current?.click()}
            >
              <ImportIcon size={15} />
              Import lyrics
            </button>
            {showPickerTrigger && (
              <button
                type="button"
                className="inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-surface-hover"
                style={{ borderColor: "var(--border-strong)" }}
                onClick={() => setPickerOpen(true)}
              >
                Choose match ({candidates.length})
              </button>
            )}
            {(discoveryStatus === "error" || discoveryStatus === "not-found") && discoveryTrackId === track.id && (
              <button
                type="button"
                className="rounded-lg border px-4 py-2 text-sm text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
                style={{ borderColor: "var(--border-subtle)" }}
                onClick={() => void useLyricsStore.getState().retry(track)}
              >
                Try again
              </button>
            )}
          </div>
        </div>
      ) : (
        <div
          ref={containerRef}
          tabIndex={0}
          onWheel={onWheel}
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          onTouchCancel={onTouchEnd}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUpOrCancel}
          onPointerCancel={onPointerUpOrCancel}
          onKeyDown={onKeyDown}
          onFocusCapture={onFocusCapture}
          className="min-h-0 flex-1 overflow-hidden pr-1 focus:outline-none"
          style={{
            lineHeight: lyricLineSpacing,
            contain: "layout paint style",
          }}
          role={timedLines ? "list" : undefined}
          aria-label={timedLines ? "Synced lyrics" : "Lyrics"}
        >
          <div
            ref={listRef}
            className={`flex flex-col gap-[0.65em] py-[30vh] ${alignClass}`}
            style={{
              maxWidth: "46rem",
              willChange: "transform",
              backfaceVisibility: "hidden",
            }}
          >
            {lyrics.lines.map((line, index) => (
              <LyricLineItem
                key={index}
                index={index}
                line={line}
                isActive={index === activeIndex}
                activeWordIndex={activeWordIndex}
                timedLines={timedLines}
                lyricsStyle={lyricsStyle}
                fontSize={FONT_SIZES[lyricFontSize]}
                onSeek={seekToLine}
              />
            ))}
          </div>
        </div>
      )}

      {/* Hover/focus-revealed control strip — invisible during normal listening,
          all actions stay reachable (spec §5: accessible without cluttering). */}
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex justify-center px-4 pb-2 opacity-0 transition-opacity duration-150 group-focus-within/lyrics:pointer-events-auto group-focus-within/lyrics:opacity-100 group-hover/lyrics:pointer-events-auto group-hover/lyrics:opacity-100"
      >
        <div
          className="flex max-w-full flex-wrap items-center justify-center gap-x-2 gap-y-1 rounded-full border bg-surface-raised px-4 py-1.5 text-xs shadow-[var(--shadow-overlay)]"
          style={{ borderColor: "var(--border-subtle)" }}
        >
          <span className="flex min-w-0 items-center gap-1.5 text-text-muted">
            {checking ? (
              <span className="animate-pulse">Finding lyrics on lrcmux…</span>
            ) : lyrics ? (
              <>
                <span>
                  {isInstrumental
                    ? "Instrumental"
                    : timedLines
                      ? `Synced lyrics · ${capabilityBadge}`
                      : "Plain text — not synchronized"}
                </span>
                {sourceBadge && (
                  <span className="rounded-full border px-2 py-0.5" style={{ borderColor: "var(--border-subtle)" }}>
                    {sourceBadge}
                  </span>
                )}
                {lyrics && lyrics.skippedLines > 0 && timedLines && (
                  <span className="flex items-center gap-1" role="note">
                    <WarningIcon size={12} />
                    {lyrics.skippedLines} line{lyrics.skippedLines === 1 ? "" : "s"} skipped
                  </span>
                )}
              </>
            ) : discoveryTrackId === track.id && discoveryStatus === "offline" ? (
              <span className="flex items-center gap-1">
                <OfflineIcon size={12} />
                Offline — not saved on this device
              </span>
            ) : discoveryTrackId === track.id && discoveryStatus === "error" ? (
              <span className="text-danger">{errorMessage ?? "Lyrics lookup failed"}</span>
            ) : (
              <span>No lyrics for this song yet</span>
            )}
          </span>

          {lyrics && timedLines && (
            <>
              {lyrics.offsetMs !== 0 && (
                <span className="rounded-full border px-2 py-0.5 text-text-muted" style={{ borderColor: "var(--border-subtle)" }}>
                  offset {(lyrics.offsetMs / 1000).toFixed(1)}s
                </span>
              )}
              <button
                type="button"
                className="rounded-lg border px-2 py-0.5 text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
                style={{ borderColor: "var(--border-subtle)" }}
                aria-label="Shift lyrics half a second earlier"
                onClick={() => void adjustOffset(-500)}
              >
                −0.5s
              </button>
              <button
                type="button"
                className="rounded-lg border px-2 py-0.5 text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
                style={{ borderColor: "var(--border-subtle)" }}
                aria-label="Shift lyrics half a second later"
                onClick={() => void adjustOffset(500)}
              >
                +0.5s
              </button>
              {lyrics.offsetMs !== 0 && (
                <button
                  type="button"
                  className="rounded-lg px-1.5 py-0.5 text-accent hover:underline"
                  onClick={() => void adjustOffset(-lyrics.offsetMs)}
                >
                  Reset
                </button>
              )}
            </>
          )}

          <input
            ref={fileInputRef}
            type="file"
            accept=".lrc,.txt"
            className="hidden"
            aria-hidden
            tabIndex={-1}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void importLyricFile(file);
            }}
          />
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-lg px-2 py-0.5 text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
            onClick={() => fileInputRef.current?.click()}
          >
            <ImportIcon size={12} />
            Import
          </button>
          {lyrics && (
            <>
              <button
                type="button"
                className="rounded-lg px-2 py-0.5 text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
                onClick={() => setEditorOpen((open) => !open)}
                aria-expanded={editorOpen}
              >
                Edit
              </button>
              <button
                type="button"
                className="rounded-lg px-2 py-0.5 text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
                onClick={() => void useLyricsStore.getState().searchAgain(track)}
                title="Search lrcmux again for this song"
              >
                Search again
              </button>
            </>
          )}
          {(discoveryStatus === "error" || discoveryStatus === "not-found") && discoveryTrackId === track.id && (
            <button
              type="button"
              className="rounded-lg bg-accent-strong px-2.5 py-0.5 font-medium text-accent-contrast"
              onClick={() => void useLyricsStore.getState().retry(track)}
            >
              Try again
            </button>
          )}
          {showPickerTrigger && (
            <button
              type="button"
              className="rounded-lg bg-accent-strong px-2.5 py-0.5 font-medium text-accent-contrast"
              onClick={() => setPickerOpen(true)}
            >
              Choose match ({candidates.length})
            </button>
          )}
        </div>
      </div>

      {editorOpen && lyrics && <LyricQuickEditor lyrics={lyrics} onSaved={(updated) => setLyrics(updated)} />}

      <MatchPickerDialog
        open={pickerOpen && showPickerTrigger}
        trackTitle={track.title}
        candidates={candidates}
        onPick={(candidate) => {
          setPickerOpen(false);
          void useLyricsStore.getState().pickCandidate(candidate);
        }}
        onDismiss={() => setPickerOpen(false)}
      />
    </div>
  );
}

/** Minimal lyric text/timestamp editor. */
function LyricQuickEditor({ lyrics, onSaved }: { lyrics: TrackLyrics; onSaved: (updated: TrackLyrics) => void }) {
  const [value, setValue] = useState(() =>
    lyrics.lines
      .map((line) => (line.timeMs !== null ? `[${formatClock(line.timeMs)}] ${line.text}` : line.text))
      .join("\n"),
  );
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const parsed = parseLyricFile(lyrics.trackId, lyrics.sourceName, value);
      const updated = { ...parsed.lyrics, offsetMs: lyrics.offsetMs, origin: lyrics.origin, schemaVersion: DB_SCHEMA_VERSION };
      await repository.putLyrics(updated);
      onSaved(updated);
    } catch {
      // Leave the editor open with the user's text intact on failure.
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-4 rounded-xl border p-3" style={{ borderColor: "var(--border-subtle)", background: "var(--surface)" }}>
      <label className="mb-1.5 block text-xs text-text-secondary" htmlFor="lyric-editor">
        Quick editor — one line per lyric; use [m:ss] timestamps for sync
      </label>
      <textarea
        id="lyric-editor"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        rows={8}
        spellCheck={false}
        className="w-full resize-y rounded-lg border bg-transparent p-2.5 font-mono text-xs outline-none focus:border-accent"
        style={{ borderColor: "var(--border-subtle)" }}
      />
      <div className="mt-2 flex justify-end gap-2">
        <button
          type="button"
          className="rounded-lg bg-accent-strong px-3 py-1.5 text-xs font-medium text-accent-contrast disabled:opacity-50"
          onClick={() => void save()}
          disabled={saving}
        >
          Save lyrics
        </button>
      </div>
    </div>
  );
}
