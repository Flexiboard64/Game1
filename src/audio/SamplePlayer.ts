import type { AudioEngine, BusName } from './AudioEngine';

// Échantillons foley générés via Magnific (M8.1) : bobines ElevenLabs music
// découpées en one-shots → /assets/audio/sfx/
// <famille>-<n>.m4a + manifest.json { familles: { nom: nombre }, loops: [...] }.
// Chargement différé (patron nappes M8), pools par famille, anti-répétition
// immédiate, jitter de vitesse. Pool absent → l'appelant garde sa recette
// procédurale.

interface SfxManifest {
  families: Record<string, number>;
  loops: string[];
}

export interface SampleLoop {
  gain: GainNode;
  filter: BiquadFilterNode;
  pan: StereoPannerNode;
  stop: () => void;
}

const rnd = (spread: number): number => 1 + (Math.random() * 2 - 1) * spread;

export class SamplePlayer {
  private readonly pools = new Map<string, AudioBuffer[]>();
  private readonly lastIndex = new Map<string, number>();
  /** Sonde : nombre de familles chargées (tests headless). */
  loadedFamilies = 0;

  constructor(private readonly e: AudioEngine) {}

  /** Chargement différé — jamais dans le LoadingManager (boot inchangé). */
  async load(): Promise<void> {
    if (!this.e.enabled) return;
    let manifest: SfxManifest;
    try {
      const res = await fetch('/assets/audio/sfx/manifest.json');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      manifest = (await res.json()) as SfxManifest;
    } catch {
      console.warn('[Audio] manifest SFX absent — recettes procédurales seules');
      return;
    }
    const jobs: Promise<void>[] = [];
    for (const [family, count] of Object.entries(manifest.families)) {
      const pool: AudioBuffer[] = [];
      this.pools.set(family, pool);
      for (let i = 1; i <= count; i++) {
        jobs.push(
          this.e.loadBuffer(`/assets/audio/sfx/${family}-${i}.m4a`).then((b) => {
            if (b) pool.push(b);
          }),
        );
      }
    }
    await Promise.all(jobs);
    for (const [family, pool] of this.pools) {
      if (pool.length === 0) this.pools.delete(family);
      else void family;
    }
    this.loadedFamilies = this.pools.size;
    console.info(`[Audio] échantillons foley : ${this.pools.size} familles`);
  }

  has(family: string): boolean {
    return (this.pools.get(family)?.length ?? 0) > 0;
  }

  /**
   * Joue un échantillon du pool (jamais deux fois le même d'affilée), avec
   * jitter de vitesse ±6 % par défaut. Retourne false si pool absent
   * (l'appelant enchaîne sur sa recette procédurale).
   */
  play(
    family: string,
    opts: { gain?: number; rate?: number; jitter?: number; pan?: number; bus?: BusName; offset?: number; dur?: number } = {},
  ): boolean {
    const pool = this.pools.get(family);
    if (!pool || pool.length === 0 || !this.e.unlocked) return false;
    let idx = Math.floor(Math.random() * pool.length);
    if (pool.length > 1 && idx === this.lastIndex.get(family)) idx = (idx + 1) % pool.length;
    this.lastIndex.set(family, idx);
    const e = this.e;
    const src = e.ctx.createBufferSource();
    src.buffer = pool[idx]!;
    src.playbackRate.value = (opts.rate ?? 1) * rnd(opts.jitter ?? 0.06);
    const g = e.ctx.createGain();
    g.gain.value = opts.gain ?? 1;
    src.connect(g);
    if (opts.pan !== undefined) {
      const p = e.ctx.createStereoPanner();
      p.pan.value = opts.pan;
      g.connect(p);
      p.connect(e.bus(opts.bus ?? 'sfx'));
    } else {
      g.connect(e.bus(opts.bus ?? 'sfx'));
    }
    src.start(e.now, opts.offset ?? 0);
    if (opts.dur !== undefined) {
      // Extrait borné : fondu de sortie court puis arrêt (anti-clic)
      g.gain.setValueAtTime(opts.gain ?? 1, e.now + opts.dur - 0.08);
      g.gain.linearRampToValueAtTime(0.0001, e.now + opts.dur);
      src.stop(e.now + opts.dur + 0.02);
    }
    return true;
  }

  /**
   * Boucle continue depuis un échantillon long (roulement du train, vent,
   * crépitement) : loopStart/End rentrés de 0,12 s — on boucle À L'INTÉRIEUR
   * du buffer décodé, le gap d'encodeur mp3/m4a des extrémités est évité par
   * construction (pas besoin du double-source des nappes).
   */
  makeLoop(family: string, lowpassHz = 20000): SampleLoop | null {
    const pool = this.pools.get(family);
    if (!pool || pool.length === 0 || !this.e.unlocked) return null;
    const e = this.e;
    const buffer = pool[Math.floor(Math.random() * pool.length)]!;
    const src = e.ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    const inset = Math.min(0.12, buffer.duration * 0.1);
    src.loopStart = inset;
    src.loopEnd = buffer.duration - inset;
    const f = e.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = lowpassHz;
    const g = e.ctx.createGain();
    g.gain.value = 0.0001;
    const p = e.ctx.createStereoPanner();
    src.connect(f);
    f.connect(g);
    g.connect(p);
    p.connect(e.bus('sfx'));
    src.start(e.now, inset + Math.random() * Math.max(0.1, buffer.duration - inset * 2 - 0.1));
    return {
      gain: g,
      filter: f,
      pan: p,
      stop: () => {
        g.gain.setTargetAtTime(0.0001, e.now, 0.15);
        src.stop(e.now + 0.8);
      },
    };
  }
}
