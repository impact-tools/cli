import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import * as protobuf from "@bufbuild/protobuf";
import { proto3, type MessageType } from "@bufbuild/protobuf";

const MAX_FRAME = 16 * 1024 * 1024;
type Ref = { symbol: string };
type Method = {
  input: string;
  output: string;
  kind: "unary" | "server" | "bidi";
};

// This parser accepts descriptor literals only. It never evaluates bundle code.
class LiteralParser {
  offset = 0;
  constructor(readonly source: string) {}
  value(): any {
    this.space();
    const c = this.source[this.offset];
    if (c === "[" || c === "{") {
      this.offset++;
      const array = c === "[";
      const result: any = array ? [] : Object.create(null);
      const end = array ? "]" : "}";
      this.space();
      while (this.source[this.offset] !== end) {
        if (array) result.push(this.value());
        else {
          const key =
            this.source[this.offset] === '"' ? this.value() : this.identifier();
          this.expect(":");
          result[key] = this.value();
        }
        this.space();
        if (this.source[this.offset] !== ",") break;
        this.offset++;
        this.space();
      }
      this.expect(end);
      return result;
    }
    if (c === '"') {
      const start = this.offset++;
      while (this.offset < this.source.length) {
        const next = this.source[this.offset++];
        if (next === "\\") this.offset++;
        else if (next === '"')
          return JSON.parse(this.source.slice(start, this.offset));
      }
      throw new Error("Unterminated descriptor string");
    }
    if (c === "!") {
      this.offset++;
      return !this.value();
    }
    const number = /^-?\d+(?:\.\d+)?/.exec(this.source.slice(this.offset));
    if (number) {
      this.offset += number[0].length;
      return Number(number[0]);
    }
    const symbol = this.identifier();
    if (this.source[this.offset] === ".") {
      this.offset++;
      const member = this.identifier();
      if (member !== "getEnumType")
        throw new Error("Unsupported descriptor expression");
      this.expect("(");
      const ref = this.identifier();
      this.expect(")");
      return { symbol: ref } satisfies Ref;
    }
    return { symbol } satisfies Ref;
  }
  identifier() {
    this.space();
    const token = /^[\w$]+/.exec(this.source.slice(this.offset));
    if (!token) throw new Error(`Invalid descriptor literal at ${this.offset}`);
    this.offset += token[0].length;
    return token[0];
  }
  space() {
    while (
      /\s/.test(this.source[this.offset] ?? "") &&
      this.offset < this.source.length
    )
      this.offset++;
  }
  expect(token: string) {
    this.space();
    if (this.source[this.offset++] !== token)
      throw new Error(`Expected ${token} in descriptor`);
  }
}

