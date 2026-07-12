/**
 * Persist the current / recent Project paths for reopen.
 */

import type { RecentProjectStore } from "./host";

const DEFAULT_KEY = "grok-gui.recent-projects";
const MAX_RECENT = 8;

export function createMemoryRecentStore(
  initial: string[] = [],
): RecentProjectStore {
  let items = [...initial];
  return {
    list: () => [...items],
    remember(path: string) {
      const normalized = path.trim();
      if (!normalized) return;
      items = [
        normalized,
        ...items.filter((p) => p !== normalized),
      ].slice(0, MAX_RECENT);
    },
    clear: () => {
      items = [];
    },
    current: () => items[0] ?? null,
    prune(keep: (path: string) => boolean) {
      items = items.filter(keep);
    },
  };
}

export function createLocalStorageRecentStore(
  storage: Storage | null | undefined = typeof localStorage !== "undefined"
    ? localStorage
    : null,
  key = DEFAULT_KEY,
): RecentProjectStore {
  const memory = createMemoryRecentStore(load(storage, key));

  return {
    list: () => memory.list(),
    remember(path: string) {
      memory.remember(path);
      save(storage, key, memory.list());
    },
    clear() {
      memory.clear();
      save(storage, key, []);
    },
    current: () => memory.current(),
    prune(keep: (path: string) => boolean) {
      memory.prune?.(keep);
      save(storage, key, memory.list());
    },
  };
}

function load(storage: Storage | null | undefined, key: string): string[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

function save(
  storage: Storage | null | undefined,
  key: string,
  items: string[],
): void {
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify(items));
  } catch {
    /* quota / private mode — ignore */
  }
}
