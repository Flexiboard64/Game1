import { Vector3, type PerspectiveCamera } from 'three/webgpu';
import { ENEMY } from '../../config';
import type { EnemyManager } from '../../combat/EnemyManager';

// Barres de PV des golems, ancrées monde (patron StaminaWheel) : pool de divs
// recyclés, visibles quand le golem est en aggro OU frappé récemment, et assez
// proche. camera.updateMatrixWorld() est déjà fait en tête de Hud.update.

const POOL = 8;

export class EnemyHealthBars {
  private readonly bars: { el: HTMLDivElement; fill: HTMLDivElement }[] = [];

  constructor(parent: HTMLElement) {
    for (let i = 0; i < POOL; i++) {
      const el = document.createElement('div');
      el.className = 'enemy-hp';
      el.innerHTML = '<div class="enemy-hp-fill"></div>';
      parent.appendChild(el);
      this.bars.push({ el, fill: el.querySelector<HTMLDivElement>('.enemy-hp-fill')! });
    }
  }

  update(camera: PerspectiveCamera, enemies: EnemyManager): void {
    let used = 0;
    for (const e of enemies.enemies) {
      if (used >= POOL) break;
      if (!e.alive) continue;
      const engaged = e.state !== 'idle' && e.state !== 'return';
      const recent = e.age - e.lastDamagedAt < ENEMY.hpBarRecentS;
      if (!engaged && !recent) continue;

      _a.copy(e.root.position);
      _a.y += e.heightM + 0.35;
      const dist = _a.distanceTo(camera.position);
      if (dist > ENEMY.hpBarShowDist) continue;
      _a.project(camera);
      if (_a.z > 1) continue;
      const x = (_a.x * 0.5 + 0.5) * window.innerWidth;
      const y = (-_a.y * 0.5 + 0.5) * window.innerHeight;

      const bar = this.bars[used++]!;
      bar.el.classList.add('visible');
      bar.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -50%)`;
      bar.fill.style.width = `${((e.hp / e.maxHp) * 100).toFixed(1)}%`;
    }
    for (let i = used; i < POOL; i++) this.bars[i]!.el.classList.remove('visible');
  }
}

const _a = new Vector3();
