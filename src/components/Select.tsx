import { useEffect, useRef, useState, useId, type ReactNode } from "react";
import { CheckIcon, ChevronDownIcon } from "./Icons";

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  icon?: ReactNode;
  hint?: string;
  disabled?: boolean;
}

export interface SelectProps<T extends string = string> {
  value: T;
  onChange: (value: T) => void;
  options: Array<SelectOption<T>>;
  ariaLabel?: string;
  id?: string;
  disabled?: boolean;
  className?: string;
  buttonClassName?: string;
  dropdownClassName?: string;
  size?: "sm" | "md";
  align?: "left" | "right";
}

export function Select<T extends string = string>({
  value,
  onChange,
  options,
  ariaLabel,
  id,
  disabled = false,
  className = "",
  buttonClassName = "",
  dropdownClassName = "",
  size = "md",
  align = "left",
}: SelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState<number>(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const generatedId = useId();
  const selectId = id ?? generatedId;
  const listboxId = `${selectId}-listbox`;

  const selectedOption = options.find((opt) => opt.value === value) ?? options[0];

  // Sync highlighted option when opening
  useEffect(() => {
    if (open) {
      const idx = options.findIndex((opt) => opt.value === value);
      setHighlightedIndex(idx >= 0 ? idx : 0);
    }
  }, [open, value, options]);

  // Click outside and global Escape key listener
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // Keyboard navigation within listbox
  const handleButtonKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      const dir = event.key === "ArrowDown" ? 1 : -1;
      const nextIndex = (highlightedIndex + dir + options.length) % options.length;
      setHighlightedIndex(nextIndex);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open && highlightedIndex >= 0 && highlightedIndex < options.length) {
        const target = options[highlightedIndex];
        if (!target.disabled) {
          onChange(target.value);
          setOpen(false);
        }
      } else {
        setOpen((prev) => !prev);
      }
    }
  };

  const isSmall = size === "sm";

  return (
    <div ref={rootRef} className={`relative inline-block text-left ${className}`}>
      <button
        ref={buttonRef}
        id={selectId}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => !disabled && setOpen((prev) => !prev)}
        onKeyDown={handleButtonKeyDown}
        className={`group flex items-center justify-between gap-2 rounded-lg border font-medium text-text-primary transition-all duration-150 outline-none select-none ${
          isSmall ? "h-8 px-2.5 py-1 text-xs" : "h-9 px-3 py-1.5 text-sm"
        } ${
          disabled
            ? "cursor-not-allowed opacity-50"
            : open
              ? "border-accent bg-surface-raised shadow-xs"
              : "bg-surface hover:bg-surface-hover hover:border-[var(--border-strong)]"
        } ${buttonClassName}`}
        style={{ borderColor: open ? "var(--accent)" : "var(--border-subtle)" }}
      >
        <span className="flex items-center gap-1.5 truncate">
          {selectedOption?.icon && <span className="shrink-0">{selectedOption.icon}</span>}
          <span className="truncate">{selectedOption?.label ?? value}</span>
        </span>
        <ChevronDownIcon
          size={isSmall ? 12 : 14}
          className={`shrink-0 text-text-muted transition-transform duration-200 ease-out group-hover:text-text-primary ${
            open ? "rotate-180 text-text-primary" : ""
          }`}
        />
      </button>

      {open && (
        <div
          ref={listRef}
          id={listboxId}
          role="listbox"
          aria-label={ariaLabel}
          className={`surface-card absolute ${
            align === "right" ? "right-0" : "left-0"
          } top-[calc(100%+6px)] z-50 min-w-[max(100%,160px)] max-h-64 overflow-y-auto p-1 shadow-[var(--shadow-overlay)] animate-fade-in ${dropdownClassName}`}
          style={{ background: "var(--surface)", borderColor: "var(--border-subtle)" }}
        >
          {options.map((option, index) => {
            const isSelected = option.value === value;
            const isHighlighted = index === highlightedIndex;

            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={isSelected}
                disabled={option.disabled}
                onMouseEnter={() => setHighlightedIndex(index)}
                onClick={(event) => {
                  event.stopPropagation();
                  if (option.disabled) return;
                  onChange(option.value);
                  setOpen(false);
                  buttonRef.current?.focus();
                }}
                className={`relative flex w-full items-center justify-between gap-3 rounded-lg text-left transition-colors select-none ${
                  isSmall ? "px-2.5 py-1.5 text-xs" : "px-3 py-2 text-sm"
                } ${
                  option.disabled
                    ? "cursor-not-allowed text-text-muted opacity-40"
                    : isSelected
                      ? "bg-surface-raised font-medium text-text-primary"
                      : isHighlighted
                        ? "bg-surface-hover text-text-primary"
                        : "text-text-secondary hover:bg-surface-hover hover:text-text-primary"
                }`}
              >
                <span className="flex items-center gap-2 truncate">
                  {option.icon && <span className="shrink-0">{option.icon}</span>}
                  <span className="truncate">{option.label}</span>
                </span>
                {isSelected && (
                  <CheckIcon
                    size={isSmall ? 13 : 15}
                    className="shrink-0 text-text-primary ml-2"
                  />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
