import { afterEach, describe, expect, it, vi } from "vitest";
import { describeMediaError, HtmlAudioEngine, type EngineEvents } from "./engine";

/**
 * Regression coverage for the shared audio element's error pipeline: a
 * missing MediaError and aborted loads are transition noise on one shared
 * element and must never become fabricated playback failures, while genuine
 * network/decode/unsupported errors pass through untouched. Source
 * generations let the store ignore events from replaced sources.
 */

function makeEngine() {
  const failures: { code: number; message: string }[] = [];
  const events: EngineEvents = {
    onTimeUpdate: () => undefined,
    onDurationChange: () => undefined,
    onPlayStateChange: () => undefined,
    onBufferingChange: () => undefined,
    onSeeked: () => undefined,
    onEnded: () => undefined,
    onError: (failure) => failures.push(failure),
  };
  const engine = new HtmlAudioEngine(events);
  return { engine, failures, element: engine.element };
}

function emitMediaError(element: HTMLAudioElement, error: { code: number; message: string } | null): void {
  // jsdom has no MediaError constructor for all codes; the handler only
  // reads .code/.message, so shadowing the property is sufficient.
  Object.defineProperty(element, "error", { value: error, configurable: true });
  element.dispatchEvent(new Event("error"));
}

describe("HtmlAudioEngine error pipeline", () => {
  it("mounts inline audio in the document and removes it on dispose", () => {
    const { engine, element } = makeEngine();
    expect(document.body.contains(element)).toBe(true);
    expect(element.getAttribute("playsinline")).toBe("true");
    expect(element.preload).toBe("auto");
    expect(element.hidden).toBe(true);
    engine.dispose();
    expect(document.body.contains(element)).toBe(false);
  });
  it("never reports an error event that carries no MediaError", () => {
    const { element, failures } = makeEngine();
    emitMediaError(element, null);
    expect(failures).toHaveLength(0);
  });

  it("treats an aborted load (code 1) as a source transition, not a failure", () => {
    const { element, failures } = makeEngine();
    emitMediaError(element, { code: 1, message: "interrupted" });
    expect(failures).toHaveLength(0);
  });

  it("reports genuine network, decode, and unsupported-source errors verbatim", () => {
    const { element, failures } = makeEngine();
    emitMediaError(element, { code: 2, message: "network dead" });
    emitMediaError(element, { code: 3, message: "bad codec" });
    emitMediaError(element, { code: 4, message: "no decoder" });
    expect(failures).toEqual([
      { code: 2, message: "network dead" },
      { code: 3, message: "bad codec" },
      { code: 4, message: "no decoder" },
    ]);
  });

  it("keeps state synchronized: play/pause events still flow through", () => {
    let playing: boolean | null = null;
    const { engine } = makeEngineWithPlayState((value) => {
      playing = value;
    });
    engine.element?.dispatchEvent(new Event("play"));
    expect(playing).toBe(true);
    // jsdom does not emit a pause event from pause() when nothing is playing,
    // so the transition is simulated at the event level the engine listens to.
    engine.element?.dispatchEvent(new Event("pause"));
    expect(playing).toBe(false);
  });

  it("advances the source generation on setSource and dispose", () => {
    const { engine } = makeEngine();
    expect(engine.sourceGeneration).toBe(0);
    engine.setSource("blob:first");
    expect(engine.sourceGeneration).toBe(1);
    engine.setSource("blob:second");
    expect(engine.sourceGeneration).toBe(2);
    engine.setSource(null);
    expect(engine.sourceGeneration).toBe(3);
    engine.dispose();
    expect(engine.sourceGeneration).toBe(4);
  });

  it("describes every MediaError code with an actionable message", () => {
    expect(describeMediaError(1)).toMatch(/abort/i);
    expect(describeMediaError(2)).toMatch(/network/i);
    expect(describeMediaError(3)).toMatch(/decod/i);
    expect(describeMediaError(4)).toMatch(/format|supported/i);
    expect(describeMediaError(0)).toMatch(/unknown/i);
  });
});

function makeEngineWithPlayState(onPlayState: (playing: boolean) => void): { engine: HtmlAudioEngine } {
  const events: EngineEvents = {
    onTimeUpdate: () => undefined,
    onDurationChange: () => undefined,
    onPlayStateChange: onPlayState,
    onBufferingChange: () => undefined,
    onSeeked: () => undefined,
    onEnded: () => undefined,
    onError: () => undefined,
  };
  return { engine: new HtmlAudioEngine(events) };
}

type MockRelease = ReturnType<typeof vi.fn>;

/** jsdom has no Wake Lock API; install a controllable stub on navigator. */
function installWakeLock(): { request: ReturnType<typeof vi.fn>; sentinels: { release: MockRelease }[] } {
  const sentinels: { release: MockRelease }[] = [];
  const request = vi.fn(() => {
    const sentinel = { release: vi.fn(() => Promise.resolve()) };
    sentinels.push(sentinel);
    return Promise.resolve(sentinel);
  });
  Object.defineProperty(navigator, "wakeLock", { value: { request }, configurable: true });
  return { request, sentinels };
}

