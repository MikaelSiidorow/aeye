import { cpSync, rmSync } from "node:fs";

import adapter from "@sveltejs/adapter-node";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig, type Plugin } from "vite";

function copyMigrations(): Plugin {
  const source = new URL("./drizzle/", import.meta.url);
  const target = new URL("./build/drizzle/", import.meta.url);
  return {
    name: "aeye-copy-migrations",
    closeBundle() {
      rmSync(target, { recursive: true, force: true });
      cpSync(source, target, { recursive: true });
    },
  };
}

export default defineConfig({
  plugins: [
    sveltekit({
      experimental: {
        remoteFunctions: true,
      },
      compilerOptions: {
        experimental: {
          async: true,
        },
        runes: ({ filename }) =>
          filename.split(/[/\\]/).includes("node_modules") ? undefined : true,
      },
      adapter: adapter(),
    }),
    copyMigrations(),
  ],
});
