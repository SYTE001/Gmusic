/**
 * Generates small WAV fixtures for browser verification: three short tones
 * with "NN - Artist - Title.wav" names (exercises filename-derived metadata,
 * since WAV carries no tags we parse) plus a matching .lrc file.
 */
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const outDir = path.resolve("test-media");

function wavBytes({ seconds, frequency, amplitude = 0.35 }) {
  const sampleRate = 44100;
  const numSamples = Math.floor(sampleRate * seconds);
  const dataSize = numSamples * 2; // 16-bit mono
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16); // PCM chunk size
  buffer.writeUInt16LE(1, 20); // PCM format
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);

  let phase = 0;
  for (let i = 0; i < numSamples; i += 1) {
    // Gentle amplitude pulse so playback visibly progresses
    const pulse = 0.6 + 0.4 * Math.sin((2 * Math.PI * i) / sampleRate);
    const sample = Math.sin(phase) * amplitude * pulse;
    buffer.writeInt16LE(Math.round(sample * 32767), 44 + i * 2);
    phase += (2 * Math.PI * frequency) / sampleRate;
  }
  return buffer;
}

const tracks = [
  { file: "01 - Aurora Fields - Gentle Rise.wav", seconds: 8, frequency: 440 },
  { file: "02 - Aurora Fields - Night Signal.wav", seconds: 8, frequency: 523.25 },
  { file: "03 - Blue Harbor - Drift.wav", seconds: 8, frequency: 349.23 },
];

const lrc = `[ti:Gentle Rise]
[ar:Aurora Fields]
[offset:0]

[00:00.50]First line begins
[00:02.00]Second line follows
[00:04.00]Third line arrives
[00:06.00]Final line closes
`;

await mkdir(outDir, { recursive: true });
for (const track of tracks) {
  await writeFile(path.join(outDir, track.file), wavBytes(track));
}
await writeFile(path.join(outDir, "Aurora Fields - Gentle Rise.lrc"), lrc, "utf8");
console.log(`Wrote ${tracks.length} WAVs + 1 LRC to ${outDir}`);
