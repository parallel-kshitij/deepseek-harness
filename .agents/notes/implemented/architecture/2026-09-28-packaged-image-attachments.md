# Agent Note: Image attachments in the packaged Linux executable

Status: implemented

English | [中文](2026-09-28-packaged-image-attachments.zh.md)

## Problem

`@deepseek-ai/dsh-attachment-local` uses `sharp` to decode every admitted image completely and to read the format and dimensions of verified reads. `sharp` loads its native addon, which links against `libvips-cpp` from the `@img/sharp-libvips-<platform>` package. The single-executable asset globs listed `*.dylib`, `*.so`, and `*.dll`, but Linux shared objects carry an ABI version suffix (`libvips-cpp.so.8.18.3`), so no Linux executable contained libvips. The macOS executable contains `libvips-cpp.8.18.3.dylib` and loads the store. A Linux composition that enables the store fails to load the plugin, and the failed import takes down the whole Cordis tree. SDK hosts therefore keep the store disabled, which also removes the `read_image` tool, and they cannot tell a build that can load the store from one that cannot.

## Decision

- The asset globs add `node_modules/**/*.so.*`, so every Linux executable ships the versioned `libvips-cpp` shared object beside the addon that links it.
- `initialize` returns `capabilities.attachments: true`. The value describes the server build: a composition may enable the attachment store, whose `read_image` tool and durable `image` content blocks then work. It does not report whether the current composition enabled the store. The TypeScript client reports an absent value as `false`, and the Python `ServerCapabilities.attachments` defaults to `false`.

`sharp` stays. It is used only for admission and verified-read inspection, not for resizing or transcoding, but a full decode at admission is the store's rejection of malformed images, and a header-only parser would remove that check.

## Alternatives considered

**Replace `sharp` with header parsing.** It removes the native dependency, but it drops the full-decode admission check and adds owned parser code for four formats.

**Report whether the current composition mounted the store.** A host must decide before spawning whether to compose the store, because an old Linux executable cannot load it. A per-composition value can be observed only after enabling the store, which is the case the host must avoid.

## Consequences

A host can learn from any `initialize` result that the executable can load the attachment store, then enable it on later spawns. Linux executables grow by the size of the libvips shared object. The Linux closure is proven only by an executable built on a Linux runner, because the native PTY addon rules out a cross-architecture local build.

## Testing

`packages/sdk/server/tests/server.spec.ts` and `packages/sdk/server/tests/plugin-apply.spec.ts` cover the `initialize` capability. `packages/sdk/client/tests/sdk-client.spec.ts` and `python/sdk/tests/test_client.py` cover the capability projection, including a server that sends none. A locally built macOS arm64 executable served `read_image` on a PNG end to end through the ParallelLoop Agents SDK provider.
