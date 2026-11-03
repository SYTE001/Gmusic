import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { MoreIcon } from "./Icons";

/**
 * Accessible dropdown menu: opens on click, closes on Escape or outside
 * pointer, arrow keys move between items (rules §10).
 * Renders into a document.body React Portal with fixed positioning,
 * auto-flip, and solid Apple-inspired minimalism.
 */
export type MenuItemSpec =
  | { kind: "action"; label: string; icon?: ReactNode; onSelect: () => void; danger?: boolean }
  | { kind: "separator" }
  | { kind: "heading"; label: string };

export function Menu({
  items,
  buttonLabel,
  trigger,
  onOpenChange,
}: {
  items: MenuItemSpec[] | (() => MenuItemSpec[]);
  buttonLabel: string;
  trigger?: ReactNode;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<"bottom" | "top">("bottom");
  const [coords, setCoords] = useState<CSSProperties>({});
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    onOpenChange?.(false);
  }, [onOpenChange]);

  const updatePosition = useCallback(() => {
    if (!triggerRef.current) return;
    const triggerRect = triggerRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - triggerRect.bottom - 8;
    const spaceAbove = triggerRect.top - 8;
    const shouldFlip = spaceBelow < 280 && spaceAbove > spaceBelow;
    const newPlacement = shouldFlip ? "top" : "bottom";
    setPlacement(newPlacement);

    const right = Math.max(8, window.innerWidth - triggerRect.right);
    const style: CSSProperties = {
      right: `${right}px`,
      maxHeight: `min(380px, calc(100vh - 32px))`,
    };

    if (newPlacement === "top") {
      style.bottom = `${Math.max(8, window.innerHeight - triggerRect.top + 6)}px`;
    } else {
      style.top = `${Math.max(8, triggerRect.bottom + 6)}px`;
    }
    setCoords(style);
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        listRef.current?.contains(target) ||
        triggerRef.current?.contains(target)
      ) {
        return;
      }
      close();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
        triggerRef.current?.focus();
      }
    };

    const onScrollOrResize = (event: Event) => {
      // If user scrolls inside the menu list itself, don't close
      if (listRef.current?.contains(event.target as Node)) return;
      close();
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);

    // Initial focus on first actionable item
    const firstItem = listRef.current?.querySelector<HTMLButtonElement>("[data-menu-item]");
    firstItem?.focus();

    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [open, close]);

  const onKeyDownList = (event: React.KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const buttons = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("[data-menu-item]") ?? []);
    if (buttons.length === 0) return;
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "ArrowDown" ? (index + 1) % buttons.length : (index - 1 + buttons.length) % buttons.length;
    buttons[next].focus();
  };

  const resolvedItems = open ? (typeof items === "function" ? items() : items) : [];
  const actionable = open ? resolvedItems.filter((item) => item.kind === "action") : [];

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-menu-trigger
        className="icon-btn size-8 inline-flex items-center justify-center rounded-lg text-text-muted hover:text-text-primary hover:bg-surface-hover transition-colors shrink-0"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={buttonLabel}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => {
            const next = !value;
            onOpenChange?.(next);
            return next;
          });
        }}
      >
        {trigger ?? <MoreIcon size={16} />}
      </button>

      {open &&
        createPortal(
          <div
            ref={listRef}
            role="menu"
            data-placement={placement}
            aria-label={buttonLabel}
            onKeyDown={onKeyDownList}
            className="fixed z-[100] min-w-48 overflow-y-auto rounded-xl p-1.5 shadow-[var(--shadow-overlay)] animate-fade-in border border-[var(--border-subtle)] bg-[var(--surface)] text-text-primary"
            style={coords}
          >
            {resolvedItems.map((item, index) => {
              if (item.kind === "separator") {
                return (
                  <div
                    key={`sep-${index}`}
                    className="my-1 h-px bg-[var(--border-subtle)]"
                  />
                );
              }
              if (item.kind === "heading") {
                return (
                  <div
                    key={`head-${index}`}
                    className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-muted"
                  >
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
                  className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] font-medium transition-colors select-none outline-none ${
                    item.danger
                      ? "text-danger hover:bg-danger/10 focus:bg-danger/10"
                      : "text-text-primary hover:bg-surface-hover focus:bg-surface-hover"
                  }`}
                  onClick={(event) => {
                    event.stopPropagation();
                    close();
                    item.onSelect();
                  }}
                >
                  <span className="w-4 h-4 shrink-0 flex items-center justify-center text-text-muted">
                    {item.icon}
                  </span>
                  <span className="flex-1 truncate">{item.label}</span>
                </button>
              );
            })}
            {actionable.length === 0 && (
              <div className="px-3 py-2 text-xs text-text-muted">No actions</div>
            )}
          </div>,
          document.body
        )}
    </>
  );
}
