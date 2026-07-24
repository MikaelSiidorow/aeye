import type { ServerInit } from "@sveltejs/kit";

import { getLiveIndex, type LiveIndex } from "$lib/server/live-index";

type GlobalWithShutdown = typeof globalThis & {
  __aeyeShutdownRegistered?: boolean;
};

function registerShutdown(liveIndex: LiveIndex) {
  const globalWithShutdown = globalThis as GlobalWithShutdown;
  if (globalWithShutdown.__aeyeShutdownRegistered) return;
  globalWithShutdown.__aeyeShutdownRegistered = true;

  const close = () => {
    void liveIndex.close().catch((error: unknown) => {
      console.error("Failed to close the Aeye live index", error);
    });
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

export const init: ServerInit = async () => {
  const liveIndex = getLiveIndex();
  registerShutdown(liveIndex);
  await liveIndex.ready;
};
