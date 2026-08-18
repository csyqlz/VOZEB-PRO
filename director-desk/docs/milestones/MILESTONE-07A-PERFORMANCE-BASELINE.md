# 目标 7A：可重复性能基准与开销审计

完成日期：2026-07-16

## 基准工具

- 仅在 URL 带 `benchmark=standard` 时启用，不影响普通导演台。
- 基准使用内存临时工作区，不写入导演台注册表或项目存档。
- 固定压力场景：25 个带动作和两点路线的人物、12 个道具、三点循环镜头、地面、编辑网格、主视口和成片监看小窗。
- 预热 2 秒后采样 6 秒，使用浏览器原生 `requestAnimationFrame`，不依赖 R3F 的被测帧循环。
- 报告指标：平均 FPS、平均帧时间、P50/P95/P99、1% low、长帧比例、draw calls、三角形、几何体、纹理、Canvas 数量、CSS/实际像素尺寸、平台、CPU 线程数和 WebGL 渲染器。
- 报告同时写入 `window.__DIRECTOR_BENCHMARK_REPORT__` 和主 Canvas 的 `data-benchmark-report`，便于浏览器自动化读取。

## 当前 macOS 基线

测试环境：

- 平台：`MacIntel`
- GPU：`ANGLE Metal Renderer: Apple M5 Pro`
- 浏览器报告线程数：15
- 页面视口：1280 x 650 CSS 像素
- 设备 DPR：2
- 主 Canvas：2560 x 1300 实际像素
- Canvas 数量：3（主视口、坐标 Gizmo、成片监看）

三次重复结果：

| 次数 | 平均 FPS | 平均帧时间 | P95 |
| --- | ---: | ---: | ---: |
| 1 | 4.4 | 229.55 ms | 235.0 ms |
| 2 | 4.4 | 229.48 ms | 234.1 ms |
| 3 | 4.4 | 225.93 ms | 233.4 ms |

最终完整报告：

- P50：233.3 ms
- P95：233.6 ms
- P99：266.6 ms
- 1% low：3.8 FPS
- 长帧比例：100%
- 主视口峰值 draw calls：38
- 主视口峰值三角形：271,656
- 主视口几何体：14
- 主视口纹理：28

这些数字是“M5 Pro + DPR 2 + 25 人双视口压力场景”，不是空场景最高帧率，也不是 Windows 实机数据。

## 高优先级瓶颈

1. 播放进度每帧写入 Zustand，引发页面和多个 Canvas 的 React 重渲染。
2. 同一本地模型在不同 Canvas 中得到不同 Blob URL，破坏 `useLoader` 缓存共享，并重复骨骼克隆。
3. 全景纹理和地面 CanvasTexture 在每个 Canvas 中重复创建。
4. 播放时路线采样数组变化，Drei Line 会持续重建几何。
5. 主 Canvas 默认 DPR 可到 2，长期启用抗锯齿和 `preserveDrawingBuffer`；小窗与 Gizmo 又各自创建 WebGLRenderer。

## 自动验证

- 聚焦测试：3 个文件、42 项测试通过。
- 全量测试：62 个测试文件、530 项测试通过。
- `npm run build` 通过，仅保留既存的大 chunk 警告。
- `npx tsc -b --pretty false` 通过。
- `git diff --check` 通过。
- 浏览器压力场景连续播放、主视口和小窗正常，无业务控制台错误。

## 下一步

当时的 7B 计划是实现四档逐档对比；最终在 7D 按原始产品要求收敛为自动、流畅、高清三个用户选项，均衡只保留为自动档内部状态和固定基准参数。档位统一控制 DPR、抗锯齿、`preserveDrawingBuffer`、Gizmo Canvas 和监看策略；同时优先处理每帧全局 React 重渲染，不能只靠降画质掩盖结构性开销。

## 当前状态

- 未提交、未推送、未同步 GitHub 或在线版。
