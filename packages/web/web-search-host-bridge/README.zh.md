# @deepseek-ai/dsh-web-search-host-bridge

[English](README.md) | 中文

这是一个使用不透明令牌的 `WebSearchProvider`，适用于将搜索凭据、租户预算和后端选择保留在宿主进程中的平台。Harness 只把每次运行的能力令牌发送到回环地址的 `POST /bridge/web/search`，并把返回的结构化结果映射到 `ctx.web`。

这是实现包：它向 `ctx.web` 注册；模型可见的 `web_search` 工具由 [`@deepseek-ai/dsh-tool-web`](../tool-web/README.md) 拥有。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `baseUrl` | 空 | 无认证的回环 HTTP 源。只接受 `127.0.0.1`、`localhost` 和 `[::1]`。 |
| `runToken` | 空 | 每次运行的不透明宿主能力。它与 `baseUrl` 同时为空时禁用注册。 |
| `requestTimeoutMs` | `30000` | 一次宿主搜索请求的时限。 |
| `maxResponseBytes` | `4194304` | 接受的 JSON 响应最大字节数。 |

```yaml
- id: web-search-host
  name: '@deepseek-ai/dsh-web-search-host-bridge'
  config:
    baseUrl: !!js process.env.DSH_WEB_BRIDGE_URL ?? ''
    runToken: !!js process.env.DSH_WEB_RUN_TOKEN ?? ''
```

宿主契约接收 `{ run_token, query, max_results }`，返回 `{ ok, result, results: [{ title, url, snippet }], error }`。HTTP 错误、畸形 JSON、超大响应、宿主拒绝和取消都会成为带类型的 `WebError`。令牌绝不会发送到非回环 URL。

## 模型体验

### 宿主搜索结果

#### 模型看到什么

通过 `dsh-tool-web`，模型看到 `web_search` 以及受限的回答文本和可引用的 URL、标题与摘要。凭据和提供商私有响应字段不会进入 Harness 配置或上下文。

#### Token 影响

公开 `web_search` 的请求需要支付稳定工具 schema 的 token；每次调用只保留经规范化且由宿主限制的答案与结果字段。

#### KV Cache 影响

不会直接失效；稳定的 `web_search` 消费方拥有请求前缀中的 schema。

## 已知限制与延期工作

- **宿主端点是平台契约，不是 MCP**——部署必须提供上述三字段请求和规范化响应信封。
- **只支持搜索**——安全 URL 获取仍是独立的 `WebFetchProvider` 关注点。
- **必须使用回环地址**——远程宿主桥需要经过认证的传输设计，而不是削弱不透明令牌边界。
