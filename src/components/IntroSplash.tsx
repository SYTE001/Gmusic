import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import "./IntroSplash.css";

export const INTRO_SPLASH_STORAGE_KEY = "gmusic:intro-splash-seen";
export const INTRO_EXIT_START_MS = 2100;
export const INTRO_EXIT_DURATION_MS = 600;
export const INTRO_TOTAL_DURATION_MS = INTRO_EXIT_START_MS + INTRO_EXIT_DURATION_MS;
export const INTRO_REDUCED_MOTION_HOLD_MS = 350;
export const INTRO_REDUCED_MOTION_EXIT_MS = 200;

export type IntroSplashPhase = "active" | "exiting" | "done";

export interface IntroSplashProps {
  /** Called once the exit transition finishes and the splash unmounts. */
  onComplete?: () => void;
  /** Called as soon as the exit transition begins (at 2.1s or when skipped). */
  onExitStart?: () => void;
  /** Ignore sessionStorage and always play the intro splash when mounted. */
  forceShow?: boolean;
}

const BRAND_CHARS = [
  { char: "G", accent: true, delayMs: 560 },
  { char: "m", accent: false, delayMs: 620 },
  { char: "u", accent: false, delayMs: 675 },
  { char: "s", accent: false, delayMs: 730 },
  { char: "i", accent: false, delayMs: 785 },
  { char: "c", accent: false, delayMs: 840 },
] as const;

