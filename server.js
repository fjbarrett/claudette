import "./src/env-autoload.js"; // load .env before anything reads process.env
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { saveTranscript } from "./src/transcript.js";
import { resolveOllamaBaseUrl } from "./src/config.js";
import { chatStream, getModels as getProviderModels } from "./src/provider.js";
import { getModels as getAnthropicModels } from "./src/anthropic.js";
import { createTurnTrace } from "./src/trace.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Loopback by default: this server has no auth and exposes the workspace, so it
// must not be reachable from the LAN unless someone opts in with HOST=0.0.0.0.
const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = Number(process.env.PORT ?? 4321);
const OLLAMA_BASE_URL = resolveOllamaBaseUrl();
const WORKSPACE_ROOT = path.resolve(process.env.WORKSPACE_ROOT ?? __dirname);
const DATA_DIR = path.join(__dirname, "data");
const SESSIONS_DIR = path.join(DATA_DIR, "sessions");
const PUBLIC_DIR = path.join(__dirname, "public");
const BENCH_REPORTS_DIR = path.join(__dirname, "bench", "runs", "reports");
const DEFAULT_SYSTEM_PROMPT = [
  "You are a local coding assistant running through a terminal-first interface.",
  "Prioritize direct, technically correct answers, concise plans, code, and debugging help.",
  "When the user asks for code, return complete snippets or patches with clear file names when appropriate."
].join(" ");

await ensureDir(SESSIONS_DIR);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }

    await serveStatic(req, res, url);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    if (res.headersSent) {
      // Mid-stream failure: headers are gone, so close the stream with an
      // error line instead of leaving the client waiting forever.
      writeNdjson(res, { type: "error", error: message });
      res.end();
    } else {
      sendJson(res, error?.status ?? 500, { error: message });
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Claudette listening on http://${HOST}:${PORT}`);
});

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      ollamaBaseUrl: OLLAMA_BASE_URL,
      workspaceRoot: WORKSPACE_ROOT
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/models") {
    const models = [];
    try {
      const tags = await ollamaRequest("/api/tags", { method: "GET" });
      models.push(...(tags.models ?? []).map((model) => ({
        name: model.name,
        size: model.size,
        family: model.details?.family ?? "unknown",
        parameterSize: model.details?.parameter_size ?? "unknown",
        modifiedAt: model.modified_at
      })));
    } catch {
      // Ollama unreachable — still offer any configured cloud models below.
    }
    for (const m of await getAnthropicModels()) {
      models.push({
        name: m.name,
        size: m.size,
        family: m.family,
        parameterSize: m.paramSize,
        modifiedAt: m.modified
      });
    }
    sendJson(res, 200, { models });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/sessions") {
    const sessions = await listSessions();
    sendJson(res, 200, { sessions });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/sessions") {
    const body = await readJson(req);
    const session = {
      id: randomUUID(),
      title: truncateLine(body?.title || "New Session", 60),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      model: body?.model || null,
      cwd: normalizeWorkspacePath(body?.cwd || WORKSPACE_ROOT),
      messages: [],
      turns: []
    };
    await saveSession(session);
    sendJson(res, 201, { session });
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/sessions/")) {
    const sessionId = getSessionId(url.pathname);
    const session = await loadSession(sessionId);
    sendJson(res, 200, { session });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/bench") {
    const reports = await loadBenchReports();
    sendJson(res, 200, { reports });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/expand") {
    const body = await readJson(req);
    const expanded = await expandPromptContext(body?.text ?? "", body?.cwd ?? WORKSPACE_ROOT);
    sendJson(res, 200, expanded);
    return;
  }

  if (req.method === "POST" && url.pathname.startsWith("/api/sessions/") && url.pathname.endsWith("/messages")) {
    const sessionId = getSessionId(url.pathname.replace(/\/messages$/, ""));
    const body = await readJson(req);
    await streamAssistantReply({ req, res, sessionId, body });
    return;
  }

  sendJson(res, 404, { error: "Not found." });
}

async function serveStatic(req, res, url) {
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "Method not allowed." });
    return;
  }

  const relativePath = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.join(PUBLIC_DIR, path.normalize(relativePath));
  if (!isInsideRoot(filePath, PUBLIC_DIR)) {
    sendJson(res, 403, { error: "Forbidden." });
    return;
  }

  try {
    const stat = await fsp.stat(filePath);
    if (stat.isDirectory()) {
      sendJson(res, 404, { error: "Not found." });
      return;
    }

    const contentType = getContentType(filePath);
    res.writeHead(200, { "Content-Type": contentType });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    sendJson(res, 404, { error: "Not found." });
  }
}

// One turn per session at a time. Two overlapping POSTs to the same session both
// loaded it, both appended, and the slower save clobbered the faster one — the
// first turn's messages simply vanished.
const activeTurns = new Set();

