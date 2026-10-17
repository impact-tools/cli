import { Effect, Schema } from "effect";
import { createPrivateKey, createPublicKey, randomBytes, randomUUID, X509Certificate } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { loopbackCertificate } from "../clients/codex/Tls.ts";
import { ideCertificate } from "../clients/antigravity/Tls.ts";
import { certificateSpki, CURSOR_CERTIFICATE_NAMES, type ProxyTls } from "../clients/cursor/HttpsProxy.ts";
import { configDirectory } from "../config/Credentials.ts";
import { certificateValidity, issueCertificatePair } from "../tls/Issue.ts";
import { CliError } from "../Errors.ts";

export const proxyPaths = () => {
  const directory = join(configDirectory(), "proxy");
  return {
    directory,
    config: join(directory, "config.json"),
    ca: join(directory, "ca.pem"),
    certificate: join(directory, "proxy.pem"),
    key: join(directory, "proxy.key"),
    log: join(directory, "proxy.log"),
    codexCa: join(directory, "codex-ca.pem"),
    codexCertificate: join(directory, "codex.pem"),
    codexKey: join(directory, "codex.key"),
    antigravityCa: join(directory, "antigravity-ca.pem"),
    antigravityCertificate: join(directory, "antigravity.pem"),
    antigravityKey: join(directory, "antigravity.key"),
  };
};
export type ProxyPaths = ReturnType<typeof proxyPaths>;

const Config = Schema.Struct({
  version: Schema.Literal(1),
  port: Schema.Int,
  username: Schema.String,
  password: Schema.String,
  /** Signs local Cursor sessions, so the managed profile stays signed in across proxy restarts. */
  sessionKey: Schema.String,
  createdAt: Schema.String,
  /** Setups created before Codex support lack this until `impact proxy setup` completes them. */
  codex: Schema.optional(Schema.Struct({ port: Schema.Int, prefix: Schema.String })),
  antigravityIde: Schema.optional(Schema.Literal(true)),
});
const readConfig = Schema.decodeUnknownSync(Schema.fromJsonString(Config));
export type ProxyConfig = typeof Config.Type;

export interface CodexSetup {
  readonly port: number;
  readonly prefix: string;
  readonly baseUrl: string;
  readonly tls: { readonly key: string; readonly cert: string };
  readonly ca: X509Certificate;
  readonly certificate: X509Certificate;
}

export interface ProxySetup {
  readonly paths: ProxyPaths;
  readonly config: ProxyConfig;
  readonly tls: ProxyTls;
  readonly ca: X509Certificate;
  readonly certificate: X509Certificate;
  readonly codex?: CodexSetup;
  readonly antigravityIde?: { readonly tls: ProxyTls; readonly ca: X509Certificate; readonly certificate: X509Certificate };
}

const der = (key: ReturnType<typeof createPublicKey>) => key.export({ type: "spki", format: "der" });

/** A server certificate with its key, checked against the CA that issued it. */
const loadPair = async (caPath: string, certificatePath: string, keyPath: string) => {
  const [caText, cert, key] = await Promise.all([
    readFile(caPath, "utf8"),
    readFile(certificatePath, "utf8"),
    readFile(keyPath, "utf8"),
  ]);
  const ca = new X509Certificate(caText);
  const certificate = new X509Certificate(cert);
  if (!certificate.verify(ca.publicKey)) throw new Error("A server certificate was not issued by its stored CA.");
  if (!der(createPublicKey(createPrivateKey(key))).equals(der(certificate.publicKey)))
    throw new Error("A server key does not match its certificate.");
  return { ca, certificate, cert, key };
};

const load = async (paths: ProxyPaths): Promise<ProxySetup | undefined> => {
  if (!existsSync(paths.config)) return undefined;
  const config = readConfig(await readFile(paths.config, "utf8"));
  const cursor = await loadPair(paths.ca, paths.certificate, paths.key);
  const codex = config.codex && (await loadPair(paths.codexCa, paths.codexCertificate, paths.codexKey));
  const ide = config.antigravityIde && await loadPair(paths.antigravityCa, paths.antigravityCertificate, paths.antigravityKey);
  return {
    paths,
    config,
    tls: { key: cursor.key, cert: cursor.cert, spki: certificateSpki(cursor.cert), certificateFile: paths.ca },
    ca: cursor.ca,
    certificate: cursor.certificate,
    ...(ide ? { antigravityIde: { ca: ide.ca, certificate: ide.certificate, tls: { key: ide.key, cert: ide.cert, spki: certificateSpki(ide.cert), certificateFile: paths.antigravityCa } } } : {}),
    ...(config.codex && codex
      ? {
          codex: {
            ...config.codex,
            baseUrl: `https://127.0.0.1:${config.codex.port}${config.codex.prefix}`,
            tls: { key: codex.key, cert: codex.cert },
            ca: codex.ca,
            certificate: codex.certificate,
          },
        }
      : {}),
  };
};

export const readProxySetup = Effect.suspend(() => {
  const paths = proxyPaths();
  return Effect.tryPromise({
    try: () => load(paths),
    catch: () =>
      new CliError({ message: `The Impact proxy files in ${paths.directory} are damaged. Run impact proxy setup --force.` }),
  });
});

export const requireSetup = readProxySetup.pipe(
  Effect.flatMap((setup) =>
    setup
      ? Effect.succeed(setup)
      : Effect.fail(new CliError({ message: "The Impact proxy is not set up. Run impact proxy setup, then impact proxy start." })),
  ),
);

