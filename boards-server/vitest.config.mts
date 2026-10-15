import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Standalone on purpose: the root vitest config targets the browser editor
// (jsdom + canvas mocks) and would choke on a Node HTTP server. The suite is
// named `*.integration.ts` so the root `yarn test` never picks it up.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    environment: "node",
    include: ["**/*.integration.ts"],
  },
});
