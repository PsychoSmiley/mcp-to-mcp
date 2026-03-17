// MCP-to-MCP TicTacToe - Cloudflare Worker + Single Durable Object
// ONE Durable Object instance ("lobby") handles ALL players.
// Stateless MCP per request (SDK can't reuse McpServer across transports).
// Note: stateless PoC - no stable player identity, turn-based assignment.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { place, winner, render, txt, formatWin, endTurn, createGame } from "./server.js";

const CLEANUP_MS = 10_000;
const POLL_MS = 500;
const MAX_WAIT_MS = 300_000;

// Durable Object = tiny managed server (persistent single-threaded process with RAM)
// All requests route here via idFromName("lobby") - both players share this.game
export class GameRoom {
  constructor() { this.game = null; }

  markFinished() {
    if (!this.game) return;
    this.game.finished = true;
    setTimeout(() => { if (this.game?.finished) this.game = null; }, CLEANUP_MS);
  }

  // Polling loop: await setTimeout yields to the event loop, letting the other
  // player's request run on the same single thread. When they modify this.game,
  // the next poll tick sees the change. Promises don't cross Durable Object
  // boundaries - that's why we poll instead of using Promise-based waiting.
  async waitForOpponent(expectedCount, heartbeatFn) {
    const start = Date.now();
    let hb = 0;
    while (Date.now() - start < MAX_WAIT_MS) {
      if (this.game?.finished) return this.game.lastMove;
      if (!this.game) return null;
      if (this.game.moveCount > expectedCount) return this.game.lastMove;
      if (++hb % 8 === 0) heartbeatFn(); // SSE heartbeat keeps connection alive
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    return null;
  }

  createMcpServer() {
    const room = this;
    const srv = new McpServer({ name: "mcp-tictactoe", version: "0.1.0" });

    srv.tool(
      "make_move",
      { move: z.string().describe("Board position: A1, A2, A3, B1, B2, B3, C1, C2, C3") },
      async ({ move }, extra) => {
        try {
          const sid = extra?.sessionId;
          const heartbeat = () =>
            srv.sendLoggingMessage({ level: "info", data: `Waiting for opponent...\n${render(room.game?.board || [])}` }, sid).catch(() => {});

          if (!room.game) {
            room.game = { ...createGame(sid), moveCount: 0, lastMove: null };
            const r = place(room.game.board, move, "X");
            if (r.err) { room.game = null; return txt(r.err); }
            room.game.board = r.board;
            room.game.turn = "O";
            room.game.moveCount = 1;
            room.game.lastMove = move;
            const oppMove = await room.waitForOpponent(1, heartbeat);
            if (!oppMove) { room.game = null; return txt("No opponent joined in time. Game abandoned."); }
            return endTurn(room.game, oppMove, "X");
          }

          // Turn-based assignment (stateless transport = no session IDs)
          const mark = room.game.turn;

          const r = place(room.game.board, move, mark);
          if (r.err) return txt(`${r.err}\nBoard:\n${render(room.game.board)}\nYou are ${mark}. Call make_move again.`);
          room.game.board = r.board;
          room.game.turn = mark === "X" ? "O" : "X";
          room.game.moveCount++;
          room.game.lastMove = move;
          const count = room.game.moveCount;

          const w = winner(room.game.board);
          if (w) {
            room.markFinished();
            return txt(`Placed ${move.toUpperCase()} as ${mark}. Game over - ${formatWin(w)}\n${render(room.game.board)}`);
          }

          const oppMove = await room.waitForOpponent(count, heartbeat);
          if (!oppMove) { room.game = null; return txt("Opponent didn't respond. Game abandoned."); }
          return endTurn(room.game, oppMove, mark);
        } catch (e) {
          return txt(`Error: ${e.message}`);
        }
      }
    );
    return srv;
  }

  async fetch(request) {
    if (request.method !== "POST") {
      return new Response(request.method === "GET" ? "MCP TicTacToe lobby" : "Method not allowed", { status: request.method === "GET" ? 200 : 405 });
    }
    try {
      const body = await request.json();
      const srv = this.createMcpServer();
      // Stateless transport: no sessions to lose between requests
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await srv.connect(transport);
      return await transport.handleRequest(request, { parsedBody: body });
    } catch (e) {
      return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: e.message }, id: null }), {
        status: 500, headers: { "Content-Type": "application/json" },
      });
    }
  }
}

// Worker = stateless router. Forwards ALL /mcp requests to ONE Durable Object.
export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname !== "/mcp") return new Response("MCP TicTacToe - connect at /mcp", { status: 200 });
    return env.GAME_ROOM.get(env.GAME_ROOM.idFromName("lobby")).fetch(request);
  },
};
