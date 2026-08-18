# Agent Note: 基于 DeepSeek Harness 的 ParallelLoop 运行时对等

Status: implemented

Release certification: incomplete

[English](2026-08-18-parallelloop-runtime-parity.md) | 中文

## 问题

ParallelLoop 的 Agents SDK 目前为 Claude Agent SDK 与 Pi 提供生产级运行时适配器。它的提供方无关智能平面还持有不属于模型循环的能力：命令分派、Celery 编排、Redis 事件投递、工作区隔离、产物日志、记忆任务、git 同步、webhook、身份验证与控制平面集成。

DeepSeek Harness 已经实现了广泛的 agent 内核：持久会话、带作用域的提示词与工具组合、取消与 steering、模型路由、压缩、持久化、MCP、hooks、skills、审批、沙箱、subagent、后台任务、workflow、附件、LSP、网页工具、遥测、Web UI，以及 Python/TypeScript SDK。但它的进程外 SDK 协议只公开进程初始化、提示词入队和关闭。取消、steering、持久恢复、单会话释放、逐 agent persona 与工具限制、推理强度和根 agent 结构化输出等核心能力，当前无法通过该边界控制。

若把对等理解为“把所有 ParallelLoop 服务复制进 DeepSeek Harness”，就会重复基础设施并产生两个冲突的所有者。若把对等理解为“模型能回答提示词”，又会静默丢失生产行为。此集成需要系统级对等定义，以及一份把内核工作、适配器工作和保留的平台工作分开的可执行清单。

## 当前系统能力清单

下列清单是对等契约。“Native”表示官方 harness 已持有该行为；“Bridge”表示需要由窄 SDK 协议或 Agents SDK 适配器公开；“Platform”表示现有提供方无关 Agents SDK 实现继续作为权威；“Gap”表示 DeepSeek 提供方宣称支持前必须完成实现与证明。

### 运行时生命周期与流

| 能力 | 必须保留的 Claude/Pi 行为 | DeepSeek 机制 | 所有者 | 初始状态 | 必需证明 |
|---|---|---|---|---|---|
| 提供方选择 | 默认关闭、显式启用 | 新 `deepseek` 注册 | Bridge | Gap | 选择与默认关闭测试 |
| 进程启动 | 隔离执行或受管 warm holder | SDK JSON-RPC 子进程与打包运行时 | Bridge | Partial | 启动、握手、stderr、teardown 测试 |
| Warm 复用 | 复用健康进程且不泄漏状态 | 一个 SDK 进程、独立 session id | Bridge | Gap | 顺序与并发会话测试 |
| 提示词入队 | 持久且有标识的用户消息 | `session/prompt` 与 inbox receipt | Native | Present | 协议与适配器测试 |
| 文本流 | 增量 assistant delta | `session.event` 文本事件 | Bridge | Present | `StreamDelta` 翻译测试 |
| 推理流 | thinking 不并入答案文本 | reasoning chunk 事件 | Bridge | Present | `ThinkingMessage` 测试 |
| 工具生命周期 | start、input、result、failure | 持久工具事件 | Bridge | Present | 顺序与 activity 测试 |
| 用量 | 输入、输出、缓存读写 token | 模型事件中的 `TokenUsage` | Bridge | Present | 累加与最终结果测试 |
| 成本 | 已知价格下的稳定总成本 | 用量加模型价格目录 | Bridge | Gap | 精确计算与未知价格测试 |
| 最终结果 | 流结束后恰好一个中立结果 | receipt 到 idle 的自有区间 | Bridge | Partial | SYSTEM-first/RESULT-last 测试 |
| 结束原因 | 完成、token 上限、中止、拒绝、错误 | `turn/end.reason` | Bridge | Present | 映射表测试 |
| 最大轮数 | 硬性中立上限 | pre-step/turn 策略或取消 | Bridge | Gap | 边界测试 |
| 取消 | 中止活跃工作并可清空队列 | `Agent.cancel()` | Bridge | SDK gap | 模型中、工具中、idle 竞态测试 |
| Steering | 下一 step 接收用户引导 | `Agent.steer()` | Bridge | SDK gap | running/idle 测试 |
| 上下文注入 | 不唤醒 idle 的 next-step 上下文 | `Agent.inject()` | Bridge | SDK gap | running/parked 测试 |
| 单会话关闭 | 不关闭整个运行时 | `AgentHandle.dispose()` | Bridge | SDK gap | 幂等与跨会话隔离测试 |
| 运行时关闭 | 排空会话、插件、持久化和子进程 | `shutdown` 与 reap 阶梯 | Native | Present | 停稳测试 |
| Watchdog | 限制卡住的运行时 | `BaseRuntimeProvider` | Platform | Present | 基类组合测试 |
| Circuit breaker | 重复失败时停止分派 | `BaseRuntimeProvider` | Platform | Present | 基类与选择测试 |
| 中立错误 | 稳定的提供方无关错误 | 基类归一化 | Platform | Present | 无提供方类型泄漏测试 |

