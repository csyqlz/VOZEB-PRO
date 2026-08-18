import { useEffect, useLayoutEffect, useRef } from "react";
import type { Group } from "three";
import { disposeIsolatedModelMaterials, isolateAndTintModelMaterials } from "../runtime/modelMaterialTint";

type PartProps = {
  color: string;
  position: [number, number, number];
  scale: [number, number, number];
  rotation?: [number, number, number];
};

function BoxPart({ color, position, rotation, scale }: PartProps) {
  return (
    <mesh castShadow receiveShadow position={position} rotation={rotation} scale={scale}>
      <boxGeometry />
      <meshStandardMaterial color={color} metalness={0.04} roughness={0.62} />
    </mesh>
  );
}

function CylinderPart({ color, position, rotation, scale }: PartProps) {
  return (
    <mesh castShadow receiveShadow position={position} rotation={rotation} scale={scale}>
      <cylinderGeometry args={[0.5, 0.5, 1, 20]} />
      <meshStandardMaterial color={color} metalness={0.08} roughness={0.58} />
    </mesh>
  );
}

function Wheel({ x, z, radius = 0.22 }: { x: number; z: number; radius?: number }) {
  return (
    <CylinderPart
      color="#161b22"
      position={[x, radius, z]}
      rotation={[Math.PI / 2, 0, 0]}
      scale={[radius * 2, 0.14, radius * 2]}
    />
  );
}

function Vehicle({ color, kind }: { color: string; kind: "sedan" | "suv" | "bus" }) {
  const bus = kind === "bus";
  const suv = kind === "suv";
  const bodyY = bus ? 0.72 : suv ? 0.58 : 0.5;
  const bodyHeight = bus ? 1.2 : suv ? 0.68 : 0.48;
  const bodyLength = bus ? 2 : 1.75;
  const wheelX = bus ? 0.72 : 0.62;
  return (
    <group>
      <BoxPart color={color} position={[0, bodyY, 0]} scale={[bodyLength, bodyHeight, 0.82]} />
      {!bus ? (
        <BoxPart color={color} position={[0.08, suv ? 1.05 : 0.88, 0]} scale={[1.02, suv ? 0.52 : 0.38, 0.72]} />
      ) : null}
      <BoxPart color="#89b5c8" position={[bus ? 0 : 0.1, bus ? 1.07 : suv ? 1.08 : 0.91, 0.415]} scale={[bus ? 1.55 : 0.72, bus ? 0.45 : 0.25, 0.035]} />
      <BoxPart color="#dbe7ed" position={[-bodyLength / 2 - 0.01, bodyY + 0.04, 0]} scale={[0.035, 0.16, 0.58]} />
      <BoxPart color="#efcc55" position={[bodyLength / 2 + 0.01, bodyY + 0.04, 0]} scale={[0.035, 0.15, 0.54]} />
      <Wheel x={-wheelX} z={-0.46} radius={bus ? 0.25 : 0.22} />
      <Wheel x={wheelX} z={-0.46} radius={bus ? 0.25 : 0.22} />
      <Wheel x={-wheelX} z={0.46} radius={bus ? 0.25 : 0.22} />
      <Wheel x={wheelX} z={0.46} radius={bus ? 0.25 : 0.22} />
    </group>
  );
}

function Bicycle() {
  return (
    <group>
      {[-0.66, 0.66].map((x) => (
        <mesh key={x} castShadow position={[x, 0.47, 0]}>
          <torusGeometry args={[0.36, 0.045, 10, 28]} />
          <meshStandardMaterial color="#17212a" roughness={0.6} />
        </mesh>
      ))}
      <BoxPart color="#e85f4d" position={[0, 0.64, 0]} rotation={[0, 0, 0.58]} scale={[0.92, 0.07, 0.07]} />
      <BoxPart color="#e85f4d" position={[0.08, 0.64, 0]} rotation={[0, 0, -0.58]} scale={[0.82, 0.07, 0.07]} />
      <BoxPart color="#2d3741" position={[0.28, 1.03, 0]} rotation={[0, 0, -0.22]} scale={[0.06, 0.72, 0.06]} />
      <BoxPart color="#2d3741" position={[0.42, 1.34, 0]} scale={[0.42, 0.05, 0.05]} />
      <BoxPart color="#20262c" position={[-0.12, 1.04, 0]} scale={[0.3, 0.06, 0.16]} />
    </group>
  );
}

