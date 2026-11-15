import { afterEach, describe, expect, it, vi } from "vitest";
import {
  IMAGE_LOAD_TIMEOUT_MS,
  MediaSessionController,
  type MediaSessionActions,
  type MediaSessionPlaybackPosition,
  type MediaSessionTrack,
} from "./mediaSession";

/**
 * The controller must be a safe, optional layer over the Media Session API:
 * feature-detected per capability, validating positions, converting artwork
 * to JPEG data URLs without ever blocking or breaking audio, deduping
 * repeated artwork publications, and cleaning up completely on dispose.
 */

type RecordedHandler = MediaSessionActionHandler | null;

function installMockSession(): {
  session: {
    metadata: MediaMetadata | null;
    playbackState: MediaSessionPlaybackState;
    setActionHandler: ReturnType<typeof vi.fn>;
    setPositionState: ReturnType<typeof vi.fn>;
  };
  handlers: Map<MediaSessionAction, RecordedHandler>;
  positionStates: (MediaPositionState | undefined)[];
} {
  const handlers = new Map<MediaSessionAction, RecordedHandler>();
  const positionStates: (MediaPositionState | undefined)[] = [];
  const session = {
    metadata: null as MediaMetadata | null,
    playbackState: "none" as MediaSessionPlaybackState,
    setActionHandler: vi.fn((action: MediaSessionAction, handler: RecordedHandler) => {
      handlers.set(action, handler);
    }),
    setPositionState: vi.fn((state?: MediaPositionState) => {
      positionStates.push(state);
    }),
  };
  Object.defineProperty(navigator, "mediaSession", { value: session, configurable: true });
  return { session, handlers, positionStates };
}

class FakeMediaMetadata {
  title = "";
  artist = "";
  album = "";
  artwork: MediaImage[] = [];
  constructor(init: MediaMetadataInit = {}) {
    this.title = init.title ?? "";
    this.artist = init.artist ?? "";
    this.album = init.album ?? "";
    this.artwork = init.artwork ? [...init.artwork] : [];
  }
}

class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 0;
  naturalHeight = 0;
  crossOrigin: string | null = null;
  src = "";
  /** Mirrors the real DOM: dropping the src attribute cancels the fetch. */
  removeAttribute(_name?: string): void {
    this.src = "";
  }
}

/** Installs a controllable Image global; returns the created instances in order. */
function installFakeImage(): FakeImage[] {
  const images: FakeImage[] = [];
  vi.stubGlobal(
    "Image",
    class extends FakeImage {
      constructor() {
        super();
        images.push(this);
      }
    },
  );
  return images;
}

