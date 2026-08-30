import express from "express";
import cors from "cors";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const app = express();
const PORT = process.env.PORT || 9973;

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["*"],
  }),
);

// Fábrica para crear una instancia nueva e independiente por cada conexión
function createServerInstance() {
  const server = new McpServer({
    name: "linkedin-mcp-server",
    version: "1.0.0",
  });

  // Herramienta de prueba base
  server.tool(
    "get_profile",
    "Obtiene información del perfil de LinkedIn",
    {},
    async () => {
      return {
        content: [
          { type: "text", text: "LinkedIn MCP conectado exitosamente" },
        ],
      };
    },
  );

  return server;
}

const transports = new Map();

app.get("/", (req, res) => {
  res.status(200).send("LinkedIn MCP Server OK");
});

// Endpoint SSE
app.get("/sse", async (req, res) => {
  console.log("[SSE] Solicitud de conexión entrante desde Gemini");

  const transport = new SSEServerTransport(
    "https://mcp-linkedin.wisp.uno/message",
    res,
  );
  const sessionId = transport.sessionId;
  transports.set(sessionId, transport);

  const server = createServerInstance();

  req.on("close", async () => {
    console.log(`[SSE] Conexión cerrada para sesión ${sessionId}`);
    transports.delete(sessionId);
    try {
      await transport.close();
    } catch {}
  });

  await server.connect(transport);
  console.log(
    `[SSE] Servidor MCP vinculado exitosamente a sesión: ${sessionId}`,
  );
});

// Endpoint POST para mensajes RPC
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