async function streamAssistantReply({ req, res, sessionId, body }) {
  // Claim the slot synchronously. Checking here and adding after `loadSession`
  // left a window where two requests both passed the check.
  if (activeTurns.has(sessionId)) {
    sendJson(res, 409, { error: "This session already has a turn in flight. Wait for it to finish." });
    return;
  }
  activeTurns.add(sessionId);
  try {
    await runTurn();
  } finally {
    activeTurns.delete(sessionId);
  }

  async function runTurn() {
  const session = await loadSession(sessionId);
  if (!Array.isArray(session.turns)) {
    session.turns = [];
  }
  const model = body?.model || session.model || (await getDefaultModel());
  const cwd = normalizeWorkspacePath(body?.cwd || session.cwd || WORKSPACE_ROOT);
  const promptText = String(body?.content ?? "").trim();
  if (!promptText) {
    sendJson(res, 400, { error: "Message content is required." });
    return;
  }

  const expanded = await expandPromptContext(promptText, cwd);
  const userMessage = { role: "user", content: expanded.text };
  // Shared turn tracer; each event is also streamed to the browser as a
  // `trace` record so the web UI updates live.
  const trace = createTurnTrace({
    prompt: promptText,
    model,
    cwd,
    expandedFiles: expanded.files,
    onEvent: (event, turn) => writeNdjson(res, { type: "trace", turnId: turn.id, event })
  });
  const traceTurn = trace.turn;
  session.cwd = cwd;
  session.model = model;
  session.updatedAt = new Date().toISOString();
  session.messages.push(userMessage);
  session.turns.push(traceTurn);
  if (!session.title || session.title === "New Session") {
    session.title = truncateLine(promptText, 60);
  }
  await saveSession(session);

  const conversation = [
    { role: "system", content: body?.system || DEFAULT_SYSTEM_PROMPT },
    ...session.messages
  ];

  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });

  writeNdjson(res, {
    type: "meta",
    model,
    cwd,
    expandedFiles: expanded.files,
    traceTurn
  });

  trace.event("input_received", { promptChars: promptText.length });
  trace.event("files_expanded", { count: expanded.files.length, files: expanded.files });
  trace.event("system_prompt_built", {
    systemChars: String(body?.system || DEFAULT_SYSTEM_PROMPT).length,
    historyMessages: conversation.length
  });
  trace.event("model_request_started", { model });
  trace.event("assistant_stream_started", {});

  // A closed tab used to leave the provider call running to completion, billed
  // and discarded. Abort it with the response.
  const clientGone = new AbortController();
  const onClose = () => clientGone.abort();
  res.on("close", onClose);

  let assistantText = "";
  let result;
  try {
    result = await chatStream({
      model,
      messages: conversation,
      signal: clientGone.signal,
      onDelta: (delta) => {
        assistantText += delta;
        writeNdjson(res, { type: "delta", content: delta });
      }
    });
  } catch (error) {
    res.off("close", onClose);
    if (clientGone.signal.aborted) {
      // The client hung up; record the turn honestly and stop.
      trace.cancel();
      trace.event("assistant_aborted", {});
      session.updatedAt = new Date().toISOString();
      await saveSession(session);
      res.end();
      return;
    }
    // Provider unreachable or stream failed mid-flight. Headers are already
    // sent, so finish the ndjson stream with an error record — otherwise the
    // client hangs waiting for "done" that never comes.
    const message = error instanceof Error ? error.message : String(error);
    trace.fail();
    trace.event("assistant_failed", { error: message });
    session.updatedAt = new Date().toISOString();
    await saveSession(session);
    writeNdjson(res, { type: "error", error: message, traceTurn });
    res.end();
    return;
  }
  res.off("close", onClose);
  // result.content is the cleaned/full text; prefer it for the saved record.
  assistantText = result.content || assistantText;

  const assistantMessage = { role: "assistant", content: assistantText };
  session.messages.push(assistantMessage);
  trace.addUsage({ promptTokens: result.promptTokens ?? 0, completionTokens: result.completionTokens ?? 0 });
  trace.complete();
  trace.event("assistant_completed", { chars: assistantText.length, ...traceTurn.metrics });
  session.updatedAt = new Date().toISOString();
  await saveSession(session);

  writeNdjson(res, {
    type: "done",
    sessionId: session.id,
    title: session.title,
    traceTurn
  });
  res.end();
  }
}

