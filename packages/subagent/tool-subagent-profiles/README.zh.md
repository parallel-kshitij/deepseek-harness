# @deepseek-ai/dsh-tool-subagent-profiles

[English](README.md) | 中文

把运行期或部署期提供的命名委派清单实现为原生进程内 DeepSeek Harness 子代理工具。每个配置固定子代理 persona 和可选工具过滤器，同时保留 DSH 的子会话、深度、取消、沙箱、持久化和结果契约。

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

每一项注册 `subagent__<id>`（按 DeepSeek 的 64 字符工具名契约确定性规范化并加哈希）。调用在前台运行并返回子代理最终输出。`persona` 只覆盖该子代理的部署 persona；`toolFilter` 会从子代理提示和执行路径中移除不可用工具。

## 模型体验

### 命名委派工具

#### 模型看到什么

模型会为每个配置看到一个用途清晰的原生委派工具，以及单独配置的通用 `subagent` 工具。配置指令不会复制到父代理提示中，只进入所选子代理的系统提示。

#### Token 影响

每个配置增加一个紧凑工具 schema 和用途说明。子代理 persona token 只在委派的子代理中消耗。

#### KV Cache 影响

配置顺序、id 和描述不变时保持稳定。Persona 文本不影响父代理请求前缀。

## 已知限制与延期工作

- **配置在一次进程组合中固定**——每次运行的清单需要新的 SDK 运行时进程，或未来的作用域动态配置协议。
- **配置调用只支持前台**——后台和可继续委派由通用 `tool-subagent` 包拥有。
- **工具过滤器使用 DSH 全局工具名**——翻译其他工具词汇的提供方适配器必须在启动前规范化并验证名称。
