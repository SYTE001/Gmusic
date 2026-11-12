import { beforeEach, describe, expect, it } from "vitest";
import { THEME_CACHE_KEY, useSettingsStore, DEFAULT_PREFERENCES } from "./settingsStore";
import { repository } from "../services/indexeddb/LibraryRepository";
import type { AppPreferences } from "../types";

describe("settings theme application", () => {
  beforeEach(async () => {
    localStorage.clear();
    await repository.clearAllData();
    useSettingsStore.setState({ prefs: DEFAULT_PREFERENCES, loaded: false });
  });

  it("applies an explicit theme to the document and caches it for the pre-paint script", () => {
    const { update } = useSettingsStore.getState();
    update({ theme: "light" });
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem(THEME_CACHE_KEY)).toBe("light");

    update({ theme: "dark" });
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem(THEME_CACHE_KEY)).toBe("dark");
  });

  it("resolves system mode from the prefers-color-scheme media query", () => {
    // The test setup's matchMedia reports matches:false (prefers dark).
    useSettingsStore.getState().update({ theme: "system" });
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem(THEME_CACHE_KEY)).toBe("system");
  });

  it("reloads stored preferences on init", async () => {
    const stored: AppPreferences = { ...DEFAULT_PREFERENCES, theme: "light", volume: 0.42 };
    await repository.putPreferences(stored);

    await useSettingsStore.getState().init();

    const { prefs, resolvedTheme } = useSettingsStore.getState();
    expect(prefs.theme).toBe("light");
    expect(prefs.volume).toBe(0.42);
    expect(resolvedTheme).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("falls back to defaults when no preferences are stored", async () => {
    await useSettingsStore.getState().init();
    expect(useSettingsStore.getState().prefs).toEqual(DEFAULT_PREFERENCES);
    expect(useSettingsStore.getState().prefs.miniPlayerMode).toBe("auto");
    expect(useSettingsStore.getState().loaded).toBe(true);
  });

  it("hydrates legacy stored preferences without miniPlayerMode using default auto", async () => {
    const legacy = { ...DEFAULT_PREFERENCES } as Partial<AppPreferences>;
    delete legacy.miniPlayerMode;
    await repository.putPreferences(legacy as AppPreferences);

    await useSettingsStore.getState().init();
    expect(useSettingsStore.getState().prefs.miniPlayerMode).toBe("auto");
  });

  it("updates and persists miniPlayerMode", async () => {
    useSettingsStore.getState().update({ miniPlayerMode: "compact" });
    expect(useSettingsStore.getState().prefs.miniPlayerMode).toBe("compact");
  });
});
