// Text-based tool-call parsing — the fallback for models that emit tool calls as
// JSON inside their message text instead of using the provider's tool-call API
// (llama3.2 and qwen2.5-coder both do it, and qwen mixes both in one response).
//
// Lives in its own module so the agent runner, the interactive CLI, and the eval
// harness all share one parser instead of each re-deriving it.

// Handles models like llama3.2 that output tool calls as JSON text content.
const TOOL_ALIASES = {
  // bash aliases
  run: 'bash', execute: 'bash', shell: 'bash', cmd: 'bash', command: 'bash', bash_cmd: 'bash',
  run_bash: 'bash', run_command: 'bash', run_shell: 'bash',
  // read aliases
  read: 'read_file', cat: 'read_file', open: 'read_file', open_file: 'read_file', file_read: 'read_file',
  // write aliases
  write: 'write_file', create: 'write_file', create_file: 'write_file', file_write: 'write_file',
  // str_replace aliases
  edit: 'str_replace', replace: 'str_replace', modify: 'str_replace', patch: 'str_replace',
  // glob aliases
  list: 'glob', find: 'glob', find_files: 'glob', list_files: 'glob', search_files: 'glob',
  // search aliases
  search: 'search_code', grep: 'search_code', find_in_files: 'search_code', grep_files: 'search_code',
};

// Tools that are really interpreters — map to bash and prepend interpreter name
const INTERPRETER_TOOLS = {
  python3: 'python3', python: 'python3', node: 'node', ruby: 'ruby',
  perl: 'perl', sh: 'sh', bash_run: 'bash',
};

function normalizeToolName(raw) {
  const lower = raw.toLowerCase().replace(/[\s-]/g, '_');
  if (TOOL_ALIASES[lower]) return TOOL_ALIASES[lower];
  // Fuzzy: if any known tool name is a substring match
  const known = ['bash', 'read_file', 'write_file', 'str_replace', 'glob', 'grep'];
  for (const t of known) if (lower.includes(t.replace('_', '')) || lower.includes(t)) return t;
  // Fuzzy against aliases keys
  for (const [alias, tool] of Object.entries(TOOL_ALIASES)) {
    if (lower.includes(alias)) return tool;
  }
  return raw; // return as-is if no match
}

// Canonical param names — keyed by tool so ambiguous shorthands (e.g. 's') resolve correctly
const PARAM_ALIASES_BY_TOOL = {
  read_file:  { p: 'path', f: 'path', fp: 'path', filepath: 'path', filename: 'path',
                file: 'path', file_path: 'path', s: 'path', src: 'path', source: 'path' },
  write_file: { p: 'path', f: 'path', fp: 'path', filepath: 'path', filename: 'path',
                file: 'path', file_path: 'path', contents: 'content', text: 'content', data: 'content' },
  str_replace: { p: 'path', f: 'path', filepath: 'path', file: 'path', file_path: 'path',
                 old: 'old_str', old_string: 'old_str', original: 'old_str', search: 'old_str', s: 'old_str',
                 new: 'new_str', new_string: 'new_str', replacement: 'new_str', replace: 'new_str', r: 'new_str' },
  bash:       { cmd: 'command', shell_command: 'command', bash_command: 'command' },
  glob:       { glob_pattern: 'pattern', file_pattern: 'pattern' },
  grep:       { regex: 'pattern', query: 'pattern', dir: 'path', directory: 'path' },
};
// Fallback aliases applied when no tool-specific entry matches
const PARAM_ALIASES_COMMON = {
  p: 'path', f: 'path', filepath: 'path', filename: 'path', file_path: 'path',
  glob_pattern: 'pattern', file_pattern: 'pattern',
  regex: 'pattern', query: 'pattern', dir: 'path', directory: 'path',
};

function normalizeArgs(args, toolName) {
  const toolTable = PARAM_ALIASES_BY_TOOL[toolName] ?? {};
  const cleaned = {};
  for (const [k, v] of Object.entries(args)) {
    const key = k.toLowerCase();
    const normKey = toolTable[key] ?? PARAM_ALIASES_COMMON[key] ?? k;
    if (typeof v === 'string') {
      // Fix single-element list-wrapped values: "['ls -la']" → "ls -la"
      const listMatch = v.match(/^\[['"]([^'"]+)['"]\]$/);
      if (listMatch) {
        cleaned[normKey] = listMatch[1];
      } else {
        // Try to parse as JSON array and join with space: ['python3', 'file.py'] → 'python3 file.py'
        try {
          const parsed = JSON.parse(v.replace(/'/g, '"'));
          if (Array.isArray(parsed) && parsed.every(x => typeof x === 'string')) {
            cleaned[normKey] = parsed.join(' ');
          } else {
            cleaned[normKey] = v;
          }
        } catch {
          cleaned[normKey] = v;
        }
      }
    } else if (Array.isArray(v) && v.every(x => typeof x === 'string')) {
      // Handle actual array values: join with space
      cleaned[normKey] = v.join(' ');
    } else {
      cleaned[normKey] = v;
    }
  }
  return cleaned;
}

// Escape literal control characters inside JSON string values so JSON.parse accepts them.
// Models like qwen2.5-coder write multi-line file content with literal \n/\t in JSON strings.
function sanitizeJsonControls(s) {
  let inStr = false, esc = false, out = '';
  for (const c of s) {
    if (esc)              { esc = false; out += c; continue; }
    if (c === '\\' && inStr) { esc = true; out += c; continue; }
    if (c === '"')        { inStr = !inStr; out += c; continue; }
    if (inStr) {
      if      (c === '\n') { out += '\\n'; continue; }
      else if (c === '\r') { out += '\\r'; continue; }
      else if (c === '\t') { out += '\\t'; continue; }
      else if (c === '\b') { out += '\\b'; continue; }
      else if (c === '\f') { out += '\\f'; continue; }
    }
    out += c;
  }
  return out;
}

function extractJsonObjects(text) {
  // Brace-counting extractor — handles any nesting depth, respects strings
  const results = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '{') { i++; continue; }
    let depth = 0, inStr = false, esc = false, j = i;
    while (j < text.length) {
      const c = text[j];
      if (esc)                          { esc = false; }
      else if (c === '\\' && inStr)     { esc = true; }
      else if (c === '"')               { inStr = !inStr; }
      else if (!inStr && c === '{')     { depth++; }
      else if (!inStr && c === '}')     { depth--; if (depth === 0) { results.push(text.slice(i, j + 1)); break; } }
      j++;
    }
    i = j + 1;
  }
  return results;
}