### 对话、模型与输出契约

| 能力 | 必须保留的 Claude/Pi 行为 | DeepSeek 机制 | 所有者 | 初始状态 | 必需证明 |
|---|---|---|---|---|---|
| 工作区 cwd | 每个会话与工具使用绝对工作区 | session header `cwd` | Native | Present | 路径往返测试 |
| 系统提示词 | 逐 run 与 append 语义 | agent-scoped system prompt/persona | Bridge | SDK gap | 完整与追加快照 |
| 模型选择 | 显式 provider/model | agent options 与 `agent/request` | Native | Present | request header 断言 |
| 推理强度 | 每次运行选择支持档位 | `ReasoningEffortId` | Bridge | SDK gap | 支持/拒绝测试 |
| 输出 token 上限 | 显式输出预算 | `AgentOptions.maxTokens` | Native | Present | 现有 SDK 测试 |
| 成本预算 | 达到预算前停止 | 用量/成本观察器与取消 | Bridge | Gap | 分派前与运行中测试 |
| 结构化输出 | 符合 JSON Schema 的权威值 | scoped `structured_output` 工具 | Bridge | Root SDK gap | 合法、重试、非法、Code Mode 测试 |
| 图片与附件 | content block 无损传递 | DSH 内容块与附件 store | Bridge | Present | 图片/文件往返 |
| 压缩 | 有界上下文与可重建持久状态 | compaction 插件与 checkpoint | Native | Present | 快照与恢复测试 |
| 进程内恢复 | 继续 warm session | 服务端 session map | Native | Present | 多轮历史测试 |
| 重启后恢复 | 按稳定 id 加载持久会话 | `ctx.agents.resume()` | Bridge | SDK gap | 冷重启连续性测试 |
| Transcript mirror | 保留记忆与 eval 输入 | 持久事件日志翻译 | Bridge | Gap | 完整消息与顺序测试 |
| 模型切换 | 在已记录的 step 边界换路由 | model selection/`agent/request` | Bridge | SDK gap | header 变化测试 |

### 工具、扩展与委派工作

| 能力 | 必须保留的 Claude/Pi 行为 | DeepSeek 机制 | 所有者 | 初始状态 | 必需证明 |
|---|---|---|---|---|---|
| 内置文件/命令工具 | 读写搜索执行与持久 shell | DSH 工具插件与 Code Mode | Native | Present | profile 组合快照 |
| 允许/禁止工具 | 诚实的逐运行过滤 | `tools.restrict()` | Bridge | SDK gap | 未知工具明确失败、allow/deny 测试 |
| 自定义工具 | 中立工具调用 | Cordis tools service | Native/Bridge | Partial | 注册策略与组合测试 |
| MCP stdio | 通过子进程的外部工具 | MCP stdio transport | Native | Present | 真实进程组合测试 |
| MCP HTTP | Streamable HTTP、重连 | MCP HTTP transport | Native | Present | auth、重连、schema 测试 |
| Hook 生命周期 | 工具前后、prompt、stop、通知 | hooks bridge 与 Cordis events | Native/Bridge | Partial | 事件映射与失败策略测试 |
| 用户审批 | ask/allow/deny 与持久结果 | approval/sandbox policy | Native | Present | 审批组合测试 |
| 文件系统沙箱 | 可执行工具的内核/平台限制 | bwrap、Landlock、Seatbelt、ACL | Native/Platform | Present | 不宽于外层策略的安全测试 |
| 子进程环境 | 去密钥白名单环境 | Agents SDK env seam | Platform/Bridge | Gap | 安全 A6 与泄漏 canary |
| Skills | 发现、校验、选择、加载 | DSH skills 与 PL pipeline | Native/Platform | Present | discovery/selection 组合测试 |
| Web search/fetch | 搜索与抓取 | DSH web tools | Native | Present | keyless mock 测试 |
| LSP | 代码智能工具/上下文 | DSH LSP 插件 | Native | Present | profile 组合测试 |
| Subagent | spawn/fork/continue、深度、工具、persona、schema | 多种 DSH provider | Native | Present | 父子生命周期与结构化输出测试 |
| 后台任务 | 启动、轮询、收集 | jobs 与 continuation tools | Native | Present | 所有权与取消测试 |
| Workflow | 多 agent 图、Ralph、goal/plan/todo | workflow/goal 插件 | Native/Platform | Present | DSH 现有测试与 PL 路由 |
| Schedule | 持久延迟/周期工作 | schedule 插件 | Native/Platform | Present | DSH 测试与 Celery 所有权文档 |
| 自扩展 | 在策略下加载/卸载组合 | Cordis loader | Native | Present | HMR/invariant 测试 |

