import "fake-indexeddb/auto";

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
