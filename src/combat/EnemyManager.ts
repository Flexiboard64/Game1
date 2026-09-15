import { AnimationAction, AnimationMixer, Group, Mesh, Object3D, Scene, Vector3 } from 'three/webgpu';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { CAMP, ENEMY, FROST_GOLEM, OPERATIVE, SNOWCAMP, VOLKODLAK } from '../config';
import { assembleCharacter, type GolemClipName } from '../assets/CharacterLoader';
import { ToonMaterials } from '../materials/ToonMaterials';
import { ClipPlayer } from './ClipPlayer';
import { Enemy, type EnemyStats, type Foe } from './Enemy';
import { WraithEnemy } from './WraithEnemy';
import type { Element } from './Elements';
import type { GolemAssets, SnowEnemyAssets } from '../core/AssetManager';
import type { LoadedProp } from '../assets/PropLoader';
import type { CombatGround } from '../world/GroundSource';
import type { ObstacleGrid } from '../world/Obstacles';
import type { CampField } from '../world/CampField';
import type { CharacterController } from '../player/CharacterController';
import type { CombatEvents } from './CombatEvents';
import type { CombatSystem } from './CombatSystem';
import type { ProjectileManager } from './ProjectileManager';
import type { Updatable } from '../core/Engine';

// Flotte d'ennemis : UN assemblage template PAR ARCHÉTYPE (fusion des clips
// Meshy) puis SkeletonUtils.clone par instance — clips partagés entre mixers,
// matériaux PAR CLONE (uniforms dissolve/hitFlash indépendants). M6 : golems de
// la vallée + créatures de Snezhnaya (volkodlaks remappés sur les slots golem,
// opératifs Fatui, golems de givre reteintés, wraiths sans rig). FSM en pas
// fixe, mixers + interpolation visuelle en pas variable, séparation O(N²).

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface MeleeTemplate {
  assembled: ReturnType<typeof assembleCharacter<GolemClipName>>;
  stats: EnemyStats;
  element: Element;
  aura: Element | null;
  /** Teinte du liseré de dissolution (anémo par défaut, cryo pour le givre). */
  edgeTint?: string;
}

export class EnemyManager implements Updatable {
  readonly enemies: Foe[] = [];
  private combat: CombatSystem | null = null;
  private readonly templates = new Map<string, MeleeTemplate>();

  constructor(
    private readonly scene: Scene,
    golem: GolemAssets | null,
    camps: CampField,
    private readonly player: CharacterController,
    private readonly ground: CombatGround,
    private readonly obstacles: ObstacleGrid | null,
    private readonly events: CombatEvents,
    fightFlag: boolean,
    snowEnemies: SnowEnemyAssets | null = null,
    private readonly wraithProp: LoadedProp | null = null,
    private readonly projectiles: ProjectileManager | null = null,
  ) {
    const rand = mulberry32(CAMP.seed + 999);

    // ---- Templates par archétype (1 assemblage, N clones) ----
    if (golem) {
      const assembled = assembleCharacter<GolemClipName>(golem.rigged, golem.clips, { targetHeight: ENEMY.heightM });
      this.templates.set('golem', { assembled, stats: ENEMY, element: 'physical', aura: null });
      // Golem de givre (0 crédit) : même rig, stats renforcées, aura Cryo
      this.templates.set('frostGolem', { assembled, stats: FROST_GOLEM, element: 'cryo', aura: 'cryo', edgeTint: '#9FD6E3' });
    }
    if (snowEnemies?.volkodlak) {
      const c = snowEnemies.volkodlak.clips;
      // REMAP sur les 6 slots golem : chase = clip RUN, roar = HOWL
      const assembled = assembleCharacter<GolemClipName>(snowEnemies.volkodlak.rigged, {
        idle: c.idle, walk: c.run ?? c.walk, roar: c.howl, attack: c.attack, hit: c.hit, death: c.death,
      }, { targetHeight: VOLKODLAK.heightM });
      this.templates.set('volkodlak', { assembled, stats: VOLKODLAK, element: 'cryo', aura: 'cryo', edgeTint: '#9FD6E3' });
    }
    if (snowEnemies?.operative) {
      const c = snowEnemies.operative.clips;
      // roar = clip PARADE (posture d'aggro ET état parry)
      const assembled = assembleCharacter<GolemClipName>(snowEnemies.operative.rigged, {
        idle: c.idle, walk: c.walk, roar: c.parry, attack: c.attack, hit: c.hit, death: c.death,
      }, { targetHeight: OPERATIVE.heightM });
      this.templates.set('operative', { assembled, stats: OPERATIVE, element: 'cryo', aura: 'cryo', edgeTint: '#9FD6E3' });
    }

    // ---- Vallée : camps de golems (M4, inchangé) ----
    const spawns = [...camps.slots];
    if (fightFlag) {
      // Golem de smoke test : 6 m devant le spawn, dans l'axe regardé au boot
      spawns.push({ x: 0, z: 6, heading: Math.PI, camp: -1 });
    }
    for (const sp of spawns) this.spawnMelee(scene, 'golem', sp, rand);

    // ---- Snezhnaya : packs autorés (canaris de validation au boot) ----
    if (snowEnemies) {
      const srand = mulberry32(SNOWCAMP.seed);
      let seeded = 0;
      for (const pack of SNOWCAMP.packs) {
        for (let i = 0; i < pack.n; i++) {
          const ang = srand() * Math.PI * 2;
          const r = pack.r * Math.sqrt(srand());
          const x = pack.x + Math.sin(ang) * r;
          const z = pack.z + Math.cos(ang) * r;
          const heading = srand() * Math.PI * 2;
          if (pack.kind === 'wraith') {
            if (this.spawnWraith(scene, wraithProp, { x, z, heading })) seeded++;
          } else if (this.templates.has(pack.kind)) {
            this.spawnMelee(scene, pack.kind, { x, z, heading, camp: 100 }, rand);
            seeded++;
          }
        }
      }
      console.info(`[SnowCamp] ${seeded} créatures semées (${SNOWCAMP.packs.length} packs)`);
    }
    console.info(`[EnemyManager] ${this.enemies.length} ennemis au total (${camps.camps.length} camps vallée)`);
  }

