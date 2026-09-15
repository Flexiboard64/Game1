import {
  AdditiveBlending,
  CylinderGeometry,
  DoubleSide,
  Group,
  InstancedMesh,
  Mesh,
  MeshBasicNodeMaterial,
  PlaneGeometry,
  SpriteNodeMaterial,
} from 'three/webgpu';
import {
  cameraPosition,
  color,
  cos,
  float,
  fract,
  hash,
  instanceIndex,
  mix,
  mx_noise_float,
  sin,
  smoothstep,
  time,
  uniform,
  uv,
  vec2,
  vec3,
} from 'three/tsl';
import { WINDCOLS } from '../config';
import type { Updatable } from '../core/Engine';
import type { SnowField } from './SnowField';

// Colonnes de vent (M7) : tornades de NEIGE — le contrôleur interroge
// updraftAt() pendant l'intégration verticale (gameplay inchangé).
// M7.2 visuel : vraie tornade — entonnoir de flocons instanciés en hélice
// (SpriteNodeMaterial + positionNode par instanceIndex, pattern SnowfallField :
// AUCUN travail CPU par frame), jupe de poudrerie arrachée au sol qui spirale
// vers le cœur, voile tournant au sol, et voiles coniques additifs en stries
// DIAGONALES. TOUJOURS compilé (visible=true, activation par uniform ×0).

export class WindColumns implements Updatable {
  readonly group = new Group();
  /** Activation globale (la quête réveille les colonnes ; ensuite permanent). */
  private readonly uActive = uniform(0);
  active = false;
  /** Hook audio (M8) : front d'activation. */
  onActivate: (() => void) | null = null;

