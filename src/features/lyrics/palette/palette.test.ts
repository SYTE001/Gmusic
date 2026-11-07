import { describe, expect, it } from "vitest";
import { extractClustersFromPixels } from "./extraction";
import { selectSolidPalette, createFallbackPalette } from "./legibility";
import type { PixelData } from "./extraction";

/** Helper to generate a 32x32 pixel buffer with specific RGBA colors. */
function makePixelBuffer(
  colorWeights: Array<{ r: number; g: number; b: number; a?: number; weight: number }>
): PixelData {
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

describe("Solid Album-Adaptive Palette & Contrast System", () => {
  it("1. White cover (e.g. Rihanna - Breakin' Dishes) -> near-black neutral/faint tint (L 6-9%) with >= 7:1 active & >= 3:1 inactive", () => {
    const pixels = makePixelBuffer([
      { r: 252, g: 252, b: 250, weight: 8 },
      { r: 210, g: 205, b: 200, weight: 2 },
    ]);
    const clusters = extractClustersFromPixels(pixels);
    const palette = selectSolidPalette(clusters, "white-cover");

    expect(palette.category).toBe("light");
    expect(palette.bgHsl.l).toBeGreaterThanOrEqual(0.06);
    expect(palette.bgHsl.l).toBeLessThanOrEqual(0.09);
    expect(palette.contrasts.active).toBeGreaterThanOrEqual(7.0);
    expect(palette.contrasts.inactive).toBeGreaterThanOrEqual(3.0);
    expect(palette.contrasts.uiText).toBeGreaterThanOrEqual(4.5);
  });

  it("2. Red cover (e.g. Megan Thee Stallion - Thot Shit) -> deep dark red (hsl(h, 60-70%, 12-18%)), visibly different from white cover", () => {
    const pixels = makePixelBuffer([
      { r: 215, g: 20, b: 32, weight: 7 },
      { r: 160, g: 12, b: 22, weight: 2 },
      { r: 25, g: 10, b: 12, weight: 1 },
    ]);
    const clusters = extractClustersFromPixels(pixels);
    const palette = selectSolidPalette(clusters, "red-cover");

    expect(palette.category).toBe("saturated");
    // Red hue around 345-360 or 0-15
    expect(palette.bgHsl.h >= 340 || palette.bgHsl.h <= 20).toBe(true);
    expect(palette.bgHsl.s).toBeGreaterThanOrEqual(0.55);
    expect(palette.bgHsl.l).toBeGreaterThanOrEqual(0.11);
    expect(palette.bgHsl.l).toBeLessThanOrEqual(0.18);
    expect(palette.bgRgb.r).toBeGreaterThan(palette.bgRgb.b * 2);
    expect(palette.contrasts.active).toBeGreaterThanOrEqual(7.0);
    expect(palette.contrasts.inactive).toBeGreaterThanOrEqual(3.0);
    expect(palette.contrasts.uiText).toBeGreaterThanOrEqual(4.5);
  });

  it("3. Blue cover -> deep dark blue with passing contrast", () => {
    const pixels = makePixelBuffer([
      { r: 20, g: 95, b: 230, weight: 8 },
      { r: 10, g: 45, b: 140, weight: 2 },
    ]);
    const clusters = extractClustersFromPixels(pixels);
    const palette = selectSolidPalette(clusters, "blue-cover");

    expect(palette.category).toBe("saturated");
    expect(palette.bgHsl.h).toBeGreaterThanOrEqual(200);
    expect(palette.bgHsl.h).toBeLessThanOrEqual(240);
    expect(palette.bgRgb.b).toBeGreaterThan(palette.bgRgb.r * 2);
    expect(palette.contrasts.active).toBeGreaterThanOrEqual(7.0);
    expect(palette.contrasts.inactive).toBeGreaterThanOrEqual(3.0);
    expect(palette.contrasts.uiText).toBeGreaterThanOrEqual(4.5);
  });

  it("4. Green cover -> deep dark green with passing contrast", () => {
    const pixels = makePixelBuffer([
      { r: 24, g: 185, b: 75, weight: 8 },
      { r: 14, g: 110, b: 45, weight: 2 },
    ]);
    const clusters = extractClustersFromPixels(pixels);
    const palette = selectSolidPalette(clusters, "green-cover");

    expect(palette.category).toBe("saturated");
    expect(palette.bgHsl.h).toBeGreaterThanOrEqual(115);
    expect(palette.bgHsl.h).toBeLessThanOrEqual(160);
    expect(palette.bgRgb.g).toBeGreaterThan(palette.bgRgb.r * 1.8);
    expect(palette.contrasts.active).toBeGreaterThanOrEqual(7.0);
    expect(palette.contrasts.inactive).toBeGreaterThanOrEqual(3.0);
    expect(palette.contrasts.uiText).toBeGreaterThanOrEqual(4.5);
  });

  it("5. Black / dark cover -> lifted slightly so not pure black (L 10-16%)", () => {
    const pixels = makePixelBuffer([
      { r: 18, g: 12, b: 28, weight: 7 },
      { r: 8, g: 6, b: 12, weight: 3 },
    ]);
    const clusters = extractClustersFromPixels(pixels);
    const palette = selectSolidPalette(clusters, "dark-cover");

    expect(palette.category).toBe("dark");
    expect(palette.bgHsl.l).toBeGreaterThanOrEqual(0.10);
    expect(palette.bgHsl.l).toBeLessThanOrEqual(0.16);
    expect(palette.contrasts.active).toBeGreaterThanOrEqual(7.0);
    expect(palette.contrasts.inactive).toBeGreaterThanOrEqual(3.0);
    expect(palette.contrasts.uiText).toBeGreaterThanOrEqual(4.5);
  });

  it("6. Grayscale cover -> neutral charcoal (L 8-12%)", () => {
    const pixels = makePixelBuffer([
      { r: 50, g: 50, b: 50, weight: 3 },
      { r: 120, g: 120, b: 120, weight: 4 },
      { r: 195, g: 195, b: 195, weight: 3 },
    ]);
    const clusters = extractClustersFromPixels(pixels);
    const palette = selectSolidPalette(clusters, "grayscale-cover");

    expect(palette.category).toBe("grayscale");
    expect(palette.bgHsl.l).toBeGreaterThanOrEqual(0.08);
    expect(palette.bgHsl.l).toBeLessThanOrEqual(0.12);
    expect(palette.bgHsl.s).toBeLessThanOrEqual(0.06);
    expect(palette.contrasts.active).toBeGreaterThanOrEqual(7.0);
    expect(palette.contrasts.inactive).toBeGreaterThanOrEqual(3.0);
    expect(palette.contrasts.uiText).toBeGreaterThanOrEqual(4.5);
  });

  it("7. Pastel cover -> near-black with faint tint of cover hue (L 6-9%)", () => {
    const pixels = makePixelBuffer([
      { r: 248, g: 212, b: 224, weight: 5 },
      { r: 225, g: 238, b: 252, weight: 5 },
    ]);
    const clusters = extractClustersFromPixels(pixels);
    const palette = selectSolidPalette(clusters, "pastel-cover");

    expect(palette.category).toBe("light");
    expect(palette.bgHsl.l).toBeGreaterThanOrEqual(0.06);
    expect(palette.bgHsl.l).toBeLessThanOrEqual(0.09);
    expect(palette.contrasts.active).toBeGreaterThanOrEqual(7.0);
    expect(palette.contrasts.inactive).toBeGreaterThanOrEqual(3.0);
    expect(palette.contrasts.uiText).toBeGreaterThanOrEqual(4.5);
  });

  it("8. Cover with a big white border -> selects the saturated subject (red) over the larger white border", () => {
    const pixels = makePixelBuffer([
      { r: 252, g: 252, b: 252, weight: 65 }, // 65% white border
      { r: 215, g: 24, b: 36, weight: 35 },   // 35% red subject
    ]);
    const clusters = extractClustersFromPixels(pixels);
    const palette = selectSolidPalette(clusters, "white-border-red-subject");

    expect(palette.category).toBe("saturated");
    expect(palette.bgHsl.h >= 340 || palette.bgHsl.h <= 20).toBe(true);
    expect(palette.bgRgb.r).toBeGreaterThan(palette.bgRgb.b * 2);
    expect(palette.contrasts.active).toBeGreaterThanOrEqual(7.0);
    expect(palette.contrasts.inactive).toBeGreaterThanOrEqual(3.0);
    expect(palette.contrasts.uiText).toBeGreaterThanOrEqual(4.5);
  });

  it("9. Missing cover -> fallback neutral dark with passing contrast", () => {
    const fallback = createFallbackPalette("missing-cover");
    expect(fallback.category).toBe("fallback");
    expect(fallback.contrasts.active).toBeGreaterThanOrEqual(7.0);
    expect(fallback.contrasts.inactive).toBeGreaterThanOrEqual(3.0);
    expect(fallback.contrasts.uiText).toBeGreaterThanOrEqual(4.5);
  });

  it("ignores transparent pixels with alpha < 200", () => {
    const pixels = makePixelBuffer([
      { r: 255, g: 0, b: 0, a: 50, weight: 8 },
      { r: 0, g: 80, b: 220, a: 255, weight: 2 },
    ]);
    const raw = extractClustersFromPixels(pixels);
    expect(raw.length).toBeGreaterThan(0);
    expect(raw[0].rgb.b).toBeGreaterThan(raw[0].rgb.r);
  });
});
