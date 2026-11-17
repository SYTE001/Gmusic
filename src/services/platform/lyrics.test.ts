import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverDesktopLyrics, parseDesktopLyrics } from "./lyrics";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const track = { id: "stable-id", title: "Song", artist: "Artist", album: "Album", durationMs: 200000 };
const empty = { candidates: [], errors: [], fromCache: false, offline: false, cacheWarning: null };

beforeEach(() => {
  invoke.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
});
afterEach(() => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  vi.restoreAllMocks();
});

describe("desktop lyrics platform adapter", () => {
  it("web never invokes Rust", async () => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    expect(await discoverDesktopLyrics(track, { providers: ["lrclib"] })).toBeNull();
    expect(await parseDesktopLyrics("plain")).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("sends only the established metadata contract", async () => {
    invoke.mockResolvedValue(empty);
    expect(await discoverDesktopLyrics(track, { providers: ["lrclib"], force: true })).toEqual(empty);
    expect(invoke).toHaveBeenCalledWith("discover_desktop_lyrics", { request: { track, providers: ["lrclib"], force: true, offline: false } });
  });

  it("passes offline explicitly so native discovery can use disk cache", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    invoke.mockResolvedValue({ ...empty, offline: true });
    await discoverDesktopLyrics(track, { providers: ["lrclib"] });
    expect(invoke).toHaveBeenCalledWith("discover_desktop_lyrics", expect.objectContaining({ request: expect.objectContaining({ offline: true }) }));
  });

  it("provider errors do not trigger a second web lookup", async () => {
    invoke.mockResolvedValue({ ...empty, errors: ["lrclib: request timed out"] });
    expect((await discoverDesktopLyrics(track, { providers: ["lrclib"] }))?.errors).toHaveLength(1);
  });

  it.each([null, {}, { ...empty, candidates: [{}] }, { ...empty, errors: [12] }])("rejects malformed IPC responses %#", async (response) => {
    invoke.mockResolvedValue(response);
    expect(await discoverDesktopLyrics(track, { providers: ["lrclib"] })).toBeNull();
  });

  it("falls back when native command is unavailable", async () => {
    invoke.mockRejectedValue(new Error("unknown command"));
    expect(await discoverDesktopLyrics(track, { providers: ["lrclib"] })).toBeNull();
    expect(await parseDesktopLyrics("plain")).toBeNull();
  });

  it("cancels a pending IPC call without returning its late result", async () => {
    let finish: (value: unknown) => void = () => {};
    invoke.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const controller = new AbortController();
    const pending = discoverDesktopLyrics(track, { providers: ["lrclib"], signal: controller.signal });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    finish(empty);
  });

  it("does not dispatch an already cancelled request", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(discoverDesktopLyrics(track, { providers: ["lrclib"], signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("accepts integer genuine word timestamps and rejects invalid ones", async () => {
    const parsed = { format: "lrc", skippedLines: 0, lines: [{ timeMs: 1000, text: "Hi", words: [{ text: "Hi", startMs: 1000, endMs: 1500 }] }] };
    invoke.mockResolvedValue(parsed);
    expect(await parseDesktopLyrics("source")).toEqual(parsed);
    invoke.mockResolvedValue({ ...parsed, lines: [{ timeMs: -1, text: "invalid" }] });
    expect(await parseDesktopLyrics("source")).toBeNull();
  });
});
