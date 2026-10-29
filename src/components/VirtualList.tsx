import { useRef, useState, type ReactNode } from "react";

/**
 * Minimal fixed-row-height virtualization so the library can render thousands
 * of rows cheaply (PRD §7.3). No external dependency.
 */
export function VirtualList<T>({
  items,
  rowHeight,
  overscan = 6,
  renderRow,
  getKey,
  ariaLabel,
  className = "",
  footerHeight = 0,
}: {
  items: T[];
  rowHeight: number;
  overscan?: number;
  renderRow: (item: T, index: number) => ReactNode;
  getKey: (item: T, index: number) => string;
  ariaLabel: string;
  className?: string;
  footerHeight?: number;
}) {
  const [scrollTop, setScrollTop] = useState(0);
  const viewportRef = useRef<HTMLDivElement>(null);

  const totalHeight = items.length * rowHeight + footerHeight;
  const viewportHeight = viewportRef.current?.clientHeight ?? 800;
  const startIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const visibleCount = Math.ceil(viewportHeight / rowHeight) + overscan * 2;
  const endIndex = Math.min(items.length, startIndex + visibleCount);
  const slice = items.slice(startIndex, endIndex);

  return (
    <div
      ref={viewportRef}
      role="list"
      aria-label={ariaLabel}
      className={`relative overflow-y-auto ${className}`}
      onScroll={(event) => setScrollTop((event.target as HTMLDivElement).scrollTop)}
    >
      <div style={{ height: totalHeight, position: "relative" }}>
        {slice.map((item, offset) => {
          const index = startIndex + offset;
          return (
            <div
              key={getKey(item, index)}
              role="listitem"
              style={{ position: "absolute", top: index * rowHeight, left: 0, right: 0, height: rowHeight }}
            >
              {renderRow(item, index)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
