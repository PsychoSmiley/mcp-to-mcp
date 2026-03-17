#!/usr/bin/env node
// MCP-to-MCP TicTacToe - Local Node.js server + shared game logic
// Exports game functions for worker.js. Starts HTTP server only in Node.js.
// Stdio + HTTP transports. No database. State lives in-memory.

// -- Game logic (pure functions, exported for worker.js) --

const POS = { A1: 0, A2: 1, A3: 2, B1: 3, B2: 4, B3: 5, C1: 6, C2: 7, C3: 8 };
const WINS = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];

export function emptyBoard() { return Array(9).fill(""); }

export function place(board, pos, mark) {
  const i = POS[pos.toUpperCase()];
  if (i === undefined) return { err: `Invalid position "${pos}". Use: ${Object.keys(POS).join(", ")}` };
  if (board[i]) return { err: `${pos.toUpperCase()} is occupied by ${board[i]}.` };
  const next = [...board]; next[i] = mark; return { board: next };
}

export function winner(board) {
  for (const [a, b, c] of WINS) if (board[a] && board[a] === board[b] && board[b] === board[c]) return board[a];
  return board.every(Boolean) ? "draw" : null;
}

export function render(board) {
  const c = (i) => board[i] || "·";
  return `  1 2 3\nA ${c(0)} ${c(1)} ${c(2)}\nB ${c(3)} ${c(4)} ${c(5)}\nC ${c(6)} ${c(7)} ${c(8)}`;
}

export function txt(text) { return { content: [{ type: "text", text }] }; }
export function formatWin(w) { return w === "draw" ? "Draw!" : `${w} wins!`; }

export function createGame(sid) {
  return { board: emptyBoard(), xSid: sid, oSid: null, turn: "X", finished: false };
}

// MCP Session-Id = free player identity (local only, Cloudflare uses turn order)
export function assignPlayer(game, sid) {
  if (!game) return null;
  if (sid === game.xSid) return "X";
  if (sid === game.oSid) return "O";
  if (!game.oSid && sid !== game.xSid) { game.oSid = sid; return "O"; }
  return null;
}

export function endTurn(game, oppMove, myMark) {
  if (!game) return txt(`Opponent played ${oppMove.toUpperCase()}. Game over!`);
  const w = winner(game.board);
  if (w) return txt(`Opponent played ${oppMove.toUpperCase()}. Game over - ${formatWin(w)}\n${render(game.board)}`);
  return txt(`Opponent played ${oppMove.toUpperCase()}. Your turn (${myMark}).\n${render(game.board)}\nCall make_move with your next position.`);
}

