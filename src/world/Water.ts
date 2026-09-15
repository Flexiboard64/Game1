import { DataTexture, LinearFilter, Mesh, PlaneGeometry, RGBAFormat } from 'three/webgpu';
import { WATER } from '../config';
import { ToonMaterials, type WaterBounds } from '../materials/ToonMaterials';
import type { HeightField } from './HeightField';

// Un plan d'eau = 1 quad à y = level + 1 DataTexture bakée (R = profondeur,
// G = distance à la rive, B = masque d'appartenance au corps d'eau). Deux
// instances sur la carte M3 : étage bas (lac + rivière + marais) et bassin
// amont. Le canal B tue structurellement la « plaque d'eau » qui déborderait
// l'arête de la falaise (la profondeur R y est grande mais le SDF du corps
// est positif — greffe du jugement de composition).

export interface WaterBodyConfig {
  level: number;
  bounds: WaterBounds;
  texResX: number;
  texResZ: number;
  /** SDF PROPRE au corps d'eau (pas le min global). */
  sdf: (x: number, z: number) => number;
}

export class Water {
  readonly mesh: Mesh;

  constructor(ground: HeightField, cfg: WaterBodyConfig) {
    const sizeX = cfg.bounds.maxX - cfg.bounds.minX;
    const sizeZ = cfg.bounds.maxZ - cfg.bounds.minZ;

    const data = new Uint8Array(cfg.texResX * cfg.texResZ * 4);
    for (let iz = 0; iz < cfg.texResZ; iz++) {
      for (let ix = 0; ix < cfg.texResX; ix++) {
        const x = cfg.bounds.minX + (ix / (cfg.texResX - 1)) * sizeX;
        const z = cfg.bounds.minZ + (iz / (cfg.texResZ - 1)) * sizeZ;
        const sdf = cfg.sdf(x, z);
        const gap = cfg.level - ground.getHeight(x, z);
        const depth = Math.min(Math.max(gap / WATER.depthNorm, 0), 1);
        const dist = Math.min(Math.max(-sdf / WATER.distNorm, 0), 1);
        // Appartenance = SDF du corps ET garde de surplomb : le SDF seul laisse
        // le corridor du déversoir peindre une dalle opaque au-dessus du vide,
        // en aval de la lèvre (l'eau réelle ne dépasse jamais maxDepth = 1,35 m)
        const hang = Math.min(Math.max((gap - WATER.hangoverLo) / (WATER.hangoverHi - WATER.hangoverLo), 0), 1);
        const belong = Math.max(Math.min(Math.max((sdf + 2.5) / 5, 0), 1), hang);
        const o = (iz * cfg.texResX + ix) * 4;
        data[o] = Math.round(depth * 255);
        data[o + 1] = Math.round(dist * 255);
        data[o + 2] = Math.round(belong * 255);
        data[o + 3] = 255;
      }
    }
    const tex = new DataTexture(data, cfg.texResX, cfg.texResZ, RGBAFormat);
    tex.minFilter = LinearFilter;
    tex.magFilter = LinearFilter;
    // flipY false : la ligne iz=0 du bake correspond à v=0 — l'UV du matériau
    // est calculé depuis positionWorld avec la même convention
    tex.flipY = false;
    tex.needsUpdate = true;

    const geo = new PlaneGeometry(sizeX, sizeZ, 1, 1);
    geo.rotateX(-Math.PI / 2);
    this.mesh = new Mesh(geo, ToonMaterials.water(tex, cfg.bounds));
    this.mesh.position.set(cfg.bounds.minX + sizeX / 2, cfg.level, cfg.bounds.minZ + sizeZ / 2);
    // frustumCulled false : le bassin amont est hors frustum au moment du
    // compile de warmup (caméra vers +Z au spawn) — sinon ses shaders se
    // compilent en jeu quand le joueur se retourne
    this.mesh.frustumCulled = false;
  }
}

/** Anneau de wading partagé : suit le joueur et le NIVEAU LOCAL (levelAt). */
export class WadingRipple {
  readonly mesh: Mesh;

  constructor(private readonly ground: HeightField) {
    const geo = new PlaneGeometry(WATER.rippleSize, WATER.rippleSize);
    geo.rotateX(-Math.PI / 2);
    this.mesh = new Mesh(geo, ToonMaterials.wadingRing());
    this.mesh.renderOrder = 10; // par-dessus la surface (blend, pas de depthWrite)
    // frustumCulled false : compileAsync frustum-culle aussi — le quad doit être
    // visible du compile de warmup (main le toggle) pour éviter l'à-coup de
    // compilation du shader à la première entrée dans l'eau
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  /** 1 échantillon SDF + 1 levelAt par frame. */
  update(px: number, py: number, pz: number): void {
    const level = this.ground.levelAt(px, pz);
    const wading = py < level - 0.04 && this.ground.getWaterSdf(px, pz) < WATER.rippleSdfMax;
    this.mesh.visible = wading;
    if (wading) {
      this.mesh.position.set(px, level + 0.03, pz);
    }
  }
}
