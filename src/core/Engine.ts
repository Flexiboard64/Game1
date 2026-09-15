import { PCFSoftShadowMap, PerspectiveCamera, Scene, WebGPURenderer } from 'three/webgpu';
import { CAMERA, POST } from '../config';
import { createPostPipeline, type PostPipeline } from '../render/PostPipeline';

export interface Updatable {
  /** Simulation à pas fixe (60 Hz) : gameplay, timers, physique. */
  fixedUpdate?(dt: number): void;
  /** Mise à jour à pas variable : caméra, mixers d'animation, écritures DOM. */
  update?(dt: number, alpha: number): void;
}

const FIXED_DT = 1 / 60;
const MAX_FRAME_DT = 0.1; // garde anti « spirale de la mort » (retour d'onglet)

export class Engine {
  readonly renderer: WebGPURenderer;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;

  private accumulator = 0;
  private lastTime = -1;
  private readonly systems: Updatable[] = [];
  private post: PostPipeline | null = null;
  private hitstopUntil = -1;
  private hitstopScale = 1;

  private constructor(renderer: WebGPURenderer) {
    this.renderer = renderer;
    this.scene = new Scene();
    this.camera = new PerspectiveCamera(
      CAMERA.fov,
      window.innerWidth / window.innerHeight,
      CAMERA.near,
      CAMERA.far,
    );
    window.addEventListener('resize', () => this.onResize());
  }

  static async create(canvas: HTMLCanvasElement): Promise<Engine> {
    const forceWebGL = new URLSearchParams(location.search).has('forcewebgl');
    const renderer = new WebGPURenderer({ canvas, antialias: true, forceWebGL });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    // PCF doux DÉTERMINISTE : le PCF par défaut ajoute un dither par pixel
    // (interleaved gradient noise) qui rampe avec la caméra — très visible sur
    // les aplats toon qui n'ont aucune texture pour le masquer
    renderer.shadowMap.type = PCFSoftShadowMap;
    await renderer.init();
    const engine = new Engine(renderer);
    console.info(`[Engine] backend actif : ${engine.isWebGPU ? 'WebGPU' : 'WebGL2'}`);
    return engine;
  }

  get isWebGPU(): boolean {
    // three ne type pas backend.isWebGPUBackend — duck-typing volontaire
    return Boolean((this.renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend);
  }

  add(system: Updatable): void {
    this.systems.push(system);
  }

  /**
   * Gel de frappe (hitstop) : la sim ET les mixers ralentissent à `scale`
   * pendant `durationS` en temps RÉEL (un timer en dt scalé durerait 20× trop).
   * Le nœud TSL `time` (horloge renderer) continue de couler : l'ambiant (eau,
   * herbe, cascade) vit pendant le gel — assumé, l'action seule se fige.
   */
  requestHitstop(durationS: number, scale = 0.05): void {
    this.hitstopUntil = Math.max(this.hitstopUntil, this.lastTime + durationS * 1000);
    this.hitstopScale = scale;
  }

  /** À appeler après tous les scene.add : construit le pipeline bloom+vignette. */
  initPost(): void {
    const nopost = new URLSearchParams(location.search).has('nopost');
    if (!POST.enabled || nopost) return;
    try {
      this.post = createPostPipeline(this.renderer, this.scene, this.camera);
    } catch (e) {
      console.warn('[Engine] post-processing indisponible — rendu direct', e);
      this.post = null;
    }
  }

  /**
   * Précompilation des shaders (remplace renderer.compileAsync de main) : avec
   * le pipeline, la scène rend dans la RT de la passe — un AUTRE contexte de
   * compilation que le framebuffer. Le render de warmup absorbe les compiles
   * synchrones du quad final et des matériaux internes du bloom derrière
   * l'écran de chargement encore opaque. Échec (backend exotique) → repli.
   */
  async compile(): Promise<void> {
    if (this.post) {
      try {
        await this.post.scenePass.compileAsync(this.renderer);
        this.post.pipeline.render(); // warmup
        return;
      } catch (e) {
        console.warn('[Engine] échec du pipeline de post — repli rendu direct', e);
        this.post = null;
      }
    }
    await this.renderer.compileAsync(this.scene, this.camera);
  }

  start(): void {
    this.renderer.setAnimationLoop((timeMs) => this.frame(timeMs));
  }

  private frame(timeMs: number): void {
    if (this.lastTime < 0) this.lastTime = timeMs;
    const dt = Math.min((timeMs - this.lastTime) / 1000, MAX_FRAME_DT);
    this.lastTime = timeMs;

    // Hitstop : le temps scalé affame les pas fixes et gèle mixers/VFX
    const sdt = timeMs < this.hitstopUntil ? dt * this.hitstopScale : dt;

    this.accumulator += sdt;
    while (this.accumulator >= FIXED_DT) {
      for (const s of this.systems) s.fixedUpdate?.(FIXED_DT);
      this.accumulator -= FIXED_DT;
    }
    const alpha = this.accumulator / FIXED_DT;
    for (const s of this.systems) s.update?.(sdt, alpha);

    if (this.post) {
      try {
        this.post.pipeline.render();
      } catch (e) {
        // Garde 1re frame : repli définitif sur le rendu direct
        console.warn('[Engine] pipeline en échec au rendu — repli direct', e);
        this.post = null;
        this.renderer.render(this.scene, this.camera);
      }
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  private onResize(): void {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }
}
