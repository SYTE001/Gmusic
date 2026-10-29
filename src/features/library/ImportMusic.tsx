import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useLibraryStore } from "../../stores/libraryStore";
import { toast } from "../../stores/toastStore";
import {
  audioAcceptAttribute,
  pickAudioFilesWithPicker,
  pickAudioFolderWithPicker,
  type ImportItem,
} from "../../services/library/importService";
import { fileSystemAccessSupported } from "../../services/file-access/FileAccessService";
import { Modal } from "../../components/Modal";
import { FolderIcon, ImportIcon } from "../../components/Icons";
import type { ImportOutcome } from "../../types";

/** Human-readable summary of an import run, including everything skipped. */
export function ImportOutcomeDialog({ outcome, onClose }: { outcome: ImportOutcome; onClose: () => void }) {
  if (outcome.duplicatesSkipped === 0 && outcome.unsupported.length === 0 && outcome.failed.length === 0) {
    return null;
  }
  return (
    <Modal open title="Import report" onClose={onClose} width="max-w-md">
      <div className="space-y-3 text-sm">
        <p className="text-text-secondary">
          Added <strong className="text-text-primary">{outcome.added}</strong> track
          {outcome.added === 1 ? "" : "s"}.
          {outcome.duplicatesSkipped > 0 && (
            <>
              {" "}
              Skipped <strong className="text-text-primary">{outcome.duplicatesSkipped}</strong> duplicate
              {outcome.duplicatesSkipped === 1 ? "" : "s"}.
            </>
          )}
        </p>
        {outcome.unsupported.length > 0 && (
          <div>
            <h3 className="mb-1 font-medium text-text-primary">Unsupported or undecodable files</h3>
            <p className="mb-2 text-xs text-text-secondary">
              Your browser cannot decode these formats, so they were not added. Converting them to MP3, M4A, FLAC, OGG, or WAV
              usually fixes this.
            </p>
            <ul className="max-h-32 space-y-1 overflow-y-auto text-xs text-text-muted">
              {outcome.unsupported.map((name) => (
                <li key={name} className="truncate">
                  {name}
                </li>
              ))}
            </ul>
          </div>
        )}
        {outcome.failed.length > 0 && (
          <div>
            <h3 className="mb-1 font-medium text-text-primary">Failed to import</h3>
            <ul className="max-h-32 space-y-1 overflow-y-auto text-xs text-text-muted">
              {outcome.failed.map((entry) => (
                <li key={entry.fileName} className="truncate">
                  {entry.fileName} — {entry.reason}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <div className="mt-5 flex justify-end">
        <button
          type="button"
          className="rounded-lg bg-accent-strong px-4 py-2 text-sm font-medium text-accent-contrast"
          onClick={onClose}
        >
          Got it
        </button>
      </div>
    </Modal>
  );
}

/** Runs an import and reports the outcome through a dialog + toast. */
export function useImportFlow() {
  const importItems = useLibraryStore((state) => state.importItems);
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (items: ImportItem[]) => {
    if (items.length === 0) {
      toast("info", "No audio files were selected.");
      return;
    }
    setBusy(true);
    try {
      const result = await importItems(items);
      const skippedTotal = result.duplicatesSkipped + result.unsupported.length + result.failed.length;
      if (result.added > 0 && skippedTotal === 0) {
        toast("success", `Added ${result.added} track${result.added === 1 ? "" : "s"} to your library.`);
      } else if (skippedTotal > 0) {
        setOutcome(result);
      } else if (result.added === 0) {
        toast("info", "Nothing new was imported.");
      }
      if (result.sessionOnlyAdded > 0) {
        toast(
          "info",
          `${result.sessionOnlyAdded} track${result.sessionOnlyAdded === 1 ? "" : "s"} will need re-importing after you reload this app — enable “Keep copies of audio” in Settings to avoid that.`,
        );
      }
    } catch (error) {
      toast("error", error instanceof Error ? `Import failed: ${error.message}` : "Import failed.");
    } finally {
      setBusy(false);
    }
  };

  return { run, busy, outcome, dismissOutcome: () => setOutcome(null) };
}

/**
 * Import buttons with progressive enhancement (PRD §5): File System Access
 * picker + folder import where supported, `<input type="file">` fallback
 * elsewhere.
 */
export function ImportMusicButtons({ variant = "buttons" }: { variant?: "buttons" | "compact" }) {
  const { run, busy } = useImportFlow();
  const inputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const supportsPicker = fileSystemAccessSupported();

  const onPickFiles = async () => {
    if (supportsPicker) {
      try {
        const handles = await pickAudioFilesWithPicker();
        await run(handles);
      } catch (error) {
        if ((error as DOMException)?.name === "AbortError") return;
        toast("error", "The file picker could not be opened.");
      }
    } else {
      inputRef.current?.click();
    }
  };

  const onPickFolder = async () => {
    try {
      const handles = await pickAudioFolderWithPicker();
      await run(handles);
    } catch (error) {
      if ((error as DOMException)?.name === "AbortError") return;
      toast("error", "The folder picker could not be opened.");
    }
  };

  const buttonClass =
    variant === "compact"
      ? "flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-sm hover:bg-surface-hover"
      : "inline-flex items-center gap-2 rounded-lg bg-accent-strong px-4 py-2.5 text-sm font-medium text-accent-contrast transition-opacity hover:opacity-90 disabled:opacity-50";

  return (
    <div className={variant === "buttons" ? "flex flex-wrap items-center gap-2" : ""}>
      {/* Always rendered: the reliable fallback input, used when the picker
          API is unavailable and by assistive/automation flows. */}
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={audioAcceptAttribute()}
        className="hidden"
        aria-hidden
        tabIndex={-1}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          void run(files);
        }}
      />
      <input
        ref={folderInputRef}
        type="file"
        className="hidden"
        // Folder selection fallback (Chromium supports webkitdirectory on input)
        {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          void run(files);
        }}
      />
      <button type="button" className={buttonClass} onClick={onPickFiles} disabled={busy}>
        <ImportIcon size={variant === "compact" ? 17 : 18} />
        {variant === "compact" ? "Import music files" : "Import music"}
      </button>
      <button
        type="button"
        className={
          variant === "compact"
            ? "flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-sm hover:bg-surface-hover"
            : "inline-flex items-center gap-2 rounded-lg border border-line-strong px-4 py-2.5 text-sm font-medium text-text-primary transition-colors hover:bg-surface-hover disabled:opacity-50"
        }
        onClick={() => {
          if (supportsPicker || "showDirectoryPicker" in window) void onPickFolder();
          else folderInputRef.current?.click();
        }}
        disabled={busy}
      >
        <FolderIcon size={variant === "compact" ? 17 : 18} />
        {variant === "compact" ? "Import a folder" : "Folder"}
      </button>
    </div>
  );
}

/** Empty-library state (PRD §7.1) with privacy note. */
export function LibraryEmptyState() {
  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-[var(--radius-tile)] border border-dashed px-6 py-16 text-center" style={{ borderColor: "var(--border-subtle)" }}>
      <div className="grid size-16 place-items-center rounded-2xl bg-surface-raised text-text-secondary" aria-hidden>
        <ImportIcon size={26} />
      </div>
      <div className="max-w-md space-y-1.5">
        <h2 className="text-lg font-semibold">Your library is empty</h2>
        <p className="text-sm text-text-secondary">
          Choose audio files from this device to start your library. MP3, M4A, FLAC, OGG, and WAV are supported where your
          browser can decode them.
        </p>
        <p className="text-xs text-text-muted">
          Your files stay on this device — nothing is uploaded. See{" "}
          <Link to="/settings" className="text-accent underline underline-offset-2">
            Settings
          </Link>{" "}
          for storage details.
        </p>
      </div>
      <ImportMusicButtons />
    </div>
  );
}
