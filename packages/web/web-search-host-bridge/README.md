# @deepseek-ai/dsh-web-search-host-bridge

English | [中文](README.zh.md)

An opaque-token `WebSearchProvider` for platforms that keep search credentials, tenant budgets, and backend selection in a host process. The harness sends only a per-run capability token to a loopback `POST /bridge/web/search` endpoint and maps the returned structured hits into `ctx.web`.

This is an implementation package. It registers into `ctx.web`; [`@deepseek-ai/dsh-tool-web`](../tool-web/README.md) owns the model-facing `web_search` tool.

## Config

| Key | Default | Meaning |
|---|---|---|
| `baseUrl` | empty | Unauthenticated loopback HTTP origin. Only `127.0.0.1`, `localhost`, and `[::1]` are accepted. |
| `runToken` | empty | Opaque per-run host capability. Empty together with `baseUrl` disables registration. |
| `requestTimeoutMs` | `30000` | Bound for one host search request. |
| `maxResponseBytes` | `4194304` | Maximum accepted JSON response bytes. |

```yaml
- id: web-search-host
  name: '@deepseek-ai/dsh-web-search-host-bridge'
  config:
    baseUrl: !!js process.env.DSH_WEB_BRIDGE_URL ?? ''
    runToken: !!js process.env.DSH_WEB_RUN_TOKEN ?? ''
```

The host contract accepts `{ run_token, query, max_results }` and returns `{ ok, result, results: [{ title, url, snippet }], error }`. HTTP, malformed JSON, oversized responses, host denials, and cancellation become typed `WebError`s. The token is never sent to a non-loopback URL.

## Model Experience

### Hosted search results

#### What the model sees

Through `dsh-tool-web`, the model sees `web_search` with the provider's bounded answer text and citeable URLs, titles, and snippets. Credentials and provider-private response fields never enter harness configuration or context.

#### Token effect

The stable tool schema is paid on requests that expose `web_search`; each call retains only the normalized, host-bounded answer and hit fields.

#### KV Cache effect

No direct invalidation; the stable `web_search` consumer owns the request-prefix schema.

## Known Limitations and Deferred Work

- **The host endpoint is a platform contract, not MCP** — deployments must provide the three-field request and normalized response envelope above.
- **Search only** — safe URL fetching remains a separate `WebFetchProvider` concern.
- **Loopback is mandatory** — remote host bridges require an authenticated transport design rather than weakening the opaque-token boundary.
