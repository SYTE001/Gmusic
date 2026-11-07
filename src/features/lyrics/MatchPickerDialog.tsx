import { Modal } from "../../components/Modal";
import type { RankedCandidate } from "../../services/lyrics/matching";
import { formatClock } from "../../utils/misc";

/**
 * Candidate chooser for ambiguous lrcmux matches (feature spec §1.8): shown
 * instead of silently attaching lyrics when confidence is low.
 */
export function MatchPickerDialog({
  open,
  trackTitle,
  candidates,
  onPick,
  onDismiss,
}: {
  open: boolean;
  trackTitle: string;
  candidates: RankedCandidate[];
  onPick: (candidate: RankedCandidate) => void;
  onDismiss: () => void;
}) {
  return (
    <Modal open={open} title={`Choose lyrics for “${trackTitle}”`} onClose={onDismiss} width="max-w-lg">
      <p className="mb-3 text-sm text-text-secondary">
        No clear match was found automatically. These are the closest candidates from lrcmux — pick the one that matches
        your file, or dismiss to keep looking manually.
      </p>
      <div className="max-h-80 space-y-1 overflow-y-auto pr-1">
        {candidates.map((candidate) => (
          <button
            key={candidate.record.id}
            type="button"
            className="flex w-full flex-col gap-0.5 rounded-lg border px-3.5 py-2.5 text-left transition-colors hover:bg-surface-hover"
            style={{ borderColor: "var(--border-subtle)" }}
            onClick={() => onPick(candidate)}
          >
            <span className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-sm text-text-primary">
                {candidate.record.trackName || "Unknown title"}
              </span>
              {candidate.capability === "word" && (
                <span className="shrink-0 rounded-full bg-surface-raised px-2 py-0.5 text-[10px] text-accent">word sync</span>
              )}
              {candidate.capability === "line" && (
                <span className="shrink-0 rounded-full bg-surface-raised px-2 py-0.5 text-[10px] text-success">synced</span>
              )}
              {candidate.capability === "instrumental" && (
                <span className="shrink-0 rounded-full bg-surface-raised px-2 py-0.5 text-[10px] text-text-muted">instrumental</span>
              )}
              {candidate.capability === "plain" && (
                <span className="shrink-0 rounded-full bg-surface-raised px-2 py-0.5 text-[10px] text-text-muted">plain</span>
              )}
            </span>
            <span className="truncate text-xs text-text-secondary">
              {candidate.record.artistName || "Unknown artist"}
              {candidate.record.albumName ? ` · ${candidate.record.albumName}` : ""}
              {candidate.record.duration != null ? ` · ${formatClock(candidate.record.duration * 1000)}` : ""}
              {candidate.quality.durationDeltaSeconds != null
                ? ` (yours: ${candidate.quality.durationDeltaSeconds < 1 ? "same length" : `±${Math.round(candidate.quality.durationDeltaSeconds)}s`})`
                : ""}
            </span>
          </button>
        ))}
      </div>
    </Modal>
  );
}
