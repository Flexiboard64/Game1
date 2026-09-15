import { Group, Mesh, OctahedronGeometry, Scene, Vector3 } from 'three/webgpu';
import { BRAZIERS, CRYSTALS, FIRE, HUD, PALETTE } from '../config';
import { REACTIONS } from '../combat/Elements';
import { ToonMaterials } from '../materials/ToonMaterials';
import { FireVfx } from '../vfx/FireVfx';
import type { LoadedProp } from '../assets/PropLoader';
import type { ObstacleGrid } from '../world/Obstacles';
import type { SnowField } from '../world/SnowField';
import type { Updatable } from '../core/Engine';
import type { InputManager } from '../core/InputManager';
import type { CharacterController } from '../player/CharacterController';
import type { CombatSystem } from '../combat/CombatSystem';
import type { CombatEvents } from '../combat/CombatEvents';
import type { RideController } from '../train/RideController';
import type { ColdSystem } from './ColdSystem';

// Interactions F de Snezhnaya (M6) : braseros allumables (chaleur + checkpoint,
// puis « Embraser la lame » = infusion Pyro → la Fonte), cristaux de givre à
// ramasser (quête simple), coffre du boss. Enregistré APRÈS ride et AVANT
// input.clearFrame() — le train garde la priorité absolue sur la touche F.

interface Brazier {
  x: number;
  z: number;
  fire: FireVfx;
}

interface Crystal {
  x: number;
  z: number;
  mesh: Mesh;
  taken: boolean;
}

export class InteractionManager implements Updatable {
  readonly group = new Group();
  /** Libellé du prompt (le HUD compose : ride d'abord, puis nous). */
  promptLabel: string | null = null;
  crystalsFound = 0;
  onCrystals: ((n: number, total: number) => void) | null = null;
  /** Hooks audio (M8) : coffre ouvert / lame embrasée. */
  onChest: (() => void) | null = null;
  onInfusion: (() => void) | null = null;
  /** Coffre posé par l'ArenaController à la mort du boss. */
  chest: { x: number; z: number; mesh: Mesh; opened: boolean } | null = null;

  private readonly braziers: Brazier[] = [];
  private readonly crystals: Crystal[] = [];
  private crystalIsProp = false;
  private t = 0;

  constructor(
    scene: Scene,
    private readonly input: InputManager,
    private readonly player: CharacterController,
    private readonly ride: RideController,
    private readonly cold: ColdSystem,
    private readonly combat: CombatSystem,
    private readonly events: CombatEvents,
    snow: SnowField,
    brazierProp: LoadedProp | null,
    obstacles: ObstacleGrid | null,
    crystalProp: LoadedProp | null = null,
  ) {
    // ---- Braseros (éteints au boot — F les allume) ----
    for (const b of BRAZIERS) {
      const y = snow.getHeight(b.x, b.z);
      if (brazierProp) {
        const mesh = new Mesh(brazierProp.geometry, ToonMaterials.snowProp(brazierProp.material.map ?? null));
        mesh.position.set(b.x, y - 0.04, b.z);
        mesh.castShadow = true;
        this.group.add(mesh);
      }
      // Vrai feu animé (M10) : toujours visible, l'allumage est un uniform —
      // le shader compile au warmup, zéro à-coup au premier F
      const fire = new FireVfx();
      fire.group.position.set(b.x, y + (brazierProp ? brazierProp.height * FIRE.bowlFrac : 0.85), b.z);
      this.group.add(fire.group);
      this.braziers.push({ x: b.x, z: b.z, fire });
      obstacles?.add({ x: b.x, z: b.z, r: brazierProp ? brazierProp.radiusXZ * 0.7 : 0.6 });
    }

    // ---- Cristaux de givre (pickup quête) — M7.1 : vrai GLB posé au sol ----
    this.crystalIsProp = crystalProp !== null;
    const mat = crystalProp
      ? ToonMaterials.glowProp(crystalProp.material.map ?? null, PALETTE.elements.cryo, 1.6)
      : ToonMaterials.lantern(PALETTE.elements.cryo, 1.9);
    for (const c of CRYSTALS.spots) {
      let mesh: Mesh;
      if (crystalProp) {
        mesh = new Mesh(crystalProp.geometry, mat);
        mesh.position.set(c.x, snow.getHeight(c.x, c.z) - 0.05, c.z);
        mesh.rotation.y = (c.x * 5.7 + c.z * 2.9) % 6.28;
        mesh.castShadow = true;
      } else {
        mesh = new Mesh(new OctahedronGeometry(0.34, 0), mat);
        mesh.position.set(c.x, snow.getHeight(c.x, c.z) + 0.65, c.z);
      }
      this.group.add(mesh);
      this.crystals.push({ x: c.x, z: c.z, mesh, taken: false });
    }

    this.group.traverse((o) => {
      o.frustumCulled = false;
    });
    scene.add(this.group);
  }