  constructor(snow: SnowField) {
    const V = WINDCOLS.vortex;

    // ---- Voiles coniques additifs (2 coquilles) : stries en spirale ----
    // Double lecture cel-shading : 1) SOUS-VOILE en fondu normal, plus sombre
    // que le ciel → la silhouette de l'entonnoir existe même plein jour ;
    // 2) RUBANS hélicoïdaux additifs nets qui s'enroulent (fract + smoothstep,
    // pas du bruit : des bandes FRANCHES, style courants de vent Genshin)
    const veilMat = new MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      fog: false,
    });
    const ribbonMat = new MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
      fog: false,
    });
    {
      const u = uv();
      const taper = smoothstep(0.0, 0.1, u.y).mul(smoothstep(0.55, 1.0, u.y).oneMinus());
      const breakup = mx_noise_float(vec2(u.x.mul(6.0), u.y.mul(2.2).sub(time.mul(0.7)))).mul(0.5).add(0.5);
      veilMat.colorNode = mix(color('#7ea6c4'), color('#a9cde2'), u.y);
      veilMat.opacityNode = breakup.mul(0.5).add(0.25).mul(taper).mul(0.42).mul(this.uActive);

      // 3 rubans enroulés qui défilent : coordonnée diagonale, bandes nettes
      const coil = u.x.mul(3.0).add(u.y.mul(5.5)).sub(time.mul(2.1));
      const f = fract(coil);
      const band = smoothstep(0.3, 0.42, f).mul(smoothstep(0.74, 0.62, f));
      const gaps = mx_noise_float(vec2(u.x.mul(4.0).add(time.mul(0.4)), u.y.mul(3.0))).mul(0.5).add(0.5);
      ribbonMat.colorNode = color('#eef9ff').mul(0.55); // additif ×2 couches + bloom : rester bien sous 1
      ribbonMat.opacityNode = band.mul(smoothstep(0.25, 0.6, gaps)).mul(taper).mul(0.5).mul(this.uActive);
    }

    for (const c of WINDCOLS.columns) {
      const ground = snow.getHeight(c.x, c.z);
      const H = c.topY - ground + 3;

      // Cônes (entonnoir : étroit en bas, évasé en haut) : voile + rubans sur
      // la même enveloppe, rubans seuls sur le cône intérieur (phase décalée
      // gratuite : la densité UV diffère avec l'échelle)
      const coneGeo = new CylinderGeometry(c.r * 1.0, c.r * 0.42, H, 18, 1, true);
      const veil = new Mesh(coneGeo, veilMat);
      veil.position.set(c.x, ground + H / 2, c.z);
      veil.frustumCulled = false; // doit compiler au warmup (uniform à 0 = invisible)
      this.group.add(veil);
      const ribbons = new Mesh(coneGeo, ribbonMat);
      ribbons.position.copy(veil.position);
      ribbons.scale.setScalar(1.02);
      ribbons.frustumCulled = false;
      this.group.add(ribbons);
      const inner = new Mesh(new CylinderGeometry(c.r * 0.5, c.r * 0.18, H * 0.9, 12, 1, true), ribbonMat);
      inner.position.copy(veil.position);
      inner.frustumCulled = false;
      this.group.add(inner);

      // ---- Entonnoir de flocons : hélice montante, rayon qui s'évase ----
      this.group.add(this.buildVortexFlakes(c.x, ground, c.z, {
        count: V.funnelFlakes,
        yLo: 0.2, yHi: H,
        rLo: c.r * V.rBotFrac, rHi: c.r * V.rTopFrac,
        riseS: V.riseS,
        sizeMul: 1,
        opacity: V.opacity,
      }));

      // ---- Jupe de poudrerie : arrachée LARGE au sol, spirale vers le cœur ----
      this.group.add(this.buildVortexFlakes(c.x, ground, c.z, {
        count: V.skirtFlakes,
        yLo: 0.05, yHi: 2.2,
        rLo: c.r * 1.5, rHi: c.r * 0.5, // rentre en montant (aspiration)
        riseS: V.riseS * 0.5,
        sizeMul: 1.25,
        opacity: V.skirtOpacity, // rLo > rHi : la jupe RENTRE en montant (aspiration)
      }));

      // ---- Voile de poudrerie au sol : disque de bruit qui TOURNE ----
      const dustMat = new MeshBasicNodeMaterial({
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        side: DoubleSide,
        fog: false,
      });
      {
        const p = uv().sub(0.5);
        // Rotation du champ de bruit (pas de la géométrie) : repère tournant
        const ct = cos(time.mul(1.3));
        const st = sin(time.mul(1.3));
        const rp = vec2(p.x.mul(ct).sub(p.y.mul(st)), p.x.mul(st).add(p.y.mul(ct)));
        const swirl = mx_noise_float(rp.mul(4.2)).mul(0.5).add(0.5);
        const len = p.length();
        const ring = smoothstep(0.06, 0.16, len).mul(smoothstep(0.5, 0.28, len));
        dustMat.colorNode = color('#eaf6ff').mul(0.7);
        dustMat.opacityNode = swirl.mul(swirl).mul(ring).mul(0.3).mul(this.uActive);
      }
      const dust = new Mesh(new PlaneGeometry(c.r * 2 * V.dustR, c.r * 2 * V.dustR), dustMat);
      dust.rotation.x = -Math.PI / 2;
      dust.position.set(c.x, ground + 0.25, c.z);
      dust.frustumCulled = false;
      this.group.add(dust);
    }
  }

  /**
   * Flocons GPU en hélice : position 100 % TSL (hash par instance, zéro CPU).
   * rLo > rHi ⇒ le rayon RENTRE en montant (jupe d'aspiration au sol).
   */
  private buildVortexFlakes(cx: number, ground: number, cz: number, o: {
    count: number;
    yLo: number; yHi: number;
    rLo: number; rHi: number;
    riseS: number;
    sizeMul: number;
    opacity: number;
  }): InstancedMesh {
    const V = WINDCOLS.vortex;
    const m = new SpriteNodeMaterial({ transparent: true, depthWrite: false });
    const h = (n: number) => hash(instanceIndex.add(n));

    // Cycle vertical : chaque flocon a sa période propre (pas de vague synchrone)
    const period = mix(float(o.riseS * 0.7), float(o.riseS * 1.4), h(1));
    const yF = fract(h(0).add(time.div(period)));

    // Rayon : profil d'entonnoir + jitter par flocon + respiration
    const rBase = mix(float(o.rLo), float(o.rHi), yF);
    const jitter = mix(float(0.78), float(1.06), h(2)); // resserré : paroi de tube nette, pas un nuage
    const wobble = sin(time.mul(2.6).add(h(5).mul(6.2832)).add(yF.mul(9.0))).mul(V.wobble);
    const radius = rBase.mul(jitter).add(wobble);

    // Hélice : tous le MÊME sens de rotation (cohérence de la tornade)
    const ang = h(3).mul(6.2832).add(time.mul(mix(float(V.angMin), float(V.angMax), h(4))));
    // Léger serpentement d'ensemble (amplitude ≤ 0,45 m : les cônes ne bougent
    // pas, plus grand ça décollerait visiblement de l'enveloppe)
    const sway = yF.mul(0.45);
    const pos = vec3(
      cos(ang).mul(radius).add(sin(time.mul(0.8).add(yF.mul(2.6))).mul(sway)).add(cx),
      float(ground + o.yLo).add(yF.mul(o.yHi - o.yLo)),
      sin(ang).mul(radius).add(cos(time.mul(0.8).add(yF.mul(2.6))).mul(sway)).add(cz),
    );
    m.positionNode = pos;

    const size = mix(float(V.sizeMin), float(V.sizeMax), h(7)).mul(o.sizeMul);
    // Étirés horizontalement : traînée de rotation (même astuce que la bourrasque)
    m.scaleNode = vec2(size.mul(V.streak), size.mul(0.85));

    const p = uv().sub(0.5);
    const disc = smoothstep(0.16, 0.5, p.length()).oneMinus();
    const fadeEnds = smoothstep(0.0, 0.08, yF).mul(smoothstep(0.8, 1.0, yF).oneMinus());
    const envNear = smoothstep(float(1.0), float(2.4), pos.sub(cameraPosition).length());

    m.colorNode = color('#ffffff').mul(mix(float(0.85), float(1.05), h(8))); // pointes juste au-dessus du fond
    m.opacityNode = disc.mul(fadeEnds).mul(envNear).mul(o.opacity).mul(this.uActive);

    const mesh = new InstancedMesh(new PlaneGeometry(1, 1), m, o.count);
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    return mesh;
  }

  /** Réveil des vents (fin de l'étape autel de la crevasse) — définitif. */
  activate(): void {
    if (this.active) return;
    this.active = true;
    console.info('[Quest] colonnes de vent actives');
    this.onActivate?.();
  }

  /**
   * Vitesse ascensionnelle imposée à (x,y,z) — 0 hors colonne ou inactive.
   * Le plafond topY laisse retomber doucement au sommet (portage, pas fusée).
   */
  updraftAt(x: number, y: number, z: number): number {
    if (!this.active) return 0;
    for (let i = 0; i < WINDCOLS.columns.length; i++) {
      const c = WINDCOLS.columns[i]!;
      if (y > c.topY) continue;
      const d = Math.hypot(x - c.x, z - c.z);
      if (d > c.r) continue;
      // Plein souffle au cœur, fondu au bord ; s'adoucit près du plafond
      const radial = 1 - (d / c.r) * 0.5;
      const cap = Math.min(1, (c.topY - y) / 3);
      return c.strength * radial * cap;
    }
    return 0;
  }

  update(dt: number): void {
    // Fondu d'activation (2 s) — la matière est toujours compilée
    const target = this.active ? 1 : 0;
    const v = this.uActive.value as number;
    this.uActive.value = v + Math.min(Math.max(target - v, -dt / 2), dt / 2);
  }
}
