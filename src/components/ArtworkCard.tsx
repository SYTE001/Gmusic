import { Artwork } from "./Artwork";
import { PlayIcon } from "./Icons";

/** Responsive artwork card with title/subtitle and a hover/focus play action. */
export function ArtworkCard({
  artworkKey,
  title,
  subtitle,
  onOpen,
  onPlay,
  ariaLabel,
}: {
  artworkKey: string | null;
  title: string;
  subtitle: string;
  onOpen: () => void;
  onPlay?: () => void;
  ariaLabel: string;
}) {
  return (
    <div className="group relative flex w-full flex-col gap-2.5 rounded-[var(--radius-tile)] p-3 transition-colors hover:bg-surface-hover">
      <button type="button" className="relative aspect-square w-full overflow-hidden rounded-[var(--radius-tile)]" onClick={onOpen} aria-label={ariaLabel}>
        <Artwork trackId={artworkKey} alt="" className="size-full" rounded="rounded-[var(--radius-tile)]" />
        {onPlay && (
          <span
            className="absolute bottom-2 right-2 grid size-11 translate-y-2 place-items-center rounded-full bg-accent-strong text-accent-contrast opacity-0 shadow-lg transition-all duration-200 group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:translate-y-0 group-focus-within:opacity-100"
            aria-hidden
          >
            <PlayIcon size={18} />
          </span>
        )}
      </button>
      <div>
        <div className="truncate text-sm font-medium text-text-primary" title={title}>
          {title}
        </div>
        <div className="truncate text-xs text-text-secondary" title={subtitle}>
          {subtitle}
        </div>
      </div>
      {onPlay && (
        <button
          type="button"
          className="sr-only"
          onClick={(event) => {
            event.stopPropagation();
            onPlay();
          }}
        >
          Play {title}
        </button>
      )}
    </div>
  );
}
