import "dotenv/config";
import express from "express";
import cors from "cors";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LinkedInMCPServer } from "./dist/server.js";
import { getConfig, validateConfig, needsOAuth } from "./dist/config.js";
import { OAuthManager } from "./dist/oauth-manager.js";
import { Logger } from "./dist/logger.js";

const app = express();
const PORT = process.env.PORT || 9973;

// Middleware de CORS completo para soportar clientes web, Gemini Spark, Google AI Studio, proxies
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS", "HEAD"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "x-session-id",
      "mcp-session-id",
      "Origin",
      "Accept",
      "X-Requested-With",
      "*",
    ],
    exposedHeaders: ["*", "x-session-id", "mcp-session-id"],
    credentials: false,
  }),
);

// Middleware opcional para parsear JSON si viene como body
app.use(express.json({ limit: "10mb" }));

// Mapa de transportes activos por sessionId
const transports = new Map();

// Helper para crear la instancia del servidor MCP
async function createMcpInstance() {
  let isConfigured = false;
  let config;
  let tokenProvider;

  try {
    config = getConfig();
    validateConfig(config);
    isConfigured = true;
  } catch {
    isConfigured = false;
  }

  if (isConfigured && config) {
    try {
      const logger = new Logger(config.logLevel || "info");

      if (needsOAuth(config)) {
        logger.info("[Auth] Usando OAuth token provider...");
        const oauthManager = new OAuthManager(
          {
            clientId: config.linkedInClientId,
            clientSecret: config.linkedInClientSecret,
            redirectUri: config.linkedInRedirectUri,
          },
          logger,
        );
        tokenProvider = oauthManager;
      }

      const linkedInServer = new LinkedInMCPServer(config, tokenProvider);
      return {
        server: linkedInServer.getServer(),
        type: "full-linkedin",
      };
    } catch (err) {
      console.warn(
        `[MCP Init] Error inicializando cliente de LinkedIn completo: ${err.message}. Usando servidor base de diagnóstico.`,
      );
    }
  }

  // Si no hay credenciales configuradas o hubo un error, iniciar servidor base con herramientas de diagnóstico y perfil
  const fallbackServer = new McpServer(
    {
      name: "linkedin-mcp-server",
      version: "1.4.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  fallbackServer.tool(
    "get_linkedin_profile",
    "Obtiene información del perfil de LinkedIn del usuario autenticado",
    {},
    async () => {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                status: "ready",
                message:
                  "Servidor LinkedIn MCP conectado a Gemini Spark con éxito.",
                note:
                  "Para consultar datos reales de la API de LinkedIn, configura LINKEDIN_ACCESS_TOKEN o las credenciales OAuth (LINKEDIN_CLIENT_ID y LINKEDIN_CLIENT_SECRET) en tu archivo .env.",
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  fallbackServer.tool(
    "linkedin_server_status",
    "Verifica el estado del servidor MCP de LinkedIn y la configuración",
    {},
    async () => {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                mcp_status: "online",
                transport: "sse",
                gemini_spark_compatible: true,
                active_sessions: transports.size,
                has_linkedin_token: !!process.env.LINKEDIN_ACCESS_TOKEN,
                has_oauth: !!(
                  process.env.LINKEDIN_CLIENT_ID &&
                  process.env.LINKEDIN_CLIENT_SECRET
                ),
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  fallbackServer.tool(
    "share_linkedin_post",
    "Comparte una publicación en LinkedIn",
    {
      text: z.string().describe("El texto de la publicación a compartir"),
    },
    async ({ text }) => {
      return {
        content: [
          {
            type: "text",
            text: `[LinkedIn MCP Mock] Publicación recibida: "${text}". Configura LINKEDIN_ACCESS_TOKEN en el servidor para publicar directamente en LinkedIn.`,
          },
        ],
      };
    },
  );

  return {
    server: fallbackServer,
    type: "fallback",
  };
}

// Endpoint de salud y estado
app.get("/", (req, res) => {
  const protocol = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const host = req.get("host") || `localhost:${PORT}`;
  const baseUrl = process.env.BASE_URL || `${protocol}://${host}`;

  res.status(200).json({
    status: "ok",
    name: "linkedin-mcp-server",
    version: "1.4.0",
    description:
      "LinkedIn MCP Server optimizado para Gemini Spark y clientes MCP SSE",
    activeSessions: transports.size,
    endpoints: {
      sse: `${baseUrl}/sse`,
      message: `${baseUrl}/message`,
      health: `${baseUrl}/health`,
    },
    authStatus: {
      hasAccessToken: !!process.env.LINKEDIN_ACCESS_TOKEN,
      hasOAuth: !!(
        process.env.LINKEDIN_CLIENT_ID && process.env.LINKEDIN_CLIENT_SECRET
      ),
    },
  });
});

app.get("/health", (req, res) => {
  res.status(200).json({ status: "healthy", timestamp: new Date().toISOString() });
});

// Endpoint SSE principal para Gemini Spark y clientes MCP
app.get("/sse", async (req, res) => {
  const clientIp = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  console.log(`\n[SSE] 🚀 Nueva conexión entrante desde: ${clientIp}`);

  // Headers SSE explícitos y anti-buffering
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  // Determinar la URL del endpoint para el mensaje de retorno
  let messageEndpoint = "/message";
  if (process.env.MCP_MESSAGE_ENDPOINT) {
    messageEndpoint = process.env.MCP_MESSAGE_ENDPOINT;
  } else if (process.env.BASE_URL) {
    messageEndpoint = `${process.env.BASE_URL.replace(/\/$/, "")}/message`;
  }

  const transport = new SSEServerTransport(messageEndpoint, res);
  const sessionId = transport.sessionId;
  transports.set(sessionId, transport);

  console.log(`[SSE] 🔑 Sesión MCP asignada: ${sessionId}`);
  console.log(`[SSE] 📡 Endpoint de mensajes configurado en: ${messageEndpoint}`);

  // Heartbeat / Keep-alive cada 15 segundos para evitar que Gemini o proxies cierren la conexión
  const heartbeatInterval = setInterval(() => {
    try {
      res.write(": keepalive\n\n");
    } catch {
      clearInterval(heartbeatInterval);
    }
  }, 15000);

  // Instanciar servidor MCP para esta sesión
  const { server, type } = await createMcpInstance();
  console.log(`[SSE] ⚙️ Servidor MCP inicializado en modo: ${type}`);

  const cleanup = async () => {
    clearInterval(heartbeatInterval);
    if (transports.has(sessionId)) {
      console.log(`[SSE] 🔌 Conexión cerrada para sesión: ${sessionId}`);
      transports.delete(sessionId);
      try {
        await transport.close();
      } catch {}
    }
  };

  req.on("close", cleanup);
  transport.onclose = cleanup;

  try {
    await server.connect(transport);
    console.log(`[SSE] ✅ Handshake MCP completado exitosamente para sesión ${sessionId}`);
  } catch (err) {
    console.error(`[SSE] ❌ Error conectando servidor MCP:`, err);
    cleanup();
  }
});

// Handler unificado para mensajes POST (RPC)
async function handleMessagePost(req, res) {
  const sessionId = req.query.sessionId || req.headers["x-session-id"];
  console.log(`[POST /message] 📩 Mensaje entrante para sessionId: ${sessionId}`);

  if (!sessionId) {
    console.warn("[POST Rechazado] Falta el parámetro sessionId en la solicitud");
    return res.status(400).json({ error: "Missing sessionId query parameter" });
  }

  const transport = transports.get(sessionId);
  if (!transport) {
    console.warn(`[POST Rechazado] Sesión no encontrada o expirada: ${sessionId}`);
    return res.status(404).json({ error: `Session not found: ${sessionId}` });
  }

  try {
    // Si express.json() ya parseó el body, lo pasamos como parsedBody; si no, handlePostMessage leerá el stream
    await transport.handlePostMessage(req, res, req.body);
  } catch (error) {
    console.error(`[POST /message] Error procesando mensaje RPC:`, error);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error processing RPC message" });
    }
  }
}

// Endpoint POST para mensajes RPC (ruta estándar y alias)
app.post("/message", handleMessagePost);
app.post("/sse/message", handleMessagePost);

// Iniciar servidor HTTP
const serverInstance = app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n======================================================`);
  console.log(`🚀 LinkedIn MCP SSE Server listo para Gemini Spark`);
  console.log(`📍 Puerto local: ${PORT}`);
  console.log(`🔗 Endpoint SSE: http://localhost:${PORT}/sse`);
  console.log(`🔗 Endpoint POST: http://localhost:${PORT}/message`);
  console.log(`📊 Endpoint Health: http://localhost:${PORT}/health`);
  console.log(`======================================================\n`);
});

// Cierre graceful
function handleShutdown(signal) {
  console.log(`\n[Shutdown] Recibida señal ${signal}. Cerrando conexiones SSE...`);
  for (const [id, transport] of transports.entries()) {
    try {
      transport.close();
    } catch {}
  }
  transports.clear();
  serverInstance.close(() => {
    console.log("[Shutdown] Servidor detenido limpiamente.");
    process.exit(0);
  });
}

process.on("SIGINT", () => handleShutdown("SIGINT"));
process.on("SIGTERM", () => handleShutdown("SIGTERM"));
