import { AUDIO } from '../config';
import type { AudioEngine } from './AudioEngine';
import { chirpPing, crackleBuffer, fmTone, noiseBurst, sharedNoise, tone } from './dsp';
import type { SamplePlayer } from './SamplePlayer';
import type { Surface } from './SurfaceSampler';

// Recettes sonores : ÉCHANTILLON Magnific d'abord (M8.1 — pools SamplePlayer,
// retour utilisateur « pas réaliste »), recette procédurale en REPLI intégral
// (assets absents/en chargement → le jeu sonne quand même, drive.mjs vert).
// Randomisation ±8 % pitch/gain systématique. Tout sur l'horloge audio (e.now).

const rnd = (spread = 0.08): number => 1 + (Math.random() * 2 - 1) * spread;

export class Sfx {
  /** Nom du dernier SFX joué (sonde ?audiodiag / tests headless). */
  lastPlayed = '';

  constructor(
    private readonly e: AudioEngine,
    private readonly samples: SamplePlayer | null = null,
  ) {}

  /** Échantillon si pool présent, sinon false → recette procédurale. */
  private sample(family: string, opts?: Parameters<SamplePlayer['play']>[1]): boolean {
    return this.samples?.play(family, opts) ?? false;
  }

  private mark(name: string): boolean {
    if (!this.e.unlocked) return false;
    this.lastPlayed = name;
    return true;
  }

  // ---- Locomotion ----

  footstep(surface: Surface, gain = 1): void {
    if (!this.mark(`step-${surface}`)) return;
    const e = this.e;
    // Discret et RÉGULIER (retour utilisateur) : volume global ×0,5, jitter réduit
    const g = gain * AUDIO.steps.gain * rnd(0.05);
    // Échantillons foley par surface (glace = pierre pitchée + ping conservé)
    const fam: Partial<Record<Surface, [string, number, number]>> = {
      snow: ['steps-snow', 1, 0.9], grass: ['steps-grass', 1, 0.9], dirt: ['steps-grass', 0.94, 0.9],
      pavement: ['steps-stone', 1, 0.85], rock: ['steps-stone', 0.96, 0.85], ballast: ['steps-stone', 1.06, 0.8],
      wagon: ['steps-wood', 1, 0.9], ice: ['steps-stone', 1.28, 0.55],
    };
    const f = fam[surface];
    if (f && this.sample(f[0], { rate: f[1], gain: f[2] * g })) {
      if (surface === 'ice') chirpPing(e, 'sfx', { freqs: [1800 * rnd()], dur: 0.09, peak: 0.05 * g });
      return;
    }
    switch (surface) {
      case 'grass':
      case 'dirt':
        noiseBurst(e, 'sfx', { dur: 0.07, type: 'bandpass', freq: 450 * rnd(), freqEnd: 340, q: 1, env: { a: 0.004, d: 0.07, peak: 0.22 * g } });
        break;
      case 'snow': // deux micro-impacts décalés : crissement
        noiseBurst(e, 'sfx', { dur: 0.05, type: 'lowpass', freq: 1200 * rnd(), env: { a: 0.004, d: 0.05, peak: 0.2 * g } });
        noiseBurst(e, 'sfx', { dur: 0.06, type: 'lowpass', freq: 900 * rnd(), env: { a: 0.004, d: 0.06, peak: 0.14 * g } }, e.now + 0.03);
        break;
      case 'ice':
        noiseBurst(e, 'sfx', { dur: 0.04, type: 'highpass', freq: 2000, env: { a: 0.003, d: 0.04, peak: 0.13 * g } });
        chirpPing(e, 'sfx', { freqs: [1800 * rnd()], dur: 0.09, peak: 0.05 * g });
        break;
      case 'pavement':
      case 'rock':
      case 'ballast':
        noiseBurst(e, 'sfx', { dur: 0.05, type: 'bandpass', freq: 1300 * rnd(), q: 2, env: { a: 0.003, d: 0.05, peak: 0.2 * g } });
        noiseBurst(e, 'sfx', { dur: 0.008, type: 'highpass', freq: 4000, env: { a: 0.003, d: 0.008, peak: 0.1 * g } });
        break;
      case 'wagon': // thunk boisé
        noiseBurst(e, 'sfx', { dur: 0.09, type: 'lowpass', freq: 500, env: { a: 0.004, d: 0.09, peak: 0.2 * g } });
        tone(e, 'sfx', { wave: 'sine', freq: 130 * rnd(), dur: 0.06, env: { a: 0.004, d: 0.06, peak: 0.12 * g } });
        break;
      case 'water': // clapot
        noiseBurst(e, 'sfx', { dur: 0.12, type: 'bandpass', freq: 900, freqEnd: 2000, q: 1.2, env: { a: 0.006, d: 0.12, peak: 0.22 * g } });
        tone(e, 'sfx', { wave: 'sine', freq: 600 * rnd(), freqEnd: 1400, dur: 0.05, env: { a: 0.004, d: 0.05, peak: 0.06 * g } });
        break;
    }
  }

