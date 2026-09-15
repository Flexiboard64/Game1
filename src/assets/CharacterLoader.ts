import {
  AnimationAction,
  AnimationClip,
  AnimationMixer,
  Box3,
  Group,
  Material,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  SkinnedMesh,
  Texture,
  Vector3,
  VectorKeyframeTrack,
} from 'three/webgpu';
import { CHARACTER } from '../config';
import { ToonMaterials } from '../materials/ToonMaterials';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';

export type ClipName =
  | 'idle' | 'walk' | 'run' | 'sprint' | 'jump' | 'glide'
  | 'climb' | 'climbGrab'
  | 'attack1' | 'attack2' | 'attack3' | 'skill' | 'burst';

/** Clips du golem sylvestre (M4) — même chaîne de fusion, autre union. */
export type GolemClipName = 'idle' | 'walk' | 'roar' | 'attack' | 'hit' | 'death';
export type VolkodlakClipName = 'idle' | 'walk' | 'run' | 'howl' | 'attack' | 'hit' | 'death';
export type OperativeClipName = 'idle' | 'walk' | 'attack' | 'parry' | 'hit' | 'death';
export type BossClipName = 'idle' | 'walk' | 'attack' | 'roar' | 'death';

export interface AssembleOptions {
  /** Hauteur monde cible (défaut : CHARACTER.heightMeters — l'héroïne). */
  targetHeight?: number;
  /** Fabrique de matériau par mesh (défaut : ToonMaterials.character). */
  makeMaterial?: (albedo: Texture | null) => Material;
}

export interface AssembledCharacter<K extends string = ClipName> {
  /** Wrapper : ne jamais transformer la hiérarchie skinnée directement. */
  root: Group;
  /** Scène skinnée interne (échelle appliquée) — SkeletonUtils.clone pour N instances. */
  skinnedScene: Object3D;
  /** Échelle appliquée au GLB (compensation des attaches : épée dans la main). */
  sceneScale: number;
  /** Première texture albédo trouvée (matériaux par clone d'ennemi). */
  albedo: Texture | null;
  mixer: AnimationMixer;
  actions: Partial<Record<K, AnimationAction>>;
  /** Clips ASSAINIS — partageables entre mixers (mixer.clipAction par clone). */
  clips: Partial<Record<K, AnimationClip>>;
}

// Assemble un modèle riggé Meshy + les clips GLB séparés (même squelette auto-rig) :
// 1. collecte des noms de nœuds du rig ; 2. filtrage des tracks de chaque clip
// (log bruyant si ça droppe — canari d'un squelette divergent) ; 3. suppression du
// root motion XZ ; 4. remplacement des matériaux par le toon + coque de contour.
// Générique depuis M4 : l'héroïne ET le golem passent par la même chaîne.
// MUTATION EN PLACE, non ré-entrante : un appel par GLTF source (les instances
// d'ennemis viennent de SkeletonUtils.clone sur skinnedScene, jamais d'un 2e appel).

export function assembleCharacter<K extends string = ClipName>(
  rigged: GLTF,
  clipSources: Partial<Record<K, GLTF | null>>,
  opts: AssembleOptions = {},
): AssembledCharacter<K> {
  const scene = rigged.scene;
  const targetHeight = opts.targetHeight ?? CHARACTER.heightMeters;

  // ---- Noms de nœuds du rig ----
  const nodeNames = new Set<string>();
  scene.traverse((o: Object3D) => nodeNames.add(o.name));

  // ---- Échelle AVANT les coques de contour : l'inflation du contour se fait en
  // espace local du GLB source, l'épaisseur monde vaut width × scale — on
  // compense pour rester à ~1,2 cm quel que soit le système d'unités exporté ----
  const bbox = new Box3().setFromObject(scene);
  const size = bbox.getSize(new Vector3());
  const scale = size.y > 0.01 ? targetHeight / size.y : 1;
  const outlineWidth = 0.012 / scale;

  // ---- Matériaux toon + ombres + contours ----
  let albedo: Texture | null = null;
  const outlines: SkinnedMesh[] = [];
  scene.traverse((o: Object3D) => {
    if ((o as Mesh).isMesh) {
      const mesh = o as Mesh;
      mesh.castShadow = true;
      const mat = mesh.material as MeshStandardMaterial;
      const map: Texture | null = mat.map ?? null;
      if (map && !albedo) albedo = map;
      mesh.material = opts.makeMaterial
        ? opts.makeMaterial(map)
        : map ? ToonMaterials.character(map) : ToonMaterials.placeholder();

      if ((mesh as SkinnedMesh).isSkinnedMesh) {
        const src = mesh as SkinnedMesh;
        const hull = new SkinnedMesh(src.geometry, ToonMaterials.outline(outlineWidth));
        hull.bind(src.skeleton, src.bindMatrix);
        hull.bindMode = src.bindMode;
        hull.userData.isOutline = true; // repéré par les clones (matériau dédié)
        outlines.push(hull);
      }
    }
  });
  // Les coques rejoignent la scène après le traverse (éviter de modifier pendant l'itération)
  for (const hull of outlines) scene.add(hull);

  const root = new Group();
  root.add(scene);
  scene.scale.setScalar(scale);
  // Pieds à y=0 du wrapper
  scene.position.y = -bbox.min.y * scale;

  // ---- Clips ----
  const mixer = new AnimationMixer(scene);
  const actions: Partial<Record<K, AnimationAction>> = {};
  const clips: Partial<Record<K, AnimationClip>> = {};
  for (const [name, gltf] of Object.entries(clipSources) as [K, GLTF | null][]) {
    if (!gltf || gltf.animations.length === 0) continue;
    const clip = sanitizeClip(gltf.animations[0]!, nodeNames, name);
    if (clip.tracks.length === 0) {
      console.warn(`[CharacterLoader] clip « ${name} » : aucune track compatible, ignoré`);
      continue;
    }
    clips[name] = clip;
    actions[name] = mixer.clipAction(clip);
  }

  return { root, skinnedScene: scene, sceneScale: scale, albedo, mixer, actions, clips };
}

function sanitizeClip(source: AnimationClip, nodeNames: Set<string>, newName: string): AnimationClip {
  const kept = [];
  const dropped: string[] = [];
  for (const track of source.tracks) {
    const nodeName = track.name.split('.')[0]!;
    if (!nodeNames.has(nodeName)) {
      dropped.push(track.name);
      continue;
    }
    kept.push(stripRootMotion(track));
  }
  if (dropped.length > 0) {
    const ratio = dropped.length / source.tracks.length;
    console.warn(
      `[CharacterLoader] clip « ${newName} » : ${dropped.length}/${source.tracks.length} tracks droppées` +
      (ratio > 0.2 ? ' — SQUELETTE DIVERGENT, retarget nécessaire' : ''),
      dropped.slice(0, 6),
    );
  }
  return new AnimationClip(newName, source.duration, kept);
}

/**
 * Supprime le déplacement XZ des tracks .position (le contrôleur possède le
 * mouvement monde ; on garde Y pour l'écrasement du saut).
 */
function stripRootMotion(track: AnimationClip['tracks'][number]): AnimationClip['tracks'][number] {
  if (!(track instanceof VectorKeyframeTrack) || !track.name.endsWith('.position')) return track;
  const values = track.values.slice();
  const x0 = values[0] ?? 0;
  const z0 = values[2] ?? 0;
  for (let i = 0; i < values.length; i += 3) {
    values[i] = x0;
    values[i + 2] = z0;
  }
  return new VectorKeyframeTrack(track.name, Array.from(track.times), Array.from(values));
}
