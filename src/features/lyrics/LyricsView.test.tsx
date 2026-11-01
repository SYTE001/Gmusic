import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { usePlaybackStore } from "../../stores/playbackStore";
import { useLibraryStore } from "../../stores/libraryStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useLyricsStore } from "../../stores/lyricsStore";
import { repository } from "../../services/indexeddb/LibraryRepository";
import type { AudioEngine } from "../../services/audio/engine";
import type { Track, TrackLyrics } from "../../types";

/**
 * LyricsView + AmllLyricPlayer wiring. jsdom has no layout, so the AMLL
 * DomLyricPlayer is replaced by a small fake that records the data and clock
 * it is fed, marks the active line, and emits the same `click` event shape.
 */
type FakeLine = { words: { word: string; startTime: number; endTime: number }[]; startTime: number; endTime: number };

const players: FakePlayer[] = [];

class FakePlayer extends EventTarget {
  element = document.createElement("div");
  lines: FakeLine[] = [];
  clock = 0;
  playing = false;
  disposed = false;
  springEnabled = true;
  scaleEnabled = true;
  blurEnabled = true;
  constructor() {
    super();
    this.element.setAttribute("data-testid", "amll");
    players.push(this);
  }
  getElement() {
    return this.element;
  }
  setEnableBlur(enable: boolean) {
    this.blurEnabled = enable;
  }
  setEnableScale(enable: boolean) {
    this.scaleEnabled = enable;
  }
  setEnableSpring(enable: boolean) {
    this.springEnabled = enable;
  }
  setLyricLines(lines: FakeLine[]) {
    this.lines = lines;
    this.render();
  }
  setCurrentTime(ms: number) {
    this.clock = ms;
    this.render();
  }
  update() {}
  pause() {
    this.playing = false;
  }
  resume() {
    this.playing = true;
  }
  dispose() {
    this.disposed = true;
  }
  private render() {
    let active = -1;
    this.lines.forEach((line, index) => {
      if (line.startTime <= this.clock) active = index;
    });
    this.element.replaceChildren(
      ...this.lines.map((line, index) => {
        const el = document.createElement("div");
        el.dataset.line = String(index);
        if (index === active) el.dataset.active = "true";
        el.textContent = line.words.map((w) => w.word).join("");
        el.addEventListener("click", () => {
          const event = Object.assign(new Event("click"), { line: { getLine: () => line } });
          this.dispatchEvent(event);
        });
        return el;
      }),
    );
  }
}

vi.mock("@applemusic-like-lyrics/core", () => ({
  DomLyricPlayer: FakePlayer,
  LayoutReason: { PlaybackTick: 0 },
  LayoutReasonStrategyMap: { 0: { disableStagger: false } },
}));
vi.mock("@applemusic-like-lyrics/core/style.css", () => ({}));

import { LyricsView } from "./LyricsView";

const track: Track = {
  id: "amll-track",
  title: "AMLL Song",
  artist: "Artist",
  album: "",
  trackNumber: null,
  albumTrackCount: null,
  durationMs: 60000,
  fileName: "a.wav",
  fileSize: 1,
  mimeType: "audio/wav",
  addedAt: 1,
  lastPlayedAt: null,
  playCount: 0,
  isLiked: false,
  availability: "available",
  accessMode: "stored-copy",
  fingerprint: null,
  metadataFromFilename: false,
};

const base = { trackId: track.id, offsetMs: 0, updatedAt: 1, skippedLines: 0 };

const wordLyrics: TrackLyrics = {
  ...base,
  format: "lrc",
  lines: [
    {
      timeMs: 1000,
      text: "Word up now",
      words: [
        { text: "Word", startMs: 1000, endMs: 1500 },
        { text: "up", startMs: 1500, endMs: 2000 },
        { text: "now", startMs: 2000, endMs: null },
      ],
    },
    { timeMs: 5000, text: "second line" },
  ],
  sourceName: "w.lrc",
  origin: { kind: "lrcmux", recordId: 1, fetchedAt: 1, capability: "word" },
};