  jump(): void {
    if (!this.mark('jump')) return;
    if (this.sample('swing', { rate: 0.72, gain: 0.4 })) return; // whoosh d'air grave
    noiseBurst(this.e, 'sfx', { dur: 0.15, type: 'bandpass', freq: 300, freqEnd: 1200 * rnd(), q: 1.4, env: { a: 0.01, d: 0.15, peak: 0.16 } });
  }

  /** k = intensité 0..1 (|vy| normalisée soft→hard). */
  land(k: number, surface: Surface): void {
    if (!this.mark('land')) return;
    const e = this.e;
    if (this.sample('land', { gain: 0.35 + 0.65 * k, rate: 1.05 - 0.15 * k })) {
      if (k > 0.6) tone(e, 'sfx', { wave: 'sine', freq: 60, dur: 0.12, env: { a: 0.005, d: 0.12, peak: 0.3 * k } });
      return;
    }
    noiseBurst(e, 'sfx', { dur: 0.1 + 0.08 * k, type: 'lowpass', freq: 400 + 600 * k, env: { a: 0.004, d: 0.1 + 0.08 * k, peak: (0.15 + 0.5 * k) * rnd() } });
    if (k > 0.6) tone(e, 'sfx', { wave: 'sine', freq: 60, dur: 0.12, env: { a: 0.005, d: 0.12, peak: 0.3 * k } });
    this.footstep(surface, 0.5 + 0.5 * k);
  }

  climbGrab(): void {
    if (!this.mark('climb')) return;
    noiseBurst(this.e, 'sfx', { dur: 0.06, type: 'lowpass', freq: 700 * rnd(0.2), env: { a: 0.004, d: 0.06, peak: 0.14 } });
  }

  gliderOpen(): void {
    if (!this.mark('glider-open')) return;
    noiseBurst(this.e, 'sfx', { dur: 0.08, type: 'bandpass', freq: 1000, q: 1.2, env: { a: 0.003, d: 0.08, peak: 0.3 } });
    noiseBurst(this.e, 'sfx', { dur: 0.3, type: 'lowpass', freq: 900, freqEnd: 400, env: { a: 0.02, d: 0.3, peak: 0.12 } });
  }

  // ---- Combat joueur ----

  swing(combo: number): void {
    if (!this.mark(`swing-${combo}`)) return;
    const pitch = [1, 1.12, 1.25][combo] ?? 1;
    if (this.sample('swing', { rate: pitch, gain: 0.85 })) return;
    noiseBurst(this.e, 'sfx', { dur: 0.12, type: 'bandpass', freq: 600 * pitch, freqEnd: 2500 * pitch, q: 1.6, env: { a: 0.008, d: 0.12, peak: 0.24 * rnd() } });
  }

