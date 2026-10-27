import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SplitwiseClient, type SplitwiseClientOptions } from './splitwise/client.js';
import { registerReadTools } from './tools/read.js';
import { Directory } from './tools/shared.js';
import { registerWriteTools } from './tools/write.js';
import { VERSION } from './version.js';

export interface ServerOptions {
  /** A ready client, or options to build one. */
  client: SplitwiseClient | SplitwiseClientOptions;
  /** When true, tools that change data are not registered at all. */
  readOnly?: boolean;
}

export const READ_TOOLS = [
  'get_current_user',
  'list_groups',
  'get_group',
  'list_friends',
  'get_balances',
  'list_expenses',
  'get_expense',
  'search_expenses',
] as const;

export const WRITE_TOOLS = ['create_expense', 'update_expense', 'delete_expense', 'settle_up'] as const;

const INSTRUCTIONS = `Tools for the user's Splitwise account.
- People and groups can be referenced by id or by name; "me" is the account owner.
- If a tool reports that a name is ambiguous, ask the user which person or group they meant. Do not guess.
- Amounts are decimal strings in the expense's currency. Balances: positive means the other person owes the user.
- Before update_expense, delete_expense or settle_up, confirm the details with the user.`;

export function createServer(options: ServerOptions): McpServer {
  const client = options.client instanceof SplitwiseClient ? options.client : new SplitwiseClient(options.client);
  const server = new McpServer(
    { name: 'splitwise-mcp', version: VERSION },
    {
      instructions: options.readOnly
        ? `${INSTRUCTIONS}\n- This server is in read-only mode: it cannot create, edit or delete anything.`
        : INSTRUCTIONS,
    },
  );
  const dir = new Directory(client);
  registerReadTools(server, dir);
  if (!options.readOnly) registerWriteTools(server, dir);
  return server;
}

export { SplitwiseClient } from './splitwise/client.js';
export { SplitwiseError, SplitwiseValidationError } from './splitwise/errors.js';