### ParallelLoop 生产平面

| 能力 | 权威实现 | DeepSeek 集成规则 | 所有者 | 初始状态 | 必需证明 |
|---|---|---|---|---|---|
| 命令注册表 | YAML Agents SDK dispatch | runtime selection 外无分支 | Platform | Present | 现有测试 |
| Celery 队列 | 九个生产队列 | 现有 task 调用适配器 | Platform | Present | 现有 task 测试 |
| Chat 编排 | 通用 chat 与 conversation id | 转发 id 和冻结消息 | Platform/Bridge | Partial | 集成测试 |
| Redis 流 | text/thinking/activity channel | 发布翻译后的冻结消息 | Platform/Bridge | Partial | 顺序与终态测试 |
| 记忆 | memory task、transcript mirror、MCP | 复用中立实现，DSH log 为输入 | Platform/Bridge | Gap | warm/cold 测试 |
| 产物检测 | LD_PRELOAD journal 与 `FilesWritten` | 保留 env，发一个冻结事件 | Platform/Bridge | Gap | 写/改名/删除/子进程测试 |
| 产物注册 | 现有 artifact service | 原样消费 `FilesWritten` | Platform | Present | 现有测试加 DSH 事件 |
| Git 同步 | ChangeLog 与周期同步 | DSH 不持有 git | Platform | Present | 解耦测试 |
| Webhook outbox | HMAC、at-least-once | DSH 不直连 Playbook | Platform | Present | 现有测试 |
| 身份与组织隔离 | 请求/工作区边界 | 仅传解析路径和白名单 env | Platform/Bridge | Gap | 跨组织负向测试 |
| 控制平面 seam | 集中 Playbook client | provider 无 inline HTTP | Platform | Present | 安全 A7 与测试 |
| 可观测性 | Langfuse/Sentry/metrics | 加 provider/model/run 属性，可接 OTEL | Platform/Bridge | Gap | trace 关联测试 |
| Eval 记录 | 中立 runtime eval | 基类记录 DSH 结果 | Platform | Present | 基类组合测试 |
| Egress 策略 | 部署网络与代理策略 | DSH 只能收窄外层策略 | Platform/Bridge | Gap | proxy/deny 测试 |

## 决策

### 1. 保留一个智能平面

ParallelLoop 继续持有命令分派、队列、身份、组织边界、Redis、记忆调度、产物注册、git、webhook、可观测性和控制平面调用。DeepSeek 作为现有 `AgentRuntime` seam 后的第三个 provider。这样每项业务能力只有一个实现，同一命令可在 Claude、Pi 或 DeepSeek 上运行而不改变编排。

### 2. 在原生 capability seam 上扩展 SDK

增加有类型、可加性的 JSON-RPC 方法，而不是 ParallelLoop 专用 loop fork：

- `session/open` 创建或恢复会话，并设置 scoped 路由、persona/system prompt、工具限制和可选结构化输出 schema；
- `session/prompt` 保持仅入队与持久 `messageId` 语义；
- `session/steer` 与 `session/inject` 写入带标识的 next-step 输入；
- `session/cancel` 调用核心队列感知取消；
- `session/close` 将单个服务端 handle 停稳释放；
- `session.result`（通知或查询）报告根结构化输出，且不虚构 prompt 级因果所有权。

服务端继续流式发送完整持久会话词汇。Python 与 TypeScript 客户端公开同样的方法。协议增加必须保留 one-send-one-turn 与 owned-run 决策：prompt receipt 不是单个 assistant 答案的 Promise；高层 `run()` 仍拥有 receipt 到 idle 区间。

### 3. 为 Agents SDK 增加一个 DeepSeek provider

