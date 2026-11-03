import { assert, describe, it } from "@effect/vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

import { ImpactRpcs } from "../src/schemas/Rpcs.ts";

/**
 * `src/schemas` copies the gateway's public contract so the CLI builds on its own. Inside the
 * monorepo the copies must match their sources in `packages/public-schemas` byte for byte (the files
 * of `packages/schemas` only re-export them); a standalone checkout has no sources to compare with
 * and skips this.
 */
const copies = join(import.meta.dirname, "../src/schemas");
const sources = join(import.meta.dirname, "../../packages/public-schemas/src");
/** The server's own schemas, where the whole RPC group lives: it is not part of the public contract. */
const serverSchemas = join(import.meta.dirname, "../../packages/schemas/src");
/** The CLI's RPC group is a deliberate subset: only the calls it makes. */
const SUBSET = "Rpcs.ts";

const files = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)],
  );

describe("model data", () => {
  it("is not embedded: models, prices and names come from GET /v1/models, so a new model needs no release", () => {
    assert.isFalse(existsSync(join(copies, "Catalog.ts")));
    assert.isFalse(existsSync(join(copies, "catalog")));
  });
});

describe.skipIf(!existsSync(sources) || !existsSync(serverSchemas))("copied API contract", () => {
  const copied = files(copies)
    .map((path) => relative(copies, path))
    .filter((path) => path !== SUBSET);

  it("copies a contract that is there", () => {
    assert.isAbove(copied.length, 0);
    for (const path of ["V1.ts", "Spend.ts", "Billing.ts", "ModelVocabulary.ts"]) assert.include(copied, path);
  });

  it.each(copied)("%s matches packages/public-schemas byte for byte", (path) => {
    assert.isTrue(existsSync(join(sources, path)), `${path} has no source in packages/public-schemas/src`);
    assert.isTrue(
      readFileSync(join(copies, path)).equals(readFileSync(join(sources, path))),
      `cli/src/schemas/${path} differs from packages/public-schemas/src/${path}; copy the source over`,
    );
  });

  it("keeps only RPCs the server defines, built from the copied groups", async () => {
    const server = (await import(pathToFileURL(join(serverSchemas, SUBSET)).href)) as {
      readonly ImpactRpcs: { readonly requests: ReadonlyMap<string, unknown> };
    };
    const served = [...server.ImpactRpcs.requests.keys()];
    const used = [...ImpactRpcs.requests.keys()];
    assert.isAbove(used.length, 0);
    for (const tag of used) assert.include(served, tag);
    // Each RPC comes from a copied file, so the byte comparison above covers its schemas.
    const imports = [...readFileSync(join(copies, SUBSET), "utf8").matchAll(/from "\.\/([^"]+)"/g)].map(
      (match) => match[1]!,
    );
    for (const file of imports) assert.include(copied, file);
  });
});
