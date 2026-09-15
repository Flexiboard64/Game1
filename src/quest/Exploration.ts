import { BoxGeometry, Group, Mesh, OctahedronGeometry, PlaneGeometry, Scene, TorusGeometry, Vector3 } from 'three/webgpu';
import { EXPLORE7, HUD, PALETTE, QUEST7 } from '../config';
import { ToonMaterials } from '../materials/ToonMaterials';
import type { LoadedProp } from '../assets/PropLoader';
import type { Updatable } from '../core/Engine';
import type { InputManager } from '../core/InputManager';
import type { CharacterController } from '../player/CharacterController';
import type { RideController } from '../train/RideController';
import type { SnowField } from '../world/SnowField';
import type { Dialogue } from './Dialogue';

// Exploration M7.3 — éléments façon Genshin (recherches Dragonspine/Snezhnaya) :
// STÈLES de lore (F → dialogue, comme les tablettes de pierre de Dragonspine),
// AGATES DE GIVRE à collecter (Crimson Agate-like, 3 sont DANS les colonnes de
// vent) puis à OFFRIR à l'autel du belvédère (Arbre porte-givre-like) → coffre,
// et DÉFI DES VENTS chronométré au planeur (Time Trial : anneaux en descente).
// Dernier de la chaîne F : ride > interactions > quest > exploration.
// Canaris : [Tablet] [Agate] [Explore] [Trial].

interface FChain {
  readonly promptLabel: string | null;
}

export class Exploration implements Updatable {
  readonly group = new Group();
  promptLabel: string | null = null;
  agatesFound = 0;
  offered = false;
  trialState: 'idle' | 'run' | 'won' = 'idle';
  /** Sondes headless : positions exactes des agates (x,y,z). */
  readonly agates: { x: number; y: number; z: number; mesh: Mesh; taken: boolean }[] = [];
  /** Hooks audio (M8) — null-safe, à câbler plus tard. */
  onAgate: ((n: number) => void) | null = null;
  onTrialStart: (() => void) | null = null;
  onTrialRing: ((i: number) => void) | null = null;
  onTrialEnd: ((won: boolean) => void) | null = null;
  onChest: (() => void) | null = null;

  private readonly tablets: { x: number; z: number; yaw: number; title: string; lines: readonly string[] }[] = [];
  private readonly rings: { x: number; y: number; z: number; mesh: Mesh; passed: boolean }[] = [];
  private readonly totemPos = new Vector3();
  private chest: { x: number; z: number; group: Group; opened: boolean } | null = null;
  private trialLeft = 0;
  private readonly timerEl: HTMLDivElement;
  private t = 0;

