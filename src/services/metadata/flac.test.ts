import { describe, expect, it } from "vitest";
import { parseFlacTags } from "./flac";

function createFlacFile(blocks: Array<{ type: number; isLast: boolean; data: Uint8Array }>): File {
  // fLaC magic number
  const parts: Uint8Array[] = [new Uint8Array([0x66, 0x4c, 0x61, 0x43])];

  for (const block of blocks) {
    const header = new Uint8Array(4);
    header[0] = (block.isLast ? 0x80 : 0x00) | (block.type & 0x7f);
    header[1] = (block.data.length >> 16) & 0xff;
    header[2] = (block.data.length >> 8) & 0xff;
    header[3] = block.data.length & 0xff;
    parts.push(header);
    parts.push(block.data);
  }

  const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
  const fullBytes = new Uint8Array(totalLength);
  let cursor = 0;
  for (const p of parts) {
    fullBytes.set(p, cursor);
    cursor += p.length;
  }

  const file = new File([fullBytes], "test.flac", { type: "audio/flac" });
  file.slice = (start?: number, end?: number, contentType?: string) => {
    const sliced = fullBytes.subarray(start ?? 0, end ?? fullBytes.length);
    const blob = new Blob([sliced], { type: contentType });
    blob.arrayBuffer = async () =>
      sliced.buffer.slice(sliced.byteOffset, sliced.byteOffset + sliced.byteLength);
    return blob;
  };
  return file;
}

function makeStreaminfo(sampleRate: number, totalSamples: number): Uint8Array {
  const buf = new Uint8Array(34);
  // min/max blocksize (bytes 0-3)
  buf[0] = 0x10; buf[1] = 0x00; buf[2] = 0x10; buf[3] = 0x00;

  // bytes 10-17: sample rate (20b), channels (3b), bps (5b), total samples (36b)
  buf[10] = (sampleRate >> 12) & 0xff;
  buf[11] = (sampleRate >> 4) & 0xff;
  buf[12] = ((sampleRate & 0x0f) << 4) | (1 << 1) | 0; // 2 channels (1), 16bps

  const high4 = Math.floor(totalSamples / 0x100000000) & 0x0f;
  const low32 = totalSamples >>> 0;
  buf[13] = (15 << 4) | high4; // 16 bits per sample, high 4 bits of total_samples
  buf[14] = (low32 >> 24) & 0xff;
  buf[15] = (low32 >> 16) & 0xff;
  buf[16] = (low32 >> 8) & 0xff;
  buf[17] = low32 & 0xff;

  return buf;
}

describe("FLAC metadata and STREAMINFO parser", () => {
  it("parses sample rate and total samples to calculate exact duration", async () => {
    // 44100 Hz, 441000 samples = exactly 10,000 ms (10 seconds)
    const streaminfo = makeStreaminfo(44100, 441000);
    const file = createFlacFile([{ type: 0, isLast: true, data: streaminfo }]);

    const tags = await parseFlacTags(file);
    expect(tags.durationMs).toBe(10000);
  });

  it("handles high-resolution 96kHz 24-bit audio duration accurately", async () => {
    // 96000 Hz, 9600000 samples = exactly 100,000 ms
    const streaminfo = makeStreaminfo(96000, 9600000);
    const file = createFlacFile([{ type: 0, isLast: true, data: streaminfo }]);

    const tags = await parseFlacTags(file);
    expect(tags.durationMs).toBe(100000);
  });

  it("handles zero sample rate or zero total samples by leaving durationMs undefined", async () => {
    const zeroRate = makeStreaminfo(0, 441000);
    const file1 = createFlacFile([{ type: 0, isLast: true, data: zeroRate }]);
    const tags1 = await parseFlacTags(file1);
    expect(tags1.durationMs).toBeUndefined();

    const zeroSamples = makeStreaminfo(44100, 0);
    const file2 = createFlacFile([{ type: 0, isLast: true, data: zeroSamples }]);
    const tags2 = await parseFlacTags(file2);
    expect(tags2.durationMs).toBeUndefined();
  });

  it("handles truncated/malformed STREAMINFO without throwing", async () => {
    const truncated = new Uint8Array(20); // less than 34 bytes
    const file = createFlacFile([{ type: 0, isLast: true, data: truncated }]);

    const tags = await parseFlacTags(file);
    expect(tags.durationMs).toBeUndefined();
  });
});