// -- Node.js server (skipped in Cloudflare Workers) --
// typeof caches: Workers have global Cache Storage API, Node.js does not.
// This one check makes server.js a polyglot file - exports for Workers, runs HTTP in Node.
if (typeof caches === "undefined") {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { isInitializeRequest } = await import("@modelcontextprotocol/sdk/types.js");
  const { z } = await import("zod");
  const { randomUUID } = await import("node:crypto");
  const { createServer } = await import("node:http");
  const log = (msg) => process.stderr.write(msg + "\n"); // stdout reserved for stdio MCP

  let game = null;
  const CLEANUP_MS = 10_000;
  const MAX_WAIT_MS = 300_000;

  function markFinished() {
    if (!game) return;
    game.finished = true;
    setTimeout(() => { if (game?.finished) game = null; }, CLEANUP_MS);
  }

  // Ping-pong core: returns a Promise that hangs until opponent resolves it (or timeout)
  // SSE heartbeats keep the connection alive so claude.ai doesn't kill the tool call
  function waitForOpponent(heartbeatFn) {
    let done = false, resolve;
    const promise = new Promise((r) => { resolve = r; });
    const hbTimer = setInterval(heartbeatFn, 5_000);
    const toTimer = setTimeout(() => finish(null), MAX_WAIT_MS);
    function finish(v) { if (done) return; done = true; clearInterval(hbTimer); clearTimeout(toTimer); resolve(v); }
    return { promise, resolve: finish };
  }

  // Each session needs its own McpServer (SDK can't reuse one across transports)
  // But all share the same `game` variable - that's the shared room
  function createMcpServer() {
    const srv = new McpServer({ name: "mcp-tictactoe", version: "0.1.0" });
    srv.registerTool("make_move", {
      description: "Place your mark on the tic-tac-toe board. Positions: A1, A2, A3, B1, B2, B3, C1, C2, C3.",
      inputSchema: { move: z.string().describe("Board position (e.g. A1, B2, C3)") },
    }, async ({ move }, extra) => {
      const sid = extra.sessionId;
      const heartbeat = () =>
        srv.sendLoggingMessage({ level: "info", data: `Waiting for opponent...\n${render(game?.board || [])}` }, sid).catch(() => {});

      if (!game) {
        game = createGame(sid);
        game.waiter = null;
        const r = place(game.board, move, "X");
        if (r.err) { game = null; return txt(r.err); }
        game.board = r.board;
        game.turn = "O";
        // Ping-pong: hang here (SSE open) until opponent moves, then return their move
        game.waiter = waitForOpponent(heartbeat);
        const oppMove = await game.waiter.promise;
        if (!oppMove) { game = null; return txt("Opponent didn't respond in time. Game abandoned."); }
        return endTurn(game, oppMove, "X");
      }

      const mark = assignPlayer(game, sid);
      if (!mark) return txt("Game in progress. Try again later.");

      if (game.turn !== mark)
        return txt(`Not your turn yet. Current board:\n${render(game.board)}\nYou are ${mark}. Call make_move after opponent plays.`);

      const r = place(game.board, move, mark);
      if (r.err) return txt(`${r.err}\nBoard:\n${render(game.board)}\nYou are ${mark}. Call make_move again.`);
      game.board = r.board;
      game.turn = mark === "X" ? "O" : "X";

      const w = winner(game.board);
      if (w) {
        if (game.waiter) game.waiter.resolve(move); // wake up opponent's hanging call
        markFinished();
        return txt(`Placed ${move.toUpperCase()} as ${mark}. Game over - ${formatWin(w)}\n${render(game.board)}`);
      }

      if (game.waiter) game.waiter.resolve(move); // wake up opponent's hanging call
      game.waiter = waitForOpponent(heartbeat);
      const oppMove = await game.waiter.promise;
      if (!oppMove) { game = null; return txt("Opponent didn't respond in time. Game abandoned."); }
      return endTurn(game, oppMove, mark);
    });
    return srv;
  }

  // -- Proxy helper (for when another local instance is already hosting) --

  async function proxyMove(url, move) {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "stdio-proxy", version: "1" } } }),
    });
    // This fetch may hang for minutes (waiting for opponent) - that's the ping-pong working
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "make_move", arguments: { move } } }),
    });
    const text = await resp.text();
    for (const line of text.split("\n").reverse()) {
      if (!line.startsWith("data: ")) continue;
      try { const j = JSON.parse(line.slice(6)); if (j.result?.content) return j.result; } catch {}
    }
    return txt("No response from game server.");
  }

  // -- HTTP server (try to host - if port taken, another instance is hosting, join them) --
  // Port collision = auto-join: EADDRINUSE means Player 1 is already running

  const port = process.env.PORT || 8787;
  const sessions = {};
  const touch = (t) => { t._lastSeenAt = Date.now(); };

  setInterval(() => {
    const now = Date.now();
    for (const [id, t] of Object.entries(sessions)) {
      if (t._lastSeenAt && now - t._lastSeenAt > 600_000) { t.close?.(); delete sessions[id]; }
    }
  }, 60_000);

  async function handlePost(req, res) {
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const sid = req.headers["mcp-session-id"];

      if (sid && sessions[sid]) { touch(sessions[sid]); return sessions[sid].handleRequest(req, res, body); }

      if (!sid && isInitializeRequest(body)) {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => { touch(transport); sessions[id] = transport; },
        });
        transport.onclose = () => { if (transport.sessionId) delete sessions[transport.sessionId]; };
        await createMcpServer().connect(transport);
        return transport.handleRequest(req, res, body);
      }

      res.writeHead(400).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Invalid request" }, id: null }));
    } catch (e) {
      if (!res.headersSent) res.writeHead(500).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: e.message }, id: null }));
    }
  }

  let proxyUrl = null;

  {
    const hosted = await new Promise((resolve) => {
      const s = createServer((req, res) => {
        if (req.url !== "/mcp") return res.writeHead(404).end();
        if (req.method === "POST") return handlePost(req, res);
        if (req.method === "GET" || req.method === "DELETE") {
          const sid = req.headers["mcp-session-id"];
          if (sid && sessions[sid]) { touch(sessions[sid]); return sessions[sid].handleRequest(req, res); }
          return res.writeHead(400).end();
        }
        res.writeHead(405).end();
      });
      s.on("error", (e) => { if (e.code === "EADDRINUSE") resolve(false); else throw e; });
      s.listen(port, () => { log(`Hosting game on http://localhost:${port}/mcp`); resolve(true); });
    });
    if (!hosted) proxyUrl = `http://localhost:${port}/mcp`;
  }

  // -- Stdio transport --
  // Host -> uses local game state (same createMcpServer, shared `game` variable)
  // Join -> proxies to existing local server via HTTP

  if (proxyUrl) {
    log(`Joining game at ${proxyUrl}`);
    const stdioSrv = new McpServer({ name: "mcp-tictactoe", version: "0.1.0" });
    stdioSrv.registerTool("make_move", {
      description: "Place your mark on the tic-tac-toe board. Positions: A1, A2, A3, B1, B2, B3, C1, C2, C3.",
      inputSchema: { move: z.string().describe("Board position (e.g. A1, B2, C3)") },
    }, async ({ move }) => proxyMove(proxyUrl, move));
    await stdioSrv.connect(new StdioServerTransport());
  } else {
    log("Stdio connected as Player 1 (hosting)");
    await createMcpServer().connect(new StdioServerTransport());
  }
}
