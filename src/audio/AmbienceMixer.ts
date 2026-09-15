import { AUDIO } from '../config';
import { AUDIO_URLS } from '../assets/manifest';
import type { AudioEngine } from './AudioEngine';

// Nappes d'ambiance mp3 en couches simultanées, gains crossfadés par l'état du
// monde (ambS/nightS déjà calculés par main.ts, blizzard01 du ColdSystem,
// wagon/tunnel). Rebouclage SANS couture : jamais loop=true nu sur un mp3 (gap
// d'encodeur en tête/queue) — deux AudioBufferSourceNode alternées par couche,
// croisées en equal-power sur xfadeS avant la fin, replanifiées par une file
// d'échéances vérifiée à chaque update (lookahead 1 s).

type LayerName = keyof typeof AUDIO_URLS;

interface Layer {
  buffer: AudioBuffer | null;
  gain: GainNode | null;   // gain de couche (cible pilotée par update)
  target: number;
  nextReschedule: number;  // horloge audio : quand redémarrer la source jumelle
  started: boolean;
}

export interface AmbienceParams {
  ambS: number;
  nightS: number;
  blizzard01: number;
  envBoost: number;
  aboard: boolean;
  tunnel: boolean;
  trainSpeed01: number;
  riverProx01: number;
}

export class AmbienceMixer {
  private readonly layers: Record<LayerName, Layer>;
  private running = false;

  constructor(private readonly e: AudioEngine) {
    this.layers = Object.fromEntries(
      (Object.keys(AUDIO_URLS) as LayerName[]).map((k) => [k, { buffer: null, gain: null, target: 0, nextReschedule: 0, started: false }]),
    ) as Record<LayerName, Layer>;
  }

  /** Chargement différé (PAS dans le LoadingManager : boot inchangé). */
  async load(): Promise<void> {
    if (!this.e.enabled) return;
    const names = Object.keys(AUDIO_URLS) as LayerName[];
    const buffers = await Promise.all(names.map((n) => this.e.loadBuffer(AUDIO_URLS[n])));
    let ok = 0;
    names.forEach((n, i) => {
      this.layers[n].buffer = buffers[i] ?? null;
      if (buffers[i]) ok++;
    });
    console.info(`[Audio] nappes chargées : ${ok}/${names.length}`);
  }

  /** Expose les gains cibles (sonde ?audiodiag / tests headless). */
  get gains(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, l] of Object.entries(this.layers)) out[k] = Number(l.target.toFixed(3));
    return out;
  }

  private startLayer(name: LayerName): void {
    const l = this.layers[name];
    if (!l.buffer || l.started) return;
    l.started = true;
    l.gain = this.e.ctx.createGain();
    l.gain.gain.value = 0.0001;
    l.gain.connect(this.e.ambienceFilter);
    this.scheduleLoop(name, this.e.now + 0.05);
  }

  /** Programme une lecture du buffer et mémorise l'échéance du rebouclage. */
  private scheduleLoop(name: LayerName, when: number): void {
    const l = this.layers[name];
    if (!l.buffer || !l.gain) return;
    const xf = AUDIO.ambience.xfadeS;
    const src = this.e.ctx.createBufferSource();
    src.buffer = l.buffer;
    // Enveloppe de segment : fondu d'entrée/sortie en equal-power — les deux
    // segments qui se chevauchent somment à puissance constante
    const seg = this.e.ctx.createGain();
    seg.gain.setValueAtTime(0.0001, when);
    seg.gain.linearRampToValueAtTime(1, when + xf);
    const end = when + l.buffer.duration;
    seg.gain.setValueAtTime(1, end - xf);
    seg.gain.linearRampToValueAtTime(0.0001, end);
    src.connect(seg);
    seg.connect(l.gain);
    src.start(when);
    src.stop(end + 0.05);
    l.nextReschedule = end - xf; // la jumelle démarre quand ce segment entame son fondu de sortie
  }

  update(p: AmbienceParams): void {
    if (!this.e.unlocked) return;
    if (!this.running) {
      this.running = true;
      for (const n of Object.keys(this.layers) as LayerName[]) this.startLayer(n);
    }
    // Cibles de couche
    const l = this.layers;
    l.ambValley.target = (1 - p.ambS) * (p.aboard ? 0.25 : 1);
    l.ambRiver.target = p.riverProx01 * (1 - p.ambS) * (p.aboard ? 0.3 : 1);
    l.ambBlizzard.target = Math.min(1, p.ambS * (1 - p.nightS) * (0.45 + 0.55 * p.blizzard01) + p.envBoost * 0.85) * (p.aboard ? 0.35 : 1);
    l.ambCityNight.target = p.nightS * (p.aboard ? 0.3 : 1);
    l.ambTrain.target = p.aboard ? 0.45 + 0.55 * p.trainSpeed01 : 0;
    const now = this.e.now;
    for (const name of Object.keys(l) as LayerName[]) {
      const layer = l[name];
      if (!layer.gain) {
        // Buffer arrivé après coup (chargement différé) : démarrer dès que possible
        if (layer.buffer && !layer.started) this.startLayer(name);
        continue;
      }
      layer.gain.gain.setTargetAtTime(Math.max(0.0001, layer.target), now, AUDIO.ambience.smoothTau);
      // Rebouclage : replanifier la jumelle dans la fenêtre de lookahead
      if (layer.nextReschedule > 0 && now >= layer.nextReschedule - 1) {
        const when = layer.nextReschedule;
        layer.nextReschedule = 0; // scheduleLoop la re-renseigne
        this.scheduleLoop(name, Math.max(when, now + 0.02));
      }
    }
    // Lowpass d'intérieur (wagon/tunnel)
    const cutoff = p.aboard || p.tunnel ? AUDIO.ambience.lowpassInteriorHz : AUDIO.ambience.lowpassOpenHz;
    this.e.ambienceFilter.frequency.setTargetAtTime(cutoff, now, AUDIO.ambience.filterTau);
  }
}
