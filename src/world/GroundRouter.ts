import type { Vector3 } from 'three/webgpu';
import { RAIL } from '../config';
import type { GroundSource, CameraGround } from './GroundSource';
import type { HeightField } from './HeightField';
import type { SnowField } from './SnowField';
import type { TrackSpec } from './TrackSpec';

// Routeur de sol (M5) : carte principale ↔ région neige, par position. Injecté
// au contrôleur ET à la caméra à la place du HeightField nu. L'interstice entre
// les deux terrains est franchissable UNIQUEMENT le long du corridor du tunnel
// (le bore est une vraie tranchée marchable — on peut traverser à pied dans le
// noir, lanternes à l'appui) ; partout ailleurs il reste hors bornes.

export class GroundRouter implements GroundSource, CameraGround {
  private readonly mainHalf: number;

  constructor(
    private readonly main: HeightField,
    private readonly snow: SnowField,
    private readonly track: TrackSpec,
  ) {
    this.mainHalf = main.size / 2;
  }

  /** Dans le corridor du tunnel, au-dessus de l'interstice inter-terrains. */
  private inGapCorridor(x: number, z: number): boolean {
    if (this.inMain(x, z) || this.snow.contains(x, z)) return false;
    return this.track.trackDistance(x, z) < 3.1;
  }

  private inMain(x: number, z: number): boolean {
    return Math.abs(x) <= this.mainHalf && Math.abs(z) <= this.mainHalf;
  }

  getHeight(x: number, z: number): number {
    if (this.inMain(x, z)) return this.main.getHeight(x, z);
    if (this.snow.contains(x, z)) return this.snow.getHeight(x, z);
    // Interstice : plancher du bore au profil du rail (marche dans le tunnel)
    const c = this.track.closest(x, z);
    return c.d < 4 ? this.track.railY(c.s) - 0.12 : RAIL.tunnelY;
  }

  getSlopeDeg(x: number, z: number): number {
    if (this.inMain(x, z)) return this.main.getSlopeDeg(x, z);
    if (this.snow.contains(x, z)) return this.snow.getSlopeDeg(x, z);
    return 0;
  }

  getNormal(x: number, z: number, out: Vector3): Vector3 {
    if (this.inMain(x, z)) return this.main.getNormal(x, z, out);
    if (this.snow.contains(x, z)) return this.snow.getNormal(x, z, out);
    return out.set(0, 1, 0);
  }

  inBounds(x: number, z: number): boolean {
    return this.main.inBounds(x, z) || this.snow.inBounds(x, z) || this.inGapCorridor(x, z);
  }

  getWaterSdf(x: number, z: number): number {
    return this.inMain(x, z) ? this.main.getWaterSdf(x, z) : 1e6; // pas d'eau côté neige
  }

  /** Type de surface (M6) : la glace de Snezhnaya rend le sol glissant. */
  getSurface(x: number, z: number): 'default' | 'ice' {
    if (!this.inMain(x, z) && this.snow.contains(x, z)) return this.snow.getSurface(x, z);
    return 'default';
  }

  levelAt(x: number, z: number): number {
    return this.inMain(x, z) ? this.main.levelAt(x, z) : -1e6; // jamais de clamp
  }
}
