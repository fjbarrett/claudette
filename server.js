import "./src/env-autoload.js"; // load .env before anything reads process.env
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { resolveOllamaBaseUrl } from "./src/config.js";
import { getModels as getProviderModels } from "./src/provider.js";
import { runAgent } from "./src/agent-runner.js";
import { createTurnTrace } from "./src/trace.js";
import { recordTurnUsage } from "./src/usage.js";
import { expandFiles } from "./src/context.js";
import {
  createSession as createStoredSession,
  listSessions as listStoredSessions,
  loadSession as loadStoredSession,
  saveSession as saveStoredSession,
} from "./src/session.js";
import { guardWorkspacePath, isWithinPath, realpathOrSelf } from "./src/workspace-path.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = Number(process.env.PORT ?? 4321);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error(`Invalid PORT: ${process.env.PORT}`);
}
const SERVER_TOKEN = String(process.env.CLAUDETTE_SERVER_TOKEN ?? "").trim();
const configuredHosts = String(process.env.CLAUDETTE_ALLOWED_HOSTS ?? "")
  .split(",")
  .map(value => normalizeHostName(value.trim()))
  .filter(Boolean);
const bindIsLoopback = isLoopbackHost(HOST);
if (!bindIsLoopback && (!SERVER_TOKEN || configuredHosts.length === 0)) {
  throw new Error("Non-loopback HOST requires CLAUDETTE_SERVER_TOKEN and CLAUDETTE_ALLOWED_HOSTS.");
}
const ALLOWED_HOSTS = new Set(configuredHosts.length
  ? configuredHosts
  : ["127.0.0.1", "localhost", "::1"]);
const OLLAMA_BASE_URL = resolveOllamaBaseUrl();
const WORKSPACE_ROOT = await realpathOrSelf(path.resolve(process.env.WORKSPACE_ROOT ?? __dirname));
const PUBLIC_DIR = await realpathOrSelf(path.join(__dirname, "public"));
const BENCH_REPORTS_DIR = await realpathOrSelf(path.join(__dirname, "bench", "runs", "reports"));
const DEFAULT_SYSTEM_PROMPT = [
  "You are a local coding assistant running through a terminal-first interface.",
  "Prioritize direct, technically correct answers, concise plans, code, and debugging help.",
  "When the user asks for code, return complete snippets or patches with clear file names when appropriate."
].join(" ");

const server = http.createServer(async (req, res) => {
  try {
    setCommonSecurityHeaders(res, req);
    const authority = validateRequestSource(req);
    const url = new URL(req.url, `http://${authority}`);
    if (url.pathname.startsWith("/api/")) {
      requireApiAuthorization(req, res);
      await handleApi(req, res, url);
      return;
    }

    await serveStatic(req, res, url);
  } catch (error) {
    const status = Number(error?.status) || 500;
    const internalMessage = error instanceof Error ? error.message : "Unexpected server error.";
    const message = status >= 500 ? "Internal server error." : internalMessage;
    if (res.headersSent) {
      // Mid-stream failure: headers are gone, so close the stream with an
      // error line instead of leaving the client waiting forever.
      writeNdjson(res, { type: "error", error: internalMessage });
      res.end();
    } else {
      if (status >= 500) console.error(internalMessage);
      sendJson(res, status, { error: message });
    }
  }
});

server.on("clientError", (_error, socket) => {
  if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
});
server.headersTimeout = 15_000;
server.requestTimeout = 30_000;
server.keepAliveTimeout = 5_000;

server.listen(PORT, HOST, () => {
  console.log(`Claudette listening on http://${HOST}:${PORT}`);
});

function normalizeHostName(value) {
  return String(value ?? "").trim().replace(/^\[|\]$/g, "").toLowerCase();
}

