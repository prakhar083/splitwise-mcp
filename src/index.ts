#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { startHttpServer } from './http.js';
import { SplitwiseClient, createServer } from './server.js';
import { VERSION } from './version.js';

const USAGE = `splitwise-mcp ${VERSION}: MCP server for Splitwise

Usage:
  splitwise-mcp                 Serve over stdio (what Claude Desktop, Claude Code and Cursor expect)
  splitwise-mcp --http          Serve over Streamable HTTP at http://127.0.0.1:3000/mcp

Options:
  --http                Use the Streamable HTTP transport instead of stdio
  --port <n>            HTTP port (default 3000, or $PORT)
  --host <addr>         HTTP bind address (default 127.0.0.1)
  -h, --help            Show this help
  -v, --version         Show the version

Environment:
  SPLITWISE_API_KEY           Required. Personal API key from https://secure.splitwise.com/apps
  SPLITWISE_READ_ONLY=true    Register only read tools; nothing can be created, edited or deleted
  SPLITWISE_MCP_HTTP_TOKEN    Bearer token required by --http (mandatory when binding beyond localhost)
`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      http: { type: 'boolean', default: false },
      port: { type: 'string' },
      host: { type: 'string', default: '127.0.0.1' },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  });
  if (values.help) return void process.stdout.write(USAGE);
  if (values.version) return void process.stdout.write(`${VERSION}\n`);

  const config = loadConfig();
  // One client for the process, so the current-user lookup is cached across requests.
  const client = new SplitwiseClient({ apiKey: config.apiKey, ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}) });
  const serverFactory = () => createServer({ client, readOnly: config.readOnly });
  const mode = config.readOnly ? ' (read-only)' : '';

  if (values.http) {
    const port = Number(values.port ?? process.env.PORT ?? 3000);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid port: ${values.port ?? process.env.PORT}`);
    const token = process.env.SPLITWISE_MCP_HTTP_TOKEN?.trim() || undefined;
    const server = await startHttpServer({ host: values.host, port, token, serverFactory });
    const address = server.address();
    const shownPort = typeof address === 'object' && address ? address.port : port;
    console.error(`splitwise-mcp ${VERSION}${mode} listening on http://${values.host}:${shownPort}/mcp`);
    return;
  }

  // stdout carries the protocol in stdio mode; all logging goes to stderr.
  await serverFactory().connect(new StdioServerTransport());
  console.error(`splitwise-mcp ${VERSION}${mode} running on stdio`);
}

main().catch((error: unknown) => {
  console.error(`splitwise-mcp: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
