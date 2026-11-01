import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { usePlaybackStore } from "../../stores/playbackStore";
import { useLibraryStore } from "../../stores/libraryStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useLyricsStore } from "../../stores/lyricsStore";
import { repository } from "../../services/indexeddb/LibraryRepository";
import { DB_SCHEMA_VERSION } from "../../types";
import {
  clampLyricOffset,
  hasWordTimestamps,
  parseLyricFile,
  readLyricFileText,
} from "../../services/lyrics/lyricsService";
import type { TrackLyrics } from "../../types";
import { formatClock } from "../../utils/misc";
import { detectLyricsCapability } from "../../services/lyrics/capability";
import { toAmllLines } from "../../services/lyrics/amllAdapter";
import { ImportIcon, LyricsIcon, OfflineIcon, WarningIcon } from "../../components/Icons";
import { MatchPickerDialog } from "./MatchPickerDialog";
import { LyricLineItem } from "./LyricLineItem";

// The AMLL renderer (and its stylesheet) is its own chunk, fetched only when
// a timed lyrics document is actually shown.
const AmllLyricPlayer = lazy(() => import("./AmllLyricPlayer"));

const FONT_SIZES = {
  sm: "clamp(1.1rem, 2.6vw, 1.6rem)",
  md: "clamp(1.35rem, 3.2vw, 2.1rem)",
  lg: "clamp(1.6rem, 3.8vw, 2.7rem)",
} as const;

const FOLLOW_TRANSITION = "transform 360ms cubic-bezier(0.22, 1, 0.36, 1)";

/**
 * Lyrics view (feature spec §3, §7). Timed lyrics are rendered and animated by
 * the AMLL player (AmllLyricPlayer), fed imperatively from the audio element's
 * clock — the timing authority — so pausing, seeking, background throttling,
 * and stalls can never make lyrics drift on an independent clock. Plain and
 * instrumental results keep this view's own static UI.
 */