function isLoopbackHost(value) {
  const host = normalizeHostName(value);
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function validateRequestSource(req) {
  const rawHost = req.headers.host;
  if (typeof rawHost !== "string" || !rawHost.trim()) {
    throw new HttpError(400, "Host header is required.");
  }

  let authority;
  try {
    authority = new URL(`http://${rawHost}`);
  } catch {
    throw new HttpError(400, "Invalid Host header.");
  }
  const hostname = normalizeHostName(authority.hostname);
  const rawPort = authority.port ? Number(authority.port) : PORT;
  const requestPort = Number.isFinite(rawPort) ? rawPort : PORT;
  if (!ALLOWED_HOSTS.has(hostname) || requestPort !== PORT) {
    throw new HttpError(421, "Misdirected request.");
  }

  if (String(req.headers["sec-fetch-site"] ?? "").toLowerCase() === "cross-site") {
    throw new HttpError(403, "Cross-site requests are not allowed.");
  }
  const origin = req.headers.origin;
  if (origin != null) {
    let parsedOrigin;
    try {
      parsedOrigin = new URL(String(origin));
    } catch {
      throw new HttpError(403, "Invalid request Origin.");
    }
    const originPort = Number(parsedOrigin.port || (parsedOrigin.protocol === "https:" ? 443 : 80));
    if (
      !["http:", "https:"].includes(parsedOrigin.protocol)
      || normalizeHostName(parsedOrigin.hostname) !== hostname
      || originPort !== requestPort
    ) {
      throw new HttpError(403, "Cross-origin requests are not allowed.");
    }
  }
  return rawHost;
}

function safeTokenEqual(provided, expected) {
  const left = Buffer.from(String(provided ?? ""));
  const right = Buffer.from(String(expected ?? ""));
  return left.length === right.length && timingSafeEqual(left, right);
}

const authFailures = new Map(); // ip -> { count, until }

function requireApiAuthorization(req, res) {
  if (!SERVER_TOKEN) return;
  const ip = req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = authFailures.get(ip);
  if (entry && entry.until > now) {
    res.setHeader('Retry-After', String(Math.ceil((entry.until - now)/1000)));
    throw new HttpError(429, "Too many authentication failures. Try again later.");
  }
  const match = String(req.headers.authorization ?? "").match(/^Bearer\s+(.+)$/i);
  if (!match || !safeTokenEqual(match[1], SERVER_TOKEN)) {
    const fails = (entry?.count ?? 0) + 1;
    const until = fails >= 5 ? now + 60_000 : 0;
    authFailures.set(ip, { count: fails, until });
    if (fails >= 5) console.warn(`[auth] ${ip} exceeded bearer failures, throttling 60s`);
    // decay entry after window
    if (until) setTimeout(() => authFailures.delete(ip), 60_000).unref?.();
    else if (fails >= 5) setTimeout(() => authFailures.delete(ip), 60_000).unref?.();
    res.setHeader("WWW-Authenticate", 'Bearer realm="claudette", error="invalid_token"');
    throw new HttpError(401, "Authentication required.");
  }
  // success: reset counter
  if (entry) authFailures.delete(ip);
}

function setCommonSecurityHeaders(res, req = null) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  const isHttps = req?.socket?.encrypted || String(req?.headers?.['x-forwarded-proto'] ?? '').toLowerCase() === 'https';
  if (isHttps) {
    res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  }
}

