import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AudioEngine } from "../services/audio/engine";
import { usePlaybackStore } from "../stores/playbackStore";
import { SeekBar } from "./SeekBar";

class SeekBarEngine implements AudioEngine {
  readonly element = document.createElement("audio");
  readonly sourceGeneration = 1;
  currentTimeSec = 0;
  durationSec: number | null = 120;

  setSource() {}
  async play() {}
  pause() {}
  seekSec(seconds: number) {
    this.currentTimeSec = seconds;
  }
  setVolume() {}
  setMuted() {}
  dispose() {}
}

let engine: SeekBarEngine;

describe("SeekBar audio-clock synchronization", () => {
  beforeEach(() => {
    engine = new SeekBarEngine();
    engine.element.src = "https://example.test/track.mp3";
    usePlaybackStore.getState().setEngineForTests(engine);
    usePlaybackStore.setState({
      currentTrackId: "track-1",
      currentTimeMs: 0,
      durationMs: 120000,
      isPlaying: false,
      status: "ready",
    });
  });

  afterEach(() => cleanup());

  it("preserves a restored paused position before any source is loaded", () => {
    engine.element.removeAttribute("src");
    engine.currentTimeSec = 0;
    usePlaybackStore.setState({ currentTimeMs: 42000 });

    const { container } = render(<SeekBar />);

    expect(screen.getByRole("slider", { name: "Seek" }).getAttribute("aria-valuenow")).toBe("42");
    expect((container.querySelector(".origin-left") as HTMLDivElement).style.transform).toBe("scaleX(0.35)");
    expect(usePlaybackStore.getState().currentTimeMs).toBe(42000);
  });

  it("mounts at the paused audio element position instead of stale store time", () => {
    engine.currentTimeSec = 60;

    const { container } = render(<SeekBar />);

    expect(screen.getByRole("slider", { name: "Seek" }).getAttribute("aria-valuenow")).toBe("60");
    expect(screen.getByText("1:00")).toBeTruthy();
    expect((container.querySelector(".origin-left") as HTMLDivElement).style.transform).toBe("scaleX(0.5)");
    expect(usePlaybackStore.getState().currentTimeMs).toBe(60000);
  });

  it("keeps the final audio position when playback pauses between timeupdate events", () => {
    engine.currentTimeSec = 45;
    usePlaybackStore.setState({ currentTimeMs: 40000, isPlaying: true });
    const { container } = render(<SeekBar />);

    engine.currentTimeSec = 47.5;
    act(() => {
      usePlaybackStore.setState({ isPlaying: false });
    });

    expect(screen.getByRole("slider", { name: "Seek" }).getAttribute("aria-valuenow")).toBe("48");
    expect((container.querySelector(".origin-left") as HTMLDivElement).style.transform).toBe("scaleX(0.3958333333333333)");
    expect(usePlaybackStore.getState().currentTimeMs).toBe(47500);
  });

  it("seeks by keyboard from the real audio position while paused", () => {
    engine.currentTimeSec = 30;
    usePlaybackStore.setState({ currentTimeMs: 0 });
    render(<SeekBar />);

    fireEvent.keyDown(screen.getByRole("slider", { name: "Seek" }), { key: "ArrowRight" });

    expect(engine.currentTimeSec).toBe(35);
    expect(usePlaybackStore.getState().currentTimeMs).toBe(35000);
  });
});
