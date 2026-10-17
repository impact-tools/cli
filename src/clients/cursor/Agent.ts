import type { IncomingMessage, ServerResponse } from "node:http";
import type { Http2ServerRequest, Http2ServerResponse } from "node:http2";

import { createHash, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { Schema } from "effect";

import type { Connection } from "../../config/Connection.ts";
import { ProtocolError, streamChat, type ChatMessage } from "./Impact.ts";
import { CURSOR_AGENT_PROMPT, cursorInstructions, selectedInstructions } from "./Instructions.ts";
import { CursorWire, decodeFrames, endFrame, frame } from "./Wire.ts";

type Request = IncomingMessage | Http2ServerRequest;
type Response = ServerResponse;
type Native = Record<string, any>;
type Pending = {
  expected: string;
  execId?: string;
  resolve(value: Native): void;
  reject(error: Error): void;
};
const CLIENT = "agent.v1.AgentClientMessage";
const SERVER = "agent.v1.AgentServerMessage";
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_RUNS = 16;
const MAX_STEPS = 64;
const WAIT_MS = 120_000;

const object = Schema.Record(Schema.String, Schema.Unknown);
const text = Schema.String;
const optionalInt = Schema.optional(Schema.Int);
const schemas = {
  read_file: Schema.Struct({
    path: text,
    offset: optionalInt,
    limit: optionalInt,
  }),
  write_file: Schema.Struct({ path: text, content: text }),
  edit_file: Schema.Struct({
    path: text,
    old_text: text,
    new_text: text,
    replace_all: Schema.optional(Schema.Boolean),
  }),
  run_terminal_cmd: Schema.Struct({
    command: text,
    working_directory: Schema.optional(text),
    timeout_ms: optionalInt,
  }),
  list_dir: Schema.Struct({
    path: text,
    ignore: Schema.optional(Schema.Array(text)),
  }),
  grep: Schema.Struct({
    pattern: text,
    path: Schema.optional(text),
    glob: Schema.optional(text),
    case_insensitive: Schema.optional(Schema.Boolean),
    context: optionalInt,
    head_limit: optionalInt,
  }),
};
const definitions = [
  [
    "read_file",
    "Read a file by absolute or workspace-relative path, including rule and skill files from the catalog. Offset is a one-based line number.",
    {
      path: { type: "string" },
      offset: { type: "integer", minimum: 1 },
      limit: { type: "integer", minimum: 1 },
    },
    ["path"],
  ],
  [
    "write_file",
    "Create or replace a workspace file. The editor displays the resulting change.",
    { path: { type: "string" }, content: { type: "string" } },
    ["path", "content"],
  ],
  [
    "edit_file",
    "Replace an exact text match in a workspace file. Fails when the match is absent or ambiguous.",
    {
      path: { type: "string" },
      old_text: { type: "string" },
      new_text: { type: "string" },
      replace_all: { type: "boolean" },
    },
    ["path", "old_text", "new_text"],
  ],
  [
    "run_terminal_cmd",
    "Run a shell command using the editor's native approval and sandbox settings.",
    {
      command: { type: "string" },
      working_directory: { type: "string" },
      timeout_ms: { type: "integer", minimum: 1, maximum: 120000 },
    },
    ["command"],
  ],
  [
    "list_dir",
    "List a directory in the workspace.",
    {
      path: { type: "string" },
      ignore: { type: "array", items: { type: "string" } },
    },
    ["path"],
  ],
  [
    "grep",
    "Search workspace files using a regular expression.",
    {
      pattern: { type: "string" },
      path: { type: "string" },
      glob: { type: "string" },
      case_insensitive: { type: "boolean" },
      context: { type: "integer", minimum: 0 },
      head_limit: { type: "integer", minimum: 1 },
    },
    ["pattern"],
  ],
] as const;
const toolDefinitions = definitions.map(
  ([name, description, properties, required]) => ({
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      },
    },
  }),
);

const errorOf = (cause: unknown): ProtocolError =>
  cause instanceof ProtocolError
    ? cause
    : new ProtocolError(
        "internal",
        "The local Cursor adapter could not process this request.",
      );
const debugFailure = (cause: unknown) => {
  if (process.env.IMPACT_CURSOR_DEBUG !== "1") return;
  const error = cause instanceof Error ? cause : undefined;
  process.stderr.write(
    `[Cursor agent] Failure ${JSON.stringify({
      name: error?.name ?? "unknown",
      code: cause instanceof ProtocolError ? cause.code : undefined,
      message: cause instanceof ProtocolError ? cause.message : undefined,
      // Stack frames identify adapter/parser faults; the first line can contain
      // untrusted protobuf data and must never enter the debug log.
      frames: error?.stack
        ?.split("\n")
        .slice(1, 5)
        .map((line) => line.slice(0, 300)),
    })}\n`,
  );
};
const oneof = (name: string, value: Native) => ({ case: name, value });
const byteKey = (value: Uint8Array) => Buffer.from(value).toString("hex");
const mcpName = (mcp: Native) =>
  `mcp_${mcp.name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40)}_${createHash("sha256").update(`${mcp.providerIdentifier}:${mcp.toolName}:${mcp.name}`).digest("hex").slice(0, 8)}`;

function shellAnalysis(command: string): Native {
  // This intentionally accepts only literal unquoted words. Native permissions
  // must review shell syntax that we cannot analyze; a false clean AST could
  // incorrectly let an operator, substitution or redirect inherit an allowlist.
  const literal =
    /^[a-zA-Z0-9_./:@%+-]+(?:[ \t]+[a-zA-Z0-9_./:@%,+=-]+)*$/.test(
      command.trim(),
    );
  if (!literal)
    return {
      parsingFailed: true,
      executableCommands: [],
      hasRedirects: false,
      hasCommandSubstitution: false,
      redirects: [],
    };
  const [name, ...args] = command.trim().split(/[ \t]+/);
  return {
    parsingFailed: false,
    executableCommands: [
      {
        name,
        fullText: command.trim(),
        args: args.map((value) => ({ type: "word", value })),
      },
    ],
    hasRedirects: false,
    hasCommandSubstitution: false,
    redirects: [],
  };
}

