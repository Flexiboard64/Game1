import { BackSide, Color, Fog, Mesh, MeshBasicNodeMaterial, Scene, SphereGeometry } from 'three/webgpu';
import {
  color,
  float,
  fract,
  hash,
  mix,
  mx_noise_float,
  positionLocal,
  sin,
  smoothstep,
  step,
  time,
  uniform,
  vec2,
} from 'three/tsl';
import { AMBIENCE, SKY } from '../config';

// Dôme de ciel : dégradé vertical peint à la main (zénith → horizon), style anime.
// La couleur d'horizon alimente aussi le fog de la scène : raccord invisible.
// M5 : les trois stops sont des uniforms lerpés par setAmbience (région neige).
// M6 : 2e poids « nuit » (Snezhnograd) + AURORES BORÉALES et ÉTOILES additives
// (termes TSL toujours compilés, pilotés par uniforms — zéro rebuild).

export class SkyDome {
  readonly mesh: Mesh;
  private readonly fog: Fog;
  private readonly uHorizon = uniform(new Color(SKY.horizon));
  private readonly uMid = uniform(new Color(SKY.mid));
  private readonly uZenith = uniform(new Color(SKY.zenith));
  private readonly uAurora = uniform(0);
  private readonly uStars = uniform(0);
  private ambience = -1; // force la première application
  private night = -1;

  constructor(scene: Scene) {
    const geometry = new SphereGeometry(600, 32, 20);
    const material = new MeshBasicNodeMaterial({ side: BackSide, depthWrite: false, fog: false });

    const d = positionLocal.div(600);
    const h = d.y; // [-1, 1]
    const lowBlend = smoothstep(-0.04, 0.18, h);
    const highBlend = smoothstep(0.18, 0.62, h);
    const base = mix(mix(this.uHorizon, this.uMid, lowBlend), this.uZenith, highBlend);

    // ---- Aurores : rideaux bruités qui défilent, fenêtre verticale au-dessus
    // de l'horizon. ⚠ jamais de smoothstep à bornes décroissantes (UB GLSL) —
    // les fenêtres « qui redescendent » passent par .oneMinus()
    const au = AMBIENCE.aurora;
    const n1 = mx_noise_float(vec2(d.x.mul(2.2).add(time.mul(au.scroll)), d.z.mul(2.2))).mul(0.5).add(0.5);
    const n2 = mx_noise_float(
      vec2(d.x.mul(6.5).sub(time.mul(au.scroll * 0.6)), d.z.mul(6.5).add(time.mul(au.scroll * 0.3))),
    ).mul(0.5).add(0.5);
    const ribbon = smoothstep(0.55, 0.85, n1.mul(0.65).add(n2.mul(0.35)));
    const win = smoothstep(0.10, 0.28, h).mul(smoothstep(0.42, 0.72, h).oneMinus());
    const hueT = mx_noise_float(vec2(d.z.mul(3.1), d.x.mul(3.1).add(time.mul(0.01)))).mul(0.5).add(0.5);
    const auroraCol = mix(mix(color(au.colorA), color(au.colorB), hueT), color(au.colorC), n2.mul(0.35));
    const aurora = auroraCol.mul(ribbon).mul(win).mul(this.uAurora).mul(au.intensity);

    // ---- Étoiles : hash par cellule en projection GNOMONIQUE (xz/(y+0,35) —
    // des cellules en xz brut s'étirent en OVALES près de l'horizon, retour
    // utilisateur). Points minuscules, taille ET éclat variés par étoile.
    // Offset +1000 : hash() TSL tronque en uint, WGSL sature les négatifs.
    const st = AMBIENCE.stars;
    const proj = d.xz.div(h.abs().add(0.35));
    const cellUv = proj.mul(st.cell).add(1000);
    const cell = cellUv.floor();
    const rnd = hash(cell.x.mul(1973).add(cell.y.mul(9277)));
    const rnd2 = hash(cell.x.mul(613).add(cell.y.mul(3121)).add(7));
    const f = fract(cellUv).sub(0.5);
    const size = mix(float(0.028), float(0.075), rnd2);
    const pt = smoothstep(size.mul(0.3), size, f.length()).oneMinus();
    const twinkle = sin(time.mul(2.0).add(rnd.mul(40))).mul(0.3).add(0.7);
    const stars = color('#eaf2ff')
      .mul(step(float(st.threshold), rnd))
      .mul(pt)
      .mul(twinkle)
      .mul(mix(float(0.2), float(1.0), rnd2)) // magnitudes inégales
      .mul(smoothstep(0.08, 0.3, h))
      .mul(this.uStars)
      .mul(st.intensity);

    material.colorNode = base.add(aurora).add(stars);

    this.mesh = new Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -100;
    scene.add(this.mesh);

    this.fog = new Fog(new Color(SKY.horizon), SKY.fogNear, SKY.fogFar);
    scene.fog = this.fog;
    this.setAmbience(0, 0);
  }

  /** Le dôme suit la caméra en XZ pour rester « infini ». */
  followCamera(x: number, z: number): void {
    this.mesh.position.set(x, 0, z);
  }

  /**
   * Crossfade vallée (0) → neige (1) puis → nuit d'aurore (night 0→1) :
   * stops du dôme + fog (couleur ET portées) + intensités aurore/étoiles.
   */
  setAmbience(t: number, night = 0): void {
    if (Math.abs(t - this.ambience) < 1e-3 && Math.abs(night - this.night) < 1e-3) return;
    this.ambience = t;
    this.night = night;
    const nt = AMBIENCE.night;
    this.uHorizon.value.set(SKY.horizon).lerp(_c.set(AMBIENCE.snowHorizon), t).lerp(_c.set(nt.horizon), night);
    this.uMid.value.set(SKY.mid).lerp(_c.set(AMBIENCE.snowMid), t).lerp(_c.set(nt.mid), night);
    this.uZenith.value.set(SKY.zenith).lerp(_c.set(AMBIENCE.snowZenith), t).lerp(_c.set(nt.zenith), night);
    this.fog.color.copy(this.uHorizon.value);
    const dayNear = SKY.fogNear + (AMBIENCE.snowFogNear - SKY.fogNear) * t;
    const dayFar = SKY.fogFar + (AMBIENCE.snowFogFar - SKY.fogFar) * t;
    this.fog.near = dayNear + (nt.fogNear - dayNear) * night;
    this.fog.far = dayFar + (nt.fogFar - dayFar) * night;
    this.uAurora.value = night;
    this.uStars.value = night;
  }
}

const _c = new Color();
