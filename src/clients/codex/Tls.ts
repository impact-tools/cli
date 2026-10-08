import { Effect, FileSystem } from "effect";
import { randomUUID } from "node:crypto";
import * as tls from "node:tls";
import selfsigned from "selfsigned";

import { CliError, mapPlatformError } from "../../Errors.ts";

/** A one-launch CA and loopback certificate; the CA joins the trusted roots given to Codex only. */
export const createProxyCertificate = Effect.fn("createProxyCertificate")(function* () {
  const { ca, key, cert } = yield* Effect.tryPromise({
    try: async () => {
      // A nested launch inherits the previous CA; unique issuers prevent TLS from selecting its obsolete key.
      const ca = await selfsigned.generate([{ name: "commonName", value: `Impact local proxy ${randomUUID()}` }], {
        keyType: "ec",
        algorithm: "sha256",
        extensions: [
          { name: "basicConstraints", cA: true },
          { name: "keyUsage", keyCertSign: true, cRLSign: true },
        ],
      });
      const leaf = await selfsigned.generate([{ name: "commonName", value: "localhost" }], {
        keyType: "ec",
        algorithm: "sha256",
        ca: { key: ca.private, cert: ca.cert },
        extensions: [
          { name: "basicConstraints", cA: false },
          { name: "keyUsage", digitalSignature: true },
          { name: "extKeyUsage", serverAuth: true },
          { name: "subjectAltName", altNames: [{ type: 7, ip: "127.0.0.1" }] },
        ],
      });
      return { ca: ca.cert, key: leaf.private, cert: leaf.cert };
    },
    catch: () => new CliError({ message: "Cannot create the local Codex TLS certificate." }),
  });
  const fs = yield* FileSystem.FileSystem;
  const certificateFile = yield* fs.makeTempFileScoped({ prefix: "impact-ca-", suffix: ".pem" });
  const custom = process.env.CODEX_CA_CERTIFICATE ?? process.env.SSL_CERT_FILE;
  const roots = custom
    ? yield* fs.readFileString(custom)
    : [
        ...tls.rootCertificates,
        ...(typeof tls.getCACertificates === "function" ? tls.getCACertificates("system") : []),
      ].join("\n");
  yield* fs.writeFileString(certificateFile, `${roots}\n${ca}`);
  return { key, cert, certificateFile };
}, mapPlatformError("Cannot write the Codex CA bundle"));