function setContentSecurityPolicy(res, nonce = null) {
  const scriptSources = ["'self'", ...(nonce ? [`'nonce-${nonce}'`] : [])].join(" ");
  res.setHeader("Content-Security-Policy", [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    `script-src ${scriptSources}`,
    "style-src 'self'",
    "connect-src 'self'",
    "img-src 'self' data:",
    "form-action 'self'",
  ].join("; "));
}

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
    const models = (await getProviderModels()).map((model) => ({
      name: model.name,
      size: model.size,
      family: model.family,
      parameterSize: model.paramSize,
      modifiedAt: model.modified,
      capabilities: model.capabilities,
    }));
    sendJson(res, 200, { models, defaultModel: await getDefaultModel() });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/sessions") {
    const limit = Number(url.searchParams.get("limit") ?? 0);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const sessions = await listSessions({ limit: Number.isFinite(limit) ? limit : 0, offset: Number.isFinite(offset) ? offset : 0 });
    sendJson(res, 200, { sessions });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/sessions") {
    const body = validateBody(await readJson(req), ["title", "model", "cwd"]);
    const title = optionalString(body, "title", { maxLength: 10_000 });
    const model = optionalString(body, "model", { allowNull: true, maxLength: 500 });
    const cwd = optionalString(body, "cwd", { allowNull: true, maxLength: 4096 });
    const session = await createStoredSession({
      title: truncateLine(title || "New Session", 60),
      model: model || null,
      cwd: await normalizeWorkspacePath(cwd || WORKSPACE_ROOT),
    });
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
    const body = validateBody(await readJson(req), ["text", "cwd"]);
    const text = optionalString(body, "text", { maxLength: MAX_BODY_BYTES }) ?? "";
    const cwd = optionalString(body, "cwd", { allowNull: true, maxLength: 4096 }) ?? WORKSPACE_ROOT;
    const expanded = await expandPromptContext(text, cwd);
    sendJson(res, 200, expanded);
    return;
  }

  if (req.method === "POST" && url.pathname.startsWith("/api/sessions/") && url.pathname.endsWith("/messages")) {
    const sessionId = getSessionId(url.pathname.replace(/\/messages$/, ""));
    const body = validateBody(await readJson(req), ["content", "model", "cwd", "system"]);
    optionalString(body, "content", { maxLength: MAX_BODY_BYTES });
    optionalString(body, "model", { allowNull: true, maxLength: 500 });
    optionalString(body, "cwd", { allowNull: true, maxLength: 4096 });
    optionalString(body, "system", { allowNull: true, maxLength: MAX_BODY_BYTES });
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

  let relativePath;
  try {
    relativePath = decodeURIComponent(url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, ""));
  } catch {
    throw new HttpError(400, "Malformed URL path.");
  }

  try {
    const filePath = await guardWorkspacePath(relativePath, PUBLIC_DIR, PUBLIC_DIR);
    const stat = await fsp.stat(filePath);
    if (stat.isDirectory()) {
      sendJson(res, 404, { error: "Not found." });
      return;
    }

    const contentType = getContentType(filePath);
    if (filePath.endsWith(".html")) {
      const nonce = randomBytes(18).toString("base64");
      setContentSecurityPolicy(res, nonce);
      const html = (await fsp.readFile(filePath, "utf8"))
        .replace(/<script\b/g, `<script nonce="${nonce}"`);
      res.writeHead(200, { "Content-Type": contentType, "Content-Length": Buffer.byteLength(html) });
      res.end(html);
      return;
    }
    setContentSecurityPolicy(res);
    const etag = `"${stat.size.toString(16)}-${Number(stat.mtimeMs).toString(16)}"`;
    const ifNoneMatch = req.headers["if-none-match"];
    if (ifNoneMatch === etag) {
      res.writeHead(304);
      res.end();
      return;
    }
    const headers = {
      "Content-Type": contentType,
      "Content-Length": stat.size,
      "ETag": etag,
      "Cache-Control": filePath.endsWith(".html") ? "no-cache" : "public, max-age=3600",
    };
    // Handle gzip if client accepts it and file is large enough? Keep simple: no compression for now but headers ready.
    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    if (error instanceof HttpError) throw error;
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
  let activeModel = model;
  const cwd = await normalizeWorkspacePath(body?.cwd || session.cwd || WORKSPACE_ROOT);
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
    onEvent: (event, turn) => writeNdjson(res, { type: "trace", turnId: turn.id, event }),
    onFinish: (turn) => recordTurnUsage(turn, session)
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
  // A closed tab used to leave the provider call running to completion, billed
  // and discarded. Abort it with the response.
  const clientGone = new AbortController();
  const onClose = () => clientGone.abort();
  res.on("close", onClose);

  let resolvedModel = null;
  let resolvedProvider = null;
  const result = await runAgent({
    model,
    messages: conversation,
    tools: [], // web runner is read-only; tool calls via HTTP are not executed (see test at test.js:3375)
    signal: clientGone.signal,
    toolContext: { cwd, workspace: WORKSPACE_ROOT },
    onDelta: (delta) => writeNdjson(res, { type: "delta", content: delta }),
    emit: async (type, data) => {
      if (type === "request_start") {
        trace.event("model_request_started", { model: data.model, iteration: data.iteration });
      } else if (type === "stream_started") {
        trace.event("assistant_stream_started", { iteration: data.iteration });
      } else if (type === "model_switch") {
        activeModel = data.to;
        traceTurn.finalModel = data.to;
        trace.event("model_switch", {
          from: data.from,
          to: data.to,
          reason: data.reason,
          status: data.status,
          switch: data.switch,
          requestTokens: data.requestTokens,
          skippedModels: data.skippedModels,
        });
        writeNdjson(res, {
          type: "model_switch",
          from: data.from,
          to: data.to,
          reason: data.reason,
          status: data.status,
          requestTokens: data.requestTokens,
          skippedModels: data.skippedModels,
        });
      } else if (type === "usage") {
        const last = data.last ?? {};
        resolvedModel = last.resolvedModel ?? resolvedModel;
        resolvedProvider = last.resolvedProvider ?? resolvedProvider;
        if (last.resolvedModel || last.resolvedProvider) {
          trace.event("model_resolved", {
            requestedModel: data.model,
            model: last.resolvedModel ?? null,
            provider: last.resolvedProvider ?? null,
          });
        }
        if (last.rateLimit) traceTurn.rateLimit = last.rateLimit;
      } else if (type === "message") {
        session.messages.push(data.message);
      }
    },
  });
  res.off("close", onClose);
  activeModel = result.model || activeModel;
  session.model = activeModel;
  traceTurn.finalModel = activeModel;
  traceTurn.attemptedModels = result.attemptedModels;

  if (result.status === "cancelled" || clientGone.signal.aborted) {
    trace.cancel();
    trace.event("assistant_aborted", {});
    await saveSession(session);
    res.end();
    return;
  }
  if (result.status !== "completed") {
    const message = result.error instanceof Error
      ? result.error.message
      : String(result.error || `Agent turn ended with status ${result.status}.`);
    trace.fail();
    trace.event("assistant_failed", { error: message, status: result.status });
    await saveSession(session);
    writeNdjson(res, { type: "error", error: message, traceTurn });
    res.end();
    return;
  }

  const assistantText = result.content || "";
  trace.addUsage(result.usage);
  trace.complete();
  trace.event("assistant_completed", {
    chars: assistantText.length,
    resolvedModel,
    resolvedProvider,
    ...traceTurn.metrics,
  });
  await saveSession(session);

  writeNdjson(res, {
    type: "done",
    sessionId: session.id,
    title: session.title,
    model: activeModel,
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
  return listStoredSessions();
}

async function loadSession(sessionId) {
  getSessionId(`/sessions/${sessionId}`);
  try {
    const session = await loadStoredSession(sessionId);
    session.turns = Array.isArray(session.turns) ? session.turns : [];
    return session;
  } catch (error) {
    if (error?.code === "ENOENT" || /Session not found/.test(String(error?.message))) {
      throw new HttpError(404, "Session not found.");
    }
    throw error;
  }
}

async function saveSession(session) {
  getSessionId(`/sessions/${session.id}`);
  await saveStoredSession(session);
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
            const reportPath = await guardWorkspacePath(f, BENCH_REPORTS_DIR, BENCH_REPORTS_DIR);
            const raw = await fsp.readFile(reportPath, "utf8");
            const r = JSON.parse(raw);
            return normalizeBenchReport(r, f);
          } catch { return null; }
        })
    );
    return reports.filter(Boolean);
  } catch { return []; }
}

