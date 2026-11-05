import { describe, expect, it } from "vitest";
import {
  extractClustersFromPixels,
  selectDistinctClusters,
} from "./extraction";
import { enforceLegibility, createFallbackPalette } from "./legibility";
import { selectPreset } from "./presets";
import type { PixelData } from "./extraction";

/** Helper to generate a 32x32 pixel buffer with specific RGBA colors. */
function makePixelBuffer(colorWeights: Array<{ r: number; g: number; b: number; a?: number; weight: number }>): PixelData {
  const buffer = new Uint8ClampedArray(32 * 32 * 4);
  const totalWeight = colorWeights.reduce((acc, c) => acc + c.weight, 0);
  let offset = 0;

  for (const c of colorWeights) {
    const count = Math.round((c.weight / totalWeight) * 1024);
    for (let i = 0; i < count && offset < buffer.length; i++) {
      buffer[offset] = c.r;
      buffer[offset + 1] = c.g;
      buffer[offset + 2] = c.b;
      buffer[offset + 3] = c.a ?? 255;
      offset += 4;
    }
  }

  // Fill remainder if any
  while (offset < buffer.length) {
    const last = colorWeights[colorWeights.length - 1];
    buffer[offset] = last.r;
    buffer[offset + 1] = last.g;
    buffer[offset + 2] = last.b;
    buffer[offset + 3] = last.a ?? 255;
    offset += 4;
  }

  return buffer;
}

describe("Adaptive Lyrics Background - Palette & Legibility System", () => {
  // Test Cover 1: Red / White / Black
  it("Test Cover 1: Red / White / Black yields red-toned safe palette with >= 4.5:1 contrast", () => {
    const pixels = makePixelBuffer([
      { r: 220, g: 20, b: 30, weight: 4 }, // Red
      { r: 250, g: 250, b: 250, weight: 3 }, // White
      { r: 15, g: 15, b: 15, weight: 3 }, // Black
    ]);

    const clusters = selectDistinctClusters(extractClustersFromPixels(pixels));
    const preset = selectPreset(clusters);
    const palette = enforceLegibility(clusters, preset, "red-white-black");

    expect(palette.worstCaseContrast).toBeGreaterThanOrEqual(4.5);
    expect(palette.averageLuminance).toBeLessThanOrEqual(0.185);
    // Base should be dark red
    expect(palette.baseColor).toMatch(/^hsl\(\d+,\s*\d+%,\s*\d+%\)$/);
  });

  // Test Cover 2: Pure White
  it("Test Cover 2: Pure White cover never produces white glaring background (contrast >= 4.5:1)", () => {
    const pixels = makePixelBuffer([
      { r: 255, g: 255, b: 255, weight: 1 },
    ]);

    const clusters = selectDistinctClusters(extractClustersFromPixels(pixels));
    const preset = selectPreset(clusters);
    const palette = enforceLegibility(clusters, preset, "pure-white");

    expect(palette.worstCaseContrast).toBeGreaterThanOrEqual(4.5);
    expect(palette.averageLuminance).toBeLessThanOrEqual(0.185);
  });

  // Test Cover 3: Pure Black
  it("Test Cover 3: Pure Black cover produces deep dark base and controlled calm/balanced blobs", () => {
    const pixels = makePixelBuffer([
      { r: 0, g: 0, b: 0, weight: 1 },
    ]);

    const clusters = selectDistinctClusters(extractClustersFromPixels(pixels));
    const preset = selectPreset(clusters);
    const palette = enforceLegibility(clusters, preset, "pure-black");

    expect(palette.worstCaseContrast).toBeGreaterThanOrEqual(4.5);
    expect(palette.averageLuminance).toBeLessThanOrEqual(0.185);
  });

  // Test Cover 4: Grayscale Photo
  it("Test Cover 4: Grayscale photo triggers 'calm' preset and produces low-chroma drift", () => {
    const pixels = makePixelBuffer([
      { r: 50, g: 50, b: 50, weight: 3 },
      { r: 120, g: 120, b: 120, weight: 4 },
      { r: 200, g: 200, b: 200, weight: 3 },
    ]);

    const clusters = selectDistinctClusters(extractClustersFromPixels(pixels));
    const preset = selectPreset(clusters);
    expect(preset).toBe("calm");

    const palette = enforceLegibility(clusters, preset, "grayscale");
    expect(palette.preset).toBe("calm");
    expect(palette.worstCaseContrast).toBeGreaterThanOrEqual(4.5);
  });

  // Test Cover 5: Neon Multi-Color
  it("Test Cover 5: Neon Multi-Color triggers 'flow' preset with vibrant distinct blobs", () => {
    const pixels = makePixelBuffer([
      { r: 255, g: 0, b: 128, weight: 3 }, // Hot Pink
      { r: 0, g: 255, b: 200, weight: 3 }, // Cyan/Turquoise
      { r: 255, g: 220, b: 0, weight: 2 }, // Neon Yellow
      { r: 130, g: 0, b: 255, weight: 2 }, // Purple
    ]);

    const clusters = selectDistinctClusters(extractClustersFromPixels(pixels));
    const preset = selectPreset(clusters);
    expect(preset).toBe("flow");

    const palette = enforceLegibility(clusters, preset, "neon");
    expect(palette.preset).toBe("flow");
    expect(palette.worstCaseContrast).toBeGreaterThanOrEqual(4.5);
    expect(palette.averageLuminance).toBeLessThanOrEqual(0.185);
  });

  // Test Cover 6: Pastel
  it("Test Cover 6: Pastel cover triggers 'dim' preset and clamps lightness appropriately", () => {
    const pixels = makePixelBuffer([
      { r: 255, g: 210, b: 220, weight: 3 }, // Pastel Pink
      { r: 210, g: 235, b: 255, weight: 3 }, // Pastel Blue
      { r: 240, g: 255, b: 220, weight: 4 }, // Pastel Green
    ]);

    const clusters = selectDistinctClusters(extractClustersFromPixels(pixels));
    const preset = selectPreset(clusters);
    expect(preset).toBe("dim");

    const palette = enforceLegibility(clusters, preset, "pastel");
    expect(palette.worstCaseContrast).toBeGreaterThanOrEqual(4.5);
    expect(palette.averageLuminance).toBeLessThanOrEqual(0.185);
  });

  // Test Cover 7: Transparent Pixels Ignored
  it("Test Cover 7: Cover with transparency ignores pixels with alpha < 200", () => {
    const pixels = makePixelBuffer([
      { r: 255, g: 0, b: 0, a: 50, weight: 8 }, // 80% low alpha (should be ignored)
      { r: 0, g: 0, b: 220, a: 255, weight: 2 }, // 20% solid blue
    ]);

    const raw = extractClustersFromPixels(pixels);
    expect(raw.length).toBeGreaterThan(0);
    // Dominant cluster must be blue, not red
    const blueDom = raw[0];
    expect(blueDom.rgb.b).toBeGreaterThan(blueDom.rgb.r);
  });

  // Test Cover 8: Missing Cover Fallback
  it("Test Cover 8: Missing cover creates safe fallback palette", () => {
    const fallback = createFallbackPalette();
    expect(fallback.worstCaseContrast).toBeGreaterThanOrEqual(4.5);
    expect(fallback.baseColor).toBeDefined();
    expect(fallback.blobColors).toHaveLength(4);
    expect(fallback.preset).toBe("calm");
  });
});