async function ollamaRequest(endpoint, init) {
  const response = await fetch(`${OLLAMA_BASE_URL}${endpoint}`, init);
  if (!response.ok) {
    throw new Error(`Ollama request failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function listSessions() {
  const fileNames = await fsp.readdir(SESSIONS_DIR);
  const sessions = await Promise.all(
    fileNames
      .filter((fileName) => fileName.endsWith(".json"))
      .map(async (fileName) => {
        try {
          const fullPath = path.join(SESSIONS_DIR, fileName);
          const raw = await fsp.readFile(fullPath, "utf8");
          const session = JSON.parse(raw);
          return {
            id: session.id,
            title: session.title,
            model: session.model,
            cwd: session.cwd,
            updatedAt: session.updatedAt,
            messageCount: session.messages.length
          };
        } catch {
          return null;
        }
      })
  ).then((results) => results.filter(Boolean));

  return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function loadSession(sessionId) {
  const filePath = path.join(SESSIONS_DIR, `${sessionId}.json`);
  const raw = await fsp.readFile(filePath, "utf8");
  const session = JSON.parse(raw);
  session.turns = Array.isArray(session.turns) ? session.turns : [];
  return session;
}

async function saveSession(session) {
  const filePath = path.join(SESSIONS_DIR, `${session.id}.json`);
  await fsp.writeFile(filePath, `${JSON.stringify(session, null, 2)}\n`, "utf8");
  await saveTranscript(session);
}

async function loadBenchReports() {
  try {
    await fsp.mkdir(BENCH_REPORTS_DIR, { recursive: true });
    const files = await fsp.readdir(BENCH_REPORTS_DIR);
    const reports = await Promise.all(
      files
        .filter(f => f.endsWith(".json"))
        .sort()
        .reverse()
        .map(async f => {
          try {
            const raw = await fsp.readFile(path.join(BENCH_REPORTS_DIR, f), "utf8");
            const r = JSON.parse(raw);
            return {
              file: f,
              taskId: r.task?.id,
              taskTitle: r.task?.title,
              category: r.task?.category,
              model: r.model,
              judgeModel: r.judgeModel,
              startedAt: r.startedAt,
              completedAt: r.completedAt,
              summary: r.summary,
              hardChecks: r.hardChecks,
              verification: r.verification,
              llmJudgment: r.llmJudgment,
              workflow: r.workflow,
              git: { diffStat: r.git?.diffStat },
            };
          } catch { return null; }
        })
    );
    return reports.filter(Boolean);
  } catch { return []; }
}

async function expandPromptContext(text, cwd) {
  const files = [];
  let expandedText = text;
  const matches = [...text.matchAll(/(^|\s)@([^\s]+)/g)];

  for (const match of matches) {
    const token = match[2];
    try {
      const filePath = resolveWorkspaceFile(token, cwd);
      const stat = await fsp.stat(filePath);
      if (!stat.isFile()) {
        continue;
      }

      const content = await fsp.readFile(filePath, "utf8");
      files.push(path.relative(WORKSPACE_ROOT, filePath) || path.basename(filePath));
      expandedText = expandedText.replace(
        `@${token}`,
        `\n\n[file:${path.relative(WORKSPACE_ROOT, filePath)}]\n\`\`\`\n${content}\n\`\`\`\n`
      );
    } catch {
      // file not found, outside workspace, or unreadable — leave @token as-is
    }
  }

  return { text: expandedText, files };
}

// Containment check mirroring guardPath in src/tools.js. A string prefix match is
// not a boundary: with root "/x/claudette", "/x/claudette-evil" starts with it and
// would pass. Compare the relative path instead.
function isInsideRoot(absolutePath, root) {
  const rel = path.relative(root, absolutePath);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

function resolveWorkspaceFile(inputPath, cwd) {
  const absolutePath = path.resolve(cwd, inputPath);
  if (!isInsideRoot(absolutePath, WORKSPACE_ROOT)) {
    throw new Error("Requested file is outside the workspace.");
  }
  return absolutePath;
}

function normalizeWorkspacePath(inputPath) {
  const absolutePath = path.resolve(inputPath);
  if (!isInsideRoot(absolutePath, WORKSPACE_ROOT)) {
    return WORKSPACE_ROOT;
  }
  return absolutePath;
}

async function getDefaultModel() {
  try {
    const tags = await ollamaRequest("/api/tags", { method: "GET" });
    if (tags.models?.[0]?.name) return tags.models[0].name;
  } catch {
    // Ollama unreachable — fall back to a configured cloud model if present.
  }
  const all = await getProviderModels().catch(() => []);
  return all[0]?.name || "llama3.2:latest";
}

function writeNdjson(res, payload) {
  res.write(`${JSON.stringify(payload)}\n`);
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(`${JSON.stringify(payload)}\n`);
}

// Cap on a request body. Without one, `for await (const chunk of req)` buffers
// whatever a client sends — an unauthenticated loopback server that will happily
// accept a gigabyte into memory. 1 MB is far above any real prompt.
const MAX_BODY_BYTES = Number(process.env.CLAUDETTE_MAX_BODY_BYTES) || 1024 * 1024;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  let tooBig = false;
  for await (const chunk of req) {
    size += chunk.length;
    // Stop buffering, but keep draining: destroying the socket here resets the
    // connection, and the client never gets to read the 413 we are about to send.
    if (size > MAX_BODY_BYTES) { tooBig = true; continue; }
    chunks.push(chunk);
  }
  if (tooBig) throw new HttpError(413, `Request body exceeds ${MAX_BODY_BYTES} bytes.`);
  const body = Buffer.concat(chunks).toString("utf8");
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw new HttpError(400, "Request body is not valid JSON.");
  }
}

async function ensureDir(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true });
}

function getSessionId(sessionPath) {
  const parts = sessionPath.split("/");
  const sessionId = parts.at(-1);
  if (!sessionId) {
    throw new Error("Session ID is missing.");
  }
  return sessionId;
}

function truncateLine(value, maxLength) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function getContentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  return "text/plain; charset=utf-8";
}
