import { Canvas, useFrame, useLoader } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { Suspense, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { AnimationMixer, Box3, LoopRepeat, Vector3 } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import { inspectCharacterAsset, type CharacterAssetInspection } from "../../editor/loaders/characterAssetInspection";
import "./style.css";

const MODEL_URL = `${import.meta.env.BASE_URL}local-assets/sample-characters/cesium-man.glb`;

interface CharacterImportSmokeReport {
  status: "loading" | "passed" | "failed";
  model: string;
  source: string;
  inspection: CharacterAssetInspection | null;
  error: string | null;
}

declare global {
  interface Window {
    __CHARACTER_IMPORT_SMOKE__?: CharacterImportSmokeReport;
  }
}

function CharacterPreview({ onInspection }: { onInspection: (report: CharacterAssetInspection) => void }) {
  const gltf = useLoader(GLTFLoader, MODEL_URL);
  const { scene, mixer, scale, offset } = useMemo(() => {
    const clonedScene = cloneSkeleton(gltf.scene);
    clonedScene.updateMatrixWorld(true);
    const bounds = new Box3().setFromObject(clonedScene);
    const size = bounds.getSize(new Vector3());
    const modelScale = size.y > 0 ? 1.8 / size.y : 1;
    return {
      scene: clonedScene,
      mixer: new AnimationMixer(clonedScene),
      scale: modelScale,
      offset: new Vector3(
        -(bounds.min.x + bounds.max.x) * 0.5 * modelScale,
        -bounds.min.y * modelScale,
        -(bounds.min.z + bounds.max.z) * 0.5 * modelScale
      ),
    };
  }, [gltf.scene]);

  useLayoutEffect(() => {
    const clip = gltf.animations.find((item) => item.duration > 0.05 && item.tracks.length > 0);
    if (!clip) return;
    const action = mixer.clipAction(clip, scene);
    action.reset().setLoop(LoopRepeat, Infinity).play();
    return () => {
      mixer.stopAllAction();
      mixer.uncacheRoot(scene);
    };
  }, [gltf.animations, mixer, scene]);

  useEffect(() => {
    onInspection(inspectCharacterAsset(scene, gltf.animations, "glb"));
  }, [gltf.animations, onInspection, scene]);

  useFrame((_, delta) => mixer.update(Math.min(delta, 0.1)));

  return (
    <group position={[offset.x, offset.y, offset.z]} scale={scale}>
      <primitive object={scene} />
    </group>
  );
}

function App() {
  const [report, setReport] = useState<CharacterImportSmokeReport>({
    status: "loading",
    model: "CesiumMan.glb",
    source: "Khronos glTF Sample Assets / Cesium, CC-BY 4.0 with trademark limitations",
    inspection: null,
    error: null,
  });

  useEffect(() => {
    window.__CHARACTER_IMPORT_SMOKE__ = report;
  }, [report]);

  const handleInspection = useMemo(() => (inspection: CharacterAssetInspection) => {
    const passed = inspection.skinnedMeshCount > 0
      && inspection.primaryBoneCount > 10
      && inspection.playableAnimationCount > 0
      && inspection.dimensions.every(Number.isFinite);
    setReport((current) => ({
      ...current,
      status: passed ? "passed" : "failed",
      inspection,
      error: passed ? null : "骨架、动作或尺寸体检未达到验收条件",
    }));
  }, []);

  const inspection = report.inspection;

  return (
    <main className="character-import-smoke">
      <header className="character-import-smoke__header">
        <div>
          <h1>外部绑骨人物导入自测</h1>
          <p>真实 GLB · 蒙皮骨架 · 自带动作 · 正式体检器</p>
        </div>
        <strong data-state={report.status} role="status">
          {report.status === "loading" ? "正在加载" : report.status === "passed" ? "验收通过" : "验收失败"}
        </strong>
      </header>
      <section className="character-import-smoke__workspace">
        <div className="character-import-smoke__viewport">
          <Canvas camera={{ position: [2.6, 1.4, 3.2], fov: 38 }} dpr={[1, 1.5]}>
            <color attach="background" args={["#101419"]} />
            <ambientLight intensity={1.8} />
            <directionalLight intensity={2.4} position={[3, 5, 4]} />
            <Suspense fallback={null}>
              <CharacterPreview onInspection={handleInspection} />
            </Suspense>
            <gridHelper args={[8, 16, "#526071", "#28313b"]} />
            <OrbitControls makeDefault target={[0, 0.9, 0]} />
          </Canvas>
        </div>
        <aside className="character-import-smoke__report">
          <h2>{report.model}</h2>
          <dl>
            <div><dt>兼容等级</dt><dd>{inspection?.readiness ?? "检查中"}</dd></div>
            <div><dt>骨架类型</dt><dd>{inspection?.rigProfile ?? "检查中"}</dd></div>
            <div><dt>蒙皮网格</dt><dd>{inspection ? `${inspection.skinnedMeshCount} 个` : "检查中"}</dd></div>
            <div><dt>主骨架</dt><dd>{inspection ? `${inspection.primaryBoneCount} 根` : "检查中"}</dd></div>
            <div><dt>可播放动作</dt><dd>{inspection ? `${inspection.playableAnimationCount} 个` : "检查中"}</dd></div>
            <div><dt>身体识别</dt><dd>{inspection ? `${inspection.mappedBodyParts.length}/16` : "检查中"}</dd></div>
          </dl>
          {inspection?.animationNames.length ? (
            <p className="character-import-smoke__action">正在播放：{inspection.animationNames[0]}</p>
          ) : null}
          {inspection?.warnings.length ? (
            <ul>{inspection.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
          ) : null}
          {report.error ? <p className="character-import-smoke__error">{report.error}</p> : null}
          <footer>{report.source}</footer>
        </aside>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
