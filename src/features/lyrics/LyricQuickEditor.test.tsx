import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TrackLyrics } from "../../types";
import { repository } from "../../services/indexeddb/LibraryRepository";
import { LyricQuickEditor } from "./LyricQuickEditor";

const lyrics: TrackLyrics = {
  trackId: "editor-track", format: "lrc", lines: [{ timeMs: 1000, text: "Original" }], offsetMs: 750,
  updatedAt: 1, skippedLines: 0, sourceName: "lrclib", origin: { kind: "lrclib", recordId: 42, fetchedAt: 1, capability: "line" },
};

beforeEach(async () => { await repository.clearAllData(); });

describe("manual lyrics edits", () => {
  it("marks edited provider lyrics as manual and preserves the user offset", async () => {
    const onSaved = vi.fn();
    render(<LyricQuickEditor lyrics={lyrics} onSaved={onSaved} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "[00:02]Edited" } });
    fireEvent.click(screen.getByRole("button", { name: "Save lyrics" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    const saved = await repository.getLyrics(lyrics.trackId);
    expect(saved?.origin?.kind).toBe("manual");
    expect(saved?.origin?.recordId).toBeNull();
    expect(saved?.offsetMs).toBe(750);
    expect(saved?.lines[0]).toMatchObject({ timeMs: 2000, text: "Edited" });
  });
});
