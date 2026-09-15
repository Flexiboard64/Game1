import type { Vector3 } from 'three/webgpu';

// Abstractions de sol : le contrôleur et la caméra ne consomment qu'une poignée
// de membres du HeightField — les typer permet de leur injecter d'autres sols
// (plancher du wagon de train, terrain de la région neige, routeur composite).

/** Sol minimal consommé par CharacterController. */
export interface GroundSource {
  getHeight(x: number, z: number): number;
  getSlopeDeg(x: number, z: number): number;
  getNormal(x: number, z: number, out: Vector3): Vector3;
  /** Vrai si (x,z) est une position de marche autorisée (bornes monde/wagon). */
  inBounds(x: number, z: number): boolean;
  /** Type de surface (M6) : glissance de la glace. Absent = 'default'. */
  getSurface?(x: number, z: number): 'default' | 'ice';
}

/** Sol consommé par le COMBAT (M6) : ennemis, VFX, respawn — découple du
 *  HeightField concret pour que les créatures vivent aussi en Snezhnaya. */
export interface CombatGround extends GroundSource {
  getWaterSdf(x: number, z: number): number;
}

/** Sol vu par ThirdPersonCamera (clairance de perche + clamps plancher/eau). */
export interface CameraGround {
  getHeight(x: number, z: number): number;
  getWaterSdf(x: number, z: number): number;
  levelAt(x: number, z: number): number;
}
