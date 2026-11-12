import { useEffect, useState } from "react";
import "./IntroSplash.css";

/**
 * IntroSplash — one-shot logo reveal on cold app start.
 *
 * Mounted once above the router, so route navigation never replays it. It is
 * purely presentational: no stores, no network, no timers owned outside this
 * component, and it never blocks app initialization (stores boot in parallel
 * underneath the overlay, so the app is already rendered when the intro hands
 * off).
 *
 * Choreography (matches the approved 4.0s reference timeline):
 *   0.000–0.375s  solid black screen
 *   0.375–1.250s  progressive left→right reveal of the mark through a clip
 *                 mask — constant speed with an ease-out tail near completion
 *   1.250–3.750s  static logo hold (the mark never moves, scales or distorts)
 *   3.750–4.000s  overlay fades out, revealing the already-rendered app
 *
 * The mark reuses the exact geometry of the official asset
 * (public/icons/icon.svg, mark bounds viewBox "196 112 206 258") and its
 * original color. No text, no additional effects.
 */

/** Black-screen lead-in before the reveal starts. */
const BLACK_MS = 375;
/** Reveal duration: 0.375s → 1.25s in the reference timeline. */
const REVEAL_MS = 875;
/** Static hold after the reveal completes. */
const HOLD_MS = 2500;
/** Handoff fade; the overlay unmounts when it completes. */
const EXIT_MS = 250;
/** Total overlay lifetime before the exit fade begins. */
const PLAY_MS = BLACK_MS + REVEAL_MS + HOLD_MS;

/** Mark color from the official icon asset (public/icons/icon.svg). */
const MARK_COLOR = "#8da8ff";

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

  // Phase chain: play → (3.75s) → exit → (250ms) → done/unmount. The effect
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
      {/* Exact mark geometry of the official icon asset (public/icons/icon.svg),
          without the icon background. The reveal mask lives in CSS. */}
      <svg className="intro-mark" viewBox="196 112 206 258" aria-hidden="true" focusable="false">
        <g fill={MARK_COLOR}>
          <path d="M322 118l-118 26v40l118-26z" />
          <rect x="296" y="112" width="26" height="200" rx="13" />
          <circle cx="248" cy="318" r="52" />
          <circle cx="350" cy="292" r="52" />
        </g>
      </svg>
    </div>
  );
}
