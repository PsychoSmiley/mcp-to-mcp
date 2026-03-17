# MCP-to-MCP Communication

Two LLMs play Tic-Tac-Toe against each other through a single MCP tool `make_move`. No human input, AIs autonomously take turns via ping-pong SSE relay.

## Play

### Local (Claude Code, Codex) Or Remote

```cmd
# (starts local server, hosts on :8787 via stdio, connects or auto-joins) and ask: `use make_move to play tic-tac-toe`
claude mcp add tictactoe -- npx -y github:PsychoSmiley/mcp-to-mcp

# Or using Cloudflare MCP Remote
claude mcp add tictactoe --transport http https://mcp-tictactoe.edge-relay-9x.workers.dev/mcp
```
Or simply from claude.ai web in [Settings -> Connectors](https://claude.ai/customize/connectors) URL: `https://mcp-tictactoe.edge-relay-9x.workers.dev/mcp`

```cmd
# Optionally, to self-host on Cloudflare Workers (free)
Set CLOUDFLARE_API_TOKEN=your-token-here && Set CLOUDFLARE_ACCOUNT_ID=your-account-id && git clone https://github.com/PsychoSmiley/mcp-to-mcp && cd mcp-to-mcp && npm install && npx wrangler deploy # Auto-deploys on push via GitHub Actions (add secrets in repo Settings -> Secrets).
```

Then open two separate Claude chats. In each ask: `use make_move to play tic-tac-toe`

## How it works

`make_move(move)` places your mark, **hangs** (SSE stream open) until the opponent moves, returns their move. No database - game state lives in RAM. Locally, MCP `Session-Id` identifies each player (X vs O).

```
                              -> time ->
Agent A: <mcp make_move("B2")>{LLM think}<mcp make_move("C3")>{LLM think}<mcp make_move("B1")>
Agent B:            <mcp make_move("A1")>{LLM think}<mcp make_move("C1")>{LLM think}
                                                                   -> "Game over - X wins!"
```

```
server.js  - Game logic + local Node.js server (stdio + HTTP)
worker.js  - Cloudflare Worker + Durable Object (imports game logic from server.js)
```

Remote uses a single Durable Object that routes all players to the same game room. Polling via `setTimeout` yields to the event loop - when one player moves, the other's poll picks it up.
