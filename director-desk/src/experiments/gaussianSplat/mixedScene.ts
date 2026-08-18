import {
  BoxGeometry,
  BufferGeometry,
  CameraHelper,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  SphereGeometry,
  Vector3,
  type Material,
} from "three";

function material(color: string, options: { opacity?: number; wireframe?: boolean } = {}) {
  return new MeshStandardMaterial({
    color: new Color(color),
    opacity: options.opacity ?? 1,
    transparent: (options.opacity ?? 1) < 1,
    wireframe: options.wireframe ?? false,
  });
}

export function createExperimentCharacter() {
  const group = new Group();
  group.name = "实验人物";
  const bodyMaterial = material("#4f9de8");
  const skinMaterial = material("#f0b38d");
  const darkMaterial = material("#172334");

  const torso = new Mesh(new CylinderGeometry(0.27, 0.34, 0.86, 10), bodyMaterial);
  torso.position.y = 1.13;
  const head = new Mesh(new SphereGeometry(0.24, 16, 12), skinMaterial);
  head.position.y = 1.82;
  const leftLeg = new Mesh(new CylinderGeometry(0.105, 0.12, 0.78, 8), darkMaterial);
  leftLeg.position.set(-0.16, 0.39, 0);
  const rightLeg = leftLeg.clone();
  rightLeg.position.x = 0.16;
  const leftArm = new Mesh(new CylinderGeometry(0.075, 0.09, 0.72, 8), bodyMaterial);
  leftArm.position.set(-0.39, 1.16, 0);
  leftArm.rotation.z = -0.16;
  const rightArm = leftArm.clone();
  rightArm.position.x = 0.39;
  rightArm.rotation.z = 0.16;
  const direction = new Mesh(new ConeGeometry(0.12, 0.34, 8), material("#eaf4ff"));
  direction.position.set(0, 1.22, -0.38);
  direction.rotation.x = -Math.PI / 2;

  group.add(torso, head, leftLeg, rightLeg, leftArm, rightArm, direction);
  group.position.set(-2.7, -0.82, -1.6);
  return group;
}

export function createExperimentProp() {
  const group = new Group();
  group.name = "实验道具";
  const body = new Mesh(new BoxGeometry(0.9, 0.65, 0.7), material("#e6a34e"));
  body.position.y = 0.33;
  const top = new Mesh(new BoxGeometry(0.7, 0.08, 0.52), material("#fff0cb"));
  top.position.y = 0.7;
  group.add(body, top);
  group.position.set(2.55, -0.82, -1.2);
  return group;
}

export function createExperimentCameraRig() {
  const group = new Group();
  group.name = "实验摄像机";
  const camera = new PerspectiveCamera(45, 16 / 9, 0.1, 2.2);
  camera.position.set(-2.8, 1.35, -2.6);
  camera.lookAt(0, 0.55, 0);
  camera.updateMatrixWorld(true);
  const helper = new CameraHelper(camera);
  helper.name = "实验摄像机视锥";
  group.add(camera, helper);
  return group;
}

export function createSurfaceMarker() {
  const marker = new Group();
  marker.name = "高斯表面选点";
  marker.visible = false;
  const sphere = new Mesh(new SphereGeometry(0.09, 14, 10), material("#ffcf55"));
  const stem = new Mesh(new CylinderGeometry(0.015, 0.015, 0.55, 8), material("#ffcf55"));
  stem.position.y = 0.28;
  marker.add(sphere, stem);
  return marker;
}

export function createGroundProbeLine() {
  const geometry = new BufferGeometry();
  geometry.setFromPoints([new Vector3(), new Vector3(0, -1, 0)]);
  const line = new Line(geometry, new LineBasicMaterial({ color: "#70e0a1", transparent: true, opacity: 0.88 }));
  line.name = "向下地面探针";
  line.visible = false;
  return line;
}

export function updateGroundProbeLine(line: Line, from: Vector3, to: Vector3) {
  line.geometry.setFromPoints([from, to]);
  line.geometry.attributes.position.needsUpdate = true;
  line.visible = true;
}

export function createProxyBoxMesh(
  center: Vector3,
  size: Vector3,
  color = "#ff6d63"
) {
  const mesh = new Mesh(
    new BoxGeometry(size.x, size.y, size.z),
    material(color, { opacity: 0.18, wireframe: true })
  );
  mesh.name = "高斯碰撞代理盒";
  mesh.position.copy(center);
  mesh.userData.proxySize = size.toArray();
  return mesh;
}

export function disposeObjectTree(root: Object3D) {
  root.traverse((object) => {
    const mesh = object as Mesh;
    mesh.geometry?.dispose?.();
    const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    materials.forEach((entry: Material) => entry.dispose());
  });
}
