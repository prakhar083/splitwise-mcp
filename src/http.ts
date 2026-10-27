import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export interface HttpOptions {
  host: string;
  port: number;
  /** When set, every request must carry `Authorization: Bearer <token>`. */
  token?: string | undefined;
  /** Builds a fresh MCP server per request (stateless mode). */
  serverFactory: () => McpServer;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

export function isLoopback(host: string): boolean {
  return LOOPBACK.has(host.replace(/^\[|\]$/g, ''));
}

function hostnameOf(hostHeader: string | undefined): string {
  if (!hostHeader) return '';
  const match = /^(\[[^\]]+\]|[^:]+)/.exec(hostHeader);
  return (match?.[1] ?? '').replace(/^\[|\]$/g, '').toLowerCase();
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const presented = Buffer.from(header?.replace(/^Bearer\s+/i, '') ?? '');
  const expected = Buffer.from(token);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

function sendJsonRpcError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(
    JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }),
  );
}

/**
 * Serves MCP over Streamable HTTP at POST /mcp, statelessly: each request gets
 * its own server and transport, so there is no session state to leak between
 * clients. Loopback binds reject foreign Host headers (DNS-rebinding defence);
 * other binds require a bearer token.
 */
export function startHttpServer(options: HttpOptions): Promise<Server> {
  const { host, port, token, serverFactory } = options;
  if (!isLoopback(host) && !token) {
    throw new Error(
      `Refusing to listen on ${host} without authentication: anyone who can reach it could use your Splitwise account. ` +
        'Set SPLITWISE_MCP_HTTP_TOKEN, or bind to 127.0.0.1.',
    );
  }

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path !== '/mcp') return sendJsonRpcError(res, 404, 'Not found. The MCP endpoint is /mcp.');
    if (isLoopback(host) && !isLoopback(hostnameOf(req.headers.host))) {
      return sendJsonRpcError(res, 403, 'Forbidden host.');
    }
    if (token && !tokenMatches(req.headers.authorization, token)) {
      return sendJsonRpcError(res, 401, 'Missing or invalid bearer token.');
    }
    if (req.method !== 'POST') {
      // Stateless mode has no server-initiated streams or sessions to resume or delete.
      res.setHeader('Allow', 'POST');
      return sendJsonRpcError(res, 405, 'Method not allowed.');
    }

    const server = serverFactory();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error('splitwise-mcp: error handling HTTP request:', error);
      if (!res.headersSent) sendJsonRpcError(res, 500, 'Internal server error.');
    }
  };

  const httpServer = createHttpServer((req, res) => void handler(req, res));
  return new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => resolve(httpServer));
  });
}
