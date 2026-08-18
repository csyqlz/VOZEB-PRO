# 3D 导演台二创与嵌入协议

这个项目是独立 Vite 应用。推荐用 iframe 引入，不要把 Three.js 依赖打进宿主项目。

## iframe 地址

同源部署时：

```html
<iframe src="/director-desk/?instanceId=node_123&theme=dark"></iframe>
```

本地跨端口开发时，必须带 `hostOrigin`：

```html
<iframe
  src="http://localhost:5173/?instanceId=node_123&theme=dark&hostOrigin=http%3A%2F%2Flocalhost%3A3000"
></iframe>
```

参数：

| 参数 | 说明 |
| --- | --- |
| `instanceId` | 当前导演台实例 ID。导演台会按这个 ID 做 localStorage 场景隔离。 |
| `theme` | `dark` 或 `light`。 |
| `hostOrigin` | 父页面 origin。跨端口/跨域 iframe 通信时必填。 |

同一个 `instanceId` 会恢复同一个导演台工程；不同 `instanceId` 会隔离保存。独立打开时，顶部也可以在“导演台 1 号 / 导演台 2 号”等本地实例之间切换。

不带 `instanceId` 直接访问根地址时，会显示导演台首页，让用户选择、新建或删除本地导演台。

## 子应用发给宿主

### ready

导演台初始化完成：

```ts
{
  type: "storyai:director-desk-ready"
}
```

收到 `ready` 后，宿主应先调用下文的 `capabilities.get`，不要根据导演台界面版本猜测接口能力。

### close

用户点击右上角关闭：

```ts
{
  type: "storyai:director-desk-close"
}
```

### captures-sent

用户把机位截图发送回宿主：

```ts
{
  type: "storyai:director-desk-captures-sent",
  payload: {
    captures: [
      {
        dataUrl: "data:image/png;base64,...",
        fileName: "机位01-截图01.png"
      }
    ]
  }
}
```

宿主收到后建议：

1. 把 `dataUrl` 转成文件，保存到宿主自己的素材/本地数据层；
2. 在画布上创建图片节点；
3. 不要长期把大 base64 存进普通 localStorage。

## 宿主发给子应用

### session

打开或切换一个导演台实例：

```ts
iframe.contentWindow?.postMessage(
  {
    type: "storyai:director-desk-session",
    payload: {
      instanceId: "node_123",
      theme: "dark"
    }
  },
  "http://localhost:5173"
);
```

### panorama

把宿主已有图片设置为当前导演台全景图：

```ts
iframe.contentWindow?.postMessage(
  {
    type: "storyai:director-desk-panorama",
    payload: {
      edgeId: "edge_image_director",
      sourceNodeId: "node_image",
      imageUrl: "https://example.com/panorama.jpg",
      fileName: "场景全景图.jpg"
    }
  },
  directorOrigin
);
```

`imageUrl` 支持 `http:`、`https:`、`blob:` 和 `data:image/`。宿主需要自行保证地址对 iframe 可访问。

## 二创受控接口 v1

当前协议版本为 `1`。所有请求使用同一个消息类型：

本地开发时可以直接打开 `/extension-protocol-smoke.html`，它会建立独立测试导演台，连续验证工程读取、插件结果、首帧、当前帧、尾帧、非黑图和导出后时间轴恢复，不会修改正式导演台。`/extension-video-smoke.html` 使用临时标准压力工程实际录制一段 MP4，用于验证浏览器的 MediaRecorder、画面变化和 Blob 回传。

```ts
{
  type: "storyai:director-desk:request",
  payload: {
    requestId: "宿主生成的唯一请求 ID",
    action: "capabilities.get" | "project.get" | "timeline.get" | "export.frame" | "export.video" | "plugin.result.submit" | "plugin.results.list",
    options: {}
  }
}
```

所有响应使用：

```ts
{
  type: "storyai:director-desk:response",
  payload: {
    protocolVersion: 1,
    requestId: "原请求 ID",
    action: "project.get",
    ok: true,
    data: {}
  }
}
```

失败时 `ok` 为 `false`，并返回 `error.code` 和中文 `error.message`。宿主必须按 `requestId` 配对响应，不能假设响应顺序与请求顺序相同。

### 查询能力

请求 `capabilities.get`。返回的关键字段：

