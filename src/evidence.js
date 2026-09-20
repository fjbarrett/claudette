// Shared by CLI/library/eval prompts and by the actual Bash result path.
export const EVIDENCE_GUIDANCE = [
  '- For a review or assessment, report findings from code you actually inspected, with file paths and supporting symbols or line ranges. State the scope read; do not claim a whole-project review after sampling excerpts. Separate demonstrated defects from optional improvements, and do not edit unless asked.',
  '- Read existing project configuration and representative tests before recommending tooling or stricter settings. Account for configured options, not just command-line flags. Do not guess that dependencies, tests, timeouts, or validation are missing.',
  '- pytest --co / --collect-only lists tests without executing them. Coverage from collection-only is not test-suite coverage; actual coverage remains unknown until tests run. Disable configured coverage during collection (for example --no-cov when pytest-cov is installed), and do not repeatedly collect tests just to reinterpret a coverage table.',
  '- Coverage table Stmts/Miss/Branch columns are executable statement/branch counts, not physical file lengths. Use actual source or wc -l for line counts. Low collection coverage says nothing about how well the tests exercise the project.',
  '- Preserve test, coverage, and type-check gates. Do not recommend lowering thresholds or disabling checks merely to make an incomplete or nonexecuting check pass.',
  '- A gate failing during collection does not show it will fail when tests execute. Keep finding headings consistent with their evidence; do not predict a passing/failing suite or a coverage percentage without running it. A normal configured coverage gate is not itself a defect.',
  '- Run configured checks directly and retain their exit status. A command ending in || true can hide failure; exit 0 from that wrapper does not prove the checker passed. Help, version, collection, and dry-run output are discovery, not successful verification. If checks were not run or were inconclusive, say so.',
].join('\n');

// Recognize simple command invocations without treating quoted command examples
// as executions. This is evidence labeling, not a shell parser or permission gate.
function commandParts(command) {
  const tokens = String(command ?? '').match(/&&|\|\||[|;\n]|(?:[^\s"'|;&]|"(?:\\.|[^"\\])*"|'[^']*')+|&/g) ?? [];
  const parts = [];
  let words = [];
  for (const token of tokens) {
    if (['&&', '||', '|', ';', '\n'].includes(token)) {
      parts.push({ words, after: token });
      words = [];
    } else {
      words.push(token.replace(/"((?:\\.|[^"\\])*)"|'([^']*)'/g, (_match, double, single) =>
        single ?? double.replace(/\\(["\\$`])/g, '$1')));
    }
  }
  parts.push({ words, after: null });
  return parts;
}

function invocation(words) {
  let args = [...words];
  let pytestAddopts = '';
  while (args.length && (/^[A-Za-z_]\w*=/.test(args[0]) || ['env', 'sudo', 'time'].includes(args[0]))) {
    const word = args.shift();
    if (word.startsWith('PYTEST_ADDOPTS=')) pytestAddopts = word.slice('PYTEST_ADDOPTS='.length);
  }
  if (args[0] === 'npx') args.shift();
  if (['pnpm', 'yarn', 'bun'].includes(args[0]) && CHECK_NAMES.has(args[1])) args.shift();
  if (['uv', 'poetry', 'pipenv'].includes(args[0]) && args[1] === 'run') args = args.slice(2);
  let name = args[0]?.split('/').at(-1);
  if (/^python(?:\d+(?:\.\d+)*)?$/.test(name) && args[1] === '-m') {
    args = args.slice(2);
    name = args[0];
  }
  return { name, args: args.slice(1), pytestAddopts };
}

const COLLECTION_FLAGS = new Set(['--co', '--collect-only', '--collectonly']);
const DISCOVERY_FLAGS = new Set([...COLLECTION_FLAGS, '--help', '-h', '--version', '-V', '--dry-run', '--listTests']);
const CHECK_NAMES = new Set([
  'pytest', 'unittest', 'mypy', 'ruff', 'flake8', 'pyright', 'py_compile', 'compileall',
  'pip-audit', 'pip_audit', 'tsc', 'eslint', 'jest', 'vitest', 'phpunit', 'rspec',
  'node', 'next', 'vite', 'go', 'cargo', 'make', 'mvn', 'gradle',
]);
const CHECK_SCRIPTS = new Set(['build', 'test', 'lint', 'typecheck', 'type-check', 'check']);

function isChecker({ name, args }) {
  return CHECK_NAMES.has(name)
    || (['npm', 'pnpm', 'yarn', 'bun'].includes(name) && CHECK_SCRIPTS.has(args[0] === 'run' ? args[1] : args[0]));
}

// Pytest adds these options to the real command. Recognize explicit collection
// settings while leaving option values (for example a -k expression) as data.
function checkArgs(call) {
  if (call.name !== 'pytest') return call.args;
  const flags = [];
  let iniAddopts = '';
  const values = new Set(['-k', '-m', '-c', '-p', '--rootdir', '--basetemp', '--confcutdir',
    '--ignore', '--ignore-glob', '--deselect', '--import-mode']);
  for (let i = 0; i < call.args.length; i++) {
    const arg = call.args[i];
    if (arg === '--') break;
    let override;
    if (arg === '-o' || arg === '--override-ini') override = call.args[++i];
    else if (arg.startsWith('--override-ini=')) override = arg.slice('--override-ini='.length);
    else if (values.has(arg)) { i++; continue; }
    else flags.push(arg);
    if (override?.startsWith('addopts=')) iniAddopts = override.slice('addopts='.length);
  }
  const added = `${iniAddopts} ${call.pytestAddopts ?? ''}`;
  return [...flags, ...commandParts(added).flatMap(part => part.words)];
}

export function isNonExecutingCheck(command) {
  return commandParts(command).some(({ words }) => {
    const call = invocation(words);
    return isChecker(call) && (checkArgs(call).some(arg => DISCOVERY_FLAGS.has(arg.split('=')[0]))
      || (call.name === 'make' && call.args.some(arg =>
        ['--just-print', '--recon', '--question'].includes(arg) || /^-[^-]*[nq]/.test(arg))));
  });
}

export function annotateBashEvidence(command, output) {
  const parts = commandParts(command);
  const calls = parts.map(({ words }) => invocation(words));
  const notes = [];
  if (calls.some(call => call.name === 'pytest' && checkArgs(call).some(arg => COLLECTION_FLAGS.has(arg.split('=')[0])))) {
    notes.push('This command includes pytest collection-only. That step lists tests and does not execute them. ' +
      'Any coverage printed by that step is not test-suite coverage; actual test coverage is unknown from collection alone. ' +
      'Coverage table Stmts/Miss/Branch values are statement counts or branch counts, not source file lengths. ' +
      'Do not lower a coverage gate or claim the tests are inadequate from this output.');
  }
  if (calls.some(isChecker) && parts.some((part, i) =>
    ['||', ';', '\n'].includes(part.after) && ['true', ':', 'echo', 'printf'].includes(calls[i + 1]?.name))) {
    notes.push('The checker exit status is masked by a shell fallback or later command. ' +
      'An overall exit 0 is not proof that the check passed; inspect its actual output or rerun without masking.');
  }
  return notes.length ? `[Claudette evidence]\n${notes.join('\n')}\n\n${output}` : output;
}
