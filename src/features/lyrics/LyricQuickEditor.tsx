import { useState } from "react";
import type { TrackLyrics } from "../../types";
import { DB_SCHEMA_VERSION } from "../../types";
import { formatClock } from "../../utils/misc";
import { parseLyricFile } from "../../services/lyrics/lyricsService";
import { repository } from "../../services/indexeddb/LibraryRepository";

/** Minimal lyric text/timestamp editor. */
export function LyricQuickEditor({ lyrics, onSaved }: { lyrics: TrackLyrics; onSaved: (updated: TrackLyrics) => void }) {
  const [value, setValue] = useState(() =>
    lyrics.lines
      .map((line) => (line.timeMs !== null ? `[${formatClock(line.timeMs)}] ${line.text}` : line.text))
      .join("\n"),
  );
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const parsed = parseLyricFile(lyrics.trackId, lyrics.sourceName, value);
      const updated = { ...parsed.lyrics, offsetMs: lyrics.offsetMs, origin: lyrics.origin, schemaVersion: DB_SCHEMA_VERSION };
      await repository.putLyrics(updated);
      onSaved(updated);
    } catch {
      // Leave the editor open with the user's text intact on failure.
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-4 rounded-xl border p-3" style={{ borderColor: "var(--border-subtle)", background: "var(--surface)" }}>
      <label className="mb-1.5 block text-xs text-text-secondary" htmlFor="lyric-editor">
        Quick editor — one line per lyric; use [m:ss] timestamps for sync
      </label>
      <textarea
        id="lyric-editor"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        rows={8}
        spellCheck={false}
        className="w-full resize-y rounded-lg border bg-transparent p-2.5 font-mono text-xs outline-none focus:border-accent"
        style={{ borderColor: "var(--border-subtle)" }}
      />
      <div className="mt-2 flex justify-end gap-2">
        <button
          type="button"
          className="rounded-lg bg-accent-strong px-3 py-1.5 text-xs font-medium text-accent-contrast disabled:opacity-50"
          onClick={() => void save()}
          disabled={saving}
        >
          Save lyrics
        </button>
      </div>
    </div>
  );
}
