import { BoxGeometry, CylinderGeometry, Mesh, OctahedronGeometry, Scene, Vector3 } from 'three/webgpu';
import { AdditiveBlending, DoubleSide, MeshBasicNodeMaterial } from 'three/webgpu';
import { color, mix, mx_noise_float, smoothstep, time, uniform, uv, vec2 } from 'three/tsl';
import { BELVEDERE, HUD, PALETTE, QUEST7 } from '../config';
import { ToonMaterials } from '../materials/ToonMaterials';
import type { Updatable } from '../core/Engine';
import type { InputManager } from '../core/InputManager';
import type { CharacterController } from '../player/CharacterController';
import type { SnowField } from '../world/SnowField';
import type { WindColumns } from '../world/WindColumns';
import type { EnemyManager } from '../combat/EnemyManager';
import type { CombatSystem } from '../combat/CombatSystem';
import type { CombatEvents } from '../combat/CombatEvents';
import type { RideController } from '../train/RideController';
import type { Foe } from '../combat/Enemy';
import type { Dialogue } from './Dialogue';
import type { Npc } from './Npc';
import type { Seelie } from './Seelie';
import type { ResonancePuzzle } from './ResonancePuzzle';
import type { LoadedProp } from '../assets/PropLoader';

// Quête M7 « La Bénédiction des Vents du Nord » — première quête complète :
// FSM à 6 étapes, marqueur monde doré sur la cible courante, objectif +
// distance dans le tracker (via le Vector3 PARTAGÉ ctx.questPos), prompts F
// (chaîne ride > interactions > quête), pilier de lumière final, déblocage du
// PLANEUR. Canaris console [Quest] pour le test headless.

type Step = 'idle' | 'talk' | 'seelie' | 'resonance' | 'altar1' | 'ascent' | 'guardians' | 'altar2' | 'done';

const NADYA_INTRO = [
  { speaker: 'Nadya', text: 'Hé, toi ! C’est toi qui es descendue du train, n’est-ce pas ? On n’a plus vu d’étranger ici depuis des lunes…', voice: 'nadya-intro-1' },
  { speaker: 'Nadya', text: 'Je m’appelle Nadya, éclaireuse de Snezhnograd. Depuis quelques nuits, la Crevasse scintillante s’est… réveillée.', voice: 'nadya-intro-2' },
  {
    speaker: 'Nadya',
    text: 'Des lumières y dansent sous la glace, et les anciens parlent d’une bénédiction que les Vents du Nord n’accordent qu’aux âmes vaillantes.',
    voice: 'nadya-intro-3',
    choices: ['Alors montrez-moi cette crevasse.', 'Et quel prix demande cette bénédiction ?'],
    choiceVoices: ['aeliana-choice-1', 'aeliana-choice-2'],
  },
  { speaker: 'Nadya', text: 'Ha ! Voilà une réponse d’aventurière. Ici, quand le blizzard souffle une lune entière, on apprend à ne jamais cesser de marcher — la bénédiction ne coûte rien, sinon du courage.', voice: 'nadya-intro-3b' },
  { speaker: 'Nadya', text: 'On raconte que la Tsaritsa elle-même, du fond de son palais d’hiver, prête l’oreille à ce que murmurent ces vents-là. Alors tâche de leur faire bonne impression.', voice: 'nadya-intro-3c' },
  { speaker: 'Aeliana', text: 'Une bénédiction des vents ? Dans une crevasse de glace ?', voice: 'aeliana-intro-4' },
  { speaker: 'Nadya', text: 'Les échos gelés doivent être éveillés dans l’ordre, avant que le blizzard ne les rendorme. Ensuite… les vents décideront.', voice: 'nadya-intro-5' },
  { speaker: 'Nadya', text: 'Une Luciole de givre te montrera le chemin. Suis-la — et ne la perds pas dans la tempête !', voice: 'nadya-intro-6' },
] as const;

const NADYA_DONE = [
  { speaker: 'Nadya', text: 'Tu… tu as volé ! Les Vents du Nord t’ont vraiment choisie. Snezhnograd se souviendra de toi, Aeliana.', voice: 'nadya-done-1' },
] as const;

export class QuestSystem implements Updatable {
  promptLabel: string | null = null;
  step: Step = 'idle';
  /** Boost de blizzard pendant la résonance (lu par main → SnowfallField). */
  envBoost = 0;
  /** Hook audio : les gardiens apparaissent au belvédère. */
  onGuardians: (() => void) | null = null;