export function LyricsView() {
  const currentTrackId = usePlaybackStore((state) => state.currentTrackId);
  const track = useLibraryStore((state) => state.tracks.find((item) => item.id === currentTrackId) ?? null);
  const [lyrics, setLyrics] = useState<TrackLyrics | null>(null);
  const [loading, setLoading] = useState(false);
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
  const discoveryPhase = useLyricsStore((state) => state.phase);
  const discoveryTrackId = useLyricsStore((state) => state.trackId);
  const discoveryVersion = useLyricsStore((state) => state.lyricsVersion);
  const candidates = useLyricsStore((state) => state.candidates);
  const errorMessage = useLyricsStore((state) => state.errorMessage);
  const resolveForTrack = useLyricsStore((state) => state.resolveForTrack);

  const currentYRef = useRef<number>(0);
  const lastTransitionRef = useRef<string>("none");
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
  // Errors stay terminal — auto re-triggering from here would loop
  // checking→error forever; the "Try again" button retries on purpose.
  useEffect(() => {
    if (!track || loading) return;
    if (lyrics) return;
    if (discoveryTrackId === track.id && discoveryStatus !== "idle") return;
    void resolveForTrack(track);
  }, [track, loading, lyrics, discoveryTrackId, discoveryStatus, resolveForTrack]);

  const timedLines = lyrics?.format === "lrc";

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

  const nudgeManualScroll = useCallback(
    (deltaY: number) => {
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
        applyTransform(0, false);
      } else if (e.key === "End" && geom) {
        e.preventDefault();
        applyTransform(geom.maxScroll, false);
      }
    },
    [nudgeManualScroll, applyTransform],
  );

  // Keep the overflow-hidden container from scrolling natively when focus moves inside it.
  const onFocusCapture = useCallback(() => {
    if (containerRef.current && containerRef.current.scrollTop !== 0) {
      containerRef.current.scrollTop = 0;
    }
  }, []);

  // Click on a timed line (reported by the AMLL player as an audio-clock
  // position with the offset applied) seeks the actual playback engine.
  const seekToAudioMs = useCallback((audioMs: number) => {
    usePlaybackStore.getState().seek(audioMs);
  }, []);

  const adjustOffset = async (deltaMs: number) => {
    if (!lyrics || !currentTrackId) return;
    const next = clampLyricOffset(lyrics.offsetMs + deltaMs);
    const updated = { ...lyrics, offsetMs: next, updatedAt: Date.now() };
    // The player re-syncs from the new offset immediately; the stored lines
    // are shared by reference and never rewritten.
    setLyrics(updated);
    try {
      await repository.putLyrics(updated);
    } catch {
      return;
    }
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

  // Capability is read from the actual payload — never from provider flags —
  // so the UI never implies synchronization the data cannot deliver.
  const payloadCapability = useMemo(() => (lyrics ? detectLyricsCapability(lyrics) : null), [lyrics]);

  // Converted once per lyric lines + style + track duration. The offset is not
  // an input: it is applied to the player clock, so nudging it never rebuilds lines.
  const lyricLines = lyrics?.lines ?? null;
  const trackDurationMs = track?.durationMs ?? null;
  const amllLines = useMemo(
    () => (lyricLines && timedLines ? toAmllLines({ lines: lyricLines }, { style: lyricsStyle, durationMs: trackDurationMs }) : []),
    [lyricLines, timedLines, lyricsStyle, trackDurationMs],
  );

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
    payloadCapability === "word"
      ? "word sync"
      : payloadCapability === "line"
        ? "line sync"
        : payloadCapability === "instrumental"
          ? "instrumental"
          : payloadCapability === "plain"
            ? "plain text"
            : "no content";
  // Honesty hint: the word-by-word preference is saved, but this song's data
  // cannot deliver it — say so instead of silently doing nothing.
  const wordStyleInactive = lyricsStyle === "word" && payloadCapability === "line";

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
                ? discoveryPhase === "identifying"
                  ? "Identifying track…"
                  : discoveryPhase === "validating"
                    ? "Validating lyrics…"
                    : "Searching lyrics…"
                : discoveryTrackId === track.id && discoveryStatus === "error"
                  ? "Couldn’t load lyrics"
                  : discoveryTrackId === track.id && discoveryStatus === "offline"
                    ? "Offline — nothing cached for this song"
                    : discoveryTrackId === track.id && discoveryStatus === "not-found"
                      ? "No reliable match found"
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
      ) : timedLines ? (
        <div className="min-h-0 flex-1" aria-label="Synced lyrics">
          <Suspense fallback={<div className="grid h-full place-items-center text-sm text-text-muted">Loading…</div>}>
            <AmllLyricPlayer
              lines={amllLines}
              offsetMs={lyrics.offsetMs}
              isPlaying={isPlaying}
              fontSize={FONT_SIZES[lyricFontSize]}
              onSeek={seekToAudioMs}
            />
          </Suspense>
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
          aria-label="Lyrics"
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
              <LyricLineItem key={index} line={line} fontSize={FONT_SIZES[lyricFontSize]} />
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
              <span className="animate-pulse">
                {discoveryPhase === "identifying"
                  ? "Identifying track…"
                  : discoveryPhase === "validating"
                    ? "Validating lyrics…"
                    : "Searching lyrics…"}
              </span>
            ) : lyrics ? (
              <>
                <span>
                  {isInstrumental
                    ? "Instrumental"
                    : timedLines
                      ? `Synced lyrics · ${capabilityBadge}`
                      : "Plain text — not synchronized"}
                </span>
                {wordStyleInactive && (
                  <span className="rounded-full border px-2 py-0.5" style={{ borderColor: "var(--border-subtle)" }} role="note">
                    word style inactive — line sync only
                  </span>
                )}
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
            ) : discoveryTrackId === track.id && discoveryStatus === "not-found" ? (
              <span>No reliable match found</span>
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
