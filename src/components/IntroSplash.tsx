import { useEffect, useState, type CSSProperties } from "react";
import { APP_NAME } from "../types";
import "./IntroSplash.css";

/**
 * IntroSplash — one-shot motion intro on cold app start.
 *
 * Mounted once above the router, so route navigation never replays it. It is
 * purely presentational: no stores, no network, no timers owned outside this
 * component, and it never blocks app initialization (stores boot in parallel).
 *
 * Choreography (2.5s, then a 340ms handoff fade into the running app):
 *   0.00–0.60s  a minimal waveform appears and drifts horizontally
 *   0.60–1.50s  three waveform elements glide into the exact geometry of the
 *               official mark (public/icons/icon.svg), the remaining bars
 *               dissolve inward, and the beam completes the note
 *   1.50–2.10s  the wordmark reveals (opacity + horizontal movement)
 *   2.10–2.50s  the lockup settles into its final composition
 *
 * The final frame is pixel-identical to the official mark: a 26×26 rect with
 * rx=13 is a circle, so the two waveform "dots" scale ×4 into the 104px note
 * heads, and the 26×200 bar translates onto the stem. Only transform and
 * opacity are animated.
 */

/** Length of the choreography before the handoff fade begins. */
const PLAY_MS = 2500;
/** Handoff fade duration; the overlay unmounts when it completes. */
const EXIT_MS = 340;
/** Per-bar stagger so the waveform rises and gathers left → right. */
const BAR_STAGGER_MS = 40;

/** Mark color from the official icon asset (public/icons/icon.svg). */
const MARK_COLOR = "#8da8ff";
/** Vertical center of the waveform line = vertical center of the mark. */
const WAVE_CENTER_Y = 241;

type WaveBar = {
  /** Left edge in the official icon's 512-unit coordinate space. */
  x: number;
  /** Resting waveform height (26 = the dots that become the note heads). */
  h: number;
  /** Final glide: translate + scale, in icon units. */
  tx: number;
  ty: number;
  sx: number;
  sy: number;
  /** End opacity: 1 for bars that become the mark, 0 for dissolving bars. */
  fade: number;
};

const WAVE_BARS: WaveBar[] = [
  { x: 118, h: 132, tx: 100, ty: 0, sx: 1, sy: 0.25, fade: 0 },
  { x: 174, h: 78, tx: 68, ty: 0, sx: 1, sy: 0.25, fade: 0 },
  // Becomes the lower note head: circle r52 at (248, 318) in icon.svg.
  { x: 230, h: 26, tx: 5, ty: 77, sx: 4, sy: 4, fade: 1 },
  // Becomes the stem: rect(296, 112, 26×200) in icon.svg.
  { x: 286, h: 200, tx: 10, ty: -29, sx: 1, sy: 1, fade: 1 },
  // Becomes the upper note head: circle r52 at (350, 292) in icon.svg.
  { x: 342, h: 26, tx: -5, ty: 51, sx: 4, sy: 4, fade: 1 },
  { x: 398, h: 118, tx: -68, ty: 0, sx: 1, sy: 0.25, fade: 0 },
  { x: 454, h: 164, tx: -100, ty: 0, sx: 1, sy: 0.25, fade: 0 },
];

/**
 * Same effective-motion rule as base.css and DynamicIslandNotification:
 * data-motion="on" forces reduction, data-motion="off" overrides the OS
 * preference. Read once at boot — the splash never re-renders on setting
 * changes (the settings screen is unreachable behind it).
 */
function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return true;
  const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  const attr = document.documentElement.dataset.motion;
  return attr === "on" || (attr !== "off" && Boolean(media?.matches));
}

type Phase = "play" | "exit" | "done";

export function IntroSplash() {
  const [phase, setPhase] = useState<Phase>(() => (prefersReducedMotion() ? "done" : "play"));

  // Phase chain: play → (2.5s) → exit → (340ms) → done/unmount. The effect
  // re-arms per phase and its cleanup keeps StrictMode symmetric.
  useEffect(() => {
    if (phase === "done") return;
    const timer = window.setTimeout(
      () => setPhase((current) => (current === "play" ? "exit" : "done")),
      phase === "play" ? PLAY_MS : EXIT_MS,
    );
    return () => window.clearTimeout(timer);
  }, [phase]);

  // Escape skips even though the splash is not focusable (decorative overlay).
  useEffect(() => {
    if (phase !== "play") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPhase("exit");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [phase]);

  if (phase === "done") return null;

  return (
    <div
      className="intro-splash"
      data-phase={phase}
      role="presentation"
      aria-hidden="true"
      onPointerDown={() => {
        if (phase === "play") setPhase("exit");
      }}
    >
      <div className="intro-lockup">
        {/* Tight viewBox around the official mark bounds (196,112 → 402,370);
            the waveform extends past it, so the svg must not clip. */}
        <svg className="intro-mark" viewBox="196 112 206 258" aria-hidden="true" focusable="false">
          <g fill={MARK_COLOR}>
            <g className="intro-wave">
              {WAVE_BARS.map((bar, index) => (
                <rect
                  key={bar.x}
                  className="intro-bar"
                  x={bar.x}
                  y={WAVE_CENTER_Y - bar.h / 2}
                  width={26}
                  height={bar.h}
                  rx={13}
                  style={
                    {
                      animationDelay: `${index * BAR_STAGGER_MS}ms`,
                      "--tx": `${bar.tx}px`,
                      "--ty": `${bar.ty}px`,
                      "--sx": String(bar.sx),
                      "--sy": String(bar.sy),
                      "--fade": String(bar.fade),
                    } as CSSProperties
                  }
                />
              ))}
            </g>
            {/* Beam from the official mark; slides in from the stem side. */}
            <path className="intro-beam" d="M322 118l-118 26v40l118-26z" />
          </g>
        </svg>
        {/* Same wordmark treatment as the app shell (APP_NAME, semibold). */}
        <span className="intro-wordmark">{APP_NAME}</span>
      </div>
    </div>
  );
}
