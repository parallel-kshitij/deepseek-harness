# @deepseek-ai/dsh-read-gate-host-bridge

[English](README.md) | 中文

把 DeepSeek Harness 的 `write`、`edit`、`str_replace_editor` 和 `bash` 拦截桥接到宿主拥有的“先读后写”策略。宿主保留 Redis 快照和策略逻辑；本插件只把 DSH 参数转换为 Claude 形状的 `Write`/`Edit`/`Bash` 检查与刷新请求。

```yaml
- id: read-gate
  name: '@deepseek-ai/dsh-read-gate-host-bridge'
  config:
    baseUrl: !!js process.env.DSH_READGATE_BRIDGE_URL ?? ''
    cwd: !!js process.env.DSH_CWD ?? process.cwd()
```

`baseUrl` 只接受无认证的回环 HTTP。执行前调用 `POST /bridge/readgate/check`；`{ block: true, reason }` 会成为带类型的工具拒绝。每个受控结果之后调用 `POST /bridge/readgate/refresh`。两条路径都有界，并在传输、解析或策略服务故障时放行，与宿主的建议性策略一致。沙箱仍是隔离边界。

## 模型体验

### 被拒绝的修改结果

#### 模型看到什么

被拒绝的 `write`、`edit`、`str_replace_editor` 或 `bash` 修改把宿主的精确原因作为普通工具错误返回，模型可以先读取文件再重试。允许的修改不会增加桥所拥有的内容。

#### Token 影响

允许的调用为零 token。拒绝会保留一个普通且有界的工具错误结果。

#### KV Cache 影响

不会改变请求前缀。拒绝只会在可复用前缀之后追加一个普通工具结果。

## 已知限制与延期工作

- **这是读取门，不是通用回调桥**——其他类型化 DSH 策略和 Claude Code 命令 hook 使用各自的拦截插件。
- **策略按设计失败时放行**——Redis/桥不可用不能让工作死锁；沙箱策略必须执行真实文件系统权限。
- **Bash 目标发现仍由宿主拥有**——桥把命令正则和快照语义委派给宿主，而不在 TypeScript 中重复实现。