  hit(crit: boolean): void {
    if (!this.mark(crit ? 'crit' : 'hit')) return;
    const e = this.e;
    if (this.sample('impact', { gain: crit ? 1 : 0.75, rate: crit ? 0.95 : 1.05 })) {
      if (crit) chirpPing(e, 'sfx', { freqs: [2400, 3600], dur: 0.2, peak: 0.12 });
      return;
    }
    fmTone(e, 'sfx', { carrier: 200 * rnd(), ratio: 3.7, index: 80, dur: 0.06, env: { a: 0.003, d: 0.06, peak: crit ? 0.42 : 0.28 } });
    noiseBurst(e, 'sfx', { dur: 0.03, type: 'highpass', freq: 3000, env: { a: 0.003, d: 0.03, peak: 0.18 } });
    if (crit) chirpPing(e, 'sfx', { freqs: [2400, 3600], dur: 0.2, peak: 0.12 });
  }

  skillCast(): void {
    if (!this.mark('skill')) return;
    const e = this.e;
    if (this.sample('spell', { rate: 1.15, gain: 0.85 })) return;
    // Bourrasque anemo : deux couches de bruit + accord en quinte détuné
    noiseBurst(e, 'sfx', { dur: 0.6, type: 'bandpass', freq: 500, freqEnd: 1800, q: 1.1, env: { a: 0.03, d: 0.6, peak: 0.22 } });
    noiseBurst(e, 'sfx', { dur: 0.5, type: 'bandpass', freq: 900, freqEnd: 2600, q: 2, env: { a: 0.06, d: 0.5, peak: 0.12 } }, e.now + 0.08);
    tone(e, 'sfx', { wave: 'triangle', freq: 392, dur: 0.5, env: { a: 0.04, d: 0.5, peak: 0.06 }, detuneCents: -8 });
    tone(e, 'sfx', { wave: 'triangle', freq: 587, dur: 0.5, env: { a: 0.05, d: 0.5, peak: 0.05 }, detuneCents: 8 });
  }

  burstCast(): void {
    if (!this.mark('burst')) return;
    const e = this.e;
    if (this.sample('spell', { rate: 0.72, gain: 1 })) {
      // Le boom FM grave reste : assise physique sous la couche magique
      fmTone(e, 'sfx', { carrier: 80, ratio: 2, index: 120, dur: 0.7, env: { a: 0.02, d: 0.7, peak: 0.22 } });
      return;
    }
    noiseBurst(e, 'sfx', { dur: 0.5, type: 'bandpass', freq: 200, freqEnd: 4000, q: 1.2, env: { a: 0.05, d: 0.5, peak: 0.3 } });
    fmTone(e, 'sfx', { carrier: 80, ratio: 2, index: 120, dur: 0.7, env: { a: 0.02, d: 0.7, peak: 0.3 } });
    tone(e, 'sfx', { wave: 'sine', freq: 55, freqEnd: 80, dur: 0.6, env: { a: 0.02, d: 0.6, peak: 0.25 } });
  }

  burstTick(): void {
    if (!this.mark('burst-tick')) return;
    noiseBurst(this.e, 'sfx', { dur: 0.15, type: 'bandpass', freq: 700 * rnd(0.2), freqEnd: 1600, q: 1.3, env: { a: 0.01, d: 0.15, peak: 0.1 } });
  }

  reaction(kind: 'melt' | 'swirl' | 'superconduct'): void {
    if (!this.mark(`reaction-${kind}`)) return;
    const e = this.e;
    if (kind === 'melt') {
      tone(e, 'sfx', { wave: 'sine', freq: 90, freqEnd: 50, dur: 0.3, env: { a: 0.01, d: 0.3, peak: 0.3 } });
      noiseBurst(e, 'sfx', { dur: 0.25, type: 'highpass', freq: 4000, env: { a: 0.01, d: 0.25, peak: 0.14 } });
    } else if (kind === 'swirl') {
      noiseBurst(e, 'sfx', { dur: 0.45, type: 'bandpass', freq: 800, freqEnd: 2400, q: 2.4, env: { a: 0.04, d: 0.45, peak: 0.2 } });
      chirpPing(e, 'sfx', { freqs: [1320, 1980], dur: 0.3, peak: 0.06 });
    } else {
      fmTone(e, 'sfx', { carrier: 320 * rnd(0.15), ratio: 7.3, index: 260, dur: 0.18, env: { a: 0.003, d: 0.18, peak: 0.26 } });
      chirpPing(e, 'sfx', { freqs: [2600, 4100, 5200], dur: 0.22, peak: 0.1 });
    }
  }

