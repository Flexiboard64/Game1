import { Vector3 } from 'three/webgpu';
import type { Object3D, PerspectiveCamera } from 'three/webgpu';
import { COMBAT, HUD } from '../../config';
import type { Updatable } from '../../core/Engine';
import type { InputManager } from '../../core/InputManager';
import type { CharacterController } from '../../player/CharacterController';
import type { ThirdPersonCamera } from '../../player/ThirdPersonCamera';
import type { Terrain } from '../../world/Terrain';
import type { HeightField } from '../../world/HeightField';
import type { CombatSystem } from '../../combat/CombatSystem';
import type { EnemyManager } from '../../combat/EnemyManager';
import type { CombatEvents } from '../../combat/CombatEvents';
import type { RideController } from '../../train/RideController';
import { Minimap } from './Minimap';
import { QuestTracker } from './QuestTracker';
import { PartySlots } from './PartySlots';
import { SkillButtons } from './SkillButtons';
import { StaminaWheel } from './StaminaWheel';
import { RegionTitle } from './RegionTitle';
import { MenuBar } from './MenuBar';
import { ChatHint } from './ChatHint';
import { InteractHint } from './InteractHint';
import { EnemyHealthBars } from './EnemyHealthBars';
import { DamageNumbers } from './DamageNumbers';
import { DeathVeil, DamageVignette } from './DeathVeil';
import { ColdGauge } from './ColdGauge';
import { BossBar } from './BossBar';

export interface HudContext {
  player: CharacterController;
  orbit: ThirdPersonCamera;
  camera: PerspectiveCamera;
  questPos: Vector3;
  portraitUrl: string | null;
  /** Transform visuelle interpolée du modèle (≠ état 60 Hz brut du contrôleur). */
  playerVisual: Object3D;
  /** Canopées d'arbres pour la minimap (blobs peints). */
  minimapTrees: readonly { x: number; z: number; r: number }[];
  /** Ancres des mufliers — prompt « F » décoratif à l'approche. */
  snapdragonAnchors: readonly Vector3[];
  /** Combat (M4) : le HUD TIRE l'état — le combat n'écrit jamais le DOM. */
  combat: CombatSystem;
  enemies: EnemyManager;
  events: CombatEvents;
  /** Chevauchée du train (M5) — prompt F prioritaire. */
  ride: RideController;
  /** Région Snezhnaya (M6) : 2e carte de la minimap + repères. */
  snowMap?: {
    snow: import('../../world/SnowField').SnowField;
    track: import('../../world/TrackSpec').TrackSpec;
    buildings: readonly { x: number; z: number; r: number }[];
  };
  /** Froid mordant (M6) : le HUD tire la jauge. */
  cold?: { readonly cold01: number };
  /** Interactions F de Snezhnaya (braseros/cristaux/coffre). */
  interactions?: { readonly promptLabel: string | null };
  /** Boss d'arène (barre top-centre). */
  boss?: import('../../combat/BossEnemy').BossEnemy | null;
  /** Quête M7 (prompts F) — attaché APRÈS construction via setQuest. */
  quest?: { readonly promptLabel: string | null };
  /** Exploration M7.3 (stèles/agates/défi) — dernier de la chaîne F. */
  explo?: { readonly promptLabel: string | null };
}

// Racine du HUD : overlay plein écran en pointer-events:none (les clics
// atteignent toujours le canvas). Chaque composant possède son élément et
// est mis à jour à pas variable.

export class Hud implements Updatable {
  readonly root: HTMLDivElement;
  private readonly minimap: Minimap;
  private readonly quest: QuestTracker;
  private readonly interact: InteractHint;
  private readonly stamina: StaminaWheel;
  readonly skills: SkillButtons; // public : le système audio s'abonne à onCue
  private readonly menuBar: MenuBar;
  private readonly party: PartySlots;
  private readonly enemyBars: EnemyHealthBars;
  private readonly dmgNumbers: DamageNumbers;
  private readonly deathVeil: DeathVeil;
  private readonly vignette: DamageVignette;
  private readonly coldGauge: ColdGauge;
  private readonly bossBar: BossBar;
  readonly regionTitle: RegionTitle;
  private readonly veil: HTMLDivElement;