  /** Câblé après construction (cycle EnemyManager ↔ CombatSystem). */
  setCombat(combat: CombatSystem): void {
    this.combat = combat;
  }

  /** Enrôle un ennemi construit ailleurs (le boss d'arène). */
  add(foe: Foe): void {
    this.enemies.push(foe);
  }

  /** Gardiens de quête (M7) : wraiths invoqués à la volée au Belvédère. */
  spawnQuestWraiths(spawns: readonly { x: number; z: number }[]): Foe[] {
    const made: Foe[] = [];
    for (const sp of spawns) {
      if (this.spawnWraith(this.scene, this.wraithProp, { x: sp.x, z: sp.z, heading: 0 })) {
        made.push(this.enemies[this.enemies.length - 1]!);
      }
    }
    return made;
  }

  private spawnMelee(
    scene: Scene,
    kind: string,
    sp: { x: number; z: number; heading: number; camp: number },
    rand: () => number,
  ): void {
    const tpl = this.templates.get(kind);
    if (!tpl) return;
    const cloned = cloneSkeleton(tpl.assembled.skinnedScene) as Object3D;
    // Matériaux PAR CLONE : mêmes graphes de nœuds (cache de programme partagé),
    // uniforms indépendants (dissolution/flash de coup de CET ennemi)
    const set = ToonMaterials.golemSet(tpl.assembled.albedo, 0.012 / tpl.assembled.sceneScale, tpl.edgeTint);
    cloned.traverse((o: Object3D) => {
      if (!(o as Mesh).isMesh) return;
      const mesh = o as Mesh;
      // Skinnés jamais cullés : la bounding ne suit pas les os, et les camps
      // sont hors champ au warmup de compile (patron Waterfall)
      mesh.frustumCulled = false;
      if (o.userData.isOutline) mesh.material = set.outlineMaterial;
      else mesh.material = set.material;
    });
    const root = new Group();
    root.add(cloned);
    scene.add(root);

    const mixer = new AnimationMixer(cloned);
    const actions: Partial<Record<GolemClipName, AnimationAction>> = {};
    for (const [name, clip] of Object.entries(tpl.assembled.clips)) {
      if (clip) actions[name as GolemClipName] = mixer.clipAction(clip);
    }

    this.enemies.push(new Enemy(
      root, mixer, new ClipPlayer(actions), set,
      { x: sp.x, z: sp.z }, sp.heading, this.ground, this.obstacles, this.events, rand,
      tpl.stats, tpl.element, tpl.aura,
    ));
  }

  private spawnWraith(scene: Scene, prop: LoadedProp | null, sp: { x: number; z: number; heading: number }): boolean {
    if (!prop) return false;
    const set = ToonMaterials.golemSet(prop.material.map ?? null, 0.012, '#9FD6E3');
    const body = new Mesh(prop.geometry, set.material);
    body.frustumCulled = false;
    body.castShadow = false; // spectre : pas d'ombre (lisibilité + style)
    const root = new Group();
    root.add(body);
    scene.add(root);
    this.enemies.push(new WraithEnemy(
      root, body, set, { x: sp.x, z: sp.z }, sp.heading, this.ground, this.events, this.projectiles,
      mulberry32(SNOWCAMP.seed + Math.round(sp.x * 7 + sp.z * 13)),
    ));
    return true;
  }