  projectileImpact(pan: number, gain: number): void {
    if (!this.mark('proj-impact')) return;
    chirpPing(this.e, 'sfx', { freqs: [2100, 3300, 4700], dur: 0.15, peak: 0.2 * gain, pan });
    noiseBurst(this.e, 'sfx', { dur: 0.03, type: 'highpass', freq: 3000, env: { a: 0.003, d: 0.03, peak: 0.12 * gain }, pan });
  }

  parried(pan: number): void {
    if (!this.mark('parried')) return;
    fmTone(this.e, 'sfx', { carrier: 800, ratio: 2.4, index: 60, dur: 0.3, env: { a: 0.003, d: 0.3, peak: 0.3 }, pan });
  }

  playerHit(): void {
    if (!this.mark('player-hit')) return;
    noiseBurst(this.e, 'sfx', { dur: 0.08, type: 'lowpass', freq: 800, env: { a: 0.003, d: 0.08, peak: 0.3 } });
    tone(this.e, 'sfx', { wave: 'sine', freq: 140, freqEnd: 80, dur: 0.12, env: { a: 0.004, d: 0.12, peak: 0.2 } });
  }

  playerFrozen(): void {
    if (!this.mark('frozen')) return;
    tone(this.e, 'sfx', { wave: 'sine', freq: 800, freqEnd: 200, dur: 0.4, env: { a: 0.01, d: 0.4, peak: 0.2 } });
    chirpPing(this.e, 'sfx', { freqs: [2800, 3900, 5100], dur: 0.5, peak: 0.14 });
  }

  coldTick(): void {
    if (!this.mark('cold-tick')) return;
    chirpPing(this.e, 'sfx', { freqs: [3000 * rnd(0.05)], dur: 0.12, peak: 0.07 });
    // Jauge pleine = le froid MORD : impact sourd sous le tick cristallin
    this.sample('impact', { rate: 0.55, gain: 0.22 });
  }

  playerDeath(): void {
    if (!this.mark('death')) return;
    tone(this.e, 'sfx', { wave: 'sine', freq: 300, freqEnd: 80, dur: 0.9, env: { a: 0.02, d: 0.9, peak: 0.25 } });
    this.e.duck('ambience', 0.3, 0.4);
  }

  playerRespawn(): void {
    if (!this.mark('respawn')) return;
    const e = this.e;
    [523, 659, 784].forEach((f, i) => tone(e, 'ui', { wave: 'sine', freq: f, dur: 0.3, env: { a: 0.01, d: 0.3, peak: 0.08 } }, e.now + i * 0.09));
    this.e.unduck('ambience', 1.2);
  }

  // ---- Ennemis / boss ----

  enemyRoar(pan: number, gain: number): void {
    if (!this.mark('roar')) return;
    fmTone(this.e, 'sfx', { carrier: 90 * rnd(0.2), ratio: 1.4, index: 140, dur: 0.5, env: { a: 0.02, d: 0.5, peak: 0.3 * gain }, pan });
  }

  enemyTelegraph(pan: number, gain: number): void {
    if (!this.mark('telegraph')) return;
    noiseBurst(this.e, 'sfx', { dur: 0.25, type: 'bandpass', freq: 300, freqEnd: 900, q: 2, env: { a: 0.02, d: 0.25, peak: 0.14 * gain }, pan });
  }

