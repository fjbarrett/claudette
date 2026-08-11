"""Harbor adapter: run claudette as a Terminal-Bench / Harbor agent.

Follows the BaseInstalledAgent pattern of Harbor's bundled agents (see
harbor/agents/installed/pi.py): install claudette into the task container,
run it headless over --json-ipc, tee the JSONL event stream to the agent
log, and recover token usage from the final `done` event.

Usage:
    harbor run -d terminal-bench@2.1 \
        -a claudette_harbor:Claudette \
        -m openrouter/openai/gpt-5-nano

Pin the claudette revision with --agent-kwarg version=<git ref> (branch,
tag, or SHA of github.com/fjbarrett/claudette). Defaults to main.
"""

import json
import os
import shlex
from typing import override

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

# provider prefix (claudette model ids are provider/model, LiteLLM-style,
# matching Harbor's -m format verbatim) -> env vars claudette reads for it.
_PROVIDER_KEYS: dict[str, list[str]] = {
    "anthropic": ["ANTHROPIC_API_KEY"],
    "openai": ["OPENAI_API_KEY"],
    "deepseek": ["DEEPSEEK_API_KEY"],
    "groq": ["GROQ_API_KEY"],
    "hf": ["HF_TOKEN"],
    "openrouter": ["OPENROUTER_API_KEY"],
    "together": ["TOGETHER_API_KEY"],
    "fireworks": ["FIREWORKS_API_KEY"],
    "google": ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    "xai": ["XAI_API_KEY"],
    "mistral": ["MISTRAL_API_KEY"],
    "cohere": ["COHERE_API_KEY"],
    "perplexity": ["PERPLEXITY_API_KEY"],
}

_REPO = "fjbarrett/claudette"


class Claudette(BaseInstalledAgent):
    _OUTPUT_FILENAME = "claudette.jsonl"

    @staticmethod
    @override
    def name() -> str:
        return "claudette"

    @override
    def get_version_command(self) -> str | None:
        return '. "$HOME/.nvm/nvm.sh"; npm ls -g claudette --depth=0 2>/dev/null | tail -1'

    @override
    def parse_version(self, stdout: str) -> str:
        return stdout.strip().splitlines()[-1].strip()

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        await self.exec_as_root(
            environment,
            command="apt-get update && apt-get install -y curl ca-certificates",
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )
        ref = self._version or "main"
        tarball = f"https://github.com/{_REPO}/archive/{ref}.tar.gz"
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                "curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.2/install.sh | bash && "
                'export NVM_DIR="$HOME/.nvm" && '
                '\\. "$NVM_DIR/nvm.sh" && '
                "nvm install 22 && npm -v && "
                f"npm install -g {shlex.quote(tarball)} && "
                "command -v claudette"
            ),
        )

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        if not self.model_name or "/" not in self.model_name:
            raise ValueError(
                "Model name must be provider/model, e.g. openrouter/openai/gpt-5-nano"
            )

        provider = self.model_name.split("/", 1)[0]
        env: dict[str, str] = {}
        for key in _PROVIDER_KEYS.get(provider, []):
            val = os.environ.get(key)
            if val:
                env[key] = val

        # Local models. `ollama/<id>` (or a bare id) routes to Ollama, which runs
        # on the host, not in the task container — so point it at the host gateway
        # unless the caller already set a reachable URL. Without this, a local
        # model is simply unusable under Harbor, and every benchmark run costs
        # money it does not need to.
        if provider not in _PROVIDER_KEYS:
            base = os.environ.get("CLAUDETTE_HARBOR_OLLAMA_URL")
            if not base:
                host = os.environ.get("OLLAMA_BASE_URL", "http://127.0.0.1:11434")
                for local in ("127.0.0.1", "localhost", "0.0.0.0"):
                    host = host.replace(local, "host.docker.internal")
                base = host
            env["OLLAMA_BASE_URL"] = base

        # Pass through the agent tuning knobs the harness cares about, so a run is
        # reproducible from its environment rather than from whatever the image
        # happened to default to.
        for key in ("CLAUDETTE_NUM_CTX", "CLAUDETTE_THINK", "CLAUDETTE_MAX_ITERATIONS",
                    "CLAUDETTE_EFFORT", "CLAUDETTE_STALL_TIMEOUT", "CLAUDETTE_MAX_RETRIES"):
            val = os.environ.get(key)
            if val:
                env[key] = val

        # One line in, JSONL out: claudette's --json-ipc reads a prompt line,
        # runs the full agentic turn, and exits on stdin EOF. json.dumps keeps
        # multi-line instructions on a single physical line.
        prompt_line = json.dumps({"type": "prompt", "text": instruction})

        await self.exec_as_agent(
            environment,
            command=(
                '. "$HOME/.nvm/nvm.sh"; '
                f"printf '%s\\n' {shlex.quote(prompt_line)} | "
                f"claudette --json-ipc -y --model {shlex.quote(self.model_name)} "
                f'2>&1 | grep -v \'"type":"delta"\' | '
                f"stdbuf -oL tee /logs/agent/{self._OUTPUT_FILENAME}"
            ),
            env=env,
        )

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        output_file = self.logs_dir / self._OUTPUT_FILENAME
        if not output_file.exists():
            return

        prompt_tokens = 0
        completion_tokens = 0
        for line in output_file.read_text().splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if event.get("type") == "done":
                prompt_tokens += event.get("promptTokens", 0)
                completion_tokens += event.get("completionTokens", 0)

        if prompt_tokens or completion_tokens:
            context.n_input_tokens = prompt_tokens
            context.n_output_tokens = completion_tokens
