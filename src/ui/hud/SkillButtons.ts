import { PALETTE } from '../../config';
import { BURST_GLYPH, JUMP_GLYPH, SKILL_GLYPH } from '../glyphs';

// Boutons Saut (Espace, flash au saut), E (compétence, cooldown avec balayage
// radial + secondes) et Q (ultime, remplissage « liquide » couleur Anemo, pulse
// quand chargé). PILOTÉS par le CombatSystem depuis M4 : plus aucun listener
// E/Q interne (le flash Espace reste cosmétique), écritures INCONDITIONNELLES
// (un cooldown remis à zéro de l'extérieur doit se repeindre).

const RING_R = 31;
const RING_C = 2 * Math.PI * RING_R;

export interface SkillState {
  cooldown: number;    // secondes restantes sur E
  cooldownMax: number;
  energy01: number;    // 0..1 (Q)
}

export class SkillButtons {
  private readonly skillSweep: SVGCircleElement;
  private readonly skillSeconds: HTMLSpanElement;
  private readonly skillEl: HTMLDivElement;
  private readonly burstFill: HTMLDivElement;
  private readonly burstEl: HTMLDivElement;
  private wasOnCooldown = false;
  private wasFull = false;
  /** Hook audio : fronts « compétence prête » / « énergie pleine ». */
  onCue: ((cue: 'cooldownReady' | 'energyFull') => void) | null = null;

  constructor(parent: HTMLElement) {
    const el = document.createElement('div');
    el.className = 'skill-buttons';
    el.innerHTML = `
      <div class="skill-btn jump">
        <span class="skill-glyph">${JUMP_GLYPH}</span>
        <span class="keycap key-chip">Espace</span>
      </div>
      <div class="skill-btn skill">
        <span class="skill-glyph">${SKILL_GLYPH}</span>
        <div class="skill-clip">
          <svg class="cooldown-ring" viewBox="0 0 68 68">
            <circle class="cooldown-sweep" cx="34" cy="34" r="${RING_R}"
              fill="none" stroke="rgba(10,12,18,0.72)" stroke-width="${RING_R * 2}"
              stroke-dasharray="0 ${RING_C}" transform="rotate(-90 34 34) scale(1,-1) translate(0,-68)" />
          </svg>
        </div>
        <span class="cooldown-seconds"></span>
        <span class="keycap key-chip">E</span>
      </div>
      <div class="skill-btn burst">
        <div class="skill-clip">
          <div class="burst-fill" style="--element:${PALETTE.elements.anemo}"></div>
        </div>
        <span class="skill-glyph">${BURST_GLYPH}</span>
        <span class="keycap key-chip">R</span>
      </div>`;
    parent.appendChild(el);

    this.skillEl = el.querySelector<HTMLDivElement>('.skill')!;
    this.burstEl = el.querySelector<HTMLDivElement>('.burst')!;
    const jumpEl = el.querySelector<HTMLDivElement>('.jump')!;
    this.skillSweep = el.querySelector<SVGCircleElement>('.cooldown-sweep')!;
    this.skillSeconds = el.querySelector<HTMLSpanElement>('.cooldown-seconds')!;
    this.burstFill = el.querySelector<HTMLDivElement>('.burst-fill')!;

    // Flash cosmétique du bouton Saut (E/Q sont pilotés par le combat)
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !e.repeat) {
        jumpEl.classList.add('jump-flash');
        setTimeout(() => jumpEl.classList.remove('jump-flash'), 300);
      }
    });
  }

  /** Flash de cast de la compétence (événement skillCast). */
  flashSkill(): void {
    this.skillEl.classList.add('ready-flash');
    setTimeout(() => this.skillEl.classList.remove('ready-flash'), 300);
  }

  /** Flash de cast de l'ultime (événement burstCast). */
  flashBurst(): void {
    this.burstEl.classList.add('burst-flash');
    setTimeout(() => this.burstEl.classList.remove('burst-flash'), 400);
  }

  update(_dt: number, state: SkillState): void {
    // --- Compétence : balayage de cooldown (écriture inconditionnelle) ---
    const onCd = state.cooldown > 0;
    const frac = onCd ? state.cooldown / state.cooldownMax : 0;
    this.skillSweep.setAttribute('stroke-dasharray', `${frac * RING_C} ${RING_C}`);
    this.skillSeconds.textContent = onCd ? state.cooldown.toFixed(1) : '';
    this.skillEl.classList.toggle('on-cooldown', onCd);
    if (this.wasOnCooldown && !onCd) {
      this.skillEl.classList.add('ready-flash');
      setTimeout(() => this.skillEl.classList.remove('ready-flash'), 300);
      this.onCue?.('cooldownReady');
    }
    this.wasOnCooldown = onCd;

    // --- Ultime : niveau d'énergie réel ---
    this.burstFill.style.height = `${(Math.min(state.energy01, 1) * 100).toFixed(1)}%`;
    const full = state.energy01 >= 1;
    this.burstEl.classList.toggle('full', full);
    if (full && !this.wasFull) this.onCue?.('energyFull');
    this.wasFull = full;
  }
}