Provider 继承 `BaseRuntimeProvider`，复用 watchdog、circuit breaker、中立错误、eval、warm holder、interrupt 和 steering 契约。它只持有：

- 子进程启动和白名单环境；
- 有类型 JSON-RPC session 控制；
- 为 MCP、hooks、skills、tools、permissions、sandbox 生成 Cordis profile/config；
- 把 DSH 持久/实时通知翻译成冻结 `RuntimeMessageType`；
- 用量/成本、最终 `RuntimeResult`、transcript mirror 与产物 journal 观察；
- 在模型 I/O 前拒绝不支持组合的 capability 校验。

除 `app/runtime/providers/deepseek/` 外不导入 DeepSeek Python SDK。选择和静态能力表可命名 provider，但只依赖中立 runtime 词汇。

### 4. 发布受约束的 ParallelLoop profile

Profile 只加载 bundled runtime closure 内经过审计的官方 package。逐运行值是数据，不是生成的可执行代码。密钥只能经 Agents SDK 白名单子进程环境或 MCP credential proxy 进入。内层 DSH sandbox 可收窄已解析工作区策略，绝不能放宽外层 Landlock。可选网络工具默认关闭。

### 5. 认证主张，而非推断

只有完成对应证明后，能力才可从 Gap/Partial 变为 Present。最终报告必须包括：

1. DSH 变更文件 100% per-file coverage；
2. TypeScript/Python 服务端与客户端协议测试；
3. 使用真实 Cordis loader 与 fake model transport 的 keyless 组合测试；
4. 每个冻结消息与选项映射的 Agents SDK 单元测试；
5. warm、cold-resume、interrupt、steering、structured output、MCP、artifact journal、memory 集成测试；
6. lint、typecheck、生成文档、翻译配对与安全 gate；
7. 最终清单中所有已宣称能力均不再是 Gap/Partial。

## 实现结果（2026-08-18，重新开启发布认证）

该设计已在 DeepSeek Harness 与 ParallelLoop Agents SDK 中实现，但尚未通过“完整对等”的发布认证。原结论采用了较窄的定义：能力诚实的路由，加上保留提供方无关的生产平面。现在的发布标准改为 Claude Agent SDK 与 Pi 行为能力的并集，并且必须通过生产运行时路径执行。Agents SDK 中 `app/runtime/providers/deepseek/parity_contract.yaml` 是机器可读的事实来源；只要任何必需能力或 Linux／服务／staging／eval gate 仍开放，其状态就必须保持 `incomplete`。

### DeepSeek Harness 增量

- 类型化 JSON-RPC 边界现支持 `session/open`、持久恢复、`session/steer`、`session/inject`、`session/cancel`、`session/output` 与 `session/close`。初始化和会话打开可携带路由、输出上限、推理强度、精确系统提示、工具限制与可选输出 schema。
- TypeScript 和 Python 客户端公开同样的控制，并投影结束原因与权威结构化输出。
- 可复用的结构化运行时能挂载到其他组合；内置 Python 运行时是完整编码 profile，包含沙箱 shell／文件、指令、skill、持久化／检查点、附件、搜索、goal／job／todo、token 计量、压缩、裁剪和进程内 subagent。
- MCP 新增有界、可取消、只允许回环地址的宿主传输。宿主在不透明运行令牌下提供一份无密钥清单；注册与释放是原子的，工具名复用现有确定性规范化契约。
- 宿主网页搜索使用独立的不透明令牌 `WebSearchProvider`。命名 agent 定义成为带深度和工具过滤器的原生固定 persona subagent 工具。读取门桥和 Claude Code 命令 hook 适配器运行在类型化工具执行前后拦截点。
- 单可执行文件资产闭包现在包含原生插件所需的 `.dylib`、`.so` 与 `.dll` 依赖（例如 `sharp`），修复了真实可执行文件 smoke 发现的源码与打包附件差异。

### Agents SDK 提供方事实

