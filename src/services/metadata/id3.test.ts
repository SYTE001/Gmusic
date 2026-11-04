import { describe, expect, it } from "vitest";
import { parseID3v1, parseID3v2 } from "./id3";
import { cleanTagText, isCorruptedOrSuspiciousMetadata, tryRepairMojibake } from "./types";

function makeID3v23Buffer(frames: Array<{ id: string; text: string; encoding?: number }>): ArrayBuffer {
  const encodedFrames: Uint8Array[] = [];
  for (const f of frames) {
    const enc = f.encoding ?? 0;
    let textBytes: Uint8Array;
    if (enc === 1) {
      // UTF-16LE with BOM
      const u16 = new Uint8Array(2 + f.text.length * 2);
      u16[0] = 0xff;
      u16[1] = 0xfe;
      for (let i = 0; i < f.text.length; i++) {
        const code = f.text.charCodeAt(i);
        u16[2 + i * 2] = code & 0xff;
        u16[2 + i * 2 + 1] = (code >> 8) & 0xff;
      }
      textBytes = u16;
    } else if (enc === 3) {
      textBytes = new TextEncoder().encode(f.text);
    } else {
      textBytes = new Uint8Array(Array.from(f.text).map((c) => c.charCodeAt(0)));
    }
    const frameSize = 1 + textBytes.length;
    const frameHeader = new Uint8Array(10);
    for (let i = 0; i < 4; i++) frameHeader[i] = f.id.charCodeAt(i);
    frameHeader[4] = (frameSize >> 24) & 0xff;
    frameHeader[5] = (frameSize >> 16) & 0xff;
    frameHeader[6] = (frameSize >> 8) & 0xff;
    frameHeader[7] = frameSize & 0xff;
    frameHeader[8] = 0;
    frameHeader[9] = 0;

    const frame = new Uint8Array(10 + frameSize);
    frame.set(frameHeader, 0);
    frame[10] = enc;
    frame.set(textBytes, 11);
    encodedFrames.push(frame);
  }

  const totalContent = encodedFrames.reduce((sum, f) => sum + f.length, 0);
  const tagHeader = new Uint8Array(10);
  tagHeader[0] = 0x49; // I
  tagHeader[1] = 0x44; // D
  tagHeader[2] = 0x33; // 3
  tagHeader[3] = 3;    // v2.3
  tagHeader[4] = 0;
  tagHeader[5] = 0;
  tagHeader[6] = (totalContent >> 21) & 0x7f;
  tagHeader[7] = (totalContent >> 14) & 0x7f;
  tagHeader[8] = (totalContent >> 7) & 0x7f;
  tagHeader[9] = totalContent & 0x7f;

  const result = new Uint8Array(10 + totalContent);
  result.set(tagHeader, 0);
  let pos = 10;
  for (const f of encodedFrames) {
    result.set(f, pos);
    pos += f.length;
  }
  return result.buffer;
}

function makeID3v22Buffer(frames: Array<{ id: string; text: string; encoding?: number }>): ArrayBuffer {
  const encodedFrames: Uint8Array[] = [];
  for (const f of frames) {
    const enc = f.encoding ?? 0;
    const textBytes = new TextEncoder().encode(f.text);
    const frameSize = 1 + textBytes.length;
    const frameHeader = new Uint8Array(6);
    for (let i = 0; i < 3; i++) frameHeader[i] = f.id.charCodeAt(i);
    frameHeader[3] = (frameSize >> 16) & 0xff;
    frameHeader[4] = (frameSize >> 8) & 0xff;
    frameHeader[5] = frameSize & 0xff;

    const frame = new Uint8Array(6 + frameSize);
    frame.set(frameHeader, 0);
    frame[6] = enc;
    frame.set(textBytes, 7);
    encodedFrames.push(frame);
  }

  const totalContent = encodedFrames.reduce((sum, f) => sum + f.length, 0);
  const tagHeader = new Uint8Array(10);
  tagHeader[0] = 0x49;
  tagHeader[1] = 0x44;
  tagHeader[2] = 0x33;
  tagHeader[3] = 2; // v2.2
  tagHeader[4] = 0;
  tagHeader[5] = 0;
  tagHeader[6] = (totalContent >> 21) & 0x7f;
  tagHeader[7] = (totalContent >> 14) & 0x7f;
  tagHeader[8] = (totalContent >> 7) & 0x7f;
  tagHeader[9] = totalContent & 0x7f;

  const result = new Uint8Array(10 + totalContent);
  result.set(tagHeader, 0);
  let pos = 10;
  for (const f of encodedFrames) {
    result.set(f, pos);
    pos += f.length;
  }
  return result.buffer;
}

function makeID3v1Buffer(fields: { title?: string; artist?: string; album?: string; track?: number }): ArrayBuffer {
  const buf = new Uint8Array(128);
  buf[0] = 0x54; // T
  buf[1] = 0x41; // A
  buf[2] = 0x47; // G

  const writeStr = (start: number, maxLen: number, str?: string) => {
    if (!str) return;
    const bytes = new TextEncoder().encode(str).subarray(0, maxLen);
    buf.set(bytes, start);
  };

  writeStr(3, 30, fields.title);
  writeStr(33, 30, fields.artist);
  writeStr(63, 30, fields.album);
  if (fields.track !== undefined) {
    buf[125] = 0;
    buf[126] = fields.track & 0xff;
  }
  return buf.buffer;
}

