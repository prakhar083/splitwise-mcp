import type { AddressInfo } from 'node:net';
import { type Server, request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { isLoopback, startHttpServer } from '../src/http.js';
import { createServer } from '../src/server.js';
import { fakeSplitwise } from './fixtures.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

async function start(token?: string) {
  const fake = fakeSplitwise();
  const server = await startHttpServer({
    host: '127.0.0.1',
    port: 0,
    token,
    serverFactory: () => createServer({ client: { apiKey: 'k', fetch: fake.fetch } }),
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'http-test', version: '1.0.0' } },
};

type Json = any;

function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });
}

describe('Streamable HTTP transport', () => {
  it('answers initialize and tools/list statelessly', async () => {
    const base = await start();
    const init = await post(`${base}/mcp`, initialize);
    expect(init.status).toBe(200);
    expect(((await init.json()) as Json).result.serverInfo.name).toBe('splitwise-mcp');

    const list = await post(`${base}/mcp`, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = ((await list.json()) as Json).result.tools as { name: string }[];
    expect(tools.map((t) => t.name)).toContain('create_expense');
  });

  it('calls a tool over HTTP', async () => {
    const base = await start();
    const res = await post(`${base}/mcp`, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'get_current_user', arguments: {} },
    });
    const body = (await res.json()) as Json;
    expect(JSON.parse(body.result.content[0].text).name).toBe('Riya Sharma');
  });

  it('only serves /mcp and only POST', async () => {
    const base = await start();
    expect((await post(`${base}/other`, initialize)).status).toBe(404);
    expect((await fetch(`${base}/mcp`)).status).toBe(405);
  });

  it('rejects foreign Host headers on a loopback bind', async () => {
    // fetch() will not let us forge Host, so use a raw request, as a DNS-rebinding page effectively would.
    const base = new URL(await start());
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(
        { host: base.hostname, port: base.port, path: '/mcp', method: 'POST', headers: { Host: 'evil.example.com', 'Content-Type': 'application/json' } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify(initialize));
    });
    expect(status).toBe(403);
  });

  it('enforces the bearer token when configured', async () => {
    const base = await start('s3cret');
    expect((await post(`${base}/mcp`, initialize)).status).toBe(401);
    expect((await post(`${base}/mcp`, initialize, { Authorization: 'Bearer wrong!' })).status).toBe(401);
    expect((await post(`${base}/mcp`, initialize, { Authorization: 'Bearer s3cret' })).status).toBe(200);
  });

  it('refuses to listen beyond loopback without a token', () => {
    expect(() =>
      startHttpServer({ host: '0.0.0.0', port: 0, serverFactory: () => createServer({ client: { apiKey: 'k' } }) }),
    ).toThrow(/Refusing to listen on 0.0.0.0 without authentication/);
  });

  it('recognises loopback addresses', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('[::1]')).toBe(true);
    expect(isLoopback('localhost')).toBe(true);
    expect(isLoopback('0.0.0.0')).toBe(false);
  });
});