  fixedUpdate(dt: number): void {
    if (this.enemies.length === 0) return;
    // Position MONDE composée : à bord du train, player.position est LOCALE au
    // wagon (≈ origine) — l'aggro viserait le spawn
    this.player.worldPosition(_playerWorld);
    const pl = {
      x: _playerWorld.x,
      z: _playerWorld.z,
      alive: this.combat ? this.combat.alive : true,
    };

    // Séparation douce O(N²) entre vivants (poussées consommées ce tick)
    for (let i = 0; i < this.enemies.length; i++) {
      const a = this.enemies[i]!;
      if (!a.alive) continue;
      for (let j = i + 1; j < this.enemies.length; j++) {
        const b = this.enemies[j]!;
        if (!b.alive) continue;
        const dx = b.position.x - a.position.x;
        const dz = b.position.z - a.position.z;
        const d = Math.hypot(dx, dz);
        const overlap = (a.radius + b.radius) * 1.3 - d;
        if (overlap <= 0 || d < 1e-4) continue;
        const px = (dx / d) * overlap * ENEMY.separationK;
        const pz = (dz / d) * overlap * ENEMY.separationK;
        a.addPush(-px, -pz);
        b.addPush(px, pz);
      }
      // L'ennemi cède devant le joueur (jamais traversé « en force »)
      const dxp = a.position.x - pl.x;
      const dzp = a.position.z - pl.z;
      const dp = Math.hypot(dxp, dzp);
      const ovp = ENEMY.separationR * 0.8 - dp;
      if (ovp > 0 && dp > 1e-4) a.addPush((dxp / dp) * ovp * ENEMY.separationK, (dzp / dp) * ovp * ENEMY.separationK);
    }

    const deal = (dmg: number, dirX: number, dirZ: number, element?: Element): void => {
      this.combat?.applyPlayerDamage(dmg, dirX, dirZ, element);
    };
    for (const e of this.enemies) e.fixedUpdate(dt, pl, deal);

    // Aggro de meute : un ennemi en chasse alerte ses voisins tranquilles
    for (const e of this.enemies) {
      if (e.state !== 'roar' && e.state !== 'chase' && e.state !== 'windup' && e.state !== 'hitstun' && e.state !== 'drift') continue;
      for (const m of this.enemies) {
        if (m === e || m.state !== 'idle') continue;
        if (Math.hypot(m.position.x - e.position.x, m.position.z - e.position.z) < ENEMY.packRange) m.alert();
      }
    }
  }

  update(dt: number, alpha: number): void {
    for (const e of this.enemies) e.applyVisual(alpha, dt);
  }

  /** Cible d'auto-aim : le vivant le plus proche dans un cône. */
  nearestInCone(x: number, z: number, axisRad: number, coneDeg: number, range: number): Foe | null {
    const halfCone = (coneDeg / 2) * (Math.PI / 180);
    let best: Foe | null = null;
    let bestD = Infinity;
    for (const e of this.enemies) {
      if (!e.alive) continue;
      const dx = e.position.x - x;
      const dz = e.position.z - z;
      const d = Math.hypot(dx, dz);
      if (d > range + e.radius || d >= bestD) continue;
      let dd = Math.atan2(dx, dz) - axisRad;
      while (dd > Math.PI) dd -= 2 * Math.PI;
      while (dd < -Math.PI) dd += 2 * Math.PI;
      if (Math.abs(dd) > halfCone) continue;
      best = e;
      bestD = d;
    }
    return best;
  }

  /** Balayage d'arc d'une attaque du joueur. */
  forEachAliveInArc(x: number, z: number, axisRad: number, range: number, arcDeg: number, cb: (e: Foe) => void): void {
    const halfArc = (arcDeg / 2) * (Math.PI / 180);
    for (const e of this.enemies) {
      if (!e.alive) continue;
      const dx = e.position.x - x;
      const dz = e.position.z - z;
      if (Math.hypot(dx, dz) > range + e.radius) continue;
      let dd = Math.atan2(dx, dz) - axisRad;
      while (dd > Math.PI) dd -= 2 * Math.PI;
      while (dd < -Math.PI) dd += 2 * Math.PI;
      if (Math.abs(dd) > halfArc) continue;
      cb(e);
    }
  }

  /** Ennemis vivants dans un rayon (ticks de la tornade Q). */
  forEachAliveInRadius(x: number, z: number, r: number, cb: (e: Foe) => void): void {
    for (const e of this.enemies) {
      if (!e.alive) continue;
      if (Math.hypot(e.position.x - x, e.position.z - z) <= r + e.radius) cb(e);
    }
  }

  /** Mort du joueur : tout le monde rentre au camp. */
  disengageAll(): void {
    for (const e of this.enemies) e.disengage();
  }
}

const _playerWorld = new Vector3();