  fixedUpdate(): void {
    this.promptLabel = null;
    if (this.ride.promptLabel !== null || this.ride.aboard) return; // le train a la priorité sur F
    this.player.worldPosition(_pw);
    const range = HUD.interactRangeM + 0.6;

    // Brasero le plus proche en portée
    let bi = -1;
    let bd = Infinity;
    for (let i = 0; i < this.braziers.length; i++) {
      const b = this.braziers[i]!;
      const d = Math.hypot(_pw.x - b.x, _pw.z - b.z);
      if (d < range + 1.0 && d < bd) {
        bd = d;
        bi = i;
      }
    }
    if (bi >= 0) {
      const lit = this.cold.brazierLit[bi]!;
      if (!lit) {
        this.promptLabel = 'Allumer le brasero';
        if (this.input.wasPressed('KeyF')) {
          this.cold.brazierLit[bi] = true;
          this.cold.lastLitIndex = bi;
          this.braziers[bi]!.fire.setActive(true);
          this.events.emit({ type: 'brazierLit', x: this.braziers[bi]!.x, z: this.braziers[bi]!.z });
          console.info(`[Brazier] allumé #${bi}`);
        }
        return;
      }
      if (!this.combat.infusion) {
        this.promptLabel = 'Embraser la lame';
        if (this.input.wasPressed('KeyF')) {
          this.combat.infuse('pyro', REACTIONS.infusionS);
          this.onInfusion?.();
        }
        return;
      }
    }

    // Cristal en portée
    for (const c of this.crystals) {
      if (c.taken) continue;
      if (Math.hypot(_pw.x - c.x, _pw.z - c.z) < CRYSTALS.pickupR) {
        this.promptLabel = 'Ramasser le cristal';
        if (this.input.wasPressed('KeyF')) {
          c.taken = true;
          c.mesh.visible = false;
          this.crystalsFound++;
          this.onCrystals?.(this.crystalsFound, CRYSTALS.count);
          console.info(`[Crystal] ${this.crystalsFound}/${CRYSTALS.count}`);
        }
        return;
      }
    }

    // Coffre du boss
    if (this.chest && !this.chest.opened) {
      if (Math.hypot(_pw.x - this.chest.x, _pw.z - this.chest.z) < range + 0.6) {
        this.promptLabel = 'Ouvrir le coffre';
        if (this.input.wasPressed('KeyF')) {
          this.chest.opened = true;
          this.chest.mesh.rotation.x = -0.9; // couvercle basculé
          this.crystalsFound = Math.min(CRYSTALS.count, this.crystalsFound + 2);
          this.onCrystals?.(this.crystalsFound, CRYSTALS.count);
          this.onChest?.();
          console.info('[Chest] ouvert (+2 cristaux)');
        }
      }
    }
  }

  update(dt: number): void {
    this.t += dt;
    // Cristaux : rotation + bob doux (repli octaèdre seulement — un amas
    // rocheux posé au sol qui tourne lirait comme un bug) ; flammes : flicker
    if (!this.crystalIsProp) {
      for (let i = 0; i < this.crystals.length; i++) {
        const c = this.crystals[i]!;
        if (c.taken) continue;
        c.mesh.rotation.y = this.t * 0.9 + i;
        c.mesh.position.y += Math.sin(this.t * 2 + i * 1.7) * 0.0012;
      }
    }
    for (const b of this.braziers) b.fire.update(dt);
  }
}

const _pw = new Vector3();
