import { existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  CursorWire,
  decodeFrames,
  endFrame,
  frame,
} from "../src/clients/cursor/Wire.ts";

const fixture = `
E=A.makeEnum("test.Kind",[{no:0,name:"UNKNOWN"},{no:1,name:"READY"}]),
C=A.makeMessageType("agent.v1.AgentClientMessage",()=>[{no:1,name:"text_value",kind:"scalar",T:9,oneof:"message"},{no:2,name:"reply",kind:"message",T:S,oneof:"message"}]),
S=A.makeMessageType("agent.v1.AgentServerMessage",()=>[{no:1,name:"state",kind:"enum",T:A.getEnumType(E)},{no:2,name:"chunks",kind:"scalar",T:12,repeated:!0}]),
M=A.makeMessageType("aiserver.v1.AvailableModelsResponse",()=>[{no:1,name:"model_names",kind:"scalar",T:9,repeated:!0}]),
service={typeName:"agent.v1.AgentService",methods:{run:{name:"Run",I:C,O:S,kind:K.BiDiStreaming},models:{name:"Models",I:C,O:M,kind:K.Unary}}};`;

describe("Cursor installed descriptor codecs", () => {
  it("resolves forward message references, enums, camelCase, oneofs and JSON without executing bundle", () => {
    const wire = CursorWire.fromBundle(
      `throw new Error("must not execute");${fixture}`,
    );
    const input = {
      message: {
        case: "reply",
        value: { state: 1, chunks: [new Uint8Array([1, 2])] },
      },
    };
    const result = wire.decode(
      "agent.v1.AgentClientMessage",
      wire.encode("agent.v1.AgentClientMessage", input),
    );
    expect(result.message.case).toBe("reply");
    expect(result.message.value.state).toBe(1);
    expect(Array.from(result.message.value.chunks[0])).toEqual([1, 2]);
    const bytes = wire.encode(
      "aiserver.v1.AvailableModelsResponse",
      { modelNames: ["impact"] },
      true,
    );
    expect(
      wire.decode("aiserver.v1.AvailableModelsResponse", bytes, true)
        .modelNames,
    ).toEqual(["impact"]);
    expect(wire.method("/agent.v1.AgentService/Run")).toEqual({
      input: "agent.v1.AgentClientMessage",
      output: "agent.v1.AgentServerMessage",
      kind: "bidi",
    });
    expect(wire.method("/unknown")).toBeUndefined();
  });
  it("rejects executable descriptor expressions and absent required schemas", () => {
    expect(() =>
      CursorWire.fromBundle(fixture.replace("T:S", "T:evil()")),
    ).toThrow();
    expect(() => CursorWire.fromBundle("")).toThrow(
      "Cursor descriptor missing",
    );
  });
  it("parses exponent-notation field numbers and skips unsupported declarations", () => {
    // October 2026 Cursor bundles emit large field numbers as 1e3 and can
    // contain descriptor shapes the literal parser does not cover yet.
    const wire = CursorWire.fromBundle(
      fixture.replace("{no:2,name:\"reply\"", "{no:1e3,name:\"reply\"") +
        `,X=A.makeMessageType("agent.v1.UnsupportedShape",()=>unsupported());`,
    );
    const result = wire.decode(
      "agent.v1.AgentClientMessage",
      wire.encode("agent.v1.AgentClientMessage", {
        message: {
          case: "reply",
          value: { state: 1, chunks: [new Uint8Array([3])] },
        },
      }),
    );
    expect(result.message.case).toBe("reply");
    expect(result.message.value.state).toBe(1);
    expect(Array.from(result.message.value.chunks[0])).toEqual([3]);
    expect(wire.type("agent.v1.AgentClientMessage")).toBeTruthy();
    expect(() => wire.type("agent.v1.UnsupportedShape")).toThrow(
      "Cursor descriptor missing",
    );
  });
  it("resolves type aliases followed by braces from minified bundles", () => {
    const wire = CursorWire.fromBundle(
      `${fixture}T={no:1,name:"state",kind:"enum",T:A.getEnumType(E)};U=T;`,
    );
    expect(wire.type("agent.v1.AgentServerMessage")).toBeTruthy();
  });
  it.skipIf(!existsSync("/Applications/Cursor.app"))(
    "roundtrips actual installed agent and model schemas",
    async () => {
      const wire = await CursorWire.load("/Applications/Cursor.app");
      const client = {
        message: {
          case: "runRequest",
          value: {
            conversationId: "test-conversation",
            customSystemPrompt: "test",
          },
        },
      };
      const result = wire.decode(
        "agent.v1.AgentClientMessage",
        wire.encode("agent.v1.AgentClientMessage", client),
      );
      expect(result.message.case).toBe("runRequest");
      expect(result.message.value.conversationId).toBe("test-conversation");
      const server = { ttftBreakdown: { serverFirstTokenMs: 42 } };
      expect(
        wire.decode(
          "agent.v1.AgentServerMessage",
          wire.encode("agent.v1.AgentServerMessage", server),
        ).ttftBreakdown.serverFirstTokenMs,
      ).toBe(42);
      expect(
        wire.decode(
          "aiserver.v1.AvailableModelsResponse",
          wire.encode("aiserver.v1.AvailableModelsResponse", {
            modelNames: ["impact"],
          }),
        ).modelNames,
      ).toEqual(["impact"]);
      const catalog = wire.decode(
        "aiserver.v1.AvailableModelsResponse",
        wire.encode("aiserver.v1.AvailableModelsResponse", {
          modelNames: ["impact", "second"],
          models: [{ name: "impact", namedModelSectionIndex: 1 }, { name: "second", namedModelSectionIndex: 1 }],
        }),
      );
      expect(catalog.models.map((model: { namedModelSectionIndex?: number }) => model.namedModelSectionIndex)).toEqual([1, 1]);
      expect(wire.method("/agent.v1.AgentService/Run")?.kind).toBe("bidi");
    },
  );
});

async function* chunks(bytes: Buffer, size = 1) {
  for (let offset = 0; offset < bytes.length; offset += size)
    yield bytes.subarray(offset, offset + size);
}
async function collect(bytes: Buffer, size = 1, limit?: number) {
  const result = [];
  for await (const item of decodeFrames(chunks(bytes, size), limit))
    result.push(item);
  return result;
}
it("decodes split, empty, multiple, compressed and terminal Connect frames", async () => {
  const bytes = Buffer.concat([
    frame(Buffer.alloc(0)),
    frame(gzipSync(Buffer.from("hello")), 1),
    endFrame({ code: "unimplemented", message: "unsupported" }),
  ]);
  const result = await collect(bytes);
  expect(result.map((item) => item.flags)).toEqual([0, 0, 2]);
  expect(result[1]!.payload.toString()).toBe("hello");
  expect(JSON.parse(result[2]!.payload.toString())).toEqual({
    error: { code: "unimplemented", message: "unsupported" },
  });
});
it("rejects truncated, oversized, unsupported and inflated oversized frames", async () => {
  await expect(collect(Buffer.from([0, 0]))).rejects.toThrow("Truncated");
  await expect(collect(frame(Buffer.from("too large")), 1, 2)).rejects.toThrow(
    "too large",
  );
  await expect(collect(Buffer.from([4, 0, 0, 0, 0]))).rejects.toThrow("flags");
  await expect(
    collect(frame(gzipSync(Buffer.alloc(1000)), 1), 100, 50),
  ).rejects.toThrow();
});
