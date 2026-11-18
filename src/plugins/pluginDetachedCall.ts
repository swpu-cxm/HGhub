import { pluginCommand } from "./client";

/** Survives React view unmount; only explicit cancelAllDetachedPluginCalls aborts. */
const detachedPending = new Set<string>();

export async function detachedPluginCall<T>(params: {
  id: string;
  method: string;
  args: Record<string, unknown>;
}): Promise<T> {
  const requestId = crypto.randomUUID();
  detachedPending.add(requestId);
  try {
    return await pluginCommand<T>("call", { ...params, requestId });
  } finally {
    detachedPending.delete(requestId);
  }
}

export function cancelAllDetachedPluginCalls(): void {
  for (const requestId of detachedPending) {
    void pluginCommand("cancel", { requestId }).catch(() => {});
    detachedPending.delete(requestId);
  }
}

export function detachedPendingCount(): number {
  return detachedPending.size;
}