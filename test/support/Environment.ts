import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";

/** A fresh directory for Impact credentials and the client homes, and `process.env` restored after each test. */
export function isolatedEnvironment() {
  const state = { directory: "" };
  const previous = { ...process.env };
  beforeEach(async () => {
    state.directory = await mkdtemp(join(tmpdir(), "impact-cli-test-"));
    for (const name of Object.keys(process.env))
      if (
        name.startsWith("IMPACT_") ||
        name.startsWith("ANTHROPIC_") ||
        name.startsWith("CLAUDE_CODE_") ||
        name.startsWith("KILO_") ||
        name.startsWith("OPENCODE_")
      )
        delete process.env[name];
    process.env.IMPACT_CONFIG_DIR = state.directory;
    process.env.CODEX_HOME = state.directory;
    process.env.CLAUDE_CONFIG_DIR = state.directory;
  });
  afterEach(async () => {
    process.env = { ...previous };
    await rm(state.directory, { recursive: true, force: true });
  });
  return state;
}
