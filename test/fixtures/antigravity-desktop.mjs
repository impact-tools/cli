#!/usr/bin/env node
console.log(JSON.stringify({ args: process.argv.slice(2), devUrl: process.env.DEV_URL, impactKey: process.env.IMPACT_API_KEY,
  proxy: process.env.HTTPS_PROXY, nodeCa: process.env.NODE_EXTRA_CA_CERTS, sslCa: process.env.SSL_CERT_FILE,
}));
