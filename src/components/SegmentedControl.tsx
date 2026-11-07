/**
 * Monochrome segmented control (redesign reference 4). The selected segment
 * lifts to the raised surface with a soft shadow; unselected segments stay
 * muted. Used for theme choice (Light / Dark / System) wherever a small set
 * of exclusive options needs a compact, touch-friendly control.
 */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (value: T) => void;
  options: readonly { value: T; label: string }[];
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded-lg bg-surface-hover p-0.5">
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            className={`rounded-md px-3 py-1 text-xs font-medium transition-colors sm:text-sm ${
              selected
                ? "bg-surface-raised text-text-primary shadow-sm"
                : "text-text-secondary hover:text-text-primary"
            }`}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
