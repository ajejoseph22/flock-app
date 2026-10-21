// Bundle the worker and the workspace packages into one ESM file; npm dependencies stay external.
import { build } from "esbuild";
import { readFileSync } from "node:fs";

const external = new Set();
for (const pkg of ["../../packages/db", "../../packages/core", "../../packages/telegram", "../../packages/payments", "."]) {
  const json = JSON.parse(readFileSync(new URL(`${pkg}/package.json`, import.meta.url)));
  for (const dep of Object.keys(json.dependencies ?? {})) if (!dep.startsWith("@flock/")) external.add(dep);
}

await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.js",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  external: [...external],
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: "info",
});
