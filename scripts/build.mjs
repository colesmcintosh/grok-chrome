import { mkdir } from "node:fs/promises";
import { build } from "esbuild";

await mkdir("dist/background", { recursive: true });

await build({
  entryPoints: ["src/background/service-worker.js"],
  outfile: "dist/background/service-worker.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["chrome116"],
  sourcemap: false,
  logLevel: "info",
  legalComments: "none"
});
