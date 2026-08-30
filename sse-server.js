import express from "express";
import cors from "cors";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const app = express();
const PORT = process.env.PORT || 9973;

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["*"],
  }),
);

const transports = new Map();

app.get("/", (req, res) => {
  res.status(200).send("LinkedIn MCP Server OK");
});

// Endpoint SSE
app.get("/sse", async (req, res) => {
  console.log("[SSE] Solicitud de conexión entrante desde Gemini");

  const transport = new SSEServerTransport("/message", res);
  const sessionId = transport.sessionId;

  // Iniciar cliente de transporte local conectado a LinkedIn MCP
  const clientTransport = new StdioClientTransport({
    command: "node",
    args: ["./dist/index.js"],
    env: process.env,
  });

  await clientTransport.start();

  // Puente bidireccional entre Gemini (SSE) y LinkedIn MCP (Stdio)
  transport.onmessage = async (message) => {
    console.log(`[Gemini -> MCP]: ${JSON.stringify(message)}`);
    await clientTransport.send(message);
  };

  clientTransport.onmessage = async (message) => {
    console.log(`[MCP -> Gemini]: ${JSON.stringify(message)}`);
    await transport.send(message);
  };

  transports.set(sessionId, { transport, clientTransport });

  req.on("close", async () => {
    console.log(`[SSE] Conexión cerrada para sesión ${sessionId}`);
    transports.delete(sessionId);
    try {
      await clientTransport.close();
      await transport.close();
    } catch {}
  });

  await transport.start();
  console.log(`[SSE] Handshake completado para sesión: ${sessionId}`);
});

// Endpoint POST para mensajes RPC
app.post("/message", async (req, res) => {
  const sessionId = req.query.sessionId;
  const session = transports.get(sessionId);

  if (!session) {
    console.warn(`[POST Rechazado] Sesión no encontrada: ${sessionId}`);
    return res.status(404).send("Session not found");
  }

  await session.transport.handlePostMessage(req, res);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[MCP Server] Escuchando en el puerto ${PORT}`);
});
