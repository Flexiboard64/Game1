// File d'événements SIM → RENDU du combat : remplie en fixedUpdate (plusieurs
// pas fixes peuvent s'accumuler dans une frame), lue par N consommateurs en
// update (VfxSystem pour la 3D, Hud pour le DOM), vidée par un système final
// enregistré en DERNIER (symétrie avec input.clearFrame). Jamais utilisée pour
// de la communication sim→sim (appels directs, sinon double-traitement).

export type CombatEvent =
  | { type: 'swing'; combo: number; heading: number }        // départ d'un coup NA (0-2)
  | { type: 'skillCast'; heading: number }                   // départ du E
  | { type: 'burstCast'; x: number; z: number }              // cast du Q (tornade)
  | { type: 'burstTick'; x: number; z: number }              // tick de dégâts de la tornade
  | { type: 'hit'; x: number; y: number; z: number; dirX: number; dirZ: number; dmg: number; crit: boolean; kill: boolean; skill: boolean }
  | { type: 'enemyRoar'; x: number; z: number }
  | { type: 'enemyTelegraph'; x: number; z: number }
  | { type: 'enemyDeath'; x: number; y: number; z: number }
  | { type: 'playerHit'; dmg: number }
  | { type: 'playerDeath' }
  | { type: 'playerRespawn' }
  // ---- M6 Snezhnaya ----
  | { type: 'parried'; x: number; y: number; z: number }           // l'opératif a bloqué
  | { type: 'projectileImpact'; x: number; y: number; z: number }  // éclat de glace au sol/joueur
  | { type: 'reaction'; kind: 'melt' | 'swirl' | 'superconduct'; x: number; y: number; z: number }
  | { type: 'playerFrozen' }
  | { type: 'brazierLit'; x: number; z: number }
  | { type: 'bossPhase'; phase: number }
  | { type: 'shieldBreak'; x: number; y: number; z: number };

export class CombatEvents {
  private readonly queue: CombatEvent[] = [];

  emit(e: CombatEvent): void {
    this.queue.push(e);
  }

  get list(): readonly CombatEvent[] {
    return this.queue;
  }

  clear(): void {
    this.queue.length = 0;
  }
}
