import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Matches the "@/*" path in tsconfig.json, so tests can import route handlers.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
});