function Scooter() {
  return (
    <group>
      <BoxPart color="#3d566e" position={[0, 0.16, 0]} scale={[1.2, 0.12, 0.3]} />
      <BoxPart color="#3d566e" position={[0.45, 0.75, 0]} rotation={[0, 0, -0.08]} scale={[0.08, 1.25, 0.08]} />
      <BoxPart color="#202831" position={[0.44, 1.36, 0]} scale={[0.48, 0.06, 0.06]} />
      <Wheel x={-0.46} z={0} radius={0.16} />
      <Wheel x={0.48} z={0} radius={0.16} />
    </group>
  );
}

function Sofa() {
  return (
    <group>
      <BoxPart color="#b26d4f" position={[0, 0.46, 0]} scale={[1.8, 0.42, 0.82]} />
      <BoxPart color="#9b5c43" position={[0, 0.9, 0.28]} rotation={[-0.12, 0, 0]} scale={[1.72, 0.7, 0.2]} />
      <BoxPart color="#8b513b" position={[-0.88, 0.68, 0]} scale={[0.18, 0.5, 0.82]} />
      <BoxPart color="#8b513b" position={[0.88, 0.68, 0]} scale={[0.18, 0.5, 0.82]} />
      <BoxPart color="#3b302b" position={[-0.7, 0.12, 0]} scale={[0.12, 0.24, 0.12]} />
      <BoxPart color="#3b302b" position={[0.7, 0.12, 0]} scale={[0.12, 0.24, 0.12]} />
    </group>
  );
}

function DiningTable() {
  return (
    <group>
      <BoxPart color="#8b5a36" position={[0, 0.88, 0]} scale={[1.75, 0.14, 1.05]} />
      {[-0.7, 0.7].flatMap((x) => [-0.38, 0.38].map((z) => (
        <BoxPart key={`${x}:${z}`} color="#654128" position={[x, 0.43, z]} scale={[0.12, 0.86, 0.12]} />
      )))}
    </group>
  );
}

function Appliance({ washer = false }: { washer?: boolean }) {
  return (
    <group>
      <BoxPart color="#e6e9ec" position={[0, 0.92, 0]} scale={[1.05, 1.84, 0.9]} />
      {washer ? (
        <>
          <CylinderPart color="#273744" position={[0, 0.92, 0.47]} rotation={[Math.PI / 2, 0, 0]} scale={[0.56, 0.08, 0.56]} />
          <CylinderPart color="#81a8bc" position={[0, 0.92, 0.52]} rotation={[Math.PI / 2, 0, 0]} scale={[0.38, 0.08, 0.38]} />
          <BoxPart color="#303942" position={[0, 1.56, 0.47]} scale={[0.72, 0.12, 0.04]} />
        </>
      ) : (
        <>
          <BoxPart color="#b9c8ce" position={[0, 1.22, 0.46]} scale={[0.02, 1.25, 0.05]} />
          <BoxPart color="#69767c" position={[-0.12, 1.18, 0.5]} scale={[0.05, 0.42, 0.04]} />
          <BoxPart color="#69767c" position={[0.12, 1.18, 0.5]} scale={[0.05, 0.42, 0.04]} />
        </>
      )}
    </group>
  );
}

function StreetLamp() {
  return (
    <group>
      <CylinderPart color="#303940" position={[0, 0.12, 0]} scale={[0.5, 0.24, 0.5]} />
      <CylinderPart color="#3c474e" position={[0, 1.12, 0]} scale={[0.14, 2, 0.14]} />
      <BoxPart color="#3c474e" position={[0.32, 2.05, 0]} scale={[0.7, 0.1, 0.1]} />
      <BoxPart color="#f4d77a" position={[0.65, 1.93, 0]} scale={[0.38, 0.18, 0.3]} />
    </group>
  );
}

function Tree() {
  return (
    <group>
      <CylinderPart color="#735139" position={[0, 0.68, 0]} scale={[0.28, 1.36, 0.28]} />
      <mesh castShadow position={[0, 1.6, 0]}><sphereGeometry args={[0.72, 12, 9]} /><meshStandardMaterial color="#4d8a55" roughness={0.9} /></mesh>
      <mesh castShadow position={[-0.45, 1.42, 0.12]}><sphereGeometry args={[0.45, 10, 8]} /><meshStandardMaterial color="#5c9c5d" roughness={0.9} /></mesh>
      <mesh castShadow position={[0.43, 1.48, -0.08]}><sphereGeometry args={[0.5, 10, 8]} /><meshStandardMaterial color="#397849" roughness={0.9} /></mesh>
    </group>
  );
}

