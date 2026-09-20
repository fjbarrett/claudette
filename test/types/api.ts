// Compile-only consumer contract; npm run typecheck never executes this file.
import {
  run, stream, createAgent, runAgent, buildSystemPrompt, executeTool,
  trimToolOutputs, missingCredential, estimateCost,
} from 'claudette';
import type { Message, RunOptions, RunResult, RunStatus, AgentEvent } from 'claudette';

const messages: Message[] = [{ role: 'user', content: 'hello' }];
const signal = new AbortController().signal;
const options: RunOptions = {
  model: 'fixture', cwd: '/workspace', tools: true, allowShell: false,
  signal, messages, projectInstructions: false, expandAtFiles: false,
  approve: async (name, args) => name === 'read_file' && typeof args.path === 'string',
  onEvent(event) { const kind: AgentEvent['type'] = event.type; void kind; },
  onText(text) { text.toUpperCase(); },
};

async function consumerContract() {
  const result: RunResult = await run('hello', options);
  const status: RunStatus = result.status;
  const agent = createAgent(options);
  const reply: RunResult = await agent.send('next');
  for await (const event of stream('hello', options)) { const kind: string = event.type; void kind; }
  for await (const event of agent.stream('next')) { const kind: string = event.type; void kind; }
  const history: Message[] = agent.messages;
  agent.reset().send('reset');
  const lowerLevel = await runAgent({ model: 'fixture', messages });
  const content: string = lowerLevel.content;
  const prompt: string = await buildSystemPrompt({ cwd: '/workspace', system: null });
  const output: string = await executeTool('read_file', { path: 'file.txt' }, { cwd: '/workspace', workspace: '/workspace', signal });
  const trimmed: Message[] = trimToolOutputs(messages, { keep: 2, minChars: 10, maxTotalChars: 1024 });
  const cost: number | null = estimateCost('fixture', result.usage);
  const credential = missingCredential(['fixture']);
  if (credential) { const label: string = credential.label; void label; }
  void [status, reply, history, content, prompt, output, trimmed, cost];
}
void consumerContract;

// Intentional invalid usage must remain a compiler error.
// @ts-expect-error prompts must be strings
run(123);
// @ts-expect-error structured tools are explicitly enabled with a boolean
run('hello', { tools: ['bash'] });
// @ts-expect-error signals must be AbortSignals
run('hello', { signal: 'cancel' });
// @ts-expect-error trim budget must be numeric
trimToolOutputs(messages, { maxTotalChars: 'unlimited' });
