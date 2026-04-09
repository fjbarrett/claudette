const state = {
  sessions: [],
  models: [],
  currentSessionId: null,
  currentModel: null,
  turns: []
};

const transcriptEl = document.querySelector("#transcript");
const sessionListEl = document.querySelector("#session-list");
const modelSelectEl = document.querySelector("#model-select");
const modelMetaEl = document.querySelector("#model-meta");
const statusChipEl = document.querySelector("#status-chip");
const composerEl = document.querySelector("#composer");
const promptInputEl = document.querySelector("#prompt-input");
const cwdInputEl = document.querySelector("#cwd-input");
const clearOutputEl = document.querySelector("#clear-output");
const newSessionEl = document.querySelector("#new-session");
const refreshModelsEl = document.querySelector("#refresh-models");
const templateEl = document.querySelector("#message-template");
const traceListEl = document.querySelector("#trace-list");

bootstrap().catch(err => {
  appendMessage("system", `Startup error: ${err.message}. Is Ollama running?`);
});

composerEl.addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = promptInputEl.value.trim();
  if (!input) {
    return;
  }

  if (input.startsWith("/")) {
    await handleCommand(input);
    promptInputEl.value = "";
    return;
  }

  appendMessage("user", input);
  promptInputEl.value = "";
  await sendPrompt(input);
});

clearOutputEl.addEventListener("click", () => {
  transcriptEl.innerHTML = "";
});

newSessionEl.addEventListener("click", async () => {
  await createSession();
});

refreshModelsEl.addEventListener("click", async () => {
  await loadModels();
});

modelSelectEl.addEventListener("change", () => {
  state.currentModel = modelSelectEl.value;
  renderModelMeta();
});

async function bootstrap() {
  await loadModels();
  await loadSessions();
  if (!state.currentSessionId) {
    await createSession();
  } else {
    await openSession(state.currentSessionId);
  }
}

async function loadModels() {
  const response = await fetchJson("/api/models");
  state.models = response.models;
  if (!state.currentModel) {
    state.currentModel = state.models[0]?.name ?? null;
  }
  renderModels();
}

async function loadSessions() {
  const response = await fetchJson("/api/sessions");
  state.sessions = response.sessions;
  if (!state.currentSessionId && state.sessions[0]) {
    state.currentSessionId = state.sessions[0].id;
  }
  renderSessions();
}

async function createSession() {
  const response = await fetchJson("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "Web Session",
      model: state.currentModel,
      cwd: cwdInputEl.value.trim()
    })
  });
  state.currentSessionId = response.session.id;
  await loadSessions();
  transcriptEl.innerHTML = "";
  state.turns = [];
  renderTraceTurns();
}

async function openSession(sessionId) {
  const response = await fetchJson(`/api/sessions/${sessionId}`);
  state.currentSessionId = response.session.id;
  state.currentModel = response.session.model || state.currentModel;
  state.turns = response.session.turns ?? [];
  cwdInputEl.value = response.session.cwd;
  transcriptEl.innerHTML = "";

  for (const message of response.session.messages) {
    appendMessage(message.role, message.content);
  }

  renderModels();
  renderSessions();
  renderTraceTurns();
}

