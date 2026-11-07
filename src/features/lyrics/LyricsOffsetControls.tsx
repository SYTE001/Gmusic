import type { TrackLyrics } from "../../types";

interface LyricsOffsetControlsProps {
  lyrics: TrackLyrics;
  onAdjustOffset: (deltaMs: number) => void | Promise<void>;
}

export function LyricsOffsetControls({ lyrics, onAdjustOffset }: LyricsOffsetControlsProps) {
  return (
    <>
      {lyrics.offsetMs !== 0 && (
        <span
          className="rounded-full border px-2 py-0.5 text-text-muted"
          style={{ borderColor: "var(--border-subtle)" }}
        >
          offset {(lyrics.offsetMs / 1000).toFixed(1)}s
        </span>
      )}
      <button
        type="button"
        className="rounded-lg border px-2 py-0.5 text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
        style={{ borderColor: "var(--border-subtle)" }}
        aria-label="Shift lyrics half a second earlier"
        onClick={() => void onAdjustOffset(-500)}
      >
        −0.5s
      </button>
      <button
        type="button"
        className="rounded-lg border px-2 py-0.5 text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
        style={{ borderColor: "var(--border-subtle)" }}
        aria-label="Shift lyrics half a second later"
        onClick={() => void onAdjustOffset(500)}
      >
        +0.5s
      </button>
      {lyrics.offsetMs !== 0 && (
        <button
          type="button"
          className="rounded-lg px-1.5 py-0.5 text-accent hover:underline"
          onClick={() => void onAdjustOffset(-lyrics.offsetMs)}
        >
          Reset
        </button>
      )}
    </>
  );
}
