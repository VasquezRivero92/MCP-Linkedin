import "dotenv/config";
import express from "express";
import cors from "cors";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LinkedInMCPServer } from "./dist/server.js";
import { getConfig, validateConfig, needsOAuth } from "./dist/config.js";
import { OAuthManager } from "./dist/oauth-manager.js";
import { Logger } from "./dist/logger.js";

const app = express();
const PORT = process.env.PORT || 9973;

// Middleware de CORS completo
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS", "HEAD", "PUT", "DELETE"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "x-session-id",
      "mcp-session-id",
      "mcp-protocol-version",
      "Origin",
      "Accept",
      "X-Requested-With",
      "*",
    ],
    exposedHeaders: ["*", "x-session-id", "mcp-session-id", "mcp-protocol-version"],
    credentials: false,
  }),
);

// Logging de todas las peticiones entrantes para diagnóstico en tiempo real
app.use((req, res, next) => {
  const timestamp = new Date().toLocaleTimeString();
  console.log(`[${timestamp}] 🌐 ${req.method} ${req.originalUrl} - IP: ${req.headers["x-forwarded-for"] || req.socket.remoteAddress}`);
  next();
});

// Middleware para parsear JSON
app.use(express.json({ limit: "10mb" }));

// Subclase de SSEServerTransport que garantiza el envío de URLs absolutas HTTPS y anti-buffering
class AbsoluteSSEServerTransport extends SSEServerTransport {
  constructor(endpoint, res, options) {
    super(endpoint, res, options);
  }

  async start() {
    if (this._sseResponse) {
      throw new Error("SSEServerTransport already started!");
    }

    if (!this.res.headersSent) {
      this.res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform, no-store, must-revalidate",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
        "Access-Control-Allow-Origin": "*",
      });
      if (typeof this.res.flushHeaders === "function") {
        this.res.flushHeaders();
      }
    }

    // Construir URL absoluta con sessionId
    let endpointWithSession;
    try {
      const url = new URL(this._endpoint);
      url.searchParams.set("sessionId", this._sessionId);
      endpointWithSession = url.toString();
    } catch {
      endpointWithSession = `${this._endpoint}${this._endpoint.includes("?") ? "&" : "?"}sessionId=${this._sessionId}`;
    }

    // Priming comment de 2KB para forzar a cualquier proxy intermedio (Nginx, Wisp, Cloudflare) a vaciar buffers
    const padding = ": " + " ".repeat(2048) + "\n\n";
    this.res.write(padding);

    // Enviar evento 'endpoint' que espera Gemini
    this.res.write(`event: endpoint\ndata: ${endpointWithSession}\n\n`);

    if (typeof this.res.flush === "function") {
      this.res.flush();
    }

    this._sseResponse = this.res;

    this.res.on("close", () => {
      this._sseResponse = undefined;
      this.onclose?.();
    });
  }
}

// Mapa de transportes activos por sessionId para SSE clásico
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
        `[MCP Init] Error inicializando cliente de LinkedIn: ${err.message}. Usando servidor base.`,
      );
    }
  }

  // Servidor de fallback con herramientas completas
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
                message: "Servidor LinkedIn MCP conectado a Gemini Spark con éxito.",
                note: "Para consultar datos reales, configura LINKEDIN_ACCESS_TOKEN o LINKEDIN_CLIENT_ID y LINKEDIN_CLIENT_SECRET en .env",
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
                transport: "sse + streamable_http",
                gemini_spark_compatible: true,
                active_sessions: transports.size,
                has_linkedin_token: !!process.env.LINKEDIN_ACCESS_TOKEN,
                has_oauth: !!(
                  process.env.LINKEDIN_CLIENT_ID && process.env.LINKEDIN_CLIENT_SECRET
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
            text: `[LinkedIn MCP Mock] Publicación recibida: "${text}".`,
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

// Determinar URL base pública
function getBaseUrl(req) {
  if (process.env.BASE_URL) {
    let base = process.env.BASE_URL.trim().replace(/\/$/, "");
    if (!base.startsWith("http://") && !base.startsWith("https://")) {
      base = `https://${base}`;
    }
    return base;
  }

  const protoHeader = req.headers["x-forwarded-proto"];
  const hostHeader =
    req.headers["x-forwarded-host"] || req.get("host") || `localhost:${PORT}`;

  let protocol = "http";
  if (protoHeader) {
    protocol = protoHeader.split(",")[0].trim();
  } else if (!hostHeader.includes("localhost") && !hostHeader.includes("127.0.0.1")) {
    protocol = "https";
  }

  return `${protocol}://${hostHeader}`;
}

// Servidor global para Streamable HTTP (soporte para peticiones HTTP POST JSON-RPC directas)
let globalStreamableTransport = null;
let globalStreamableServer = null;

async function getStreamableTransport() {
  if (!globalStreamableTransport) {
    globalStreamableTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => undefined, // modo stateless compatible con múltiples requests
    });
    const { server } = await createMcpInstance();
    globalStreamableServer = server;
    await globalStreamableServer.connect(globalStreamableTransport);
  }
  return globalStreamableTransport;
}