  enemyDeath(pan: number, gain: number): void {
    if (!this.mark('enemy-death')) return;
    noiseBurst(this.e, 'sfx', { dur: 0.4, type: 'lowpass', freq: 900, freqEnd: 150, env: { a: 0.01, d: 0.4, peak: 0.24 * gain }, pan });
    chirpPing(this.e, 'sfx', { freqs: [1600, 2300], dur: 0.3, peak: 0.08 * gain, pan });
  }

  bossPhase(phase: number): void {
    if (!this.mark(`boss-phase-${phase}`)) return;
    const e = this.e;
    fmTone(e, 'sfx', { carrier: 70, ratio: 1.7, index: 160, dur: 0.9, env: { a: 0.03, d: 0.9, peak: 0.4 } });
    noiseBurst(e, 'sfx', { dur: 0.8, type: 'bandpass', freq: 200, freqEnd: 2000 + phase * 600, q: 1.3, env: { a: 0.1, d: 0.8, peak: 0.2 } });
  }

  shieldBreak(): void {
    if (!this.mark('shield-break')) return;
    const e = this.e;
    const freqs = Array.from({ length: 8 }, () => 2000 + Math.random() * 4000);
    chirpPing(e, 'sfx', { freqs, dur: 0.45, peak: 0.3 });
    noiseBurst(e, 'sfx', { dur: 0.3, type: 'highpass', freq: 2500, env: { a: 0.003, d: 0.3, peak: 0.2 } });
  }

  // ---- Interactions / quête ----

  brazierIgnite(pan: number): void {
    if (!this.mark('brazier')) return;
    // Tête de la bobine feu = whoosh d'embrasement (extrait borné 1,4 s)
    if (this.sample('fire-loop', { pan, gain: 0.9, dur: 1.4 })) return;
    noiseBurst(this.e, 'sfx', { dur: 0.35, type: 'lowpass', freq: 300, freqEnd: 900, env: { a: 0.02, d: 0.35, peak: 0.3 }, pan });
    tone(this.e, 'sfx', { wave: 'sine', freq: 120, dur: 0.4, env: { a: 0.08, d: 0.4, peak: 0.14 }, pan });
  }

  infusion(): void {
    if (!this.mark('infusion')) return;
    noiseBurst(this.e, 'sfx', { dur: 0.5, type: 'bandpass', freq: 600, freqEnd: 2200, q: 1.4, env: { a: 0.03, d: 0.5, peak: 0.2 } });
    chirpPing(this.e, 'sfx', { freqs: [880, 1320], dur: 0.4, peak: 0.08 });
  }

  crystalPickup(): void {
    if (!this.mark('crystal')) return;
    if (this.sample('chime', { gain: 0.7, bus: 'ui' })) return;
    const e = this.e;
    [1047, 1319, 1568].forEach((f, i) => tone(e, 'ui', { wave: 'sine', freq: f, dur: 0.25, env: { a: 0.005, d: 0.25, peak: 0.09 } }, e.now + i * 0.06));
  }

  /** Agate de givre (M7.3) : chime dont la hauteur MONTE avec le compte. */
  agatePickup(n: number): void {
    if (!this.mark('agate')) return;
    if (this.sample('chime', { gain: 0.75, rate: 1 + n * 0.05, bus: 'ui' })) return;
    tone(this.e, 'ui', { wave: 'sine', freq: 880 * (1 + n * 0.06), dur: 0.3, env: { a: 0.005, d: 0.3, peak: 0.1 } });
  }

  /** Anneau du défi des vents traversé. */
  trialRing(i: number): void {
    if (!this.mark('trial-ring')) return;
    if (this.sample('chime', { gain: 0.8, rate: 1.1 + i * 0.04 })) return;
    chirpPing(this.e, 'sfx', { freqs: [1568, 2093], dur: 0.25, peak: 0.14 });
  }

