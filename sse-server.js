import express from "express";
import cors from "cors";
import { spawn } from "child_process";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

const app = express();
const PORT = process.env.PORT || 9973;

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-session-id"],
  }),
);

const sessions = new Map();

app.get("/", (req, res) => {
  res.status(200).send("LinkedIn MCP Server OK");
});

app.get("/mcp", async (req, res) => {
  console.log("[MCP] Handshake inicial recibido desde Gemini");

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  // Construir explícitamente la URL absoluta HTTPS para Gemini
  const fullMessageUrl = "https://mcp-linkedin.wisp.uno/mcp/message";
  const transport = new SSEServerTransport(fullMessageUrl, res);

  const child = spawn("node", ["./dist/index.js"], {
    env: process.env,
    stdio: ["pipe", "pipe", "inherit"],
  });

  const sessionId = transport.sessionId;
  sessions.set(sessionId, { transport, child });

  child.stdout.on("data", (data) => {
    const raw = data.toString();
    const lines = raw.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("{")) continue;
      try {
        const json = JSON.parse(trimmed);
        transport.send(json);
      } catch {
        // Ignorar logs
      }
    }
  });

  req.on("close", () => {
    console.log(`[MCP] Sesión finalizada: ${sessionId}`);
    child.kill();
    sessions.delete(sessionId);
  });

  await transport.start();
});

app.post("/mcp/message", express.json({ limit: "10mb" }), async (req, res) => {
  const sessionId = req.query.sessionId;
  const session = sessions.get(sessionId);

  console.log(`[MCP] Mensaje RPC entrante para sesión: ${sessionId}`);

  if (!session) {
    return res.status(404).send("Session not found");
  }

  session.child.stdin.write(JSON.stringify(req.body) + "\n");
  res.status(202).send("Accepted");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[MCP Server] Escuchando en http://0.0.0.0:${PORT}/mcp`);
});
