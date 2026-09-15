import { AUDIO } from '../config';
import type { AudioEngine, BusName } from './AudioEngine';

// Primitives de synthèse WebAudio pures. Contrat anti-pop : toute enveloppe
// démarre à 0.0001, monte en exponentielle (attack ≥ 3 ms) et retombe à 0.0001
// AVANT le stop — jamais de start/stop à gain non nul. Chaque voix passe par
// un GainNode d'enveloppe branché sur le bus demandé ; le compteur de voix de
// l'AudioEngine borne le total (refuser > voler : les one-shots sont courts).

const MIN_GAIN = 0.0001;

export interface Env {
  /** Attack (s), ≥ 0.003. */ a: number;
  /** Decay/release (s). */ d: number;
  /** Gain de crête (linéaire). */ peak: number;
}

let noiseBuf: AudioBuffer | null = null;
/** 2 s de bruit blanc partagé (une seule allocation pour tout le jeu). */
export function sharedNoise(ctx: AudioContext): AudioBuffer {
  if (!noiseBuf) {
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  return noiseBuf;
}

let crackleBuf: AudioBuffer | null = null;
/** 2 s d'impulsions éparses lowpassées (crépitement de feu), partagé. */
export function crackleBuffer(ctx: AudioContext): AudioBuffer {
  if (!crackleBuf) {
    crackleBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = crackleBuf.getChannelData(0);
    let v = 0;
    for (let i = 0; i < d.length; i++) {
      // Impulsion aléatoire rare + décroissance : petits claquements de braise
      if (Math.random() < 0.0015) v = (Math.random() * 2 - 1) * (0.4 + Math.random() * 0.6);
      v *= 0.988;
      // Souffle très léger sous les claquements
      d[i] = v + (Math.random() * 2 - 1) * 0.02;
    }
  }
  return crackleBuf;
}

/** Réserve une voix (cap global) — retourne false si saturé. */
function claim(e: AudioEngine): boolean {
  if (!e.unlocked || e.voices >= AUDIO.maxVoices) return false;
  e.voices++;
  return true;
}

/** Enveloppe A/D standard sur un GainNode, retourne l'instant de fin. */
function applyEnv(g: GainNode, when: number, env: Env): number {
  const a = Math.max(0.003, env.a);
  g.gain.setValueAtTime(MIN_GAIN, when);
  g.gain.exponentialRampToValueAtTime(Math.max(MIN_GAIN, env.peak), when + a);
  const end = when + a + env.d;
  g.gain.exponentialRampToValueAtTime(MIN_GAIN, end);
  return end + 0.02;
}

/** Chaîne de sortie [panner?] → gain → bus ; câble source → filter? → chaîne. */
function outputChain(e: AudioEngine, bus: BusName, pan: number | undefined): { input: AudioNode; gain: GainNode } {
  const g = e.ctx.createGain();
  if (pan !== undefined && pan !== 0) {
    const p = e.ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    g.connect(p);
    p.connect(e.bus(bus));
  } else {
    g.connect(e.bus(bus));
  }
  return { input: g, gain: g };
}

export interface NoiseBurstOpts {
  dur: number;
  type: BiquadFilterType;
  freq: number;
  freqEnd?: number;
  q?: number;
  env: Env;
  pan?: number;
  playbackRate?: number;
}

/** Bruit blanc → biquad (fréquence rampée) → enveloppe. La base du foley. */
export function noiseBurst(e: AudioEngine, bus: BusName, o: NoiseBurstOpts, when = e.now): void {
  if (!claim(e)) return;
  const src = e.ctx.createBufferSource();
  src.buffer = sharedNoise(e.ctx);
  src.loop = true;
  if (o.playbackRate) src.playbackRate.value = o.playbackRate;
  const f = e.ctx.createBiquadFilter();
  f.type = o.type;
  f.frequency.setValueAtTime(o.freq, when);
  if (o.freqEnd !== undefined) f.frequency.exponentialRampToValueAtTime(Math.max(20, o.freqEnd), when + o.dur);
  if (o.q !== undefined) f.Q.value = o.q;
  const { input, gain } = outputChain(e, bus, o.pan);
  src.connect(f);
  f.connect(input);
  const end = applyEnv(gain, when, { ...o.env, d: o.dur });
  src.onended = () => { e.voices--; };
  src.start(when, Math.random() * 1.5); // offset aléatoire dans le buffer de bruit
  src.stop(end);
}

export interface ToneOpts {
  wave: OscillatorType;
  freq: number;
  freqEnd?: number;
  dur: number;
  env: Env;
  pan?: number;
  detuneCents?: number;
}

/** Oscillateur simple (fréquence rampée optionnelle). */
export function tone(e: AudioEngine, bus: BusName, o: ToneOpts, when = e.now): void {
  if (!claim(e)) return;
  const osc = e.ctx.createOscillator();
  osc.type = o.wave;
  osc.frequency.setValueAtTime(o.freq, when);
  if (o.freqEnd !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.freqEnd), when + o.dur);
  if (o.detuneCents) osc.detune.value = o.detuneCents;
  const { input, gain } = outputChain(e, bus, o.pan);
  osc.connect(input);
  const end = applyEnv(gain, when, { ...o.env, d: o.dur });
  osc.onended = () => { e.voices--; };
  osc.start(when);
  osc.stop(end);
}

export interface FmOpts {
  carrier: number;
  ratio: number;
  /** Excursion de fréquence (Hz) injectée dans la porteuse. */
  index: number;
  dur: number;
  env: Env;
  pan?: number;
}

/** FM 2 opérateurs (métal, cloches, zaps) : mod → modGain → carrier.frequency. */
export function fmTone(e: AudioEngine, bus: BusName, o: FmOpts, when = e.now): void {
  if (!claim(e)) return;
  const car = e.ctx.createOscillator();
  car.frequency.value = o.carrier;
  const mod = e.ctx.createOscillator();
  mod.frequency.value = o.carrier * o.ratio;
  const mg = e.ctx.createGain();
  mg.gain.setValueAtTime(o.index, when);
  mg.gain.exponentialRampToValueAtTime(Math.max(0.01, o.index * 0.05), when + o.dur);
  mod.connect(mg);
  mg.connect(car.frequency);
  const { input, gain } = outputChain(e, bus, o.pan);
  car.connect(input);
  const end = applyEnv(gain, when, { ...o.env, d: o.dur });
  car.onended = () => { e.voices--; };
  car.start(when);
  mod.start(when);
  car.stop(end);
  mod.stop(end);
}

/**
 * Partiels sinus inharmoniques à décroissance rapide (verre/glace/cristal).
 * Une seule voix comptée pour l'accord entier.
 */
export function chirpPing(e: AudioEngine, bus: BusName, o: { freqs: readonly number[]; dur: number; peak: number; pan?: number }, when = e.now): void {
  if (!claim(e)) return;
  const { input, gain } = outputChain(e, bus, o.pan);
  const end = applyEnv(gain, when, { a: 0.003, d: o.dur, peak: o.peak });
  let remaining = o.freqs.length;
  for (const f of o.freqs) {
    const osc = e.ctx.createOscillator();
    osc.frequency.value = f * (1 + (Math.random() - 0.5) * 0.01);
    const og = e.ctx.createGain();
    og.gain.value = 1 / o.freqs.length;
    osc.connect(og);
    og.connect(input);
    osc.onended = () => { if (--remaining === 0) e.voices--; };
    osc.start(when);
    osc.stop(end);
  }
}
