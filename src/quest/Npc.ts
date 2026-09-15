import { AnimationAction, AnimationMixer, CapsuleGeometry, Group, Mesh, Object3D, OctahedronGeometry, Vector3 } from 'three/webgpu';
import { assembleCharacter } from '../assets/CharacterLoader';
import { ToonMaterials } from '../materials/ToonMaterials';
import { PALETTE, QUEST7 } from '../config';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import type { SnowField } from '../world/SnowField';

// PNJ Nadya (M7) : premier personnage non-joueur du jeu — assembleCharacter
// générique (idle + talk), marqueur « ! » doré flottant (quête disponible),
// regarde le joueur à l'approche (yaw amorti). GLB absent → silhouette toon
// de secours (la quête reste jouable).

type NpcClip = 'idle' | 'talk';

export class Npc {
  readonly group = new Group();
  readonly position = new Vector3();
  private readonly mixer: AnimationMixer | null = null;
  private readonly actions: Partial<Record<NpcClip, AnimationAction>> = {};
  private readonly marker: Mesh;
  private baseYaw: number;
  private yaw: number;
  private t = 0;
  private talking = false;

  constructor(snow: SnowField, rigged: GLTF | null, clips: { idle: GLTF | null; talk: GLTF | null }) {
    const y = snow.getHeight(QUEST7.npc.x, QUEST7.npc.z);
    this.position.set(QUEST7.npc.x, y, QUEST7.npc.z);
    this.group.position.copy(this.position);
    this.baseYaw = QUEST7.npc.heading;
    this.yaw = this.baseYaw;

    if (rigged) {
      const ab = assembleCharacter<NpcClip>(rigged, { idle: clips.idle, talk: clips.talk }, { targetHeight: 1.66 });
      this.group.add(ab.root);
      this.mixer = ab.mixer;
      this.actions = ab.actions;
      this.actions.idle?.play();
    } else {
      console.warn('[Npc] GLB Nadya absent — silhouette de secours');
      const ph = new Mesh(new CapsuleGeometry(0.3, 1.0, 4, 10), ToonMaterials.placeholder());
      ph.position.y = 0.85;
      this.group.add(ph);
    }

    // Marqueur « ! » : losange doré flottant (bloom) au-dessus de la tête
    this.marker = new Mesh(new OctahedronGeometry(0.22, 0), ToonMaterials.lantern(PALETTE.gold, 2.2));
    this.marker.position.y = 2.25;
    this.group.add(this.marker);
    this.group.rotation.y = this.yaw;
    this.group.traverse((o: Object3D) => {
      o.frustumCulled = false;
    });
  }

  /** La quête est prise : le « ! » disparaît ; en dialogue : anim talk. */
  setState(opts: { marker?: boolean; talking?: boolean }): void {
    if (opts.marker !== undefined) this.marker.visible = opts.marker;
    if (opts.talking !== undefined && opts.talking !== this.talking) {
      this.talking = opts.talking;
      const from = this.talking ? this.actions.idle : this.actions.talk;
      const to = this.talking ? this.actions.talk : this.actions.idle;
      if (to) {
        to.reset().fadeIn(0.25).play();
        from?.fadeOut(0.25);
      }
    }
  }

  update(dt: number, playerX: number, playerZ: number): void {
    this.t += dt;
    this.mixer?.update(dt);
    this.marker.rotation.y = this.t * 1.6;
    this.marker.position.y = 2.25 + Math.sin(this.t * 2.4) * 0.07;
    // Regarde le joueur à < 6 m (amorti), sinon revient à son cap de base
    const d = Math.hypot(playerX - this.position.x, playerZ - this.position.z);
    const want = d < 6 ? Math.atan2(playerX - this.position.x, playerZ - this.position.z) : this.baseYaw;
    let diff = want - this.yaw;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    this.yaw += diff * (1 - Math.exp(-dt / 0.3));
    this.group.rotation.y = this.yaw;
  }
}
