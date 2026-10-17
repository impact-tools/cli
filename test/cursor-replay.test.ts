import { expect, it } from "vitest";
import { packCursorReplay, type ImpactChatRequest } from "../src/clients/cursor/Impact.ts";

it("packs oversized Grok references into the active message without dropping history", () => {
  const context = "x".repeat(1_337_078);
  const request: ImpactChatRequest = { model: "grok-4.7", messages: [
    { role: "system", content: "Follow the rules" },
    { role: "user", content: context },
    { role: "assistant", content: null, tool_calls: [{ id: "read-1", function: { name: "read_file", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "read-1", content: "file contents" },
    { role: "user", content: "Explain the file" },
  ] };
  const packed = packCursorReplay(request);
  expect(packed.messages).toHaveLength(2);
  expect(packed.messages[0]).toEqual(request.messages[0]);
  const active = packed.messages[1]!.content as string;
  expect(active).toContain(context);
  expect(active).toContain('"tool_call_id":"read-1"');
  expect(active).toContain("file contents");
  expect(active.endsWith("Explain the file")).toBe(true);
  expect(request.messages).toHaveLength(5);
});

it("packs message-count overflow and continuation after a tool result", () => {
  const request: ImpactChatRequest = { model: "grok-4.7", messages: [
    ...Array.from({ length: 193 }, (_, index) => ({ role: "user" as const, content: `Turn ${index}` })),
    { role: "tool", tool_call_id: "last", content: "done" },
  ] };
  const packed = packCursorReplay(request);
  expect(packed.messages).toHaveLength(1);
  expect(packed.messages[0]!.content).toContain("Turn 0");
  expect(packed.messages[0]!.content).toContain("Turn 192");
  expect(packed.messages[0]!.content).toContain('"tool_call_id":"last"');
});

it("preserves native tool messages for other models and small Grok requests", () => {
  const request: ImpactChatRequest = { model: "grok-4.7", messages: [{ role: "user", content: "Hi" }] };
  expect(packCursorReplay(request)).toBe(request);
  const other = { ...request, model: "gpt-6.1-sol" };
  expect(packCursorReplay(other)).toBe(other);
});
