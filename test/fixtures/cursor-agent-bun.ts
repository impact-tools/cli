import { createServer } from "node:http";
import { Redacted } from "effect";

import { createAgentBridge } from "../../src/clients/cursor/Agent.ts";
import { CursorWire } from "../../src/clients/cursor/Wire.ts";

const wire = CursorWire.fromBundle(`
  E=A.makeMessageType("test.Empty",[]),
  C=A.makeMessageType("agent.v1.AgentClientMessage",()=>[{no:7,name:"client_heartbeat",kind:"message",T:E,oneof:"message"}]),
  S=A.makeMessageType("agent.v1.AgentServerMessage",[]),
  M=A.makeMessageType("aiserver.v1.AvailableModelsResponse",[]),
  R=A.makeMessageType("aiserver.v1.BidiRequestId",()=>[{no:1,name:"request_id",kind:"scalar",T:9}]),
  I=A.makeMessageType("aiserver.v1.BidiAppendRequest",()=>[{no:1,name:"data",kind:"scalar",T:9},{no:2,name:"request_id",kind:"message",T:R},{no:3,name:"append_seqno",kind:"scalar",T:3}]),
  O=A.makeMessageType("aiserver.v1.BidiAppendResponse",[]),
  service={typeName:"aiserver.v1.BidiService",methods:{append:{name:"BidiAppend",I:I,O:O,kind:K.Unary}}};
`);
const bridge = createAgentBridge(
  wire,
  {
    baseUrl: "http://127.0.0.1:1",
    apiKey: Redacted.make("sk-imp-unused"),
  },
  [],
);
const server = createServer((request, response) => {
  if (!bridge.handle(request, response, request.url!)) {
    response.writeHead(404);
    response.end();
  }
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test server port");
  process.stdout.write(
    JSON.stringify({ port: address.port, runtime: "bun" }) + "\n",
  );
});
const close = () => {
  bridge.close();
  server.closeAllConnections();
  server.close(() => process.exit(0));
};
process.once("SIGTERM", close);
process.once("SIGINT", close);