export class CursorWire {
  private readonly types = new Map<string, MessageType>();
  private readonly methods = new Map<string, Method>();
  clientVersion?: string;
  static async load(appDirectory: string): Promise<CursorWire> {
    const candidates = [
      join(appDirectory, "Contents/Resources/app"),
      join(appDirectory, "resources/app"),
      appDirectory,
    ];
    const base = candidates.find((directory) =>
      existsSync(join(directory, "out/vs/workbench/workbench.desktop.main.js")),
    );
    if (!base) throw new Error("Cannot locate installed Cursor descriptors");
    const source = await readFile(
      join(base, "out/vs/workbench/workbench.desktop.main.js"),
      "utf8",
    );
    const wire = CursorWire.fromBundle(source);
    try {
      const info = JSON.parse(await readFile(join(base, "package.json"), "utf8"));
      if (typeof info.version === "string" && /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][\w.-]+)?$/.test(info.version))
        wire.clientVersion = info.version;
    } catch { /* Descriptor fixtures and older installations may omit metadata. */ }
    return wire;
  }
  static fromBundle(source: string): CursorWire {
    const wire = new CursorWire();
    const symbols = new Map<string, any>();
    // Well-known types are emitted as specialized classes, with custom JSON
    // semantics. Use the identical pinned runtime implementations for them.
    const known = new Map<string, MessageType>();
    for (const value of Object.values(protobuf)) {
      if (
        typeof value === "function" &&
        "typeName" in value &&
        typeof value.typeName === "string"
      )
        known.set(value.typeName, value as MessageType);
    }
    for (const entry of source.matchAll(
      /([\w$]+)\.typeName="(google\.protobuf\.[^"]+)"/g,
    )) {
      const type = known.get(entry[2]!);
      if (type) {
        symbols.set(entry[1]!, type);
        wire.types.set(entry[2]!, type);
      }
    }
    const aliases = Array.from(
      source.matchAll(/(?:^|[,;])([\w$]+)=([\w$]+)(?=[,;])/g),
    );
    for (let pass = 0; pass < 3; pass++)
      for (const alias of aliases) {
        const type = symbols.get(alias[2]!);
        if (type) symbols.set(alias[1]!, type);
      }
    const declarations: Array<{ symbol: string; name: string; fields: any[] }> =
      [];
    const pattern =
      /([\w$]+)=[\w$]+\.make(MessageType|Enum)\("([^"]+)",\s*(?:\(\)=>)?/g;
    for (const match of source.matchAll(pattern)) {
      const parser = new LiteralParser(
        source.slice(match.index! + match[0].length),
      );
      const fields = parser.value();
      if (!Array.isArray(fields))
        throw new Error(`Invalid descriptor ${match[3]}`);
      if (match[2] === "Enum")
        symbols.set(match[1]!, proto3.makeEnumType(match[3]!, fields));
      else declarations.push({ symbol: match[1]!, name: match[3]!, fields });
    }
    for (const declaration of declarations) {
      const type = proto3.makeMessageType(declaration.name, () =>
        declaration.fields.map((field) => {
          const resolve = (ref: any) => {
            if (!ref || typeof ref !== "object" || !("symbol" in ref))
              return ref;
            const found = symbols.get(ref.symbol);
            if (!found)
              throw new Error(
                `Unresolved descriptor ${ref.symbol} in ${declaration.name}`,
              );
            return found;
          };
          return {
            ...field,
            T: resolve(field.T),
            ...(field.V ? { V: { ...field.V, T: resolve(field.V.T) } } : {}),
          };
        }),
      );
      symbols.set(declaration.symbol, type);
      wire.types.set(declaration.name, type);
    }
    const services = /typeName:"([^"]+)",methods:\{/g;
    for (const service of source.matchAll(services)) {
      const tail = source.slice(service.index! + service[0].length);
      const entries =
        /^((?:[\w$]+:\{name:"[^"]+",I:[\w$]+,O:[\w$]+,kind:[\w$]+\.(?:Unary|ServerStreaming|BiDiStreaming|ClientStreaming)\},?)+)/.exec(
          tail,
        );
      if (!entries) continue;
      for (const entry of entries[1]!.matchAll(
        /name:"([^"]+)",I:([\w$]+),O:([\w$]+),kind:[\w$]+\.(\w+)/g,
      )) {
        const input = symbols.get(entry[2]!);
        const output = symbols.get(entry[3]!);
        if (input && output)
          wire.methods.set(`/${service[1]}/${entry[1]}`, {
            input: input.typeName,
            output: output.typeName,
            kind:
              entry[4] === "Unary"
                ? "unary"
                : entry[4] === "ServerStreaming"
                  ? "server"
                  : "bidi",
          });
      }
    }
    const visited = new Set<string>();
    const validate = (type: MessageType) => {
      if (visited.has(type.typeName)) return;
      visited.add(type.typeName);
      for (const field of type.fields.list()) {
        if (field.kind === "message") validate(field.T);
        else if (field.kind === "map" && field.V.kind === "message")
          validate(field.V.T);
      }
    };
    for (const required of [
      "agent.v1.AgentClientMessage",
      "agent.v1.AgentServerMessage",
      "aiserver.v1.AvailableModelsResponse",
    ])
      validate(wire.type(required));
    return wire;
  }
  type(name: string): MessageType {
    const type = this.types.get(name);
    if (!type) throw new Error(`Cursor descriptor missing: ${name}`);
    return type;
  }
  decode(name: string, bytes: Uint8Array, json = false): any {
    const type = this.type(name);
    return json
      ? type.fromJsonString(Buffer.from(bytes).toString("utf8"))
      : type.fromBinary(bytes);
  }
  encode(name: string, value: Record<string, any>, json = false): Buffer {
    const message = new (this.type(name))(value);
    return Buffer.from(json ? message.toJsonString() : message.toBinary());
  }
  method(path: string): Method | undefined {
    return this.methods.get(path);
  }
}

export function frame(payload: Uint8Array, flags = 0): Buffer {
  if (payload.length > MAX_FRAME) throw new Error("Connect frame too large");
  if (![0, 1, 2, 3].includes(flags))
    throw new Error("Invalid Connect frame flags");
  const header = Buffer.alloc(5);
  header[0] = flags;
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}
export function endFrame(error?: { code: string; message: string }): Buffer {
  return frame(Buffer.from(JSON.stringify(error ? { error } : {})), 2);
}
export async function* decodeFrames(
  chunks: AsyncIterable<Uint8Array>,
  maxFrame = MAX_FRAME,
): AsyncGenerator<{ flags: number; payload: Buffer }> {
  if (!Number.isInteger(maxFrame) || maxFrame <= 0 || maxFrame > MAX_FRAME)
    throw new Error("Invalid frame limit");
  let pending = Buffer.alloc(0);
  for await (const chunk of chunks) {
    // Consume input incrementally so a large transport chunk does not become an unbounded staging buffer.
    let offset = 0;
    while (offset < chunk.length) {
      const target = pending.length < 5 ? 5 : 5 + pending.readUInt32BE(1);
      const count = Math.min(target - pending.length, chunk.length - offset);
      pending = Buffer.concat([
        pending,
        chunk.subarray(offset, offset + count),
      ]);
      offset += count;
      if (pending.length < 5) continue;
      const flags = pending[0]!;
      const size = pending.readUInt32BE(1);
      if (size > maxFrame) throw new Error("Connect frame too large");
      if (flags & ~3) throw new Error("Invalid Connect frame flags");
      if (pending.length !== 5 + size) continue;
      const payload =
        flags & 1
          ? gunzipSync(pending.subarray(5), { maxOutputLength: maxFrame })
          : pending.subarray(5);
      yield { flags: flags & ~1, payload };
      pending = Buffer.alloc(0);
    }
  }
  if (pending.length) throw new Error("Truncated Connect frame");
}
