import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import path from "node:path";

const API_BASE_URL = process.env.API_BASE_URL ?? "http://127.0.0.1:4321";
const cwd = process.cwd();
let currentModel = null;
let currentSessionId = null;
let modelsCache = [];

const rl = readline.createInterface({ input, output });

await ensureSession();
printBanner();

while (true) {
  const promptLabel = `${currentModel ?? "loading"}${currentSessionId ? `:${currentSessionId.slice(0, 8)}` : ""}> `;
  const line = (await rl.question(promptLabel)).trim();

  if (!line) {
    continue;
  }

  if (line === "/exit" || line === "/quit") {
    break;
  }

  if (line.startsWith("/")) {
    const shouldContinue = await handleCommand(line);
    if (!shouldContinue) {
      break;
    }
    continue;
  }

  await streamReply(line);
}

rl.close();

function printBanner() {
  console.log("Ollama Code Console CLI");
  console.log(`workspace: ${cwd}`);
  console.log("commands: /help /models /model <name> /new /sessions /use <id> /clear /exit");
}

async function handleCommand(line) {
  const [command, ...rest] = line.split(/\s+/);
  const arg = rest.join(" ").trim();

  if (command === "/help") {
    console.log("Use @relative/path to inline a workspace file into your prompt.");
    console.log("/models lists Ollama models.");
    console.log("/model <name> switches the active model.");
    console.log("/new creates a fresh session.");
    console.log("/sessions lists saved sessions.");
    console.log("/use <id> loads a session id.");
    console.log("/clear starts a new session with the current model.");
    console.log("/exit quits.");
    return true;
  }

  if (command === "/models") {
    modelsCache = [];
    const models = await fetchModels();
    for (const model of models) {
      console.log(`${model.name}  ${model.parameterSize}  ${model.family}`);
    }
    return true;
  }

  if (command === "/model") {
    if (!arg) {
      console.log("usage: /model <name>");
      return true;
    }
    currentModel = arg;
    console.log(`model set to ${currentModel}`);
    return true;
  }

  if (command === "/new" || command === "/clear") {
    currentSessionId = null;
    await ensureSession();
    console.log(`new session ${currentSessionId}`);
    return true;
  }

  if (command === "/sessions") {
    const response = await fetchJson("/api/sessions");
    for (const session of response.sessions) {
      console.log(`${session.id}  ${session.model ?? "unset"}  ${session.title}`);
    }
    return true;
  }

  if (command === "/use") {
    if (!arg) {
      console.log("usage: /use <session-id>");
      return true;
    }
    const session = await fetchJson(`/api/sessions/${arg}`);
    currentSessionId = session.session.id;
    currentModel = session.session.model || currentModel;
    console.log(`using session ${currentSessionId}`);
    return true;
  }

  console.log(`unknown command: ${command}`);
  return true;
}

async function ensureSession() {
  if (currentSessionId) {
    return;
  }

  if (!currentModel) {
    const models = await fetchModels();
    currentModel = models[0]?.name ?? "llama3.2:latest";
  }

  const response = await fetchJson("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "CLI Session",
      model: currentModel,
      cwd
    })
  });
  currentSessionId = response.session.id;
}

async function streamReply(content) {
  await ensureSession();
  const response = await fetch(`${API_BASE_URL}/api/sessions/${currentSessionId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content,
      model: currentModel,
      cwd
    })
  });

  if (!response.ok || !response.body) {
    console.log(`request failed: ${response.status}`);
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let printedHeader = false;

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }

      let chunk;
      try { chunk = JSON.parse(line); } catch { continue; }
      if (chunk.type === "meta" && !printedHeader) {
        printedHeader = true;
        if (Array.isArray(chunk.expandedFiles) && chunk.expandedFiles.length > 0) {
          console.log(`using files: ${chunk.expandedFiles.join(", ")}`);
        }
      }

      if (chunk.type === "delta") {
        output.write(chunk.content);
      }

      if (chunk.type === "done") {
        output.write("\n");
      }
    }
  }
}

async function fetchModels() {
  if (modelsCache.length > 0) {
    return modelsCache;
  }
  const response = await fetchJson("/api/models");
  modelsCache = response.models;
  return modelsCache;
}

async function fetchJson(endpoint, init) {
  const response = await fetch(`${API_BASE_URL}${endpoint}`, init);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }
  return response.json();
}
