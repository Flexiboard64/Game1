import { BoxGeometry, Group, Mesh, Scene, Vector3 } from 'three/webgpu';
import { ARENA, PALETTE, WRECK } from '../config';
import { ToonMaterials } from '../materials/ToonMaterials';
import type { CircleObstacle, ObstacleGrid } from '../world/Obstacles';
import type { SnowField } from '../world/SnowField';
import type { Updatable } from '../core/Engine';
import type { CharacterController } from '../player/CharacterController';
import type { CombatSystem } from '../combat/CombatSystem';
import type { BossEnemy } from '../combat/BossEnemy';
import type { InteractionManager } from './Interactions';

// Arène du boss (M6) : trigger circulaire près de l'épave — entrer réveille
// l'Automate et dresse un ANNEAU de piliers de glace (obstacles amovibles).
// Mort du joueur → reset propre (murs fondus, boss rendormi PV pleins, jamais
// de re-lock en boucle). Victoire → murs fondus + COFFRE (interactions F).

export class ArenaController implements Updatable {
  private active = false;
  private chestSpawned = false;
  private readonly wallGroup = new Group();
  private readonly wallObstacles: CircleObstacle[] = [];

  constructor(
    private readonly scene: Scene,
    private readonly player: CharacterController,
    private readonly combat: CombatSystem,
    private readonly boss: BossEnemy | null,
    private readonly interactions: InteractionManager,
    snow: SnowField,
    private readonly obstacles: ObstacleGrid | null,
  ) {
    if (!boss) return;
    // Piliers de glace pré-construits, invisibles hors combat (compile au warmup)
    const mat = ToonMaterials.lantern(PALETTE.elements.cryo, 1.2);
    for (let i = 0; i < ARENA.wallCount; i++) {
      const a = (i / ARENA.wallCount) * Math.PI * 2;
      const x = WRECK.arena.x + Math.sin(a) * ARENA.wallR;
      const z = WRECK.arena.z + Math.cos(a) * ARENA.wallR;
      const pillar = new Mesh(new BoxGeometry(1.7, ARENA.wallH, 1.7), mat);
      pillar.position.set(x, snow.getHeight(x, z) + ARENA.wallH / 2 - 0.3, z);
      pillar.rotation.y = a;
      this.wallGroup.add(pillar);
      this.wallObstacles.push({ x, z, r: 1.25 });
    }
    this.wallGroup.visible = false;
    this.wallGroup.traverse((o) => {
      o.frustumCulled = false;
    });
    scene.add(this.wallGroup);
  }

  fixedUpdate(): void {
    const boss = this.boss;
    if (!boss) return;
    this.player.worldPosition(_pw);
    const d = Math.hypot(_pw.x - WRECK.arena.x, _pw.z - WRECK.arena.z);

    if (!this.active) {
      if (boss.state === 'dormant' && this.combat.alive && d < ARENA.triggerR - 1.5) {
        this.active = true;
        boss.engage();
        this.setWalls(true);
        console.info('[Boss] arène verrouillée');
      }
      return;
    }

    // Mort du joueur : reset propre, PAS de re-lock tant qu'il n'est pas revenu
    if (!this.combat.alive) {
      this.active = false;
      boss.resetFight();
      this.setWalls(false);
      return;
    }
    // Victoire : murs fondus + coffre
    if (!boss.alive) {
      this.active = false;
      this.setWalls(false);
      if (!this.chestSpawned) {
        this.chestSpawned = true;
        this.spawnChest();
      }
    }
  }

  private setWalls(up: boolean): void {
    this.wallGroup.visible = up;
    for (const o of this.wallObstacles) {
      if (up) this.obstacles?.add(o);
      else this.obstacles?.remove(o);
    }
  }

  private spawnChest(): void {
    const x = WRECK.arena.x;
    const z = WRECK.arena.z;
    const y = this.wallGroup.children[0] ? this.wallGroup.children[0].position.y - ARENA.wallH / 2 + 0.3 : 4.4;
    const chest = new Group();
    const body = new Mesh(new BoxGeometry(1.2, 0.7, 0.8), ToonMaterials.stationWood());
    body.position.y = 0.35;
    const lid = new Mesh(new BoxGeometry(1.24, 0.3, 0.84), ToonMaterials.trainBrass());
    lid.position.y = 0.82;
    const glow = new Mesh(new BoxGeometry(1.0, 0.08, 0.6), ToonMaterials.lantern(PALETTE.gold, 2.2));
    glow.position.y = 0.72;
    chest.add(body, lid, glow);
    chest.position.set(x, y, z);
    chest.traverse((o) => {
      o.frustumCulled = false;
    });
    this.scene.add(chest);
    this.interactions.chest = { x, z, mesh: lid, opened: false };
    console.info('[Boss] coffre apparu');
  }
}

const _pw = new Vector3();
