import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __configureMusicBrainzForTests,
  buildReleaseGroupSearchQuery,
  hasSufficientMetadataForMusicBrainz,
  isValidMbid,
  scoreReleaseCandidate,
  scoreReleaseGroupCandidate,
  searchMusicBrainzReleaseGroups,
  type MusicBrainzReleaseGroup,
} from "./musicbrainzClient";

describe("musicbrainzClient", () => {
  beforeEach(() => {
    __configureMusicBrainzForTests({ rateLimitMs: 0 });
    vi.restoreAllMocks();
  });

  afterEach(() => {
    __configureMusicBrainzForTests();
  });

  it("validates MusicBrainz UUID MBIDs", () => {
    expect(isValidMbid("11111111-2222-3333-4444-555555555555")).toBe(true);
    expect(isValidMbid("A1B2C3D4-E5F6-4711-8899-AABBCCDDEEFF")).toBe(true);
    expect(isValidMbid("invalid-mbid")).toBe(false);
    expect(isValidMbid("")).toBe(false);
    expect(isValidMbid(null)).toBe(false);
  });

  it("skips unnecessary queries when metadata is incomplete or placeholder", () => {
    expect(hasSufficientMetadataForMusicBrainz({ artist: "", album: "Discovery" })).toBe(false);
    expect(hasSufficientMetadataForMusicBrainz({ artist: "Unknown Artist", album: "Discovery" })).toBe(false);
    expect(
      hasSufficientMetadataForMusicBrainz({ artist: "Daft Punk", album: "Unknown Album", title: "Track 1" }),
    ).toBe(false);
    expect(hasSufficientMetadataForMusicBrainz({ artist: "Daft Punk", album: "Discovery" })).toBe(true);
    expect(
      hasSufficientMetadataForMusicBrainz({ artist: "Daft Punk", album: "", title: "One More Time" }),
    ).toBe(true);
  });

  it("builds normalized Lucene release-group search queries", () => {
    const query = buildReleaseGroupSearchQuery({
      artist: "Daft Punk feat. Pharrell Williams",
      album: "Random Access Memories (Deluxe Edition)",
      title: "Get Lucky (Official Audio)",
    });
    expect(query).toBe('artist:"Daft Punk" AND releasegroup:"random access memories"');
  });

  it("scores an exact studio album match as high confidence", () => {
    const candidate: MusicBrainzReleaseGroup = {
      id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      title: "Random Access Memories",
      "primary-type": "Album",
      "artist-credit": [{ name: "Daft Punk", artist: { name: "Daft Punk" } }],
    };

    const scored = scoreReleaseGroupCandidate(candidate, {
      artist: "Daft Punk",
      album: "Random Access Memories",
      title: "Get Lucky",
    });

    expect(scored.tier).toBe("high");
    expect(scored.confidence).toBeGreaterThanOrEqual(90);
  });

  it("rejects incorrect artist or incorrect album matches with low confidence", () => {
    const wrongArtist: MusicBrainzReleaseGroup = {
      id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeee1",
      title: "Random Access Memories",
      "primary-type": "Album",
      "artist-credit": [{ name: "Totally Different Band" }],
    };
    const scoredWrongArtist = scoreReleaseGroupCandidate(wrongArtist, {
      artist: "Daft Punk",
      album: "Random Access Memories",
    });
    expect(scoredWrongArtist.tier).toBe("low");
    expect(scoredWrongArtist.confidence).toBeLessThan(40);

    const wrongAlbum: MusicBrainzReleaseGroup = {
      id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeee2",
      title: "Completely Unrelated Album Title",
      "primary-type": "Album",
      "artist-credit": [{ name: "Daft Punk" }],
    };
    const scoredWrongAlbum = scoreReleaseGroupCandidate(wrongAlbum, {
      artist: "Daft Punk",
      album: "Random Access Memories",
    });
    expect(scoredWrongAlbum.tier).toBe("low");
    expect(scoredWrongAlbum.confidence).toBeLessThan(40);
  });

  it("distinguishes standard, deluxe, live, remix, and compilation editions", () => {
    const standard: MusicBrainzReleaseGroup = {
      id: "11111111-1111-1111-1111-111111111111",
      title: "Discovery",
      "primary-type": "Album",
      "artist-credit": [{ name: "Daft Punk" }],
    };
    const deluxe: MusicBrainzReleaseGroup = {
      id: "22222222-2222-2222-2222-222222222222",
      title: "Discovery (Deluxe Edition)",
      "primary-type": "Album",
      disambiguation: "Deluxe Edition",
      "artist-credit": [{ name: "Daft Punk" }],
    };
    const liveAlbum: MusicBrainzReleaseGroup = {
      id: "33333333-3333-3333-3333-333333333333",
      title: "Discovery (Live)",
      "primary-type": "Album",
      "secondary-types": ["Live"],
      "artist-credit": [{ name: "Daft Punk" }],
    };
    const remixAlbum: MusicBrainzReleaseGroup = {
      id: "44444444-4444-4444-4444-444444444444",
      title: "Discovery Remixes",
      "primary-type": "Album",
      "secondary-types": ["Remix"],
      "artist-credit": [{ name: "Daft Punk" }],
    };

    // For a standard studio album query, standard ranks above deluxe, and live/remix are heavily penalized
    const sStandard = scoreReleaseGroupCandidate(standard, { artist: "Daft Punk", album: "Discovery" });
    const sDeluxe = scoreReleaseGroupCandidate(deluxe, { artist: "Daft Punk", album: "Discovery" });
    const sLive = scoreReleaseGroupCandidate(liveAlbum, { artist: "Daft Punk", album: "Discovery" });
    const sRemix = scoreReleaseGroupCandidate(remixAlbum, { artist: "Daft Punk", album: "Discovery" });

    expect(sStandard.confidence).toBeGreaterThan(sDeluxe.confidence);
    expect(sStandard.confidence).toBeGreaterThan(sLive.confidence + 20);
    expect(sStandard.confidence).toBeGreaterThan(sRemix.confidence + 20);

    // For an explicit Deluxe query, deluxe ranks above standard
    const dStandard = scoreReleaseGroupCandidate(standard, {
      artist: "Daft Punk",
      album: "Discovery (Deluxe Edition)",
    });
    const dDeluxe = scoreReleaseGroupCandidate(deluxe, {
      artist: "Daft Punk",
      album: "Discovery (Deluxe Edition)",
    });
    expect(dDeluxe.confidence).toBeGreaterThan(dStandard.confidence);
  });

  it("matches artist aliases and featured artists", () => {
    const candidate: MusicBrainzReleaseGroup = {
      id: "55555555-5555-5555-5555-555555555555",
      title: "Starboy",
      "primary-type": "Album",
      "artist-credit": [
        {
          name: "The Weeknd",
          artist: {
            name: "The Weeknd",
            aliases: [{ name: "Abel Tesfaye" }],
          },
        },
      ],
    };

    const byFeatured = scoreReleaseGroupCandidate(candidate, {
      artist: "The Weeknd feat. Daft Punk",
      album: "Starboy",
    });
    expect(byFeatured.tier).toBe("high");

    const byAlias = scoreReleaseGroupCandidate(candidate, {
      artist: "Abel Tesfaye",
      album: "Starboy",
    });
    expect(byAlias.tier).toBe("high");
  });

  it("incorporates track title and duration evidence when scoring releases", () => {
    const matchingDurationRelease = scoreReleaseCandidate(
      {
        id: "66666666-6666-6666-6666-666666666666",
        title: "Random Access Memories",
        status: "Official",
        "artist-credit": [{ name: "Daft Punk" }],
        media: [
          {
            tracks: [{ title: "Get Lucky", length: 248000 }],
          },
        ],
      },
      {
        artist: "Daft Punk",
        album: "Random Access Memories",
        title: "Get Lucky",
        durationMs: 248400,
      },
    );

    const mismatchedDurationRelease = scoreReleaseCandidate(
      {
        id: "77777777-7777-7777-7777-777777777777",
        title: "Random Access Memories",
        status: "Official",
        "artist-credit": [{ name: "Daft Punk" }],
        media: [
          {
            tracks: [{ title: "Get Lucky", length: 420000 }],
          },
        ],
      },
      {
        artist: "Daft Punk",
        album: "Random Access Memories",
        title: "Get Lucky",
        durationMs: 248400,
      },
    );

    expect(matchingDurationRelease.confidence).toBeGreaterThan(mismatchedDurationRelease.confidence);
  });

  it("falls back to track title when album metadata is missing", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        "release-groups": [
          {
            id: "88888888-8888-8888-8888-888888888888",
            title: "One More Time",
            "primary-type": "Single",
            "artist-credit": [{ name: "Daft Punk" }],
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await searchMusicBrainzReleaseGroups({
      artist: "Daft Punk",
      album: "",
      title: "One More Time",
    });

    expect(result.status).toBe("ok");
    expect(result.bestCandidate?.mbid).toBe("88888888-8888-8888-8888-888888888888");
    expect(result.bestCandidate?.tier).toBe("high");
  });
});