// Qwen-style XML tool calls:
//
//   <function=write_file>
//   <parameter=path>
//   greeting.txt
//   </parameter>
//   <parameter=content>
//   hello from claudette
//   </parameter>
//   </function>
//
// qwen3-coder:30b emits exactly this when it does not use the provider's
// tool-call API, and the JSON parser below saw plain prose — so a bake-off
// scored it 0 on `write-then-verify` for a tool call that was perfectly correct.
// A `</tool_call>` or `<tool_call>` wrapper around it is common and ignored.
const XML_CALL_RE = /<function\s*=\s*([a-zA-Z0-9_.-]+)\s*>([\s\S]*?)(?:<\/function>|$)/g;
const XML_PARAM_RE = /<parameter\s*=\s*([a-zA-Z0-9_.-]+)\s*>([\s\S]*?)(?:<\/parameter>|$)/g;

// One leading and one trailing newline are the tag's own formatting, not part of
// the value — but interior whitespace is load-bearing for `content` and
// `old_str`, so this is deliberately not a trim().
function stripTagNewlines(value) {
  return value.replace(/^[ \t]*\r?\n/, '').replace(/\r?\n[ \t]*$/, '');
}

function coerceScalar(value) {
  if (/^-?\d+$/.test(value)) return Number(value);
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

export function parseXmlToolCalls(text) {
  const calls = [];
  for (const [, rawName, body] of String(text ?? '').matchAll(XML_CALL_RE)) {
    const rawArgs = {};
    for (const [, key, rawValue] of body.matchAll(XML_PARAM_RE)) {
      rawArgs[key] = coerceScalar(stripTagNewlines(rawValue));
    }
    if (!Object.keys(rawArgs).length) continue; // a bare <function=x> is not a call
    const toolName = normalizeToolName(rawName);
    calls.push({ function: { name: toolName, arguments: normalizeArgs(rawArgs, toolName) } });
  }
  return calls;
}

function parseTextToolCalls(text) {
  // Strip markdown code fences
  const stripped = text.replace(/```(?:\w+)?\n?([\s\S]*?)```/g, '$1').trim();

  const calls = [];
  // Try the whole text, then each individual JSON object found
  const candidates = [stripped, ...extractJsonObjects(stripped)];

  for (const candidate of candidates) {
    try {
      const obj = JSON.parse(sanitizeJsonControls(candidate));
      const wrappedCalls = obj.tool_calls ?? obj.calls;
      if (Array.isArray(wrappedCalls)) {
        for (const wrapped of wrappedCalls) {
          const inner = wrapped.function ?? wrapped.tool ?? wrapped;
          if (typeof inner?.name !== 'string') continue;
          const toolName = normalizeToolName(inner.name);
          const rawArgs = inner.arguments ?? inner.parameters ?? inner.args ?? {};
          const args = typeof rawArgs === 'object' && rawArgs !== null
            ? normalizeArgs(rawArgs, toolName)
            : rawArgs;
          calls.push({ function: { name: toolName, arguments: args } });
        }
        continue;
      }

      // Must have a name field and arguments or parameters
      if (typeof obj.name !== 'string') continue;
      const rawArgs = obj.arguments ?? obj.parameters ?? obj.args ?? {};
      if (typeof rawArgs !== 'object') continue;

      // Check if this is an interpreter invocation (e.g. python3, node)
      const lowerName = obj.name.toLowerCase();
      const interp = INTERPRETER_TOOLS[lowerName];
      if (interp) {
        const fileArg = rawArgs.command ?? rawArgs.file ?? rawArgs.file_name ?? rawArgs.script ?? rawArgs.path ?? '';
        calls.push({ function: { name: 'bash', arguments: { command: `${interp} ${fileArg}`.trim() } } });
        continue;
      }

      const toolName = normalizeToolName(obj.name);
      const args = normalizeArgs(rawArgs, toolName);
      calls.push({ function: { name: toolName, arguments: args } });
    } catch { /* keep trying */ }
  }

  calls.push(...parseXmlToolCalls(stripped));

  // Deduplicate by stringified identity (whole-text parse can overlap with extracted objects)
  const seen = new Set();
  return calls.filter(c => {
    const key = JSON.stringify(c);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}


export { parseTextToolCalls, normalizeToolName, normalizeArgs, sanitizeJsonControls, extractJsonObjects };

