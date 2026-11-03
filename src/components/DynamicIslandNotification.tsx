import { useEffect, useRef, useState } from "react";
import { useDynamicIslandStore } from "../stores/dynamicIslandStore";
import { CloseIcon, WarningIcon } from "./Icons";

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === "undefined") return false;
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const attr = typeof document !== "undefined" ? document.documentElement.dataset.motion : undefined;
    return attr === "on" || (attr !== "off" && Boolean(media?.matches));
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const update = () => {
      const attr = document.documentElement.dataset.motion;
      setReduced(attr === "on" || (attr !== "off" && Boolean(media?.matches)));
    };

    media?.addEventListener?.("change", update);
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-motion"] });

    return () => {
      media?.removeEventListener?.("change", update);
      observer.disconnect();
    };
  }, []);

  return reduced;
}

export function DynamicIslandNotification() {
  const current = useDynamicIslandStore((state) => state.current);
  const stage = useDynamicIslandStore((state) => state.stage);
  const dismiss = useDynamicIslandStore((state) => state.dismissNotification);
  const reset = useDynamicIslandStore((state) => state.reset);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const reducedMotion = usePrefersReducedMotion();

  // Clean up timers on unmount
  useEffect(() => {
    return () => {
      reset();
    };
  }, [reset]);

  if (!current || stage === "idle") {
    return null;
  }

  const isExpanded = stage === "expanded";
  const isCollapsing = stage === "collapsing";

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="pointer-events-none fixed top-3 left-1/2 z-50 flex -translate-x-1/2 items-center justify-center px-4 md:top-4"
    >
      <div
        className={`pointer-events-auto relative flex items-center overflow-hidden border bg-surface ${
          reducedMotion ? "" : "transition-all"
        } ${
          isExpanded
            ? "h-[54px] w-[min(420px,calc(100vw-32px))] rounded-[26px] px-2 py-1.5 shadow-[var(--shadow-overlay)]"
            : "size-12 rounded-[16px] p-1 shadow-md"
        } ${isCollapsing ? "scale-90 opacity-0" : "scale-100 opacity-100"}`}
        style={{
          borderColor: "var(--border-subtle)",
          transitionDuration: reducedMotion ? "0.01ms" : isExpanded ? "340ms" : "240ms",
          transitionTimingFunction: reducedMotion
            ? "linear"
            : isExpanded
              ? "cubic-bezier(0.34, 1.45, 0.64, 1)"
              : "cubic-bezier(0.4, 0, 0.2, 1)",
        }}
      >
        {/* Stage 1/4: Rounded icon container with subtle glow */}
        <div
          className={`grid size-10 shrink-0 place-items-center rounded-[13px] bg-surface-raised text-danger transition-shadow duration-300 ${
            isExpanded && !reducedMotion ? "shadow-[0_0_12px_rgba(239,68,68,0.32)]" : ""
          }`}
          aria-hidden
        >
          <WarningIcon size={19} className="text-danger" />
        </div>

        {/* Stage 3: Content reveal with subtle opacity transition */}
        <div
          className={`min-w-0 flex-1 pl-2.5 pr-1 ${
            reducedMotion ? "" : "transition-opacity duration-200"
          } ${
            isExpanded
              ? reducedMotion
                ? "opacity-100"
                : "opacity-100 delay-100"
              : "pointer-events-none opacity-0"
          }`}
        >
          <div className="flex items-center gap-1.5 leading-tight">
            <span className="truncate text-[13px] font-semibold text-text-primary">
              {current.title}
            </span>
          </div>
          <p className="truncate text-[12px] text-text-secondary leading-tight mt-0.5">
            {current.description}
          </p>
          {current.song && (
            <p className="truncate text-[11px] text-text-muted leading-tight mt-0.5">
              {current.song}
            </p>
          )}
        </div>

        {/* Close button on right side */}
        <button
          ref={closeButtonRef}
          type="button"
          aria-label="Dismiss notification"
          onClick={dismiss}
          className={`grid size-7 shrink-0 place-items-center rounded-full text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary ${
            isExpanded
              ? reducedMotion
                ? "opacity-100"
                : "opacity-100 delay-100"
              : "pointer-events-none opacity-0"
          }`}
        >
          <CloseIcon size={14} />
        </button>
      </div>
    </div>
  );
}
