import { describe, expect, it } from "vitest";
import { mapJsonResponseToRecord, type LrcmuxJsonResponse } from "./lrcmuxClient";
import { buildLyricsFromRecord } from "./lyricsService";

describe("lrcmux response mapping", () => {
  it("maps word-level timed lyrics with millisecond word timestamps", () => {
    const json: LrcmuxJsonResponse = {
      track: {
        title: "Bohemian Rhapsody",
        artist: "Queen",
        album: "A Night at the Opera",
        duration: 354,
      },
      meta: {
        level: "word",
        instrumental: false,
        source: { id: "apple", name: "Apple Music" },
      },
      lines: [
        {
          text: "Is this the real life?",
          start: 1200,
          end: 3500,
          words: [
            { text: "Is ", start: 1200, end: 1400 },
            { text: "this ", start: 1400, end: 1700 },
            { text: "the ", start: 1700, end: 1900 },
            { text: "real ", start: 1900, end: 2400 },
            { text: "life?", start: 2400, end: 3500 },
          ],
        },
        {
          text: "Is this just fantasy?",
          start: 4000,
          end: 7000,
          words: [
            { text: "Is ", start: 4000, end: 4200 },
            { text: "this ", start: 4200, end: 4500 },
            { text: "just ", start: 4500, end: 5000 },
            { text: "fantasy?", start: 5000, end: 7000 },
          ],
        },
      ],
    };

    const record = mapJsonResponseToRecord(json);
    expect(record.hasWordSync).toBe(true);
    expect(record.syncLevel).toBe("word");
    expect(record.source).toBe("Apple Music");
    expect(record.lines).toHaveLength(2);
    expect(record.lines![0].timeMs).toBe(1200);
    expect(record.lines![0].words).toHaveLength(5);
    expect(record.lines![0].words![0]).toEqual({ text: "Is ", startMs: 1200, endMs: 1400 });

    const trackLyrics = buildLyricsFromRecord("track-1", record);
    expect(trackLyrics.format).toBe("lrc");
    expect(trackLyrics.origin?.capability).toBe("word");
    expect(trackLyrics.origin?.kind).toBe("lrcmux");
    expect(trackLyrics.lines[0].words).toHaveLength(5);
    expect(trackLyrics.lines[0].words![0].startMs).toBe(1200);
  });

  it("maps line-level timed lyrics without word breakdown", () => {
    const json: LrcmuxJsonResponse = {
      track: {
        title: "Line Only Song",
        artist: "Artist",
        album: "Album",
        duration: 200,
      },
      meta: {
        level: "line",
        instrumental: false,
      },
      lines: [
        { text: "First line", start: 5000, end: 8000 },
        { text: "Second line", start: 8500, end: 12000 },
      ],
    };

    const record = mapJsonResponseToRecord(json);
    expect(record.hasWordSync).toBe(false);
    expect(record.syncLevel).toBe("line");
    expect(record.lines).toHaveLength(2);
    expect(record.lines![0].timeMs).toBe(5000);
    expect(record.lines![0].words).toBeUndefined();

    const trackLyrics = buildLyricsFromRecord("track-2", record);
    expect(trackLyrics.format).toBe("lrc");
    expect(trackLyrics.origin?.capability).toBe("line");
    expect(trackLyrics.lines[0].timeMs).toBe(5000);
    expect(trackLyrics.lines[0].words).toBeUndefined();
  });

  it("maps instrumental response correctly", () => {
    const json: LrcmuxJsonResponse = {
      track: {
        title: "Orion",
        artist: "Metallica",
        album: "Master of Puppets",
        duration: 500,
      },
      meta: {
        level: "none",
        instrumental: true,
      },
      lines: null,
    };

    const record = mapJsonResponseToRecord(json);
    expect(record.instrumental).toBe(true);
    expect(record.syncLevel).toBe("none");

    const trackLyrics = buildLyricsFromRecord("track-3", record);
    expect(trackLyrics.lines).toHaveLength(0);
    expect(trackLyrics.origin?.capability).toBe("instrumental");
  });

  it("maps plain unsynced text correctly", () => {
    const json: LrcmuxJsonResponse = {
      track: {
        title: "Poem",
        artist: "Author",
        album: "Book",
        duration: 100,
      },
      meta: {
        level: "none",
        instrumental: false,
      },
      lines: [
        { text: "Just words" },
        { text: "Without any time" },
      ],
    };

    const record = mapJsonResponseToRecord(json);
    expect(record.hasWordSync).toBe(false);
    expect(record.syncLevel).toBe("none");
    expect(record.lines![0].timeMs).toBeNull();

    const trackLyrics = buildLyricsFromRecord("track-4", record);
    expect(trackLyrics.format).toBe("txt");
    expect(trackLyrics.origin?.capability).toBe("plain");
    expect(trackLyrics.lines).toHaveLength(2);
    expect(trackLyrics.lines[0].timeMs).toBeNull();
  });
});