// Endpoint de salud y diagnóstico
app.get("/", async (req, res) => {
  // Si la petición pide text/event-stream, derivar al handler SSE
  if (req.headers.accept?.includes("text/event-stream")) {
    return handleSseConnection(req, res);
  }

  const baseUrl = getBaseUrl(req);
  res.status(200).json({
    status: "ok",
    name: "linkedin-mcp-server",
    version: "1.4.0",
    description: "LinkedIn MCP Server compatible con Gemini Spark, Gemini Connected Apps y Claude",
    activeSessions: transports.size,
    endpoints: {
      sse: `${baseUrl}/sse`,
      mcp: `${baseUrl}/mcp`,
      message: `${baseUrl}/message`,
      health: `${baseUrl}/health`,
    },
    supportedUrlsForGemini: [
      `${baseUrl}/sse`,
      `${baseUrl}/mcp`,
      `${baseUrl}`,
    ],
  });
});

app.get("/health", (req, res) => {
  res.status(200).json({ status: "healthy", timestamp: new Date().toISOString() });
});

// Handler SSE principal
async function handleSseConnection(req, res) {
  const clientIp = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  const baseUrl = getBaseUrl(req);
  const messageEndpoint = `${baseUrl}/message`;

  console.log(`\n[SSE] 🚀 Conexión SSE entrante desde: ${clientIp}`);
  console.log(`[SSE] 🌐 URL Base: ${baseUrl}`);
  console.log(`[SSE] 📡 Endpoint de retorno: ${messageEndpoint}`);

  const transport = new AbsoluteSSEServerTransport(messageEndpoint, res);
  const sessionId = transport.sessionId;
  transports.set(sessionId, transport);

  console.log(`[SSE] 🔑 Sesión asignada: ${sessionId}`);

  // Heartbeat cada 10 segundos
  const heartbeatInterval = setInterval(() => {
    try {
      res.write(": keepalive\n\n");
      if (typeof res.flush === "function") res.flush();
    } catch {
      clearInterval(heartbeatInterval);
    }
  }, 10000);

  const { server, type } = await createMcpInstance();
  console.log(`[SSE] ⚙️ Servidor MCP en modo: ${type}`);

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
    console.log(`[SSE] ✅ Handshake MCP completado para sesión ${sessionId}`);
  } catch (err) {
    console.error(`[SSE] ❌ Error en servidor MCP:`, err);
    cleanup();
  }
}

// Rutas SSE
app.get("/sse", handleSseConnection);
app.get("/mcp", handleSseConnection); // Soporte si Gemini intenta /mcp con GET SSE

// Handler para mensajes POST (RPC)
async function handleMessagePost(req, res) {
  const sessionId = req.query.sessionId || req.headers["x-session-id"];

  // Si tiene sessionId, va al transporte SSE de esa sesión
  if (sessionId && transports.has(sessionId)) {
    const transport = transports.get(sessionId);
    const method = req.body?.method || "(raw)";
    console.log(`[POST /message] 📩 RPC [${method}] para sesión: ${sessionId}`);
    try {
      await transport.handlePostMessage(req, res, req.body);
    } catch (error) {
      console.error(`[POST /message] Error:`, error);
      if (!res.headersSent) res.status(500).json({ error: String(error) });
    }
    return;
  }

  // Si NO tiene sessionId o es una petición Streamable HTTP directa (como Gemini Enterprise / Streamable)
  console.log(`[POST] Petición Streamable HTTP directa (sin sessionId SSE) en ${req.path}`);
  try {
    const streamableTransport = await getStreamableTransport();
    await streamableTransport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error(`[POST] Error en Streamable HTTP:`, err);
    if (!res.headersSent) {
      if (sessionId) {
        res.status(404).json({ error: `Session not found: ${sessionId}` });
      } else {
        res.status(500).json({ error: "Failed to handle MCP request" });
      }
    }
  }
}

// Endpoints POST para RPC
app.post("/message", handleMessagePost);
app.post("/sse/message", handleMessagePost);
app.post("/sse", handleMessagePost); // Soporte si Gemini hace POST a /sse directamente
app.post("/mcp", handleMessagePost); // Soporte estándar /mcp
app.post("/", handleMessagePost);    // Soporte para raíz

// Iniciar servidor HTTP
const serverInstance = app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n======================================================`);
  console.log(`🚀 LinkedIn MCP Universal Server listo`);
  console.log(`📍 Puerto local: ${PORT}`);
  console.log(`🔗 SSE: http://localhost:${PORT}/sse`);
  console.log(`🔗 MCP: http://localhost:${PORT}/mcp`);
  console.log(`🔗 POST Message: http://localhost:${PORT}/message`);
  console.log(`======================================================\n`);
});

// Cierre graceful
function handleShutdown(signal) {
  console.log(`\n[Shutdown] Recibida señal ${signal}. Cerrando conexiones...`);
  for (const [id, transport] of transports.entries()) {
    try {
      transport.close();
    } catch {}
  }
  transports.clear();
  serverInstance.close(() => {
    console.log("[Shutdown] Servidor detenido.");
    process.exit(0);
  });
}

process.on("SIGINT", () => handleShutdown("SIGINT"));
process.on("SIGTERM", () => handleShutdown("SIGTERM"));
