import express from "express";
import cors from "cors";
import { spawn } from "child_process";
import crypto from "crypto";

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

// Endpoint SSE
app.get("/mcp", (req, res) => {
  console.log("[MCP] Nueva conexión SSE recibida");

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();

  const sessionId = crypto.randomUUID();
  const absoluteEndpoint = `https://mcp-linkedin.wisp.uno/mcp/message?sessionId=${sessionId}`;

  // Iniciar subproceso MCP en Stdio
  const child = spawn("node", ["./dist/index.js"], {
    env: process.env,
    stdio: ["pipe", "pipe", "inherit"],
  });

  sessions.set(sessionId, { res, child });

  // Enviar el endpoint absoluto obligatorio para Google Gemini
  res.write(`event: endpoint\ndata: ${absoluteEndpoint}\n\n`);

  child.stdout.on("data", (data) => {
    const raw = data.toString();
    const lines = raw.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("{")) continue;
      res.write(`event: message\ndata: ${trimmed}\n\n`);
    }
  });

  child.on("error", (err) => {
    console.error(`[MCP Proceso Error]: ${err.message}`);
  });

  req.on("close", () => {
    console.log(`[MCP] Conexión cerrada para sesión ${sessionId}`);
    child.kill();
    sessions.delete(sessionId);
  });
});

// Endpoint POST para recepción de mensajes RPC
app.post("/mcp/message", express.json({ limit: "10mb" }), (req, res) => {
  const sessionId = req.query.sessionId;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).send("Session not found");
  }

  console.log(
    `[MCP] Mensaje recibido del cliente: ${JSON.stringify(req.body)}`,
  );
  session.child.stdin.write(JSON.stringify(req.body) + "\n");
  res.status(202).send("Accepted");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[MCP Server] Escuchando en http://0.0.0.0:${PORT}/mcp`);
});
