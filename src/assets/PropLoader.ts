import {
  BufferGeometry,
  Mesh,
  MeshStandardMaterial,
  MeshToonNodeMaterial,
  Object3D,
  Texture,
  Vector3,
} from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { ToonMaterials } from '../materials/ToonMaterials';

// Convertit un GLB Meshy statique en (géométrie fusionnée + matériau toon) prêt
// pour l'instanciation : matrices cuites, pieds à y=0, centré XZ, échelle CUITE
// dans la géométrie (les matrices d'instance restent pures pose/rotation/échelle).

export interface LoadedProp {
  geometry: BufferGeometry;
  material: MeshToonNodeMaterial;
  /** = targetHeight (hauteur monde de la géométrie normalisée). */
  height: number;
  /** Demi-empreinte XZ (bounding spheres de chunk, rayons de collision). */
  radiusXZ: number;
  /** Largeur X monde (pas de pose de la clôture). */
  lengthX: number;
}

export function loadProp(gltf: GLTF, opts: { targetHeight: number; sway?: boolean }): LoadedProp | null {
  const geoms: BufferGeometry[] = [];
  let albedo: Texture | null = null;
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o: Object3D) => {
    if (!(o as Mesh).isMesh) return;
    const mesh = o as Mesh;
    const g = mesh.geometry.clone();
    g.applyMatrix4(mesh.matrixWorld);
    // Attributs homogènes pour la fusion (les tangentes Meshy divergent parfois)
    for (const name of Object.keys(g.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
    }
    geoms.push(g);
    const mat = mesh.material as MeshStandardMaterial;
    if (mat.map) {
      if (!albedo) albedo = mat.map;
      else if (albedo !== mat.map) {
        // La fusion ne garde qu'UN albédo : un GLB multi-matériaux perdrait les autres
        console.warn('[PropLoader] GLB multi-albédo : seule la première texture est conservée');
      }
    }
  });
  if (geoms.length === 0) return null;
  const merged = geoms.length === 1 ? geoms[0]! : mergeGeometries(geoms, false);
  if (!merged) return null;

  merged.computeBoundingBox();
  const bbox = merged.boundingBox!;
  const size = bbox.getSize(new Vector3());
  const center = bbox.getCenter(new Vector3());
  const scale = size.y > 0.001 ? opts.targetHeight / size.y : 1;
  merged.translate(-center.x, -bbox.min.y, -center.z);
  merged.scale(scale, scale, scale);
  merged.computeBoundingSphere();

  const material = opts.sway
    ? ToonMaterials.foliage(albedo, opts.targetHeight)
    : ToonMaterials.prop(albedo);
  return {
    geometry: merged,
    material,
    height: opts.targetHeight,
    radiusXZ: Math.max(size.x, size.z) * 0.5 * scale,
    lengthX: size.x * scale,
  };
}
