import { Effect, FileSystem } from "effect";
import { randomUUID } from "node:crypto";
import * as tls from "node:tls";
import selfsigned from "selfsigned";
import { certificateValidity, issueCertificatePair } from "../../tls/Issue.ts";
import { CliError, mapPlatformError } from "../../Errors.ts";

/** Legacy per-launch material retained for callers that use `codexProxy` without setup. */
export const createProxyCertificate = Effect.fn("createProxyCertificate")(function* () {
  const { ca, cert, key } = yield* Effect.tryPromise({
    try: async () => {
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
  const certificateFile = yield* codexCaBundle(ca);
  return { key, cert, certificateFile };
});

/** A CA and the 127.0.0.1 certificate it signs; the CA key is discarded, so it can sign nothing else. */
export const loopbackCertificate = async (days: number) => {
  // Unique issuers keep TLS from selecting an obsolete key when bundles from several setups meet.
  const { ca, leaf } = await issueCertificatePair(
    certificateValidity(days),
    {
      commonName: `Impact local proxy ${randomUUID()}`,
      extensions: [
        { name: "basicConstraints", cA: true },
        { name: "keyUsage", keyCertSign: true, cRLSign: true },
      ],
    },
    {
      commonName: "localhost",
      extensions: [
        { name: "basicConstraints", cA: false },
        { name: "keyUsage", digitalSignature: true },
        { name: "extKeyUsage", serverAuth: true },
        { name: "subjectAltName", altNames: [{ type: 7, ip: "127.0.0.1" }] },
      ],
    },
  );
  return { ca: ca.cert, key: leaf.private, cert: leaf.cert };
};

/**
 * Codex replaces its roots with `CODEX_CA_CERTIFICATE`. This launch's bundle is the inherited custom bundle,
 * or the usual roots, plus `ca`; it is removed when the launch ends.
 */
export const codexCaBundle = Effect.fn("codexCaBundle")(function* (ca: string) {
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
  return certificateFile;
}, mapPlatformError("Cannot write the Codex CA bundle"));