/** Each run owns its buffers, client-side execution IDs and cancellation. No tool is executed by the CLI. */
// Keep reference material out of provider instructions: ChatGPT limits the
// aggregate system/developer field to 1,048,576 characters.
export function prepareAgentContext(
  messages: ChatMessage[],
  system: string,
  references: string,
): void {
  if (system.length > 1_000_000)
    throw new ProtocolError(
      "resource_exhausted",
      "Cursor instructions exceed the provider limit. Reduce the custom system prompt or always-applied rules.",
    );
  const seen = new Set([system]);
  const history = messages.filter((message) => {
    if (message.role !== "system" || typeof message.content !== "string")
      return true;
    if (seen.has(message.content)) return false;
    seen.add(message.content);
    return true;
  });
  // Cursor root prompts can contain an entire previous workspace snapshot.
  // Preserve them as context instead of concatenating them into instructions.
  const conversation = history.map((message): ChatMessage =>
    message.role === "system"
      ? { role: "user", content: `Previous Cursor instructions and context:\n${
          typeof message.content === "string" ? message.content : JSON.stringify(message.content)
        }` }
      : message,
  );
  messages.splice(0, messages.length,
    { role: "system", content: system },
    ...conversation,
    ...(references ? [{ role: "user" as const, content: `Files attached by Cursor:\n${references}` }] : []),
  );
}

class Run {
  readonly controller = new AbortController();
  readonly pending = new Map<number, Pending>();
  readonly blobs = new Map<string, Buffer>();
  readonly appendBuffer = new Map<number, Buffer>();
  readonly output: Buffer[] = [];
  outputBytes = 0;
  blobBytes = 0;
  appendBytes = 0;
  nextAppend = 0;
  seqno = 0;
  nextId = 1;
  started = false;
  attached = false;
  finished = false;
  error?: ProtocolError;
  wake = Promise.withResolvers<void>();
  private readonly deadline: ReturnType<typeof setTimeout>;
  private readonly heartbeat: ReturnType<typeof setInterval>;

  constructor(
    readonly wire: CursorWire,
    readonly connection: Connection,
    readonly modelIds: readonly string[],
  ) {
    this.deadline = setTimeout(
      () =>
        this.fail(
          new ProtocolError(
            "deadline_exceeded",
            "The agent run exceeded ten minutes.",
          ),
        ),
      600_000,
    );
    this.deadline.unref();
    this.heartbeat = setInterval(() => {
      try {
        if (!this.finished) this.update("heartbeat", {});
      } catch (error) {
        this.fail(error);
      }
    }, 15_000);
    this.heartbeat.unref();
  }

  emit(message: Native) {
    if (this.finished) return;
    const bytes = this.wire.encode(SERVER, message);
    if (this.outputBytes + bytes.length > MAX_BYTES)
      throw new ProtocolError(
        "resource_exhausted",
        "The editor is not consuming the agent stream.",
      );
    this.output.push(bytes);
    this.outputBytes += bytes.length;
    this.wake.resolve();
  }
  update(name: string, value: Native) {
    this.emit({
      message: oneof("interactionUpdate", { message: oneof(name, value) }),
    });
  }
  finish() {
    this.finished = true;
    clearTimeout(this.deadline);
    clearInterval(this.heartbeat);
    this.wake.resolve();
  }
  fail(cause: unknown) {
    if (this.finished) return;
    debugFailure(cause);
    this.error = errorOf(cause);
    this.controller.abort(this.error);
    for (const task of this.pending.values()) task.reject(this.error);
    this.pending.clear();
    this.finish();
  }
  async take(): Promise<Buffer | undefined> {
    for (;;) {
      const bytes = this.output.shift();
      if (bytes) {
        this.outputBytes -= bytes.length;
        return bytes;
      }
      if (this.finished) return;
      this.wake = Promise.withResolvers<void>();
      await this.wake.promise;
    }
  }

  input(message: Native) {
    if (this.finished) return;
    const part = message.message;
    switch (part?.case) {
      case "runRequest":
        if (this.started)
          throw new ProtocolError(
            "invalid_argument",
            "An agent stream can contain only one run request.",
          );
        this.started = true;
        void this.execute(part.value).catch((error) => this.fail(error));
        return;
      case "clientHeartbeat":
      case "prewarmRequest":
        return;
      case "conversationAction":
        if (part.value.action?.case === "cancelAction") {
          this.fail(
            new ProtocolError("canceled", "Agent canceled in the editor."),
          );
          return;
        }
        throw new ProtocolError(
          "unimplemented",
          "This agent action requires starting a new run.",
        );
      case "kvClientMessage":
      case "execClientMessage": {
        const reply = part.value;
        const task = this.pending.get(reply.id);
        if (!task)
          throw new ProtocolError(
            "invalid_argument",
            "Unexpected native execution response ID.",
          );
        if (
          reply.message?.case !== task.expected ||
          (reply.execId && task.execId && reply.execId !== task.execId)
        )
          throw new ProtocolError(
            "invalid_argument",
            "The native execution response does not match its request.",
          );
        this.pending.delete(reply.id);
        task.resolve(reply.message.value);
        return;
      }
      case "execClientControlMessage": {
        const control = part.value.message;
        if (control?.case === "heartbeat") return;
        const task = this.pending.get(control?.value?.id);
        if (task) {
          this.pending.delete(control.value.id);
          task.reject(
            new ProtocolError(
              "failed_precondition",
              control.case === "throw"
                ? "The editor could not execute the tool."
                : "The editor closed a native tool before returning its result.",
            ),
          );
        }
        return;
      }
      default:
        throw new ProtocolError(
          "unimplemented",
          `Unsupported native agent message: ${part?.case ?? "empty"}.`,
        );
    }
  }