  private readonly marker: Mesh;
  private readonly pillar: Mesh;
  private readonly uPillar = uniform(0);
  private pillarT = -1;
  private guardians: Foe[] = [];
  private t = 0;

  constructor(
    scene: Scene,
    private readonly input: InputManager,
    private readonly player: CharacterController,
    private readonly ride: RideController,
    private readonly interactions: { readonly promptLabel: string | null },
    private readonly dialogue: Dialogue,
    private readonly npc: Npc,
    private readonly seelie: Seelie,
    private readonly puzzle: ResonancePuzzle,
    private readonly windCols: WindColumns,
    private readonly enemies: EnemyManager,
    private readonly combat: CombatSystem,
    private readonly events: CombatEvents,
    private readonly snow: SnowField,
    /** Vector3 PARTAGÉ avec le HUD (distance du tracker). */
    private readonly questPos: Vector3,
    private readonly setObjective: (text: string) => void,
    private readonly showToast: (title: string, subtitle: string) => void,
    altarProp: LoadedProp | null = null,
  ) {
    // Marqueur de cible : losange doré flottant (suit la cible courante)
    this.marker = new Mesh(new OctahedronGeometry(0.3, 0), ToonMaterials.lantern(PALETTE.gold, 2.4));
    this.marker.frustumCulled = false;
    scene.add(this.marker);

    // Pilier de lumière final : TOUJOURS compilé (uniform ×0), or → cyan
    const mat = new MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
      fog: false,
    });
    const u = uv();
    const bands = mx_noise_float(vec2(u.x.mul(5), u.y.mul(2.4).sub(time.mul(1.4)))).mul(0.5).add(0.5);
    const taper = smoothstep(0.0, 0.1, u.y).mul(smoothstep(0.5, 1.0, u.y).oneMinus());
    mat.colorNode = mix(color(PALETTE.gold), color(PALETTE.elements.cryo), u.y).mul(2.4);
    mat.opacityNode = bands.mul(taper).mul(0.85).mul(this.uPillar);
    this.pillar = new Mesh(new CylinderGeometry(1.6, 2.4, 34, 16, 1, true), mat);
    const ay = snow.getHeight(QUEST7.altarBelvedere.x, QUEST7.altarBelvedere.z);
    this.pillar.position.set(QUEST7.altarBelvedere.x, ay + 17, QUEST7.altarBelvedere.z);
    this.pillar.frustumCulled = false;
    scene.add(this.pillar);

    // ---- Autels + ARCHE DE GLACE du belvédère — M7.1 : vrai GLB Meshy
    // (socle sculpté + cristal flottant), repli procédural si absent ----
    const stone = ToonMaterials.masonry();
    const altarMat = altarProp
      ? ToonMaterials.glowProp(altarProp.material.map ?? null, PALETTE.elements.cryo, 0.28)
      : null;
    const buildAltar = (x: number, z: number): void => {
      const y = snow.getHeight(x, z);
      if (altarProp && altarMat) {
        const mesh = new Mesh(altarProp.geometry, altarMat);
        mesh.position.set(x, y - 0.05, z);
        mesh.castShadow = true;
        mesh.frustumCulled = false;
        scene.add(mesh);
        return;
      }
      const base = new Mesh(new BoxGeometry(1.5, 0.5, 1.5), stone);
      base.position.set(x, y + 0.25, z);
      const column = new Mesh(new BoxGeometry(0.7, 0.9, 0.7), stone);
      column.position.set(x, y + 0.95, z);
      const gem = new Mesh(new OctahedronGeometry(0.3, 0), ToonMaterials.lantern(PALETTE.elements.cryo, 2.0));
      gem.position.set(x, y + 1.65, z);
      for (const m of [base, column, gem]) {
        m.castShadow = true;
        m.frustumCulled = false;
        scene.add(m);
      }
    };
    buildAltar(QUEST7.altarCrevasse.x, QUEST7.altarCrevasse.z);
    buildAltar(QUEST7.altarBelvedere.x, QUEST7.altarBelvedere.z);
    // Arche de glace : anneau de voussoirs cryo au-dessus de l'autel final
    {
      const iceMat = ToonMaterials.iceBlock();
      const ax = QUEST7.altarBelvedere.x;
      const az = QUEST7.altarBelvedere.z;
      const ay = snow.getHeight(ax, az);
      const R = 3.4;
      for (let v = 0; v < 9; v++) {
        const th = (Math.PI * (12 + (156 * v) / 8)) / 180;
        const seg = new Mesh(new BoxGeometry(0.55, 0.55, 1.35), iceMat);
        seg.position.set(ax + Math.cos(th) * R, ay + 0.4 + Math.sin(th) * R, az);
        seg.rotation.z = th - Math.PI / 2;
        seg.rotation.y = 0.2;
        seg.frustumCulled = false;
        scene.add(seg);
      }
    }

    this.setTarget(this.npc.position.x, this.npc.position.y + 1, this.npc.position.z);
    this.setObjective('Parlez à Nadya, l’éclaireuse de Snezhnograd');
    this.step = 'talk';
    console.info('[Quest] disponible : parlez à Nadya');
  }

  private setTarget(x: number, y: number, z: number): void {
    this.questPos.set(x, y, z);
  }

  fixedUpdate(dt: number): void {
    void dt;
    this.promptLabel = null;
    if (this.ride.promptLabel !== null || this.ride.aboard) {
      if (this.dialogue.open) this.closeDialogueGuard();
      return;
    }
    // Les interactions M6 (braseros/cristaux/coffre) gardent la priorité sur F
    if (!this.dialogue.open && this.interactions.promptLabel !== null) return;
    this.player.worldPosition(_pw);
    const range = HUD.interactRangeM + 0.8;

    // Dialogue ouvert : F avance (ou prend la 1re réponse), 1/2 choisissent
    if (this.dialogue.open) {
      this.promptLabel = 'Continuer';
      if (this.input.wasPressed('Digit1')) this.dialogue.choose(0);
      else if (this.input.wasPressed('Digit2')) this.dialogue.choose(1);
      else if (this.input.wasPressed('KeyF')) this.dialogue.advance();
      return;
    }

    switch (this.step) {
      case 'talk': {
        if (Math.hypot(_pw.x - this.npc.position.x, _pw.z - this.npc.position.z) < range + 0.6) {
          this.promptLabel = 'Parler à Nadya';
          if (this.input.wasPressed('KeyF') && this.combat.phase === 'idle') {
            this.player.setCombatDrive(true, this.player.heading); // gèle le déplacement
            this.npc.setState({ talking: true, marker: false });
            this.dialogue.start(NADYA_INTRO, () => {
              this.player.setCombatDrive(false);
              this.npc.setState({ talking: false });
              this.seelie.begin();
              this.step = 'seelie';
              this.setObjective('Suivez la Luciole de givre');
              console.info('[Quest] étape : suivre la luciole');
            });
          }
        }
        break;
      }

      case 'seelie': {
        this.setTarget(this.seelie.group.position.x, this.seelie.group.position.y, this.seelie.group.position.z);
        if (this.seelie.arrived
          && Math.hypot(_pw.x - this.seelie.group.position.x, _pw.z - this.seelie.group.position.z) < 14) {
          this.step = 'resonance';
          this.seelie.group.visible = false;
          this.setObjective('Éveillez les 4 cristaux de résonance');
          console.info('[Quest] étape : résonance');
        }
        break;
      }

      case 'resonance': {
        this.envBoost = 1; // le blizzard force pendant la séquence
        const i = this.puzzle.nearestUnlit(_pw.x, _pw.z, range);
        if (i >= 0) {
          this.promptLabel = 'Éveiller le cristal';
          if (this.input.wasPressed('KeyF')) this.puzzle.awaken(i);
        }
        if (this.puzzle.timeLeft > 0) {
          this.setObjective(`Éveillez les cristaux · ${Math.ceil(this.puzzle.timeLeft)} s`);
        }
        // Cible : prochain cristal éteint (ou l'autel si résolu)
        const n = this.puzzle.nearestUnlit(_pw.x, _pw.z, 1e9);
        if (n >= 0) {
          const c = QUEST7.crystals[n]!;
          this.setTarget(c.x, this.snow.getHeight(c.x, c.z) + 1.4, c.z);
        }
        if (this.puzzle.solved) {
          this.envBoost = 0;
          this.step = 'altar1';
          this.setObjective('Touchez l’autel au fond de la crevasse');
          console.info('[Quest] étape : autel de la crevasse');
        }
        break;
      }

      case 'altar1': {
        const a = QUEST7.altarCrevasse;
        this.setTarget(a.x, this.snow.getHeight(a.x, a.z) + 1.2, a.z);
        if (Math.hypot(_pw.x - a.x, _pw.z - a.z) < range + 0.6) {
          this.promptLabel = 'Invoquer les Vents du Nord';
          if (this.input.wasPressed('KeyF')) {
            this.windCols.activate();
            this.step = 'ascent';
            this.setObjective('Laissez les vents vous porter jusqu’au Belvédère du Nord');
            console.info('[Quest] étape : ascension');
          }
        }
        break;
      }

      case 'ascent': {
        this.setTarget(BELVEDERE.x, BELVEDERE.topY + 2, BELVEDERE.z);
        const onTop = Math.hypot(_pw.x - BELVEDERE.x, _pw.z - BELVEDERE.z) < BELVEDERE.r + 2
          && _pw.y > BELVEDERE.topY - 1.5 && this.player.grounded;
        if (onTop) {
          this.spawnGuardians();
          this.onGuardians?.();
          this.step = 'guardians';
          this.setObjective('Chassez les esprits du sommet');
          console.info('[Quest] étape : gardiens');
        }
        break;
      }

      case 'guardians': {
        const alive = this.guardians.filter((g) => g.alive);
        if (alive.length > 0) {
          const g = alive[0]!;
          this.setTarget(g.position.x, g.position.y + 1.6, g.position.z);
        } else {
          this.step = 'altar2';
          this.setObjective('Recevez la Bénédiction des Vents');
          console.info('[Quest] étape : autel du belvédère');
        }
        break;
      }

      case 'altar2': {
        const a = QUEST7.altarBelvedere;
        this.setTarget(a.x, this.snow.getHeight(a.x, a.z) + 1.4, a.z);
        if (Math.hypot(_pw.x - a.x, _pw.z - a.z) < range + 1.0) {
          this.promptLabel = 'Recevoir la Bénédiction';
          if (this.input.wasPressed('KeyF')) {
            this.pillarT = 0;
            this.player.unlockGlider();
            this.showToast('Aile de Givre obtenue', 'Maintenez ESPACE en l’air pour planer');
            this.setObjective('Quête accomplie — les vents vous appartiennent');
            this.step = 'done';
            this.events.emit({ type: 'brazierLit', x: a.x, z: a.z }); // sparkles gratuits
            console.info('[Quest] ACCOMPLIE — planeur débloqué');
            // Épilogue à la prochaine visite de Nadya (marqueur discret)
            this.npc.setState({ marker: false });
            this.dialogue.start(NADYA_DONE, () => undefined);
          }
        }
        break;
      }

      case 'done':
      case 'idle':
        break;
    }
  }

  private spawnGuardians(): void {
    if (this.guardians.length > 0) return;
    // Réutilise les templates du manager : 2 wraiths gardiens éphémères
    const made = this.enemies.spawnQuestWraiths(QUEST7.guardianSpawns);
    this.guardians = made;
    console.info(`[Quest] ${made.length} gardiens invoqués`);
  }

  update(dt: number): void {
    this.t += dt;
    // Marqueur : flotte + tourne au-dessus de la cible courante
    this.marker.position.copy(this.questPos);
    this.marker.position.y += 0.5 + Math.sin(this.t * 2.2) * 0.12;
    this.marker.rotation.y = this.t * 1.8;
    this.marker.visible = this.step !== 'done' && this.step !== 'idle';
    // Pilier de lumière : monte 0,6 s, tient 2,5 s, s'éteint
    if (this.pillarT >= 0) {
      this.pillarT += dt;
      const v = this.pillarT < 0.6 ? this.pillarT / 0.6 : this.pillarT < 3.1 ? 1 : 1 - (this.pillarT - 3.1) / 1.2;
      this.uPillar.value = Math.max(0, Math.min(1, v));
      if (this.pillarT > 4.4) this.pillarT = -1;
    } else {
      this.uPillar.value = 0;
    }
  }

  private closeDialogueGuard(): void {
    // Sécurité : embarquement pendant un dialogue (impossible en pratique —
    // Nadya est loin du quai) : on referme proprement
    this.dialogue.advance();
  }
}

const _pw = new Vector3();
