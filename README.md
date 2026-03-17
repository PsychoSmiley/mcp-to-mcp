# MCP-to-MCP Communication

Two LLMs play Tic-Tac-Toe against each other through a single MCP tool `make_move`. No human input, AIs autonomously take turns via ping-pong SSE relay.

## Play

### Local (Claude Code, Codex) Or Remote

```cmd
# (starts local server on :8787 via stdio, or auto-joins if another instance is already hosting)
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

## Why you should care

The idea isn't Tic-Tac-Toe - it's the architecture. Using MCP itself as a ping-pong turn relay, where each tool call is the AI's response back-and-forth like a baton relay. This achieves synchronous P2P agent communication over a stateless REST protocol, with zero database reads/writes. The same pattern could be used for chat between two or more AI agents via MCP ;)

## How it works

Each `make_move(move)` call both submits a move and waits for the opponent's reply - send + block + receive in one MCP call. The server is authoritative: LLMs only send moves, never the board state. No database - game state lives in RAM. Local MCP `Session-Id` identifies each player (X vs O).

```
                              -> time -> Each MCP closes only to receive opponent's move result, then immediately answers
Agent A: <mcp make_move("B2")>{LLM think}<mcp make_move("C3")>{LLM think}<mcp make_move("B1")>
Agent B:            <mcp make_move("A1")>{LLM think}<mcp make_move("C1")>{LLM think}
                                                                   -> "Game over - X wins!"
```

- `server.js` - Game logic + local Node.js server (stdio + HTTP)
- `worker.js` - Cloudflare Worker + Durable Object (imports game logic from server.js)

## Why Durable Object

Locally (`server.js`), the Node.js process is that shared room. Remotely (`worker.js`), the Durable Object is.

A Cloudflare Worker is stateless - each request spawns a fresh isolate that dies after responding. Two players' requests can land on different isolates in different cities with no shared memory. They can't meet, can't pass state, can't even know each other exist. Cloudflare KV could bridge them (shared key-value store), but the free tier limits writes to 1,000/day - tight for a game with many moves. 
A Durable Object is basically a tiny managed server (persistent single-threaded process with RAM). All requests route to the same instance via `idFromName("lobby")` - both players share one `this.game` variable. When Player B places a move, Player A's polling loop (yielding via `setTimeout`) sees the change on the next tick. No database, no transfers, no serialization - just two requests reading the same variable on the same event loop. (Durable Object SQLite could also replace KV with unlimited read/write, but RAM is faster for short-lived games.)


