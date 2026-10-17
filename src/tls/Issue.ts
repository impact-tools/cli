import selfsigned from "selfsigned";

export type CertificateAttributes = NonNullable<Parameters<typeof selfsigned.generate>[0]>;
type GenerateOptions = NonNullable<Parameters<typeof selfsigned.generate>[1]>;
export type CertificateExtensions = NonNullable<GenerateOptions["extensions"]>;

type ProfileOptions = Omit<GenerateOptions, "ca" | "extensions" | "notBeforeDate" | "notAfterDate">;

export interface CertificateProfile {
  readonly commonName: string;
  readonly extensions: CertificateExtensions;
  readonly options?: ProfileOptions;
}

export const certificateValidity = (days: number) => ({
  notBeforeDate: new Date(Date.now() - 60_000),
  notAfterDate: new Date(Date.now() + days * 86_400_000),
});

export async function issueCertificatePair(
  validity: { readonly notBeforeDate: Date; readonly notAfterDate: Date },
  caProfile: CertificateProfile,
  leafProfile: CertificateProfile,
) {
  const common = { ...validity, keyType: "ec" as const, algorithm: "sha256" };
  const ca = await selfsigned.generate(
    [{ name: "commonName", value: caProfile.commonName }],
    { ...common, ...caProfile.options, extensions: caProfile.extensions },
  );
  const leaf = await selfsigned.generate(
    [{ name: "commonName", value: leafProfile.commonName }],
    {
      ...common,
      ...leafProfile.options,
      ca: { key: ca.private, cert: ca.cert },
      extensions: leafProfile.extensions,
    },
  );
  return { ca, leaf };
}
