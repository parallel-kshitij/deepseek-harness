# @deepseek-ai/dsh-tool-subagent-profiles

English | [中文](README.zh.md)

Materializes a run- or deployment-supplied roster of named delegates as native in-process DeepSeek Harness subagent tools. Each profile fixes a child persona and optional tool filter while retaining DSH's child session, depth, cancellation, sandbox, persistence, and result contracts.

```yaml
- id: subagent-profiles
  name: '@deepseek-ai/dsh-tool-subagent-profiles'
  config:
    provider: spawn
    maxDepth: 3
    profiles:
      - id: reviewer
        description: Review implementation correctness and simplicity.
        persona: You are a strict code reviewer.
        toolFilter:
          allow: [read, grep, glob]
```

Each entry registers `subagent__<id>` (deterministically normalized and hashed to DeepSeek's 64-character tool-name contract). Calls run in the foreground and return the child's final output. `persona` shadows only that child's deployment persona; `toolFilter` removes unavailable tools from the child prompt and execution path.

## Model Experience

### Named delegate tools

#### What the model sees

The model sees one clearly described native delegation tool per profile plus any separately configured general-purpose `subagent` tool. The profile instructions are not duplicated into the parent prompt; they enter only the selected child system prompt.

#### Token effect

Each profile adds one compact tool schema and purpose. Child persona tokens are paid only inside the delegated child.

#### KV Cache effect

Stable while profile order, ids, and descriptions are unchanged. Persona text does not affect the parent's request prefix.

## Known Limitations and Deferred Work

- **Profiles are fixed for one process composition** — per-run rosters require a fresh SDK runtime process or a future scoped dynamic-config protocol.
- **Profile calls are foreground-only** — the general `tool-subagent` package owns background and continuable delegation.
- **Tool filters name global DSH tools** — provider adapters translating another tool vocabulary must normalize and validate names before launch.
