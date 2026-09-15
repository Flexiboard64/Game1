import { Vector3, type PerspectiveCamera } from 'three/webgpu';

// Nombres de dégâts flottants : pool de spans recyclés (jamais de création DOM
// à 60 Hz), état monde CPU (dérive verticale), projection par frame (patron
// StaminaWheel). Variantes : .crit (or, gros), .anemo (E/Q), .player (subis).

const POOL = 24;
const LIFE = 0.9;
const FADE_AFTER = 0.5;
const RISE = 0.9; // m/s

interface Entry {
  el: HTMLSpanElement;
  pos: Vector3;
  age: number;
  active: boolean;
}

export class DamageNumbers {
  private readonly entries: Entry[] = [];
  private cursor = 0;

  constructor(parent: HTMLElement) {
    for (let i = 0; i < POOL; i++) {
      const el = document.createElement('span');
      el.className = 'dmg-number';
      parent.appendChild(el);
      this.entries.push({ el, pos: new Vector3(), age: 0, active: false });
    }
  }

  spawn(text: string, x: number, y: number, z: number, kind: 'normal' | 'crit' | 'anemo' | 'player'): void {
    const e = this.entries[this.cursor]!;
    this.cursor = (this.cursor + 1) % POOL;
    e.el.textContent = text;
    e.el.className = `dmg-number ${kind === 'normal' ? '' : kind} visible`;
    // Jitter horizontal léger (des nombres empilés se distinguent)
    e.pos.set(x + (this.cursor % 5 - 2) * 0.12, y, z);
    e.age = 0;
    e.active = true;
  }

  update(dt: number, camera: PerspectiveCamera): void {
    for (const e of this.entries) {
      if (!e.active) continue;
      e.age += dt;
      if (e.age >= LIFE) {
        e.active = false;
        e.el.classList.remove('visible');
        continue;
      }
      e.pos.y += RISE * dt;
      _a.copy(e.pos).project(camera);
      if (_a.z > 1) {
        e.el.classList.remove('visible');
        continue;
      }
      e.el.classList.add('visible');
      const x = (_a.x * 0.5 + 0.5) * window.innerWidth;
      const y = (-_a.y * 0.5 + 0.5) * window.innerHeight;
      const fade = e.age < FADE_AFTER ? 1 : 1 - (e.age - FADE_AFTER) / (LIFE - FADE_AFTER);
      e.el.style.opacity = fade.toFixed(2);
      e.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -50%)`;
    }
  }
}

const _a = new Vector3();
