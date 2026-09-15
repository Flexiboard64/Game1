import type { Vector3 } from 'three/webgpu';
import type { GroundSource } from '../world/GroundSource';
import type { ObstacleGrid } from '../world/Obstacles';

// Référentiel mobile du joueur (M5) : pendant le trajet en train, le contrôleur
// simule en ESPACE LOCAL du wagon (sol plat y=0, bornes = rectangle intérieur,
// obstacles = banquettes) et le rendu compose position locale × pose du wagon.
// Repère volontairement yaw + translation SEULEMENT (pas de pitch/roll de
// caisse : un frame incliné ferait flotter les pieds aux extrémités).

export interface PlayerFrame {
  /** Sol local (plat, borné à l'intérieur du wagon). */
  readonly ground: GroundSource;
  /** Obstacles locaux (banquettes). */
  readonly obstacles: ObstacleGrid | null;
  /** Yaw sim 60 Hz courant du wagon (radians, convention heading 0 = +Z). */
  yaw(): number;
  /** Origine monde sim 60 Hz du repère local (niveau du plancher). */
  origin(out: Vector3): Vector3;
  /** Yaw interpolé pour le rendu (même alpha que le joueur — zéro nage). */
  renderYaw(alpha: number): number;
  /** Origine monde interpolée pour le rendu. */
  renderOrigin(alpha: number, out: Vector3): Vector3;
  /** Plafond local (m au-dessus du plancher) — clamp du saut. */
  readonly ceilingY: number;
  /** La grimpe n'a aucun sens sur les parois du wagon. */
  readonly allowClimb: boolean;
}
