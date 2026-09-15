import type { CharacterController } from '../player/CharacterController';
import type { GroundRouter } from '../world/GroundRouter';
import type { HeightField } from '../world/HeightField';
import type { SnowField } from '../world/SnowField';
import type { Terrain } from '../world/Terrain';
import type { TrackSpec } from '../world/TrackSpec';

// Fonction pure : quel matériau sous les pieds ? Compose les sondes existantes
// dans l'ordre de spécificité (wagon > glace > ville > neige > ballast > eau >
// splat vallée). Aucune nouvelle vérité : uniquement des lectures.

export type Surface = 'wagon' | 'ice' | 'pavement' | 'snow' | 'ballast' | 'water' | 'grass' | 'dirt' | 'rock';

export interface SurfaceDeps {
  player: CharacterController;
  groundRouter: GroundRouter;
  snow: SnowField;
  track: TrackSpec;
  ground: HeightField;
  terrain: Terrain;
}

export function surfaceAt(x: number, z: number, d: SurfaceDeps): Surface {
  if (d.player.aboard) return 'wagon';
  if ((d.groundRouter.getSurface?.(x, z) ?? 'default') === 'ice') return 'ice';
  if (d.snow.contains(x, z)) {
    if (d.snow.inCity(x, z)) return 'pavement';
    if (d.track.trackDistance(x, z) < 2.6) return 'ballast';
    return 'snow';
  }
  if (d.track.trackDistance(x, z) < 2.6) return 'ballast';
  if (d.ground.getWaterSdf(x, z) < 0) return 'water';
  const s = d.terrain.getSplat(x, z);
  if (s.rock >= s.grass && s.rock >= s.dirt) return 'rock';
  if (s.dirt > s.grass) return 'dirt';
  return 'grass';
}
