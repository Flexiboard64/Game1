import {
  DataTexture,
  DodecahedronGeometry,
  Group,
  LinearFilter,
  Mesh,
  PlaneGeometry,
  RGBAFormat,
  Texture,
  Vector3,
} from 'three/webgpu';
import { PATH, TERRAIN, WATER } from '../config';
import { ToonMaterials } from '../materials/ToonMaterials';
import type { HeightField } from './HeightField';
import { PolylinePath } from './Path';
import { findWalkablePath } from './PathFinder';

export interface SplatSample {
  grass: number;
  dirt: number;
  rock: number;
}

export class Terrain {
  readonly mesh: Mesh;
  readonly splatTexture: DataTexture;
  readonly questCairn: Group;
  readonly questPosition: Vector3;
  /** Tracé principal spawn → cairn (traverse la rivière au gué). */
  readonly path: PolylinePath;
  /** Fourche : longe la rive ouest puis finit sur le sable nord-ouest du lac. */
  readonly pathFork: PolylinePath;
  private readonly splatData: Uint8Array;
  private readonly splatRes: number;

  constructor(
    readonly heightField: HeightField,
    textures: { grass: Texture; dirt: Texture; rock: Texture } | null,
  ) {
    const { size, resolution } = heightField;

    // ---- Géométrie déplacée depuis la MÊME fonction de hauteur que le contrôleur ----
    const geometry = new PlaneGeometry(size, size, resolution - 1, resolution - 1);
    geometry.rotateX(-Math.PI / 2);
    const pos = geometry.attributes.position!;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      pos.setY(i, heightField.getHeight(x, z));
    }
    geometry.computeVertexNormals();

    // ---- Tracés du chemin (AVANT la splatmap qui les peint) ----
    // A* sur le VRAI terrain : spawn → gué de la rivière → cairn de quête.
    // Les arêtes trop pentues sont interdites et l'eau profonde est pénalisée,
    // donc le tracé contourne les raidillons et traverse aux gués tout seul.
    this.questPosition = heightField.findQuestPeak();
    const legA = findWalkablePath(heightField, { x: 0, z: 0 }, PATH.fordVia);
    const legB = findWalkablePath(heightField, PATH.fordVia, {
      x: this.questPosition.x,
      z: this.questPosition.z,
    });
    if (legA && legB) {
      // Les deux jambes se rejoignent au gué : si la seconde repart par où la
      // première est arrivée, l'aller-retour laisse un éperon en cul-de-sac.
      // L'effondrement ne crée jamais de segment neuf (donc rien à revalider).
      const merged = [...legA, ...legB.slice(1)];
      let i = 1;
      while (i < merged.length - 1) {
        if (i + 1 < merged.length && merged[i - 1]!.distanceToSquared(merged[i + 1]!) < 1e-6) {
          merged.splice(i, 2);
          i = Math.max(1, i - 1);
        } else {
          i++;
        }
      }
      this.path = new PolylinePath(merged);
    } else {
      console.warn('[Terrain] A* du chemin principal en échec — tracé direct de repli');
      this.path = new PolylinePath([
        new Vector3(0, 0, 0),
        new Vector3(PATH.fordVia.x, 0, PATH.fordVia.z),
        new Vector3(this.questPosition.x, 0, this.questPosition.z),
      ]);
    }
    const forkStart = new Vector3();
    const forkTan = new Vector3();
    this.path.sample(PATH.forkT * this.path.length, forkStart, forkTan);
    const forkPts = findWalkablePath(heightField, { x: forkStart.x, z: forkStart.z }, PATH.forkEnd);
    this.pathFork = new PolylinePath(
      forkPts ?? [forkStart.clone(), new Vector3(PATH.forkEnd.x, 0, PATH.forkEnd.z)],
    );

    // ---- Splatmap RGBA : R=herbe, G=terre, B=roche, A=bruit macro (variation de teinte) ----
    // Résolution découplée de la grille de hauteur : un chemin de 3 m reste lisible.
    const res = TERRAIN.splatResolution;
    this.splatRes = res;
    this.splatData = new Uint8Array(res * res * 4);
    const half = size / 2;
    for (let iz = 0; iz < res; iz++) {
      for (let ix = 0; ix < res; ix++) {
        const x = (ix / (res - 1)) * size - half;
        const z = (iz / (res - 1)) * size - half;
        const slope = heightField.getSlopeDeg(x, z);

        // Roche sur les pentes (bande adoucie autour du seuil)
        const rock = smooth01((slope - TERRAIN.rockSlopeDeg) / 14);

        // Sentes organiques : isoligne étroite d'un bruit basse fréquence.
        // Le fBm concentre ses valeurs autour de 0,5 → seuil très serré,
        // sinon le chemin inonde la vallée.
        const pathNoise = heightField.detailNoise.fbm((x / size) * 3.1, (z / size) * 3.1, 2);
        const dirtBand = 1 - smooth01((Math.abs(pathNoise - 0.5) - 0.012) / 0.02);

        // Chemin authoré (SDF de polyligne) + bande de sable le long de l'eau
        const dPath = this.pathDistance(x, z);
        const pathW = 1 - smooth01((dPath - PATH.halfWidth) / PATH.feather);
        const sdf = heightField.getWaterSdf(x, z);
        const sand = 1 - smooth01((sdf - WATER.sandInner) / WATER.sandWidth);

        const dirt = Math.max(dirtBand, pathW, sand) * (1 - rock);
        const grass = Math.max(0, 1 - rock - dirt);
        // Canal A : le sable pousse la teinte macro vers le clair (rive pâle)
        const macroNoise = heightField.detailNoise.fbm((x / size) * 9 + 40, (z / size) * 9 + 40, 2);
        const macro = Math.max(macroNoise, sand * 0.92);

        const o = (iz * res + ix) * 4;
        this.splatData[o] = Math.round(grass * 255);
        this.splatData[o + 1] = Math.round(dirt * 255);
        this.splatData[o + 2] = Math.round(rock * 255);
        this.splatData[o + 3] = Math.round(macro * 255);
      }
    }
    this.splatTexture = new DataTexture(this.splatData, res, res, RGBAFormat);
    this.splatTexture.minFilter = LinearFilter;
    this.splatTexture.magFilter = LinearFilter;
    // PlaneGeometry a l'UV v=1 en -Z après rotation ; on retourne la texture pour aligner
    this.splatTexture.flipY = true;
    this.splatTexture.needsUpdate = true;

