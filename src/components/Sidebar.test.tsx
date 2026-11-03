import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { SidebarContent } from "./Sidebar";
import { useLibraryStore } from "../stores/libraryStore";
import { repository } from "../services/indexeddb/LibraryRepository";
import type { Playlist, Track } from "../types";

function seedLibrary(): { track: Track; otherTrack: Track; playlist: Playlist } {
  const track: Track = {
    id: "t1",
    title: "Sidebar Song",
    artist: "Tester",
    album: "",
    trackNumber: null,
    albumTrackCount: null,
    durationMs: 120000,
    fileName: "t1.mp3",
    fileSize: 10,
    mimeType: "audio/mpeg",
    addedAt: Date.now(),
    lastPlayedAt: null,
    playCount: 0,
    isLiked: true,
    availability: "available",
    accessMode: "stored-copy",
    fingerprint: null,
    metadataFromFilename: false,
  };
  const otherTrack: Track = { ...track, id: "t2", title: "Other Song", isLiked: true };
  const playlist: Playlist = {
    id: "p1",
    name: "Road Trip",
    description: "",
    trackIds: [track.id],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  useLibraryStore.setState({
    tracks: [track, otherTrack],
    playlists: [playlist],
    status: "ready",
    loadError: null,
  });
  return { track, otherTrack, playlist };
}

function renderSidebar(props: Parameters<typeof SidebarContent>[0] = {}) {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <SidebarContent {...props} />
    </MemoryRouter>,
  );
}

describe("Sidebar (redesign layout)", () => {
  beforeEach(async () => {
    // Artwork thumbnails may fall through to the online lookup; keep tests
    // offline and deterministic (rules §11: no network in tests).
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network disabled for tests")));
    await repository.clearAllData();
    seedLibrary();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders primary nav, create/liked rows, and playlists in the expanded layout", () => {
    renderSidebar();

    // Primary navigation rows (reference 3).
    expect(screen.getByRole("link", { name: "Home" }).getAttribute("href")).toBe("/");
    expect(screen.getByRole("link", { name: "Your Library" }).getAttribute("href")).toBe("/library");
    expect(screen.getByRole("button", { name: "Search" })).toBeTruthy();

    // Playlists section: create action, liked shortcut with count, user playlists.
    expect(screen.getByRole("button", { name: /Create Playlist/i })).toBeTruthy();
    const liked = screen.getByRole("link", { name: /Liked Songs/i });
    expect(liked.getAttribute("href")).toBe("/liked");
    expect(within(liked).getByText("2")).toBeTruthy(); // both seeded tracks are liked
    expect(screen.getByRole("link", { name: "Road Trip" }).getAttribute("href")).toBe("/playlist/p1");
  });

  it("focuses the visible search field when the Search row is activated", () => {
    renderSidebar();
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    const input = document.querySelector<HTMLInputElement>("input[type='search']");
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
  });

  it("expands the rail when the collapsed Search icon is activated", () => {
    const onExpand = vi.fn();
    renderSidebar({ collapsed: true, onExpand });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(onExpand).toHaveBeenCalledTimes(1);
  });

  it("keeps every collapsed control labeled with a tooltip", () => {
    renderSidebar({ collapsed: true });

    // Icon rail keeps accessible names and native tooltips (reference 2).
    for (const label of ["Home", "Your Library", "Liked Songs", "Road Trip"]) {
      const control = screen.getByRole("link", { name: label });
      expect(control.getAttribute("title")).toBe(label);
    }
    const create = screen.getByRole("button", { name: "Create playlist" });
    expect(create.getAttribute("title")).toBe("Create playlist");
    const search = screen.getByRole("button", { name: "Search" });
    expect(search.getAttribute("title")).toBe("Search ( / )");
  });

  it("does not render row labels in the collapsed rail", () => {
    renderSidebar({ collapsed: true });
    // Collapsed mode renders icons only: nav text is omitted and playlist
    // names stay exposed through aria-label/title instead of visible text.
    expect(screen.queryByText("Your Library")).toBeNull();
    expect(screen.queryByText("Create Playlist")).toBeNull();
    const playlistLink = screen.getByRole("link", { name: "Road Trip" });
    expect(playlistLink.textContent ?? "").not.toContain("Road Trip");
  });

  it("shows a hint when there are no playlists", async () => {
    useLibraryStore.setState({ playlists: [] });
    renderSidebar();
    expect(screen.getByText(/Playlists you create appear here/i)).toBeTruthy();
  });
});
