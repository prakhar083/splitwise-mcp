# splitwise-mcp

[![CI](https://github.com/prakhar083/splitwise-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/prakhar083/splitwise-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

An [MCP](https://modelcontextprotocol.io) server for [Splitwise](https://www.splitwise.com). Claude Desktop, Claude Code, Cursor and any other MCP client can use it to read balances, log expenses, split bills and record settle-ups, all from a plain-language request.

> "Add the 86.40 dinner to Lisbon Trip. Sam paid, split it between me, Sam and Alex Kim."

It does three things carefully:

- **Money is exact.** Amounts are parsed and split in integer minor units (cents, paise, yen), never floats. Shares always add up to the cost, to the cent, and rounding is deterministic.
- **People are named, not numbered.** Tools take "Sam", "alex kim" or "me" as well as Splitwise ids. When a name is ambiguous, the tool returns the candidates and the model asks you which one you meant. It never guesses.
- **Writes are guarded.** `SPLITWISE_READ_ONLY=true` removes every mutating tool from the server. Mutating tools carry MCP `destructiveHint` / `idempotentHint` annotations so clients can prompt before running them.

## Example

> **You:** What do people owe me, and settle up Alex Kim's balance, he paid me back in cash.

The model calls:

1. `get_balances` →

   ```json
   {
     "owes_you": [
       { "friend": "Alex Kim", "friend_id": 2, "amount": "42.50", "currency": "USD" },
       { "friend": "Sam Patel", "friend_id": 4, "amount": "10.00", "currency": "USD" }
     ],
     "you_owe": [{ "friend": "Alex Wu", "friend_id": 3, "amount": "12.25", "currency": "USD" }],
     "totals": [{ "currency": "USD", "owed_to_you": "52.50", "you_owe": "12.25", "net": "40.25" }]
   }
   ```

2. `settle_up { "from": "Alex Kim", "to": "me" }`. With no amount, it settles the full outstanding balance →

   ```json
   { "recorded": "Alex Kim paid Riya Sharma 42.50 USD", "payment": { "id": 9999, "payment": true, "...": "..." } }
   ```

> **Claude:** Alex Kim owes you $42.50 and Sam Patel owes you $10.00; you owe Alex Wu $12.25, so you're up $40.25 overall. I've recorded Alex Kim's $42.50 cash payment, so he's settled.

And when a name is ambiguous:

> **You:** Split the $30 cab with Alex.
>
> `create_expense` → error: `"Alex" matches more than one person: Alex Kim (id 2), Alex Wu (id 3). Ask which one is meant, then pass the id or a fuller name.`
>
> **Claude:** You have two friends named Alex, Alex Kim and Alex Wu. Which one shared the cab?

## Install

You need Node.js 20 or newer and a Splitwise API key.

**Get an API key:** sign in at [secure.splitwise.com/apps](https://secure.splitwise.com/apps), register an app (any name and URL will do for personal use), and copy the **API key** from the app page. The key acts as your account, so treat it like a password.

### Claude Desktop

Edit `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "splitwise": {
      "command": "npx",
      "args": ["-y", "github:prakhar083/splitwise-mcp"],
      "env": {
        "SPLITWISE_API_KEY": "your-api-key"
      }
    }
  }
}
```

Restart Claude Desktop.

### Claude Code

```sh
claude mcp add --transport stdio --env SPLITWISE_API_KEY=your-api-key splitwise -- npx -y github:prakhar083/splitwise-mcp
```

Add `--scope user` to make it available in every project.

### Cursor

Add to `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "splitwise": {
      "command": "npx",
      "args": ["-y", "github:prakhar083/splitwise-mcp"],
      "env": {
        "SPLITWISE_API_KEY": "your-api-key"
      }
    }
  }
}
```

### Streamable HTTP

For clients that connect over HTTP instead of stdio:

```sh
SPLITWISE_API_KEY=your-api-key npx -y github:prakhar083/splitwise-mcp --http --port 3000
# MCP endpoint: http://127.0.0.1:3000/mcp
```

The HTTP server is stateless and binds to `127.0.0.1` by default, rejecting requests whose `Host` header is not loopback (DNS-rebinding defence). Set `SPLITWISE_MCP_HTTP_TOKEN` to require `Authorization: Bearer <token>`. The server refuses to bind to a non-loopback address such as `--host 0.0.0.0` unless a token is set.

## Tools

| Tool | What it does | Writes |
| --- | --- | --- |
| `get_current_user` | Your account: id, name, email, default currency. | |
| `list_groups` | Groups with member names and your balance in each. | |
| `get_group` | One group's members, their balances, and who owes whom inside it. | |
| `list_friends` | Friends with your overall balance with each, per currency. | |
| `get_balances` | Net who-owes-whom: friends who owe you, friends you owe, totals per currency. With `group`, the debts inside that group. | |
| `list_expenses` | Expenses and payments, newest first. Filter by `group`, `friend`, `dated_after`, `dated_before`; page with `limit` / `offset`. | |
| `get_expense` | One expense with every person's paid and owed share. | |
| `search_expenses` | Finds expenses whose description or notes contain every query word (case- and accent-insensitive). | |
| `create_expense` | Adds an expense. Group or non-group, any payer, split `equal`, `exact` or `percentage`. | yes |
| `update_expense` | Edits fields you pass. Changing only the cost rescales everyone's shares proportionally. | yes (destructive, idempotent) |
| `delete_expense` | Deletes an expense or payment. | yes (destructive, idempotent) |
| `settle_up` | Records a payment between two people. Omit `amount` to settle the full outstanding balance. | yes |

Wherever a tool takes a person or group, it accepts an id or a name. Names match case- and accent-insensitively, in tiers: exact full name or email, then an exact first or last name, then prefixes ("alex k"), then substrings, then small typos for names longer than three letters ("jonathon", "patle"). The first tier with any match wins. If that tier has several matches, the tool returns an error listing them instead of picking one.

`create_expense` splits look like this:

```jsonc
{ "type": "equal" }                                   // all group members
{ "type": "equal", "participants": ["me", "Sam"] }    // just these people
{ "type": "exact", "shares": [{ "user": "me", "amount": "12.40" }, { "user": "Sam", "amount": "7.60" }] }
{ "type": "percentage", "shares": [{ "user": "me", "percent": 60 }, { "user": "Sam", "percent": 40 }] }
```

The payer (`paid_by`, default `me`) does not need to be one of the people sharing the cost.

## Read-only mode

```json
"env": { "SPLITWISE_API_KEY": "your-api-key", "SPLITWISE_READ_ONLY": "true" }
```

In read-only mode `create_expense`, `update_expense`, `delete_expense` and `settle_up` are never registered. The model cannot see them or call them, whatever the prompt says. Use this when you only want questions answered, or while you evaluate the server.

## How split rounding works

A $100.00 bill split three ways cannot be $33.33 each: that totals $99.99. Splitwise rejects shares that don't add up to the cost, and silently fudging a cent is how ledgers drift. This server:

1. **Parses amounts as decimal strings into integer minor units** (`"100.00"` USD → `10000n`), using the currency's real precision from ICU: 2 decimals for USD and EUR, 0 for JPY and KRW, 3 for KWD and BHD. Input with more precision than the currency allows (`10.005 USD`) is an error, not a silent rounding. Ambiguous input like `1,5` is rejected rather than read as 1.5 or 15.
2. **Allocates with the largest-remainder method.** Each person gets `floor(total × weight / Σweights)`. The few leftover units go one each to the largest fractional remainders, with ties going to whoever is listed first.

So:

| Split | Result |
| --- | --- |
| $100.00 equally, 3 people | 33.34, 33.33, 33.33 (first listed absorbs the cent) |
| $10.01 equally, 3 people | 3.34, 3.34, 3.33 |
| $9.99 at 60% / 40% | 5.99, 4.00 (40% has the larger remainder, 0.6 vs 0.4) |
| $100.00 at 33.3333 / 33.3333 / 33.3334 % | 33.33, 33.33, 33.34 |
| ¥1000 equally, 3 people | 334, 333, 333 |

Percentages must total exactly 100 (up to four decimal places); exact shares must total the cost to the minor unit, and the error says how far off they are (`short by 0.50 USD`). Editing only an expense's cost re-runs the same allocation using the existing shares as weights, so a 25/75 split stays 25/75.

The test suite checks these invariants with seeded, property-style tests over thousands of random totals, party sizes and weights: shares always sum to the total, equal shares never differ by more than one unit, and every share is within one unit of its exact proportion.

## Errors

Splitwise failures come back as tool results the model can explain:

- **401**: the API key is wrong or revoked.
- **403 with "Pro subscription"**: Splitwise requires an active Splitwise Pro subscription on the account that registered the API key for some API access. The error says so plainly, and confirms nothing was changed.
- **403 otherwise**: you are probably not a member of that group or expense.
- **429**: rate limited. Reads are retried once automatically when `Retry-After` is 10 seconds or less; otherwise the error includes the wait time. Writes are never retried automatically.
- **Validation errors**: Splitwise often answers HTTP 200 with an `errors` object. These are surfaced field by field (`Splitwise rejected the request: date: is not a date`).

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `SPLITWISE_API_KEY` | (required) | Personal API key from [secure.splitwise.com/apps](https://secure.splitwise.com/apps). |
| `SPLITWISE_READ_ONLY` | `false` | `true` registers read tools only. |
| `SPLITWISE_MCP_HTTP_TOKEN` | (unset) | Bearer token required by `--http`. Mandatory for non-loopback binds. |
| `SPLITWISE_BASE_URL` | `https://secure.splitwise.com/api/v3.0` | Override the API base, e.g. for a proxy. |

CLI flags: `--http`, `--port <n>` (default 3000 or `$PORT`), `--host <addr>` (default `127.0.0.1`), `--help`, `--version`.

## Security

- The API key grants full access to your Splitwise account. Keep it in your MCP client's `env` config, not in prompts, repositories or shared dotfiles. If it leaks, delete the app at [secure.splitwise.com/apps](https://secure.splitwise.com/apps) to revoke it.
- The server only ever sends the key to Splitwise, as an `Authorization: Bearer` header over HTTPS. It does not log it and stores nothing on disk.
- Tool results contain your financial data and go to whichever model your client uses. Use read-only mode if you don't want a model able to change anything.
- In HTTP mode, anyone who can reach the endpoint acts as you. Keep it on loopback or set `SPLITWISE_MCP_HTTP_TOKEN`.

## Development

```sh
git clone https://github.com/prakhar083/splitwise-mcp.git
cd splitwise-mcp
npm install
npm test            # vitest: unit tests plus an in-memory MCP client/server suite
npm run typecheck
npm run build       # emits dist/
```

The tests never touch the real Splitwise API: `test/fixtures.ts` serves a small fictional dataset through a mocked `fetch`.

To try a local build in a client, point it at `node /absolute/path/to/splitwise-mcp/dist/index.js`, or inspect it with the [MCP Inspector](https://github.com/modelcontextprotocol/inspector):

```sh
SPLITWISE_API_KEY=your-api-key npx @modelcontextprotocol/inspector node dist/index.js
```

Layout:

```
src/
  index.ts          CLI: stdio or --http
  server.ts         createServer(): registers tools, honours read-only mode
  http.ts           Streamable HTTP transport with host and token checks
  money.ts          minor-unit parsing, formatting, largest-remainder allocation
  resolve.ts        fuzzy name resolution with disambiguation
  expenses.ts       split specs to Splitwise users__N__ shares
  format.ts         compact, model-friendly views of API objects
  tools/            read and write tool definitions
  splitwise/        typed v3.0 client and error mapping
```

## License

[MIT](LICENSE) © 2026 Prakhar Vijay
