import "fake-indexeddb/auto";

// Node >= 26 ships an experimental `localStorage` global that stays
// uninitialized unless `--localstorage-file` is provided, shadowing jsdom's
// backed implementation in test runs. Restore a working in-memory storage.
if (typeof localStorage === "undefined") {
  const store = new Map<string, string>();
  const memoryStorage: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(String(key), String(value));
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: memoryStorage,
    configurable: true,
    writable: true,
  });
}

// jsdom lacks matchMedia; provide a minimal implementation for components
// that subscribe to system theme changes.
if (typeof window !== "undefined" && !window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

// jsdom has no object URL implementation; file-access resolution needs it.
if (typeof URL !== "undefined" && typeof URL.createObjectURL !== "function") {
  URL.createObjectURL = () => `blob:fake-${Math.random().toString(36).slice(2)}`;
  URL.revokeObjectURL = () => undefined;
}
