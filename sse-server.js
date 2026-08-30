import express from "express";
import { spawn } from "child_process";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

const app = express();
const PORT = process.env.PORT || 9973;

// Map para guardar transportes y subprocesos por sesión
const sessions = new Map();

app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/message", res);

  // Iniciar una instancia del servidor MCP en stdio dedicada para esta conexión
  const child = spawn("node", ["/home/container/dist/index.js"], {
    env: process.env,
    stdio: ["pipe", "pipe", "inherit"],
  });

  const sessionId = transport.sessionId;
  sessions.set(sessionId, { transport, child });

  child.stdout.on("data", (data) => {
    // Redirigir la salida stdio del proceso al cliente SSE
    try {
      const lines = data.toString().split("\n");
      for (const line of lines) {
        if (line.trim()) {
          const json = JSON.parse(line);
          transport.send(json);
        }
      }
    } catch (e) {
      // Ignorar logs que no sean JSON
    }
  });

  req.on("close", () => {
    child.kill();
    sessions.delete(sessionId);
  });

  await transport.start();
});

app.post("/message", express.json(), async (req, res) => {
  const sessionId = req.query.sessionId;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).send("Session not found");
  }

  // Enviar mensaje del cliente web al stdin del proceso
  session.child.stdin.write(JSON.stringify(req.body) + "\n");
  res.status(200).send("OK");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[SSE MCP Server] Listening on http://0.0.0.0:${PORT}/sse`);
});
