import { describe, expect, it } from "vitest";
import {
  createLocalStorageRecentStore,
  createMemoryRecentStore,
} from "./recent-store";

describe("recent project store", () => {
  it("remembers paths with most-recent first and dedupes", () => {
    const store = createMemoryRecentStore();
    store.remember("/a");
    store.remember("/b");
    store.remember("/a");
    expect(store.list()).toEqual(["/a", "/b"]);
    expect(store.current()).toBe("/a");
  });

  it("persists through a Storage backend", () => {
    const memory = new Map<string, string>();
    const storage = {
      getItem: (k: string) => memory.get(k) ?? null,
      setItem: (k: string, v: string) => {
        memory.set(k, v);
      },
      removeItem: (k: string) => {
        memory.delete(k);
      },
      clear: () => memory.clear(),
      key: () => null,
      get length() {
        return memory.size;
      },
    } as Storage;

    const a = createLocalStorageRecentStore(storage);
    a.remember("/proj");
    const b = createLocalStorageRecentStore(storage);
    expect(b.current()).toBe("/proj");
  });
});
