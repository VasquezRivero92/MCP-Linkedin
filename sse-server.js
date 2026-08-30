import express from "express";
import cors from "cors";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
// Importa la instancia del servidor o la función constructora del proyecto compilado
import { server } from "./dist/index.js";

const app = express();
const PORT = process.env.PORT || 9973;

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-session-id"],
  }),
);

// Almacenar transportes por ID de sesión
const transports = new Map();

app.get("/", (req, res) => {
  res.status(200).send("LinkedIn MCP Server OK");
});

// Endpoint SSE
app.get("/mcp", async (req, res) => {
  console.log("[MCP] Nueva conexión SSE entrante desde Gemini");

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");

  // Constructor del transporte con la URL completa
  const transport = new SSEServerTransport(
    "https://mcp-linkedin.wisp.uno/mcp/message",
    res,
  );

  const sessionId = transport.sessionId;
  transports.set(sessionId, transport);

  req.on("close", () => {
    console.log(`[MCP] Conexión cerrada para sesión ${sessionId}`);
    transports.delete(sessionId);
  });

  // Si el servidor de index.js ya está exportado
  if (server && typeof server.connect === "function") {
    await server.connect(transport);
  } else {
    await transport.start();
  }
});

// Endpoint POST para recepción de RPC
app.post("/mcp/message", async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports.get(sessionId);

  console.log(`[MCP] Mensaje RPC entrante para sesión: ${sessionId}`);

  if (!transport) {
    return res.status(404).send("Session not found");
  }

  await transport.handlePostMessage(req, res);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[MCP Server] Escuchando en http://0.0.0.0:${PORT}/mcp`);
});
