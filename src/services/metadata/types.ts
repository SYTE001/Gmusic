export type ParsedTags = {
  title?: string;
  artist?: string;
  album?: string;
  trackNumber?: number;
  albumTrackCount?: number;
  artwork?: Blob;
};

export function parseTrackPair(value: string | undefined): { trackNumber?: number; albumTrackCount?: number } {
  if (!value) return {};
  const match = value.trim().match(/^(\d+)\s*(?:\/\s*(\d+))?$/);
  if (!match) {
    const bare = Number.parseInt(value.trim(), 10);
    return Number.isFinite(bare) && bare > 0 ? { trackNumber: bare } : {};
  }
  const trackNumber = Number.parseInt(match[1], 10);
  const albumTrackCount = match[2] ? Number.parseInt(match[2], 10) : undefined;
  return {
    trackNumber: Number.isFinite(trackNumber) && trackNumber > 0 ? trackNumber : undefined,
    albumTrackCount: albumTrackCount !== undefined && Number.isFinite(albumTrackCount) && albumTrackCount > 0 ? albumTrackCount : undefined,
  };
}

export function cleanTagText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const cleaned = value.replace(/\0+$/g, "").trim();
  return cleaned.length > 0 ? cleaned : undefined;
}
