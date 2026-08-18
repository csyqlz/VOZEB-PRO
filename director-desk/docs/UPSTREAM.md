# 上游来源

本项目基于 MIT 开源项目改造为本机独立 3D 导演台：

- 上游仓库：<https://github.com/jiguang132/storyai-3d-director-desk>
- 初始同步提交：`8c8bd36`
- 保留上游 `LICENSE`。

本地改动目标：

1. 作为独立 Vite 应用运行，不放入“无限画布”主仓库；
2. 通过 iframe / postMessage 供“无限画布”等宿主页面引入；
3. 允许通过 `hostOrigin` 查询参数配置父页面 origin，支持本地跨端口开发，例如父页面 `localhost:3000`、导演台 `localhost:5173`；
4. 截图结果通过消息回传给宿主，由宿主决定是否保存成画布图片节点。
