#!/usr/bin/env node
import { createServer } from 'node:http';
console.log(JSON.stringify({ pid: process.pid, gateway: process.env.AGY_LLM_GATEWAY_URL, impactKey: process.env.IMPACT_API_KEY }));
const server = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  res.setHeader('content-type', 'application/json');
  if (req.url.endsWith('/GetUserStatus')) return res.end(JSON.stringify({ userStatus: { name: 'preserved' } }));
  res.end(body || '{}');
});
server.listen(0, '127.0.0.1', () => console.log(`listening on random port at ${server.address().port} for HTTP`));
process.stdin.resume();
process.stdin.once('end', () => server.close());