function normalizeBenchReport(report, fileName) {
  if (!report || typeof report !== "object" || Array.isArray(report)) return null;
  const numberOrNull = value => Number.isFinite(Number(value)) ? Number(value) : null;
  const shortText = (value, max = 500) => typeof value === "string" ? value.slice(0, max) : "";
  const rawScores = report.llmJudgment?.scores;
  const scores = rawScores && typeof rawScores === "object" && !Array.isArray(rawScores)
    ? Object.fromEntries(Object.entries(rawScores).slice(0, 50).map(([key, value]) => [
        shortText(key, 100),
        typeof value === "number" ? value : shortText(value, 200),
      ]))
    : null;
  const verification = Array.isArray(report.verification)
    ? report.verification.slice(0, 100).map(item => ({
        code: Number.isInteger(item?.code) ? item.code : 1,
        command: shortText(item?.command, 2_000),
        stdout: shortText(item?.stdout, 20_000),
        stderr: shortText(item?.stderr, 20_000),
      }))
    : [];
  return {
    file: shortText(fileName, 255),
    taskId: shortText(report.task?.id),
    taskTitle: shortText(report.task?.title),
    category: shortText(report.task?.category),
    model: shortText(report.model),
    judgeModel: shortText(report.judgeModel),
    startedAt: shortText(report.startedAt, 100),
    completedAt: shortText(report.completedAt, 100),
    summary: {
      hardScore: numberOrNull(report.summary?.hardScore),
      judgeScore: numberOrNull(report.summary?.judgeScore),
      overallScore: numberOrNull(report.summary?.overallScore),
    },
    hardChecks: {
      filesChanged: report.hardChecks?.filesChanged === true,
      verificationPassRate: numberOrNull(report.hardChecks?.verificationPassRate),
    },
    verification,
    llmJudgment: report.llmJudgment && typeof report.llmJudgment === "object" ? {
      error: shortText(report.llmJudgment.error, 2_000),
      summary: shortText(report.llmJudgment.summary, 10_000),
      scores,
    } : null,
    workflow: { summary: shortText(report.workflow?.summary, 20_000) },
    git: { diffStat: shortText(report.git?.diffStat, 10_000) },
  };
}