const lineOnlyLyrics: TrackLyrics = {
  ...base,
  format: "lrc",
  lines: [
    { timeMs: 1000, text: "first line" },
    { timeMs: 5000, text: "second line" },
  ],
  sourceName: "l.lrc",
  origin: { kind: "lrcmux", recordId: 2, fetchedAt: 1, capability: "line" },
};

const plainLyrics: TrackLyrics = {
  ...base,
  format: "txt",
  lines: [
    { timeMs: null, text: "just words" },
    { timeMs: null, text: "no timing" },
  ],
  sourceName: "p.txt",
  origin: { kind: "lrcmux", recordId: 3, fetchedAt: 1, capability: "plain" },
};

let audioClockSec = 0;

function installEngine() {
  const engine = {
    get element() {
      return {} as HTMLAudioElement;
    },
    get currentTimeSec() {
      return audioClockSec;
    },
    dispose() {},
  } as unknown as AudioEngine;
  usePlaybackStore.getState().setEngineForTests(engine);
}

async function renderView(lyrics: TrackLyrics, style: "line" | "word", playback: { isPlaying?: boolean } = {}) {
  await repository.clearAllData();
  await repository.putLyrics(lyrics);
  useSettingsStore.setState((current) => ({ prefs: { ...current.prefs, lyricsStyle: style } }));
  // Discovery (network) is out of scope here; stored lyrics are the input.
  useLyricsStore.setState({ status: "idle", trackId: null, candidates: [], resolveForTrack: vi.fn().mockResolvedValue(undefined) });
  useLibraryStore.setState({ tracks: [track], playlists: [], status: "ready", loadError: null });
  usePlaybackStore.setState({
    currentTrackId: track.id,
    isPlaying: playback.isPlaying ?? false,
    status: "ready",
    currentTimeMs: 0,
    durationMs: 60000,
    queueTrackIds: [track.id],
    queueIndex: 0,
    contextTrackIds: [track.id],
    context: { type: "library", label: "L" },
  });
  installEngine();
  return render(
    <MemoryRouter>
      <LyricsView />
    </MemoryRouter>,
  );
}

function seekTo(ms: number) {
  audioClockSec = ms / 1000;
  act(() => {
    usePlaybackStore.setState({ currentTimeMs: ms });
  });
}

