import { hueDistance } from "./colorUtils";
import type { ColorCluster, PresetConfig, PresetName } from "./types";

/**
 * Preset table configuring animation parameters, opacity, and scrim intensities.
 * Plain config object for easy tuning (PRD §4.3).
 */
export const PRESET_CONFIGS: Record<PresetName, PresetConfig> = {
  calm: {
    name: "calm",
    blobCount: 3,
    duration: 50, // 50s slow loop
    blobOpacity: 0.35,
    scrimTop: 0.28,
    scrimBottom: 0.48,
    travelScale: 0.7,
  },
  dim: {
    name: "dim",
    blobCount: 4,
    duration: 42,
    blobOpacity: 0.42,
    scrimTop: 0.35,
    scrimBottom: 0.60,
    travelScale: 0.9,
  },
  flow: {
    name: "flow",
    blobCount: 4,
    duration: 32,
    blobOpacity: 0.65,
    scrimTop: 0.25,
    scrimBottom: 0.45,
    travelScale: 1.25,
  },
  balanced: {
    name: "balanced",
    blobCount: 4,
    duration: 40,
    blobOpacity: 0.52,
    scrimTop: 0.26,
    scrimBottom: 0.46,
    travelScale: 1.0,
  },
};

/**
 * Automatically chooses a preset from cluster statistics (PRD §4.3).
 */
export function selectPreset(clusters: ColorCluster[]): PresetName {
  if (clusters.length === 0) {
    return "balanced";
  }

  const avgSaturation = clusters.reduce((acc, c) => acc + c.hsl.s, 0) / clusters.length;
  const avgLightness = clusters.reduce((acc, c) => acc + c.hsl.l, 0) / clusters.length;

  // Compute maximum hue spread across clusters with reasonable saturation (> 0.15)
  const coloredClusters = clusters.filter((c) => c.hsl.s > 0.15);
  let maxHueSpread = 0;
  for (let i = 0; i < coloredClusters.length; i++) {
    for (let j = i + 1; j < coloredClusters.length; j++) {
      const spread = hueDistance(coloredClusters[i].hsl.h, coloredClusters[j].hsl.h);
      if (spread > maxHueSpread) {
        maxHueSpread = spread;
      }
    }
  }

  // 1. Low saturation overall (< 0.2) -> calm
  if (avgSaturation < 0.2) {
    return "calm";
  }

  // 2. Bright or pastel cover (avg lightness > 0.6) -> dim
  if (avgLightness > 0.6) {
    return "dim";
  }

  // 3. High saturation & multiple hues (hue spread > 90) -> flow
  if (avgSaturation > 0.45 && maxHueSpread > 90) {
    return "flow";
  }

  // 4. Default -> balanced
  return "balanced";
}
