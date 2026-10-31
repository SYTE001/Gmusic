import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Compact sticky strip for playlist/liked pages: appears once the large
 * header block has scrolled out of view, keeping Play + context reachable.
 * Purely additive chrome — hidden (and inert) until then.
 */
export function StickyPageHeader({ children }: { children: ReactNode }) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [show, setShow] = useState(false);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => setShow(!entry.isIntersecting),
      { threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <div ref={sentinelRef} aria-hidden className="h-px w-full" />
      <div
        className={`sticky top-0 z-20 -mx-4 mb-4 flex items-center gap-3 border-b bg-app-bg px-4 py-2 transition-opacity duration-200 md:-mx-8 md:px-8 ${
          show ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
        aria-hidden={!show}
        style={{ borderColor: "var(--border-subtle)" }}
      >
        {children}
      </div>
    </>
  );
}
