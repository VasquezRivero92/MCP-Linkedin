import express from "express";
import cors from "cors";
import { spawn } from "child_process";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

const app = express();
const PORT = process.env.PORT || 9973;

// Middleware CORS global
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-session-id"],
  }),
);

const sessions = new Map();

// Endpoint de verificación inicial
app.get("/", (req, res) => {
  res.status(200).send("LinkedIn MCP Server OK");
});

// Endpoint SSE
app.get("/mcp", async (req, res) => {
  console.log("[MCP] Handshake inicial recibido desde Gemini");

  // Detectar el host dinámicamente para construir la URL absoluta de retorno
  const host =
    req.headers["x-forwarded-host"] ||
    req.headers.host ||
    "mcp-linkedin.wisp.uno";
  const proto = req.headers["x-forwarded-proto"] || "https";
  const messageEndpoint = `${proto}://${host}/mcp/message`;

  const transport = new SSEServerTransport(messageEndpoint, res);

  const child = spawn("node", ["./dist/index.js"], {
    env: process.env,
    stdio: ["pipe", "pipe", "inherit"], // Los logs van a stderr (consola), el JSON a stdout
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
        // Ignorar logs de texto plano
      }
    }
  });

  child.on("error", (err) => {
    console.error(`[MCP Error en proceso hijo]: ${err.message}`);
  });

  req.on("close", () => {
    console.log(`[MCP] Sesión finalizada: ${sessionId}`);
    child.kill();
    sessions.delete(sessionId);
  });

  await transport.start();
});

// Endpoint POST para recepción de RPC
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
