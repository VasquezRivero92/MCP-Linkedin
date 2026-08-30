import express from "express";
import cors from "cors";
import { spawn } from "child_process";
import crypto from "crypto";

const app = express();
const PORT = process.env.PORT || 9973;

// Cabeceras CORS globales completas
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "*");
  res.header("Access-Control-Allow-Credentials", "true");
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }
  next();
});

// Permitir tanto JSON estructurado como texto plano
app.use(express.json());
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
    "X-Accel-Buffering": "no",
    "Access-Control-Allow-Origin": "*",
  });
  res.flushHeaders();

  const absoluteEndpoint = `https://mcp-linkedin.wisp.uno/message?sessionId=${sessionId}`;

  const child = spawn("node", ["./dist/index.js"], {
    env: { ...process.env, FORCE_COLOR: "0" },
    stdio: ["pipe", "pipe", "inherit"],
  });

  sessions.set(sessionId, { res, child });

  // Notificar el endpoint al cliente
  res.write(`event: endpoint\ndata: ${absoluteEndpoint}\n\n`);

  // Latido periódico para mantener la conexión viva
  const heartbeat = setInterval(() => {
    res.write(":\n\n");
  }, 15000);

  let stdoutBuffer = "";
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
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
    clearInterval(heartbeat);
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
    typeof req.body === "object" ? JSON.stringify(req.body) : req.body;
  console.log(`[Gemini -> MCP]: ${payload}`);

  session.child.stdin.write(payload + "\n");
  res.status(200).send("Accepted");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[MCP Server] Escuchando en el puerto ${PORT}`);
});