describe("ID3v2.3 parsing & UTF-16 decoding", () => {
  it("correctly parses ID3v2.3 UTF-16LE titles with BOM (Beyoncé & Megan Thee Stallion cases)", () => {
    const buffer = makeID3v23Buffer([
      { id: "TIT2", text: "MORNING DEW (DONK)", encoding: 1 },
      { id: "TPE1", text: "Beyoncé", encoding: 1 },
      { id: "TALB", text: "Renaissance", encoding: 1 },
    ]);

    const tags = parseID3v2(buffer);
    expect(tags.title).toBe("MORNING DEW (DONK)");
    expect(tags.artist).toBe("Beyoncé");
    expect(tags.album).toBe("Renaissance");
  });

  it("parses Megan Thee Stallion - Thot Shit without mojibake or desynchronization", () => {
    const buffer = makeID3v23Buffer([
      { id: "TIT2", text: "Thot Shit", encoding: 1 },
      { id: "TPE1", text: "Megan Thee Stallion", encoding: 1 },
      { id: "TRCK", text: "1/12", encoding: 0 },
    ]);

    const tags = parseID3v2(buffer);
    expect(tags.title).toBe("Thot Shit");
    expect(tags.artist).toBe("Megan Thee Stallion");
    expect(tags.trackNumber).toBe(1);
    expect(tags.albumTrackCount).toBe(12);
  });

  it("handles Latin-1 encoding with sneaky UTF-8 bytes (auto-detection)", () => {
    // UTF-8 bytes for Beyoncé under encoding 0
    const utf8Bytes = new TextEncoder().encode("Beyoncé");
    const rawLatin1 = Array.from(utf8Bytes)
      .map((b) => String.fromCharCode(b))
      .join("");

    const buffer = makeID3v23Buffer([
      { id: "TIT2", text: rawLatin1, encoding: 0 },
      { id: "TPE1", text: rawLatin1, encoding: 0 },
    ]);

    const tags = parseID3v2(buffer);
    expect(tags.title).toBe("Beyoncé");
    expect(tags.artist).toBe("Beyoncé");
  });
});

describe("ID3v2.2 parsing", () => {
  it("parses 3-character ID3v2.2 frames (TT2, TP1, TAL, TRK)", () => {
    const buffer = makeID3v22Buffer([
      { id: "TT2", text: "Criminal", encoding: 3 },
      { id: "TP1", text: "Britney Spears", encoding: 3 },
      { id: "TAL", text: "Femme Fatale", encoding: 3 },
      { id: "TRK", text: "5", encoding: 3 },
    ]);

    const tags = parseID3v2(buffer);
    expect(tags.title).toBe("Criminal");
    expect(tags.artist).toBe("Britney Spears");
    expect(tags.album).toBe("Femme Fatale");
    expect(tags.trackNumber).toBe(5);
  });
});

describe("ID3v1 parsing", () => {
  it("parses standard 128-byte ID3v1 / ID3v1.1 trailer", () => {
    const buffer = makeID3v1Buffer({
      title: "SexyBack",
      artist: "Justin Timberlake",
      album: "FutureSex/LoveSounds",
      track: 2,
    });

    const tags = parseID3v1(buffer);
    expect(tags.title).toBe("SexyBack");
    expect(tags.artist).toBe("Justin Timberlake");
    expect(tags.album).toBe("FutureSex/LoveSounds");
    expect(tags.trackNumber).toBe(2);
  });
});

describe("Corrupted metadata detection & Unicode preservation", () => {
  it("identifies corrupted strings with raw BOM mojibake and NUL characters", () => {
    expect(isCorruptedOrSuspiciousMetadata("ÿþThot Shit")).toBe(true);
    expect(isCorruptedOrSuspiciousMetadata("\x00\x00\x01ÿþMORNING DEW (DONK)")).toBe(true);
    expect(isCorruptedOrSuspiciousMetadata("Title with \uFFFD")).toBe(true);
    expect(isCorruptedOrSuspiciousMetadata("   ")).toBe(true);
    expect(isCorruptedOrSuspiciousMetadata("")).toBe(false);
  });

  it("never flags legitimate Unicode characters or non-Latin scripts as corrupted", () => {
    expect(isCorruptedOrSuspiciousMetadata("Beyoncé")).toBe(false);
    expect(isCorruptedOrSuspiciousMetadata("Björk")).toBe(false);
    expect(isCorruptedOrSuspiciousMetadata("宇多田ヒカル")).toBe(false);
    expect(isCorruptedOrSuspiciousMetadata("周杰伦")).toBe(false);
    expect(isCorruptedOrSuspiciousMetadata("방탄소년단")).toBe(false);
    expect(isCorruptedOrSuspiciousMetadata("Тату")).toBe(false);
    expect(isCorruptedOrSuspiciousMetadata("Tasya Kamila “Say No” (Thailand Edit)")).toBe(false);
    expect(isCorruptedOrSuspiciousMetadata("MORNING DEW (DONK)")).toBe(false);
    expect(isCorruptedOrSuspiciousMetadata("AC/DC")).toBe(false);
  });

  it("repairs UTF-8 mojibake decoded as Windows-1252", () => {
    expect(tryRepairMojibake("Beyonc\u00C3\u00A9")).toBe("Beyoncé");
  });

  it("cleanTagText rejects corrupted metadata and returns undefined", () => {
    expect(cleanTagText("ÿþThot Shit")).toBeUndefined();
    expect(cleanTagText("\x00\x00\x01ÿþMORNING DEW (DONK)")).toBeUndefined();
    expect(cleanTagText("MORNING DEW (DONK)")).toBe("MORNING DEW (DONK)");
    expect(cleanTagText("Beyoncé")).toBe("Beyoncé");
    expect(cleanTagText("宇多田ヒカル")).toBe("宇多田ヒカル");
  });
});
