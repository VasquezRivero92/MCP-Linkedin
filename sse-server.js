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
    allowedHeaders: ["*"],
  }),
);

// Permite capturar el payload JSON-RPC en cualquier formato
app.use(express.text({ type: "*/*" }));

const sessions = new Map();

app.get("/", (req, res) => {
  res.status(200).send("LinkedIn MCP Server OK");
});

// Endpoint SSE
app.get("/sse", (req, res) => {
  const sessionId = crypto.randomUUID();
  console.log(`[SSE] Nueva conexión iniciada (Sesión: ${sessionId})`);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  res.flushHeaders();

  // Iniciar subproceso dedicado para esta sesión
  const child = spawn("node", ["./dist/index.js"], {
    env: { ...process.env, FORCE_COLOR: "0" },
    stdio: ["pipe", "pipe", "inherit"],
  });

  sessions.set(sessionId, { res, child });

  // Evento endpoint obligatorio para MCP
  res.write(
    `event: endpoint\ndata: https://mcp-linkedin.wisp.uno/message?sessionId=${sessionId}\n\n`,
  );

  let stdoutBuffer = "";
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // Filtrar logs de texto plano y enviar solo JSON válidos
      if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
        console.log(`[MCP -> Gemini]: ${trimmed}`);
        res.write(`event: message\ndata: ${trimmed}\n\n`);
      } else {
        console.log(`[Proceso Log]: ${trimmed}`);
      }
    }
  });

  child.on("error", (err) => {
    console.error(`[Error Proceso ${sessionId}]:`, err.message);
  });

  req.on("close", () => {
    console.log(`[SSE] Conexión cerrada (Sesión: ${sessionId})`);
    child.kill();
    sessions.delete(sessionId);
  });
});

// Endpoint POST para mensajes JSON-RPC
app.post("/message", (req, res) => {
  const sessionId = req.query.sessionId;
  const session = sessions.get(sessionId);

  if (!session) {
    console.warn(`[Mensaje rechazado] Sesión no encontrada: ${sessionId}`);
    return res.status(404).send("Session not found");
  }

  const payload =
    typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  console.log(`[Gemini -> MCP]: ${payload}`);

  session.child.stdin.write(payload + "\n");
  res.status(200).send("OK");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[MCP Server] Escuchando en el puerto ${PORT}`);
});