  constructor(
    scene: Scene,
    private readonly input: InputManager,
    private readonly player: CharacterController,
    private readonly ride: RideController,
    private readonly interactions: FChain,
    private readonly quest: FChain,
    private readonly dialogue: Dialogue,
    private readonly snow: SnowField,
    private readonly showToast: (title: string, subtitle: string) => void,
    hudParent: HTMLElement,
    props: { stele: LoadedProp | null; totem: LoadedProp | null } = { stele: null, totem: null },
  ) {
    // ---- Stèles de lore — GLB Meshy (M9.1, runes peintes auto-émissives),
    // repli dalle masonry + faces runiques codées main ----
    if (props.stele) {
      const steleMat = ToonMaterials.glowProp(props.stele.material.map ?? null, '#8fd0e8', 0.4);
      for (const tb of EXPLORE7.tablets) {
        const y = snow.getHeight(tb.x, tb.z);
        const stele = new Mesh(props.stele.geometry, steleMat);
        stele.position.set(tb.x, y - 0.03, tb.z);
        stele.rotation.y = tb.yaw; // face runique vers l'axe d'approche (config)
        stele.castShadow = true;
        this.group.add(stele);
        this.tablets.push(tb);
      }
    } else {
      const slabMat = ToonMaterials.masonry();
      const runeMat = ToonMaterials.lantern('#8fd0e8', 1.2);
      for (const tb of EXPLORE7.tablets) {
        const y = snow.getHeight(tb.x, tb.z);
        const slab = new Mesh(new BoxGeometry(0.95, 1.35, 0.16), slabMat);
        slab.position.set(tb.x, y + 0.62, tb.z);
        slab.rotation.y = tb.yaw; // face runique vers l'axe d'approche (config)
        slab.rotation.z = 0.05;
        slab.castShadow = true;
        this.group.add(slab);
        // Runes sur LES DEUX faces (une stèle lisible ne doit jamais tourner le dos)
        for (const zc of [0.085, -0.085]) {
          const rune = new Mesh(new PlaneGeometry(0.62, 0.95), runeMat);
          rune.position.set(0, 0.04, zc);
          if (zc < 0) rune.rotation.y = Math.PI;
          slab.add(rune);
        }
        this.tablets.push(tb);
      }
    }

    // ---- Agates de givre (orbes flottants — ramassage au contact) ----
    const agateMat = ToonMaterials.lantern('#cfeeff', 2.6);
    for (const a of EXPLORE7.agates) {
      const y = snow.getHeight(a.x, a.z) + a.clearY;
      const mesh = new Mesh(new OctahedronGeometry(0.22, 0), agateMat);
      mesh.position.set(a.x, y, a.z);
      this.group.add(mesh);
      this.agates.push({ x: a.x, y, z: a.z, mesh, taken: false });
    }

    // ---- Défi des vents : totem + anneaux (compilés au warmup, échelle nulle) ----
    const T = EXPLORE7.trial;
    const ty = snow.getHeight(T.totem.x, T.totem.z);
    this.totemPos.set(T.totem.x, ty, T.totem.z);
    let gemY = ty + 2.55;
    if (props.totem) {
      // GLB Meshy (M9.1) : pilier cristallin gravé, facettes auto-émissives
      const totem = new Mesh(props.totem.geometry,
        ToonMaterials.glowProp(props.totem.material.map ?? null, '#9fdcf2', 0.3));
      totem.position.set(T.totem.x, ty - 0.03, T.totem.z);
      totem.castShadow = true;
      this.group.add(totem);
      gemY = ty + props.totem.height + 0.4; // la gemme animée plane AU-DESSUS du GLB
    } else {
      const pillar = new Mesh(new BoxGeometry(0.55, 2.1, 0.55), ToonMaterials.iceBlock());
      pillar.position.set(T.totem.x, ty + 1.05, T.totem.z);
      pillar.castShadow = true;
      this.group.add(pillar);
    }
    const gem = new Mesh(new OctahedronGeometry(0.26, 0), ToonMaterials.lantern(PALETTE.gold, 2.2));
    gem.position.set(T.totem.x, gemY, T.totem.z);
    gem.name = 'trial-gem';
    this.group.add(gem);

    const ringMat = ToonMaterials.lantern(PALETTE.gold, 1.6);
    let prevY: number = ty + 1.5;
    let prevX: number = T.totem.x;
    let prevZ: number = T.totem.z;
    for (let i = 0; i < T.rings.length; i++) {
      const r = T.rings[i]!;
      // Descente en CHAÎNE à finesse fixe — jamais relative au sol local
      const dist = Math.hypot(r.x - prevX, r.z - prevZ);
      let y = prevY - dist / T.glideRatio;
      const minY = snow.getHeight(r.x, r.z) + T.minClearY;
      if (y < minY) {
        console.warn(`[Trial] segment ${i} clampé au sol (+${(minY - y).toFixed(1)} m) — finesse dégradée`);
        y = minY;
      }
      const mesh = new Mesh(new TorusGeometry(1.5, 0.12, 8, 24), ringMat);
      mesh.position.set(r.x, y, r.z);
      // L'anneau fait face au segment qui l'amène (traversée naturelle en plané)
      mesh.rotation.y = Math.atan2(r.x - prevX, r.z - prevZ);
      mesh.scale.setScalar(1e-4);
      this.group.add(mesh);
      this.rings.push({ x: r.x, y, z: r.z, mesh, passed: false });
      prevX = r.x; prevY = y; prevZ = r.z;
    }

    this.group.traverse((o) => {
      o.frustumCulled = false;
    });
    scene.add(this.group);

    // Chrono DOM (style bandeau de défi Genshin)
    this.timerEl = document.createElement('div');
    this.timerEl.className = 'trial-timer';
    hudParent.appendChild(this.timerEl);
  }