  append(seqno: number, payload: Buffer) {
    if (
      !Number.isSafeInteger(seqno) ||
      seqno < 0 ||
      seqno > this.nextAppend + 64
    )
      throw new ProtocolError(
        "invalid_argument",
        "Invalid agent append sequence.",
      );
    if (seqno < this.nextAppend) return; // The editor retries acknowledged appends after transport errors.
    const prior = this.appendBuffer.get(seqno);
    if (prior) {
      if (!prior.equals(payload))
        throw new ProtocolError(
          "invalid_argument",
          "Conflicting agent append sequence.",
        );
      return;
    }
    if (this.appendBytes + payload.length > MAX_BYTES)
      throw new ProtocolError(
        "resource_exhausted",
        "Too much pending agent input.",
      );
    this.appendBuffer.set(seqno, payload);
    this.appendBytes += payload.length;
    while (this.appendBuffer.has(this.nextAppend)) {
      const bytes = this.appendBuffer.get(this.nextAppend)!;
      this.appendBuffer.delete(this.nextAppend++);
      this.appendBytes -= bytes.length;
      this.input(this.wire.decode(CLIENT, bytes));
    }
  }

  async call(
    channel: "kvServerMessage" | "execServerMessage",
    name: string,
    value: Native,
    expected: string,
  ): Promise<Native> {
    if (this.controller.signal.aborted)
      throw this.error ?? new ProtocolError("canceled", "Agent canceled.");
    const id = this.nextId++;
    const execId = channel === "execServerMessage" ? randomUUID() : undefined;
    const reply = Promise.withResolvers<Native>();
    const timer = setTimeout(() => {
      this.pending.delete(id);
      reply.reject(
        new ProtocolError(
          "deadline_exceeded",
          "The editor did not return a native execution result.",
        ),
      );
    }, WAIT_MS);
    timer.unref();
    this.pending.set(id, {
      expected,
      execId,
      resolve: reply.resolve,
      reject: reply.reject,
    });
    try {
      this.emit({
        message: oneof(channel, {
          id,
          ...(execId ? { execId } : {}),
          message: oneof(name, value),
        }),
      });
      return await reply.promise;
    } finally {
      clearTimeout(timer);
      this.pending.delete(id);
    }
  }

  cacheBlob(id: Uint8Array, bytes: Buffer) {
    const key = byteKey(id);
    if (this.blobs.has(key)) return;
    if (this.blobBytes + bytes.length > MAX_BYTES)
      throw new ProtocolError(
        "resource_exhausted",
        "Conversation blobs exceed 8 MiB.",
      );
    this.blobs.set(key, bytes);
    this.blobBytes += bytes.length;
  }
  async blob(id: Uint8Array): Promise<Buffer> {
    if (!id?.length)
      throw new ProtocolError(
        "data_loss",
        "Conversation contains an empty blob reference.",
      );
    const cached = this.blobs.get(byteKey(id));
    if (cached) return cached;
    const response = await this.call(
      "kvServerMessage",
      "getBlobArgs",
      { blobId: id },
      "getBlobResult",
    );
    if (response.error || !response.blobData?.length)
      throw new ProtocolError(
        "data_loss",
        "A conversation blob is missing from the editor.",
      );
    const bytes = Buffer.from(response.blobData);
    this.cacheBlob(id, bytes);
    return bytes;
  }
  async put(type: string, value: Native): Promise<Buffer> {
    const bytes = this.wire.encode(`agent.v1.${type}`, value);
    const id = createHash("sha256").update(bytes).digest();
    this.cacheBlob(id, bytes);
    const result = await this.call(
      "kvServerMessage",
      "setBlobArgs",
      { blobId: id, blobData: bytes },
      "setBlobResult",
    );
    if (result.error)
      throw new ProtocolError(
        "data_loss",
        "The editor could not persist the conversation.",
      );
    return id;
  }

  async userContent(user: Native): Promise<string | unknown[]> {
    let content =
      user.text ||
      (user.textBlobId?.length
        ? (await this.blob(user.textBlobId)).toString("utf8")
        : "");
    const selected = user.selectedContext;
    if (selected) {
      const snippets = [
        ...(selected.files ?? []),
        ...(selected.codeSelections ?? []),
      ].map(
        (file) => `File: ${file.path || file.relativePath}\n${file.content}`,
      );
      snippets.push(...(selected.extraContext ?? []));
      snippets.push(...selectedInstructions(selected));
      if (snippets.length)
        content += `\n\nSelected editor context:\n${snippets.join("\n\n")}`;
      const images: unknown[] = [];
      for (const image of selected.selectedImages ?? []) {
        const data = image.dataOrBlobId;
        const bytes =
          data?.case === "data"
            ? data.value
            : data?.case === "blobId"
              ? await this.blob(data.value)
              : data?.case === "blobIdWithData"
                ? data.value.data
                : undefined;
        if (!bytes?.length)
          throw new ProtocolError(
            "unimplemented",
            "This attached image format is not available to the local adapter.",
          );
        const mimeType = image.mimeType || "image/png";
        if (!/^image\/(png|jpeg|webp|gif)$/.test(mimeType))
          throw new ProtocolError(
            "invalid_argument",
            "Unsupported image media type.",
          );
        images.push({
          type: "image_url",
          image_url: {
            url: `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`,
          },
        });
      }
      if (images.length) return [{ type: "text", text: content }, ...images];
      if (selected.selectedVideos?.length || selected.selectedDocuments?.length)
        throw new ProtocolError(
          "unimplemented",
          "Video and document attachments are not supported by the local adapter.",
        );
    }
    return content;
  }

