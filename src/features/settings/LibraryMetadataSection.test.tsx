import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { LibraryMetadataSection } from "./LibraryMetadataSection";
import { useLibraryStore } from "../../stores/libraryStore";
import { useCloudStore } from "../../stores/cloudStore";
import { repository } from "../../services/indexeddb/LibraryRepository";
import type { Track } from "../../types";

const authState = vi.hoisted(() => ({
  status: "anonymous" as "anonymous" | "authenticated",
  user: null as unknown,
}));

vi.mock("../../services/cloud/cloudAuthService", () => ({
  cloudConfigured: () => true,
  workerConfigured: () => true,
  workerUrl: () => "https://worker.example",
  getAccessToken: async () => (authState.status === "authenticated" ? "test-token" : null),
  snapshotAuth: (session: unknown) => ({
    status: session ? "authenticated" : "anonymous",
    user: session ? { email: "user@example.com" } : null,
    session,
  }),
  currentAuthState: async () => authState,
  signInWithEmail: async () => undefined,
  signUpWithEmail: async () => undefined,
  signOutCloud: async () => undefined,
  subscribeToAuthChanges: () => () => undefined,
}));

const mockSyncTrackMetadata = vi.fn();
const mockRetryPending = vi.fn();

vi.mock("../../services/cloud/cloudMetadataSyncService", () => ({
  syncTrackMetadata: async (track: Track) => {
    try {
      await mockSyncTrackMetadata(track);
    } catch (e) {
      await repository.putPendingMetadataSync({
        trackId: track.id,
        title: track.title,
        description: track.description ?? "",
        queuedAt: Date.now(),
        lastError: e instanceof Error ? e.message : "Sync error",
      });
      throw e;
    }
  },
  retryPendingMetadataSync: () => mockRetryPending(),
}));

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: `track-${Math.random().toString(36).slice(2, 7)}`,
    title: "Bohemian Rhapsody",
    artist: "Queen",
    album: "A Night at the Opera",
    trackNumber: 4,
    albumTrackCount: 12,
    durationMs: 354000,
    fileName: "queen_bohemian.mp3",
    fileSize: 8400000,
    mimeType: "audio/mpeg",
    addedAt: 1000,
    lastPlayedAt: null,
    playCount: 0,
    isLiked: false,
    availability: "available",
    accessMode: "stored-copy",
    fingerprint: "fp-rhapsody",
    metadataFromFilename: false,
    description: "Classic rock masterpiece",
    updatedAt: 1000,
    cloudStatus: "local",
    ...overrides,
  };
}

