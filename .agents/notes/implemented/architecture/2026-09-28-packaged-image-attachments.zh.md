# Agent Note: 打包 Linux 可执行文件中的图片附件

Status: implemented

[English](2026-09-28-packaged-image-attachments.md) | 中文

## 问题

`@deepseek-ai/dsh-attachment-local` 使用 `sharp` 对每张准入图片做完整解码，并在已校验的读取中读取格式与尺寸。`sharp` 加载其原生插件，该插件链接 `@img/sharp-libvips-<platform>` 包中的 `libvips-cpp`。单文件可执行文件的资源 glob 列出了 `*.dylib`、`*.so` 与 `*.dll`，但 Linux 共享对象带有 ABI 版本后缀（`libvips-cpp.so.8.18.3`），因此没有任何 Linux 可执行文件包含 libvips。macOS 可执行文件包含 `libvips-cpp.8.18.3.dylib`，可以加载该存储。启用该存储的 Linux 组合无法加载插件，而失败的导入会拖垮整个 Cordis 树。因此 SDK 宿主始终禁用该存储，这也移除了 `read_image` 工具；宿主也无法区分能加载该存储的构建与不能加载的构建。

## 决策

- 资源 glob 新增 `node_modules/**/*.so.*`，使每个 Linux 可执行文件在链接它的插件旁附带带版本后缀的 `libvips-cpp` 共享对象。
- `initialize` 返回 `capabilities.attachments: true`。该值描述服务器构建：组合可以启用附件存储，随后其 `read_image` 工具与持久 `image` 内容块可用。它不报告当前组合是否启用了该存储。TypeScript 客户端将缺省值报告为 `false`，Python 的 `ServerCapabilities.attachments` 默认为 `false`。

`sharp` 保留。它只用于准入与已校验读取的检查，不用于缩放或转码，但准入时的完整解码是存储拒绝畸形图片的手段，仅解析文件头会移除这一检查。

## 考虑过的替代方案

**用文件头解析替代 `sharp`。** 这会移除原生依赖，但会丢掉完整解码的准入检查，并为四种格式新增自有解析代码。

**报告当前组合是否挂载了该存储。** 宿主必须在启动进程前决定是否组合该存储，因为旧的 Linux 可执行文件无法加载它。按组合给出的值只有在启用存储后才能观察到，而这正是宿主必须避免的情形。

## 影响

宿主可以从任一 `initialize` 结果得知可执行文件能够加载附件存储，并在之后启动的进程中启用它。Linux 可执行文件的体积增加一个 libvips 共享对象的大小。Linux 闭包只能由在 Linux runner 上构建的可执行文件证明，因为原生 PTY 插件排除了跨架构的本地构建。

## 测试

`packages/sdk/server/tests/server.spec.ts` 与 `packages/sdk/server/tests/plugin-apply.spec.ts` 覆盖 `initialize` 能力。`packages/sdk/client/tests/sdk-client.spec.ts` 与 `python/sdk/tests/test_client.py` 覆盖能力投影，包括不发送该能力的服务器。本地构建的 macOS arm64 可执行文件经由 ParallelLoop Agents SDK provider 端到端地对一张 PNG 执行了 `read_image`。
