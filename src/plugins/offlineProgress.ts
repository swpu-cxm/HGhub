const KEY = "hpp.offlinePlaybackProgress";

export type OfflinePlaybackProgress = {
  positionSec: number;
  durationSec?: number;
  updatedAt: number;
};

type Store = Record<string, OfflinePlaybackProgress>;

function readStore(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Store) : {};
  } catch {
    return {};
  }
}

export function getOfflineProgress(downloadId: string): OfflinePlaybackProgress | null {
  return readStore()[downloadId] ?? null;
}

export function setOfflineProgress(downloadId: string, positionSec: number, durationSec?: number) {
  if (!Number.isFinite(positionSec) || positionSec < 0) return;
  const store = readStore();
  store[downloadId] = {
    positionSec,
    durationSec: durationSec && Number.isFinite(durationSec) ? durationSec : store[downloadId]?.durationSec,
    updatedAt: Date.now(),
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch { /* quota */ }
}