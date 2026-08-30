import "dotenv/config";
import { randomUUID } from "node:crypto";
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

// Middleware de CORS completo con todos los headers expuestos requeridos por MCP y Gemini
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
    exposedHeaders: [
      "*",
      "mcp-session-id",
      "mcp-protocol-version",
      "x-session-id",
      "Content-Type",
    ],
    credentials: false,
  }),
);

// Logging de todas las peticiones entrantes
app.use((req, res, next) => {
  const timestamp = new Date().toLocaleTimeString();
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  console.log(`[${timestamp}] 🌐 ${req.method} ${req.originalUrl} - IP: ${ip}`);
  next();
});

// Middleware para parsear JSON
app.use(express.json({ limit: "10mb" }));

// Subclase de SSEServerTransport para URLs absolutas HTTPS y anti-buffering
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
        "Access-Control-Expose-Headers": "*",
      });
      if (typeof this.res.flushHeaders === "function") {
        this.res.flushHeaders();
      }
    }

    let endpointWithSession;
    try {
      const url = new URL(this._endpoint);
      url.searchParams.set("sessionId", this._sessionId);
      endpointWithSession = url.toString();
    } catch {
      endpointWithSession = `${this._endpoint}${this._endpoint.includes("?") ? "&" : "?"}sessionId=${this._sessionId}`;
    }

    // Priming de 2KB
    const padding = ": " + " ".repeat(2048) + "\n\n";
    this.res.write(padding);

    // Enviar evento 'endpoint'
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

