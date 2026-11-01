import { describe, expect, it } from "vitest";
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