  chestOpen(): void {
    if (!this.mark('chest')) return;
    const e = this.e;
    noiseBurst(e, 'sfx', { dur: 0.01, type: 'highpass', freq: 2000, env: { a: 0.003, d: 0.01, peak: 0.14 } });
    if (this.sample('chime', { gain: 0.8, rate: 0.92, bus: 'ui' })) return;
    [659, 784, 988, 1319].forEach((f, i) => tone(e, 'ui', { wave: 'triangle', freq: f, dur: 0.35, env: { a: 0.008, d: 0.35, peak: 0.08 } }, e.now + 0.1 + i * 0.09));
  }

  /** Notes montantes des cristaux de résonance (i = 0..3). */
  resonanceNote(i: number): void {
    if (!this.mark(`resonance-${i}`)) return;
    const f = [440, 523, 587, 659][i] ?? 440;
    // Éveil de gemme échantillonné (hauteur qui monte avec l'index) + la note
    // pitchée par-dessus : l'identité MUSICALE de la séquence est conservée
    if (this.sample('gem', { rate: 1 + i * 0.1, gain: 0.9 })) {
      tone(this.e, 'sfx', { wave: 'sine', freq: f * 2, dur: 0.7, env: { a: 0.02, d: 0.7, peak: 0.05 }, detuneCents: 6 });
      return;
    }
    tone(this.e, 'sfx', { wave: 'triangle', freq: f, dur: 0.9, env: { a: 0.01, d: 0.9, peak: 0.16 } });
    tone(this.e, 'sfx', { wave: 'sine', freq: f * 2, dur: 0.9, env: { a: 0.02, d: 0.9, peak: 0.07 }, detuneCents: 6 });
  }

  resonanceSolved(): void {
    if (!this.mark('resonance-ok')) return;
    const e = this.e;
    this.sample('gem', { rate: 1.3, gain: 0.9 }); // couche brillante par-dessus l'accord
    [440, 554, 659, 880].forEach((f, i) => tone(e, 'sfx', { wave: 'triangle', freq: f, dur: 0.8, env: { a: 0.01, d: 0.8, peak: 0.1 } }, e.now + i * 0.1));
  }

  resonanceFail(): void {
    if (!this.mark('resonance-fail')) return;
    tone(this.e, 'sfx', { wave: 'square', freq: 130, freqEnd: 98, dur: 0.35, env: { a: 0.01, d: 0.35, peak: 0.12 } });
  }

  windColumnsActivate(): void {
    if (!this.mark('windcols')) return;
    if (this.sample('spell', { rate: 0.85, gain: 0.9 })) return;
    noiseBurst(this.e, 'sfx', { dur: 1.2, type: 'bandpass', freq: 300, freqEnd: 1400, q: 1.2, env: { a: 0.15, d: 1.2, peak: 0.22 } });
  }

  /** Boucle de présence de la Luciole de givre (carillon cristallin). */
  makeSeelieLoop(): { gain: GainNode; pan: StereoPannerNode; stop: () => void } | null {
    return this.samples?.makeLoop('seelie-loop', 9000) ?? null;
  }

  /** Boucle de glissade sur glace. */
  makeIceSlideLoop(): { gain: GainNode; stop: () => void } | null {
    return this.samples?.makeLoop('ice-slide-loop', 6000) ?? null;
  }

  /** Boucle positionnelle d'une tornade (colonne de vent) — pan contrôlable. */
  makeTornadoLoop(): { gain: GainNode; pan: StereoPannerNode; stop: () => void } | null {
    const sampled = this.samples?.makeLoop('tornado-loop', 5000);
    if (sampled) return sampled;
    if (!this.e.unlocked) return null;
    const e = this.e;
    const src = e.ctx.createBufferSource();
    src.buffer = sharedNoise(e.ctx);
    src.loop = true;
    const f = e.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 600;
    f.Q.value = 0.8;
    const g = e.ctx.createGain();
    g.gain.value = 0.0001;
    const p = e.ctx.createStereoPanner();
    src.connect(f); f.connect(g); g.connect(p); p.connect(e.bus('sfx'));
    src.start(e.now, Math.random() * 1.5);
    return { gain: g, pan: p, stop: () => { g.gain.setTargetAtTime(0.0001, e.now, 0.2); src.stop(e.now + 0.9); } };
  }

