import { useEffect, useRef, useState, type ReactNode } from "react";
import { MoreIcon } from "./Icons";

/**
 * Accessible dropdown menu: opens on click, closes on Escape or outside
 * pointer, arrow keys move between items (rules §10).
 */
export type MenuItemSpec =
  | { kind: "action"; label: string; icon?: ReactNode; onSelect: () => void; danger?: boolean }
  | { kind: "separator" }
  | { kind: "heading"; label: string };

export function Menu({ items, buttonLabel, trigger }: {
  items: MenuItemSpec[];
  buttonLabel: string;
  trigger?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        rootRef.current?.querySelector<HTMLButtonElement>("[data-menu-trigger]")?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    const firstItem = listRef.current?.querySelector<HTMLButtonElement>("[data-menu-item]");
    firstItem?.focus();
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const onKeyDownList = (event: React.KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const buttons = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("[data-menu-item]") ?? []);
    if (buttons.length === 0) return;
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "ArrowDown" ? (index + 1) % buttons.length : (index - 1 + buttons.length) % buttons.length;
    buttons[next].focus();
  };

  const actionable = items.filter((item) => item.kind === "action");

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        data-menu-trigger
        className="icon-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={buttonLabel}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      >
        {trigger ?? <MoreIcon size={18} />}
      </button>
      {open && (
        <div
          ref={listRef}
          role="menu"
          aria-label={buttonLabel}
          onKeyDown={onKeyDownList}
          className="surface-card absolute right-0 top-[calc(100%+4px)] z-40 min-w-48 py-1.5 shadow-[var(--shadow-overlay)] animate-fade-in"
        >
          {items.map((item, index) => {
            if (item.kind === "separator") {
              return <div key={`sep-${index}`} className="my-1.5 h-px" style={{ background: "var(--border-subtle)" }} />;
            }
            if (item.kind === "heading") {
              return (
                <div key={`head-${index}`} className="px-3.5 py-1 text-xs uppercase tracking-wide text-text-muted">
                  {item.label}
                </div>
              );
            }
            return (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                data-menu-item
                className={`flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-sm transition-colors hover:bg-surface-hover ${
                  item.danger ? "text-danger" : "text-text-primary"
                }`}
                onClick={(event) => {
                  event.stopPropagation();
                  setOpen(false);
                  item.onSelect();
                }}
              >
                {item.icon && <span className="text-text-muted">{item.icon}</span>}
                {item.label}
              </button>
            );
          })}
          {actionable.length === 0 && <div className="px-3.5 py-2 text-sm text-text-muted">No actions</div>}
        </div>
      )}
    </div>
  );
}
