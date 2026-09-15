import { Group, InstancedMesh, Matrix4, Quaternion, Vector3 } from 'three/webgpu';
import { CASCADE, MOUNTAIN, RAIL, RIM_PROPS } from '../config';
import type { LoadedProp } from '../assets/PropLoader';
import type { HeightField } from './HeightField';
import type { ObstacleGrid } from './Obstacles';

// Habillage de la lèvre de vallée : rochers géants + arbres agrandis posés en
// anneau CARRÉ sur les crêtes, face vers l'intérieur. Le fog (70→320 m) fait
// tout le travail de fondu — silhouettes de falaises à la Genshin, 0 crédit.

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class RimDressing {
  readonly group = new Group();

  constructor(
    ground: HeightField,
    boulder: LoadedProp | null,
    tree: LoadedProp | null,
    obstacles: ObstacleGrid | null = null,
    private readonly trackDistance: ((x: number, z: number) => number) | null = null,
  ) {
    const rand = mulberry32(RIM_PROPS.seed);

    if (boulder) {
      this.group.add(this.buildRing(ground, boulder, rand, obstacles, {
        count: RIM_PROPS.boulderCount,
        ringMin: RIM_PROPS.ringMin,
        ringMax: RIM_PROPS.ringMax,
        scaleMin: RIM_PROPS.boulderScaleMin,
        scaleMax: RIM_PROPS.boulderScaleMax,
        sinkFrac: RIM_PROPS.sinkFrac,
        yStretch: true,
        slopeMax: 90,
        collisionR: RIM_PROPS.boulderCollisionR,
      }));
    }
    if (tree) {
      this.group.add(this.buildRing(ground, tree, rand, obstacles, {
        count: RIM_PROPS.treeCount,
        ringMin: RIM_PROPS.treeRingMin,
        ringMax: RIM_PROPS.treeRingMax,
        scaleMin: RIM_PROPS.treeScaleMin,
        scaleMax: RIM_PROPS.treeScaleMax,
        sinkFrac: RIM_PROPS.treeSinkFrac,
        yStretch: false,
        slopeMax: RIM_PROPS.maxSlopeDeg,
        collisionR: RIM_PROPS.treeCollisionR,
      }));
    }
  }

  private buildRing(
    ground: HeightField,
    prop: LoadedProp,
    rand: () => number,
    obstacles: ObstacleGrid | null,
    opts: {
      count: number;
      ringMin: number;
      ringMax: number;
      scaleMin: number;
      scaleMax: number;
      sinkFrac: number; // fraction de la hauteur de l'instance enterrée
      yStretch: boolean;
      slopeMax: number;
      collisionR: number;
    },
  ): InstancedMesh {
    const placements: { x: number; y: number; z: number; yaw: number; s: number; ys: number }[] = [];
    for (let i = 0; i < opts.count; i++) {
      const theta = (i / opts.count) * Math.PI * 2 + (rand() - 0.5) * 0.6;
      // Projection sur l'anneau CARRÉ (la vallée est carrée)
      const denom = Math.max(Math.abs(Math.cos(theta)), Math.abs(Math.sin(theta)));
      const r = (opts.ringMin + rand() * (opts.ringMax - opts.ringMin)) / denom;
      const x = Math.min(Math.max(Math.cos(theta) * r, -127), 127);
      const z = Math.min(Math.max(Math.sin(theta) * r, -127), 127);
      if (ground.getSlopeDeg(x, z) > opts.slopeMax) continue;
      // Jamais sur la lèvre de la cascade : un rocher géant y barrerait la chute
      if (Math.hypot(x - CASCADE.top.x, z - CASCADE.top.z) < RIM_PROPS.cascadeClear) continue;
      // Jamais sur la montagne (M4) : un bloc échelle 4-8 ou un arbre géant sur
      // une vire ou le plateau sommital écraserait la silhouette et la grimpe
      if (Math.hypot(x - MOUNTAIN.cx, z - MOUNTAIN.cz) < MOUNTAIN.radius + MOUNTAIN.rimPropClear) continue;
      // Jamais sur la voie ferrée ni son portail (M5)
      if (this.trackDistance && this.trackDistance(x, z) < RAIL.clearRim) continue;
      const s = opts.scaleMin + rand() * (opts.scaleMax - opts.scaleMin);
      const ys = opts.yStretch ? 1 + rand() * 0.35 : 1; // verticalité de falaise
      // La crête est atteignable à pied : cercle à l'échelle TIRÉE (l'échelle
      // moyenne laissait un mur 2 m plus étroit que la silhouette des gros blocs)
      obstacles?.add({ x, z, r: opts.collisionR * s });
      placements.push({
        x,
        y: ground.getHeight(x, z) - prop.height * s * ys * opts.sinkFrac,
        z,
        yaw: Math.atan2(-x, -z) + (rand() - 0.5) * 0.7, // face vers l'intérieur
        s,
        ys,
      });
    }

    const mesh = new InstancedMesh(prop.geometry, prop.material, Math.max(placements.length, 1));
    const m = new Matrix4();
    const q = new Quaternion();
    const up = new Vector3(0, 1, 0);
    const scale = new Vector3();
    for (let i = 0; i < placements.length; i++) {
      const p = placements[i]!;
      q.setFromAxisAngle(up, p.yaw);
      scale.set(p.s, p.s * p.ys, p.s);
      m.compose(_pos.set(p.x, p.y, p.z), q, scale);
      mesh.setMatrixAt(i, m);
    }
    mesh.count = placements.length;
    // L'anneau couvre toute la carte : une bounding sphere ne cullerait jamais
    mesh.frustumCulled = false;
    mesh.castShadow = false; // hors du frustum d'ombre (±45 m joueur) de toute façon
    mesh.receiveShadow = false;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.name = 'rim-dressing';
    return mesh;
  }
}

const _pos = new Vector3();
