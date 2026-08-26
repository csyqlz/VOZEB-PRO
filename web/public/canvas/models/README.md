# Canvas 本地视觉模型

## 人脸检测

- `face_detection_full_range_sparse.tflite` 来自 Google MediaPipe 官方资源：<https://storage.googleapis.com/mediapipe-assets/face_detection_full_range_sparse.tflite>
- SHA-256：`2C3728E6DA56F21E21A320433396FB06D40D9088F2247C05E5635A688D45DFE1`
- 许可证：Apache License 2.0

模型只在用户点击“自动识别人脸”时由浏览器本地加载，输入图片不会上传到额外的人脸识别服务。

## 通用主体分割

- `magic_touch.tflite` 来自 Google MediaPipe 官方 MagicTouch 模型：<https://storage.googleapis.com/mediapipe-models/interactive_segmenter/magic_touch/float32/1/magic_touch.tflite>
- SHA-256：`E24338A717C1B7AD8D159666677EF400BABB7F33B8AD60C4D96DB4ECF694CD25`
- 许可证：Apache License 2.0

模型只在用户点击“消除背景”或“智能分层”时由浏览器 Worker 按需加载。图片仅在浏览器本地处理，不会上传到新增第三方分割服务。
