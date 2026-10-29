import { useEffect, useRef, useState } from "react";
import { useSettingsStore } from "../../stores/settingsStore";
import { useLibraryStore } from "../../stores/libraryStore";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Modal } from "../../components/Modal";
import { toast } from "../../stores/toastStore";
import {
  buildBackup,
  downloadBackup,
  restoreBackup,
  validateBackupText,
  type BackupSummary,
} from "../../services/backup/backupService";
import { repository } from "../../services/indexeddb/LibraryRepository";
import { flushPlaybackSessionNow } from "../../stores/libraryStore";
import { fileSystemAccessSupported } from "../../services/file-access/FileAccessService";
import { humanBytes } from "../../utils/misc";
import { APP_VERSION } from "../../types";
import { ImportIcon, InfoIcon, OfflineIcon } from "../../components/Icons";
import { CloudAccountSection } from "./CloudAccountSection";
import { CloudMigrationSection } from "./CloudMigrationSection";

type RestoreState =
  | { phase: "idle" }
  | { phase: "invalid"; errors: string[] }
  | { phase: "confirm"; summary: BackupSummary; text: string };

/** Settings (PRD §7.13): theme, lyrics, playback, storage, backup, reset. */
export function SettingsPage() {
  const prefs = useSettingsStore((state) => state.prefs);
  const update = useSettingsStore((state) => state.update);
  const tracks = useLibraryStore((state) => state.tracks);
  const clearLibrary = useLibraryStore((state) => state.clearLibrary);
  const [confirmClearLibrary, setConfirmClearLibrary] = useState(false);
  const [confirmClearAll, setConfirmClearAll] = useState(false);
  const [restore, setRestore] = useState<RestoreState>({ phase: "idle" });
  const [storage, setStorage] = useState<{ usage: number | null; quota: number | null; persisted: boolean | null }>({
    usage: null,
    quota: null,
    persisted: null,
  });
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void (async () => {
      try {
        const estimate = await navigator.storage?.estimate?.();
        const persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : null;
        setStorage({ usage: estimate?.usage ?? null, quota: estimate?.quota ?? null, persisted: persisted ?? null });
      } catch {
        setStorage({ usage: null, quota: null, persisted: null });
      }
    })();
  }, [tracks.length]);

  const handleExport = async () => {
    try {
      const backup = await buildBackup();
      if (backup.tracks.length === 0) {
        toast("info", "Nothing to back up yet — your library is empty.");
        return;
      }
      downloadBackup(backup);
      toast("success", `Backup downloaded (${backup.tracks.length} tracks, ${backup.playlists.length} playlists).`);
    } catch {
      toast("error", "The backup could not be created.");
    }
  };

  const handleImportFile = async (file: File) => {
    try {
      const text = await file.text();
      const result = validateBackupText(text);
      if (!result.ok) {
        setRestore({ phase: "invalid", errors: result.errors });
        return;
      }
      setRestore({ phase: "confirm", summary: result.summary, text });
    } catch {
      setRestore({ phase: "invalid", errors: ["The file could not be read."] });
    }
  };

  const confirmRestore = async () => {
    if (restore.phase !== "confirm") return;
    const result = validateBackupText(restore.text);
    if (!result.ok) {
      setRestore({ phase: "invalid", errors: result.errors });
      return;
    }
    try {
      await restoreBackup(result.backup);
      // Clear the saved playback session: its track references are stale.
      flushPlaybackSessionNow();
      await useLibraryStore.getState().init();
      setRestore({ phase: "idle" });
      toast("success", "Backup restored. Re-import or re-link your audio files to play them again.");
    } catch {
      toast("error", "The backup could not be restored. Your previous data was kept.");
    }
  };

  const accessSummary = tracks.reduce(
    (acc, track) => {
      acc[track.accessMode] = (acc[track.accessMode] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  return (
    <div className="mx-auto max-w-2xl space-y-8 pb-10">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-text-secondary">Everything is stored on this device first. An optional cloud account adds private audio storage and cross-device sync — nothing is uploaded without it.</p>
      </div>

      <Section title="Appearance">
        <Row label="Theme" hint="Dark is the designed default.">
          <select
            value={prefs.theme}
            onChange={(event) => update({ theme: event.target.value as typeof prefs.theme })}
            className="rounded-lg border bg-surface px-2.5 py-1.5 text-sm outline-none focus:border-accent"
            style={{ borderColor: "var(--border-subtle)" }}
          >
            <option value="dark">Dark</option>
            <option value="light">Light</option>
            <option value="system">System</option>
          </select>
        </Row>
        <Row label="Artwork background tint" hint="Tint Now Playing with a soft color from the current cover.">
          <Toggle checked={prefs.artworkTint} onChange={(value) => update({ artworkTint: value })} label="Artwork tint" />
        </Row>
        <Row label="Reduced motion" hint="Follows your system setting by default.">
          <select
            value={prefs.reducedMotion}
            onChange={(event) => update({ reducedMotion: event.target.value as typeof prefs.reducedMotion })}
            className="rounded-lg border bg-surface px-2.5 py-1.5 text-sm outline-none focus:border-accent"
            style={{ borderColor: "var(--border-subtle)" }}
          >
            <option value="system">Follow system</option>
            <option value="on">Always reduce</option>
            <option value="off">Never reduce</option>
          </select>
        </Row>
      </Section>

      <Section title="Playback defaults">
        <Row label="Shuffle" hint="Applies when you start playback from a list.">
          <Toggle checked={prefs.shuffle} onChange={(value) => update({ shuffle: value })} label="Shuffle" />
        </Row>
        <Row label="Repeat">
          <select
            value={prefs.repeatMode}
            onChange={(event) => update({ repeatMode: event.target.value as typeof prefs.repeatMode })}
            className="rounded-lg border bg-surface px-2.5 py-1.5 text-sm outline-none focus:border-accent"
            style={{ borderColor: "var(--border-subtle)" }}
          >
            <option value="off">Off</option>
            <option value="all">Repeat all</option>
            <option value="one">Repeat one</option>
          </select>
        </Row>
        <Row label="Volume" hint={`${Math.round(prefs.volume * 100)}% — also adjustable in the player.`}>
          <input
            type="range"
            className="app-range w-32"
            min={0}
            max={1}
            step={0.02}
            value={prefs.volume}
            aria-label="Default volume"
            onChange={(event) => update({ volume: Number(event.target.value) })}
          />
        </Row>
      </Section>

      <Section title="Lyrics">
        <Row
          label="Lyric style"
          hint="Word by word highlights each word when the song has word timing, otherwise falls back to line by line."
        >
          <select
            value={prefs.lyricsStyle}
            onChange={(event) => update({ lyricsStyle: event.target.value as typeof prefs.lyricsStyle })}
            className="rounded-lg border bg-surface px-2.5 py-1.5 text-sm outline-none focus:border-accent"
            style={{ borderColor: "var(--border-subtle)" }}
          >
            <option value="line">Line</option>
            <option value="word">Word by word</option>
          </select>
        </Row>
        <Row label="Font size">
          <select
            value={prefs.lyricFontSize}
            onChange={(event) => update({ lyricFontSize: event.target.value as typeof prefs.lyricFontSize })}
            className="rounded-lg border bg-surface px-2.5 py-1.5 text-sm outline-none focus:border-accent"
            style={{ borderColor: "var(--border-subtle)" }}
          >
            <option value="sm">Small</option>
            <option value="md">Medium</option>
            <option value="lg">Large</option>
          </select>
        </Row>
        <Row label="Alignment">
          <select
            value={prefs.lyricAlignment}
            onChange={(event) => update({ lyricAlignment: event.target.value as typeof prefs.lyricAlignment })}
            className="rounded-lg border bg-surface px-2.5 py-1.5 text-sm outline-none focus:border-accent"
            style={{ borderColor: "var(--border-subtle)" }}
          >
            <option value="center">Centered</option>
            <option value="left">Left</option>
          </select>
        </Row>
        <Row label="Line spacing">
          <input
            type="range"
            className="app-range w-32"
            min={1.1}
            max={2.2}
            step={0.1}
            value={prefs.lyricLineSpacing}
            aria-label="Lyric line spacing"
            onChange={(event) => update({ lyricLineSpacing: Number(event.target.value) })}
          />
        </Row>
        <p className="px-1 text-xs text-text-muted">
          Per-song timing offsets are set in the lyrics view (−0.5s / +0.5s) and saved per track.
        </p>
        <Row
          label="Find lyrics online automatically"
          hint="When a song starts and no lyrics are saved, look it up on lrcmux. Only the song's title, artist, album, and duration are sent — never the audio file. Found lyrics are cached for offline use."
        >
          <Toggle checked={prefs.autoFetchLyrics} onChange={(value) => update({ autoFetchLyrics: value })} label="Find lyrics online" />
        </Row>
      </Section>

      <Section title="Storage & file access">
        <CloudMigrationSection />
        <div className="space-y-2 rounded-xl border p-4 text-sm" style={{ borderColor: "var(--border-subtle)" }}>
          <div className="flex justify-between gap-4">
            <span className="text-text-secondary">Tracks with retained file access</span>
            <span className="tabular-nums">{accessSummary.handle ?? 0}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-text-secondary">Tracks stored in this app</span>
            <span className="tabular-nums">{accessSummary["stored-copy"] ?? 0}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-text-secondary">Tracks in cloud storage</span>
            <span className="tabular-nums">{tracks.filter((track) => track.cloudStatus === "ready").length}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-text-secondary">Tracks needing re-import</span>
            <span className="tabular-nums">{accessSummary["session-only"] ?? 0}</span>
          </div>
          <div className="flex justify-between gap-4 border-t pt-2" style={{ borderColor: "var(--border-subtle)" }}>
            <span className="text-text-secondary">Storage used by this app</span>
            <span className="tabular-nums">
              {storage.usage !== null && storage.quota !== null
                ? `${humanBytes(storage.usage)} of ${humanBytes(storage.quota)}`
                : "Not reported by this browser"}
            </span>
          </div>
        </div>
        <Row
          label="Keep copies of audio in this app"
          hint={
            fileSystemAccessSupported()
              ? "Files imported through the folder/file fallback can't be re-opened after a reload; a stored copy keeps them playable. Uses device storage."
              : "This browser can't retain file access between visits, so copies keep your library playable after a reload. Uses device storage."
          }
        >
          <Toggle checked={prefs.storeAudioCopies} onChange={(value) => update({ storeAudioCopies: value })} label="Store audio copies" />
        </Row>
        {storage.persisted === false && navigator.storage?.persist && (
          <button
            type="button"
            className="text-xs text-accent underline underline-offset-2"
            onClick={() => {
              void navigator.storage?.persist?.().then((granted) => {
                setStorage((current) => ({ ...current, persisted: granted }));
                toast(granted ? "success" : "info", granted ? "Storage marked as persistent." : "The browser declined persistent storage.");
              });
            }}
          >
            Request persistent storage
          </button>
        )}
      </Section>

      <CloudAccountSection />

      <Section title="Backup">
        <p className="px-1 text-sm text-text-secondary">
          Export your library metadata, playlists, likes, and lyrics as a JSON file. Audio files are never included — after
          restoring on any device, re-import your music to re-link it.
        </p>
        <div className="flex flex-wrap gap-2 px-1">
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-lg bg-accent-strong px-4 py-2 text-sm font-medium text-accent-contrast"
            onClick={() => void handleExport()}
          >
            <ImportIcon size={16} className="rotate-180" />
            Export backup
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            aria-hidden
            tabIndex={-1}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void handleImportFile(file);
            }}
          />
          <button
            type="button"
            className="rounded-lg border px-4 py-2 text-sm text-text-primary transition-colors hover:bg-surface-hover"
            style={{ borderColor: "var(--border-strong)" }}
            onClick={() => fileInputRef.current?.click()}
          >
            Restore from backup…
          </button>
        </div>
      </Section>

      <Section title="Data">
        <Row
          label="Clear library metadata"
          hint="Removes tracks, playlists, and lyrics from this app. Your audio files are never touched."
        >
          <button
            type="button"
            className="rounded-lg bg-danger/15 px-3.5 py-1.5 text-sm text-danger transition-colors hover:bg-danger/25"
            onClick={() => setConfirmClearLibrary(true)}
          >
            Clear library
          </button>
        </Row>
        <Row label="Reset everything" hint="Clears the library and all settings, restoring this app to a fresh state.">
          <button
            type="button"
            className="rounded-lg bg-danger/15 px-3.5 py-1.5 text-sm text-danger transition-colors hover:bg-danger/25"
            onClick={() => setConfirmClearAll(true)}
          >
            Reset app data
          </button>
        </Row>
      </Section>

      <Section title="About & limits">
        <ul className="list-inside list-disc space-y-1.5 px-1 text-sm text-text-secondary">
          <li>Local Music {APP_VERSION} — an offline personal music player. Original implementation; not affiliated with any other music app.</li>
          <li>Your audio, artwork, lyrics, and metadata never leave this device. There is no server, account, or analytics.</li>
          <li>
            Playback support depends on your browser's codecs: MP3, AAC/M4A, FLAC, OGG/Vorbis/Opus, and WAV generally work in
            current Chrome, Edge, and Firefox. Files your browser can't decode are reported during import.
          </li>
          <li className="flex items-start gap-1.5">
            <OfflineIcon size={15} className="mt-0.5 shrink-0" />
            <span>
              After the app shell is cached (first visit online, or install), the interface and saved data load offline. Browsers
              decide when to evict cached sites under storage pressure.
            </span>
          </li>
        </ul>
      </Section>

      {/* Dialogs */}
      <ConfirmDialog
        open={confirmClearLibrary}
        title="Clear library?"
        description={
          <>
            All tracks, playlists, liked songs, and lyrics will be removed from this app's storage on this device.{" "}
            <strong>Your original audio files are never deleted.</strong> Consider exporting a backup first.
          </>
        }
        confirmLabel="Clear library"
        onConfirm={() => {
          void clearLibrary().then(() => {
            toast("success", "Library cleared.");
            void useLibraryStore.getState().init();
          });
          setConfirmClearLibrary(false);
        }}
        onCancel={() => setConfirmClearLibrary(false)}
      />
      <ConfirmDialog
        open={confirmClearAll}
        title="Reset all app data?"
        description={
          <>
            This clears the library, lyrics, playlists, <strong>and all settings</strong>, restoring the app to a fresh state.
            Your audio files are never deleted.
          </>
        }
        confirmLabel="Reset everything"
        onConfirm={() => {
          void (async () => {
            await repository.clearAllData();
            await useLibraryStore.getState().init();
            useSettingsStore.getState().update({ theme: "dark" });
          })().then(() => toast("success", "App data reset."));
          setConfirmClearAll(false);
        }}
        onCancel={() => setConfirmClearAll(false)}
      />

      {/* Restore dialogs */}
      <Modal open={restore.phase === "confirm"} title="Restore backup?" onClose={() => setRestore({ phase: "idle" })} width="max-w-sm">
        {restore.phase === "confirm" && (
          <>
            <p className="text-sm text-text-secondary">
              This backup from {restore.summary.exportedAt ? new Date(restore.summary.exportedAt).toLocaleString() : "unknown date"}{" "}
              contains:
            </p>
            <ul className="mt-2 list-inside list-disc text-sm text-text-secondary">
              <li>{restore.summary.trackCount} tracks ({restore.summary.likedCount} liked)</li>
              <li>{restore.summary.playlistCount} playlists</li>
              <li>{restore.summary.lyricCount} songs with lyrics</li>
            </ul>
            <p className="mt-3 rounded-lg bg-surface-raised p-3 text-xs text-text-secondary">
              <InfoIcon size={13} className="mr-1 inline" />
              Restoring <strong>replaces</strong> your current library metadata, playlists, and lyrics. Audio files are never
              included — you'll re-link them after restoring.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" className="rounded-lg px-4 py-2 text-sm text-text-secondary hover:bg-surface-hover" onClick={() => setRestore({ phase: "idle" })}>
                Cancel
              </button>
              <button
                type="button"
                className="rounded-lg bg-accent-strong px-4 py-2 text-sm font-medium text-accent-contrast"
                onClick={() => void confirmRestore()}
              >
                Replace and restore
              </button>
            </div>
          </>
        )}
      </Modal>
      <Modal open={restore.phase === "invalid"} title="Backup not valid" onClose={() => setRestore({ phase: "idle" })} width="max-w-sm">
        <p className="text-sm text-text-secondary">The file was not restored. Nothing has been changed.</p>
        <ul className="mt-2 list-inside list-disc text-sm text-danger">
          {restore.phase === "invalid" && restore.errors.map((error) => <li key={error}>{error}</li>)}
        </ul>
      </Modal>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section aria-label={title}>
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-text-muted">{title}</h2>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl px-1 py-2">
      <div className="min-w-0">
        <div className="text-sm text-text-primary">{label}</div>
        {hint && <div className="mt-0.5 text-xs text-text-muted">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`relative h-6 w-11 rounded-full transition-colors ${checked ? "bg-accent-strong" : "bg-surface-hover"}`}
      onClick={() => onChange(!checked)}
    >
      <span
        className={`absolute top-0.5 size-5 rounded-full bg-text-primary transition-transform ${checked ? "translate-x-[22px]" : "translate-x-0.5"}`}
      />
    </button>
  );
}
