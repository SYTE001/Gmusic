import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { useSettingsStore } from "../../stores/settingsStore";
import LyricsAmbientBackground from "./LyricsAmbientBackground";
import { FALLBACK_URLS, useLyricsAmbient } from "./useLyricsAmbient";

/**
 * jsdom neither decodes images nor implements 2D contexts, so both are
 * replaced: FakeImage lets tests settle/brake decodes explicitly, and a stub
 * recording 2D context calls makes the canvas paint path observable. With
 * those in place the full source-priority flow — artwork, broken artwork,
 * theme-matched fallbacks, crossfade roles, reduced motion — is testable.
 */

const artworkState = vi.hoisted(() => ({ url: undefined as string | undefined }));

vi.mock("../../components/Artwork", () => ({
  useArtworkUrl: () => artworkState.url,
}));

class FakeImage {
  static instances: FakeImage[] = [];
  crossOrigin = "";
  decoding = "";
  complete = false;
  naturalWidth = 0;
  naturalHeight = 0;
  src = "";
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor() {
    FakeImage.instances.push(this);
  }
}

function makeCtx() {
  return {
    fillStyle: "#000000",
    fillRect: vi.fn(),
    drawImage: vi.fn(),
    clearRect: vi.fn(),
  };
}

type Ctx = ReturnType<typeof makeCtx>;
let ctx2d: Ctx;
let filterHistory: string[];

function settleImage(image: FakeImage, ok: boolean, width = 80): void {
  act(() => {
    if (ok) {
      image.naturalWidth = width;
      image.naturalHeight = width;
      image.onload?.();
    } else {
      image.onerror?.();
    }
  });
}

function imageBySrc(fragment: string): FakeImage {
  const image = FakeImage.instances.find((item) => item.src.includes(fragment));
  if (!image) throw new Error(`no FakeImage for ${fragment}`);
  return image;
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeImage.instances = [];
  vi.stubGlobal("Image", FakeImage as unknown as typeof Image);
  ctx2d = makeCtx();
  filterHistory = [];
  Object.defineProperty(ctx2d, "filter", {
    configurable: true,
    get: () => filterHistory[filterHistory.length - 1] ?? "none",
    set: (value: string) => filterHistory.push(value),
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx2d as unknown as CanvasRenderingContext2D);
  useSettingsStore.setState({ resolvedTheme: "dark" });
  delete document.documentElement.dataset.motion;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete document.documentElement.dataset.motion;
});

describe("useLyricsAmbient", () => {
  it("resolves the theme-matched fallback asset and follows theme switches", () => {
    const { result, rerender } = renderHookCurrent(() => useLyricsAmbient(undefined));
    expect(result.current.fallbackImage).toBeNull();

    settleImage(imageBySrc("lyrics-fallback-light"), true);
    settleImage(imageBySrc("lyrics-fallback-dark"), true);
    expect(result.current.fallbackImage).not.toBeNull();
    expect(result.current.theme).toBe("dark");
    expect(FALLBACK_URLS.light).toContain("lyrics-fallback-light");
    expect(FALLBACK_URLS.dark).toContain("lyrics-fallback-dark");

    act(() => {
      useSettingsStore.setState({ resolvedTheme: "light" });
    });
    rerender();
    expect(result.current.theme).toBe("light");
    expect(result.current.fallbackImage?.src).toContain("lyrics-fallback-light");
  });

  it("keeps artwork null when missing or broken, and exposes decoded artwork", () => {
    const { result, rerender } = renderHookCurrent(() => useLyricsAmbient("track-1"));
    expect(result.current.artworkImage).toBeNull();

    artworkState.url = "blob:broken";
    rerender();
    const broken = FakeImage.instances.filter((item) => item.src === "blob:broken").at(-1);
    expect(broken).toBeDefined();
    settleImage(broken!, false);
    expect(result.current.artworkImage).toBeNull();

    artworkState.url = "blob:good";
    rerender();
    const good = FakeImage.instances.filter((item) => item.src === "blob:good").at(-1)!;
    settleImage(good, true);
    expect(result.current.artworkImage).toBe(good);
  });

  it("tracks the reduced-motion preference including the data-motion override", async () => {
    const { result } = renderHookCurrent(() => useLyricsAmbient(undefined));
    expect(result.current.reducedMotion).toBe(false);

    // MutationObserver records are delivered on the microtask queue.
    await act(async () => {
      document.documentElement.dataset.motion = "on";
    });
    expect(result.current.reducedMotion).toBe(true);

    await act(async () => {
      document.documentElement.dataset.motion = "off";
    });
    expect(result.current.reducedMotion).toBe(false);
  });
});

