type Native = Record<string, any>;

/**
 * Cursor's own agent prompt lives on Cursor's servers; the editor never sends
 * it. This prompt replaces it and describes the native tools this bridge offers.
 */
export const CURSOR_AGENT_PROMPT = [
  "You are an AI coding agent working inside the Cursor editor. You pair-program with the user in the workspace described below.",
  "",
  "Working style:",
  "- Inspect the workspace with tools before you answer questions about its code. Never invent file contents, command output or tool results.",
  "- Make requested changes with the editing tools instead of printing whole files. Use edit_file for targeted changes and write_file for new files or full rewrites.",
  "- Use read_file, grep and list_dir to explore. Use run_terminal_cmd for builds, tests and other commands; the editor applies its approval and sandbox settings.",
  "- Use absolute paths, or paths relative to the first workspace folder.",
  "- Keep going until the task is done, then summarize what changed. Ask only when you cannot proceed safely without the user's decision.",
  "- Reply in the user's language. Be concise and use Markdown; put code in fenced blocks.",
  "",
  "Rules and skills:",
  "- Rules marked as always applied are binding instructions.",
  "- The catalog lists further rules and skills with a short description and the file path. When an entry is relevant to the task, read its file with read_file and follow it before you act. Ignore unrelated entries; do not read them.",
  "- A file-pattern rule applies when you read or change files that match its patterns.",
].join("\n");

const MAX_DESCRIPTION = 1000;
const oneLine = (value: unknown) => {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > MAX_DESCRIPTION ? `${text.slice(0, MAX_DESCRIPTION - 1)}…` : text;
};
const labelOf = (path: string) => {
  const parts = path.split(/[\\/]/).filter(Boolean);
  const file = parts.at(-1) ?? path;
  return /^skill\.md$/i.test(file) ? (parts.at(-2) ?? file) : file.replace(/\.(?:mdc|md)$/i, "");
};
const ruleText = (rule: Native) => `Rule ${rule.fullPath || "(unnamed)"}:\n${rule.content ?? ""}`;

/** Mirrors Cursor's rule semantics: only always-applied rules are inlined. */
export function cursorInstructions(
  context: Native,
  base: string,
  text: (value: Native) => string,
): string {
  const applied: string[] = [];
  const catalog: string[] = [];
  const listed = new Set<string>();
  for (const rule of context.rules ?? []) {
    const type = rule.type?.type;
    const path = String(rule.fullPath ?? "");
    if (type?.case === "global" || rule.isRequired) applied.push(ruleText(rule));
    else if (type?.case === "agentFetched") {
      if (!path || listed.has(path)) continue;
      listed.add(path);
      catalog.push(`- Rule ${labelOf(path)}: ${oneLine(type.value?.description) || "No description."} (${path})`);
    } else if (type?.case === "fileGlobbed") {
      if (!path || listed.has(path)) continue;
      listed.add(path);
      catalog.push(`- Rule ${labelOf(path)} for files matching ${oneLine(type.value?.globs) || "unspecified patterns"} (${path})`);
    }
    // Manually attached rules apply only when the user selects them.
  }
  for (const skill of context.agentSkills ?? []) {
    const path = String(skill.fullPath ?? "");
    // Skills hidden from the model are invoked explicitly by the user.
    if (!path || skill.disableModelInvocation || listed.has(path)) continue;
    listed.add(path);
    catalog.push(`- Skill ${labelOf(path)}: ${oneLine(skill.description) || "No description."} (${path})`);
  }
  const sections = [
    base,
    ...applied.map((rule) => `Always applied ${rule}`),
    ...(context.nonFileRules ?? []).map((rule: Native) => `User rule:\n${rule.content ?? ""}`),
    context.cloudRule ? `Cloud rule:\n${context.cloudRule}` : "",
    context.hooksAdditionalContext ? `Hook context:\n${context.hooksAdditionalContext}` : "",
    ...(context.mcpInstructions ?? []).map((instruction: Native) => `MCP server instructions:\n${text(instruction)}`),
    catalog.length ? `Catalog of rules and skills:\n${catalog.join("\n")}` : "",
    `Workspace environment:\n${JSON.stringify(context.env ?? {})}`,
  ];
  return sections.filter(Boolean).join("\n\n");
}

/** Rules, skills and commands the user attached to this message apply in full. */
export function selectedInstructions(selected: Native | undefined): string[] {
  if (!selected) return [];
  return [
    ...(selected.cursorRules ?? []).map((entry: Native) => entry.rule).filter(Boolean)
      .map((rule: Native) => `Attached ${ruleText(rule)}`),
    ...(selected.selectedSkills ?? []).map((skill: Native) =>
      `Invoked skill ${skill.fullPath || "(unnamed)"}:\n${skill.content ?? ""}`),
    ...(selected.cursorCommands ?? []).map((command: Native) =>
      `Invoked command ${command.displayName || command.name || command.fullPath || "(unnamed)"}:\n${command.content ?? ""}`),
  ];
}