  async recover(state: Native): Promise<ChatMessage[]> {
    const messages: ChatMessage[] = [];
    for (const id of state.rootPromptMessagesJson ?? []) {
      let value: any;
      try {
        value = Schema.decodeUnknownSync(
          Schema.Struct({
            role: Schema.Literals(["system", "user", "assistant", "tool"]),
            content: Schema.Union([
              Schema.String,
              Schema.Array(Schema.Unknown),
              Schema.Null,
            ]),
          }),
        )(JSON.parse((await this.blob(id)).toString("utf8")));
      } catch (error) {
        if (error instanceof ProtocolError) throw error;
        throw new ProtocolError(
          "data_loss",
          "Invalid root conversation message.",
        );
      }
      messages.push(value);
    }
    if ((state.turns?.length ?? 0) > 128)
      throw new ProtocolError(
        "resource_exhausted",
        "Conversation exceeds 128 native turns.",
      );
    for (const id of state.turns ?? []) {
      const turn = this.wire.decode(
        "agent.v1.ConversationTurnStructure",
        await this.blob(id),
      ).turn;
      if (turn.case !== "agentConversationTurn")
        throw new ProtocolError(
          "unimplemented",
          "This native conversation turn type is not supported.",
        );
      const value = turn.value;
      if (value.userMessage?.length)
        messages.push({
          role: "user",
          content: await this.userContent(
            this.wire.decode(
              "agent.v1.UserMessage",
              await this.blob(value.userMessage),
            ),
          ),
        });
      for (const stepId of value.steps ?? []) {
        const step = this.wire.decode(
          "agent.v1.ConversationStep",
          await this.blob(stepId),
        ).message;
        if (step.case === "assistantMessage")
          messages.push({ role: "assistant", content: step.value.text });
        else if (step.case === "toolCall") {
          const call = step.value;
          const tool = call.tool;
          const args = tool.value?.args ?? {};
          const nativeNames: Record<string, string> = {
            shellToolCall: "run_terminal_cmd",
            readToolCall: "read_file",
            editToolCall: "write_file",
            lsToolCall: "list_dir",
            grepToolCall: "grep",
            mcpToolCall: tool.case === "mcpToolCall" ? mcpName(args) : "",
          };
          const name = nativeNames[tool.case];
          if (!name)
            throw new ProtocolError(
              "unimplemented",
              `Cannot recover native tool ${tool.case}.`,
            );
          const original =
            tool.case === "shellToolCall"
              ? {
                  command: args.command,
                  working_directory: args.workingDirectory,
                  timeout_ms: args.timeout,
                }
              : tool.case === "editToolCall"
                ? { path: args.path, content: args.streamContent }
                : tool.case === "grepToolCall"
                  ? {
                      pattern: args.pattern,
                      path: args.path,
                      glob: args.glob,
                      case_insensitive: args.caseInsensitive,
                      context: args.context,
                      head_limit: args.headLimit,
                    }
                  : tool.case === "mcpToolCall"
                    ? Object.fromEntries(
                        Object.entries(args.args ?? {}).map(([key, value]) => [
                          key,
                          (value as any).toJson(),
                        ]),
                      )
                    : args;
          messages.push({
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: call.toolCallId,
                type: "function",
                function: { name, arguments: JSON.stringify(original) },
              },
            ],
          });
          messages.push({
            role: "tool",
            tool_call_id: call.toolCallId,
            content: this.resultText(tool.value.result),
          });
        }
        if (messages.length > 250)
          throw new ProtocolError(
            "resource_exhausted",
            "Conversation exceeds the message limit.",
          );
      }
    }
    return messages;
  }

  importedHistory(history: Native): ChatMessage[] {
    if ((history.messages?.length ?? 0) > 250)
      throw new ProtocolError(
        "resource_exhausted",
        "Imported conversation exceeds 250 messages.",
      );
    return (history.messages ?? []).map((entry: Native): ChatMessage => {
      const message = entry.message;
      if (!["user", "assistant", "tool"].includes(message?.case))
        throw new ProtocolError(
          "unimplemented",
          "Unknown imported conversation message.",
        );
      const values = message.value.content ?? [];
      const content: unknown[] = [];
      const calls: unknown[] = [];
      for (const item of values) {
        const part = item.content;
        if (part?.case === "text")
          content.push({ type: "text", text: part.value.text });
        else if (part?.case === "image") {
          const image = part.value;
          if (
            !/^image\/(png|jpeg|gif|webp)$/.test(image.mimeType) ||
            !/^[\w+/=]+$/.test(image.data)
          )
            throw new ProtocolError(
              "invalid_argument",
              "Invalid imported conversation image.",
            );
          content.push({
            type: "image_url",
            image_url: { url: `data:${image.mimeType};base64,${image.data}` },
          });
        } else if (part?.case === "toolCall")
          calls.push({
            id: part.value.toolCallId,
            type: "function",
            function: {
              name: part.value.toolName,
              arguments: part.value.argsJson,
            },
          });
        else if (!["reasoning", "redactedReasoning"].includes(part?.case))
          throw new ProtocolError(
            "unimplemented",
            "Unknown imported conversation content.",
          );
      }
      const plainText = content.every((part: any) => part.type === "text")
        ? content.map((part: any) => part.text).join("\n")
        : content;
      return {
        role: message.case,
        content: plainText,
        ...(calls.length ? { tool_calls: calls } : {}),
        ...(message.case === "tool"
          ? { tool_call_id: message.value.toolCallId }
          : {}),
      };
    });
  }

  async context(request: Native, action: Native): Promise<Native> {
    let context = action.requestContext;
    const parts = request.action?.requestContextParts;
    if (parts) {
      context = { ...(context ?? parts.dynamicContext ?? {}) };
      for (const [ref, type] of [
        ["rulesBlobId", "RequestContextRulesPart"],
        ["skillsBlobId", "RequestContextSkillsPart"],
        ["mcpsBlobId", "RequestContextMcpsPart"],
      ]) {
        if (parts[ref!]?.length)
          Object.assign(
            context,
            this.wire.decode(`agent.v1.${type}`, await this.blob(parts[ref!])),
          );
      }
    }
    if (!context?.env) {
      const result = await this.call(
        "execServerMessage",
        "requestContextArgs",
        {},
        "requestContextResult",
      );
      if (
        result.result?.case !== "success" ||
        !result.result.value.requestContext
      )
        throw new ProtocolError(
          "failed_precondition",
          "The editor could not provide workspace context.",
        );
      context = { ...result.result.value.requestContext, ...context };
    }
    return context;
  }

  resultText(result: Native): string {
    if (!result)
      throw new ProtocolError(
        "data_loss",
        "Native tool did not return a result.",
      );
    const value = result.result?.value ?? result;
    if (value.output?.case === "content") return value.output.value;
    if (value.content && typeof value.content === "string")
      return value.content;
    const content = JSON.stringify(result, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value,
    );
    if (content.length > 1024 * 1024)
      throw new ProtocolError(
        "resource_exhausted",
        "Tool output exceeds 1 MiB.",
      );
    return content;
  }

  async tool(
    name: string,
    input: string,
    callId: string,
    context: Native,
    mcps: Map<string, Native>,
  ): Promise<{ call: Native; content: string }> {
    let args: Native;
    try {
      args = Schema.decodeUnknownSync(object)(JSON.parse(input));
    } catch {
      throw new ProtocolError(
        "invalid_argument",
        `Invalid arguments for ${name}.`,
      );
    }
    const schema = schemas[name as keyof typeof schemas];
    if (schema) {
      try {
        args = Schema.decodeUnknownSync(schema)(args);
      } catch {
        throw new ProtocolError(
          "invalid_argument",
          `Invalid arguments for ${name}.`,
        );
      }
    } else if (!mcps.has(name))
      throw new ProtocolError(
        "unimplemented",
        `Unsupported Impact tool: ${name}.`,
      );
    const workspace =
      context.env?.workspacePaths?.[0] ||
      context.env?.projectFolder ||
      context.env?.processWorkingDirectory;
    let exec: string,
      expected: string,
      tool: string,
      nativeArgs: Native,
      displayArgs: Native;
    switch (name) {
      case "read_file":
        if (
          (args.offset !== undefined && args.offset < 1) ||
          (args.limit !== undefined && args.limit < 1)
        )
          throw new ProtocolError("invalid_argument", "Invalid file range.");
        exec = "readArgs";
        expected = "readResult";
        tool = "readToolCall";
        nativeArgs = {
          path: args.path,
          offset: args.offset,
          limit: args.limit,
          toolCallId: callId,
        };
        displayArgs = {
          path: args.path,
          offset: args.offset,
          limit: args.limit,
          includeLineNumbers: false,
        };
        break;
      case "write_file":
      case "edit_file": {
        let content = args.content;
        if (name === "edit_file") {
          const read = await this.call(
            "execServerMessage",
            "readArgs",
            { path: args.path, toolCallId: callId },
            "readResult",
          );
          if (
            read.result?.case !== "success" ||
            read.result.value.output?.case !== "content"
          )
            throw new ProtocolError(
              "failed_precondition",
              "The file could not be read for editing.",
            );
          const original: string = read.result.value.output.value;
          if (
            !args.old_text ||
            !original.includes(args.old_text) ||
            (!args.replace_all &&
              original.indexOf(args.old_text) !==
                original.lastIndexOf(args.old_text))
          )
            throw new ProtocolError(
              "failed_precondition",
              "The edit text is absent or matches more than once.",
            );
          content = args.replace_all
            ? original.split(args.old_text).join(args.new_text)
            : original.replace(args.old_text, args.new_text);
        }
        exec = "writeArgs";
        expected = "writeResult";
        tool = "editToolCall";
        nativeArgs = {
          path: args.path,
          fileText: content,
          toolCallId: callId,
          returnFileContentAfterWrite: true,
        };
        displayArgs = { path: args.path, streamContent: content };
        break;
      }
      case "run_terminal_cmd":
        exec = "shellArgs";
        expected = "shellResult";
        tool = "shellToolCall";
        nativeArgs = {
          command: args.command,
          workingDirectory: args.working_directory || workspace,
          timeout: Math.min(Math.max(args.timeout_ms ?? 30_000, 1), 120_000),
          toolCallId: callId,
          parsingResult: shellAnalysis(args.command),
          skipApproval: false,
          closeStdin: true,
        };
        displayArgs = nativeArgs;
        break;
      case "list_dir":
        exec = "lsArgs";
        expected = "lsResult";
        tool = "lsToolCall";
        nativeArgs = {
          path: args.path,
          ignore: args.ignore ?? [],
          toolCallId: callId,
        };
        displayArgs = nativeArgs;
        break;
      case "grep":
        exec = "grepArgs";
        expected = "grepResult";
        tool = "grepToolCall";
        nativeArgs = {
          pattern: args.pattern,
          path: args.path || workspace,
          glob: args.glob,
          caseInsensitive: args.case_insensitive,
          context: args.context,
          headLimit: Math.min(Math.max(args.head_limit ?? 200, 1), 1000),
          outputMode: "content",
          toolCallId: callId,
        };
        displayArgs = nativeArgs;
        break;
      default: {
        const mcp = mcps.get(name)!;
        exec = "mcpArgs";
        expected = "mcpResult";
        tool = "mcpToolCall";
        const values = Object.fromEntries(
          Object.entries(args).map(([key, value]) => [
            key,
            this.wire.type("google.protobuf.Value").fromJson(value),
          ]),
        );
        nativeArgs = {
          name: mcp.name,
          providerIdentifier: mcp.providerIdentifier,
          toolName: mcp.toolName,
          args: values,
          toolCallId: callId,
          skipApproval: false,
        };
        displayArgs = nativeArgs;
      }
    }
    const started = Date.now();
    const call: Native = {
      toolCallId: callId,
      startedAtMs: BigInt(started),
      tool: oneof(tool, { args: displayArgs }),
    };
    this.update("toolCallStarted", {
      callId,
      toolCall: call,
      modelCallId: callId,
    });
    const result = await this.call(
      "execServerMessage",
      exec,
      nativeArgs,
      expected,
    );
    let displayResult = result;
    if (tool === "readToolCall") {
      displayResult =
        result.result?.case === "success"
          ? {
              result: oneof("success", {
                ...result.result.value,
                fileSize: Number(result.result.value.fileSize),
                path: args.path,
              }),
            }
          : { result: oneof("error", { message: this.resultText(result) }) };
    } else if (tool === "editToolCall") {
      displayResult =
        result.result?.case === "success"
          ? {
              result: oneof("success", {
                path: args.path,
                afterFullFileContent: nativeArgs.fileText,
              }),
            }
          : { result: oneof("error", { message: this.resultText(result) }) };
    } else if (
      tool === "mcpToolCall" &&
      !["success", "rejected", "permissionDenied"].includes(result.result?.case)
    )
      displayResult = {
        result: oneof("error", { message: this.resultText(result) }),
      };
    call.tool.value.result = displayResult;
    call.completedAtMs = BigInt(Date.now());
    this.update("toolCallCompleted", {
      callId,
      toolCall: call,
      modelCallId: callId,
    });
    return { call, content: this.resultText(result) };
  }

  async execute(request: Native) {
    const model =
      request.requestedModel?.modelId || request.modelDetails?.modelId;
    if (!model || !this.modelIds.includes(model))
      throw new ProtocolError(
        "invalid_argument",
        `Impact model is unavailable: ${model || "empty"}.`,
      );
    if ((request.preFetchedBlobs?.length ?? 0) > 1024)
      throw new ProtocolError(
        "resource_exhausted",
        "Too many prefetched conversation blobs.",
      );
    for (const entry of request.preFetchedBlobs ?? [])
      this.cacheBlob(entry.id, Buffer.from(entry.value));
    const action = request.action?.action;
    if (action?.case === "cancelAction")
      throw new ProtocolError("canceled", "Agent canceled.");
    if (action?.case !== "userMessageAction")
      throw new ProtocolError(
        "unimplemented",
        `Unsupported agent action: ${action?.case ?? "empty"}.`,
      );
    const user = action.value.userMessage;
    if (!user)
      throw new ProtocolError(
        "invalid_argument",
        "Agent request is missing its user message.",
      );
    const state = request.conversationState ?? {};
    const messages = action.value.conversationHistory?.messages?.length
      ? this.importedHistory(action.value.conversationHistory)
      : await this.recover(state);
    const context = await this.context(request, action.value);
    const system = cursorInstructions(
      context,
      request.customSystemPrompt || CURSOR_AGENT_PROMPT,
      (value) => this.resultText(value),
    );
    const references = Object.entries(context.fileContents ?? {})
      .map(([path, content]) => `File: ${path}\n${content}`)
      .join("\n\n");
    prepareAgentContext(messages, system, references);
    for (const prior of action.value.prependUserMessages ?? [])
      messages.push({ role: "user", content: await this.userContent(prior) });
    messages.push({ role: "user", content: await this.userContent(user) });
    this.update("userMessageAppended", { userMessage: user });
    const userId = await this.put("UserMessage", user);
    const steps: Buffer[] = [];
    const mcps = new Map<string, Native>();
    const tools: unknown[] = [...toolDefinitions];
    for (const mcp of [
      ...(request.mcpTools?.mcpTools ?? []),
      ...(context.tools ?? []),
    ]) {
      const name = mcpName(mcp);
      if (mcps.has(name)) continue;
      let parameters;
      try {
        parameters = mcp.inputSchemaJson
          ? JSON.parse(mcp.inputSchemaJson)
          : mcp.inputSchema?.toJson();
      } catch {
        throw new ProtocolError(
          "invalid_argument",
          "Invalid MCP input schema.",
        );
      }
      if (!parameters)
        throw new ProtocolError(
          "invalid_argument",
          "Missing MCP input schema.",
        );
      mcps.set(name, mcp);
      tools.push({
        type: "function",
        function: { name, description: mcp.description, parameters },
      });
    }
    const readOnly = user.mode === 2 || user.mode === 3;
    const offered = readOnly
      ? tools.filter((tool: any) =>
          ["read_file", "list_dir", "grep"].includes(tool.function.name),
        )
      : tools;
    for (let step = 0; step < MAX_STEPS; step++) {
      this.update("stepStarted", { stepId: BigInt(step) });
      const calls = new Map<
        number,
        { id: string; name: string; arguments: string }
      >();
      let content = "",
        reasoning = "",
        usage:
          { prompt_tokens?: number; completion_tokens?: number } | undefined;
      let finishReason: string | undefined;
      for await (const delta of streamChat(
        this.connection,
        { model, messages, tools: offered },
        this.controller.signal,
      )) {
        if (delta.content) {
          content += delta.content;
          this.update("textDelta", { text: delta.content });
        }
        if (delta.reasoning) {
          reasoning += delta.reasoning;
          this.update("thinkingDelta", { text: delta.reasoning });
        }
        if (content.length + reasoning.length > MAX_BYTES)
          throw new ProtocolError(
            "resource_exhausted",
            "Model output exceeds 8 MiB.",
          );
        if (delta.usage) usage = delta.usage;
        if (delta.finishReason) finishReason = delta.finishReason;
        for (const part of delta.toolCalls ?? []) {
          if (
            !Number.isInteger(part.index) ||
            part.index < 0 ||
            part.index >= 32
          )
            throw new ProtocolError(
              "resource_exhausted",
              "Too many simultaneous tool calls.",
            );
          const call = calls.get(part.index) ?? {
            id: "",
            name: "",
            arguments: "",
          };
          if (part.id) call.id += part.id;
          if (part.name) call.name += part.name;
          if (part.arguments) call.arguments += part.arguments;
          if (call.arguments.length > 1024 * 1024)
            throw new ProtocolError(
              "resource_exhausted",
              "Tool arguments exceed 1 MiB.",
            );
          calls.set(part.index, call);
        }
      }
      if (reasoning)
        this.update("thinkingCompleted", { thinkingDurationMs: 0 });
      if (content)
        steps.push(
          await this.put("ConversationStep", {
            message: oneof("assistantMessage", { text: content }),
          }),
        );
      if (calls.size) {
        const seen = new Set<string>();
        const complete = [...calls.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, call]) => {
            if (
              !call.id ||
              !call.name ||
              seen.has(call.id) ||
              !offered.some((tool: any) => tool.function.name === call.name)
            )
              throw new ProtocolError(
                "unimplemented",
                "Impact returned an unknown or invalid tool call.",
              );
            seen.add(call.id);
            return call;
          });
        messages.push({
          role: "assistant",
          content: content || null,
          tool_calls: complete.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: call.arguments },
          })),
        });
        for (const call of complete) {
          const result = await this.tool(
            call.name,
            call.arguments,
            call.id,
            context,
            mcps,
          );
          steps.push(
            await this.put("ConversationStep", {
              message: oneof("toolCall", result.call),
            }),
          );
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: result.content,
          });
        }
        this.update("stepCompleted", {
          stepId: BigInt(step),
          stepDurationMs: 0,
        });
        continue;
      }
      if (finishReason === "length" || finishReason === "content_filter")
        throw new ProtocolError(
          "failed_precondition",
          `Impact stopped generation: ${finishReason}.`,
        );
      if (!content && !reasoning)
        throw new ProtocolError(
          "data_loss",
          "Impact returned an empty assistant response.",
        );
      const turnId = await this.put("ConversationTurnStructure", {
        turn: oneof("agentConversationTurn", {
          userMessage: userId,
          steps,
          requestId: request.runId || randomUUID(),
        }),
      });
      const checkpoint = {
        ...state,
        turns: [...(state.turns ?? []), turnId],
        pendingToolCalls: [],
      };
      this.emit({ message: oneof("conversationCheckpointUpdate", checkpoint) });
      this.update("stepCompleted", { stepId: BigInt(step), stepDurationMs: 0 });
      this.update("turnEnded", {
        ...(usage?.prompt_tokens !== undefined
          ? { inputTokens: BigInt(usage.prompt_tokens) }
          : {}),
        ...(usage?.completion_tokens !== undefined
          ? { outputTokens: BigInt(usage.completion_tokens) }
          : {}),
      });
      this.emit({ message: oneof("conversationCheckpointUpdate", checkpoint) });
      this.finish();
      return;
    }
    throw new ProtocolError(
      "resource_exhausted",
      "The agent reached the limit of 64 model steps.",
    );
  }
}