async function expandPromptContext(text, cwd) {
  const safeCwd = await normalizeWorkspacePath(cwd);
  return expandFiles(text, safeCwd, WORKSPACE_ROOT);
}

async function normalizeWorkspacePath(inputPath) {
  const absolutePath = path.resolve(inputPath);
  try {
    const realPath = await fsp.realpath(absolutePath);
    const stat = await fsp.stat(realPath);
    if (stat.isDirectory() && isWithinPath(WORKSPACE_ROOT, realPath)) return realPath;
  } catch {
    // Invalid, missing, or escaping cwd values safely fall back to the root.
  }
  return WORKSPACE_ROOT;
}

async function getDefaultModel() {
  if (process.env.CLAUDETTE_MODEL) return process.env.CLAUDETTE_MODEL;
  const all = await getProviderModels().catch(() => []);
  return all[0]?.name || "llama3.2:latest";
}

function writeNdjson(res, payload) {
  res.write(`${JSON.stringify(payload)}\n`);
}

function sendJson(res, statusCode, payload) {
  const body = `${JSON.stringify(payload)}\n`;
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
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
  const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
  if (!/^application\/json(?:\s*;|$)/.test(contentType)) {
    throw new HttpError(415, "Content-Type must be application/json.");
  }
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

function validateBody(body, allowedKeys) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "Request body must be a JSON object.");
  }
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(body).find(key => !allowed.has(key));
  if (unknown) throw new HttpError(400, `Unknown request field: ${unknown}`);
  return body;
}

function optionalString(body, key, { allowNull = false, maxLength = 100_000 } = {}) {
  const value = body[key];
  if (value === undefined || (allowNull && value === null)) return value;
  if (typeof value !== "string") throw new HttpError(400, `${key} must be a string.`);
  if (value.length > maxLength) throw new HttpError(400, `${key} is too long.`);
  return value;
}

function getSessionId(sessionPath) {
  const parts = sessionPath.split("/");
  const sessionId = parts.at(-1);
  if (!sessionId || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
    throw new HttpError(400, "Invalid session ID.");
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
