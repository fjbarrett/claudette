# Model files

`qwen3.6:35b-a3b-opencode` won the eval bake-off on this machine — 5/5 cases in
55s, roughly 6x faster than every other model that also scored 5/5.

It was pulled from the official library (the manifest records
`registry.ollama.ai/library/qwen3.6/35b-a3b-opencode`), but **that tag no longer
exists**: `ollama pull` now returns "file does not exist", while
`qwen3.6:27b-q4_K_M` and `qwen3.6:latest` still resolve. The registry has since
grown `35b-a3b-coding-{mxfp8,nvfp4,bf16}` tags, so the `-opencode` line looks
renamed rather than withdrawn.

The weights are not the special part. All three `35b-a3b` variants on this
machine share one blob (`sha256-f5ee307a2982…`), which `qwen3.6:35b-a3b-q4_K_M`
still ships. What the `-opencode` build adds is the parameter block, and that is
what these files preserve:

    num_ctx           65536   (vs unset -> Ollama's 4096 default)
    presence_penalty  0       (vs 1.5 — penalising repeated tokens wrecks JSON tool calls)
    temperature       0.6

To rebuild if the local copy is ever lost:

    ollama pull qwen3.6:35b-a3b-q4_K_M
    ollama create qwen3.6:35b-a3b-opencode -f qwen3.6_35b-a3b-opencode.Modelfile

The `FROM` line points at a local blob path; repoint it at the pulled model
first. Measured fallback: `qwen3.6:35b-a3b-q4_K_M` scores the same 5/5 at 78s,
so nothing is lost but a little speed.
