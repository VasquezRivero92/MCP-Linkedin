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

// Aceptar payloads como texto/JSON sin alterar
app.use(express.text({ type: "*/*" }));

const sessions = new Map();

app.get("/", (req, res) => {
  res.status(200).send("LinkedIn MCP Server OK");
});

// Endpoint SSE
app.get("/mcp", (req, res) => {
  console.log("[MCP] Handshake inicial recibido desde Gemini");

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();

  const sessionId = crypto.randomUUID();
  const absoluteEndpoint = `https://mcp-linkedin.wisp.uno/mcp/message?sessionId=${sessionId}`;

  // Iniciar el proceso MCP de LinkedIn
  const child = spawn("node", ["./dist/index.js"], {
    env: process.env,
    stdio: ["pipe", "pipe", "inherit"],
  });

  sessions.set(sessionId, { res, child });

  // Enviar evento endpoint requerido por Gemini
  res.write(`event: endpoint\ndata: ${absoluteEndpoint}\n\n`);

  child.stdout.on("data", (data) => {
    const raw = data.toString();
    const lines = raw.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("{")) continue;
      console.log(`[MCP -> Gemini]: ${trimmed}`);
      res.write(`event: message\ndata: ${trimmed}\n\n`);
    }
  });

  child.on("error", (err) => {
    console.error(`[MCP Error Proceso]: ${err.message}`);
  });

  req.on("close", () => {
    console.log(`[MCP] Conexión cerrada para sesión ${sessionId}`);
    child.kill();
    sessions.delete(sessionId);
  });
});

// Endpoint POST para recibir peticiones JSON-RPC
app.post("/mcp/message", (req, res) => {
  const sessionId = req.query.sessionId;
  const session = sessions.get(sessionId);

  if (!session) {
    console.error(`[MCP] Sesión no encontrada: ${sessionId}`);
    return res.status(404).send("Session not found");
  }

  const payload =
    typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  console.log(`[Gemini -> MCP]: ${payload}`);

  session.child.stdin.write(payload + "\n");
  res.status(202).send("Accepted");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[MCP Server] Escuchando en http://0.0.0.0:${PORT}/mcp`);
});
