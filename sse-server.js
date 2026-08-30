import express from "express";
import cors from "cors";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

const app = express();
const PORT = process.env.PORT || 9973;

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["*"],
  }),
);

// Almacén de transportes SSE activos
const transports = new Map();

app.get("/", (req, res) => {
  res.status(200).send("LinkedIn MCP Server OK");
});

// Endpoint SSE
app.get("/sse", async (req, res) => {
  console.log("[SSE] Solicitud de conexión entrante desde Gemini");

  // El SDK genera automáticamente el evento endpoint con la ruta adecuada
  const transport = new SSEServerTransport("/message", res);
  const sessionId = transport.sessionId;
  transports.set(sessionId, transport);

  // Iniciar cliente interno conectado al servidor de LinkedIn
  const clientTransport = new StdioClientTransport({
    command: "node",
    args: ["./dist/index.js"],
    env: process.env,
  });

  const client = new Client(
    { name: "gemini-bridge", version: "1.0.0" },
    { capabilities: {} },
  );

  req.on("close", async () => {
    console.log(`[SSE] Conexión cerrada para sesión ${sessionId}`);
    transports.delete(sessionId);
    try {
      await clientTransport.close();
    } catch {}
  });

  await transport.start();
  console.log(`[SSE] Handshake completado para sesión: ${sessionId}`);
});

// Endpoint POST para mensajes JSON-RPC
app.post("/message", async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports.get(sessionId);

  if (!transport) {
    console.warn(`[POST Rechazado] Sesión no encontrada: ${sessionId}`);
    return res.status(404).send("Session not found");
  }

  await transport.handlePostMessage(req, res);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[MCP Server] Escuchando en el puerto ${PORT}`);
});
