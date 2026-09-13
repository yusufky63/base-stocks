import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    // @x402/next's ESM build imports bare "next/server", which resolves through Next's export map
    // in the app but not under vitest's node resolver.
    alias: [{ find: /^next\/server$/, replacement: "next/server.js" }],
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