  fixedUpdate(dt: number): void {
    this.promptLabel = null;
    this.t += dt;
    this.player.worldPosition(_pw);

    // Agates : ramassage au CONTACT (3D — trois se cueillent en plein vol)
    for (const a of this.agates) {
      if (a.taken) continue;
      const d = Math.hypot(_pw.x - a.x, _pw.y + 0.9 - a.y, _pw.z - a.z);
      if (d < EXPLORE7.agatePickupR) {
        a.taken = true;
        a.mesh.visible = false;
        this.agatesFound++;
        this.onAgate?.(this.agatesFound);
        console.info(`[Agate] ${this.agatesFound}/${EXPLORE7.agates.length}`);
        if (this.agatesFound === EXPLORE7.agates.length) {
          this.showToast('Agates de givre réunies', 'Offrez-les à l’autel du Belvédère');
        }
      }
    }

    // Défi en cours : chrono + anneaux (hors chaîne F)
    if (this.trialState === 'run') {
      this.trialLeft -= dt;
      for (let i = 0; i < this.rings.length; i++) {
        const r = this.rings[i]!;
        if (r.passed) continue;
        if (Math.hypot(_pw.x - r.x, _pw.y + 0.9 - r.y, _pw.z - r.z) < EXPLORE7.trial.ringR) {
          r.passed = true;
          r.mesh.scale.setScalar(1e-4);
          this.onTrialRing?.(i);
          console.info(`[Trial] anneau ${i + 1}/${this.rings.length}`);
        }
      }
      if (this.rings.every((r) => r.passed)) {
        this.trialState = 'won';
        this.onTrialEnd?.(true);
        console.info(`[Trial] RÉUSSI (${this.trialLeft.toFixed(1)} s restantes)`);
        this.showToast('Défi des vents réussi', 'Un trésor est apparu au pied du dernier anneau');
        if (!this.chest) this.spawnChest(this.rings[this.rings.length - 1]!.x, this.rings[this.rings.length - 1]!.z);
      } else if (this.trialLeft <= 0) {
        this.trialState = 'idle';
        for (const r of this.rings) r.mesh.scale.setScalar(1e-4);
        this.onTrialEnd?.(false);
        console.info('[Trial] échoué — retournez au totem');
      }
    }

    // ---- Chaîne F : tout le monde AVANT nous a la priorité ----
    if (this.dialogue.open || this.ride.aboard) return;
    if (this.ride.promptLabel !== null || this.interactions.promptLabel !== null || this.quest.promptLabel !== null) return;
    const range = HUD.interactRangeM + 0.6;

    // Coffre de récompense (offrande OU défi) — AVANT les stèles : un coffre
    // fraîchement apparu ne doit pas être masqué par une stèle voisine
    if (this.chest && !this.chest.opened) {
      if (Math.hypot(_pw.x - this.chest.x, _pw.z - this.chest.z) < range + 0.4) {
        this.promptLabel = 'Ouvrir le coffre';
        if (this.input.wasPressed('KeyF')) {
          this.chest.opened = true;
          const lid = this.chest.group.getObjectByName('lid');
          if (lid) lid.rotation.x = -0.9;
          this.onChest?.();
          console.info('[Explore] coffre du Nord ouvert');
          this.showToast('Trésor du Nord', 'Les vents gardent les curieux');
        }
        return;
      }
    }

    // Stèle en portée → lecture (dialogue, mouvement gelé comme un vrai dialogue)
    for (const tb of this.tablets) {
      if (Math.hypot(_pw.x - tb.x, _pw.z - tb.z) < range) {
        this.promptLabel = 'Lire la stèle';
        if (this.input.wasPressed('KeyF')) {
          console.info(`[Tablet] lecture : ${tb.title}`);
          this.player.setCombatDrive(true, this.player.heading);
          const ti = this.tablets.indexOf(tb) + 1;
          // Aeliana lit l'inscription à voix haute (clés stele-<t>-<n>)
          this.dialogue.start(
            tb.lines.map((text, li) => ({ speaker: tb.title, text, voice: `stele-${ti}-${li + 1}` })),
            () => this.player.setCombatDrive(false),
          );
        }
        return;
      }
    }

    // Offrande des agates à l'autel du belvédère (quête finie = planeur débloqué)
    if (this.player.gliderUnlocked && !this.offered && this.agatesFound === EXPLORE7.agates.length) {
      const A = QUEST7.altarBelvedere;
      if (Math.hypot(_pw.x - A.x, _pw.z - A.z) < range + 0.6) {
        this.promptLabel = 'Offrir les agates de givre';
        if (this.input.wasPressed('KeyF')) {
          this.offered = true;
          console.info('[Explore] offrande des agates acceptée');
          this.showToast('Offrande acceptée', 'Les Vents du Nord vous remercient');
          this.spawnChest(A.x + 2.4, A.z - 1.2);
        }
        return;
      }
    }

    // Totem du défi (planeur requis)
    if (this.player.gliderUnlocked && this.trialState !== 'run') {
      if (Math.hypot(_pw.x - this.totemPos.x, _pw.z - this.totemPos.z) < range) {
        this.promptLabel = 'Commencer le défi des vents';
        if (this.input.wasPressed('KeyF')) {
          this.trialState = 'run';
          this.trialLeft = EXPLORE7.trial.timeS;
          for (const r of this.rings) {
            r.passed = false;
            r.mesh.scale.setScalar(1);
          }
          console.info('[Trial] défi lancé');
          this.onTrialStart?.();
        }
        return;
      }
    }

  }