    const material = textures
      ? ToonMaterials.terrain(textures.grass, textures.dirt, textures.rock, this.splatTexture)
      : ToonMaterials.terrainDebug(this.splatTexture);
    this.mesh = new Mesh(geometry, material);
    this.mesh.receiveShadow = true;

    // ---- Cairn de quête : 3 pierres empilées sur le point haut d'un anneau autour du spawn ----
    this.questCairn = new Group();
    const stoneSizes = [0.85, 0.6, 0.38];
    let y = this.questPosition.y - 0.15;
    for (let i = 0; i < stoneSizes.length; i++) {
      const s = stoneSizes[i]!;
      const stone = new Mesh(new DodecahedronGeometry(s, 0), ToonMaterials.stone());
      y += s * 0.82;
      stone.position.set(this.questPosition.x, y, this.questPosition.z);
      stone.rotation.set(i * 0.7, i * 1.3, i * 0.4);
      stone.castShadow = true;
      stone.receiveShadow = true;
      this.questCairn.add(stone);
      y += s * 0.45;
    }
  }

  /** Distance XZ au chemin le plus proche (principal ou fourche) — semis et clôture. */
  pathDistance(x: number, z: number): number {
    return Math.min(this.path.distance(x, z), this.pathFork.distance(x, z));
  }

  /**
   * Tamponne un halo de terre/roche dans la splatmap (assise visuelle des rochers).
   * Valide UNIQUEMENT avant engine.compile() : la DataTexture référence le même
   * Uint8Array, la mutation est gratuite avant le premier upload GPU.
   */
  stampSplat(x: number, z: number, r: number, dirtAmt: number, rockAmt: number): void {
    const res = this.splatRes;
    const half = this.heightField.size / 2;
    const toTexel = (v: number): number => ((v + half) / this.heightField.size) * (res - 1);
    const texR = (r / this.heightField.size) * (res - 1);
    const cx = toTexel(x);
    const cz = toTexel(z);
    const i0 = Math.max(Math.floor(cx - texR), 0);
    const i1 = Math.min(Math.ceil(cx + texR), res - 1);
    const j0 = Math.max(Math.floor(cz - texR), 0);
    const j1 = Math.min(Math.ceil(cz + texR), res - 1);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const falloff = 1 - Math.hypot(i - cx, j - cz) / texR;
        if (falloff <= 0) continue;
        const w = smooth01(falloff);
        const o = (j * res + i) * 4;
        const dirt = Math.max(this.splatData[o + 1]! / 255, dirtAmt * w);
        const rock = Math.max(this.splatData[o + 2]! / 255, rockAmt * w);
        // Normalisation conservée : grass = 1 − dirt − rock (sinon le sol change de luminosité)
        const grass = Math.max(0, 1 - dirt - rock);
        this.splatData[o] = Math.round(grass * 255);
        this.splatData[o + 1] = Math.round(dirt * 255);
        this.splatData[o + 2] = Math.round(rock * 255);
      }
    }
    this.splatTexture.needsUpdate = true;
  }

  /** Poids de splat en coordonnées monde — utilisé par le semis d'herbe et la minimap. */
  getSplat(x: number, z: number): SplatSample {
    const half = this.heightField.size / 2;
    const res = this.splatRes;
    const ix = Math.min(Math.max(Math.round(((x + half) / this.heightField.size) * (res - 1)), 0), res - 1);
    const iz = Math.min(Math.max(Math.round(((z + half) / this.heightField.size) * (res - 1)), 0), res - 1);
    const o = (iz * res + ix) * 4;
    return {
      grass: this.splatData[o]! / 255,
      dirt: this.splatData[o + 1]! / 255,
      rock: this.splatData[o + 2]! / 255,
    };
  }
}

function smooth01(t: number): number {
  const c = Math.min(Math.max(t, 0), 1);
  return c * c * (3 - 2 * c);
}
