import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

const fromProjectRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  root: fromProjectRoot("./static-host"),
  base: "./",
  publicDir: fromProjectRoot("./public"),
  plugins: [react()],
  build: {
    outDir: fromProjectRoot("./dist-static"),
    emptyOutDir: true,
  },
});