const available = (port: number) =>
  new Promise<number | undefined>((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(undefined));
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address && typeof address !== "string" ? address.port : undefined));
    });
  });

/** Writes with owner-only permissions, replacing existing files on every platform. */
const writePrivate = async (path: string, text: string) => {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { mode: 0o600 });
    try {
      await rename(temporary, path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || !["EEXIST", "EPERM", "ENOTEMPTY"].includes(code ?? "")) throw error;
      // Windows does not replace an existing destination through rename(). The
      // temporary file still prevents a partial write; remove only our old file
      // before completing the swap.
      await unlink(path);
      await rename(temporary, path);
    }
  } finally {
    await unlink(temporary).catch(() => {});
  }
};

const TEN_YEARS = 10 * 365 * 86400_000;
/** Below every platform's ephemeral range, so outgoing connections never take the port. */
const DEFAULT_PORTS = Array.from({ length: 20 }, (_, index) => 17_420 + index);

const freePort = async (requested: number | undefined, taken: readonly number[] = []) => {
  for (const candidate of requested === undefined ? DEFAULT_PORTS.filter((port) => !taken.includes(port)) : [requested]) {
    const port = await available(candidate);
    if (port !== undefined) return port;
  }
  throw new CliError({
    message: requested === undefined ? "Ports 17420-17439 are in use. Choose one with --port." : `Port ${requested} is in use. Choose another with --port.`,
  });
};

/** Codex's loopback endpoint: its own certificate, port and secret path. */
const writeCodex = async (paths: ProxyPaths, taken: readonly number[]) => {
  const port = await freePort(undefined, taken);
  const material = await loopbackCertificate(TEN_YEARS / 86400_000);
  await writePrivate(paths.codexKey, material.key);
  await writePrivate(paths.codexCertificate, material.cert);
  await writePrivate(paths.codexCa, material.ca);
  return { port, prefix: `/${randomUUID()}` };
};

const writeIde = async (paths: ProxyPaths) => {
  const material = await ideCertificate(TEN_YEARS / 86400_000);
  await writePrivate(paths.antigravityKey, material.key);
  await writePrivate(paths.antigravityCertificate, material.cert);
  await writePrivate(paths.antigravityCa, material.ca);
  return true as const;
};

/**
 * Creates the persistent proxy identity: a CA whose private key is discarded after it signs one server
 * certificate for Cursor's hosts, the same for Codex's loopback endpoint, two ports, a proxy login and a
 * session signing key.
 */
const generate = async (paths: ProxyPaths, requestedPort: number | undefined) => {
  const port = await freePort(requestedPort);
  const { ca, leaf } = await issueCertificatePair(
    certificateValidity(TEN_YEARS / 86400_000),
    {
      commonName: `Impact Cursor proxy ${randomUUID()}`,
      extensions: [
        { name: "basicConstraints", cA: true, critical: true, pathLenConstraint: 0 },
        { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
      ],
    },
    {
      commonName: "api2.cursor.sh",
      extensions: [
        { name: "basicConstraints", cA: false },
        { name: "keyUsage", digitalSignature: true },
        { name: "extKeyUsage", serverAuth: true },
        { name: "subjectAltName", altNames: CURSOR_CERTIFICATE_NAMES.map((value) => ({ type: 2 as const, value })) },
      ],
    },
  );
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  await chmod(paths.directory, 0o700);
  await writePrivate(paths.key, leaf.private);
  await writePrivate(paths.certificate, leaf.cert);
  await writePrivate(paths.ca, ca.cert);
  const config: ProxyConfig = {
    version: 1,
    port,
    username: randomBytes(18).toString("hex"),
    password: randomBytes(32).toString("hex"),
    sessionKey: randomBytes(32).toString("base64url"),
    createdAt: new Date().toISOString(),
    codex: await writeCodex(paths, [port]),
    antigravityIde: await writeIde(paths),
  };
  // The settings file is written last: it marks a complete setup.
  await writePrivate(paths.config, `${JSON.stringify(config, null, 2)}\n`);
  const setup = await load(paths);
  if (!setup) throw new Error("The proxy setup was not saved.");
  return setup;
};

/** Adds what a setup from an earlier version lacks; the Cursor certificate and login stay unchanged. */
const complete = async (setup: ProxySetup) => {
  if (setup.codex && setup.antigravityIde) return setup;
  const config: ProxyConfig = { ...setup.config,
    codex: setup.config.codex ?? await writeCodex(setup.paths, [setup.config.port]),
    antigravityIde: setup.config.antigravityIde ?? await writeIde(setup.paths),
  };
  await writePrivate(setup.paths.config, `${JSON.stringify(config, null, 2)}\n`);
  const completed = await load(setup.paths);
  if (!completed) throw new Error("The proxy setup was not saved.");
  return completed;
};

export const completeProxySetup = (setup: ProxySetup) =>
  Effect.tryPromise({
    try: () => complete(setup),
    catch: (error) =>
      error instanceof CliError ? error : new CliError({ message: `Cannot write the Impact proxy files to ${setup.paths.directory}.` }),
  });

export const createProxySetup = (port?: number) =>
  Effect.suspend(() => {
    const paths = proxyPaths();
    return Effect.tryPromise({
      try: () => generate(paths, port),
      catch: (error) =>
        error instanceof CliError ? error : new CliError({ message: `Cannot write the Impact proxy files to ${paths.directory}.` }),
    });
  });