```ts
{
  protocolVersion: 1,
  projectSchemaVersion: 1,
  actions: ["capabilities.get", "project.get", "timeline.get", "export.frame", "export.video", "plugin.result.submit", "plugin.results.list"],
  uiExports: ["project-json", "reference-video", "viewport-still"],
  protocolExports: ["clean-frame", "reference-video"],
  assetPersistence: "browser-local-references"
}
```

### 读取工程

请求 `project.get`，返回：

```ts
{
  protocolVersion: 1,
  projectSchemaVersion: 1,
  projectFingerprint: "fnv1a32-1234abcd",
  project: {
    version: 1,
    scene: {},
    assets: [],
    animationAssets: [],
    objects: [],
    cameras: [],
    activeCameraId: "cam_1",
    panoramaAssetId: null
  },
  portability: {
    portable: true,
    browserLocalAssetIds: [],
    note: null
  }
}
```

`project` 是深拷贝，只包含工程数据，不含选中状态、撤销栈、鼠标状态和播放循环等 UI 内部数据。

相机 `motionPath` 包含时长、FOV、路线形状、速度曲线、停留点和逐点追踪目标。人物/道具 `motionPath` 包含空间变换、到达时间、停留行为及动作。人物追踪部位通过相机轨迹点的 `targetBodyPart` 表示。

`projectFingerprint` 是当前工程内容的确定性指纹。插件读取工程后应原样带回这个值；它用于判断计算期间工程是否已经改变，不作为密码或安全签名。

### 读取当前时间轴

请求 `timeline.get`，返回：

```ts
{
  protocolVersion: 1,
  progress: 0.375,
  timeSeconds: 3,
  durationSeconds: 8,
  playing: true,
  viewMode: "camera",
  activeCameraId: "cam_1"
}
```

这里读取的是实际渲染使用的高频时间源，不是可能被性能档位降频的界面数字。

### 导出当前帧、首帧或尾帧

请求 `export.frame`：

```ts
{
  requestId: "frame-1",
  action: "export.frame",
  options: {
    fileName: "首帧.png",
    position: "current" | "first" | "last",
    quality: "720p" | "1080p"
  }
}
```

成功响应的 `data` 包含 PNG `dataUrl`、实际宽高、文件名和对应进度。它来自干净成片 Canvas，不包含 UI、网格、轨迹线或轨迹点。导出结束后会恢复用户原来的时间点和播放状态。`720p` / `1080p` 表示清晰度边界，实际宽高仍跟随导演台当前画幅；例如 16:9 的 720p 为 1280 x 720，竖屏 9:16 则按 720 像素高计算宽度。

### 导出参考视频

请求 `export.video`：

```ts
{
  requestId: "video-1",
  action: "export.video",
  options: {
    fileName: "参考视频.mp4",
    fps: 24 | 30 | 60,
    quality: "720p" | "1080p"
  }
}
```

成功响应的 `data.blob` 是 H.264 MP4 `Blob`，同时返回 MIME、实际宽高、时长和文件名。协议请求不会自动下载；宿主可以上传、保存或自行创建下载链接。界面里的“导出 MP4”仍会正常下载。

同一时间只允许一个帧或视频导出任务。并发请求返回 `export-busy`；渲染器未准备好、浏览器不支持 MediaRecorder 或镜头点不足时返回 `export-failed`。每个错误都保留原 `requestId`。

### 插件回传结果

插件读取 `project.get` 后，可以用 `plugin.result.submit` 把结构化结果送回导演台运行时收件箱：

```ts
{
  requestId: "plugin-result-1",
  action: "plugin.result.submit",
  options: {
    result: {
      basedOnProjectFingerprint: "fnv1a32-1234abcd",
      plugin: {
        id: "group.camera-agent",
        name: "群友镜头 Agent",
        version: "1.0.0"
      },
      kind: "camera-plan",
      status: "success",
      summary: "生成 6 个镜头建议",
      data: {
        shots: []
      }
    }
  }
}
```

导演台会返回带 `id`、`receivedAt` 和 `stale` 的结果记录。`stale: true` 表示结果基于旧工程，宿主不应自动套用。请求 `plugin.results.list` 可读取本次页面运行期间最近 50 条结果。

插件结果限制：

- `data` 必须是 JSON，不能包含函数、DOM、循环引用或可执行代码。
- 单条序列化数据最多 512 KB，收件箱最多保留 50 条。
- 插件 ID 只允许字母、数字、点、下划线和连字符。
- 结果收件箱只存在于当前页面运行时，不写工程 JSON，不上传服务器。
- 提交结果不会自动新增、删除或修改镜头、人物和素材；后续若增加“应用结果”，必须是独立的显式权限和用户确认流程。