| 已认证能力 | 实现 |
|---|---|
| 流式与最终结果 | 持久 DSH 事件转换为冻结消息类型；带标识的提示区间在目标会话下一次 idle 时结束。 |
| 系统提示、路由、输出上限、effort、thinking | 通过类型化 initialize/open 控制发送；Claude 形状的 thinking 设置映射到经审计 effort id。 |
| 内置工具与 allowlist | 中立名称映射到精确 DSH 名称；未知工具在 spawn 前失败；限制以会话为作用域。 |
| 结构化输出 | JSON Schema 在发布前安装，并在轮次后查询根 agent 权威值。 |
| 冷恢复 | 稳定 id 在组织绑定的根目录中重新打开 JSONL 持久会话。 |
| MCP 与记忆工具 | 宿主对象、凭据、拒绝策略和调用留在 Python；DSH 只接收不透明令牌与固定清单。 |
| 网页搜索 | 独立不透明能力连接现有宿主搜索服务；凭据和租户策略保留在宿主。 |
| 命名 agent | Claude 形状定义成为原生进程内配置工具，并校验 persona 与翻译后的工具过滤器。 |
| Hook | 项目命令 hook 经 DSH Claude Code 桥运行；聊天先读后写检查复用未修改的宿主读取门。 |
| Skill | 选择的 `.claude/skills/<name>/SKILL.md` 与可选命令包装器先经路径校验，再折叠进作用域提示；原生发现接收显式 skill 目录。 |
| 权限模式与沙箱 | 内层 DSH 沙箱可收窄现有外层 Landlock 授权，但不能扩大。 |
| Steering、中断、最大轮数、watchdog、breaker、eval | 类型化 steering／cancel 控制与现有提供方无关基类机制组合。 |
| 用量、成本、记忆、文件 | 用量／缓存桶和配置费率投影到冻结结果；完整消息使用中立 transcript writer；DSH 写／编辑事件发出 `FilesWritten`，产物 journal 仍是权威。 |

提供方只声明 `streaming`、`system_prompts`、`tool_use`、`allowed_tools`、`env`、`effort`、`thinking`、`output_format`、`session_resume`、`mcp_servers`、`memory_tools`、`web_search`、`agents`、`skills_pipeline_deepseek`、`permission_modes` 与 `steer`。工作区项目 hook 与读取门是始终启用的组合能力，而不是通用逐运行 `hooks` 选择器能力。静态选择表被锁定为完全相同的集合。

### 尚未关闭的完整对等缺口

| 能力 | 最终处理 |
|---|---|
| 交互式 ask-user 轮次 | 仅 Claude。无人值守 JSON-RPC 提供方没有中立问答会合点，交互选择保持关闭。 |
| 任意逐运行 Python hook 回调 | 不声明。支持项目命令 hook 与聊天读取门；Python callable 绝不会跨进程边界。 |
| 完整 Claude `setting_sources` 分层 | 不声明。支持显式项目 skill、工作区指令和项目 hook 设置，但不宣称 Claude 的 user／local 优先规则。 |
| 原始 `extra_args` | 与提供方绑定且不适用，不声明；DSH 使用类型化选项与审计配置。 |
| `fallback_model` 与 `max_budget_usd` 取消 | 不声明；共享调用点选项会被记录为忽略，因此选择器不会把它们视为已支持语义。 |
| Warm 进程复用 | 不声明。已实现冷进程与持久语义恢复；未来 holder 必须先补充隔离和并发会话证明才能改变声明。 |

关闭能力 gate 可以防止静默降级，但在更严格的发布标准下，它们仍是完整对等缺口。交互式问题、任意逐运行 hook、完整设置分层、fallback／预算控制和 warm 复用必须实现并通过认证；否则必须由产品契约明确移除，发布才能称为完整。

### 保留生产平面所有权

命令注册表、Celery 路由、聊天编排、Redis 发布、记忆调度、产物注册、git 同步、webhook outbox、身份验证、组织隔离、控制平面调用、可观测性、eval 记录与出口策略仍由现有提供方无关实现持有。DeepSeek 适配器产生这些服务已消费的相同冻结输入，不新增第二写入者，也不直接调用 Playbook。

### 验证证据

以下项目是实现证据，不足以单独构成端到端发布认证。真实 macOS 打包 carrier 现在还通过了实时命令注册表与 provider factory，并经由 `BaseRuntimeProvider.execute_query` 完成结构化输出、文件写入／`FilesWritten` 与进程重启后的冷恢复。生产 Linux、真实平台服务、staging 模型／bridge 流量和对比 eval 仍是强制开放 gate。