function hasSeenSplashInSession(): boolean {
  try {
    return window.sessionStorage.getItem(INTRO_SPLASH_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function markSplashSeenInSession(): void {
  try {
    window.sessionStorage.setItem(INTRO_SPLASH_STORAGE_KEY, "1");
  } catch {
    // Ignore storage quota or privacy-mode exceptions.
  }
}

function prefersReducedMotion(): boolean {
  try {
    if (typeof window === "undefined") return false;
    const attr = document.documentElement?.dataset?.motion;
    if (attr === "on") return true;
    if (attr === "off") return false;
    return (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  } catch {
    return false;
  }
}

export function IntroSplash({ onComplete, onExitStart, forceShow = false }: IntroSplashProps) {
  const [phase, setPhase] = useState<IntroSplashPhase>(() => {
    if (!forceShow && hasSeenSplashInSession()) {
      return "done";
    }
    return "active";
  });

  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  const onExitStartRef = useRef(onExitStart);
  onExitStartRef.current = onExitStart;

  const completedRef = useRef(false);
  const exitStartedRef = useRef(false);

  const triggerExit = useCallback(() => {
    setPhase((current) => (current === "active" ? "exiting" : current));
  }, []);

  useEffect(() => {
    if (phase === "active") {
      markSplashSeenInSession();
      const holdDuration = prefersReducedMotion()
        ? INTRO_REDUCED_MOTION_HOLD_MS
        : INTRO_EXIT_START_MS;

      const timer = window.setTimeout(() => {
        setPhase("exiting");
      }, holdDuration);

      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
          setPhase("exiting");
        }
      };
      window.addEventListener("keydown", onKeyDown);

      return () => {
        window.clearTimeout(timer);
        window.removeEventListener("keydown", onKeyDown);
      };
    }

    if (phase === "exiting") {
      markSplashSeenInSession();
      if (!exitStartedRef.current) {
        exitStartedRef.current = true;
        onExitStartRef.current?.();
      }

      const exitDuration = prefersReducedMotion()
        ? INTRO_REDUCED_MOTION_EXIT_MS
        : INTRO_EXIT_DURATION_MS;

      const timer = window.setTimeout(() => {
        setPhase("done");
      }, exitDuration);

      return () => {
        window.clearTimeout(timer);
      };
    }

    if (phase === "done" && !completedRef.current) {
      completedRef.current = true;
      onCompleteRef.current?.();
    }
  }, [phase]);

  if (phase === "done") {
    return null;
  }

  const isExiting = phase === "exiting";

  return (
    <div
      className={`intro-splash${isExiting ? " intro-splash--exiting" : ""}`}
      data-testid="intro-splash"
      data-phase={phase}
      role="region"
      aria-label="Gmusic intro splash"
      aria-hidden={isExiting}
      style={{ pointerEvents: isExiting ? "none" : "auto" }}
    >
      <div className="intro-splash__ambient" aria-hidden="true" />

      <div className="intro-splash__stage">
        <div className="intro-splash__mark-wrap">
          <svg
            className="intro-splash__svg"
            viewBox="0 0 120 120"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
          >
            <defs>
              <linearGradient id="gmusic-ring-grad" x1="12" y1="12" x2="108" y2="108" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#8DA8FF" />
                <stop offset="55%" stopColor="#B8C9FF" />
                <stop offset="100%" stopColor="#E5B869" />
              </linearGradient>
              <linearGradient id="gmusic-eq-grad" x1="60" y1="36" x2="60" y2="84" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stopColor="#B8C9FF" />
                <stop offset="100%" stopColor="#8DA8FF" />
              </linearGradient>
            </defs>

            {/* Core vinyl disc */}
            <circle
              className="intro-splash__core-disc"
              cx="60"
              cy="60"
              r="46"
              fill="#12121A"
              stroke="rgba(244, 244, 248, 0.08)"
              strokeWidth="1.5"
            />

            {/* Outer precision stroke ring */}
            <circle
              className="intro-splash__ring-outer"
              style={{ "--dash-length": 326 } as CSSProperties}
              cx="60"
              cy="60"
              r="52"
              stroke="url(#gmusic-ring-grad)"
              strokeWidth="2.2"
              strokeLinecap="round"
              transform="rotate(-90 60 60)"
            />

            {/* Vinyl acoustic groove rings */}
            <circle
              className="intro-splash__ring-groove"
              style={{ "--dash-length": 226 } as CSSProperties}
              cx="60"
              cy="60"
              r="36"
              stroke="rgba(141, 168, 255, 0.28)"
              strokeWidth="1.25"
              strokeLinecap="round"
              strokeDasharray="226"
              transform="rotate(-45 60 60)"
            />

            <circle
              className="intro-splash__ring-inner"
              style={{ "--dash-length": 120 } as CSSProperties}
              cx="60"
              cy="60"
              r="19"
              stroke="rgba(244, 244, 248, 0.16)"
              strokeWidth="1"
              strokeLinecap="round"
            />

            {/* Harmonic equalizer bars in center stage */}
            <rect
              className="intro-splash__eq-bar intro-splash__eq-bar--1"
              x="42"
              y="50"
              width="4"
              height="20"
              rx="2"
              fill="url(#gmusic-eq-grad)"
            />
            <rect
              className="intro-splash__eq-bar intro-splash__eq-bar--2"
              x="50"
              y="43"
              width="4"
              height="34"
              rx="2"
              fill="url(#gmusic-eq-grad)"
            />
            <rect
              className="intro-splash__eq-bar intro-splash__eq-bar--3"
              x="58"
              y="36"
              width="4"
              height="48"
              rx="2"
              fill="url(#gmusic-eq-grad)"
            />
            <rect
              className="intro-splash__eq-bar intro-splash__eq-bar--4"
              x="66"
              y="43"
              width="4"
              height="34"
              rx="2"
              fill="url(#gmusic-eq-grad)"
            />
            <rect
              className="intro-splash__eq-bar intro-splash__eq-bar--5"
              x="74"
              y="50"
              width="4"
              height="20"
              rx="2"
              fill="url(#gmusic-eq-grad)"
            />
          </svg>
          <div className="intro-splash__sheen" aria-hidden="true" />
        </div>

        <div className="intro-splash__wordmark-group">
          <h1 className="intro-splash__title" aria-label="Gmusic">
            {BRAND_CHARS.map((item) => (
              <span
                key={item.char}
                className={`intro-splash__char${item.accent ? " intro-splash__char--accent" : ""}`}
                style={{ animationDelay: `${item.delayMs}ms` }}
              >
                {item.char}
              </span>
            ))}
          </h1>
          <p className="intro-splash__tagline">Personal Audio Studio</p>
        </div>
      </div>

      <button
        type="button"
        className="intro-splash__skip"
        onClick={triggerExit}
        aria-label="Skip intro"
        tabIndex={isExiting ? -1 : 0}
      >
        Skip
      </button>
    </div>
  );
}
