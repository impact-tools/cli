import { chmod, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("./", import.meta.url));
const compile = process.argv.includes("--compile");
const outfile = `${root}dist/impact${compile && process.platform === "win32" ? ".exe" : compile ? "" : ".js"}`;
await mkdir(`${root}dist`, { recursive: true });
const result = await Bun.build({
  entrypoints: [`${root}src/main.ts`],
  minify: true,
  ...(compile
    ? { compile: { outfile, autoloadDotenv: false, autoloadBunfig: false } }
    : { target: "node", outdir: `${root}dist`, naming: "impact.js" }),
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exitCode = 1;
} else {
  await chmod(outfile, 0o755);
  console.log(`Built ${outfile}`);
}