function setDocumentHidden(hidden: boolean): void {
  Object.defineProperty(document, "hidden", { value: hidden, configurable: true });
}

function dispatchVisibilityChange(): void {
  document.dispatchEvent(new Event("visibilitychange"));
}

const flushAsync = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("HtmlAudioEngine wake lock and listener lifecycle", () => {
  afterEach(() => {
    delete (navigator as unknown as { wakeLock?: unknown }).wakeLock;
    delete (document as unknown as { hidden?: unknown }).hidden;
    vi.restoreAllMocks();
  });

  it("acquires a screen wake lock when playback starts and releases it on pause", async () => {
    const { engine, element } = makeEngine();
    const { request, sentinels } = installWakeLock();
    element.dispatchEvent(new Event("play"));
    expect(request).toHaveBeenCalledWith("screen");
    await flushAsync();
    expect(sentinels[0]?.release).not.toHaveBeenCalled();
    element.dispatchEvent(new Event("pause"));
    expect(sentinels[0]?.release).toHaveBeenCalledTimes(1);
    engine.dispose();
  });

  it("releases the wake lock when playback ends", async () => {
    const { engine, element } = makeEngine();
    const { sentinels } = installWakeLock();
    element.dispatchEvent(new Event("play"));
    await flushAsync();
    element.dispatchEvent(new Event("ended"));
    expect(sentinels[0]?.release).toHaveBeenCalledTimes(1);
    engine.dispose();
  });

  it("releases the wake lock on a genuine media error", async () => {
    const { engine, element } = makeEngine();
    const { sentinels } = installWakeLock();
    element.dispatchEvent(new Event("play"));
    await flushAsync();
    emitMediaError(element, { code: 2, message: "network dead" });
    expect(sentinels[0]?.release).toHaveBeenCalledTimes(1);
    engine.dispose();
  });

  it("releases when the document is hidden and reacquires when visible again", async () => {
    const { engine, element } = makeEngine();
    const { request, sentinels } = installWakeLock();
    element.dispatchEvent(new Event("play"));
    await flushAsync();
    setDocumentHidden(true);
    dispatchVisibilityChange();
    expect(sentinels[0]?.release).toHaveBeenCalledTimes(1);
    setDocumentHidden(false);
    dispatchVisibilityChange();
    expect(request).toHaveBeenCalledTimes(2);
    engine.dispose();
  });

  it("releases the result of an in-flight request whose playback already paused", async () => {
    const { engine, element } = makeEngine();
    const { request } = installWakeLock();
    const deferred: { resolve: ((sentinel: { release: MockRelease }) => void) | null } = { resolve: null };
    request.mockImplementationOnce(
      () =>
        new Promise<{ release: MockRelease }>((resolve) => {
          deferred.resolve = resolve;
        }),
    );
    const sentinel = { release: vi.fn(() => Promise.resolve()) };
    element.dispatchEvent(new Event("play"));
    expect(request).toHaveBeenCalledTimes(1);
    element.dispatchEvent(new Event("pause"));
    if (!deferred.resolve) throw new Error("request promise was not created");
    deferred.resolve(sentinel);
    await flushAsync();
    expect(sentinel.release).toHaveBeenCalledTimes(1);
    // Nothing is held afterwards: repeated pause events must not double-release.
    element.dispatchEvent(new Event("pause"));
    expect(sentinel.release).toHaveBeenCalledTimes(1);
    engine.dispose();
  });

  it("swallows wake lock request rejections without affecting audio events", async () => {
    const states: boolean[] = [];
    const { engine } = makeEngineWithPlayState((value) => states.push(value));
    const { request } = installWakeLock();
    request.mockRejectedValueOnce(new Error("denied"));
    engine.element?.dispatchEvent(new Event("play"));
    await flushAsync();
    engine.element?.dispatchEvent(new Event("pause"));
    expect(states).toEqual([true, false]);
    engine.dispose();
  });

  it("releases the wake lock on setSource(null) and never reacquires it for a dead source", async () => {
    const { engine, element } = makeEngine();
    const { request, sentinels } = installWakeLock();
    element.dispatchEvent(new Event("play"));
    await flushAsync();
    engine.setSource(null);
    expect(sentinels[0]?.release).toHaveBeenCalledTimes(1);
    dispatchVisibilityChange();
    expect(request).toHaveBeenCalledTimes(1);
    engine.dispose();
  });

  it("releases on dispose, removes the element, and detaches all listeners", async () => {
    const { engine, element } = makeEngine();
    const { request, sentinels } = installWakeLock();
    element.dispatchEvent(new Event("play"));
    await flushAsync();
    engine.dispose();
    expect(sentinels[0]?.release).toHaveBeenCalledTimes(1);
    expect(document.body.contains(element)).toBe(false);
    // Aborted listeners: media and visibility events after dispose are inert.
    element.dispatchEvent(new Event("play"));
    setDocumentHidden(true);
    dispatchVisibilityChange();
    setDocumentHidden(false);
    dispatchVisibilityChange();
    expect(request).toHaveBeenCalledTimes(1);
    expect(sentinels[0]?.release).toHaveBeenCalledTimes(1);
  });
});
