import type { ServerInit } from "@sveltejs/kit";

import { getLiveIndex } from "$lib/server/live-index";

export const init: ServerInit = async () => {
  await getLiveIndex().ready;
};
