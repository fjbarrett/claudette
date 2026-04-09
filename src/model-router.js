const TOOL_CAPABLE_ORDER = [
  'gemma4',
  'qwen2.5-coder',
  'qwen2.5',
  'mistral',
  'llama3.1',
  'qwen3.5',
];

const CODE_FIRST_ORDER = [
  'deepseek-coder-v2',
  'deepseek-coder',
  'gemma4',
  'qwen2.5-coder',
  'qwen3.5',
];

const GENERAL_ORDER = [
  'gemma4',
  'qwen3.5',
  'qwen2.5-coder',
  'deepseek-coder-v2',
];

const TOOL_REQUIRED_RE = /\b(@[\w./-]+|read|open|inspect|search|grep|find|list files|repo|repository|codebase|diff|git|commit|run tests|test suite|edit existing|patch|modify|fix in|update file|look at the files|use (a )?tool)\b/i;
const CODE_GEN_RE = /\b(write|generate|create|implement|draft|scaffold|build)\b/i;
const CODE_OBJECT_RE = /\b(function|component|class|script|query|regex|sql|algorithm|snippet|endpoint|schema|test)\b/i;
const EXPLANATION_RE = /\b(explain|why|how does|what does|summari[sz]e|compare|review this idea)\b/i;
const DEBUG_RE = /\b(debug|fix|bug|failing|broken|error|stack trace|regression|issue)\b/i;

export function resolveAutoModel({ prompt, models, toolsAvailable }) {
  const available = Array.isArray(models) ? models.map(m => typeof m === 'string' ? m : m.name).filter(Boolean) : [];
  const task = classifyPrompt(prompt, { toolsAvailable });
  const order = pickOrder(task);
  const model = findFirstInstalled(order, available) ?? available[0] ?? null;

  return {
    model,
    task,
    reason: `${task.type}${task.requiresTools ? ' + tools' : ''}`,
  };
}

export function classifyPrompt(prompt, { toolsAvailable } = {}) {
  const text = String(prompt ?? '').trim();
  const lower = text.toLowerCase();
  const requiresTools = !!toolsAvailable && TOOL_REQUIRED_RE.test(lower);
  const isDebug = DEBUG_RE.test(lower);
  const isCodeGen = CODE_GEN_RE.test(lower) && CODE_OBJECT_RE.test(lower);
  const isExplanation = EXPLANATION_RE.test(lower);

  if (requiresTools) {
    return { type: isDebug ? 'repo_debug' : 'repo_task', requiresTools: true };
  }
  if (isCodeGen) {
    return { type: 'code_generation', requiresTools: false };
  }
  if (isDebug) {
    return { type: 'debug_reasoning', requiresTools: false };
  }
  if (isExplanation) {
    return { type: 'explanation', requiresTools: false };
  }
  return { type: 'general', requiresTools: false };
}

export function getDefaultSelection(models, { toolsAvailable } = {}) {
  const available = Array.isArray(models) ? models.map(m => typeof m === 'string' ? m : m.name).filter(Boolean) : [];
  const order = toolsAvailable ? TOOL_CAPABLE_ORDER : GENERAL_ORDER;
  return findFirstInstalled(order, available) ?? available[0] ?? null;
}

function pickOrder(task) {
  if (task.requiresTools) return TOOL_CAPABLE_ORDER;
  if (task.type === 'code_generation') return CODE_FIRST_ORDER;
  return GENERAL_ORDER;
}

function findFirstInstalled(order, available) {
  for (const pref of order) {
    const found = available.find(name => name.includes(pref));
    if (found) return found;
  }
  return null;
}
