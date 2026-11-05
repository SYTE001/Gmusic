import { colorDistance, relativeLuminance, rgbToHsl } from "./colorUtils";
import type { ColorCluster, RgbColor } from "./types";

const K_CLUSTERS = 5;
const MAX_ITERATIONS = 8;
const MIN_ALPHA = 200;

export type PixelData = Uint8ClampedArray | number[];

/**
 * Computes a meaningfulness score for a color cluster (Task §3):
 * Scores by population and saturation so a large white or black border
 * never outranks a saturated subject (e.g., red figure on white cover).
 */
export function scoreClusterMeaningfulness(population: number, s: number, l: number): number {
  let chromaWeight = 1.0;

  // Penalize near-white (white border / background) and near-black (black border / shadows)
  if (l > 0.88 && s < 0.25) {
    chromaWeight = 0.08;
  } else if (l < 0.08) {
    chromaWeight = 0.12;
  } else if (s < 0.12) {
    chromaWeight = 0.18;
  } else if (l > 0.78 && s < 0.35) {
    chromaWeight = 0.35;
  }

  const midtonePreference = Math.max(0, 1 - Math.abs(l - 0.5) * 1.4);
  return (population * 0.42 + s * 0.48 + midtonePreference * 0.1) * chromaWeight;
}

/**
 * Extracts ~5 color clusters from a 32x32 RGBA pixel buffer (1024 pixels).
 * Ignores pixels with alpha < 200 and quantizes via k-means.
 * Clusters are returned sorted by meaningfulness score descending.
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

  // Initialize k centroids using evenly distributed steps across the image
  const k = Math.min(K_CLUSTERS, validPixels.length);
  const centroids: RgbColor[] = [];
  const step = Math.max(1, Math.floor(validPixels.length / k));

  for (let i = 0; i < k; i++) {
    centroids.push({ ...validPixels[Math.min(validPixels.length - 1, i * step)] });
  }

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

  const totalPixels = validPixels.length;
  const clusters: ColorCluster[] = [];

  for (let c = 0; c < k; c++) {
    const count = counts[c];
    if (count === 0) continue;

    const rgb = centroids[c];
    const hsl = rgbToHsl(rgb);
    const population = count / totalPixels;
    const luminance = relativeLuminance(rgb);
    const score = scoreClusterMeaningfulness(population, hsl.s, hsl.l);

    clusters.push({
      rgb,
      hsl,
      population,
      luminance,
      score,
    });
  }

  clusters.sort((a, b) => b.score - a.score);
  return clusters;
}