async function write(res: Response, bytes: Buffer) {
  if (res.destroyed || res.writableEnded)
    throw new ProtocolError("canceled", "The editor disconnected.");
  if (!res.write(bytes))
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        res.off("drain", drained);
        res.off("close", closed);
        res.off("error", failed);
      };
      const drained = () => {
        cleanup();
        resolve();
      };
      const closed = () => {
        cleanup();
        reject(new ProtocolError("canceled", "The editor disconnected."));
      };
      const failed = () => {
        cleanup();
        reject(
          new ProtocolError(
            "unavailable",
            "Cannot send the native agent stream.",
          ),
        );
      };
      res.once("drain", drained);
      res.once("close", closed);
      res.once("error", failed);
    });
}
async function unaryInput(
  req: Request,
  wire: CursorWire,
  type: string,
  json: boolean,
) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const bytes of req) {
    size += bytes.length;
    if (size > MAX_BYTES)
      throw new ProtocolError(
        "resource_exhausted",
        "Agent request exceeds 8 MiB.",
      );
    chunks.push(Buffer.from(bytes));
  }
  let bytes = Buffer.concat(chunks);
  // Some Cursor HTTP/1 proxy transports omit their request headers. The gzip
  // signature cannot start a valid protobuf message (wire type 7 is invalid).
  const implicitGzip =
    !req.headers["content-encoding"] &&
    bytes[0] === 0x1f &&
    bytes[1] === 0x8b &&
    bytes[2] === 8;
  if (req.headers["content-encoding"] === "gzip" || implicitGzip)
    bytes = gunzipSync(bytes, { maxOutputLength: MAX_BYTES });
  else if (
    req.headers["content-encoding"] &&
    req.headers["content-encoding"] !== "identity"
  )
    throw new ProtocolError(
      "invalid_argument",
      "Unsupported agent input compression.",
    );
  const implicitJson =
    !json && bytes.subarray(0, 32).toString("utf8").trimStart().startsWith("{");
  return wire.decode(type, bytes, json || implicitJson);
}
async function streamInput(
  req: Request,
  wire: CursorWire,
  type: string,
  json: boolean,
) {
  let input: Native | undefined;
  for await (const item of decodeFrames(req)) {
    if (item.flags === 2) continue;
    if (input)
      throw new ProtocolError(
        "invalid_argument",
        "Expected one agent transport request.",
      );
    input = wire.decode(type, item.payload, json);
  }
  if (!input)
    throw new ProtocolError(
      "invalid_argument",
      "Missing agent transport request.",
    );
  return input;
}

