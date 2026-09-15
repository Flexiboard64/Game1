import { BoxGeometry, Group, InstancedMesh, Matrix4, Mesh, Quaternion, Vector3 } from 'three/webgpu';
import { RAIL, WRECK } from '../config';
import { ToonMaterials } from '../materials/ToonMaterials';
import { loadProp } from '../assets/PropLoader';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import type { ObstacleGrid } from './Obstacles';
import type { SnowField } from './SnowField';

// Toundra du Morne Blizzard (M6) : l'ÉPAVE de train échouée de la réf 2 —
// réutilise le GLB train-loco (0 crédit), couchée et demi-ensevelie près d'une
// voie de garage morte dont les rails s'enfoncent dans les congères.

export function buildWreck(snow: SnowField, obstacles: ObstacleGrid | null, locoGltf: GLTF | null): Group {
  const group = new Group();

  // ---- Voie de garage : rails + traverses demi-ensevelis (droite, courte) ----
  const a = WRECK.sidingA;
  const b = WRECK.sidingB;
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  const ux = (b.x - a.x) / len;
  const uz = (b.z - a.z) / len;
  const yaw = Math.atan2(ux, uz);
  const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw);
  const nRail = Math.floor(len);
  const rails = new InstancedMesh(new BoxGeometry(RAIL.railW, RAIL.railH, 1.06), ToonMaterials.railSteel(), nRail * 2);
  const sleepers = new InstancedMesh(
    new BoxGeometry(RAIL.sleeper.w, RAIL.sleeper.h, RAIL.sleeper.d),
    ToonMaterials.railWood(),
    Math.floor(len / RAIL.sleeperEvery),
  );
  let ri = 0;
  for (let i = 0; i < nRail; i++) {
    const t = (i + 0.5);
    const x = a.x + ux * t;
    const z = a.z + uz * t;
    // Demi-enseveli : plus la voie avance vers l'épave, plus elle s'enfonce
    const sink = 0.06 + (t / len) * 0.22;
    const y = snow.getHeight(x, z) - sink;
    for (const side of [-1, 1]) {
      _v.set(x - uz * side * (RAIL.gauge / 2), y + RAIL.railH / 2, z + ux * side * (RAIL.gauge / 2));
      _m.compose(_v, q, _one);
      rails.setMatrixAt(ri++, _m);
    }
  }
  for (let i = 0; i < sleepers.count; i++) {
    const t = (i + 0.5) * RAIL.sleeperEvery;
    const x = a.x + ux * t;
    const z = a.z + uz * t;
    _v.set(x, snow.getHeight(x, z) - 0.1 - (t / len) * 0.2, z);
    _m.compose(_v, q, _one);
    sleepers.setMatrixAt(i, _m);
  }
  rails.count = ri;
  for (const mesh of [rails, sleepers]) {
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.name = 'wreck-siding';
    group.add(mesh);
  }

  // ---- L'épave elle-même : loco couchée, enfoncée, givrée ----
  if (locoGltf) {
    const prop = loadProp(locoGltf, { targetHeight: 4.1 });
    if (prop) {
      // Axe long le long de Z (comme TrainSystem.buildCar)
      prop.geometry.computeBoundingBox();
      const size = prop.geometry.boundingBox!.getSize(_v);
      if (size.x > size.z) prop.geometry.rotateY(Math.PI / 2);
      const mesh = new Mesh(prop.geometry, ToonMaterials.snowProp(prop.material.map ?? null));
      const y = snow.getHeight(WRECK.x, WRECK.z);
      mesh.position.set(WRECK.x, y - prop.height * WRECK.sinkFrac + prop.height * 0.28, WRECK.z);
      mesh.rotation.set(0, WRECK.yaw, WRECK.roll);
      mesh.castShadow = true;
      mesh.receiveShadow = false;
      mesh.name = 'wreck-loco';
      group.add(mesh);
      obstacles?.add({ x: WRECK.x, z: WRECK.z, r: 3.4 });
    }
  }

  group.traverse((o) => {
    o.frustumCulled = false;
  });
  return group;
}

const _m = new Matrix4();
const _v = new Vector3();
const _one = new Vector3(1, 1, 1);
