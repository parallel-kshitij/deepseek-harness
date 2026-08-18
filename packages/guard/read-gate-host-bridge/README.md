# @deepseek-ai/dsh-read-gate-host-bridge

English | [中文](README.zh.md)

Bridges DeepSeek Harness `write`, `edit`, `str_replace_editor`, and `bash` interception to a host-owned read-before-write policy. The host keeps Redis snapshots and policy logic; this plugin only translates DSH arguments into Claude-shaped `Write`/`Edit`/`Bash` check and refresh requests.

```yaml
- id: read-gate
  name: '@deepseek-ai/dsh-read-gate-host-bridge'
  config:
    baseUrl: !!js process.env.DSH_READGATE_BRIDGE_URL ?? ''
    cwd: !!js process.env.DSH_CWD ?? process.cwd()
```

`baseUrl` accepts only unauthenticated loopback HTTP. Before execution the plugin calls `POST /bridge/readgate/check`; `{ block: true, reason }` becomes a typed tool denial. After every gated result it calls `POST /bridge/readgate/refresh`. Both paths are bounded and fail open on transport, parsing, or policy-service faults, matching the advisory host policy. The sandbox remains the isolation boundary.

## Model Experience

### Denied mutation result

#### What the model sees

A denied `write`, `edit`, `str_replace_editor`, or `bash` mutation returns the host's exact reason as an ordinary tool error, so the model can read the file and retry. An allowed mutation adds no bridge-owned content.

#### Token effect

Zero tokens for allowed calls. A denial retains one ordinary bounded tool-error result.

#### KV Cache effect

No request-prefix change. A denial appends one normal tool result after the reusable prefix.

## Known Limitations and Deferred Work

- **This is the read gate, not a general callback bridge** — other typed DSH policies and Claude Code command hooks use their own interception plugins.
- **The policy is fail-open by design** — Redis/bridge availability cannot deadlock work; sandbox policy must enforce actual filesystem authority.
- **Bash target discovery remains host-owned** — the bridge delegates the command regex and snapshot semantics instead of duplicating them in TypeScript.