describe("LyricsAmbientBackground", () => {
  it("renders the isolated layer structure once and hides it from the a11y tree", () => {
    const { container } = render(<LyricsAmbientBackground trackId={undefined} />);
    const root = container.querySelector<HTMLElement>(".gm-ambient")!;
    expect(root.getAttribute("aria-hidden")).toBe("true");
    expect(root.querySelectorAll(".gm-ambient__stack")).toHaveLength(2);
    expect(root.querySelectorAll(".gm-ambient__layer--base")).toHaveLength(2);
    expect(root.querySelectorAll(".gm-ambient__scrim")).toHaveLength(1);
  });

  it("first paint settles the first stack, marks ready, and reports the source", () => {
    const { container } = render(<LyricsAmbientBackground trackId={undefined} />);
    const root = container.querySelector<HTMLElement>(".gm-ambient")!;
    const stacks = () => root.querySelectorAll<HTMLElement>(".gm-ambient__stack");
    // Before anything decodes the component paints a flat theme fill.
    expect(root.dataset.source).toBe("empty");

    settleImage(imageBySrc("lyrics-fallback-light"), true);
    settleImage(imageBySrc("lyrics-fallback-dark"), true);
    act(() => vi.advanceTimersByTime(700)); // let the fallback crossfade settle

    expect(root.classList.contains("is-ready")).toBe(true);
    expect(root.dataset.source).toBe("fallback");
    const [a, b] = stacks();
    expect(a.style.opacity).toBe("0");
    expect(a.dataset.paused).toBe("true");
    expect(b.style.opacity).toBe("1");
    expect(b.style.zIndex).toBe("2");
    expect(b.dataset.paused).toBe("false");
  });

  it("prefers artwork when it decodes and tones it for the dark theme", () => {
    artworkState.url = "blob:cover";
    const { container } = render(<LyricsAmbientBackground trackId="track-1" />);
    settleImage(imageBySrc("lyrics-fallback-light"), true);
    settleImage(imageBySrc("lyrics-fallback-dark"), true);
    const root = container.querySelector<HTMLElement>(".gm-ambient")!;

    settleImage(imageBySrc("blob:cover"), true);
    expect(root.dataset.source).toBe("artwork");
    // Dark-theme artwork tone mapping hit the canvas pipeline.
    expect(filterHistory).toContain("blur(26px) brightness(0.72) saturate(1.06)");
  });

  it("keeps the fallback when the artwork URL is broken", () => {
    artworkState.url = "blob:broken";
    const { container } = render(<LyricsAmbientBackground trackId="track-1" />);
    settleImage(imageBySrc("lyrics-fallback-light"), true);
    settleImage(imageBySrc("lyrics-fallback-dark"), true);
    const root = container.querySelector<HTMLElement>(".gm-ambient")!;
    expect(root.dataset.source).toBe("fallback");
    expect(filterHistory).not.toContain("blur(26px) brightness(0.72) saturate(1.06)");
  });

  it("crossfades between theme fallbacks and hands the settled role over", () => {
    const { container } = render(<LyricsAmbientBackground trackId={undefined} />);
    settleImage(imageBySrc("lyrics-fallback-light"), true);
    settleImage(imageBySrc("lyrics-fallback-dark"), true);
    act(() => vi.advanceTimersByTime(700));
    const root = container.querySelector<HTMLElement>(".gm-ambient")!;
    const stacks = () => root.querySelectorAll<HTMLElement>(".gm-ambient__stack");
    expect(stacks()[1].style.zIndex).toBe("2"); // dark fallback settled on B

    act(() => {
      useSettingsStore.setState({ resolvedTheme: "light" });
    });
    // The repainted hidden stack (A) fades in above the settled one (B).
    expect(stacks()[0].style.zIndex).toBe("3");
    expect(stacks()[0].style.opacity).toBe("1");
    expect(stacks()[1].style.opacity).toBe("1");

    act(() => vi.advanceTimersByTime(700));
    expect(stacks()[0].style.zIndex).toBe("2");
    expect(stacks()[0].style.opacity).toBe("1");
    expect(stacks()[1].style.opacity).toBe("0");
    expect(stacks()[1].dataset.paused).toBe("true");
    expect(stacks()[0].dataset.paused).toBe("false");
  });

  it("drops the sheen layer and swaps instantly under reduced motion", () => {
    document.documentElement.dataset.motion = "on";
    const { container } = render(<LyricsAmbientBackground trackId={undefined} />);
    settleImage(imageBySrc("lyrics-fallback-light"), true);
    settleImage(imageBySrc("lyrics-fallback-dark"), true);
    const root = container.querySelector<HTMLElement>(".gm-ambient")!;
    expect(root.dataset.reduced).toBe("true");
    expect(root.querySelectorAll(".gm-ambient__layer--sheen")).toHaveLength(0);

    act(() => {
      useSettingsStore.setState({ resolvedTheme: "light" });
    });
    const stacks = root.querySelectorAll<HTMLElement>(".gm-ambient__stack");
    // Instant swap: A shows the light asset, B is parked, no fade in between.
    expect(stacks[0].style.opacity).toBe("1");
    expect(stacks[0].style.zIndex).toBe("2");
    expect(stacks[1].style.opacity).toBe("0");
  });

  it("finalizes an in-flight crossfade when the source changes again quickly", () => {
    const { container } = render(<LyricsAmbientBackground trackId={undefined} />);
    settleImage(imageBySrc("lyrics-fallback-light"), true);
    settleImage(imageBySrc("lyrics-fallback-dark"), true);
    const root = container.querySelector<HTMLElement>(".gm-ambient")!;
    const stacks = () => root.querySelectorAll<HTMLElement>(".gm-ambient__stack");

    act(() => {
      useSettingsStore.setState({ resolvedTheme: "light" });
    });
    expect(stacks()[0].style.zIndex).toBe("3"); // A fading in over B

    // Second theme change before the first fade completes.
    act(() => {
      useSettingsStore.setState({ resolvedTheme: "dark" });
    });
    expect(stacks()[1].style.zIndex).toBe("3"); // B now fading in over A

    act(() => vi.advanceTimersByTime(700));
    expect(stacks()[1].style.opacity).toBe("1");
    expect(stacks()[0].style.opacity).toBe("0");
  });

  it("clears the crossfade timer on unmount", () => {
    const { unmount } = render(<LyricsAmbientBackground trackId={undefined} />);
    settleImage(imageBySrc("lyrics-fallback-light"), true);
    settleImage(imageBySrc("lyrics-fallback-dark"), true);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

/** renderHook without the extra import: render a probe component. */
function renderHookCurrent<T>(useHook: () => T): { result: { current: T }; rerender: () => void } {
  const result: { current: T } = { current: undefined as unknown as T };
  function Probe() {
    result.current = useHook();
    return null;
  }
  const rendered = render(<Probe />);
  return { result, rerender: () => rendered.rerender(<Probe />) };
}
