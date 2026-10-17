import type { AddressInfo } from "node:net";

import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createServer as httpServer, type Server } from "node:http";
import {
  connect,
  createServer as http2Server,
  type Http2Server,
} from "node:http2";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { Redacted } from "effect";
import { afterEach, expect, it } from "vitest";

import { createAgentBridge } from "../src/clients/cursor/Agent.ts";
import { CursorWire, decodeFrames, frame } from "../src/clients/cursor/Wire.ts";

it("accepts a 6.6 MiB hexadecimal BidiAppend under the Bun runtime", async () => {
  const child = spawn(
    process.env.BUN_BIN ?? "bun",
    [
      "--no-env-file",
      fileURLToPath(new URL("./fixtures/cursor-agent-bun.ts", import.meta.url)),
    ],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  try {
    const address = await new Promise<{ port: number; runtime: string }>(
      (resolve, reject) => {
        let output = "";
        const timer = setTimeout(
          () => reject(new Error(`Bun fixture failed to start: ${stderr}`)),
          10_000,
        );
        const failed = (error: Error) => {
          clearTimeout(timer);
          reject(error);
        };
        child.once("error", failed);
        child.once("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`Bun fixture exited ${code}: ${stderr}`));
        });
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          output += chunk;
          if (!output.includes("\n")) return;
          clearTimeout(timer);
          child.off("error", failed);
          try {
            resolve(JSON.parse(output.slice(0, output.indexOf("\n"))));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    expect(address.runtime).toBe("bun");
    // A native heartbeat plus an unknown bytes field is a valid protobuf. Its
    // 3.3 MiB payload expands to the observed 6.6 MiB hexadecimal append size.
    const payloadSize = 3_300_000;
    const varint: number[] = [];
    for (let size = payloadSize; ; size >>>= 7) {
      varint.push((size & 127) | (size > 127 ? 128 : 0));
      if (size <= 127) break;
    }
    const payload = Buffer.concat([
      Buffer.from([0x3a, 0, 0xfa, 7, ...varint]),
      Buffer.alloc(payloadSize, 0xab),
    ]);
    const hex = payload.toString("hex");
    expect(hex.length).toBeGreaterThan(6_500_000);
    const wire = wireFixture();
    const append = async (data: string, requestId: string) => {
      const body = wire.encode("aiserver.v1.BidiAppendRequest", {
        data,
        requestId: { requestId },
        appendSeqno: 0n,
      });
      expect(body.length).toBeLessThan(8 * 1024 * 1024);
      const response = await fetch(
        `http://127.0.0.1:${address.port}/aiserver.v1.BidiService/BidiAppend`,
        {
          method: "POST",
          headers: {
            "content-type": "application/proto",
            "content-encoding": "gzip",
          },
          body: gzipSync(body),
        },
      );
      await response.arrayBuffer();
      return response.status;
    };
    expect(await append(hex, "large-valid-hex")).toBe(200);
    expect(await append(hex.slice(1), "large-odd-hex")).toBe(400);
    expect(await append(`${hex.slice(0, -1)}g`, "large-invalid-hex")).toBe(400);
  } finally {
    const exited =
      child.exitCode !== null || child.signalCode !== null
        ? Promise.resolve()
        : once(child, "exit");
    child.kill("SIGTERM");
    await exited;
  }
}, 30_000);

// Native field numbers and oneof layout; only the fields used by these exchanges
// are included. This fixture runs on CI without an installed proprietary app.
type Field = [number, string, number | string, string?, boolean?];
const messages: Record<string, Field[]> = {
  AgentClientMessage: [
    [1, "run_request", "AgentRunRequest", "message"],
    [2, "exec_client_message", "ExecClientMessage", "message"],
    [3, "kv_client_message", "KvClientMessage", "message"],
    [4, "conversation_action", "ConversationAction", "message"],
    [7, "client_heartbeat", "Empty", "message"],
  ],
  AgentServerMessage: [
    [1, "interaction_update", "InteractionUpdate", "message"],
    [2, "exec_server_message", "ExecServerMessage", "message"],
    [
      3,
      "conversation_checkpoint_update",
      "ConversationStateStructure",
      "message",
    ],
    [4, "kv_server_message", "KvServerMessage", "message"],
  ],
  AgentRunRequest: [
    [1, "conversation_state", "ConversationStateStructure"],
    [2, "action", "ConversationAction"],
    [3, "model_details", "ModelDetails"],
    [5, "conversation_id", 9],
    [8, "custom_system_prompt", 9],
  ],
  ModelDetails: [[1, "model_id", 9]],
  ConversationAction: [
    [1, "user_message_action", "UserMessageAction", "action"],
    [3, "cancel_action", "CancelAction", "action"],
  ],
  CancelAction: [],
  UserMessageAction: [
    [1, "user_message", "UserMessage"],
    [2, "request_context", "RequestContext"],
  ],
  UserMessage: [
    [1, "text", 9],
    [2, "message_id", 9],
    [4, "mode", 5],
  ],
  ConversationStateStructure: [
    [1, "root_prompt_messages_json", 12, undefined, true],
    [2, "turns", 12, undefined, true],
    [4, "pending_tool_calls", 9, undefined, true],
  ],
  ConversationTurnStructure: [
    [1, "agent_conversation_turn", "AgentConversationTurnStructure", "turn"],
  ],
  AgentConversationTurnStructure: [
    [1, "user_message", 12],
    [2, "steps", 12, undefined, true],
    [3, "request_id", 9],
  ],
  ConversationStep: [
    [1, "assistant_message", "AssistantMessage", "message"],
    [2, "tool_call", "ToolCall", "message"],
  ],
  AssistantMessage: [[1, "text", 9]],
  ToolCall: [
    [1, "shell_tool_call", "ShellToolCall", "tool"],
    [5, "read_tool_call", "ReadToolCall", "tool"],
    [8, "edit_tool_call", "EditToolCall", "tool"],
    [9, "ls_tool_call", "LsToolCall", "tool"],
    [4, "grep_tool_call", "GrepToolCall", "tool"],
    [11, "mcp_tool_call", "McpToolCall", "tool"],
    [100, "tool_call_id", 9],
    [101, "started_at_ms", 4],
    [102, "completed_at_ms", 4],
  ],
  InteractionUpdate: [
    [1, "text_delta", "TextDeltaUpdate", "message"],
    [4, "tool_call_started", "ToolCallStartedUpdate", "message"],
    [5, "tool_call_completed", "ToolCallCompletedUpdate", "message"],
    [6, "thinking_delta", "ThinkingDeltaUpdate", "message"],
    [7, "thinking_completed", "Empty", "message"],
    [8, "user_message_appended", "UserMessageAppendedUpdate", "message"],
    [14, "heartbeat", "Empty", "message"],
    [15, "turn_ended", "TurnEndedUpdate", "message"],
    [16, "step_started", "StepUpdate", "message"],
    [17, "step_completed", "StepUpdate", "message"],
  ],
  TextDeltaUpdate: [[1, "text", 9]],
  ThinkingDeltaUpdate: [[1, "text", 9]],
  UserMessageAppendedUpdate: [[1, "user_message", "UserMessage"]],
  ToolCallStartedUpdate: [
    [1, "call_id", 9],
    [2, "tool_call", "ToolCall"],
    [3, "model_call_id", 9],
  ],
  ToolCallCompletedUpdate: [
    [1, "call_id", 9],
    [2, "tool_call", "ToolCall"],
    [3, "model_call_id", 9],
  ],
  TurnEndedUpdate: [
    [1, "input_tokens", 3],
    [2, "output_tokens", 3],
  ],
  StepUpdate: [[1, "step_id", 4]],
  Empty: [],
  ExecServerMessage: [
    [1, "id", 13],
    [15, "exec_id", 9],
    [2, "shell_args", "ShellArgs", "message"],
    [3, "write_args", "WriteArgs", "message"],
    [5, "grep_args", "GrepArgs", "message"],
    [7, "read_args", "ReadArgs", "message"],
    [8, "ls_args", "LsArgs", "message"],
    [10, "request_context_args", "Empty", "message"],
  ],
  ExecClientMessage: [
    [1, "id", 13],
    [15, "exec_id", 9],
    [2, "shell_result", "ShellResult", "message"],
    [3, "write_result", "WriteResult", "message"],
    [5, "grep_result", "GrepResult", "message"],
    [7, "read_result", "ReadResult", "message"],
    [8, "ls_result", "LsResult", "message"],
    [10, "request_context_result", "RequestContextResult", "message"],
  ],
  RequestContextResult: [[1, "success", "RequestContextSuccess", "result"]],
  RequestContextSuccess: [[1, "request_context", "RequestContext"]],
  RequestContext: [[2, "env", "RequestContextEnv"]],
  RequestContextEnv: [
    [2, "workspace_paths", 9, undefined, true],
    [3, "shell", 9],
  ],
  KvServerMessage: [
    [1, "id", 13],
    [2, "get_blob_args", "GetBlobArgs", "message"],
    [3, "set_blob_args", "SetBlobArgs", "message"],
  ],
  KvClientMessage: [
    [1, "id", 13],
    [2, "get_blob_result", "GetBlobResult", "message"],
    [3, "set_blob_result", "SetBlobResult", "message"],
  ],
  GetBlobArgs: [[1, "blob_id", 12]],
  GetBlobResult: [[1, "blob_data", 12]],
  SetBlobArgs: [
    [1, "blob_id", 12],
    [2, "blob_data", 12],
  ],
  SetBlobResult: [],
  ReadArgs: [
    [1, "path", 9],
    [2, "tool_call_id", 9],
    [3, "offset", 5],
    [4, "limit", 13],
  ],
  ReadResult: [[1, "success", "ReadSuccess", "result"]],
  ReadSuccess: [
    [1, "path", 9],
    [2, "content", 9, "output"],
    [4, "total_lines", 5],
    [5, "file_size", 3],
  ],
  ReadToolCall: [
    [1, "args", "ReadArgs"],
    [2, "result", "ReadResult"],
  ],
  WriteArgs: [
    [1, "path", 9],
    [2, "file_text", 9],
    [3, "tool_call_id", 9],
    [4, "return_file_content_after_write", 8],
  ],
  WriteResult: [[1, "success", "WriteSuccess", "result"]],
  WriteSuccess: [[1, "path", 9]],
  EditArgs: [
    [1, "path", 9],
    [2, "stream_content", 9],
  ],
  EditResult: [[1, "success", "EditSuccess", "result"]],
  EditSuccess: [
    [1, "path", 9],
    [6, "after_full_file_content", 9],
  ],
  EditToolCall: [
    [1, "args", "EditArgs"],
    [2, "result", "EditResult"],
  ],
  ShellArgs: [
    [1, "command", 9],
    [2, "working_directory", 9],
    [3, "timeout", 5],
    [4, "tool_call_id", 9],
    [8, "parsing_result", "ShellCommandParsingResult"],
    [13, "skip_approval", 8],
  ],
  ShellCommandParsingResult: [
    [1, "parsing_failed", 8],
    [2, "executable_commands", "ExecutableCommand", undefined, true],
    [3, "has_redirects", 8],
    [4, "has_command_substitution", 8],
  ],
  ExecutableCommand: [
    [1, "name", 9],
    [2, "args", "ExecutableCommandArg", undefined, true],
    [3, "full_text", 9],
  ],
  ExecutableCommandArg: [
    [1, "type", 9],
    [2, "value", 9],
  ],
  ShellResult: [[1, "success", "ShellSuccess", "result"]],
  ShellSuccess: [
    [1, "command", 9],
    [3, "exit_code", 5],
    [5, "stdout", 9],
  ],
  ShellToolCall: [
    [1, "args", "ShellArgs"],
    [2, "result", "ShellResult"],
  ],
  LsArgs: [
    [1, "path", 9],
    [2, "ignore", 9, undefined, true],
    [3, "tool_call_id", 9],
  ],
  LsResult: [[1, "success", "Empty", "result"]],
  LsToolCall: [
    [1, "args", "LsArgs"],
    [2, "result", "LsResult"],
  ],
  GrepArgs: [
    [1, "pattern", 9],
    [2, "path", 9],
    [3, "glob", 9],
    [4, "output_mode", 9],
    [9, "case_insensitive", 8],
    [11, "head_limit", 5],
    [15, "tool_call_id", 9],
  ],
  GrepResult: [[1, "success", "Empty", "result"]],
  GrepToolCall: [
    [1, "args", "GrepArgs"],
    [2, "result", "GrepResult"],
  ],
  McpToolCall: [],
};
const symbols = new Map(
  Object.keys(messages).map((name, index) => [name, `m${index}`]),
);
const declarations = Object.entries(messages)
  .map(
    ([name, fields]) =>
      `${symbols.get(name)}=A.makeMessageType("agent.v1.${name}",()=>[${fields.map(([no, name, type, oneof, repeated]) => `{no:${no},name:${JSON.stringify(name)},kind:"${typeof type === "number" ? "scalar" : "message"}",T:${typeof type === "number" ? type : symbols.get(type)}${oneof ? `,oneof:${JSON.stringify(oneof)}` : ""}${repeated ? ",repeated:!0" : ""}}`).join(",")}])`,
  )
  .join(",");
const wireFixture = () =>
  CursorWire.fromBundle(`${declarations},
  M=A.makeMessageType("aiserver.v1.AvailableModelsResponse",[]),
  B=A.makeMessageType("aiserver.v1.BidiRequestId",()=>[{no:1,name:"request_id",kind:"scalar",T:9}]),
  P=A.makeMessageType("aiserver.v1.BidiPollRequest",()=>[{no:1,name:"request_id",kind:"message",T:B},{no:2,name:"start_request",kind:"scalar",T:8}]),
  O=A.makeMessageType("aiserver.v1.BidiPollResponse",()=>[{no:1,name:"seqno",kind:"scalar",T:3},{no:2,name:"data",kind:"scalar",T:9},{no:3,name:"eof",kind:"scalar",T:8}]),
  A1=A.makeMessageType("aiserver.v1.BidiAppendRequest",()=>[{no:1,name:"data",kind:"scalar",T:9},{no:2,name:"request_id",kind:"message",T:B},{no:3,name:"append_seqno",kind:"scalar",T:3},{no:4,name:"data_binary",kind:"scalar",T:12}]),
  A2=A.makeMessageType("aiserver.v1.BidiAppendResponse",[]),
  service={typeName:"agent.v1.AgentService",methods:{run:{name:"Run",I:${symbols.get("AgentClientMessage")},O:${symbols.get("AgentServerMessage")},kind:K.BiDiStreaming},sse:{name:"RunSSE",I:B,O:${symbols.get("AgentServerMessage")},kind:K.ServerStreaming},poll:{name:"RunPoll",I:P,O:O,kind:K.ServerStreaming}}},
  service2={typeName:"aiserver.v1.BidiService",methods:{append:{name:"BidiAppend",I:A1,O:A2,kind:K.Unary}}}`);

const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});
const listen = async (server: Server | Http2Server) => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};
const startup = async (
  wire: CursorWire,
  reply: (body: any, count: number) => any,
) => {
  const requests: any[] = [];
  const gateway = httpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(body);
      expect(req.url).toBe("/v1/chat/completions");
      expect(req.headers.authorization).toBe("Bearer sk-imp-agent-test");
      res.writeHead(200, { "content-type": "text/event-stream" });
      const result = reply(body, requests.length);
      res.end(
        `data: ${JSON.stringify({ choices: [{ delta: result, finish_reason: result.tool_calls ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
    });
  });
  const baseUrl = await listen(gateway);
  const bridge = createAgentBridge(
    wire,
    { baseUrl, apiKey: Redacted.make("sk-imp-agent-test") },
    ["impact-model"],
  );
  cleanup.push(() => bridge.close());
  const server = http2Server((req, res) => {
    if (!bridge.handle(req, res, req.url!)) res.end();
  });
  const origin = await listen(server);
  return { origin, requests, bridge };
};
const runMessage = (options: any = {}) => ({
  message: {
    case: "runRequest",
    value: {
      modelDetails: { modelId: "impact-model" },
      action: {
        action: {
          case: "userMessageAction",
          value: {
            userMessage: {
              text: "Inspect this project",
              messageId: "user-1",
              mode: 1,
            },
          },
        },
      },
      ...options,
    },
  },
});

const exchange = async (
  wire: CursorWire,
  origin: string,
  request: any,
  blobs = new Map<string, Buffer>(),
  toolReply?: (exec: any) => any,
) => {
  const session = connect(origin);
  cleanup.push(() => session.destroy());
  const stream = session.request({
    ":method": "POST",
    ":path": "/agent.v1.AgentService/Run",
    "content-type": "application/connect+proto",
  });
  stream.on("error", () => {});
  stream.write(frame(wire.encode("agent.v1.AgentClientMessage", request)));
  const events: any[] = [];
  let terminal: any;
  for await (const item of decodeFrames(stream)) {
    if (item.flags === 2) {
      terminal = JSON.parse(item.payload.toString());
      break;
    }
    const event = wire.decode(
      "agent.v1.AgentServerMessage",
      item.payload,
    ).message;
    events.push(event);
    if (event.case === "kvServerMessage") {
      const value = event.value,
        call = value.message;
      const key = Buffer.from(call.value.blobId).toString("hex");
      if (call.case === "setBlobArgs")
        blobs.set(key, Buffer.from(call.value.blobData));
      stream.write(
        frame(
          wire.encode("agent.v1.AgentClientMessage", {
            message: {
              case: "kvClientMessage",
              value: {
                id: value.id,
                message: {
                  case:
                    call.case === "setBlobArgs"
                      ? "setBlobResult"
                      : "getBlobResult",
                  value:
                    call.case === "setBlobArgs"
                      ? {}
                      : { blobData: blobs.get(key) },
                },
              },
            },
          }),
        ),
      );
    }
    if (event.case === "execServerMessage") {
      const exec = event.value;
      const context = {
        case: "requestContextResult",
        value: {
          result: {
            case: "success",
            value: {
              requestContext: {
                env: { workspacePaths: ["/workspace"], shell: "zsh" },
              },
            },
          },
        },
      };
      const result =
        exec.message.case === "requestContextArgs"
          ? context
          : toolReply?.(exec);
      if (result)
        stream.write(
          frame(
            wire.encode("agent.v1.AgentClientMessage", {
              message: {
                case: "execClientMessage",
                value: { id: exec.id, execId: exec.execId, message: result },
              },
            }),
          ),
        );
    }
  }
  stream.end();
  session.destroy();
  return {
    events,
    terminal,
    blobs,
    checkpoint: events.findLast(
      (item) => item.case === "conversationCheckpointUpdate",
    )?.value,
  };
};

it.each([
  "fixture",
  ...(existsSync("/Applications/Cursor.app") ? ["installed"] : []),
])(
  "streams native chat and recovers persisted conversation through KV (%s)",
  async (variant) => {
    const wire =
      variant === "installed"
        ? await CursorWire.load("/Applications/Cursor.app")
        : wireFixture();
    const { origin, requests } = await startup(wire, (_body, count) => ({
      content: `Response ${count}`,
    }));
    const first = await exchange(wire, origin, runMessage());
    expect(first.terminal).toEqual({});
    expect(
      first.events.find(
        (item) =>
          item.case === "interactionUpdate" &&
          item.value.message.case === "textDelta",
      ).value.message.value.text,
    ).toBe("Response 1");
    expect(first.checkpoint.turns).toHaveLength(1);
    const second = await exchange(
      wire,
      origin,
      runMessage({ conversationState: first.checkpoint }),
      first.blobs,
    );
    expect(second.terminal).toEqual({});
    expect(second.checkpoint.turns).toHaveLength(2);
    expect(requests[1].messages.map((m: any) => [m.role, m.content])).toEqual([
      ["system", expect.stringContaining("/workspace")],
      ["user", "Inspect this project"],
      ["assistant", "Response 1"],
      ["user", "Inspect this project"],
    ]);
  },
);

it.each([
  "fixture",
  ...(existsSync("/Applications/Cursor.app") ? ["installed"] : []),
])(
  "executes tools in the editor, matches IDs, and continues generation (%s)",
  async (variant) => {
    const wire =
      variant === "installed"
        ? await CursorWire.load("/Applications/Cursor.app")
        : wireFixture();
    const { origin, requests } = await startup(wire, (_body, count) =>
      count === 1
        ? {
            tool_calls: [
              {
                index: 0,
                id: "read-1",
                function: {
                  name: "read_file",
                  arguments: '{"path":"/workspace/package.json"}',
                },
              },
              {
                index: 1,
                id: "shell-1",
                function: {
                  name: "run_terminal_cmd",
                  arguments: '{"command":"pwd"}',
                },
              },
              {
                index: 2,
                id: "write-1",
                function: {
                  name: "write_file",
                  arguments:
                    '{"path":"/workspace/output.txt","content":"new content"}',
                },
              },
            ],
          }
        : { content: "Finished" },
    );
    const execs: any[] = [];
    const result = await exchange(
      wire,
      origin,
      runMessage(),
      new Map(),
      (exec) => {
        execs.push(exec);
        if (exec.message.case === "readArgs")
          return {
            case: "readResult",
            value: {
              result: {
                case: "success",
                value: {
                  path: exec.message.value.path,
                  output: { case: "content", value: '{"scripts":{}}' },
                  fileSize: 14n,
                  totalLines: 1,
                },
              },
            },
          };
        if (exec.message.case === "shellArgs")
          return {
            case: "shellResult",
            value: {
              result: {
                case: "success",
                value: { command: "pwd", stdout: "/workspace", exitCode: 0 },
              },
            },
          };
        return {
          case: "writeResult",
          value: {
            result: {
              case: "success",
              value: { path: exec.message.value.path },
            },
          },
        };
      },
    );
    expect(result.terminal).toEqual({});
    expect(execs).toHaveLength(3);
    expect(new Set(execs.map((e) => e.id)).size).toBe(3);
    expect(new Set(execs.map((e) => e.execId)).size).toBe(3);
    expect(execs[1].message.value.skipApproval).toBe(false);
    expect(execs[1].message.value.parsingResult.parsingFailed).toBe(false);
    expect(
      execs[1].message.value.parsingResult.executableCommands[0].name,
    ).toBe("pwd");
    expect(execs[2].message.value.fileText).toBe("new content");
    expect(requests).toHaveLength(2);
    expect(
      requests[1].messages
        .filter((m: any) => m.role === "tool")
        .map((m: any) => m.tool_call_id),
    ).toEqual(["read-1", "shell-1", "write-1"]);
    expect(
      result.events.filter(
        (e) =>
          e.case === "interactionUpdate" &&
          e.value.message.case === "toolCallCompleted",
      ),
    ).toHaveLength(3);
  },
);

it("rejects unknown models and tools without falling back to Cursor", async () => {
  const wire = wireFixture();
  const { origin, requests } = await startup(wire, () => ({
    tool_calls: [
      {
        index: 0,
        id: "unknown",
        function: { name: "cloud_agent", arguments: "{}" },
      },
    ],
  }));
  const badModel = await exchange(
    wire,
    origin,
    runMessage({ modelDetails: { modelId: "cursor-only" } }),
  );
  expect(badModel.terminal.error.code).toBe("invalid_argument");
  expect(requests).toHaveLength(0);
  const badTool = await exchange(wire, origin, runMessage());
  expect(badTool.terminal.error.code).toBe("unimplemented");
  expect(requests).toHaveLength(1);
});

it.each([
  "pwd && rm file",
  "echo $(pwd)",
  "printf 'hello' > output",
  "VAR=value command",
])("requires native review for complex shell syntax: %s", async (command) => {
  const wire = wireFixture();
  const { origin } = await startup(wire, (_body, count) =>
    count === 1
      ? {
          tool_calls: [
            {
              index: 0,
              id: "shell-review",
              function: {
                name: "run_terminal_cmd",
                arguments: JSON.stringify({ command }),
              },
            },
          ],
        }
      : { content: "Reviewed" },
  );
  let execution: any;
  const result = await exchange(
    wire,
    origin,
    runMessage(),
    new Map(),
    (exec) => {
      execution = exec;
      return {
        case: "shellResult",
        value: {
          result: {
            case: "success",
            value: { command, exitCode: 0, stdout: "reviewed" },
          },
        },
      };
    },
  );
  expect(result.terminal).toEqual({});
  expect(execution.message.value.parsingResult.parsingFailed).toBe(true);
  expect(execution.message.value.parsingResult.executableCommands).toEqual([]);
  expect(execution.message.value.skipApproval).toBe(false);
});

it.each(["RunSSE", "RunPoll"])(
  "supports %s with hex BidiAppend and out-of-order input",
  async (method) => {
    const wire = wireFixture();
    const { origin } = await startup(wire, () => ({
      content: "Fallback works",
    }));
    const requestId = "fallback-run";
    const input =
      method === "RunSSE"
        ? { requestId }
        : { requestId: { requestId }, startRequest: true };
    const type =
      method === "RunSSE"
        ? "aiserver.v1.BidiRequestId"
        : "aiserver.v1.BidiPollRequest";
    const session = connect(origin);
    cleanup.push(() => session.destroy());
    const stream = session.request({
      ":method": "POST",
      ":path": `/agent.v1.AgentService/${method}`,
      "content-type": "application/connect+proto",
    });
    stream.end(frame(wire.encode(type, input)));
    const append = async (seqno: number, message: any, binary = false) => {
      const bytes = wire.encode("agent.v1.AgentClientMessage", message);
      const request = session.request({
        ":method": "POST",
        ":path": "/aiserver.v1.BidiService/BidiAppend",
        "content-type": "application/proto",
      });
      const encoded = wire.encode("aiserver.v1.BidiAppendRequest", {
        requestId: { requestId },
        appendSeqno: BigInt(seqno),
        ...(binary ? { dataBinary: bytes } : { data: bytes.toString("hex") }),
      });
      // Headerless gzip matches the observed native HTTP/1 proxy transport.
      request.end(binary ? gzipSync(encoded) : encoded);
      const [headers] = await once(request, "response");
      expect(headers[":status"]).toBe(200);
      for await (const _chunk of request) {
        /* consume acknowledgement */
      }
    };
    const initial = runMessage({
      action: {
        action: {
          case: "userMessageAction",
          value: {
            userMessage: { text: "Hello" },
            requestContext: { env: { workspacePaths: ["/workspace"] } },
          },
        },
      },
    });
    let seqno = 1;
    let outputSeqno = 0;
    let text = "";
    let terminal: any;
    const reading = (async () => {
      for await (const item of decodeFrames(stream)) {
        if (item.flags === 2) {
          terminal = JSON.parse(item.payload.toString());
          break;
        }
        let bytes = item.payload;
        if (method === "RunPoll") {
          const wrapper = wire.decode("aiserver.v1.BidiPollResponse", bytes);
          if (wrapper.eof) continue;
          expect(Number(wrapper.seqno)).toBe(outputSeqno++);
          bytes = Buffer.from(wrapper.data, "hex");
        }
        const event = wire.decode("agent.v1.AgentServerMessage", bytes).message;
        if (
          event.case === "interactionUpdate" &&
          event.value.message.case === "textDelta"
        )
          text += event.value.message.value.text;
        if (event.case === "kvServerMessage")
          await append(
            ++seqno,
            {
              message: {
                case: "kvClientMessage",
                value: {
                  id: event.value.id,
                  message: { case: "setBlobResult", value: {} },
                },
              },
            },
            true,
          );
      }
    })();
    await append(1, { message: { case: "clientHeartbeat", value: {} } }, true);
    await append(0, initial);
    await append(0, initial);
    await reading;
    expect(terminal).toEqual({});
    expect(text).toBe("Fallback works");
    session.destroy();
  },
);

it.each([
  "fixture",
  ...(existsSync("/Applications/Cursor.app") ? ["installed"] : []),
])(
  "applies exact edits through native read and write (%s)",
  async (variant) => {
    const wire =
      variant === "installed"
        ? await CursorWire.load("/Applications/Cursor.app")
        : wireFixture();
    const { origin } = await startup(wire, (_body, count) =>
      count === 1
        ? {
            tool_calls: [
              {
                index: 0,
                id: "edit-1",
                function: {
                  name: "edit_file",
                  arguments:
                    '{"path":"/workspace/file","old_text":"before","new_text":"after"}',
                },
              },
            ],
          }
        : { content: "Edited" },
    );
    const execs: any[] = [];
    const result = await exchange(
      wire,
      origin,
      runMessage(),
      new Map(),
      (exec) => {
        execs.push(exec);
        return exec.message.case === "readArgs"
          ? {
              case: "readResult",
              value: {
                result: {
                  case: "success",
                  value: {
                    output: { case: "content", value: "text before text" },
                  },
                },
              },
            }
          : {
              case: "writeResult",
              value: {
                result: { case: "success", value: { path: "/workspace/file" } },
              },
            };
      },
    );
    expect(result.terminal).toEqual({});
    expect(execs.map((exec) => exec.message.case)).toEqual([
      "readArgs",
      "writeArgs",
    ]);
    expect(execs[1].message.value.fileText).toBe("text after text");
  },
);

it("cancels pending execution when the editor cancels a run", async () => {
  const wire = wireFixture();
  const { origin, requests } = await startup(wire, () => ({
    content: "must not be called",
  }));
  const session = connect(origin);
  cleanup.push(() => session.destroy());
  const stream = session.request({
    ":method": "POST",
    ":path": "/agent.v1.AgentService/Run",
    "content-type": "application/connect+proto",
  });
  stream.write(frame(wire.encode("agent.v1.AgentClientMessage", runMessage())));
  let terminal: any;
  for await (const item of decodeFrames(stream)) {
    if (item.flags === 2) {
      terminal = JSON.parse(item.payload.toString());
      break;
    }
    const event = wire.decode(
      "agent.v1.AgentServerMessage",
      item.payload,
    ).message;
    if (event.case === "execServerMessage")
      stream.write(
        frame(
          wire.encode("agent.v1.AgentClientMessage", {
            message: {
              case: "conversationAction",
              value: { action: { case: "cancelAction", value: {} } },
            },
          }),
        ),
      );
  }
  expect(terminal.error.code).toBe("canceled");
  expect(requests).toHaveLength(0);
  stream.end();
  session.destroy();
});

it.skipIf(!existsSync("/Applications/Cursor.app"))(
  "translates MCP schemas and arguments using installed protobuf Value semantics",
  async () => {
    const wire = await CursorWire.load("/Applications/Cursor.app");
    let name: string;
    const { origin, requests } = await startup(wire, (body, count) => {
      name = body.tools.find((tool: any) =>
        tool.function.name.startsWith("mcp_"),
      ).function.name;
      return count === 1
        ? {
            tool_calls: [
              {
                index: 0,
                id: "mcp-1",
                function: {
                  name,
                  arguments: '{"text":"hello","nested":{"enabled":true}}',
                },
              },
            ],
          }
        : { content: "MCP complete" };
    });
    const mcp = {
      name: "example/echo",
      providerIdentifier: "example",
      toolName: "echo",
      description: "Echo input",
      inputSchemaJson:
        '{"type":"object","properties":{"text":{"type":"string"},"nested":{"type":"object"}}}',
    };
    let execution: any;
    const result = await exchange(
      wire,
      origin,
      runMessage({ mcpTools: { mcpTools: [mcp] } }),
      new Map(),
      (exec) => {
        execution = exec;
        return {
          case: "mcpResult",
          value: {
            result: { case: "success", value: { content: [], isError: false } },
          },
        };
      },
    );
    expect(result.terminal).toEqual({});
    expect(execution.message.case).toBe("mcpArgs");
    expect(execution.message.value.skipApproval).toBe(false);
    expect(execution.message.value.args.text.toJson()).toBe("hello");
    expect(execution.message.value.args.nested.toJson()).toEqual({
      enabled: true,
    });
    expect(requests).toHaveLength(2);
  },
);
