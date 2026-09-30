import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    // @x402/next's ESM build imports bare "next/server", which resolves through Next's export map
    // in the app but not under vitest's node resolver.
    // "server-only" is not installed: Next handles the import during the build, and under vitest it
    // resolves to an empty module.
    alias: [
      { find: /^next\/server$/, replacement: "next/server.js" },
      { find: /^server-only$/, replacement: fileURLToPath(new URL("./tests/stubs/server-only.ts", import.meta.url)) },
    ],
  },
  test: {
    environment: "node",
    // The alias above only applies to code vitest transforms, and this import lives inside the
    // dependency, so the dependency has to be processed rather than handed to Node as-is.
    server: { deps: { inline: ["@x402/next"] } },
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    globals: false,
  },
});
