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
app.use(express.text({ type: "*/*" }));

const sessions = new Map();

app.get("/mcp", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  res.flushHeaders();

  const sessionId = crypto.randomUUID();
  const endpoint = `https://mcp-linkedin.wisp.uno/mcp/message?sessionId=${sessionId}`;

  const child = spawn("node", ["./dist/index.js"], {
    env: { ...process.env, FORCE_COLOR: "0" },
    stdio: ["pipe", "pipe", "inherit"],
  });

  sessions.set(sessionId, { res, child });

  res.write(`event: endpoint\r\ndata: ${endpoint}\r\n\r\n`);

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("{")) {
        res.write(`event: message\r\ndata: ${trimmed}\r\n\r\n`);
      }
    }
  });

  req.on("close", () => {
    child.kill();
    sessions.delete(sessionId);
  });
});

app.post("/mcp/message", (req, res) => {
  const sessionId = req.query.sessionId;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }

  const payload =
    typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  session.child.stdin.write(payload + "\n");
  res.status(200).send("OK");
});

app.listen(PORT, "0.0.0.0", () => console.log(`Listening on ${PORT}`));
