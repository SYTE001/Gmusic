import { colorDistance, hslToRgb, hueDistance, relativeLuminance, rgbToHsl } from "./colorUtils";
import type { ColorCluster, HslColor, RgbColor } from "./types";

const K_CLUSTERS = 5;
const MAX_ITERATIONS = 8;
const MIN_ALPHA = 200;

export type PixelData = Uint8ClampedArray | number[];

/**
 * Extracts raw color clusters from a 32x32 RGBA pixel buffer (1024 pixels).
 * Filters out low-alpha pixels and quantizes with k-means.
 */
export function extractClustersFromPixels(pixels: PixelData): ColorCluster[] {
  const validPixels: RgbColor[] = [];
  const len = pixels.length;

  for (let i = 0; i < len; i += 4) {
    const a = pixels[i + 3];
    if (a >= MIN_ALPHA) {
      validPixels.push({
        r: pixels[i],
        g: pixels[i + 1],
        b: pixels[i + 2],
      });
    }
  }

  if (validPixels.length === 0) {
    return [];
  }

  // Initialize k centroids using evenly distributed steps
  const k = Math.min(K_CLUSTERS, validPixels.length);
  const centroids: RgbColor[] = [];
  const step = Math.floor(validPixels.length / k);

  for (let i = 0; i < k; i++) {
    centroids.push({ ...validPixels[i * step] });
  }

  // Run k-means iterations
  const assignments = new Int32Array(validPixels.length);
  const counts = new Int32Array(k);
  const sumR = new Float64Array(k);
  const sumG = new Float64Array(k);
  const sumB = new Float64Array(k);

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    counts.fill(0);
    sumR.fill(0);
    sumG.fill(0);
    sumB.fill(0);

    let changed = false;

    // Assign each pixel to the nearest centroid
    for (let p = 0; p < validPixels.length; p++) {
      const pixel = validPixels[p];
      let bestDist = Infinity;
      let bestCluster = 0;

      for (let c = 0; c < k; c++) {
        const dist = colorDistance(pixel, centroids[c]);
        if (dist < bestDist) {
          bestDist = dist;
          bestCluster = c;
        }
      }

      if (assignments[p] !== bestCluster) {
        assignments[p] = bestCluster;
        changed = true;
      }

      counts[bestCluster]++;
      sumR[bestCluster] += pixel.r;
      sumG[bestCluster] += pixel.g;
      sumB[bestCluster] += pixel.b;
    }

    if (!changed && iter > 0) break;

    // Update centroids
    for (let c = 0; c < k; c++) {
      if (counts[c] > 0) {
        centroids[c] = {
          r: Math.round(sumR[c] / counts[c]),
          g: Math.round(sumG[c] / counts[c]),
          b: Math.round(sumB[c] / counts[c]),
        };
      }
    }
  }

  // Compute cluster statistics and score
  const totalPixels = validPixels.length;
  const clusters: ColorCluster[] = [];

  for (let c = 0; c < k; c++) {
    const count = counts[c];
    if (count === 0) continue;

    const rgb = centroids[c];
    const hsl = rgbToHsl(rgb);
    const population = count / totalPixels;
    const luminance = relativeLuminance(rgb);

    // PRD 4.1: score = population * 0.5 + saturation * 0.4 + (1 - |lightness - 0.5|) * 0.1
    const score = population * 0.5 + hsl.s * 0.4 + (1 - Math.abs(hsl.l - 0.5)) * 0.1;

    clusters.push({
      rgb,
      hsl,
      population,
      luminance,
      score,
    });
  }

  // Sort by score descending
  clusters.sort((a, b) => b.score - a.score);
  return clusters;
}

/**
 * Picks 3-4 distinct clusters from sorted candidates.
 * Distinct condition: hue distance > 25 degrees OR lightness distance > 0.2.
 */
export function selectDistinctClusters(clusters: ColorCluster[]): ColorCluster[] {
  if (clusters.length === 0) return [];

  const selected: ColorCluster[] = [];

  for (const cluster of clusters) {
    const isDistinct = selected.every((s) => {
      // If either is very desaturated, hue comparison is noisy; rely on lightness
      if (cluster.hsl.s < 0.1 || s.hsl.s < 0.1) {
        return Math.abs(cluster.hsl.l - s.hsl.l) > 0.15;
      }
      return (
        hueDistance(cluster.hsl.h, s.hsl.h) > 25 ||
        Math.abs(cluster.hsl.l - s.hsl.l) > 0.2
      );
    });

    if (isDistinct) {
      selected.push(cluster);
      if (selected.length >= 4) break;
    }
  }

  // If we couldn't find enough distinct clusters, synthesize harmonious variations
  if (selected.length < 4 && selected.length > 0) {
    const dominant = selected[0];
    const needed = 4 - selected.length;
    const hueOffsets = [30, -30, 60, -60, 180];
    const lightnessOffsets = [-0.15, 0.12, -0.08, 0.18];

    for (let i = 0; i < needed; i++) {
      const hOffset = hueOffsets[i % hueOffsets.length];
      const lOffset = lightnessOffsets[i % lightnessOffsets.length];
      const h = (dominant.hsl.h + hOffset + 360) % 360;
      const s = Math.max(0.2, Math.min(0.8, dominant.hsl.s * 0.9));
      const l = Math.max(0.25, Math.min(0.65, dominant.hsl.l + lOffset));
      const synthHsl: HslColor = { h, s, l };
      const synthRgb = hslToRgb(synthHsl);

      selected.push({
        rgb: synthRgb,
        hsl: synthHsl,
        population: 0.1,
        luminance: relativeLuminance(synthRgb),
        score: dominant.score * 0.8,
      });
    }
  }

  return selected;
}