  /** Ding de mise à jour d'objectif de quête (signature Genshin). */
  questDing(): void {
    if (!this.mark('quest-ding')) return;
    if (this.sample('ding', { gain: 0.7, bus: 'ui' })) return;
    const e = this.e;
    [988, 1319].forEach((f, i) => tone(e, 'ui', { wave: 'sine', freq: f, dur: 0.18, env: { a: 0.005, d: 0.18, peak: 0.09 } }, e.now + i * 0.09));
  }

  /** Départ du défi des vents (totem). */
  trialStart(): void {
    if (!this.mark('trial-start')) return;
    if (this.sample('ding', { rate: 0.8, gain: 0.85 })) {
      this.sample('spell', { rate: 1.3, gain: 0.5 });
      return;
    }
    chirpPing(this.e, 'sfx', { freqs: [784, 1175], dur: 0.4, peak: 0.16 });
  }

  /** Franchissement d'obstacle (vault) : whoosh court + effort tissu. */
  vault(): void {
    if (!this.mark('vault')) return;
    if (this.sample('swing', { rate: 0.85, gain: 0.5 })) return;
    noiseBurst(this.e, 'sfx', { dur: 0.12, type: 'bandpass', freq: 500, freqEnd: 1400, q: 1.3, env: { a: 0.006, d: 0.12, peak: 0.18 } });
  }

  /** Endurance épuisée (sprint coupé / décrochage planeur). */
  staminaEmpty(): void {
    if (!this.mark('stamina')) return;
    this.sample('ding', { rate: 0.55, gain: 0.4, bus: 'ui' });
    tone(this.e, 'ui', { wave: 'sine', freq: 220, freqEnd: 165, dur: 0.3, env: { a: 0.01, d: 0.3, peak: 0.09 } });
  }

  /** Crissement de freins du train (approche de gare). */
  trainBrake(pan: number, gain: number): void {
    if (!this.mark('brake')) return;
    if (this.sample('brake', { pan, gain: 0.8 * gain })) return;
    noiseBurst(this.e, 'sfx', { dur: 1.1, type: 'bandpass', freq: 2800, freqEnd: 1800, q: 6, env: { a: 0.08, d: 1.1, peak: 0.14 * gain }, pan });
  }

  regionStinger(): void {
    if (!this.mark('region')) return;
    const e = this.e;
    [262, 330, 392].forEach((f) => tone(e, 'ui', { wave: 'triangle', freq: f, dur: 2.2, env: { a: 0.3, d: 2.2, peak: 0.05 }, detuneCents: (Math.random() - 0.5) * 12 }));
  }

  // ---- UI ----

  uiCooldownReady(): void {
    if (!this.mark('ui-cd')) return;
    const e = this.e;
    tone(e, 'ui', { wave: 'sine', freq: 660, dur: 0.1, env: { a: 0.005, d: 0.1, peak: 0.08 } });
    tone(e, 'ui', { wave: 'sine', freq: 990, dur: 0.15, env: { a: 0.005, d: 0.15, peak: 0.08 } }, e.now + 0.08);
  }

  uiEnergyFull(): void {
    if (!this.mark('ui-energy')) return;
    const e = this.e;
    [660, 880, 1320].forEach((f, i) => tone(e, 'ui', { wave: 'sine', freq: f, dur: 0.14, env: { a: 0.005, d: 0.14, peak: 0.07 } }, e.now + i * 0.07));
  }

  uiPrompt(): void {
    if (!this.mark('ui-prompt')) return;
    tone(this.e, 'ui', { wave: 'sine', freq: 880, dur: 0.06, env: { a: 0.004, d: 0.06, peak: 0.05 } });
  }

  uiDialogueAdvance(): void {
    if (!this.mark('ui-dialogue')) return;
    noiseBurst(this.e, 'ui', { dur: 0.015, type: 'highpass', freq: 5000, env: { a: 0.003, d: 0.015, peak: 0.08 } });
  }

