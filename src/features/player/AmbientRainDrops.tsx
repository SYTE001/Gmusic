import { memo, useEffect, useState, type CSSProperties } from "react";
import { useSettingsStore } from "../../stores/settingsStore";

type DropletSpec = {
  id: number;
  left: string;
  top: string;
  sizePx: number;
  opacity: number;
  durationSec: number;
  delaySec: number;
  driftXPx: number;
  travelYPx: number;
};

/**
 * 10 sparse, tiny water droplets (2.5–4.5px, 16–28% opacity) distributed
 * using percentage coordinates so they adapt cleanly across mobile (360px+)
 * and desktop viewports without JS loops, canvas, or layout shifts.
 */
export const AMBIENT_DROPLETS: readonly DropletSpec[] = [
  { id: 1, left: "11%", top: "14%", sizePx: 3, opacity: 0.22, durationSec: 11.5, delaySec: -1.4, driftXPx: 2, travelYPx: 38 },
  { id: 2, left: "86%", top: "18%", sizePx: 2.5, opacity: 0.18, durationSec: 13.2, delaySec: -4.8, driftXPx: -2, travelYPx: 44 },
  { id: 3, left: "22%", top: "30%", sizePx: 4, opacity: 0.25, durationSec: 10.4, delaySec: -7.1, driftXPx: 3, travelYPx: 42 },
  { id: 4, left: "78%", top: "34%", sizePx: 3.5, opacity: 0.2, durationSec: 12.8, delaySec: -2.9, driftXPx: -3, travelYPx: 48 },
  { id: 5, left: "8%", top: "48%", sizePx: 2.5, opacity: 0.16, durationSec: 14.2, delaySec: -9.3, driftXPx: 2, travelYPx: 36 },
  { id: 6, left: "90%", top: "52%", sizePx: 4.5, opacity: 0.27, durationSec: 9.8, delaySec: -5.6, driftXPx: -2, travelYPx: 50 },
  { id: 7, left: "16%", top: "66%", sizePx: 3.5, opacity: 0.21, durationSec: 12.1, delaySec: -3.7, driftXPx: 3, travelYPx: 40 },
  { id: 8, left: "83%", top: "69%", sizePx: 3, opacity: 0.19, durationSec: 13.6, delaySec: -8.2, driftXPx: -2, travelYPx: 45 },
  { id: 9, left: "29%", top: "80%", sizePx: 2.5, opacity: 0.17, durationSec: 11.9, delaySec: -6.4, driftXPx: 2, travelYPx: 34 },
  { id: 10, left: "71%", top: "82%", sizePx: 4, opacity: 0.24, durationSec: 10.8, delaySec: -10.5, driftXPx: -3, travelYPx: 38 },
];

export const AmbientRainDrops = memo(function AmbientRainDrops() {
  const reducedMotionSetting = useSettingsStore((state) => state.prefs.reducedMotion);
  const [osReducedMotion, setOsReducedMotion] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false,
  );

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setOsReducedMotion(mq.matches);
    const onChange = (event: MediaQueryListEvent) => setOsReducedMotion(event.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const isReducedMotion =
    reducedMotionSetting === "on" || (reducedMotionSetting === "system" && osReducedMotion);

  return (
    <div
      aria-hidden="true"
      data-testid="ambient-rain-drops"
      data-reduced-motion={isReducedMotion ? "true" : "false"}
      className="pointer-events-none absolute inset-0 z-0 overflow-hidden"
    >
      {AMBIENT_DROPLETS.map((drop) => {
        const style: CSSProperties = {
          left: drop.left,
          top: drop.top,
          width: `${drop.sizePx}px`,
          height: `${drop.sizePx}px`,
          "--drop-opacity": String(drop.opacity),
          "--drop-duration": `${drop.durationSec}s`,
          "--drop-delay": `${drop.delaySec}s`,
          "--drop-drift-x": `${drop.driftXPx}px`,
          "--drop-travel-y": `${drop.travelYPx}px`,
          ...(isReducedMotion ? { animation: "none" } : undefined),
        } as CSSProperties;

        return <span key={drop.id} data-raindrop className="gm-raindrop" style={style} />;
      })}
    </div>
  );
});
