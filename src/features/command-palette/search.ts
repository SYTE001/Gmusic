import { normalizeForSearch } from "../../utils/misc";
import type { Playlist, Track } from "../../types";
import type { CommandDefinition } from "./commands";

export type MatchTier = 1 | 2 | 3 | 4;

export type RankedResult<T> = {
  item: T;
  tier: MatchTier;
  score: number;
};

/**
 * Computes match tier (1 = exact, 2 = prefix, 3 = token prefix/exact, 4 = substring)
 * and secondary score for deterministic ordering. Returns null when there is no match.
 */
export function matchQueryAgainstFields(
  normalizedQuery: string,
  primaryField: string,
  secondaryFields: string[] = [],
): { tier: MatchTier; score: number } | null {
  if (!normalizedQuery) return { tier: 4, score: 0 };

  const normPrimary = normalizeForSearch(primaryField);
  const normSecondary = secondaryFields.map(normalizeForSearch).filter(Boolean);
  const queryTokens = normalizedQuery.split(" ").filter(Boolean);

  // 1. Exact title/name match
  if (normPrimary === normalizedQuery) {
    return { tier: 1, score: 100 };
  }

  // 2. Prefix match on primary field
  if (normPrimary.startsWith(normalizedQuery)) {
    return { tier: 2, score: 90 - Math.min(20, normPrimary.length - normalizedQuery.length) };
  }

  // Check secondary exact or prefix matches as high-priority token/prefix tier
  for (const sec of normSecondary) {
    if (sec === normalizedQuery) {
      return { tier: 2, score: 70 };
    }
    if (sec.startsWith(normalizedQuery)) {
      return { tier: 3, score: 65 };
    }
  }

  const allText = [normPrimary, ...normSecondary].join(" ");
  const allTokens = allText.split(/[\s\-_./]+/).filter(Boolean);
  const primaryTokens = normPrimary.split(/[\s\-_./]+/).filter(Boolean);

  // 3. Token match on title, artist, album, playlist name, or keywords
  // All query tokens must match at least a token prefix in combined fields
  const everyTokenMatchesBoundary =
    queryTokens.length > 0 &&
    queryTokens.every((qt) => allTokens.some((tok) => tok === qt || tok.startsWith(qt)));

  if (everyTokenMatchesBoundary) {
    const inPrimary = queryTokens.every((qt) => primaryTokens.some((tok) => tok === qt || tok.startsWith(qt)));
    return { tier: 3, score: inPrimary ? 60 : 50 };
  }

  // 4. Substring match
  if (normPrimary.includes(normalizedQuery)) {
    return { tier: 4, score: 40 };
  }
  for (const sec of normSecondary) {
    if (sec.includes(normalizedQuery)) {
      return { tier: 4, score: 30 };
    }
  }
  // Multi-word substring across fields (every token is a substring somewhere in allText)
  if (queryTokens.length > 1 && queryTokens.every((qt) => allText.includes(qt))) {
    return { tier: 4, score: 20 };
  }

  return null;
}

export const MAX_TRACK_RESULTS = 8;
export const MAX_PLAYLIST_RESULTS = 5;

export function searchTracks(tracks: Track[], query: string, limit = MAX_TRACK_RESULTS): Track[] {
  const normalized = normalizeForSearch(query);
  if (!normalized) {
    return tracks.slice(0, limit);
  }

  const matches: RankedResult<Track>[] = [];
  for (const track of tracks) {
    const match = matchQueryAgainstFields(normalized, track.title, [
      track.artist,
      track.album,
      track.fileName,
    ]);
    if (match) {
      matches.push({ item: track, tier: match.tier, score: match.score });
    }
  }

  matches.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (b.score !== a.score) return b.score - a.score;
    return a.item.title.localeCompare(b.item.title);
  });

  return matches.slice(0, limit).map((m) => m.item);
}

export function searchPlaylists(playlists: Playlist[], query: string, limit = MAX_PLAYLIST_RESULTS): Playlist[] {
  const normalized = normalizeForSearch(query);
  if (!normalized) {
    return playlists.slice(0, limit);
  }

  const matches: RankedResult<Playlist>[] = [];
  for (const playlist of playlists) {
    const match = matchQueryAgainstFields(normalized, playlist.name, []);
    if (match) {
      matches.push({ item: playlist, tier: match.tier, score: match.score });
    }
  }

  matches.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (b.score !== a.score) return b.score - a.score;
    return a.item.name.localeCompare(b.item.name);
  });

  return matches.slice(0, limit).map((m) => m.item);
}

export function searchCommands(commands: CommandDefinition[], query: string): CommandDefinition[] {
  const normalized = normalizeForSearch(query);
  if (!normalized) {
    return commands;
  }

  const matches: RankedResult<CommandDefinition>[] = [];
  for (const cmd of commands) {
    const match = matchQueryAgainstFields(normalized, cmd.label, [cmd.category, ...cmd.keywords]);
    if (match) {
      matches.push({ item: cmd, tier: match.tier, score: match.score });
    }
  }

  matches.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (b.score !== a.score) return b.score - a.score;
    return a.item.label.localeCompare(b.item.label);
  });

  return matches.map((m) => m.item);
}