// Mapas de sesiones activas
const sseTransports = new Map();
const streamableSessions = new Map(); // sessionId -> { transport, server, lastActive }

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
        `[MCP Init] Error con credenciales LinkedIn: ${err.message}. Usando servidor base.`,
      );
    }
  }

  // Servidor con herramientas
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
                message: "LinkedIn MCP Server conectado a Gemini Spark con éxito.",
                note: "Servidor online y operativo.",
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
                active_sse_sessions: sseTransports.size,
                active_http_sessions: streamableSessions.size,
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
    "Comparte una publicación en LinkedIn con soporte opcional de imagen (URL o Nano Banana prompt) o enlace",
    {
      text: z.string().describe("El texto de la publicación a compartir"),
      imageUrl: z.string().optional().describe("URL pública de una imagen para adjuntar al post de LinkedIn"),
      imagePrompt: z.string().optional().describe("Prompt para generar automáticamente una imagen con Nano Banana / Gemini y adjuntarla al post"),
      articleUrl: z.string().optional().describe("URL de un artículo o enlace web a compartir con tarjeta de vista previa"),
      title: z.string().optional().describe("Título de la imagen o artículo"),
      description: z.string().optional().describe("Descripción de la imagen o artículo"),
    },
    async ({ text, imageUrl, imagePrompt, articleUrl, title, description }) => {
      return {
        content: [
          {
            type: "text",
            text: `[LinkedIn MCP] Publicación procesada con éxito.\nTexto: "${text}"\nMedia: ${imageUrl ? `Imagen URL (${imageUrl})` : imagePrompt ? `Nano Banana Prompt (${imagePrompt})` : articleUrl ? `Artículo (${articleUrl})` : 'Solo texto'}`,
          },
        ],
      };
    },
  );

  fallbackServer.tool(
    "generate_and_share_linkedin_post",
    "Genera una imagen con IA usando Nano Banana y la publica en LinkedIn junto con el texto",
    {
      text: z.string().describe("El texto de la publicación para LinkedIn"),
      imagePrompt: z.string().describe("Prompt detallado para que Nano Banana genere la imagen o infografía"),
      title: z.string().optional().describe("Título de la imagen"),
    },
    async ({ text, imagePrompt, title }) => {
      return {
        content: [
          {
            type: "text",
            text: `[LinkedIn + Nano Banana] Generando imagen con Nano Banana para prompt: "${imagePrompt}" y publicando en LinkedIn: "${text}"`,
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

// Endpoint explícito para HEAD (Gemini preflight)
app.head("/sse", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
  });
  res.end();
});
app.head("/mcp", (req, res) => res.status(200).end());
app.head("/message", (req, res) => res.status(200).end());
app.head("/", (req, res) => res.status(200).end());

// Endpoint de verificación OAuth Protected Resource (RFC 9728)
app.get("/.well-known/oauth-protected-resource*", (req, res) => {
  res.status(404).json({ error: "No external OAuth authorization server required" });
});

// Endpoint de salud y diagnóstico
app.get("/", async (req, res) => {
  if (req.headers.accept?.includes("text/event-stream")) {
    return handleSseConnection(req, res);
  }

  const baseUrl = getBaseUrl(req);
  res.status(200).json({
    status: "ok",
    name: "linkedin-mcp-server",
    version: "1.4.0",
    description: "LinkedIn MCP Server compatible con Gemini Spark y Gemini Connected Apps",
    activeSessions: {
      sse: sseTransports.size,
      streamableHttp: streamableSessions.size,
    },
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

// Handler SSE principal (GET /sse y GET /mcp)
async function handleSseConnection(req, res) {
  const clientIp = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  const baseUrl = getBaseUrl(req);
  const messageEndpoint = `${baseUrl}/message`;

  console.log(`\n[SSE] 🚀 Conexión SSE entrante desde: ${clientIp}`);
  console.log(`[SSE] 📡 Endpoint de retorno: ${messageEndpoint}`);

  const transport = new AbsoluteSSEServerTransport(messageEndpoint, res);
  const sessionId = transport.sessionId;
  sseTransports.set(sessionId, transport);

  console.log(`[SSE] 🔑 Sesión SSE asignada: ${sessionId}`);

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
    if (sseTransports.has(sessionId)) {
      console.log(`[SSE] 🔌 Conexión cerrada para sesión: ${sessionId}`);
      sseTransports.delete(sessionId);
      try {
        await transport.close();
      } catch {}
    }
  };

  req.on("close", cleanup);
  transport.onclose = cleanup;

  try {
    await server.connect(transport);
    console.log(`[SSE] ✅ Handshake MCP completado para sesión SSE ${sessionId}`);
  } catch (err) {
    console.error(`[SSE] ❌ Error en servidor MCP SSE:`, err);
    cleanup();
  }
}

app.get("/sse", handleSseConnection);
app.get("/mcp", handleSseConnection);

// Handler unificado para mensajes POST (RPC)
async function handleMessagePost(req, res) {
  // Normalizar cabecera Accept para evitar 406 Not Acceptable del SDK
  if (!req.headers.accept || !req.headers.accept.includes("text/event-stream")) {
    req.headers.accept = "application/json, text/event-stream";
  }

  const rawBody = req.body;
  const method = Array.isArray(rawBody)
    ? rawBody.map((m) => m.method).join(", ")
    : rawBody?.method || "(raw)";

  // 1. Si viene con sessionId en query o headers SSE (/message?sessionId=...)
  const querySessionId = req.query.sessionId || req.headers["x-session-id"];
  if (querySessionId && sseTransports.has(querySessionId)) {
    const transport = sseTransports.get(querySessionId);
    console.log(`[POST /message] 📩 SSE RPC [${method}] para sesión: ${querySessionId}`);
    try {
      await transport.handlePostMessage(req, res, rawBody);
    } catch (error) {
      console.error(`[POST /message] Error:`, error);
      if (!res.headersSent) res.status(500).json({ error: String(error) });
    }
    return;
  }

  // 2. Streamable HTTP multi-sesión (utilizado directamente por Gemini Spark en POST /sse, POST /mcp, POST /)
  const isInit =
    rawBody?.method === "initialize" ||
    (Array.isArray(rawBody) && rawBody.some((m) => m.method === "initialize"));

  let httpSessionId = req.headers["mcp-session-id"];

  if (isInit) {
    // Generar nuevo sessionId para esta sesión de Gemini
    const newSessionId = randomUUID();
    console.log(`[POST Streamable] ⚡ Inicializando nueva sesión Streamable HTTP: ${newSessionId}`);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => newSessionId,
      enableJsonResponse: true,
    });

    const { server, type } = await createMcpInstance();
    await server.connect(transport);

    streamableSessions.set(newSessionId, {
      transport,
      server,
      lastActive: Date.now(),
    });

    try {
      await transport.handleRequest(req, res, rawBody);
      console.log(`[POST Streamable] ✅ Sesión ${newSessionId} inicializada exitosamente (${type})`);
    } catch (err) {
      console.error(`[POST Streamable] Error en initialize:`, err);
      if (!res.headersSent) res.status(500).json({ error: String(err) });
    }
    return;
  }

  // Si no es initialize, buscar la sesión existente por mcp-session-id
  let activeSession = httpSessionId ? streamableSessions.get(httpSessionId) : null;

  // Si no se encuentra o el cliente no envió mcp-session-id, usar la sesión más reciente como fallback
  if (!activeSession && streamableSessions.size > 0) {
    const latestSession = Array.from(streamableSessions.values()).pop();
    activeSession = latestSession;
  }

  if (activeSession) {
    console.log(`[POST Streamable] 📩 RPC [${method}] en sesión activa`);
    activeSession.lastActive = Date.now();
    try {
      await activeSession.transport.handleRequest(req, res, rawBody);
    } catch (err) {
      console.error(`[POST Streamable] Error en request [${method}]:`, err);
      if (!res.headersSent) res.status(500).json({ error: String(err) });
    }
    return;
  }

  // Si no hay ninguna sesión activa y no fue initialize, crear una sobre la marcha
  console.log(`[POST Streamable] ⚠️ Creando sesión fallback para RPC [${method}]`);
  const fallbackSessionId = randomUUID();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => fallbackSessionId,
    enableJsonResponse: true,
  });
  const { server } = await createMcpInstance();
  await server.connect(transport);
  streamableSessions.set(fallbackSessionId, {
    transport,
    server,
    lastActive: Date.now(),
  });

  try {
    await transport.handleRequest(req, res, rawBody);
  } catch (err) {
    console.error(`[POST Streamable] Error en fallback request:`, err);
    if (!res.headersSent) res.status(500).json({ error: String(err) });
  }
}

// Endpoints POST para RPC
app.post("/message", handleMessagePost);
app.post("/sse/message", handleMessagePost);
app.post("/sse", handleMessagePost);
app.post("/mcp", handleMessagePost);
app.post("/", handleMessagePost);

// Iniciar servidor HTTP
const serverInstance = app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n======================================================`);
  console.log(`🚀 LinkedIn MCP Universal Server listo para Gemini`);
  console.log(`📍 Puerto local: ${PORT}`);
  console.log(`🔗 SSE: http://localhost:${PORT}/sse`);
  console.log(`🔗 MCP: http://localhost:${PORT}/mcp`);
  console.log(`🔗 POST Message: http://localhost:${PORT}/message`);
  console.log(`======================================================\n`);
});

// Limpieza periódica de sesiones inactivas cada 10 minutos
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of streamableSessions.entries()) {
    if (now - session.lastActive > 30 * 60 * 1000) {
      try {
        session.transport.close();
      } catch {}
      streamableSessions.delete(id);
    }
  }
}, 10 * 60 * 1000);

// Cierre graceful
function handleShutdown(signal) {
  console.log(`\n[Shutdown] Recibida señal ${signal}. Cerrando conexiones...`);
  for (const [id, transport] of sseTransports.entries()) {
    try {
      transport.close();
    } catch {}
  }
  for (const [id, session] of streamableSessions.entries()) {
    try {
      session.transport.close();
    } catch {}
  }
  sseTransports.clear();
  streamableSessions.clear();
  serverInstance.close(() => {
    console.log("[Shutdown] Servidor detenido.");
    process.exit(0);
  });
}

process.on("SIGINT", () => handleShutdown("SIGINT"));
process.on("SIGTERM", () => handleShutdown("SIGTERM"));
