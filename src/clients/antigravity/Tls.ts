import { randomUUID } from "node:crypto";

import { certificateValidity, issueCertificatePair } from "../../tls/Issue.ts";

/** Only these services terminate TLS. Package downloads and other sites remain end-to-end TLS. */
export const IDE_CLOUD_HOSTS = new Set([
  "cloudcode-pa.googleapis.com", "daily-cloudcode-pa.googleapis.com",
  "preprod-daily-cloudcode-pa.sandbox.googleapis.com",
]);
export const IDE_PROXY_HOSTS: ReadonlySet<string> = new Set([
  ...IDE_CLOUD_HOSTS, "oauth2.googleapis.com", "www.googleapis.com", "antigravity-unleash.goog", "play.googleapis.com",
]);

export async function ideCertificate(days: number) {
  const { ca, leaf } = await issueCertificatePair(
    certificateValidity(days),
    {
      commonName: `Impact Antigravity proxy ${randomUUID()}`,
      extensions: [
        { name: "basicConstraints", cA: true, critical: true, pathLenConstraint: 0 },
        { name: "keyUsage", keyCertSign: true, critical: true },
      ],
    },
    {
      commonName: "cloudcode-pa.googleapis.com",
      extensions: [
        { name: "basicConstraints", cA: false },
        { name: "keyUsage", digitalSignature: true },
        { name: "extKeyUsage", serverAuth: true },
        { name: "subjectAltName", altNames: [...IDE_PROXY_HOSTS].map((value) => ({ type: 2 as const, value })) },
      ],
    },
  );
  return { ca: ca.cert, cert: leaf.cert, key: leaf.private };
}
