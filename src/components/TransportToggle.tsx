import type { ReactNode } from "react";

/**
 * Monochrome transport toggle (shuffle, repeat) for the player bars
 * (redesign reference 1). Active state stays clearly distinguishable without
 * any color: the icon brightens to full contrast and a small dot appears
 * beneath it. Inactive buttons keep the secondary text color.
 */
export function TransportToggle({
  active,
  label,
  title,
  onClick,
  children,
  className = "",
}: {
  active: boolean;
  label: string;
  title: string;
  onClick: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`icon-btn ${active ? "text-text-primary" : ""} ${className}`}
      aria-pressed={active}
      aria-label={label}
      title={title}
      onClick={onClick}
    >
      <span className="relative grid place-items-center">
        {children}
        {active && (
          <span className="absolute -bottom-[3px] left-1/2 size-1 -translate-x-1/2 rounded-full bg-accent" aria-hidden />
        )}
      </span>
    </button>
  );
}
