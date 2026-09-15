import { Color, DirectionalLight, HemisphereLight, Scene, Vector3 } from 'three/webgpu';
import { AMBIENCE, HEMI, SUN } from '../config';

// Soleil directionnel + hémisphérique doux (les bandes d'ombre toon ne doivent
// jamais être noires). Le frustum d'ombre serré suit le joueur, snappé sur la
// grille de texels pour éviter le « shadow swimming ».

export class Lighting {
  readonly sun: DirectionalLight;
  private readonly hemi: HemisphereLight;
  private readonly sunDir: Vector3;
  private readonly axisX: Vector3;
  private readonly axisY: Vector3;
  private ambience = -1;
  private night = -1;

  constructor(scene: Scene) {
    this.sunDir = new Vector3(SUN.direction.x, SUN.direction.y, SUN.direction.z).normalize();
    // Base de la caméra d'ombre (lookAt three : z = dir lumière, up monde)
    this.axisX = new Vector3().crossVectors(new Vector3(0, 1, 0), this.sunDir).normalize();
    this.axisY = new Vector3().crossVectors(this.sunDir, this.axisX);

    this.sun = new DirectionalLight(SUN.color, SUN.intensity);
    this.sun.castShadow = true;
    const cam = this.sun.shadow.camera;
    cam.left = -SUN.shadowHalfExtent;
    cam.right = SUN.shadowHalfExtent;
    cam.top = SUN.shadowHalfExtent;
    cam.bottom = -SUN.shadowHalfExtent;
    cam.near = SUN.shadowNear;
    cam.far = SUN.shadowFar;
    this.sun.shadow.mapSize.set(SUN.shadowMapSize, SUN.shadowMapSize);
    // ≈ 1,8× le texel d'ombre (90 m / 2048 = 4,4 cm) — 0,02 (0,46×) causait
    // l'acné sur les grandes surfaces lisses ; bias minimal (il est asymétrique
    // entre backends : la même valeur vaut 2× plus en WebGPU qu'en WebGL2)
    this.sun.shadow.normalBias = 0.08;
    this.sun.shadow.bias = -0.0001;
    scene.add(this.sun);
    scene.add(this.sun.target);

    this.hemi = new HemisphereLight(HEMI.sky, HEMI.ground, HEMI.intensity);
    scene.add(this.hemi);
  }

  /**
   * Crossfade vallée (0) → neige (1) puis → nuit (night 0→1). La DIRECTION du
   * soleil reste FIGÉE (le snap texel du frustum d'ombre en dépend) : la nuit
   * est une « lune » au même azimut, l'éclat vient des émissifs + bloom.
   */
  setAmbience(t: number, night = 0): void {
    if (Math.abs(t - this.ambience) < 1e-3 && Math.abs(night - this.night) < 1e-3) return;
    this.ambience = t;
    this.night = night;
    const nt = AMBIENCE.night;
    this.sun.color.set(SUN.color).lerp(_c.set(AMBIENCE.snowSun), t).lerp(_c.set(nt.sun), night);
    const dayI = SUN.intensity + (AMBIENCE.snowSunIntensity - SUN.intensity) * t;
    this.sun.intensity = dayI + (nt.sunIntensity - dayI) * night;
    this.hemi.color.set(HEMI.sky).lerp(_c.set(AMBIENCE.snowHemiSky), t).lerp(_c.set(nt.hemiSky), night);
    this.hemi.groundColor.set(HEMI.ground).lerp(_c.set(AMBIENCE.snowHemiGround), t).lerp(_c.set(nt.hemiGround), night);
    this.hemi.intensity = HEMI.intensity + (nt.hemiIntensity - HEMI.intensity) * night;
  }

  /**
   * Recentre le frustum d'ombre sur le joueur, snappé au texel EN ESPACE
   * LUMIÈRE : arrondir en XZ monde ne tombe pas sur la grille de texels de la
   * caméra d'ombre inclinée (les bords d'ombre « rampaient » quand même).
   */
  followPlayer(x: number, z: number): void {
    const texel = (SUN.shadowHalfExtent * 2) / SUN.shadowMapSize;
    _p.set(x, 0, z);
    const px = Math.round(_p.dot(this.axisX) / texel) * texel;
    const py = Math.round(_p.dot(this.axisY) / texel) * texel;
    const pz = _p.dot(this.sunDir);
    _p.copy(this.axisX).multiplyScalar(px)
      .addScaledVector(this.axisY, py)
      .addScaledVector(this.sunDir, pz);
    this.sun.target.position.copy(_p);
    this.sun.position.copy(_p).addScaledVector(this.sunDir, 90);
  }
}

const _p = new Vector3();
const _c = new Color();
