import { describe, expect, it } from "vitest";
import { deriveArtistTitleFromFileName, formatClock, looksLikeAudioFile, normalizeForSearch } from "./misc";

describe("normalizeForSearch", () => {
  it("lowercases, strips diacritics, and collapses whitespace", () => {
    expect(normalizeForSearch("  Café  Crème  ")).toBe("cafe creme");
    expect(normalizeForSearch("Björk")).toBe("bjork");
    expect(normalizeForSearch("SIGUR RÓS")).toBe("sigur ros");
  });

  it("matches substring queries the way the library search expects", () => {
    const haystack = normalizeForSearch("The Dark Side of the Moon");
    expect(haystack.includes(normalizeForSearch("dark side"))).toBe(true);
    expect(haystack.includes(normalizeForSearch("dreams"))).toBe(false);
  });
});

describe("looksLikeAudioFile", () => {
  it("accepts audio MIME types and common extensions", () => {
    expect(looksLikeAudioFile("song.mp3", "audio/mpeg")).toBe(true);
    expect(looksLikeAudioFile("song.flac", "")).toBe(true);
    expect(looksLikeAudioFile("song.m4a", "")).toBe(true);
    expect(looksLikeAudioFile("song.OGG", "")).toBe(true);
  });

  it("rejects non-audio files", () => {
    expect(looksLikeAudioFile("cover.png", "image/png")).toBe(false);
    expect(looksLikeAudioFile("notes.txt", "")).toBe(false);
    expect(looksLikeAudioFile("song.zzz", "application/octet-stream")).toBe(false);
  });
});

describe("formatClock", () => {
  it("formats milliseconds as m:ss and h:mm:ss", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(73012)).toBe("1:13");
    expect(formatClock(3661000)).toBe("1:01:01");
    expect(formatClock(null)).toBe("0:00");
    expect(formatClock(-5)).toBe("0:00");
  });
});

describe("deriveArtistTitleFromFileName", () => {
  it("splits 'Artist - Title' without extension", () => {
    expect(deriveArtistTitleFromFileName("Aurora - Runaway.mp3")).toEqual({
      artist: "Aurora",
      title: "Runaway",
      trackNumber: null,
    });
  });

  it("extracts leading track numbers", () => {
    const result = deriveArtistTitleFromFileName("03 - Beach House - Space Song.mp3");
    expect(result.trackNumber).toBe(3);
    expect(result.artist).toBe("Beach House");
    expect(result.title).toBe("Space Song");
  });

  it("falls back to the whole name as title", () => {
    const result = deriveArtistTitleFromFileName("untitled_recording.wav");
    expect(result.title).toBe("untitled_recording");
    expect(result.artist).toBe("");
  });
});
