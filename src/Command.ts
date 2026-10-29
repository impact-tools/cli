import { Command } from "effect/cli";

import { CLIENTS } from "./clients/Launch.ts";
import { login, logout } from "./commands/Auth.ts";
import { clientCommand } from "./commands/Client.ts";
import { doctor } from "./commands/Doctor.ts";
import { helper, legacyAuth } from "./commands/Helper.ts";
import { mcp } from "./commands/Mcp.ts";
import { proxy } from "./commands/Proxy.ts";
import { status } from "./commands/Status.ts";

export const command = Command.make("impact").pipe(
  Command.withDescription("Coding clients through Impact LLM"),
  Command.withSubcommands([
    { group: "Start a client", commands: CLIENTS.map(clientCommand) },
    {
      group: "Account",
      commands: [
        login.pipe(Command.withShortDescription("Sign in or import a key")),
        status.pipe(Command.withShortDescription("Wallet balance and spend")),
        logout.pipe(Command.withShortDescription("Remove local login")),
      ],
    },
    { group: "Diagnostics", commands: [doctor.pipe(Command.withShortDescription("Connection and installed clients"))] },
    { group: "Connections", commands: [proxy, mcp] },
    helper,
    legacyAuth,
  ]),
);
