// Panneau de dialogue façon Genshin (M7) : bandeau bas-centre sombre, nom doré,
// texte, chevron ▼ ; F ou clic pour avancer. Le mouvement est gelé par
// l'appelant (QuestSystem via setCombatDrive) — ici, uniquement le DOM.
// M7.3 : CHOIX DE DIALOGUE (signature Genshin) — une ligne peut proposer 2
// réponses ; 1/2 sélectionne, F prend la première ; la réponse choisie devient
// la ligne d'Aeliana puis le fil reprend.

export interface DialogueLine {
  speaker: string;
  text: string;
  /** Clé du fichier voix (/assets/audio/voice/<voice>.mp3) — optionnelle. */
  voice?: string;
  /** Réponses proposées au joueur APRÈS cette ligne (1/2 ou F = première). */
  choices?: readonly string[];
  /** Clés voix des réponses (même ordre que choices) — Aeliana parle son choix. */
  choiceVoices?: readonly string[];
}

export class Dialogue {
  private readonly el: HTMLDivElement;
  private readonly nameEl: HTMLDivElement;
  private readonly textEl: HTMLDivElement;
  private readonly choicesEl: HTMLDivElement;
  private lines: readonly DialogueLine[] = [];
  private index = 0;
  private choicePending = false;
  private onDone: (() => void) | null = null;
  /** Hook audio : appelé à CHAQUE ligne affichée (start + advance). */
  onLine: ((line: DialogueLine, index: number) => void) | null = null;

  get open(): boolean {
    return this.lines.length > 0;
  }

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'dialogue';
    this.el.innerHTML = `
      <div class="dialogue-choices"></div>
      <div class="dialogue-name"></div>
      <div class="dialogue-text"></div>
      <div class="dialogue-next">▽ <span class="key-chip">F</span></div>`;
    parent.appendChild(this.el);
    this.nameEl = this.el.querySelector<HTMLDivElement>('.dialogue-name')!;
    this.textEl = this.el.querySelector<HTMLDivElement>('.dialogue-text')!;
    this.choicesEl = this.el.querySelector<HTMLDivElement>('.dialogue-choices')!;
  }

  start(lines: readonly DialogueLine[], onDone: () => void): void {
    this.lines = lines;
    this.index = 0;
    this.onDone = onDone;
    this.el.classList.add('visible');
    this.show();
  }

  /** Avance d'une ligne — appelé par QuestSystem quand F est pressé. */
  advance(): void {
    if (!this.open) return;
    if (this.choicePending) {
      this.choose(0); // F = première réponse (les tests headless restent valides)
      return;
    }
    this.index++;
    if (this.index >= this.lines.length) {
      this.lines = [];
      this.el.classList.remove('visible');
      const cb = this.onDone;
      this.onDone = null;
      cb?.();
      return;
    }
    this.show();
  }

  /** Sélection d'une réponse (touches 1/2) — la réponse devient la ligne d'Aeliana. */
  choose(i: number): void {
    if (!this.choicePending) return;
    const line = this.lines[this.index]!;
    const picked = line.choices?.[i] ?? line.choices?.[0];
    if (picked === undefined) return;
    this.choicePending = false;
    this.choicesEl.classList.remove('visible');
    this.choicesEl.innerHTML = '';
    this.nameEl.textContent = 'Aeliana';
    this.textEl.textContent = picked;
    this.onLine?.({ speaker: 'Aeliana', text: picked, voice: line.choiceVoices?.[i] ?? line.choiceVoices?.[0] }, this.index);
  }

  private show(): void {
    const line = this.lines[this.index]!;
    this.nameEl.textContent = line.speaker;
    this.textEl.textContent = line.text;
    if (line.choices && line.choices.length > 0) {
      this.choicePending = true;
      this.choicesEl.innerHTML = line.choices
        .map((c, i) => `<div class="dialogue-choice"><span class="key-chip">${i + 1}</span><span>${c}</span></div>`)
        .join('');
      this.choicesEl.classList.add('visible');
    }
    this.onLine?.(line, this.index);
  }
}