function installWorkingCanvas(): { drawCalls: { dx: number; dy: number; dw: number; dh: number }[] } {
  const drawCalls: { dx: number; dy: number; dw: number; dh: number }[] = [];
  const fakeContext = {
    drawImage: (...args: unknown[]) => {
      drawCalls.push({ dx: args[1] as number, dy: args[2] as number, dw: args[3] as number, dh: args[4] as number });
    },
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(fakeContext as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(function (this: HTMLCanvasElement) {
    return `data:image/jpeg;base64,${this.width}`;
  });
  return { drawCalls };
}

function makeActions(): MediaSessionActions & Record<keyof MediaSessionActions, ReturnType<typeof vi.fn>> {
  return {
    play: vi.fn(),
    pause: vi.fn(),
    previous: vi.fn(),
    next: vi.fn(),
    seek: vi.fn(),
    seekBy: vi.fn(),
  };
}

const track: MediaSessionTrack = { title: "Song", artist: "Artist", album: "Album" };
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function fireAction(handlers: Map<MediaSessionAction, RecordedHandler>, action: MediaSessionAction, details?: Partial<MediaSessionActionDetails>): void {
  const handler = handlers.get(action);
  expect(handler, `expected a registered ${action} handler`).not.toBeNull();
  handler?.({ action, ...details } as MediaSessionActionDetails);
}

afterEach(() => {
  delete (navigator as unknown as { mediaSession?: unknown }).mediaSession;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("MediaSessionController feature detection", () => {
  it("is a complete no-op when navigator.mediaSession is missing", async () => {
    Object.defineProperty(navigator, "mediaSession", { value: undefined, configurable: true });
    vi.stubGlobal("MediaMetadata", FakeMediaMetadata);
    const images = installFakeImage();
    const actions = makeActions();
    expect(() => new MediaSessionController(actions)).not.toThrow();
    const controller = new MediaSessionController(actions);
    expect(() => {
      controller.setTrack(track, "blob:cover");
      controller.setArtwork("blob:other");
      controller.syncPlayback(true, { duration: 100, position: 1 });
      controller.syncPlayback(false);
      controller.clear();
      controller.dispose();
    }).not.toThrow();
    // Unsupported session: no image is ever fetched for artwork.
    expect(images).toHaveLength(0);
    expect(actions.play).not.toHaveBeenCalled();
  });

  it("is a no-op when mediaSession exists but cannot register actions", () => {
    Object.defineProperty(navigator, "mediaSession", {
      value: { metadata: null, playbackState: "none" },
      configurable: true,
    });
    const actions = makeActions();
    const controller = new MediaSessionController(actions);
    expect(() => controller.syncPlayback(true)).not.toThrow();
    controller.setTrack(track);
    controller.dispose();
    expect(actions.play).not.toHaveBeenCalled();
  });

  it("is a no-op for metadata when MediaMetadata is missing globally", () => {
    const { session } = installMockSession();
    const images = installFakeImage();
    const controller = new MediaSessionController(makeActions());
    controller.setTrack(track, "blob:cover");
    // No way to publish metadata: the conversion (and its image fetch) is skipped.
    expect(images).toHaveLength(0);
    expect(session.metadata).toBeNull();
    expect(() => controller.syncPlayback(true, { duration: 10, position: 1 })).not.toThrow();
    expect(session.playbackState).toBe("playing");
  });
});

describe("MediaSessionController action handlers", () => {
  it("registers transport and seek actions and forwards them to the actions", () => {
    const { handlers } = installMockSession();
    vi.stubGlobal("MediaMetadata", FakeMediaMetadata);
    const actions = makeActions();
    new MediaSessionController(actions);
    fireAction(handlers, "play");
    fireAction(handlers, "pause");
    fireAction(handlers, "previoustrack");
    fireAction(handlers, "nexttrack");
    expect(actions.play).toHaveBeenCalledTimes(1);
    expect(actions.pause).toHaveBeenCalledTimes(1);
    expect(actions.previous).toHaveBeenCalledTimes(1);
    expect(actions.next).toHaveBeenCalledTimes(1);
  });

  it("forwards seekto only for finite non-negative seek times", () => {
    const { handlers } = installMockSession();
    vi.stubGlobal("MediaMetadata", FakeMediaMetadata);
    const actions = makeActions();
    new MediaSessionController(actions);
    fireAction(handlers, "seekto", { seekTime: 42.5 });
    expect(actions.seek).toHaveBeenCalledWith(42.5);
    actions.seek.mockClear();
    fireAction(handlers, "seekto", { seekTime: Number.NaN });
    fireAction(handlers, "seekto", { seekTime: Number.POSITIVE_INFINITY });
    fireAction(handlers, "seekto", { seekTime: -1 });
    expect(actions.seek).not.toHaveBeenCalled();
  });

  it("defaults seekbackward/seekforward to 10 seconds and honors valid offsets", () => {
    const { handlers } = installMockSession();
    vi.stubGlobal("MediaMetadata", FakeMediaMetadata);
    const actions = makeActions();
    new MediaSessionController(actions);
    fireAction(handlers, "seekbackward");
    fireAction(handlers, "seekforward");
    expect(actions.seekBy).toHaveBeenNthCalledWith(1, -10);
    expect(actions.seekBy).toHaveBeenNthCalledWith(2, 10);
    fireAction(handlers, "seekbackward", { seekOffset: 30 });
    fireAction(handlers, "seekforward", { seekOffset: 15 });
    expect(actions.seekBy).toHaveBeenNthCalledWith(3, -30);
    expect(actions.seekBy).toHaveBeenNthCalledWith(4, 15);
    actions.seekBy.mockClear();
    fireAction(handlers, "seekbackward", { seekOffset: 0 });
    fireAction(handlers, "seekforward", { seekOffset: -5 });
    fireAction(handlers, "seekbackward", { seekOffset: Number.NaN });
    expect(actions.seekBy).not.toHaveBeenCalled();
  });

  it("keeps other actions when one registration throws, and nulls only registered ones on dispose", () => {
    const { session, handlers } = installMockSession();
    session.setActionHandler.mockImplementation((action: MediaSessionAction, handler: RecordedHandler) => {
      if (action === "seekto") throw new TypeError("unsupported action");
      handlers.set(action, handler);
    });
    vi.stubGlobal("MediaMetadata", FakeMediaMetadata);
    const actions = makeActions();
    const controller = new MediaSessionController(actions);
    expect(handlers.has("seekto")).toBe(false);
    fireAction(handlers, "play");
    expect(actions.play).toHaveBeenCalledTimes(1);
    controller.dispose();
    expect(handlers.get("play")).toBeNull();
    expect(handlers.get("seekto")).toBeUndefined();
  });
});

describe("MediaSessionController syncPlayback", () => {
  it("publishes playback state and validated position states", () => {
    const { session, positionStates } = installMockSession();
    vi.stubGlobal("MediaMetadata", FakeMediaMetadata);
    const controller = new MediaSessionController(makeActions());
    controller.syncPlayback(true, { duration: 180, position: 30.5, playbackRate: 1.25 });
    expect(session.playbackState).toBe("playing");
    expect(session.setPositionState).toHaveBeenCalledWith({ duration: 180, position: 30.5, playbackRate: 1.25 });
    controller.syncPlayback(false);
    expect(session.playbackState).toBe("paused");
    expect(positionStates.at(-1)).toBeUndefined();
  });

  it("clamps the position into [0, duration] and defaults an invalid rate to 1", () => {
    const { session } = installMockSession();
    vi.stubGlobal("MediaMetadata", FakeMediaMetadata);
    const controller = new MediaSessionController(makeActions());
    controller.syncPlayback(true, { duration: 100, position: 150, playbackRate: 0 });
    expect(session.setPositionState).toHaveBeenLastCalledWith({ duration: 100, position: 100, playbackRate: 1 });
    controller.syncPlayback(true, { duration: 100, position: -2 });
    expect(session.setPositionState).toHaveBeenLastCalledWith({ duration: 100, position: 0, playbackRate: 1 });
  });

  it("clears position state for invalid durations or non-finite positions", () => {
    const { session } = installMockSession();
    vi.stubGlobal("MediaMetadata", FakeMediaMetadata);
    const controller = new MediaSessionController(makeActions());
    const invalid: MediaSessionPlaybackPosition[] = [
      { duration: 0, position: 5 },
      { duration: -10, position: 5 },
      { duration: Number.NaN, position: 5 },
      { duration: 100, position: Number.NaN },
      { duration: 100, position: Number.POSITIVE_INFINITY },
    ];
    for (const position of invalid) {
      controller.syncPlayback(true, position);
      expect(session.setPositionState, JSON.stringify(position)).toHaveBeenLastCalledWith();
    }
  });

  it("clears position state when it is rejected by the platform", () => {
    const { session } = installMockSession();
    session.setPositionState.mockImplementation((state?: MediaPositionState) => {
      if (state) throw new TypeError("bad state");
    });
    vi.stubGlobal("MediaMetadata", FakeMediaMetadata);
    const controller = new MediaSessionController(makeActions());
    controller.syncPlayback(true, { duration: 100, position: 10 });
    expect(session.setPositionState).toHaveBeenLastCalledWith();
    expect(session.playbackState).toBe("playing");
  });
});

describe("MediaSessionController metadata and artwork", () => {
  it("publishes text metadata immediately and upgrades with JPEG artwork when ready", async () => {
    installMockSession();
    vi.stubGlobal("MediaMetadata", FakeMediaMetadata);
    const images = installFakeImage();
    const { drawCalls } = installWorkingCanvas();
    const controller = new MediaSessionController(makeActions());

    controller.setTrack(track, "blob:cover");
    // Text-only metadata is published synchronously, artwork never blocks it.
    const first = expect_last_metadata();
    expect(first.title).toBe("Song");
    expect(first.artist).toBe("Artist");
    expect(first.album).toBe("Album");
    expect(first.artwork).toEqual([]);

    const image = images.at(-1);
    expect(image?.src).toBe("blob:cover");
    if (!image) return;
    image.naturalWidth = 100;
    image.naturalHeight = 50;
    image.onload?.();
    await flush();

    const upgraded = expect_last_metadata();
    expect(upgraded.title).toBe("Song");
    expect(upgraded.artwork).toHaveLength(3);
    expect(upgraded.artwork.map((a) => a.sizes)).toEqual(["96x96", "256x256", "512x512"]);
    expect(upgraded.artwork.every((a) => a.type === "image/jpeg")).toBe(true);
    expect(upgraded.artwork.every((a) => a.src.startsWith("data:image/jpeg"))).toBe(true);
    // Cover-fit center crop of a 100x50 source into squares.
    expect(drawCalls).toEqual([
      { dx: -48, dy: 0, dw: 192, dh: 96 },
      { dx: -128, dy: 0, dw: 512, dh: 256 },
      { dx: -256, dy: 0, dw: 1024, dh: 512 },
    ]);
    expect(images).toHaveLength(1);
  });

  it("rejects stale artwork conversions after the track changed", async () => {
    installMockSession();
    vi.stubGlobal("MediaMetadata", FakeMediaMetadata);
    const images = installFakeImage();
    installWorkingCanvas();
    const controller = new MediaSessionController(makeActions());

    controller.setTrack({ title: "First", artist: "A", album: "B" }, "blob:first-art");
    const firstImage = images.at(-1);
    controller.setTrack({ title: "Second", artist: "A", album: "B" }, "blob:second-art");
    const secondImage = images.at(-1);
    expect(images).toHaveLength(2);

    // The stale conversion resolves first and must not touch the metadata.
    if (!firstImage) return;
    firstImage.naturalWidth = 10;
    firstImage.naturalHeight = 10;
    firstImage.onload?.();
    await flush();
    expect(expect_last_metadata().title).toBe("Second");
    expect(expect_last_metadata().artwork).toEqual([]);

    if (!secondImage) return;
    secondImage.naturalWidth = 10;
    secondImage.naturalHeight = 10;
    secondImage.onload?.();
    await flush();
    const upgraded = expect_last_metadata();
    expect(upgraded.title).toBe("Second");
    expect(upgraded.artwork).toHaveLength(3);
    // The applied data URLs come from the newest conversion only.
    expect(upgraded.artwork.every((a) => a.src === `data:image/jpeg;base64,${parseInt(a.sizes ?? "", 10)}`)).toBe(true);
  });

  it("dedupes setArtwork with the same URL, including a pending conversion", async () => {
    installMockSession();
    vi.stubGlobal("MediaMetadata", FakeMediaMetadata);
    const images = installFakeImage();
    installWorkingCanvas();
    const controller = new MediaSessionController(makeActions());

    controller.setTrack(track, "blob:cover");
    controller.setArtwork("blob:cover");
    controller.setArtwork("blob:cover");
    expect(images).toHaveLength(1);
    const image = images[0];
    if (!image) return;
    image.naturalWidth = 20;
    image.naturalHeight = 20;
    image.onload?.();
    await flush();
    expect(expect_last_metadata().artwork).toHaveLength(3);

    // After the conversion is cached, repeated publications stay deduped.
    controller.setArtwork("blob:cover");
    await flush();
    expect(images).toHaveLength(1);
    expect(expect_last_metadata().artwork).toHaveLength(3);
  });

  it("resets the artwork dedupe on setTrack, allowing a retry after failure", async () => {
    installMockSession();
    vi.stubGlobal("MediaMetadata", FakeMediaMetadata);
    const images = installFakeImage();
    installWorkingCanvas();
    const controller = new MediaSessionController(makeActions());

    controller.setTrack(track, "blob:cover");
    const failed = images.at(-1);
    failed?.onerror?.();
    await flush();
    expect(expect_last_metadata().artwork).toEqual([]);

    // Same URL publication is deduped (already the current target)…
    controller.setArtwork("blob:cover");
    expect(images).toHaveLength(1);
    // …but setTrack resets the dedupe and retries the conversion.
    controller.setTrack(track, "blob:cover");
    expect(images).toHaveLength(2);
    const retry = images.at(-1);
    if (!retry) return;
    retry.naturalWidth = 20;
    retry.naturalHeight = 20;
    retry.onload?.();
    await flush();
    expect(expect_last_metadata().artwork).toHaveLength(3);
  });

  it("clears artwork via setArtwork(undefined) without clearing the track", async () => {
    installMockSession();
    vi.stubGlobal("MediaMetadata", FakeMediaMetadata);
    const images = installFakeImage();
    installWorkingCanvas();
    const controller = new MediaSessionController(makeActions());

    controller.setTrack(track, "blob:cover");
    const image = images[0];
    if (!image) return;
    image.naturalWidth = 20;
    image.naturalHeight = 20;
    image.onload?.();
    await flush();
    expect(expect_last_metadata().artwork).toHaveLength(3);

    controller.setArtwork(undefined);
    const metadata = expect_last_metadata();
    expect(metadata.title).toBe("Song");
    expect(metadata.artist).toBe("Artist");
    expect(metadata.artwork).toEqual([]);
  });

  it("keeps text metadata when the image fails, the canvas fails, or a non-data URL is produced", async () => {
    installMockSession();
    vi.stubGlobal("MediaMetadata", FakeMediaMetadata);
    const images = installFakeImage();
    // jsdom's default canvas produces "data:," — i.e. conversion failure.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: () => undefined,
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:,");
    const controller = new MediaSessionController(makeActions());

    controller.setTrack(track, "blob:cover");
    const image = images[0];
    if (!image) return;
    image.naturalWidth = 20;
    image.naturalHeight = 20;
    image.onload?.();
    await flush();
    const metadata = expect_last_metadata();
    expect(metadata.title).toBe("Song");
    expect(metadata.artwork).toEqual([]);

    // A blob: URL must never reach final metadata either.
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("blob:sneaky");
    controller.setTrack(track, "blob:cover-2");
    const image2 = images.at(-1);
    if (!image2) return;
    image2.naturalWidth = 20;
    image2.naturalHeight = 20;
    image2.onload?.();
    await flush();
    expect(expect_last_metadata().artwork).toEqual([]);
  });

  it("keeps text metadata when the image fails to load", async () => {
    installMockSession();
    vi.stubGlobal("MediaMetadata", FakeMediaMetadata);
    const images = installFakeImage();
    const controller = new MediaSessionController(makeActions());

    controller.setTrack(track, "blob:missing");
    const image = images[0];
    if (!image) return;
    image.onerror?.();
    await flush();
    const metadata = expect_last_metadata();
    expect(metadata.title).toBe("Song");
    expect(metadata.artwork).toEqual([]);
    expect(() => controller.syncPlayback(true, { duration: 10, position: 0 })).not.toThrow();
  });

  it("ignores artwork with zero intrinsic dimensions", async () => {
    installMockSession();
    vi.stubGlobal("MediaMetadata", FakeMediaMetadata);
    const images = installFakeImage();
    installWorkingCanvas();
    const controller = new MediaSessionController(makeActions());

    controller.setTrack(track, "blob:empty");
    const image = images[0];
    if (!image) return;
    image.onload?.();
    await flush();
    expect(expect_last_metadata().artwork).toEqual([]);
  });
});

describe("MediaSessionController conversion lifecycle", () => {
  it("cancels the pending image load when the track changes", async () => {
    installMockSession();
    vi.stubGlobal("MediaMetadata", FakeMediaMetadata);
    const images = installFakeImage();
    installWorkingCanvas();
    const controller = new MediaSessionController(makeActions());

    controller.setTrack({ title: "First", artist: "A", album: "B" }, "blob:first");
    controller.setTrack({ title: "Second", artist: "A", album: "B" }, "blob:second");
    expect(images).toHaveLength(2);
    // The superseded load is cancelled, not left pending forever.
    expect(images[0]?.src).toBe("");
    expect(images[0]?.onload).toBeNull();
    expect(images[0]?.onerror).toBeNull();

    // Even a late load event for the cancelled image must do nothing.
    const stale = images[0];
    if (stale) {
      stale.naturalWidth = 10;
      stale.naturalHeight = 10;
      stale.onload?.();
    }
    await flush();
    expect(expect_last_metadata().artwork).toEqual([]);

    const current = images[1];
    if (!current) return;
    current.naturalWidth = 10;
    current.naturalHeight = 10;
    current.onload?.();
    await flush();
    const metadata = expect_last_metadata();
    expect(metadata.title).toBe("Second");
    expect(metadata.artwork).toHaveLength(3);
  });

  it("cancels the pending image load on clear() and dispose()", () => {
    installMockSession();
    vi.stubGlobal("MediaMetadata", FakeMediaMetadata);
    const images = installFakeImage();
    installWorkingCanvas();
    const controller = new MediaSessionController(makeActions());
    controller.setTrack(track, "blob:cover");
    controller.clear();
    expect(images[0]?.src).toBe("");
    const controller2 = new MediaSessionController(makeActions());
    controller2.setTrack(track, "blob:cover");
    controller2.dispose();
    expect(images[1]?.src).toBe("");
  });

  it("aborts image loads after the bounded timeout", async () => {
    vi.useFakeTimers();
    try {
      installMockSession();
      vi.stubGlobal("MediaMetadata", FakeMediaMetadata);
      const images = installFakeImage();
      installWorkingCanvas();
      const controller = new MediaSessionController(makeActions());

      controller.setTrack(track, "blob:slow");
      expect(images).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(IMAGE_LOAD_TIMEOUT_MS + 1);
      // The load was cancelled and metadata kept its text-only state.
      expect(images[0]?.src).toBe("");
      expect(expect_last_metadata().artwork).toEqual([]);
      expect(() => controller.syncPlayback(true, { duration: 10, position: 1 })).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it("contains Image construction failures without unhandled rejections", async () => {
    installMockSession();
    vi.stubGlobal("MediaMetadata", FakeMediaMetadata);
    vi.stubGlobal(
      "Image",
      class {
        constructor() {
          throw new Error("images unavailable");
        }
      },
    );
    const controller = new MediaSessionController(makeActions());
    expect(() => controller.setTrack(track, "blob:cover")).not.toThrow();
    await flush();
    expect(expect_last_metadata().artwork).toEqual([]);
    expect(() => controller.syncPlayback(true, { duration: 10, position: 1 })).not.toThrow();
  });

  it("keeps text-only metadata when the canvas itself is broken for blob artwork", async () => {
    installMockSession();
    vi.stubGlobal("MediaMetadata", FakeMediaMetadata);
    const images = installFakeImage();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => {
      throw new Error("no canvas");
    });
    const controller = new MediaSessionController(makeActions());

    controller.setTrack(track, "blob:cover");
    const image = images[0];
    if (!image) return;
    image.naturalWidth = 20;
    image.naturalHeight = 20;
    image.onload?.();
    await flush();
    // blob: URLs get no direct-URL fallback — conversion failure stays text-only.
    expect(expect_last_metadata().artwork).toEqual([]);
  });

  it("converts remote artwork when the host allows CORS", async () => {
    installMockSession();
    vi.stubGlobal("MediaMetadata", FakeMediaMetadata);
    const images = installFakeImage();
    installWorkingCanvas();
    const controller = new MediaSessionController(makeActions());

    controller.setTrack(track, "https://example.com/cover.jpg");
    // Remote loads request CORS first so the canvas is not tainted.
    expect(images[0]?.crossOrigin).toBe("anonymous");
    const image = images[0];
    if (!image) return;
    image.naturalWidth = 100;
    image.naturalHeight = 50;
    image.onload?.();
    await flush();
    expect(expect_last_metadata().artwork).toHaveLength(3);
    expect(images).toHaveLength(1);
  });

  it("falls back to the original URL when remote artwork cannot be converted", async () => {
    installMockSession();
    vi.stubGlobal("MediaMetadata", FakeMediaMetadata);
    const images = installFakeImage();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: () => undefined,
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(() => {
      throw new Error("tainted canvas");
    });
    const controller = new MediaSessionController(makeActions());
    const url = "https://example.com/cover.jpg";

    controller.setTrack(track, url);
    // First attempt loads with CORS; the host refuses → load error.
    expect(images[0]?.crossOrigin).toBe("anonymous");
    images[0]?.onerror?.();
    await flush();
    // Retry without CORS loads, but toDataURL throws → direct-URL fallback.
    expect(images).toHaveLength(2);
    expect(images[1]?.crossOrigin).toBeNull();
    const image = images[1];
    if (!image) return;
    image.naturalWidth = 100;
    image.naturalHeight = 100;
    image.onload?.();
    await flush();
    const metadata = expect_last_metadata();
    expect(metadata.title).toBe("Song");
    expect(metadata.artwork).toEqual([{ src: url, sizes: "512x512" }]);
    expect(metadata.artwork.every((a) => !a.src.startsWith("blob:"))).toBe(true);
  });
});

describe("MediaSessionController clear and dispose", () => {
  it("clear() resets metadata, playback state and position but keeps actions working", () => {
    const { session, positionStates, handlers } = installMockSession();
    vi.stubGlobal("MediaMetadata", FakeMediaMetadata);
    const actions = makeActions();
    const controller = new MediaSessionController(actions);
    controller.syncPlayback(true, { duration: 100, position: 10 });
    controller.clear();
    expect(session.metadata).toBeNull();
    expect(session.playbackState).toBe("none");
    expect(positionStates.at(-1)).toBeUndefined();
    fireAction(handlers, "play");
    expect(actions.play).toHaveBeenCalledTimes(1);
  });

  it("dispose() nulls handlers and all published state and makes further calls inert", async () => {
    const { session, positionStates, handlers } = installMockSession();
    vi.stubGlobal("MediaMetadata", FakeMediaMetadata);
    const images = installFakeImage();
    installWorkingCanvas();
    const actions = makeActions();
    const controller = new MediaSessionController(actions);

    controller.syncPlayback(true, { duration: 100, position: 10 });
    controller.dispose();
    for (const action of ["play", "pause", "previoustrack", "nexttrack", "seekto", "seekbackward", "seekforward"] as const) {
      expect(handlers.get(action)).toBeNull();
    }
    expect(session.metadata).toBeNull();
    expect(session.playbackState).toBe("none");
    expect(positionStates.at(-1)).toBeUndefined();

    // Post-dispose calls must not resurrect any state.
    controller.setTrack(track, "blob:cover");
    const image = images.at(-1);
    if (image) {
      image.naturalWidth = 10;
      image.naturalHeight = 10;
      image.onload?.();
    }
    controller.setArtwork("blob:cover");
    controller.syncPlayback(true, { duration: 100, position: 10 });
    await flush();
    expect(session.metadata).toBeNull();
    expect(session.playbackState).toBe("none");
    expect(images).toHaveLength(0);
    expect(actions.play).not.toHaveBeenCalled();
  });

  it("clear() and dispose() invalidate an in-flight artwork conversion", async () => {
    const { session } = installMockSession();
    vi.stubGlobal("MediaMetadata", FakeMediaMetadata);
    const images = installFakeImage();
    installWorkingCanvas();
    const controller = new MediaSessionController(makeActions());

    controller.setTrack(track, "blob:cover");
    const image = images.at(-1);
    controller.clear();
    if (!image) return;
    image.naturalWidth = 10;
    image.naturalHeight = 10;
    image.onload?.();
    await flush();
    expect(session.metadata).toBeNull();

    const controller2 = new MediaSessionController(makeActions());
    controller2.setTrack(track, "blob:cover");
    const image2 = images.at(-1);
    controller2.dispose();
    if (!image2) return;
    image2.naturalWidth = 10;
    image2.naturalHeight = 10;
    image2.onload?.();
    await flush();
    expect(session.metadata).toBeNull();
  });
});

/** Reads the metadata the controller last published onto the installed session. */
function expect_last_metadata(): FakeMediaMetadata {
  const session = (navigator as unknown as { mediaSession: { metadata: FakeMediaMetadata | null } }).mediaSession;
  expect(session.metadata).not.toBeNull();
  return session.metadata as FakeMediaMetadata;
}
