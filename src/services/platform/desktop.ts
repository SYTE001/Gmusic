import { convertFileSrc, invoke } from "@tauri-apps/api/core";

export type DesktopAudioFileInfo = {
  path: string;
  name: string;
  size: number;
  mimeType: string;
};

export type DesktopImportItem = DesktopAudioFileInfo & {
  kind: "desktop-file";
};

const AUDIO_EXTENSIONS = ["mp3", "m4a", "m4b", "aac", "wav", "wave", "ogg", "oga", "opus", "flac", "weba", "webm", "mp4"];

/**
 * True when executing inside the Tauri desktop WebView runtime.
 * Checks the injected Tauri v2 internals marker without touching network or storage.
 */
export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function isDesktopImportItem(item: unknown): item is DesktopImportItem {
  return (
    typeof item === "object" &&
    item !== null &&
    "kind" in item &&
    (item as { kind?: unknown }).kind === "desktop-file" &&
    typeof (item as { path?: unknown }).path === "string"
  );
}

export function toDesktopAudioUrl(path: string): string {
  return convertFileSrc(path);
}

async function openDialog(options: {
  multiple?: boolean;
  directory?: boolean;
  filters?: Array<{ name: string; extensions: string[] }>;
}): Promise<string | string[] | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  return open(options);
}

export async function pickDesktopAudioFiles(): Promise<DesktopImportItem[] | null> {
  if (!isTauriRuntime()) return null;
  const selected = await openDialog({
    multiple: true,
    directory: false,
    filters: [{ name: "Audio files", extensions: AUDIO_EXTENSIONS }],
  });
  if (selected === null) return null;
  const paths = Array.isArray(selected) ? selected : [selected];
  if (paths.length === 0) return [];
  const infos = await invoke<DesktopAudioFileInfo[]>("inspect_audio_paths", { paths });
  return infos.map((info) => ({ ...info, kind: "desktop-file" as const }));
}

export async function pickDesktopAudioFolder(): Promise<DesktopImportItem[] | null> {
  if (!isTauriRuntime()) return null;
  const selected = await openDialog({
    multiple: false,
    directory: true,
  });
  if (selected === null) return null;
  const dirPath = Array.isArray(selected) ? selected[0] : selected;
  if (!dirPath) return [];
  const infos = await invoke<DesktopAudioFileInfo[]>("scan_audio_folder", { dirPath });
  return infos.map((info) => ({ ...info, kind: "desktop-file" as const }));
}

export async function pickDesktopSingleAudioFile(): Promise<DesktopImportItem | null> {
  if (!isTauriRuntime()) return null;
  const selected = await openDialog({
    multiple: false,
    directory: false,
    filters: [{ name: "Audio files", extensions: AUDIO_EXTENSIONS }],
  });
  if (selected === null) return null;
  const path = Array.isArray(selected) ? selected[0] : selected;
  if (!path) return null;
  const infos = await invoke<DesktopAudioFileInfo[]>("inspect_audio_paths", { paths: [path] });
  const first = infos[0];
  return first ? { ...first, kind: "desktop-file" as const } : null;
}

export async function authorizeDesktopPaths(paths: string[]): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>();
  if (!isTauriRuntime() || paths.length === 0) return result;
  const statuses = await invoke<Array<{ path: string; exists: boolean }>>("authorize_desktop_paths", { paths });
  for (const status of statuses) {
    result.set(status.path, status.exists);
  }
  return result;
}

export async function readDesktopFileSlice(path: string, start: number, end: number): Promise<ArrayBuffer> {
  const safeStart = Math.max(0, Math.floor(start));
  const safeEnd = Math.max(safeStart, Math.floor(end));
  const length = safeEnd - safeStart;
  if (length === 0) return new ArrayBuffer(0);
  return invoke<ArrayBuffer>("read_audio_file_slice", {
    path,
    offset: safeStart,
    length,
  });
}

/**
 * Lightweight File-compatible slice reader for metadata parsing and partial
 * fingerprinting without loading multi-megabyte audio files into WebView RAM.
 */
export function createDesktopSliceFile(info: DesktopAudioFileInfo): File {
  const makeSlice = (start = 0, end = info.size): Blob => {
    const clampedStart = Math.max(0, Math.min(info.size, start));
    const clampedEnd = Math.max(clampedStart, Math.min(info.size, end));
    return {
      size: clampedEnd - clampedStart,
      type: info.mimeType,
      slice(subStart = 0, subEnd = clampedEnd - clampedStart) {
        return makeSlice(clampedStart + subStart, clampedStart + subEnd);
      },
      arrayBuffer() {
        return readDesktopFileSlice(info.path, clampedStart, clampedEnd);
      },
    } as unknown as Blob;
  };

  return {
    name: info.name,
    size: info.size,
    type: info.mimeType,
    slice(start = 0, end = info.size) {
      return makeSlice(start, end);
    },
    arrayBuffer() {
      return readDesktopFileSlice(info.path, 0, info.size);
    },
  } as unknown as File;
}