function TrashBins() {
  return <group>{[-0.5, 0, 0.5].map((x, index) => <BoxPart key={x} color={["#4386b2", "#4b9664", "#d09144"][index]} position={[x, 0.52, 0]} scale={[0.42, 1.02, 0.48]} />)}</group>;
}

function LegacyProp({ modelId }: { modelId: string }) {
  if (modelId.includes("atm")) return <><BoxPart color="#315e78" position={[0, 0.9, 0]} scale={[1.1, 1.8, 0.72]} /><BoxPart color="#172b38" position={[0, 1.2, 0.38]} rotation={[-0.16, 0, 0]} scale={[0.68, 0.45, 0.05]} /><BoxPart color="#87b9c9" position={[0, 1.23, 0.42]} rotation={[-0.16, 0, 0]} scale={[0.52, 0.3, 0.03]} /></>;
  if (modelId.includes("backpack")) return <><BoxPart color="#516b55" position={[0, 0.72, 0]} scale={[0.9, 1.3, 0.55]} /><BoxPart color="#334837" position={[0, 0.42, 0.32]} scale={[0.65, 0.42, 0.2]} /></>;
  if (modelId.includes("thermus")) return <><CylinderPart color="#bfc8cc" position={[0, 0.75, 0]} scale={[0.5, 1.5, 0.5]} /><CylinderPart color="#37434a" position={[0, 1.55, 0]} scale={[0.42, 0.16, 0.42]} /></>;
  if (modelId.includes("wrench")) return <><BoxPart color="#8d999f" position={[0, 0.16, 0]} rotation={[0, 0.35, 0]} scale={[1.6, 0.16, 0.24]} /><mesh position={[0.72, 0.18, -0.26]} rotation={[Math.PI / 2, 0, 0]}><torusGeometry args={[0.25, 0.08, 8, 18]} /><meshStandardMaterial color="#8d999f" metalness={0.6} roughness={0.35} /></mesh></>;
  if (modelId.includes("drill_press")) return <><BoxPart color="#3f5961" position={[0, 0.12, 0]} scale={[1.1, 0.24, 0.8]} /><CylinderPart color="#606c70" position={[0, 0.9, 0]} scale={[0.16, 1.6, 0.16]} /><BoxPart color="#315b60" position={[0, 1.5, 0]} scale={[0.78, 0.42, 0.52]} /></>;
  if (modelId.includes("deer_skull")) return <><BoxPart color="#d5c9aa" position={[0, 0.75, 0]} rotation={[0, 0, 0.15]} scale={[0.42, 0.7, 0.25]} /><BoxPart color="#d5c9aa" position={[-0.42, 1.25, 0]} rotation={[0, 0, -0.5]} scale={[0.55, 0.08, 0.08]} /><BoxPart color="#d5c9aa" position={[0.42, 1.25, 0]} rotation={[0, 0, 0.5]} scale={[0.55, 0.08, 0.08]} /></>;
  return <BoxPart color="#73808a" position={[0, 0.5, 0]} scale={[1, 1, 1]} />;
}

function BuiltInLifeModelContent({ modelId }: { modelId: string }) {
  const id = modelId.toLowerCase();
  if (id.includes("sedan")) return <Vehicle color="#4b7cac" kind="sedan" />;
  if (id.includes("suv")) return <Vehicle color="#6b7650" kind="suv" />;
  if (id.includes("city_bus")) return <Vehicle color="#d5a13a" kind="bus" />;
  if (id.includes("bicycle")) return <Bicycle />;
  if (id.includes("scooter")) return <Scooter />;
  if (id.includes("sofa")) return <Sofa />;
  if (id.includes("dining_table")) return <DiningTable />;
  if (id.includes("refrigerator")) return <Appliance />;
  if (id.includes("washing_machine")) return <Appliance washer />;
  if (id.includes("street_lamp")) return <StreetLamp />;
  if (id.includes("street_tree")) return <Tree />;
  if (id.includes("trash_sorting")) return <TrashBins />;
  return <LegacyProp modelId={id} />;
}

export function BuiltInLifeModel({ color, modelId }: { color?: string; modelId: string }) {
  const rootRef = useRef<Group>(null);
  useLayoutEffect(() => {
    if (rootRef.current) isolateAndTintModelMaterials(rootRef.current, color);
  }, [color]);
  useEffect(() => {
    const root = rootRef.current;
    return () => {
      if (root) disposeIsolatedModelMaterials(root);
    };
  }, []);

  return (
    <group ref={rootRef} name="built-in-life-model">
      <BuiltInLifeModelContent modelId={modelId} />
    </group>
  );
}