  update(dt: number): void {
    void dt;
    // Visuels : agates qui tournent/ondulent, gemme du totem, pulse des anneaux
    for (let i = 0; i < this.agates.length; i++) {
      const a = this.agates[i]!;
      if (a.taken) continue;
      a.mesh.rotation.y = this.t * 1.5 + i;
      a.mesh.position.y = a.y + Math.sin(this.t * 2.1 + i * 1.3) * 0.12;
    }
    const gem = this.group.getObjectByName('trial-gem');
    if (gem) gem.rotation.y = this.t * 1.8;
    if (this.trialState === 'run') {
      for (const r of this.rings) {
        if (!r.passed) r.mesh.scale.setScalar(1 + Math.sin(this.t * 5) * 0.06);
      }
      this.timerEl.textContent = `${Math.max(0, this.trialLeft).toFixed(1)} s`;
      this.timerEl.classList.add('visible');
    } else {
      this.timerEl.classList.remove('visible');
    }
  }

  /** Coffre de récompense (bois + laiton + liseré doré, comme celui du boss). */
  private spawnChest(x: number, z: number): void {
    const y = this.snow.getHeight(x, z);
    const g = new Group();
    const body = new Mesh(new BoxGeometry(1.1, 0.62, 0.72), ToonMaterials.stationWood());
    body.position.y = 0.31;
    const lid = new Mesh(new BoxGeometry(1.14, 0.26, 0.76), ToonMaterials.trainBrass());
    lid.position.y = 0.72;
    lid.name = 'lid';
    const glow = new Mesh(new BoxGeometry(0.9, 0.07, 0.55), ToonMaterials.lantern(PALETTE.gold, 2.2));
    glow.position.y = 0.62;
    g.add(body, lid, glow);
    g.position.set(x, y, z);
    g.traverse((o) => {
      o.frustumCulled = false;
      o.castShadow = true;
    });
    this.group.add(g);
    this.chest = { x, z, group: g, opened: false };
  }
}

const _pw = new Vector3();
