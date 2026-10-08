import { Schema } from "effect";

// Field numbers come from Cursor 3.22.12's CppConfigResponse descriptor.
const overrides = Buffer.from([0x28, 1, 0x38, 1, 0xb0, 1, 1, 0xc8, 1, 0]);
const readConfig = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));

/** Keep native tuning, enable Impact Tab, and request full text instead of account-bound context chunks. */
export const configureTab = (body: Buffer, contentType: string): Buffer => {
  const type = contentType.split(";")[0]?.trim();
  if (type === "application/proto") {
    // Protobuf singular fields use the last occurrence; unknown fields remain intact.
    return Buffer.concat([body, overrides]);
  }
  if (type === "application/json") {
    const config = readConfig(JSON.parse(body.toString("utf8")));
    return Buffer.from(
      JSON.stringify({
        ...config,
        isOn: true,
        shouldLetUserEnableCppEvenIfNotPro: true,
        shouldFetchRvfText: true,
        allowsTabChunks: false,
      }),
    );
  }
  throw new Error("Unsupported Tab config encoding.");
};