export function createAgentBridge(
  wire: CursorWire,
  connection: Connection,
  modelIds: readonly string[],
) {
  const runs = new Map<string, Run>();
  const all = new Set<Run>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let closed = false;
  const create = () => {
    if (closed)
      throw new ProtocolError(
        "unavailable",
        "The Cursor adapter is shutting down.",
      );
    if (all.size >= MAX_RUNS)
      throw new ProtocolError(
        "resource_exhausted",
        "Too many active Cursor agent runs.",
      );
    const run = new Run(wire, connection, modelIds);
    all.add(run);
    return run;
  };
  const get = (id: string) => {
    if (!id || id.length > 256)
      throw new ProtocolError(
        "invalid_argument",
        "Invalid native agent request ID.",
      );
    let run = runs.get(id);
    if (!run) {
      if (runs.size >= 64) {
        const expired = [...runs].find(([, value]) => value.finished);
        if (!expired)
          throw new ProtocolError(
            "resource_exhausted",
            "Too many native agent transport sessions.",
          );
        clearTimeout(timers.get(expired[0]));
        timers.delete(expired[0]);
        runs.delete(expired[0]);
      }
      run = create();
      runs.set(id, run);
      // Incomplete setup and finished transports cannot retain unbounded state.
      const timer = setTimeout(() => {
        timers.delete(id);
        runs.delete(id);
        all.delete(run!);
        run!.fail(
          new ProtocolError(
            "deadline_exceeded",
            "Native agent transport expired.",
          ),
        );
      }, 660_000);
      timer.unref();
      timers.set(id, timer);
    }
    return run;
  };

  const handleRequest = async (req: Request, res: Response, path: string) => {
    const method = wire.method(path);
    if (!method)
      throw new ProtocolError(
        "unimplemented",
        "This Cursor version does not define the agent transport.",
      );
    const json = String(req.headers["content-type"] ?? "").includes("json");
    if (path.endsWith("/BidiAppend")) {
      const input = await unaryInput(req, wire, method.input, json);
      const run = get(input.requestId?.requestId);
      const payload = input.dataBinary?.length
        ? Buffer.from(input.dataBinary)
        : (() => {
            // A repeated pair regex exceeds JavaScriptCore's match limit on
            // valid multi-megabyte context payloads. Scan once without groups.
            const hex = input.data ?? "";
            if (!hex.length || hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex))
              throw new ProtocolError(
                "invalid_argument",
                "Invalid hexadecimal agent append payload.",
              );
            return Buffer.from(input.data, "hex");
          })();
      try {
        run.append(Number(input.appendSeqno), payload);
      } catch (error) {
        run.fail(error);
        throw error;
      }
      res.writeHead(200, {
        "content-type": json ? "application/json" : "application/proto",
      });
      res.end(wire.encode(method.output, {}, json));
      return;
    }
    let run: Run;
    if (path.endsWith("/Run")) run = create();
    else {
      const input = await streamInput(req, wire, method.input, json);
      run = get(
        path.endsWith("/RunPoll")
          ? input.requestId?.requestId
          : input.requestId,
      );
    }
    if (run.attached)
      throw new ProtocolError(
        "already_exists",
        "This native agent stream already has a consumer.",
      );
    run.attached = true;
    const disconnect = () => {
      if (!res.writableEnded)
        run.fail(new ProtocolError("canceled", "The editor disconnected."));
    };
    res.on("close", disconnect);
    res.writeHead(200, {
      "content-type": json
        ? "application/connect+json"
        : "application/connect+proto",
      "connect-content-encoding": "identity",
    });
    res.flushHeaders?.();
    if (path.endsWith("/Run")) {
      void (async () => {
        try {
          for await (const item of decodeFrames(req)) {
            if (item.flags === 2) continue;
            run.input(wire.decode(CLIENT, item.payload, json));
          }
          if (!run.started)
            throw new ProtocolError(
              "invalid_argument",
              "Missing native agent run request.",
            );
        } catch (error) {
          run.fail(error);
        }
      })();
    }
    try {
      let bytes: Buffer | undefined;
      while ((bytes = await run.take())) {
        const output = path.endsWith("/RunPoll")
          ? wire.encode(
              method.output,
              { seqno: BigInt(run.seqno++), data: bytes.toString("hex") },
              json,
            )
          : json
            ? wire.encode(SERVER, wire.decode(SERVER, bytes), true)
            : bytes;
        await write(res, frame(output));
      }
      if (path.endsWith("/RunPoll") && !run.error)
        await write(
          res,
          frame(
            wire.encode(
              method.output,
              { seqno: BigInt(run.seqno), eof: true },
              json,
            ),
          ),
        );
      res.end(
        endFrame(
          run.error && { code: run.error.code, message: run.error.message },
        ),
      );
    } finally {
      if (!run.finished)
        run.fail(
          new ProtocolError(
            "canceled",
            "The editor stopped consuming the agent stream.",
          ),
        );
      res.off("close", disconnect);
      all.delete(run);
      run.blobs.clear();
      run.pending.clear();
      run.appendBuffer.clear();
      run.output.length = 0;
    }
  };

  return {
    handle(
      req: Request,
      response: ServerResponse | Http2ServerResponse,
      path: string,
    ): boolean {
      const res = response as ServerResponse;
      if (
        ![
          "/agent.v1.AgentService/Run",
          "/agent.v1.AgentService/RunSSE",
          "/agent.v1.AgentService/RunPoll",
          "/aiserver.v1.BidiService/BidiAppend",
        ].includes(path)
      )
        return false;
      void handleRequest(req, res, path).catch((cause) => {
        debugFailure(cause);
        const error = errorOf(cause);
        if (res.destroyed || res.writableEnded) return;
        if (res.headersSent)
          res.end(endFrame({ code: error.code, message: error.message }));
        else {
          res.writeHead(error.code === "resource_exhausted" ? 429 : 400, {
            "content-type": "application/json",
          });
          res.end(JSON.stringify({ code: error.code, message: error.message }));
        }
      });
      return true;
    },
    close() {
      closed = true;
      for (const run of all)
        run.fail(new ProtocolError("canceled", "The Cursor adapter closed."));
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      runs.clear();
      all.clear();
    },
  };
}
