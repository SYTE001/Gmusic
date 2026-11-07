import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ImportOutcomeDialog } from "./ImportMusic";
import type { ImportOutcome } from "../../types";

describe("ImportOutcomeDialog UI component", () => {
  it("renders null when nothing skipped, failed, updated, or needs review", () => {
    const outcome: ImportOutcome = {
      added: 5,
      updated: 0,
      duplicatesSkipped: 0,
      unsupported: [],
      failed: [],
      sessionOnlyAdded: 0,
    };
    const { container } = render(<ImportOutcomeDialog outcome={outcome} onClose={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders report with added, updated, skipped, and needs review items", () => {
    const onClose = vi.fn();
    const outcome: ImportOutcome = {
      added: 2,
      updated: 3,
      duplicatesSkipped: 1,
      needsReview: [
        { fileName: "song_alt.mp3", reason: "Possible alternate recording" },
      ],
      unsupported: ["bad.xyz"],
      failed: [{ fileName: "locked.mp3", reason: "Access denied" }],
      sessionOnlyAdded: 0,
    };

    render(<ImportOutcomeDialog outcome={outcome} onClose={onClose} />);

    const dialog = screen.getByRole("dialog", { name: "Import report" });
    expect(dialog).toBeTruthy();
    expect(dialog.textContent).toContain("Added 2 tracks");
    expect(dialog.textContent).toContain("Updated 3 existing tracks");
    expect(dialog.textContent).toContain("Skipped 1 duplicate");
    expect(dialog.textContent).toContain("Tracks to review");
    expect(dialog.textContent).toContain("song_alt.mp3 — Possible alternate recording");
    expect(dialog.textContent).toContain("Unsupported or undecodable files");
    expect(dialog.textContent).toContain("bad.xyz");
    expect(dialog.textContent).toContain("locked.mp3 — Access denied");

    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