- DeepSeek 宿主 TypeScript 构建、Cordis 配置校验、运行时闭包校验与 package invariant 校验通过。
- MCP 直接传输及宿主传输、宿主网页搜索、命名 subagent 配置、读取门 hook、协议／服务端／客户端和 Python SDK 定向测试通过。
- 重建的 215.5 MB macOS ARM64 单可执行文件通过全部无密钥打包运行时场景，包括默认 profile、自定义 profile、持久 shell／编辑器、高级 subagent／workflow 快照与直接 JSON-RPC 路径。
- Agents SDK DeepSeek 提供方、协议、选择、路由、环境、MCP 生命周期与冻结事件套件通过 190 项定向测试；经重建可执行文件和本地 SSE 端点的真实提供方运行按顺序发出 `SystemMessage`、`StreamDelta`、`UsageUpdate`、`AssistantMessage` 与 `ResultMessage`。

## 后果

- DeepSeek 成为一等运行时，而不是薄 chat-completions adapter。
- DSH scoped 插件模型可在可复用 SDK 进程内隔离每个会话的 persona、tools、policy 与 child agents。ParallelLoop provider 在未来 holder 证明并发会话隔离之前，有意为每次运行启动冷进程。
- append-only event log 为恢复、审计和压缩提供比 UI delta 重建更强的基础。
- 原生 MCP、hooks、sandbox、subagent、workflow、attachment、LSP 与 web package 减少大量 provider glue。
- 同一官方 SDK 协议可服务 ParallelLoop、Python、TypeScript 与 DSH-as-subagent。
- 平台能力保持单一所有者，避免 fork git、Redis、memory、webhook 或 auth 行为。
- 显式清单让不支持的行为在执行前失败，而不是静默降级。

## 考虑过的替代方案

**Fork DSH loop 并把 ParallelLoop 服务放进去。** 这会重复业务基础设施，违反插件扩展规则，并使 provider 改动可能绕过组织、git、webhook 与控制平面保证。

**只驱动 `session/prompt`，取消时杀掉子进程。** 这会失去 warm 会话隔离、steering、持久恢复、scoped tools 和结构化输出，并把普通取消变成全运行时故障。

**为每项语义操作生成专用 `cordis.yml`。** 组合应选择已审计插件；实时 session 控制属于有类型 service。把取消、steering 或 secret 编进 YAML 会削弱所有权与校验。

**把 DSH 包内已有功能直接宣称为对等。** SDK 边界不可达的能力对 ParallelLoop 不可用。package 的存在只证明机制，不证明集成。

## 测试

- Agents SDK 对等契约目前记录 70 项能力；只要任何必需条目或发布 gate 未关闭，发布状态就有意保持 `incomplete`。
- DeepSeek 默认关闭、可显式选择，且能力声明诚实。
- 打包 carrier 已具备 selection、dispatch、streaming、usage、structured output、文件写入、清理与冷恢复的命令级证明；取消、steering、injection 和跨会话隔离仍需 carrier 级认证。
- System prompt、tool restriction、reasoning effort、MCP、skills、hooks、sandbox、attachments、subagents 与 compaction 保留源码级证据，但在契约要求的各层通过前不会升级为发布认证。
- 所有冻结 runtime message 的字符串值与顺序契约保持不变。
- Memory、artifact journal、Redis、Celery、webhook、auth、org isolation 及相关 provider-neutral 服务仍需要真实 DeepSeek 平台服务运行；仅有 provider neutrality 不再计作路径证明。
- 提供方无关的 memory mirror 会在任何宿主 transcript 写入前拒绝路径形态的 provider 或 session 标识。
- Python 与 TypeScript SDK 行为对齐，英文/中文公开文档同步。
- DSH package invariant、完整覆盖率阈值、snapshot、生成文档、翻译配对、lint 与 typecheck 通过。
- Agents SDK 定向测试、Ruff lint／format 与 opt-in 真实 carrier 套件通过。更广仓库中依赖部署的失败以及不可用的 Pyright 二进制只能作为证据，不能算绿色发布 gate。

## 风险

Runtime closure 很大，镜像体积与冷启动可能明显高于 Pi。Warm holder 可降延迟，但增加生命周期与隔离责任。内层 DSH sandbox 与现有外层 Landlock 叠加时，若策略不是单调的或诊断不指出两层，失败会很难理解。持久 session id 属于安全敏感数据，必须绑定同一组织、项目、会话与 provider 路由。SDK 协议仍是 prerelease，但新增控制方法仍需同时更新服务端、Python、TypeScript、runtime closure、文档与 snapshot。最后，DeepSeek 模型行为和工具限制可能不同于 Claude/Pi；协议对等不保证任务质量一致，因此 eval 比较仍是发布 gate。
