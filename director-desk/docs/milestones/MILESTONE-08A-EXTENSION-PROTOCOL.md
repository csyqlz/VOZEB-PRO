# 目标 8A：版本化工程与只读二创协议

完成日期：2026-07-16

## 本阶段交付

- 工程 JSON 新增稳定外壳：`format`、`schemaVersion`、`exportedAt`、`project`。
- 旧版裸 `DirectorProject` JSON 继续兼容导入，不要求用户重新导出旧工程。
- 2026-07-17 增加显式逐级迁移注册表：旧裸工程按文档版本 `0` 输入，经 `0 -> 1` 迁移后再做结构校验；迁移复制源数据，不原地修改用户对象。
- 文档版本必须是非负整数；字符串 `"1"`、`null`、缺失版本和未来版本均明确拒绝。
- 未知未来版本会明确拒绝，不会静默丢字段后继续打开。
- 新增二创协议 v1，支持：
  - `capabilities.get`：查询协议、工程版本、只读动作和界面导出能力。
  - `project.get`：读取深拷贝工程，不暴露 Zustand UI、撤销栈或瞬时操作状态。
  - `timeline.get`：读取真实高频播放进度、秒数、时长、播放状态、视角和活动相机。
- 项目快照会识别 IndexedDB / Blob 本地素材，并返回可移植性说明和素材 ID。
- 消息只接受父窗口且来源必须匹配 `hostOrigin`；v1 不提供远程修改或删除工程能力。
- `/extension-protocol-smoke.html` 已升级为完整机器判定页，使用独立导演台连续验证 9 个关联请求。

## 工程数据边界

- 工程包含场景、相机、FOV、镜头路线、人物/道具路线、动作、逐点追踪目标和语义身体部位。
- 轨迹点和对象通过稳定 ID 关联，二创程序不得依赖数组位置。
- UI 选择、鼠标状态、播放循环、撤销栈和剪贴板不属于工程协议。
- 本地 FBX/GLB/动作/全景二进制仍保存在当前浏览器 IndexedDB；协议只返回引用，不向 postMessage 塞入大型文件。
- 坐标、旋转、时间、FOV 和版本迁移规则已写入 `docs/embed-contract.md`。

## 自动验证

- 新增工程文档、二创协议和宿主桥测试。
- 聚焦测试：5 个文件、22 项通过。
- 全量测试：67 个文件、554 项通过。
- `npx tsc -b --pretty false` 通过。
- `npm run build` 通过，仅保留既存的大 chunk 警告。
- `git diff --check` 通过。

## 浏览器验证

- 自测页建立真实同源 iframe，独立实例为 `extension_protocol_smoke`。
- `capabilities.get`、`project.get`、`timeline.get` 三个响应全部 `ok: true`。
- iframe 内导演台正常渲染，存在主 Canvas 与坐标 Gizmo Canvas。
- 普通非 iframe 页面没有业务控制台错误；Three.js `Clock` 弃用警告仍为已知非阻塞项。
- 内置浏览器在嵌套 iframe 上产生一条无来源 URL 的 `MutationObserver` 注入层错误；普通页面对照和 iframe 业务渲染均正常，不来自项目代码。

### 2026-07-17 最终复验

- `capabilities.get`、`project.get`、导出前后 `timeline.get`、插件提交与列表全部成功。
- 工程快照自动测试明确覆盖镜头路线/FOV、逐点人物与身体部位追踪、立即/柔和跟随、人物路线/动作/停留/自定义曲线。
- 浏览器本地素材边界同时覆盖模型与动作素材；错误 origin、错误父窗口 source 和非法操作均有自动测试。
- 最新证据图：`../assets/smoke-results/extension-protocol-smoke-result-v2.png`。

## 尚未完成

- 程序化参考视频、当前帧、首帧和尾帧导出请求。
- 插件结果回传协议及写入权限边界。
- 完整可运行的 React 宿主示例升级。
- 目标 8 尚未整体完成。
- 未提交、未推送、未同步 GitHub 或在线版。
