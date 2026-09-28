# Agent Note: SDK 协议上的子 agent 工具调用关联

Status: implemented

[English](2026-09-27-subagent-tool-call-links.md) | 中文

## 问题

SDK 服务器已经会流式发送每个子会话的 `session.event` 通知（以子会话的 `sessionId` 标记），并用 `subagent.started {parentSessionId, childSessionId}` 宣告每个子 agent。渲染委派的宿主仍然无法知道某个子 agent 属于父会话的哪一次工具调用。父会话的 `tool/call` 携带 `callId`；协议上没有任何消息把该 `callId` 与子会话 id 放在一起。当一条 assistant 消息并行启动多个委派时，宿主无法可靠地把每个子 agent 的实时记录挂到启动它的工具调用上，按时序或标签匹配只是猜测。

子 agent 的持久化 `subagent/descriptor` 不适合承载该值：它会被持久化，读取时精确校验版本，而调用 id 属于父级执行，不属于子 agent 的持久身份。

## 决策

该关联是一个只供观察的生命周期事实，以独立通知的形式跨越进程边界。

- `SubagentStartRequest.originCallId?: CallId` 标识请求一次性委派的模型工具调用。`dsh-tool-subagent` 在每条路径上都把它设为当前执行的 `exec.callId`；`tool-subagent-profiles` 通过共享的 `apply` 继承这一行为。该值不对模型可见，不持久化，提供方也不据此行动。
- `SubagentRuntime.start()` 把它传给一次性运行的观察者，后者把它作为 `originCallId` 复制到 `SubagentRunInfo` 与 `SubagentRunEndInfo` 上。可续接 Activation epoch 从不携带该值。
- SDK 服务器监听 `subagent/start`，对带有 `originCallId` 的 `local` 运行发送 `subagent.linked {parentSessionId, childSessionId, toolCallId}`。`subagent.finished` 对同样的运行重复 `toolCallId`。本地性规则与 `subagent.finished` 已使用的规则相同。
- `initialize` 返回 `capabilities: { subagentLinks: true }`，使宿主能够区分从不发送关联的服务器与某次未被关联的委派。
- TypeScript 与 Python 客户端在会话树订阅中按与其他谱系通知相同的父子规则包含 `subagent.linked`。TypeScript 客户端把缺失的能力报告为 `false`；对不发送能力的服务器，Python 的 `InitializeResponse.capabilities` 为 `None`。

`subagent/start` 在提供方发布子 agent 之后触发，因此 `subagent.linked` 位于 `subagent.started` 之后，并可能晚于子 agent 最早的若干 `session.event` 通知。为子 agent 事件做归属的宿主必须暂存这些事件，直到关联到达或子 agent 结束。

## 考虑过的替代方案

**把调用 id 加入 `subagent/descriptor`。** descriptor 是持久化的，该字段会成为会话日志的一部分，并为一个日志读取方都不需要的值引入 descriptor 版本变更。调用 id 也属于父级执行，而不是子 agent 的身份。

**把 `toolCallId` 加入 `subagent.started`。** 该通知来自 `session/created`，它只知道子会话头。把调用 id 传入会话创建会让会话存储承担传输层职责。

**让宿主根据顺序或标签推断关联。** 并行委派会交错，标签由模型选择且可能重复，而一次性后台作业会在子 agent 启动前返回其 `tool/result`，因此顺序与标签都无法标识调用。

**通过 `initialize` 显式开启发送。** 客户端会忽略未知的通知方法与多余字段，因此显式开启只会增加一条协商路径，而不能保护任何消费方。`initialize` 结果中的能力标志已足以让宿主决定是否等待关联。

## 后果

宿主无需解析工具结果或猜测，就能把子 agent 的实时 `session.event` 流绑定到启动它的父级工具调用上，这正是逐委派详情面板所需要的。该变更新增一种通知、`subagent.finished` 上的一个可选字段，以及 `initialize` 结果中的一个字段；持久化格式不变。

可续接子 agent、非工具启动的运行以及远程运行不会被关联，需要为它们做归属的宿主仍只有 `subagent.started`。关联可能晚于子 agent 最早的事件，因此消费方需要一个小的关联前缓冲。通过 Code Mode 分派的嵌套调用关联到它们自己的 `callId`，而不是根模型调用。

## 测试

`packages/sdk/server/tests/server.spec.ts` 覆盖已关联、未关联与远程三种情况，`subagent.started`、`subagent.linked`、`subagent.finished` 的顺序，以及 `initialize` 能力。`packages/subagent/subagent/tests/service.spec.ts` 覆盖两个生命周期事件上的 `originCallId`。`packages/subagent/tool-subagent/tests/tool-subagent.spec.ts` 覆盖前台与一次性后台路径。`packages/sdk/client/tests/sdk-client.spec.ts` 与 `python/sdk/tests/test_client.py` 覆盖会话树过滤与能力投影。`examples/jsonrpc-agent/tests/snapshots/` 下的免密钥 `subagent-spawn-in-process` 快照固定了组装后的协议流。
