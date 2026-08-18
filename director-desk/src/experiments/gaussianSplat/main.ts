import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
import {
  AmbientLight,
  Box3,
  Color,
  DirectionalLight,
  GridHelper,
  PerspectiveCamera,
  Raycaster,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Intersection,
  type Mesh,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import "./style.css";
import { mountExperimentUi } from "./experimentUi";
import {
  GAUSSIAN_BENCHMARK_DURATION_MS,
  summarizeGaussianFrames,
  type GaussianFrameSummary,
} from "./gaussianBenchmark";
import {
  createExperimentCameraRig,
  createExperimentCharacter,
  createExperimentProp,
  createGroundProbeLine,
  createProxyBoxMesh,
  createSurfaceMarker,
  disposeObjectTree,
  updateGroundProbeLine,
} from "./mixedScene";
import {
  buildAnonymousGaussianSplatBenchmarkReport,
  estimateGaussianSplatWorkingMemory,
  formatBytes,
  validateGaussianSplatFile,
  type AnonymousGaussianSplatBenchmarkReport,
  type GaussianSplatFileSummary,
} from "./splatFile";
import {
  clampSphereMovement,
  selectNearestDownwardHit,
  type AABB,
} from "./spatialCollision";
import {
  createSyntheticKsplatData,
  createSyntheticPlyData,
  createSyntheticSplatData,
} from "./syntheticSplat";

interface GaussianExperimentReport {
  status: "ready";
  asset: GaussianSplatFileSummary;
  loadMs: number;
  averageFps: number;
  estimatedWorkingMemoryBytes: number;
  renderer: string;
  canvas: { width: number; height: number };
  camera: { position: [number, number, number]; target: [number, number, number]; fov: number };
  scene: { meshObjects: 3; proxyCount: number };
  surfaceSelection: { selected: boolean; groundSampled: boolean };
}

type ProxyEntry = { bounds: AABB; mesh: Mesh };

declare global {
  interface Window {
    __GAUSSIAN_SPLAT_EXPERIMENT__?: GaussianExperimentReport;
    __GAUSSIAN_SPLAT_BENCHMARK__?: AnonymousGaussianSplatBenchmarkReport;
  }
}

function requireElement<T extends Element>(selector: string, message: string) {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(message);
  return element;
}

function tuple(vector: Vector3): [number, number, number] {
  return vector.toArray().map((value) => Number(value.toFixed(4))) as [number, number, number];
}

function browserLabel(userAgent: string) {
  const candidates: Array<[RegExp, string]> = [
    [/Edg\/(\d+)/, "Edge"],
    [/Chrome\/(\d+)/, "Chrome"],
    [/Firefox\/(\d+)/, "Firefox"],
    [/Version\/(\d+).+Safari\//, "Safari"],
  ];
  for (const [pattern, name] of candidates) {
    const match = userAgent.match(pattern);
    if (match?.[1]) return `${name} ${match[1]}`;
  }
  return "未知浏览器";
}

function setStatus(element: HTMLElement, text: string, kind: "normal" | "success" | "error" = "normal") {
  element.textContent = text;
  element.classList.toggle("is-success", kind === "success");
  element.classList.toggle("is-error", kind === "error");
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

const root = requireElement<HTMLElement>("#gaussian-splat-experiment", "高斯泼溅实验容器不存在");

async function startExperiment() {
  const ui = mountExperimentUi(root);
  const scene = new Scene();
  scene.background = new Color("#090b0f");
  const camera = new PerspectiveCamera(52, 1, 0.01, 2_000);
  const defaultPosition = new Vector3(4.8, 2.8, 6.4);
  const defaultTarget = new Vector3(0, 0.45, 0);
  camera.position.copy(defaultPosition);

  const renderer = new WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  ui.viewport.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.target.copy(defaultTarget);
  controls.minDistance = 1;
  controls.maxDistance = 200;
  controls.autoRotate = false;
  controls.autoRotateSpeed = 0.7;
  controls.update();

  const grid = new GridHelper(10, 20, "#315b82", "#202a36");
  grid.position.y = -0.84;
  scene.add(grid, new AmbientLight("#ffffff", 1.55));
  const keyLight = new DirectionalLight("#ffffff", 2.2);
  keyLight.position.set(4, 8, 6);
  scene.add(keyLight);

  const spark = new SparkRenderer({ renderer });
  scene.add(spark);

  const character = createExperimentCharacter();
  const prop = createExperimentProp();
  const cameraRig = createExperimentCameraRig();
  const surfaceMarker = createSurfaceMarker();
  const groundProbe = createGroundProbeLine();
  scene.add(character, prop, cameraRig, surfaceMarker, groundProbe);

  const raycaster = new Raycaster();
  const pointer = new Vector2();
  const down = new Vector3(0, -1, 0);
  const proxies: ProxyEntry[] = [];
  let splatMesh: SplatMesh | null = null;
  let currentBounds = new Box3(new Vector3(-4, -1, -3), new Vector3(4, 3, 3));
  let currentAsset: GaussianSplatFileSummary = { format: "splat", byteLength: 0, pointCount: 0 };
  let currentLoadMs = 0;
  let selectedSurfacePoint: Vector3 | null = null;
  let selectedGroundPoint: Vector3 | null = null;
  let characterTarget: Vector3 | null = null;
  let latestFps = 0;
  let latestBenchmark: AnonymousGaussianSplatBenchmarkReport | null = null;
  let currentBrowserHeapDeltaBytes: number | null = null;
  let benchmarkStartedAt: number | null = null;
  let benchmarkFrames: number[] = [];
  let loading = false;
  let pointerStart: Vector2 | null = null;

  const gl = renderer.getContext();
  const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
  const rendererName = String(gl.getParameter(debugInfo?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER) ?? "unknown");

  function updateProxyStatus() {
    setStatus(
      ui.collisionStatus,
      `${ui.collisionToggle.checked ? "碰撞开启" : "碰撞关闭"} · ${proxies.length} 个代理盒`,
      proxies.length > 0 ? "success" : "normal"
    );
  }

  function addProxy(center: Vector3, size = new Vector3(1.25, 1.9, 1.25)) {
    const mesh = createProxyBoxMesh(center, size);
    mesh.visible = ui.proxyToggle.checked;
    scene.add(mesh);
    proxies.push({
      mesh,
      bounds: {
        min: center.clone().addScaledVector(size, -0.5),
        max: center.clone().addScaledVector(size, 0.5),
      },
    });
    updateProxyStatus();
  }

  function clearProxies() {
    proxies.splice(0).forEach(({ mesh }) => {
      scene.remove(mesh);
      disposeObjectTree(mesh);
    });
    updateProxyStatus();
  }

  function resetDefaultProxy() {
    clearProxies();
    addProxy(new Vector3(0, 0.08, 0), new Vector3(1.3, 1.8, 1.3));
  }

  function fitViewToBounds(bounds: Box3) {
    if (bounds.isEmpty()) return;
    const center = bounds.getCenter(new Vector3());
    const size = bounds.getSize(new Vector3());
    const radius = Math.max(2.5, size.length() * 0.62);
    controls.target.copy(center);
    camera.position.copy(center).add(new Vector3(radius * 0.78, radius * 0.48, radius));
    camera.near = Math.max(0.01, radius / 2_000);
    camera.far = Math.max(100, radius * 20);
    camera.updateProjectionMatrix();
    controls.update();
    grid.position.y = bounds.min.y;
    character.position.set(
      center.x - Math.max(1.8, Math.min(3, size.x * 0.38)),
      bounds.min.y,
      center.z + Math.max(1.35, Math.min(2.1, size.z * 0.3))
    );
    prop.position.set(
      center.x + Math.max(1.7, Math.min(2.7, size.x * 0.34)),
      bounds.min.y,
      center.z + Math.max(1.1, Math.min(1.7, size.z * 0.24))
    );
  }

  function updateMetrics() {
    const memory = estimateGaussianSplatWorkingMemory(currentAsset);
    ui.countOutput.textContent = currentAsset.pointCount?.toLocaleString("zh-CN") ?? "解析后统计";
    ui.bytesOutput.textContent = formatBytes(currentAsset.byteLength);
    ui.loadOutput.textContent = `${currentLoadMs.toFixed(0)} ms`;
    ui.memoryOutput.textContent = currentBrowserHeapDeltaBytes === null
      ? `约 ${formatBytes(memory.totalBytes)}`
      : `约 ${formatBytes(memory.totalBytes)} · JS +${formatBytes(currentBrowserHeapDeltaBytes)}`;
  }

  function publishExperimentReport() {
    const memory = estimateGaussianSplatWorkingMemory(currentAsset);
    const report: GaussianExperimentReport = {
      status: "ready",
      asset: { ...currentAsset },
      loadMs: Number(currentLoadMs.toFixed(1)),
      averageFps: Number(latestFps.toFixed(1)),
      estimatedWorkingMemoryBytes: memory.totalBytes,
      renderer: rendererName,
      canvas: { width: renderer.domElement.width, height: renderer.domElement.height },
      camera: { position: tuple(camera.position), target: tuple(controls.target), fov: camera.fov },
      scene: { meshObjects: 3, proxyCount: proxies.length },
      surfaceSelection: { selected: Boolean(selectedSurfacePoint), groundSampled: Boolean(selectedGroundPoint) },
    };
    window.__GAUSSIAN_SPLAT_EXPERIMENT__ = report;
    renderer.domElement.dataset.experimentReport = JSON.stringify(report);
  }

  async function replaceSplat(
    bytes: Uint8Array,
    fileName: string,
    summary: GaussianSplatFileSummary,
    statusText: string
  ) {
    if (loading) return;
    loading = true;
    ui.importButton.disabled = true;
    ui.generateButton.disabled = true;
    setStatus(ui.sourceStatus, "正在解析并上传到 GPU…");
    const startedAt = performance.now();
    const heapBefore = (window.performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null;
    let nextMesh: SplatMesh | null = null;
    try {
      nextMesh = new SplatMesh({
        fileBytes: bytes,
        fileName,
        raycastable: true,
        minRaycastOpacity: 0.08,
      });
      scene.add(nextMesh);
      await nextMesh.initialized;
      await SplatMesh.staticInitialized;
      const nextBounds = nextMesh.getBoundingBox(false);
      nextMesh.updateMatrixWorld(true);
      const pointCount = nextMesh.splats?.getNumSplats() ?? summary.pointCount;

      if (splatMesh) {
        scene.remove(splatMesh);
        splatMesh.dispose();
      }
      splatMesh = nextMesh;
      currentBounds = nextBounds;
      currentAsset = { ...summary, pointCount };
      currentLoadMs = performance.now() - startedAt;
      const heapAfter = (window.performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null;
      currentBrowserHeapDeltaBytes = heapBefore === null || heapAfter === null
        ? null
        : Math.max(0, heapAfter - heapBefore);
      selectedSurfacePoint = null;
      selectedGroundPoint = null;
      characterTarget = null;
      surfaceMarker.visible = false;
      groundProbe.visible = false;
      ui.moveCharacterButton.disabled = true;
      ui.addProxyButton.disabled = true;
      latestBenchmark = null;
      ui.reportButton.disabled = true;
      fitViewToBounds(nextBounds);
      updateMetrics();
      setStatus(ui.sourceStatus, statusText, "success");
      setStatus(ui.pickStatus, "点击高斯表面选择空间点");
      publishExperimentReport();
      nextMesh = null;
    } catch (error) {
      if (nextMesh) {
        scene.remove(nextMesh);
        nextMesh.dispose();
      }
      setStatus(ui.sourceStatus, error instanceof Error ? error.message : "高斯场景加载失败", "error");
    } finally {
      loading = false;
      ui.importButton.disabled = false;
      ui.generateButton.disabled = false;
    }
  }

  async function loadGeneratedScene(count: number, format = ui.formatSelect.value as "splat" | "ply" | "ksplat") {
    const bytes = format === "ply"
      ? createSyntheticPlyData(count)
      : format === "ksplat"
        ? createSyntheticKsplatData(count)
        : createSyntheticSplatData(count);
    await replaceSplat(
      bytes,
      `generated-${count}.${format}`,
      { format, byteLength: bytes.byteLength, pointCount: count },
      `内置 ${count.toLocaleString("zh-CN")} 点 ${format.toUpperCase()} 测试场景`
    );
  }

  function downwardSurfaceSample(x: number, z: number) {
    if (!splatMesh) return null;
    const origin = new Vector3(x, currentBounds.max.y + Math.max(5, currentBounds.getSize(new Vector3()).y), z);
    raycaster.set(origin, down);
    raycaster.near = 0;
    raycaster.far = Math.max(20, currentBounds.getSize(new Vector3()).y * 3);
    splatMesh.updateMatrixWorld(true);
    const intersections = raycaster.intersectObject(splatMesh, false) as Intersection<SplatMesh>[];
    const hit = selectNearestDownwardHit(intersections, origin, { maxDistance: raycaster.far });
    if (!hit) return null;
    updateGroundProbeLine(groundProbe, origin, hit.point);
    return hit.point.clone();
  }

  function selectSurface(clientX: number, clientY: number) {
    if (!splatMesh || loading) return;
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    raycaster.setFromCamera(pointer, camera);
    raycaster.near = camera.near;
    raycaster.far = camera.far;
    splatMesh.updateMatrixWorld(true);
    const hit = raycaster.intersectObject(splatMesh, false)[0];
    if (!hit) {
      setStatus(ui.pickStatus, "此处没有可采样的高斯表面", "error");
      return;
    }

    selectedSurfacePoint = hit.point.clone();
    selectedGroundPoint = downwardSurfaceSample(hit.point.x, hit.point.z);
    surfaceMarker.position.copy(hit.point);
    surfaceMarker.visible = true;
    ui.moveCharacterButton.disabled = !selectedGroundPoint;
    ui.addProxyButton.disabled = !selectedGroundPoint;
    const groundText = selectedGroundPoint ? `，地面 Y ${selectedGroundPoint.y.toFixed(2)}` : "，未找到向下地面";
    setStatus(ui.pickStatus, `选点 ${tuple(hit.point).join(", ")}${groundText}`, selectedGroundPoint ? "success" : "normal");
    publishExperimentReport();
  }

  function startBenchmark() {
    benchmarkStartedAt = performance.now();
    benchmarkFrames = [];
    latestBenchmark = null;
    ui.benchmarkButton.disabled = true;
    ui.reportButton.disabled = true;
    setStatus(ui.benchmarkStatus, "正在采样 6 秒…");
  }

  function completeBenchmark(summary: GaussianFrameSummary) {
    latestBenchmark = buildAnonymousGaussianSplatBenchmarkReport({
      file: currentAsset,
      loadDurationMs: Number(currentLoadMs.toFixed(1)),
      averageFps: summary.averageFps,
      p95FrameMs: summary.p95FrameMs,
      frameCount: summary.frameCount,
      sampleDurationMs: GAUSSIAN_BENCHMARK_DURATION_MS,
      onePercentLowFps: summary.onePercentLowFps,
      browserHeapDeltaBytes: currentBrowserHeapDeltaBytes,
      system: {
        browser: browserLabel(navigator.userAgent),
        gpu: rendererName,
        hardwareConcurrency: Number.isFinite(navigator.hardwareConcurrency) ? navigator.hardwareConcurrency : null,
      },
      canvas: {
        width: renderer.domElement.width,
        height: renderer.domElement.height,
        devicePixelRatio: renderer.getPixelRatio(),
      },
      scene: { meshObjects: 3, proxyCount: proxies.length, collisionEnabled: ui.collisionToggle.checked },
    });
    window.__GAUSSIAN_SPLAT_BENCHMARK__ = latestBenchmark;
    renderer.domElement.dataset.benchmarkReport = JSON.stringify(latestBenchmark);
    benchmarkStartedAt = null;
    ui.benchmarkButton.disabled = false;
    ui.reportButton.disabled = false;
    setStatus(
      ui.benchmarkStatus,
      `${summary.averageFps} FPS · 1% Low ${summary.onePercentLowFps} · P95 ${summary.p95FrameMs} ms`,
      "success"
    );
  }

  function resize() {
    const width = Math.max(1, ui.viewport.clientWidth);
    const height = Math.max(1, ui.viewport.clientHeight);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  resize();
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(ui.viewport);
  resetDefaultProxy();
  await loadGeneratedScene(16_000, "splat");

  let frameCount = 0;
  let frameTimeTotal = 0;
  let lastFrameAt = performance.now();
  let lastFpsUpdateAt = lastFrameAt;
  renderer.setAnimationLoop((now) => {
    const deltaMs = Math.min(100, Math.max(0, now - lastFrameAt));
    lastFrameAt = now;
    frameCount += 1;
    frameTimeTotal += deltaMs;
    if (benchmarkStartedAt !== null && deltaMs > 0 && deltaMs < 1_000) benchmarkFrames.push(deltaMs);

    if (characterTarget) {
      const distance = character.position.distanceTo(characterTarget);
      if (distance <= 0.025) {
        character.position.copy(characterTarget);
        characterTarget = null;
      } else {
        const step = Math.min(distance, deltaMs * 0.001 * 1.35);
        const candidate = character.position.clone().lerp(characterTarget, step / distance);
        const resolved = ui.collisionToggle.checked
          ? clampSphereMovement(character.position, candidate, 0.3, proxies.map((entry) => entry.bounds))
          : candidate;
        const moved = resolved.distanceToSquared(character.position) > 1e-8;
        if (moved) {
          const direction = resolved.clone().sub(character.position);
          character.rotation.y = Math.atan2(-direction.x, -direction.z);
          character.position.copy(resolved);
        } else if (ui.collisionToggle.checked) {
          characterTarget = null;
          setStatus(ui.collisionStatus, `人物被代理盒阻挡 · ${proxies.length} 个代理盒`, "success");
        }
      }
    }

    prop.rotation.y += deltaMs * 0.00018;
    controls.update();
    renderer.render(scene, camera);

    if (benchmarkStartedAt !== null && now - benchmarkStartedAt >= GAUSSIAN_BENCHMARK_DURATION_MS) {
      completeBenchmark(summarizeGaussianFrames(benchmarkFrames));
    }
    if (now - lastFpsUpdateAt >= 1_000 && frameTimeTotal > 0) {
      latestFps = frameCount * 1_000 / frameTimeTotal;
      ui.fpsOutput.textContent = `${latestFps.toFixed(1)} FPS`;
      frameCount = 0;
      frameTimeTotal = 0;
      lastFpsUpdateAt = now;
      publishExperimentReport();
    }
  });

  renderer.domElement.addEventListener("pointerdown", (event) => {
    pointerStart = new Vector2(event.clientX, event.clientY);
  });
  renderer.domElement.addEventListener("pointerup", (event) => {
    const start = pointerStart;
    pointerStart = null;
    if (!start || start.distanceTo(new Vector2(event.clientX, event.clientY)) > 5) return;
    selectSurface(event.clientX, event.clientY);
  });

  ui.importButton.addEventListener("click", () => ui.fileInput.click());
  ui.fileInput.addEventListener("change", async () => {
    const file = ui.fileInput.files?.[0];
    ui.fileInput.value = "";
    if (!file) return;
    const validation = validateGaussianSplatFile(file);
    if (!validation.ok) {
      setStatus(ui.sourceStatus, validation.message, "error");
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    await replaceSplat(bytes, file.name, validation, `${file.name} · ${validation.format.toUpperCase()}`);
  });
  ui.resetSceneButton.addEventListener("click", () => void loadGeneratedScene(16_000, "splat"));
  ui.generateButton.addEventListener("click", () => void loadGeneratedScene(Number(ui.scaleSelect.value)));
  ui.resetViewButton.addEventListener("click", () => fitViewToBounds(currentBounds));
  ui.rotateButton.addEventListener("click", () => {
    controls.autoRotate = !controls.autoRotate;
    ui.rotateButton.setAttribute("aria-pressed", String(controls.autoRotate));
  });
  ui.exportButton.addEventListener("click", () => {
    renderer.render(scene, camera);
    renderer.domElement.toBlob((blob) => blob && downloadBlob(blob, "gaussian-splat-experiment.png"), "image/png");
  });
  ui.moveCharacterButton.addEventListener("click", () => {
    if (!selectedGroundPoint) return;
    characterTarget = selectedGroundPoint.clone();
    setStatus(ui.collisionStatus, "人物正在前往地面采样点…");
  });
  ui.addProxyButton.addEventListener("click", () => {
    if (!selectedGroundPoint) return;
    addProxy(selectedGroundPoint.clone().add(new Vector3(0, 0.95, 0)));
  });
  ui.clearProxyButton.addEventListener("click", clearProxies);
  ui.proxyToggle.addEventListener("change", () => proxies.forEach(({ mesh }) => { mesh.visible = ui.proxyToggle.checked; }));
  ui.collisionToggle.addEventListener("change", updateProxyStatus);
  ui.benchmarkButton.addEventListener("click", startBenchmark);
  ui.reportButton.addEventListener("click", () => {
    if (!latestBenchmark) return;
    downloadBlob(
      new Blob([`${JSON.stringify(latestBenchmark, null, 2)}\n`], { type: "application/json" }),
      "gaussian-splat-benchmark.json"
    );
  });
  requireElement<HTMLButtonElement>("#back-to-director", "返回按钮不存在").addEventListener("click", () => {
    window.location.href = `${import.meta.env.BASE_URL}`;
  });
}

startExperiment().catch((error) => {
  console.error(error);
  root.textContent = `高斯泼溅实验启动失败：${error instanceof Error ? error.message : "未知错误"}`;
  root.classList.add("experiment-error");
});
