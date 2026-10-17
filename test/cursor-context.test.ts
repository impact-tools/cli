import { expect, it } from "vitest";
import { prepareAgentContext } from "../src/clients/cursor/Agent.ts";
import { CURSOR_AGENT_PROMPT, cursorInstructions, selectedInstructions } from "../src/clients/cursor/Instructions.ts";
import type { ChatMessage } from "../src/clients/cursor/Impact.ts";

const text = (value: any) => String(value.content ?? "");

// Cursor 3.16.17 sends each installed skill twice: as an agent-fetched rule and
// as an agent skill, both with the complete SKILL.md (about 3 MB for 165 skills).
it("lists on-demand rules and skills once instead of inlining every file", () => {
  const skillBody = (index: number) => `SKILL-BODY-${index} ${"x".repeat(9_000)}`;
  const skills = Array.from({ length: 165 }, (_, index) => ({
    fullPath: `/Users/admin/.claude/skills/skill-${index}/SKILL.md`,
    content: skillBody(index),
    description: `Use skill ${index} for task ${index}.`,
  }));
  const context = {
    rules: [
      ...skills.map((skill) => ({ fullPath: skill.fullPath, content: skill.content, type: { type: { case: "agentFetched", value: { description: skill.description } } } })),
      { fullPath: "/workspace/.cursor/rules/always.mdc", content: "ALWAYS-RULE-BODY", type: { type: { case: "global", value: {} } } },
      { fullPath: "/workspace/.cursor/rules/typescript.mdc", content: "GLOB-RULE-BODY", type: { type: { case: "fileGlobbed", value: { globs: "*.ts" } } } },
      { fullPath: "/workspace/.cursor/rules/manual.mdc", content: "MANUAL-RULE-BODY", type: { type: { case: "manuallyAttached", value: {} } } },
    ],
    agentSkills: [
      ...skills,
      { fullPath: "/Users/admin/.cursor/skills/hidden/SKILL.md", content: "HIDDEN-SKILL-BODY", description: "Hidden", disableModelInvocation: true },
    ],
    nonFileRules: [{ content: "USER-RULE-BODY" }],
    env: { workspacePaths: ["/workspace"], shell: "zsh" },
  };
  const system = cursorInstructions(context, CURSOR_AGENT_PROMPT, text);
  expect(system.length).toBeLessThan(64 * 1024);
  expect(system).toContain(CURSOR_AGENT_PROMPT);
  expect(system).toContain("ALWAYS-RULE-BODY");
  expect(system).toContain("USER-RULE-BODY");
  expect(system).toContain('"workspacePaths":["/workspace"]');
  expect(system).toContain("for files matching *.ts (/workspace/.cursor/rules/typescript.mdc)");
  expect(system).not.toMatch(/SKILL-BODY|GLOB-RULE-BODY|MANUAL-RULE-BODY|HIDDEN-SKILL|manual\.mdc/);
  for (const skill of skills) expect(system.split(`(${skill.fullPath})`)).toHaveLength(2);
  expect(system).toContain("- Rule skill-7: Use skill 7 for task 7. (/Users/admin/.claude/skills/skill-7/SKILL.md)");
});

it("applies rules, skills and commands that the user attached in full", () => {
  const attached = selectedInstructions({
    cursorRules: [{ rule: { fullPath: "/workspace/.cursor/rules/manual.mdc", content: "MANUAL-RULE-BODY" } }],
    selectedSkills: [{ fullPath: "/skills/review/SKILL.md", content: "REVIEW-SKILL-BODY" }],
    cursorCommands: [{ name: "deploy", content: "DEPLOY-COMMAND-BODY" }],
  }).join("\n");
  expect(attached).toContain("MANUAL-RULE-BODY");
  expect(attached).toContain("REVIEW-SKILL-BODY");
  expect(attached).toContain("Invoked command deploy:\nDEPLOY-COMMAND-BODY");
});

it("keeps one system message and preserves history and attached files", () => {
  const system = "Current instructions";
  const previous = `Historical instructions\n${"a".repeat(1_337_078)}`;
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "system", content: previous },
    { role: "user", content: "Previous question" },
    { role: "assistant", content: "Previous answer" },
  ];
  prepareAgentContext(messages, system, "File: /workspace/a.ts\nconst a = 1;");
  expect(messages.map((message) => message.role)).toEqual(["system", "user", "user", "assistant", "user"]);
  expect(messages[0]!.content).toBe(system);
  expect(messages[1]!.content).toContain(previous);
  expect(messages[4]!.content).toContain("const a = 1;");
  const empty: ChatMessage[] = [];
  prepareAgentContext(empty, system, "");
  expect(empty).toEqual([{ role: "system", content: system }]);
});

it("reports oversized instructions without silently truncating them", () => {
  expect(() => prepareAgentContext([], "a".repeat(1_048_577), "files"))
    .toThrow("Cursor instructions exceed the provider limit");
});
