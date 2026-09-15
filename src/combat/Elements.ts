// Éléments & réactions (M6) — module PUR : la table est le seul endroit qui
// connaisse les combinaisons. Auras v1 : innées et permanentes (pas de jauge),
// portées par les créatures de givre ; le joueur applique Anemo (coups de
// base), Pyro (lame embrasée aux braseros) ou Électro (boss P3, subie).

export type Element = 'physical' | 'anemo' | 'pyro' | 'cryo' | 'electro';

export type ReactionKind = 'melt' | 'swirl' | 'superconduct' | null;

export interface HitResolution {
  mult: number;
  reaction: ReactionKind;
}

/** Résout un coup `hit` sur une cible d'aura `aura`. */
export function resolveHit(aura: Element | null, hit: Element): HitResolution {
  if (aura === 'cryo') {
    if (hit === 'pyro') return { mult: 2.0, reaction: 'melt' };
    if (hit === 'anemo') return { mult: 1.0, reaction: 'swirl' };
    if (hit === 'electro') return { mult: 1.0, reaction: 'superconduct' };
  }
  return { mult: 1.0, reaction: null };
}

/** Effets secondaires des réactions (appliqués par CombatSystem). */
export const REACTIONS = {
  swirl: { splashMult: 0.5, radius: 3 },        // éclat Anemo : AoE aux voisins
  superconduct: { splashMult: 0.4, radius: 3, physShredMult: 1.4, physShredS: 8 },
  playerFreeze: { rootS: 0.9, cooldownS: 5 },   // coup Cryo reçu : root bref
  infusionS: 30,                                 // « Embraser la lame » au brasero
} as const;