  constructor(
    private readonly ctx: HudContext,
    terrain: Terrain,
    ground: HeightField,
    input: InputManager,
  ) {
    this.root = document.createElement('div');
    this.root.id = 'hud';
    document.body.appendChild(this.root);

    this.minimap = new Minimap(this.root, terrain, ground, ctx.minimapTrees, ctx.snowMap);
    this.quest = new QuestTracker(this.root, ctx.questPos);
    this.interact = new InteractHint(this.root, ctx.snapdragonAnchors);
    this.party = new PartySlots(this.root, ctx.portraitUrl);
    this.skills = new SkillButtons(this.root);
    this.stamina = new StaminaWheel(this.root);
    this.regionTitle = new RegionTitle(this.root);
    this.menuBar = new MenuBar(this.root);
    this.enemyBars = new EnemyHealthBars(this.root);
    this.dmgNumbers = new DamageNumbers(this.root);
    this.deathVeil = new DeathVeil();
    this.vignette = new DamageVignette();
    this.coldGauge = new ColdGauge(this.root);
    this.bossBar = new BossBar(this.root);
    new ChatHint(this.root); // décoratif, sans update()

    // Voile « Cliquer pour jouer » quand le pointeur n'est pas verrouillé
    this.veil = document.createElement('div');
    this.veil.id = 'pointer-veil';
    this.veil.innerHTML = '<span>Cliquer pour jouer</span>';
    document.body.appendChild(this.veil);
    input.onPointerLockChange = (locked) => {
      this.veil.classList.toggle('visible', !locked);
      if (!locked) this.veil.querySelector('span')!.textContent = 'Cliquer pour reprendre';
    };
    this.veil.classList.add('visible');
  }

  /** Objectif de quête dynamique (compteur de cristaux M6, quête M7). */
  setQuestObjective(text: string): void {
    this.quest.setObjective(text);
  }

  /** Attache le QuestSystem (construit APRÈS le HUD — chaîne de prompts F). */
  setQuest(quest: { readonly promptLabel: string | null }): void {
    this.ctx.quest = quest;
  }

  /** Attache l'Exploration M7.3 (stèles/agates/défi) — dernier de la chaîne F. */
  setExploration(explo: { readonly promptLabel: string | null }): void {
    this.ctx.explo = explo;
  }

  update(dt: number): void {
    const { player, orbit, camera, questPos, playerVisual, combat, enemies, events } = this.ctx;
    // La caméra vient d'être orientée par lookAt : rafraîchir matrixWorldInverse
    // AVANT les projections monde→écran, sinon la roue d'endurance traîne d'une
    // frame de rotation pendant les panoramiques rapides
    camera.updateMatrixWorld();
    this.minimap.update(orbit, playerVisual);
    // Position MONDE composée (à bord du train, player.position est locale au wagon)
    const playerWorld = player.worldPosition(_playerWorld);
    this.quest.update(dt, playerWorld, questPos);
    this.interact.setOverride(
      this.ctx.ride.promptLabel ?? this.ctx.interactions?.promptLabel ?? this.ctx.quest?.promptLabel ?? this.ctx.explo?.promptLabel ?? null,
    );
    this.coldGauge.update(this.ctx.cold?.cold01 ?? 0);
    this.bossBar.update(this.ctx.boss ?? null);
    this.interact.update(playerWorld);
    this.stamina.update(dt, player, camera, playerVisual.position);
    this.skills.update(dt, {
      cooldown: combat.cooldownE,
      cooldownMax: HUD.skillCooldownS,
      energy01: combat.energy / COMBAT.energyMax,
    });
    this.menuBar.update(dt);
    this.party.setHp(combat.hp / COMBAT.playerHp);
    this.enemyBars.update(camera, enemies);

    // Événements sim→rendu du combat (la file est vidée par le système final)
    for (const ev of events.list) {
      switch (ev.type) {
        case 'hit':
          this.dmgNumbers.spawn(String(ev.dmg), ev.x, ev.y + 0.35, ev.z, ev.crit ? 'crit' : ev.skill ? 'anemo' : 'normal');
          break;
        case 'playerHit':
          this.vignette.flash();
          this.party.flashDamage();
          this.dmgNumbers.spawn(`-${ev.dmg}`, playerVisual.position.x, playerVisual.position.y + 1.95, playerVisual.position.z, 'player');
          break;
        case 'skillCast':
          this.skills.flashSkill();
          break;
        case 'burstCast':
          this.skills.flashBurst();
          break;
        case 'playerDeath':
          this.deathVeil.show();
          break;
        case 'playerRespawn':
          this.deathVeil.hide();
          break;
        default:
          break;
      }
    }
    this.dmgNumbers.update(dt, camera);
    this.vignette.update(dt, combat.hp / COMBAT.playerHp);
  }
}

const _playerWorld = new Vector3();
