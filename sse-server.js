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
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

const sessions = new Map();

// Endpoint GET para inicializar la conexión MCP/SSE
app.get("/mcp", async (req, res) => {
  console.log("[MCP] Nueva conexión entrante recibida");

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  // El endpoint para enviar mensajes de vuelta queda configurado en /mcp/message
  const transport = new SSEServerTransport("/mcp/message", res);

  const child = spawn("node", ["./dist/index.js"], {
    env: process.env,
    stdio: ["pipe", "pipe", "inherit"],
  });

  const sessionId = transport.sessionId;
  sessions.set(sessionId, { transport, child });

  child.stdout.on("data", (data) => {
    try {
      const lines = data.toString().split("\n");
      for (const line of lines) {
        if (line.trim()) {
          const json = JSON.parse(line);
          transport.send(json);
        }
      }
    } catch {
      // Ignorar logs que no sean JSON
    }
  });

  req.on("close", () => {
    console.log(`[MCP] Conexión cerrada para sesión ${sessionId}`);
    child.kill();
    sessions.delete(sessionId);
  });

  await transport.start();
});

// Endpoint POST para recibir mensajes del cliente
app.post("/mcp/message", express.json(), async (req, res) => {
  const sessionId = req.query.sessionId;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).send("Session not found");
  }

  session.child.stdin.write(JSON.stringify(req.body) + "\n");
  res.status(200).send("OK");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[MCP Server] Listening on http://0.0.0.0:${PORT}/mcp`);
});
