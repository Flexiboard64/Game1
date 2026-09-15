// Entrées clavier/souris. Utilise KeyboardEvent.code (positions physiques) :
// ZQSD sur AZERTY et WASD sur QWERTY fonctionnent sans détection de layout.

export class InputManager {
  private readonly down = new Set<string>();
  private readonly pressed = new Set<string>();
  private mouseDX = 0;
  private mouseDY = 0;
  private wheel = 0;
  private locked = false;
  private lockCooldownUntil = 0;
  private firstDeltaAfterLock = false;

  onPointerLockChange: ((locked: boolean) => void) | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.down.add(e.code);
      this.pressed.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => this.down.clear());

    // Boutons souris (Mouse0 = attaque) dans les MÊMES sets que le clavier.
    // Gardé par le lock : le clic qui ACQUIERT le pointer lock ne compte pas
    // (mousedown part avant l'acquisition → locked encore false → ignoré)
    window.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      this.down.add(`Mouse${e.button}`);
      this.pressed.add(`Mouse${e.button}`);
    });
    window.addEventListener('mouseup', (e) => this.down.delete(`Mouse${e.button}`));

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (this.locked) this.firstDeltaAfterLock = true;
      else this.lockCooldownUntil = performance.now() + 1300; // cooldown Chrome ~1.25 s
      this.onPointerLockChange?.(this.locked);
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      // Le premier delta après un lock contient souvent un pic parasite
      if (this.firstDeltaAfterLock) {
        this.firstDeltaAfterLock = false;
        return;
      }
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });

    window.addEventListener('wheel', (e) => {
      if (this.locked) this.wheel += e.deltaY;
    }, { passive: true });

    canvas.addEventListener('click', () => {
      this.requestFullscreen();
      this.requestPointerLock();
    });
  }

  /** Plein écran automatique à la (re)prise du jeu. Échec toléré (iframe, headless). */
  private requestFullscreen(): void {
    if (document.fullscreenElement) return;
    document.documentElement
      .requestFullscreen({ navigationUI: 'hide' })
      .catch(() => { /* refusé — le jeu reste jouable en fenêtre */ });
  }

  requestPointerLock(): void {
    if (this.locked || performance.now() < this.lockCooldownUntil) return;
    // Certains navigateurs renvoient une promesse rejetable (re-lock trop rapide)
    const result = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
    result?.catch(() => { /* re-tentative au prochain clic */ });
  }

  get pointerLocked(): boolean {
    return this.locked;
  }

  isDown(code: string): boolean {
    return this.down.has(code);
  }

  /** Front montant — consommé à chaque fixedUpdate via clearFrame(). */
  wasPressed(code: string): boolean {
    return this.pressed.has(code);
  }

  clearFrame(): void {
    this.pressed.clear();
  }

  consumeMouseDelta(): { dx: number; dy: number } {
    const d = { dx: this.mouseDX, dy: this.mouseDY };
    this.mouseDX = 0;
    this.mouseDY = 0;
    return d;
  }

  consumeWheelDelta(): number {
    const w = this.wheel;
    this.wheel = 0;
    return w;
  }
}
