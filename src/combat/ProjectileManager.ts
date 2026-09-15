import { InstancedMesh, Matrix4, MeshBasicNodeMaterial, OctahedronGeometry, Quaternion, Scene, Vector3 } from 'three/webgpu';
import { color } from 'three/tsl';
import { PALETTE, PROJECTILE } from '../config';
import type { Updatable } from '../core/Engine';
import type { CharacterController } from '../player/CharacterController';
import type { CombatGround } from '../world/GroundSource';
import type { CombatEvents } from './CombatEvents';
import type { CombatSystem } from './CombatSystem';

// Projectiles ennemis (M6) : pool fixe d'éclats de glace — les wraiths et les
// volées du boss. Intégration en pas fixe (segment prev→cur vs capsule joueur),
// rendu InstancedMesh interpolé + spin (patron fumée du train). Les projectiles
// SURVIVENT aux états du tireur — rien à faire dans les FSM.

interface Projectile {
  x: number; y: number; z: number;
  px: number; py: number; pz: number;
  vx: number; vy: number; vz: number;
  ttl: number;
  dmg: number;
  alive: boolean;
}

export class ProjectileManager implements Updatable {
  readonly mesh: InstancedMesh;
  private readonly pool: Projectile[] = [];
  private combat: CombatSystem | null = null;
  private spinT = 0;

  constructor(
    scene: Scene,
    private readonly player: CharacterController,
    private readonly ground: CombatGround,
    private readonly events: CombatEvents,
  ) {
    const mat = new MeshBasicNodeMaterial();
    mat.colorNode = color(PALETTE.elements.cryo).mul(PROJECTILE.intensity); // ≥1,5 → bloom
    this.mesh = new InstancedMesh(new OctahedronGeometry(PROJECTILE.size, 0), mat, PROJECTILE.poolSize);
    for (let i = 0; i < PROJECTILE.poolSize; i++) {
      this.pool.push({ x: 0, y: 0, z: 0, px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0, ttl: 0, dmg: 0, alive: false });
      this.mesh.setMatrixAt(i, _m.makeScale(0, 0, 0));
    }
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.name = 'ice-projectiles';
    scene.add(this.mesh);
  }

  setCombat(combat: CombatSystem): void {
    this.combat = combat;
  }

  /** Tire un éclat (position monde, direction normalisée, m/s). */
  fire(x: number, y: number, z: number, dirX: number, dirY: number, dirZ: number, speed: number, dmg: number, ttl: number): void {
    const p = this.pool.find((q) => !q.alive);
    if (!p) return; // pool plein : le tir le plus ancien prime (24 suffit largement)
    p.x = p.px = x;
    p.y = p.py = y;
    p.z = p.pz = z;
    p.vx = dirX * speed;
    p.vy = dirY * speed;
    p.vz = dirZ * speed;
    p.ttl = ttl;
    p.dmg = dmg;
    p.alive = true;
  }

  fixedUpdate(dt: number): void {
    this.player.worldPosition(_pw);
    for (const p of this.pool) {
      if (!p.alive) continue;
      p.px = p.x;
      p.py = p.y;
      p.pz = p.z;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      p.ttl -= dt;
      // Impact sol
      if (p.y <= this.ground.getHeight(p.x, p.z) + 0.1 || p.ttl <= 0) {
        this.events.emit({ type: 'projectileImpact', x: p.x, y: p.y, z: p.z });
        p.alive = false;
        continue;
      }
      // Impact joueur : capsule (r 0,45, hauteur 1,7) vs segment prev→cur
      const midX = (p.px + p.x) / 2;
      const midZ = (p.pz + p.z) / 2;
      const dXZ = Math.hypot(midX - _pw.x, midZ - _pw.z);
      if (dXZ < 0.45 + 0.35 && p.y > _pw.y - 0.1 && p.y < _pw.y + 1.8) {
        const inv = 1 / Math.max(Math.hypot(p.vx, p.vz), 1e-3);
        this.combat?.applyPlayerDamage(p.dmg, p.vx * inv, p.vz * inv, 'cryo');
        this.events.emit({ type: 'projectileImpact', x: p.x, y: p.y, z: p.z });
        p.alive = false;
      }
    }
  }

  update(dt: number, alpha: number): void {
    this.spinT += dt * PROJECTILE.spin;
    for (let i = 0; i < this.pool.length; i++) {
      const p = this.pool[i]!;
      if (!p.alive) {
        this.mesh.setMatrixAt(i, _m.makeScale(0, 0, 0));
        continue;
      }
      _v.set(p.px + (p.x - p.px) * alpha, p.py + (p.y - p.py) * alpha, p.pz + (p.z - p.pz) * alpha);
      _q.setFromAxisAngle(_axis, this.spinT + i * 1.7);
      _m.compose(_v, _q, _one);
      this.mesh.setMatrixAt(i, _m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

const _m = new Matrix4();
const _v = new Vector3();
const _pw = new Vector3();
const _q = new Quaternion();
const _axis = new Vector3(0.4, 1, 0.2).normalize();
const _one = new Vector3(1, 1, 1);