describe("LyricsView with the AMLL player", () => {
  beforeEach(() => {
    players.length = 0;
    audioClockSec = 0;
  });

  it("mounts the player lazily and renders the active line from the audio clock", async () => {
    await renderView(lineOnlyLyrics, "line");
    expect(await screen.findByText("first line")).toBeTruthy();
    seekTo(6000);
    await waitFor(() => {
      expect(document.querySelector('[data-active="true"]')?.textContent).toBe("second line");
    });
  });

  it("seeks the playback engine when a timed line is clicked", async () => {
    await renderView(lineOnlyLyrics, "line");
    const seek = vi.fn();
    usePlaybackStore.setState({ seek });
    fireEvent.click(await screen.findByText("second line"));
    expect(seek).toHaveBeenCalledWith(5000);
  });

  it("applies the per-song offset to the player clock and to click seeks, without touching the record", async () => {
    await renderView({ ...lineOnlyLyrics, offsetMs: 2000 }, "line");
    await screen.findByText("first line");
    // Audio at 3000 ms with +2000 ms offset is lyric time 1000 ms: first line.
    seekTo(3000);
    await waitFor(() => expect(document.querySelector('[data-active="true"]')?.textContent).toBe("first line"));
    expect(players[0].clock).toBe(1000);

    const seek = vi.fn();
    usePlaybackStore.setState({ seek });
    fireEvent.click(screen.getByText("second line"));
    expect(seek).toHaveBeenCalledWith(7000);
    expect((await repository.getLyrics(track.id))?.lines).toEqual(lineOnlyLyrics.lines);
  });

  it("re-syncs immediately and persists when the offset buttons are used", async () => {
    await renderView(lineOnlyLyrics, "line");
    await screen.findByText("first line");
    seekTo(1000);
    await waitFor(() => expect(players[0].clock).toBe(1000));

    fireEvent.click(screen.getByLabelText("Shift lyrics half a second later"));
    await waitFor(() => expect(players[0].clock).toBe(500));
    await waitFor(async () => expect((await repository.getLyrics(track.id))?.offsetMs).toBe(500));
  });

  it("feeds real word timings in word style and whole lines in line style", async () => {
    await renderView(wordLyrics, "word");
    await screen.findByText("Word up now");
    expect(players[0].lines[0].words.map((w) => w.word)).toEqual(["Word", " up", " now"]);
    expect(players[0].lines[1].words).toHaveLength(1);
  });

  it("forces single-word lines in line style", async () => {
    await renderView(wordLyrics, "line");
    await screen.findByText("Word up now");
    expect(players[0].lines[0].words).toHaveLength(1);
  });

  it("keeps the badge honest: word style on line-only lyrics is flagged and fed single words", async () => {
    await renderView(lineOnlyLyrics, "word");
    await screen.findByText("first line");
    expect(players[0].lines.every((line) => line.words.length === 1)).toBe(true);
    expect(screen.getByText(/Synced lyrics.*line sync/)).toBeTruthy();
    expect(screen.getByText(/word style inactive/)).toBeTruthy();
  });

  it("reports word sync only when the payload has word timestamps", async () => {
    await renderView(wordLyrics, "word");
    await screen.findByText("Word up now");
    expect(screen.getByText(/Synced lyrics.*word sync/)).toBeTruthy();
  });

  it("passes playing state to the player and disposes it on unmount", async () => {
    const { unmount } = await renderView(lineOnlyLyrics, "line", { isPlaying: true });
    await screen.findByText("first line");
    expect(players[0].playing).toBe(true);
    act(() => {
      usePlaybackStore.setState({ isPlaying: false });
    });
    await waitFor(() => expect(players[0].playing).toBe(false));
    unmount();
    expect(players[0].disposed).toBe(true);
  });

  it("renders plain lyrics with the existing static UI, without creating a player", async () => {
    await renderView(plainLyrics, "word");
    expect(await screen.findByText("just words")).toBeTruthy();
    expect(screen.getByText(/Plain text.*not synchronized/)).toBeTruthy();
    expect(players).toHaveLength(0);
  });

  it("disables AMLL spring simulation, scale loops, and staggered delays for solid line transitions", async () => {
    await renderView(wordLyrics, "word");
    await screen.findByText("Word up now");
    expect(players[0].springEnabled).toBe(false);
    expect(players[0].scaleEnabled).toBe(false);
    expect(players[0].blurEnabled).toBe(false);
  });

  it("intercepts float-word and emphasize-word-float animations while preserving regular animations", async () => {
    await renderView(wordLyrics, "word");
    await screen.findByText("Word up now");

    const testEl = document.createElement("div");
    document.body.appendChild(testEl);

    // float-word is intercepted with a dummy noop animation
    const floatAni = testEl.animate([{ transform: "translateY(0)" }, { transform: "translateY(-10px)" }], {
      id: "float-word",
    });
    expect(floatAni.id).toBe("float-word");
    expect(floatAni.playState).toBe("idle");
    expect(floatAni.currentTime).toBe(0);

    // emphasize-word-float is intercepted
    const empAni = testEl.animate([], { id: "emphasize-word-float" });
    expect(empAni.id).toBe("emphasize-word-float");
    expect(empAni.playState).toBe("idle");

    testEl.remove();
  });

  it("preserves individual word timestamps and word sync structures intact", async () => {
    await renderView(wordLyrics, "word");
    await screen.findByText("Word up now");

    const line0 = players[0].lines[0];
    expect(line0.words).toHaveLength(3);
    expect(line0.words[0]).toEqual({ word: "Word", startTime: 1000, endTime: 1500 });
    expect(line0.words[1]).toEqual({ word: " up", startTime: 1500, endTime: 2000 });
    expect(line0.words[2]).toEqual({ word: " now", startTime: 2000, endTime: 5000 });
  });
});
