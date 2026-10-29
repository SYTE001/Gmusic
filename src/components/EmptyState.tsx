import type { ReactNode } from "react";

/** Honest empty state with a clear next action (PRD §13). */
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-[var(--radius-tile)] border border-dashed px-6 py-14 text-center" style={{ borderColor: "var(--border-subtle)" }}>
      <div className="text-text-muted" aria-hidden>
        {icon}
      </div>
      <h3 className="text-base font-semibold text-text-primary">{title}</h3>
      <p className="max-w-md text-sm text-text-secondary">{description}</p>
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
