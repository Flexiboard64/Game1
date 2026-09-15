import { AUDIO } from '../config';
import type { AudioEngine } from './AudioEngine';

// Voix ElevenLabs : lignes de dialogue (clé `voice:` d'une DialogueLine →
// /assets/audio/voice/<clé>.mp3, cache paresseux) + barks d'Aeliana throttlés.
// Priorité stricte dialogue > bark : jamais deux voix superposées. Pendant un
// dialogue, les bus ambience/sfx sont duckés.

export type BarkKind = keyof typeof AUDIO.barks.throttleS;

export class VoicePlayer {
  /** Dernière clé jouée (sonde ?audiodiag / tests headless). */
  lastVoice = '';
  private readonly cache = new Map<string, AudioBuffer | null>();
  private current: AudioBufferSourceNode | null = null;
  private currentGain: GainNode | null = null;
  private dialogueOpen = false;
  private lastBarkAt = -Infinity;
  private readonly lastKindAt = new Map<BarkKind, number>();

  constructor(private readonly e: AudioEngine) {}

  private async buffer(key: string): Promise<AudioBuffer | null> {
    if (!this.cache.has(key)) {
      // Réserver l'emplacement AVANT l'await (deux appels rapprochés ne
      // doivent pas fetch deux fois) puis remplir
      this.cache.set(key, null);
      const buf = await this.e.loadBuffer(`/assets/audio/voice/${key}.mp3`);
      this.cache.set(key, buf);
      return buf;
    }
    return this.cache.get(key) ?? null;
  }

  private stopCurrent(): void {
    if (this.current && this.currentGain) {
      const t = this.e.now;
      this.currentGain.gain.setTargetAtTime(0.0001, t, 0.03);
      this.current.stop(t + 0.15);
    }
    this.current = null;
    this.currentGain = null;
  }

  private play(buf: AudioBuffer): void {
    this.stopCurrent();
    const src = this.e.ctx.createBufferSource();
    src.buffer = buf;
    const g = this.e.ctx.createGain();
    g.gain.value = 1;
    src.connect(g);
    g.connect(this.e.bus('voice'));
    src.onended = () => {
      if (this.current === src) {
        this.current = null;
        this.currentGain = null;
        if (!this.dialogueOpen) this.undock();
      }
    };
    this.current = src;
    this.currentGain = g;
    src.start(this.e.now);
  }

  private undock(): void {
    this.e.unduck('ambience');
    this.e.unduck('sfx');
  }

  /** Joue une ligne de dialogue (prioritaire absolue). */
  async playLine(key: string): Promise<void> {
    if (!this.e.unlocked) return;
    this.lastVoice = key;
    this.e.duck('ambience', AUDIO.duck.dialogAmbience);
    this.e.duck('sfx', AUDIO.duck.dialogSfx);
    const buf = await this.buffer(key);
    if (!buf) return;
    // Le dialogue a pu se fermer/avancer pendant le fetch : ne joue que si
    // cette clé est toujours la dernière demandée
    if (this.lastVoice !== key) return;
    this.play(buf);
  }

  /** Le duck suit l'état d'ouverture du panneau de dialogue. */
  setDialogueOpen(open: boolean): void {
    if (open === this.dialogueOpen) return;
    this.dialogueOpen = open;
    if (!this.e.unlocked) return;
    if (open) {
      this.e.duck('ambience', AUDIO.duck.dialogAmbience);
      this.e.duck('sfx', AUDIO.duck.dialogSfx);
    } else {
      this.stopCurrent();
      this.undock();
    }
  }

  /** Bark d'Aeliana — throttle global + par type + probabilité. */
  bark(kind: BarkKind): void {
    if (!this.e.unlocked || this.dialogueOpen || this.current) return;
    const t = this.e.now;
    if (t - this.lastBarkAt < AUDIO.barks.globalCooldownS) return;
    if (t - (this.lastKindAt.get(kind) ?? -Infinity) < AUDIO.barks.throttleS[kind]) return;
    if (Math.random() > AUDIO.barks.chance[kind]) return;
    this.lastBarkAt = t;
    this.lastKindAt.set(kind, t);
    const n = AUDIO.barks.variants[kind];
    const key = `aeliana-${kind}-${1 + Math.floor(Math.random() * n)}`;
    this.lastVoice = key;
    void this.buffer(key).then((buf) => {
      // Conditions re-testées après le fetch (un dialogue a pu s'ouvrir)
      if (buf && !this.dialogueOpen && !this.current) this.play(buf);
    });
  }
}
