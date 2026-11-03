import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useDynamicIslandStore } from "../stores/dynamicIslandStore";
import { CloseIcon, MusicNoteIcon, WarningIcon } from "./Icons";

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
  const pauseAutoDismiss = useDynamicIslandStore((state) => state.pauseAutoDismiss);
  const resumeAutoDismiss = useDynamicIslandStore((state) => state.resumeAutoDismiss);
  const reset = useDynamicIslandStore((state) => state.reset);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const reducedMotion = usePrefersReducedMotion();
  const navigate = useNavigate();

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

  const handleOpenBroken = () => {
    dismiss();
    const url = current.trackId ? `/broken?trackId=${encodeURIComponent(current.trackId)}` : "/broken";
    navigate(url);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleOpenBroken();
    }
  };

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="pointer-events-none fixed top-3 left-1/2 z-50 flex w-full -translate-x-1/2 items-center justify-center px-4 md:top-4"
    >
      <div
        role="button"
        tabIndex={0}
        aria-label={`${current.title}${current.song ? ` — ${current.song}` : ""}`}
        onClick={handleOpenBroken}
        onKeyDown={handleKeyDown}
        onMouseEnter={pauseAutoDismiss}
        onMouseLeave={resumeAutoDismiss}
        onFocus={pauseAutoDismiss}
        onBlur={resumeAutoDismiss}
        className={`pointer-events-auto relative flex cursor-pointer select-none items-center overflow-hidden border bg-surface ${
          reducedMotion ? "" : "transition-all"
        } ${
          isExpanded
            ? "min-h-[74px] w-[min(540px,calc(100vw-32px))] rounded-[30px] p-2.5 md:p-3 shadow-[var(--shadow-overlay)] hover:border-text-secondary/40 focus-visible:outline-2 focus-visible:outline-accent"
            : "size-12 rounded-[18px] p-1 shadow-md"
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
        {/* Red icon container with rounded corners and white warning triangle */}
        <div
          className={`grid shrink-0 place-items-center bg-[#EF233C] text-white shadow-sm transition-all duration-300 ${
            isExpanded
              ? "size-13 md:size-14 rounded-[20px]"
              : "size-10 rounded-[14px]"
          }`}
          aria-hidden
        >
          <WarningIcon size={isExpanded ? 24 : 18} className="text-white" />
        </div>

        {/* Content: Big typography title + track pill (no cluttered description) */}
        <div
          className={`min-w-0 flex-1 flex-col justify-center pl-3.5 pr-8 ${
            reducedMotion ? "" : "transition-opacity duration-200"
          } ${
            isExpanded
              ? reducedMotion
                ? "flex opacity-100"
                : "flex opacity-100 delay-100"
              : "pointer-events-none hidden opacity-0"
          }`}
        >
          {/* Big Typography Error Title */}
          <div className="flex items-center leading-tight">
            <span className="truncate text-[16px] md:text-[17px] font-bold tracking-tight text-text-primary">
              {current.title}
            </span>
          </div>

          {/* Track Information Pill */}
          {current.song && (
            <div className="mt-1.5 inline-flex max-w-full items-center gap-1.5 self-start overflow-hidden rounded-full bg-surface-raised px-2.5 py-1 text-[11.5px] md:text-[12px] text-text-primary leading-none">
              <MusicNoteIcon size={12} className="shrink-0 text-text-secondary" />
              <span className="truncate font-medium">{current.song}</span>
            </div>
          )}
        </div>

        {/* Close button on top-right side */}
        <button
          ref={closeButtonRef}
          type="button"
          aria-label="Dismiss notification"
          onClick={(e) => {
            e.stopPropagation();
            dismiss();
          }}
          className={`absolute top-3 right-3.5 grid size-7 shrink-0 place-items-center rounded-full text-text-muted transition-colors hover:bg-surface-hover hover:text-text-primary ${
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
