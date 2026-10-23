// Bundle the worker and the workspace packages into one ESM file; npm dependencies stay external.
//   node build.mjs                 dist/main.js
//   node build.mjs --tools <dir>   <dir>/migrate/dist/migrate.js (+ SQL) and <dir>/tools/*.js, for the container image
import { build } from "esbuild";
import { cpSync, readFileSync } from "node:fs";
import { join } from "node:path";

const external = new Set();
for (const pkg of ["../../packages/db", "../../packages/core", "../../packages/telegram", "../../packages/payments", "."]) {
  const json = JSON.parse(readFileSync(new URL(`${pkg}/package.json`, import.meta.url)));
  for (const dep of Object.keys(json.dependencies ?? {})) if (!dep.startsWith("@flock/")) external.add(dep);
}

const common = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  external: [...external],
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: "info",
};

const toolsIdx = process.argv.indexOf("--tools");
if (toolsIdx === -1) {
  await build({ ...common, entryPoints: ["src/main.ts"], outfile: "dist/main.js" });
} else {
  const out = process.argv[toolsIdx + 1];
  if (!out) throw new Error("--tools needs an output directory");
  // The migration runner resolves ../migrations from its own file, so the SQL sits next to dist/.
  await build({ ...common, entryPoints: ["../../packages/db/src/migrate.ts"], outfile: join(out, "migrate/dist/migrate.js") });
  cpSync("../../packages/db/migrations", join(out, "migrate/migrations"), { recursive: true });
  await build({
    ...common,
    entryPoints: ["../../scripts/set-telegram-webhook.ts", "../../scripts/deploy-check.ts", "../../scripts/stripe-webhooks.ts"],
    outdir: join(out, "tools"),
  });
}