describe("LibraryMetadataSection", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    authState.status = "anonymous";
    authState.user = null;
    mockSyncTrackMetadata.mockResolvedValue(undefined);
    mockRetryPending.mockResolvedValue({ cleared: 1, remaining: 0 });
    await repository.clearAllData();
    useLibraryStore.setState({ tracks: [] });
    useCloudStore.setState({ status: "anonymous", syncStatus: "idle" });
  });

  it("renders the dedicated section header and description", () => {
    render(<LibraryMetadataSection />);
    expect(screen.getByRole("region", { name: "Library Metadata" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Library Metadata" })).toBeTruthy();
  });

  it("handles empty library state gracefully", () => {
    render(<LibraryMetadataSection />);
    expect(screen.getByText("Your library is empty")).toBeTruthy();
    expect(screen.getByText(/Import audio files to view and edit track metadata/)).toBeTruthy();
  });

  it("displays all tracks in the library with their metadata and local save badge", () => {
    const track1 = makeTrack({ id: "t1", title: "Track One", artist: "Artist One" });
    const track2 = makeTrack({ id: "t2", title: "Track Two", artist: "Artist Two", description: "Personal favorite" });
    useLibraryStore.setState({ tracks: [track1, track2] });

    render(<LibraryMetadataSection />);

    expect(screen.getByText("Track One")).toBeTruthy();
    expect(screen.getByText("Track Two")).toBeTruthy();
    expect(screen.getByText(/Personal favorite/)).toBeTruthy();
    expect(screen.getAllByText("Local")).toHaveLength(2);
  });

  it("provides search to find tracks by title case-insensitively", () => {
    const track1 = makeTrack({ id: "t1", title: "Stairway to Heaven" });
    const track2 = makeTrack({ id: "t2", title: "Hotel California" });
    useLibraryStore.setState({ tracks: [track1, track2] });

    render(<LibraryMetadataSection />);

    const searchInput = screen.getByLabelText("Search tracks by title");
    fireEvent.change(searchInput, { target: { value: "stairway" } });

    expect(screen.getByText("Stairway to Heaven")).toBeTruthy();
    expect(screen.queryByText("Hotel California")).toBeNull();

    // Search with no results
    fireEvent.change(searchInput, { target: { value: "nonexistent" } });
    expect(screen.getByText("No tracks found")).toBeTruthy();
    expect(screen.getByText(/No track titles match “nonexistent”/)).toBeTruthy();
  });

  it("allows editing Track Title and Description, saving using stable ID", async () => {
    const track = makeTrack({ id: "stable-123", title: "Original Song", description: "Old Note", fileName: "original.mp3" });
    await repository.putTracks([track]);
    useLibraryStore.setState({ tracks: [track] });

    render(<LibraryMetadataSection />);

    // Click Edit button
    const editBtn = screen.getByLabelText("Edit metadata for Original Song");
    fireEvent.click(editBtn);

    // Verify stable ID is displayed and filename is presented as read-only / untouched
    expect(screen.getByText("stable-123")).toBeTruthy();
    expect(screen.getByText(/original\.mp3/)).toBeTruthy();
    expect(screen.getByText(/\(untouched\)/)).toBeTruthy();

    // Inputs are visible
    const titleInput = screen.getByLabelText(/Track Title/);
    const descInput = screen.getByLabelText(/Description \/ Notes/);

    expect((titleInput as HTMLInputElement).value).toBe("Original Song");
    expect((descInput as HTMLTextAreaElement).value).toBe("Old Note");

    // Modify fields
    fireEvent.change(titleInput, { target: { value: "New Masterpiece" } });
    fireEvent.change(descInput, { target: { value: "Updated Notes for testing" } });

    // Submit
    const saveBtn = screen.getByRole("button", { name: "Save changes" });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(screen.getByText(/Saved to this device/)).toBeTruthy();
    });

    // Verify stored track in IndexedDB and Zustand store
    const stored = await repository.getTrack("stable-123");
    expect(stored?.title).toBe("New Masterpiece");
    expect(stored?.description).toBe("Updated Notes for testing");
    // Original filename was never touched
    expect(stored?.fileName).toBe("original.mp3");

    const inStore = useLibraryStore.getState().tracks.find((t) => t.id === "stable-123");
    expect(inStore?.title).toBe("New Masterpiece");
    expect(inStore?.description).toBe("Updated Notes for testing");
  });

  it("cancels editing without saving changes", () => {
    const track = makeTrack({ id: "t-cancel", title: "Unchanged Song" });
    useLibraryStore.setState({ tracks: [track] });

    render(<LibraryMetadataSection />);

    fireEvent.click(screen.getByLabelText("Edit metadata for Unchanged Song"));

    const titleInput = screen.getByLabelText(/Track Title/);
    fireEvent.change(titleInput, { target: { value: "Discarded Change" } });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    // Editor is closed, original title persists
    expect(screen.getByText("Unchanged Song")).toBeTruthy();
    expect(screen.queryByLabelText(/Track Title/)).toBeNull();
  });

  it("shows synced status when cloud synchronization succeeds", async () => {
    authState.status = "authenticated";
    authState.user = { email: "user@example.com" };
    useCloudStore.setState({ status: "authenticated", user: { email: "user@example.com" } as never });
    mockSyncTrackMetadata.mockResolvedValueOnce(undefined);

    const track = makeTrack({ id: "t-cloud-sync", title: "Cloud Song" });
    await repository.putTracks([track]);
    useLibraryStore.setState({ tracks: [track] });

    render(<LibraryMetadataSection />);

    fireEvent.click(screen.getByLabelText("Edit metadata for Cloud Song"));
    const titleInput = screen.getByLabelText(/Track Title/);
    fireEvent.change(titleInput, { target: { value: "Synced Cloud Song" } });

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(screen.getByText("Saved locally and synced with cloud.")).toBeTruthy();
    });

    expect(mockSyncTrackMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ id: "t-cloud-sync", title: "Synced Cloud Song" }),
    );
  });

  it("handles cloud synchronization failure by retaining local changes and queueing for retry", async () => {
    authState.status = "authenticated";
    authState.user = { email: "user@example.com" };
    useCloudStore.setState({ status: "authenticated", user: { email: "user@example.com" } as never });
    mockSyncTrackMetadata.mockRejectedValueOnce(new Error("Supabase network error"));

    const track = makeTrack({ id: "t-fail", title: "Network Failing Track" });
    await repository.putTracks([track]);
    useLibraryStore.setState({ tracks: [track] });

    render(<LibraryMetadataSection />);

    fireEvent.click(screen.getByLabelText("Edit metadata for Network Failing Track"));
    const titleInput = screen.getByLabelText(/Track Title/);
    fireEvent.change(titleInput, { target: { value: "Locally Saved Track" } });

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(screen.getByText(/Saved locally\. Cloud sync failed and is queued for retry/)).toBeTruthy();
    });

    // Local changes are retained
    const local = await repository.getTrack("t-fail");
    expect(local?.title).toBe("Locally Saved Track");

    // Queued retry buttons are rendered (in banner and in editor card)
    expect(screen.getAllByRole("button", { name: /Retry sync/ }).length).toBeGreaterThanOrEqual(1);
  });

  it("displays pending banner and allows retrying all queued metadata changes", async () => {
    await repository.putPendingMetadataSync({
      trackId: "t-queued",
      title: "Queued Track",
      description: "Note",
      queuedAt: Date.now(),
      lastError: "Offline",
    });

    const track = makeTrack({ id: "t-queued", title: "Queued Track" });
    await repository.putTracks([track]);
    useLibraryStore.setState({ tracks: [track] });

    render(<LibraryMetadataSection />);

    await waitFor(() => {
      expect(screen.getByText(/1 track has metadata edits queued for cloud sync/)).toBeTruthy();
    });

    const retryAllBtn = screen.getByRole("button", { name: "Retry sync" });
    fireEvent.click(retryAllBtn);

    await waitFor(() => {
      expect(mockRetryPending).toHaveBeenCalled();
    });
  });
});