async function sendPrompt(content) {
  if (!state.currentSessionId) {
    await createSession();
  }

  setStatus("streaming");
  const assistantNode = appendMessage("assistant", "");
  const response = await fetch(`/api/sessions/${state.currentSessionId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content,
      model: state.currentModel,
      cwd: cwdInputEl.value.trim()
    })
  });

  if (!response.ok || !response.body) {
    assistantNode.textContent = `Request failed: ${response.status}`;
    setStatus("error");
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let activeTurnId = null;

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
      if (chunk.type === "meta" && chunk.expandedFiles?.length) {
        appendMessage("context", `Expanded files: ${chunk.expandedFiles.join(", ")}`);
      }
      if (chunk.type === "meta" && chunk.traceTurn) {
        activeTurnId = chunk.traceTurn.id;
        upsertTraceTurn(chunk.traceTurn);
      }
      if (chunk.type === "trace" && chunk.turnId) {
        addTraceEvent(chunk.turnId, chunk.event);
      }
      if (chunk.type === "delta") {
        assistantNode.textContent += chunk.content;
        transcriptEl.scrollTop = transcriptEl.scrollHeight;
      }
      if (chunk.type === "done") {
        if (chunk.traceTurn) {
          upsertTraceTurn(chunk.traceTurn);
        } else if (activeTurnId) {
          markTraceTurnCompleted(activeTurnId);
        }
        await loadSessions();
        setStatus("idle");
      }
    }
  }
}

async function handleCommand(input) {
  const [command, ...rest] = input.split(/\s+/);
  const arg = rest.join(" ").trim();

  if (command === "/help") {
    appendMessage("system", "Commands: /help /new /models /model <name> /sessions /use <id> /clear");
    return;
  }

  if (command === "/new" || command === "/clear") {
    await createSession();
    appendMessage("system", `Started new session ${state.currentSessionId}`);
    return;
  }

  if (command === "/models") {
    await loadModels();
    appendMessage("system", state.models.map((model) => `${model.name}  ${model.parameterSize}  ${model.family}`).join("\n"));
    return;
  }

  if (command === "/model") {
    state.currentModel = arg;
    renderModels();
    appendMessage("system", `Model set to ${state.currentModel}`);
    return;
  }

  if (command === "/sessions") {
    await loadSessions();
    appendMessage("system", state.sessions.map((session) => `${session.id}  ${session.model ?? "unset"}  ${session.title}`).join("\n"));
    return;
  }

  if (command === "/use") {
    await openSession(arg);
    appendMessage("system", `Loaded session ${arg}`);
    return;
  }

  appendMessage("system", `Unknown command: ${command}`);
}

function appendMessage(role, content) {
  const fragment = templateEl.content.cloneNode(true);
  const roleEl = fragment.querySelector(".message-role");
  const contentEl = fragment.querySelector(".message-content");
  roleEl.textContent = role;
  contentEl.textContent = content;
  transcriptEl.appendChild(fragment);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
  return transcriptEl.lastElementChild.querySelector(".message-content");
}

function renderModels() {
  modelSelectEl.innerHTML = "";
  for (const model of state.models) {
    const option = document.createElement("option");
    option.value = model.name;
    option.textContent = model.name;
    option.selected = model.name === state.currentModel;
    modelSelectEl.appendChild(option);
  }
  renderModelMeta();
}

function renderModelMeta() {
  const model = state.models.find((entry) => entry.name === state.currentModel);
  modelMetaEl.textContent = model
    ? `${model.family} • ${model.parameterSize} • ${new Date(model.modifiedAt).toLocaleString()}`
    : "No model selected.";
}

function renderSessions() {
  sessionListEl.innerHTML = "";
  for (const session of state.sessions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `session-button${session.id === state.currentSessionId ? " active" : ""}`;
    button.innerHTML = `${escapeHtml(session.title)}<span class="session-meta">${escapeHtml(session.model ?? "unset")} • ${session.messageCount} msgs</span>`;
    button.addEventListener("click", async () => {
      await openSession(session.id);
    });
    sessionListEl.appendChild(button);
  }
}

function setStatus(value) {
  statusChipEl.textContent = value;
}

function renderTraceTurns() {
  traceListEl.innerHTML = "";
  if (!state.turns.length) {
    const empty = document.createElement("p");
    empty.className = "trace-empty";
    empty.textContent = "No trace data yet.";
    traceListEl.appendChild(empty);
    return;
  }

  const turns = [...state.turns].slice().reverse();
  for (const turn of turns) {
    const card = document.createElement("article");
    card.className = "trace-card";

    const header = document.createElement("div");
    header.className = "trace-header";

    const titleWrap = document.createElement("div");
    const title = document.createElement("h3");
    title.className = "trace-title";
    title.textContent = turn.prompt || "Untitled turn";
    const subtitle = document.createElement("p");
    subtitle.className = "trace-subtitle";
    subtitle.textContent = [turn.model, shortenPath(turn.cwd), formatTraceTime(turn.createdAt)]
      .filter(Boolean)
      .join(" • ");
    titleWrap.append(title, subtitle);

    const status = document.createElement("span");
    status.className = `trace-status ${turn.status || "running"}`;
    status.textContent = turn.status || "running";
    header.append(titleWrap, status);

    const metrics = document.createElement("p");
    metrics.className = "trace-metrics";
    metrics.textContent = formatMetrics(turn.metrics, turn.expandedFiles);

    const events = document.createElement("ol");
    events.className = "trace-events";
    for (const event of turn.events ?? []) {
      const item = document.createElement("li");
      item.className = "trace-event";

      const head = document.createElement("div");
      head.className = "trace-event-head";

      const type = document.createElement("span");
      type.className = "trace-event-type";
      type.textContent = event.type;

      const at = document.createElement("time");
      at.className = "trace-event-time";
      at.textContent = formatTraceTime(event.at);

      const data = document.createElement("p");
      data.className = "trace-event-data";
      data.textContent = formatEventData(event.data);

      head.append(type, at);
      item.append(head, data);
      events.appendChild(item);
    }

    card.append(header, metrics, events);
    traceListEl.appendChild(card);
  }
}

function upsertTraceTurn(turn) {
  const nextTurn = normalizeTraceTurn(turn);
  const index = state.turns.findIndex((entry) => entry.id === nextTurn.id);
  if (index >= 0) {
    state.turns[index] = nextTurn;
  } else {
    state.turns.push(nextTurn);
  }
  renderTraceTurns();
}

function addTraceEvent(turnId, event) {
  const turn = state.turns.find((entry) => entry.id === turnId);
  if (!turn) {
    return;
  }
  turn.events = [...(turn.events ?? []), event];
  renderTraceTurns();
}

function markTraceTurnCompleted(turnId) {
  const turn = state.turns.find((entry) => entry.id === turnId);
  if (!turn) {
    return;
  }
  turn.status = "completed";
  renderTraceTurns();
}

function normalizeTraceTurn(turn) {
  return {
    ...turn,
    expandedFiles: turn.expandedFiles ?? [],
    metrics: turn.metrics ?? {},
    events: turn.events ?? []
  };
}

async function fetchJson(endpoint, init) {
  const response = await fetch(endpoint, init);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function formatTraceTime(value) {
  if (!value) {
    return "";
  }
  return new Date(value).toLocaleTimeString();
}

function formatMetrics(metrics = {}, files = []) {
  const parts = [];
  if (metrics.durationMs) parts.push(`${(metrics.durationMs / 1000).toFixed(1)}s`);
  if (metrics.totalTokens) parts.push(`${metrics.totalTokens} tokens`);
  if (files.length) parts.push(`${files.length} file${files.length === 1 ? "" : "s"} inlined`);
  return parts.join(" • ") || "Metrics pending";
}

function formatEventData(data) {
  if (!data || typeof data !== "object") {
    return "";
  }
  return Object.entries(data)
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([key, value]) => {
      if (Array.isArray(value)) {
        return `${key}: ${value.join(", ")}`;
      }
      return `${key}: ${value}`;
    })
    .join(" • ");
}

function shortenPath(value) {
  if (!value) {
    return "";
  }
  const parts = value.split("/");
  return parts.length <= 4 ? value : `.../${parts.slice(-3).join("/")}`;
}
