import { describe, expect, it } from "vitest";
import {
  appendToQueue,
  clearUpcoming,
  insertNext,
  moveQueueItem,
  nextIndex,
  previousIndex,
  removeQueueAt,
  shuffleArray,
  shuffledQueue,
} from "./queue";

describe("nextIndex", () => {
  it("advances within the queue", () => {
    expect(nextIndex({ queueTrackIds: ["a", "b", "c"], queueIndex: 0, repeatMode: "off" })).toBe(1);
  });

  it("wraps at the end only with repeat all", () => {
    expect(nextIndex({ queueTrackIds: ["a", "b"], queueIndex: 1, repeatMode: "off" })).toBeNull();
    expect(nextIndex({ queueTrackIds: ["a", "b"], queueIndex: 1, repeatMode: "one" })).toBeNull();
    expect(nextIndex({ queueTrackIds: ["a", "b"], queueIndex: 1, repeatMode: "all" })).toBe(0);
  });

  it("returns null for an empty queue", () => {
    expect(nextIndex({ queueTrackIds: [], queueIndex: -1, repeatMode: "all" })).toBeNull();
  });
});

describe("previousIndex", () => {
  it("goes back within the queue", () => {
    expect(previousIndex({ queueTrackIds: ["a", "b", "c"], queueIndex: 2, repeatMode: "off" })).toBe(1);
  });

  it("wraps to the last track with repeat all, clamps to 0 otherwise", () => {
    expect(previousIndex({ queueTrackIds: ["a", "b"], queueIndex: 0, repeatMode: "all" })).toBe(1);
    expect(previousIndex({ queueTrackIds: ["a", "b"], queueIndex: 0, repeatMode: "off" })).toBe(0);
  });
});

describe("shuffle", () => {
  it("keeps every track exactly once", () => {
    const items = Array.from({ length: 50 }, (_, i) => `t${i}`);
    const shuffled = shuffleArray(items);
    expect(shuffled).toHaveLength(50);
    expect(new Set(shuffled).size).toBe(50);
  });

  it("respects the rng deterministically for tests", () => {
    const shuffled = shuffleArray([1, 2, 3, 4, 5], () => 0);
    expect(shuffled).toEqual([2, 3, 4, 5, 1]);
  });

  it("pins the requested first track and keeps the rest", () => {
    const context = ["a", "b", "c", "d", "e"];
    const queue = shuffledQueue(context, "c", () => 0.99);
    expect(queue[0]).toBe("c");
    expect(new Set(queue).size).toBe(5);
  });

  it("handles a first track not present in the context", () => {
    const queue = shuffledQueue(["a", "b"], "z", () => 0.5);
    expect(queue).toHaveLength(2);
    expect(queue).not.toContain("z");
  });
});

describe("queue editing", () => {
  it("inserts the next-play item right after the current one", () => {
    const result = insertNext(["a", "b", "c"], 0, "x");
    expect(result.queueTrackIds).toEqual(["a", "x", "b", "c"]);
    expect(result.queueIndex).toBe(0);
  });

  it("appends to the end", () => {
    expect(appendToQueue(["a", "b"], "c")).toEqual(["a", "b", "c"]);
  });

  it("removing an earlier item shifts the current index down", () => {
    const result = removeQueueAt(["a", "b", "c"], 2, 0);
    expect(result).toEqual({ queueTrackIds: ["b", "c"], queueIndex: 1 });
  });

  it("removing the current item points at the next track", () => {
    const result = removeQueueAt(["a", "b", "c"], 1, 1);
    expect(result).toEqual({ queueTrackIds: ["a", "c"], queueIndex: 1 });
  });

  it("removing the last item while current clamps the index", () => {
    const result = removeQueueAt(["a", "b"], 1, 1);
    expect(result).toEqual({ queueTrackIds: ["a"], queueIndex: 0 });
  });

  it("moving adjusts the current index in every direction", () => {
    expect(moveQueueItem(["a", "b", "c"], 0, 0, 2)).toEqual({ queueTrackIds: ["b", "c", "a"], queueIndex: 2 });
    expect(moveQueueItem(["a", "b", "c"], 2, 2, 0)).toEqual({ queueTrackIds: ["c", "a", "b"], queueIndex: 0 });
    expect(moveQueueItem(["a", "b", "c"], 0, 0, 1)).toEqual({ queueTrackIds: ["b", "a", "c"], queueIndex: 1 });
    // Moving an unrelated item across the current one
    expect(moveQueueItem(["x", "a", "y", "z"], 1, 3, 0).queueIndex).toBe(2);
    // Moving an earlier item past the current one
    expect(moveQueueItem(["x", "a", "y"], 1, 0, 2)).toEqual({ queueTrackIds: ["a", "y", "x"], queueIndex: 0 });
  });

  it("clearUpcoming keeps the played prefix", () => {
    expect(clearUpcoming(["a", "b", "c", "d"], 1)).toEqual(["a", "b"]);
  });
});
