import { afterEach, describe, expect, it, vi } from "vitest";
import { requestPersistentStorage, resetPersistentStorageRequest } from "./offlineService";

describe("requestPersistentStorage", () => {
  afterEach(() => {
    resetPersistentStorageRequest();
    vi.unstubAllGlobals();
  });

  it("asks the browser for persistent storage only once per session", () => {
    const persist = vi.fn(async () => true);
    vi.stubGlobal("navigator", { ...navigator, storage: { persist } });
    requestPersistentStorage();
    requestPersistentStorage();
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("does nothing and does not throw when the browser has no storage API", () => {
    vi.stubGlobal("navigator", { ...navigator, storage: undefined });
    expect(() => requestPersistentStorage()).not.toThrow();
  });

  it("swallows a rejected request", async () => {
    const persist = vi.fn(async () => {
      throw new Error("denied");
    });
    vi.stubGlobal("navigator", { ...navigator, storage: { persist } });
    expect(() => requestPersistentStorage()).not.toThrow();
    await Promise.resolve();
  });
});