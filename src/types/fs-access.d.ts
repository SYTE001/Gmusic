/**
 * File System Access API additions not present in TypeScript's lib.dom.
 * These are progressive-enhancement APIs (PRD §5): the app works without them
 * through the multi-file input fallback.
 */

type OpenFilePickerOptions = {
  multiple?: boolean;
  excludeAcceptAllOption?: boolean;
  types?: Array<{
    description?: string;
    accept: Record<string, string[]>;
  }>;
};

type DirectoryPickerOptions = {
  mode?: "read" | "readwrite";
  id?: string;
  startIn?: string;
};

interface Window {
  showOpenFilePicker?: (options?: OpenFilePickerOptions) => Promise<FileSystemFileHandle[]>;
  showDirectoryPicker?: (options?: DirectoryPickerOptions) => Promise<FileSystemDirectoryHandle>;
}

/** Directory iteration, absent from lib.dom's minimal handle types. */
interface FileSystemDirectoryHandle extends FileSystemHandle {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
}