### 最小调用示例

完整 React 宿主客户端见 `examples/infinite-canvas-embed.tsx`，包含来源校验、并发 requestId、超时清理、媒体导出和插件结果方法。下面是最小原理示例：

```ts
const directorOrigin = "http://localhost:5173";
const pending = new Map<string, (data: unknown) => void>();

window.addEventListener("message", (event) => {
  if (event.origin !== directorOrigin) return;
  if (event.data?.type !== "storyai:director-desk:response") return;

  const response = event.data.payload;
  const resolve = pending.get(response.requestId);
  if (!resolve) return;
  pending.delete(response.requestId);
  resolve(response);
});

function requestDirector(action: "capabilities.get" | "project.get" | "timeline.get" | "export.frame" | "export.video" | "plugin.result.submit" | "plugin.results.list") {
  const requestId = crypto.randomUUID();
  return new Promise((resolve) => {
    pending.set(requestId, resolve);
    iframe.contentWindow?.postMessage(
      {
        type: "storyai:director-desk:request",
        payload: { requestId, action }
      },
      directorOrigin
    );
  });
}
```

## 工程 JSON v1

界面导出的新工程文件使用以下外壳：

```json
{
  "format": "3d-director-desk-project",
  "schemaVersion": 1,
  "exportedAt": "2026-07-16T10:00:00.000Z",
  "project": {
    "version": 1,
    "scene": {},
    "assets": [],
    "animationAssets": [],
    "objects": [],
    "cameras": [],
    "activeCameraId": null,
    "panoramaAssetId": null
  }
}
```

兼容规则：

1. 当前导入器同时接受新版外壳和旧版裸 `project` JSON；旧版裸工程会作为文档版本 `0` 的输入，通过显式 `0 -> 1` 迁移后再校验。
2. 增加可选字段、不改变旧字段含义时不提升 `schemaVersion`。
3. 删除字段、改变单位、坐标含义或枚举语义时必须提升 `schemaVersion`。
4. 迁移必须按版本逐级执行，并先复制源数据，不能原地破坏用户文件。
5. 遇到高于当前支持范围的版本必须明确拒绝，不能静默丢字段后继续打开。
6. 对象、相机、轨迹点和素材 ID 是跨接口引用键；二创程序不得只按数组位置关联。

坐标和时间约定：

- 三维坐标为 Three.js 右手坐标系，`Y` 轴向上。
- `position` 单位为导演台场景单位，默认可按米理解。
- `rotation` 单位为弧度，顺序沿用 Three.js Euler 默认顺序。
- 路线点 `time` 为 `0-1` 归一化到达位置；实际秒数结合相机路线 `duration` 和停留规划计算。
- FOV 单位为度，表示透视相机垂直视场角。

## 本地素材边界

从电脑导入的 FBX、GLB、动作和全景图二进制保存在当前浏览器 IndexedDB。工程 JSON 和 `project.get` 只返回素材引用，不会把大型二进制塞进消息。

当 `portability.portable` 为 `false` 时：

- `browserLocalAssetIds` 会列出依赖当前浏览器的素材 ID；
- 同一浏览器、同一站点可继续恢复；
- 换电脑、换浏览器或换域名后，需要用户重新导入对应原始文件；
- 二创宿主若需要跨设备工程包，应自行实现素材上传、哈希和 URL 替换，不能长期保存 `blob:` URL。

## 安全边界

- 导演台只接受父窗口发来且来源为 `hostOrigin` 的消息，也只把响应发回这个 origin。
- `hostOrigin` 必须填写完整 origin，例如 `https://example.com`，不能填路径或 `*`。
- v1 二创接口允许读取、媒体导出和提交受限 JSON 结果，不提供删除工程、修改场景或执行任意代码的入口。
- 宿主仍应验证 `event.origin`、消息 `type`、`requestId` 和 `ok`。

## 无限画布侧推荐接法

最小接入只需要做一个“打开外部导演台”的入口：

1. 无限画布打开弹窗/新窗口，里面放 iframe；
2. iframe URL 带 `instanceId`、`theme`、`hostOrigin`；
3. 收到 `ready` 后调用 `capabilities.get`；需要时读取工程和时间轴。
4. 监听 `storyai:director-desk-captures-sent`，把截图落成图片节点。

这样 Three.js、R3F、模型加载、截图逻辑都留在独立导演台里，不污染无限画布主应用。
