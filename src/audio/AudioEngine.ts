import type { PerspectiveCamera } from 'three/webgpu';
import { Vector3 } from 'three/webgpu';
import { AUDIO } from '../config';

// Cœur WebAudio : contexte (né « suspended » — autoplay policy), 4 bus à gain
// (sfx/ambience/voice/ui) chacun suivi d'un duckGain en série (le duck et le
// volume sont deux autorités DISTINCTES : jamais d'écriture .value concurrente,
// tout passe par setTargetAtTime), lowpass dédié au bus ambience (intérieur/
// tunnel). Horloge = ctx.currentTime EXCLUSIVEMENT (le hitstop scale le dt de
// la boucle de jeu). En headless sans geste utilisateur le contexte reste
// suspendu : tous les play* des consommateurs early-return sur `unlocked`.

export type BusName = 'sfx' | 'ambience' | 'voice' | 'ui';

const BUS_NAMES: readonly BusName[] = ['sfx', 'ambience', 'voice', 'ui'];

export class AudioEngine {
  readonly enabled: boolean;
  readonly ctx: AudioContext;
  readonly ambienceFilter: BiquadFilterNode;
  private readonly master: GainNode;
  private readonly busGains: Record<BusName, GainNode>;
  private readonly duckGains: Record<BusName, GainNode>;
  /** Compteur de voix actives (one-shots dsp) — cap AUDIO.maxVoices. */
  voices = 0;
  private unlockInstalled = false;

  constructor(enabled: boolean) {
    this.enabled = enabled;
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.gain.value = AUDIO.buses.master;
    this.master.connect(this.ctx.destination);
    this.busGains = {} as Record<BusName, GainNode>;
    this.duckGains = {} as Record<BusName, GainNode>;
    for (const name of BUS_NAMES) {
      const bus = this.ctx.createGain();
      bus.gain.value = AUDIO.buses[name];
      const duck = this.ctx.createGain();
      duck.gain.value = 1;
      bus.connect(duck);
      duck.connect(this.master);
      this.busGains[name] = bus;
      this.duckGains[name] = duck;
    }
    // Le lowpass d'intérieur s'insère AVANT le bus ambience : les couches du
    // mixer s'y branchent, le bus garde son rôle de volume
    this.ambienceFilter = this.ctx.createBiquadFilter();
    this.ambienceFilter.type = 'lowpass';
    this.ambienceFilter.frequency.value = AUDIO.ambience.lowpassOpenHz;
    this.ambienceFilter.connect(this.busGains.ambience);
  }

  get now(): number {
    return this.ctx.currentTime;
  }

  get unlocked(): boolean {
    return this.enabled && this.ctx.state === 'running';
  }

  bus(name: BusName): GainNode {
    return this.busGains[name];
  }

  /**
   * Débloque le contexte au premier geste utilisateur (clic canvas — même
   * contrat que fullscreen/pointer lock d'InputManager, listeners multiples
   * légaux — ou touche clavier en secours). Ne touche PAS au slot
   * onPointerLockChange (déjà pris par le HUD).
   */
  installUnlock(canvas: HTMLCanvasElement): void {
    if (!this.enabled || this.unlockInstalled) return;
    this.unlockInstalled = true;
    const tryResume = (): void => {
      if (this.ctx.state === 'running') { cleanup(); return; }
      void this.ctx.resume().then(() => {
        if (this.ctx.state === 'running') {
          console.info('[Audio] contexte débloqué');
          cleanup();
        }
      });
    };
    const cleanup = (): void => {
      canvas.removeEventListener('click', tryResume);
      window.removeEventListener('keydown', tryResume);
    };
    canvas.addEventListener('click', tryResume);
    window.addEventListener('keydown', tryResume);
  }

  /** Duck multiplicatif d'un bus (autorité unique : le duckGain en série). */
  duck(bus: BusName, level01: number, attackS: number = AUDIO.duck.attackS): void {
    this.duckGains[bus].gain.setTargetAtTime(level01, this.now, attackS);
  }

  unduck(bus: BusName, releaseS: number = AUDIO.duck.releaseS): void {
    this.duckGains[bus].gain.setTargetAtTime(1, this.now, releaseS);
  }

  /**
   * Charge et décode un fichier audio (patron tryGltf : jamais de throw, warn
   * + null si absent/illisible — drive.mjs reste vert sans mp3 sur disque).
   * decodeAudioData fonctionne sur un contexte suspendu.
   */
  async loadBuffer(url: string): Promise<AudioBuffer | null> {
    if (!this.enabled) return null;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = await res.arrayBuffer();
      return await this.ctx.decodeAudioData(raw);
    } catch {
      console.warn(`[Audio] fichier absent ou illisible : ${url}`);
      return null;
    }
  }

  /**
   * Panning + atténuation d'une source positionnelle : azimut en espace
   * caméra (droite locale · direction) et rolloff hyperbolique borné.
   */
  panFor(x: number, y: number, z: number, cam: PerspectiveCamera, out: { pan: number; gain: number }): void {
    _dir.set(x, y, z).sub(cam.position);
    const dist = _dir.length();
    if (dist >= AUDIO.rolloff.maxDist) {
      out.pan = 0;
      out.gain = 0;
      return;
    }
    _right.setFromMatrixColumn(cam.matrixWorld, 0).normalize();
    const denom = Math.max(1e-4, Math.hypot(_dir.x, _dir.z));
    out.pan = Math.max(-1, Math.min(1, _right.dot(_dir) / denom));
    const g = AUDIO.rolloff.refDist / Math.max(AUDIO.rolloff.refDist, dist);
    // Fondu terminal pour ne pas couper net à maxDist
    const edge = Math.min(1, (AUDIO.rolloff.maxDist - dist) / 8);
    out.gain = g * edge;
  }
}

const _dir = new Vector3();
const _right = new Vector3();
