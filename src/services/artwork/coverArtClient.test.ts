import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildReleaseFrontUrl,
  buildReleaseGroupFrontUrl,
  fetchReleaseCoverArt,
  fetchReleaseGroupCoverArt,
  isValidArtworkUrl,
  sanitizeArtworkUrl,
} from "./coverArtClient";

const VALID_RG_MBID = "11111111-2222-3333-4444-555555555555";
const VALID_REL_MBID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

describe("coverArtClient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("never constructs CAA URLs from untrusted or invalid MBIDs", () => {
    expect(buildReleaseGroupFrontUrl("not-a-uuid", "500")).toBeNull();
    expect(buildReleaseFrontUrl("../../etc/passwd", "500")).toBeNull();
    expect(buildReleaseGroupFrontUrl(VALID_RG_MBID, "500")).toBe(
      `https://coverartarchive.org/release-group/${VALID_RG_MBID}/front-500`,
    );
    expect(buildReleaseGroupFrontUrl(VALID_RG_MBID, "1200")).toBe(
      `https://coverartarchive.org/release-group/${VALID_RG_MBID}/front-1200`,
    );
    expect(buildReleaseFrontUrl(VALID_REL_MBID, "500")).toBe(
      `https://coverartarchive.org/release/${VALID_REL_MBID}/front-500`,
    );
  });

  it("validates artwork URLs and upgrades http:// CAA thumbnails to https://", () => {
    expect(isValidArtworkUrl("https://coverartarchive.org/release-group/11111111-2222-3333-4444-555555555555/front-500")).toBe(true);
    expect(isValidArtworkUrl("http://coverartarchive.org/release/aaa/123-500.jpg")).toBe(true);
    expect(isValidArtworkUrl("https://ia800500.us.archive.org/12/items/mbid-123/mbid-123-500.jpg")).toBe(true);
    expect(isValidArtworkUrl("javascript:alert(1)")).toBe(false);
    expect(isValidArtworkUrl("https://evil.example.com/cover.jpg")).toBe(false);

    expect(sanitizeArtworkUrl("http://coverartarchive.org/release/aaa/123-500.jpg")).toBe(
      "https://coverartarchive.org/release/aaa/123-500.jpg",
    );
  });

  it("prefers Front 500px thumbnail from CAA release-group metadata and extracts release MBID", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        release: `https://musicbrainz.org/ws/2/release/${VALID_REL_MBID}`,
        images: [
          {
            front: false,
            back: true,
            thumbnails: {
              "500": "http://coverartarchive.org/release/back-500.jpg",
            },
          },
          {
            front: true,
            thumbnails: {
              "250": "http://coverartarchive.org/release/front-250.jpg",
              "500": "http://coverartarchive.org/release/front-500.jpg",
              "1200": "http://coverartarchive.org/release/front-1200.jpg",
            },
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const res500 = await fetchReleaseGroupCoverArt(VALID_RG_MBID);
    expect(res500.status).toBe("ok");
    expect(res500.url).toBe("https://coverartarchive.org/release/front-500.jpg");
    expect(res500.releaseGroupMbid).toBe(VALID_RG_MBID);
    expect(res500.releaseMbid).toBe(VALID_REL_MBID);

    const res1200 = await fetchReleaseGroupCoverArt(VALID_RG_MBID, { size: "1200" });
    expect(res1200.status).toBe("ok");
    expect(res1200.url).toBe("https://coverartarchive.org/release/front-1200.jpg");
  });

  it("handles 404, 429, and 503 responses gracefully without throwing", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({ ok: false, status: 429 })
      .mockResolvedValueOnce({ ok: false, status: 503 });
    vi.stubGlobal("fetch", fetchMock);

    const r404 = await fetchReleaseGroupCoverArt(VALID_RG_MBID);
    expect(r404.status).toBe("not-found");
    expect(r404.url).toBeNull();

    const r429 = await fetchReleaseCoverArt(VALID_REL_MBID);
    expect(r429.status).toBe("transient-error");
    expect(r429.url).toBeNull();

    const r503 = await fetchReleaseCoverArt(VALID_REL_MBID);
    expect(r503.status).toBe("transient-error");
    expect(r503.url).toBeNull();
  });
});