  // ---- Train ----

  trainWhistle(pan: number, gain: number): void {
    if (!this.mark('whistle')) return;
    const e = this.e;
    for (const f of [880, 1174, 1318]) {
      tone(e, 'sfx', { wave: 'sine', freq: f * rnd(0.01), dur: 1.1, env: { a: 0.06, d: 1.1, peak: 0.12 * gain }, pan });
    }
  }

  trainChuff(pan: number, gain: number): void {
    if (!this.mark('chuff')) return;
    noiseBurst(this.e, 'sfx', { dur: 0.09, type: 'lowpass', freq: 400 * rnd(0.15), env: { a: 0.004, d: 0.09, peak: 0.2 * gain }, pan });
  }

  trainBell(pan: number, gain: number): void {
    if (!this.mark('bell')) return;
    const e = this.e;
    for (let i = 0; i < 3; i++) {
      fmTone(e, 'sfx', { carrier: 600, ratio: 1.4, index: 90, dur: 0.5, env: { a: 0.003, d: 0.5, peak: 0.16 * gain }, pan }, e.now + i * 0.45);
    }
  }

  /** Porte/plateforme du wagon (embarquer ou descendre). */
  trainDoor(): void {
    if (!this.mark('train-door')) return;
    if (this.sample('train-door', { gain: 0.85 })) return;
    noiseBurst(this.e, 'sfx', { dur: 0.12, type: 'lowpass', freq: 500, env: { a: 0.004, d: 0.12, peak: 0.3 } });
    fmTone(this.e, 'sfx', { carrier: 160, ratio: 2.1, index: 50, dur: 0.2, env: { a: 0.004, d: 0.2, peak: 0.18 } });
  }

  /** Boucle de roulement du train (à bord) — échantillon Magnific seulement. */
  makeTrainRollLoop(): { gain: GainNode; stop: () => void } | null {
    return this.samples?.makeLoop('train-roll', 4000) ?? null;
  }

  // ---- Boucles persistantes (crépitement, vent) : gérées par l'appelant ----

  /** Crée une boucle de crépitement de brasero, retourne son contrôle de gain. */
  makeCrackleLoop(): { gain: GainNode; pan: StereoPannerNode; stop: () => void } | null {
    const sampled = this.samples?.makeLoop('fire-loop', 3200);
    if (sampled) return sampled;
    if (!this.e.unlocked) return null;
    const e = this.e;
    const src = e.ctx.createBufferSource();
    src.buffer = crackleBuffer(e.ctx);
    src.loop = true;
    const f = e.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 2600;
    const g = e.ctx.createGain();
    g.gain.value = 0.0001;
    const p = e.ctx.createStereoPanner();
    src.connect(f); f.connect(g); g.connect(p); p.connect(e.bus('sfx'));
    src.start(e.now, Math.random() * 2);
    return { gain: g, pan: p, stop: () => { g.gain.setTargetAtTime(0.0001, e.now, 0.1); src.stop(e.now + 0.5); } };
  }

  /** Boucle de vent (planeur / colonne) — bruit lowpass, contrôle continu. */
  makeWindLoop(): { gain: GainNode; filter: BiquadFilterNode; stop: () => void } | null {
    const sampled = this.samples?.makeLoop('wind-loop', 2500);
    if (sampled) return sampled;
    if (!this.e.unlocked) return null;
    const e = this.e;
    const src = e.ctx.createBufferSource();
    src.buffer = sharedNoise(e.ctx);
    src.loop = true;
    const f = e.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 500;
    const g = e.ctx.createGain();
    g.gain.value = 0.0001;
    src.connect(f); f.connect(g); g.connect(e.bus('sfx'));
    src.start(e.now, Math.random() * 1.5);
    return { gain: g, filter: f, stop: () => { g.gain.setTargetAtTime(0.0001, e.now, 0.15); src.stop(e.now + 0.7); } };
  }
}
