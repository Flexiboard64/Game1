import { Vector3 } from 'three/webgpu';
import { CHARACTER, CLIMB, GLIDER, ICE, MOVEMENT, WINDCOLS } from '../config';
import type { InputManager } from '../core/InputManager';
import type { Updatable } from '../core/Engine';
import type { GroundSource } from '../world/GroundSource';
import type { ObstacleGrid } from '../world/Obstacles';
import type { PlayerFrame } from '../train/PlayerFrame';

export type MoveMode = 'idle' | 'walk' | 'run' | 'sprint' | 'air' | 'glide' | 'climb';

/** État de locomotion interne : `grounded` ne suffit plus depuis la grimpe
 *  (« pas au sol » ne veut plus dire « gravité + intégration Y »). */
type LocoState = 'ground' | 'air' | 'climb' | 'vault';

export interface StaminaState {
  value: number;
  readonly max: number;
  sprinting: boolean;
  exhausted: boolean;
}

/** Fournit le yaw caméra pour le déplacement relatif à la caméra. */
export interface YawProvider {
  readonly yaw: number;
}

const UP_EPS = 0.25; // au-delà : décollage (marche depuis un rebord)

export class CharacterController implements Updatable {
  readonly position = new Vector3();
  readonly velocity = new Vector3();
  heading = 0; // radians — 0 = modèle face à +Z
  // Snapshot du pas fixe précédent : le rendu (souvent 120 Hz) interpole entre
  // les deux derniers états 60 Hz, sinon le modèle « strobe » une frame sur deux
  private readonly prevPosition = new Vector3();
  private prevHeading = 0;
  mode: MoveMode = 'idle';
  /** GEL (M6) : root bref infligé par les coups Cryo — input sol ignoré. */
  private rootedLeft = 0;
  /** PLANEUR « Aile de Givre » (M7) : débloqué par la quête, Espace en l'air. */
  gliderUnlocked = false;
  gliding = false;
  private glideCooldown = 0;
  /** Vol libre (M9) : tendance verticale lissée −1 (piqué) … +1 (montée) — lue
   *  par les ailes (amplitude de battement) et l'inclinaison du modèle. */
  glideVert = 0;
  // Tap vs maintien d'Espace en vol : le front qui OUVRE les ailes ne doit pas
  // compter comme début de maintien — armé seulement après un relâchement
  private spaceArmed = false;
  private spaceHold = 0;
  /** Colonnes de vent (M7) — injectées par main, portance dans l'intégration Y. */
  wind: { updraftAt(x: number, y: number, z: number): number } | null = null;
  readonly stamina: StaminaState = {
    value: MOVEMENT.staminaMax,
    max: MOVEMENT.staminaMax,
    sprinting: false,
    exhausted: false,
  };
  /** Vitesse SIGNÉE le long de la paroi (m/s, + montée) — timeScale du clip climb. */
  climbRate = 0;

  private loco: LocoState = 'ground';
  private sprintStopTime = 0;
  private elapsed = 0;
  private pivoting = false; // freinage-pivot de demi-tour en cours
  private cameraYaw: YawProvider = { yaw: Math.PI };
  /** Pente du mur rencontré par tryMove CE pas (0 si aucun refus de pente). */
  private wallHitSlope = 0;
  private releaseUntil = -Infinity; // cooldown de ré-accroche après un lâcher
  private readonly vaultFrom = new Vector3();
  private readonly vaultTo = new Vector3();
  private vaultT = 0;
  private lean = 0; // inclinaison visuelle du buste vers la paroi (rad)
  private prevLean = 0;
  // Recul visuel hors de la paroi (le long de la normale horizontale, lissé) :
  // l'ancre physique reste SUR la surface, seul le modèle rendu recule — sans
  // ça le corps (épaisseur ~capsuleRadius) et les bras du clip de grimpe
  // traversent la roche
  private readonly wallOff = new Vector3();
  private readonly prevWallOff = new Vector3();
  // Verrou de combat : WASD/saut/accroche ignorés, cap forcé (auto-aim)
  private combatDrive = false;
  private combatHeading = 0;
  // Canal d'impulsion externe (pas-en-avant d'attaque, knockback subi) —
  // amorti exponentiellement, intégré via tryMove (murs/pentes souverains)
  private impulseX = 0;
  private impulseZ = 0;
  // Référentiel mobile (M5) : à bord du train, position/velocity/heading sont
  // LOCAUX au wagon — le monde est recomposé au rendu et via worldPosition()
  private frame: PlayerFrame | null = null;

  /** Sol effectif : wagon si à bord, monde sinon. */
  private get g(): GroundSource {
    return this.frame ? this.frame.ground : this.ground;
  }

  /** Obstacles effectifs : banquettes du wagon si à bord. */
  private get obs(): ObstacleGrid | null {
    return this.frame ? this.frame.obstacles : this.obstacles;
  }

  get aboard(): boolean {
    return this.frame !== null;
  }

  constructor(
    private readonly input: InputManager,
    private readonly ground: GroundSource,
    private readonly obstacles: ObstacleGrid | null = null,
  ) {
    this.position.set(0, ground.getHeight(0, 0), 0);
    this.prevPosition.copy(this.position);
  }

  /**
   * Téléportation SÛRE : resynchronise le snapshot d'interpolation et purge
   * vitesse/impulsions/offsets visuels — sans quoi le rendu interpole une frame
   * à travers toute la carte (bug historique du respawn).
   */
  teleport(x: number, y: number, z: number, heading?: number): void {
    this.position.set(x, y, z);
    this.prevPosition.copy(this.position);
    this.velocity.set(0, 0, 0);
    this.impulseX = 0;
    this.impulseZ = 0;
    this.wallOff.set(0, 0, 0);
    this.prevWallOff.set(0, 0, 0);
    this.lean = 0;
    this.prevLean = 0;
    this.loco = 'ground';
    this.climbRate = 0;
    if (heading !== undefined) {
      this.heading = heading;
      this.prevHeading = heading;
    }
  }

  /** Position sim 60 Hz en coordonnées MONDE (composée avec le référentiel wagon à bord). */
  worldPosition(out: Vector3): Vector3 {
    out.copy(this.position);
    if (this.frame) {
      const th = this.frame.yaw();
      this.frame.origin(_fo);
      const c = Math.cos(th);
      const s = Math.sin(th);
      const lx = out.x;
      const lz = out.z;
      out.x = _fo.x + c * lx + s * lz;
      out.y = _fo.y + out.y;
      out.z = _fo.z - s * lx + c * lz;
    }
    return out;
  }

  /**
   * Embarquement : bascule la simulation en espace LOCAL du wagon. Le cap est
   * converti monde→local pour que le modèle ne pivote pas visuellement.
   */
  enterFrame(frame: PlayerFrame, lx: number, ly: number, lz: number): void {
    const worldHeading = this.heading + (this.frame ? this.frame.yaw() : 0);
    this.frame = frame;
    this.teleport(lx, ly, lz, worldHeading - frame.yaw());
  }

  /** Débarquement : recompose en monde à la position donnée (à l'arrêt uniquement). */
  exitFrame(wx: number, wy: number, wz: number, heading?: number): void {
    const h = heading !== undefined ? heading : this.heading + (this.frame ? this.frame.yaw() : 0);
    this.frame = null;
    this.teleport(wx, wy, wz, h);
  }

  /** Interpolation LOCALE (avant composition wagon) — consommée par la caméra à bord. */
  renderLocalPosition(alpha: number, out: Vector3): Vector3 {
    out.copy(this.prevPosition).lerp(this.position, alpha);
    out.x += this.prevWallOff.x + (this.wallOff.x - this.prevWallOff.x) * alpha;
    out.z += this.prevWallOff.z + (this.wallOff.z - this.prevWallOff.z) * alpha;
    return out;
  }

  /** Position visuelle interpolée entre les deux derniers pas fixes (α ∈ [0,1[),
   *  composée avec la pose interpolée du wagon à bord (même alpha — zéro nage). */
  renderPosition(alpha: number, out: Vector3): Vector3 {
    this.renderLocalPosition(alpha, out);
    if (this.frame) {
      const th = this.frame.renderYaw(alpha);
      this.frame.renderOrigin(alpha, _fo);
      const c = Math.cos(th);
      const s = Math.sin(th);
      const lx = out.x;
      const lz = out.z;
      out.x = _fo.x + c * lx + s * lz;
      out.y = _fo.y + out.y;
      out.z = _fo.z - s * lx + c * lz;
    }
    return out;
  }

  /** Cap visuel interpolé par l'arc le plus court (wrap ±π), + yaw du wagon à bord
   *  (déroulé par construction dans la table de la voie — pas de couture). */
  renderHeading(alpha: number): number {
    let diff = this.heading - this.prevHeading;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    return this.prevHeading + diff * alpha + (this.frame ? this.frame.renderYaw(alpha) : 0);
  }

  /** Inclinaison visuelle interpolée du buste (grimpe) — rotation.x du modèle. */
  renderLean(alpha: number): number {
    return this.prevLean + (this.lean - this.prevLean) * alpha;
  }

  /** La caméra est construite après le contrôleur (elle a besoin de sa position). */
  setYawProvider(provider: YawProvider): void {
    this.cameraYaw = provider;
  }

  get speed(): number {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  get grounded(): boolean {
    return this.loco === 'ground';
  }

  get climbing(): boolean {
    return this.loco === 'climb';
  }

  get vaulting(): boolean {
    return this.loco === 'vault';
  }

  /** Attaques possibles : au sol uniquement (ni air, ni paroi, ni vault, ni train). */
  get canAttack(): boolean {
    return this.loco === 'ground' && this.frame === null;
  }

  /** Verrou de combat : gèle l'input de déplacement et force le cap (auto-aim). */
  setCombatDrive(active: boolean, headingRad?: number): void {
    this.combatDrive = active;
    if (headingRad !== undefined) this.combatHeading = headingRad;
  }

  /** Impulsion externe (m/s) : pas-en-avant d'attaque, knockback subi. */
  /** Déblocage du planeur (fin de la quête M7). */
  unlockGlider(): void {
    this.gliderUnlocked = true;
    console.info('[Quest] planeur DÉBLOQUÉ');
  }

  /** Root de gel (coup Cryo) : ignoré hors sol — jamais en grimpe/air/wagon. */
  applyRoot(s: number): void {
    if (this.loco === 'ground' && !this.frame) this.rootedLeft = Math.max(this.rootedLeft, s);
  }

  addImpulse(vx: number, vz: number): void {
    this.impulseX += vx;
    this.impulseZ += vz;
  }

  fixedUpdate(dt: number): void {
    this.prevPosition.copy(this.position);
    this.prevHeading = this.heading;
    this.prevLean = this.lean;
    this.prevWallOff.copy(this.wallOff);
    this.elapsed += dt;
    const input = this.input;

    // ---- Direction souhaitée, relative à la caméra ----
    this.rootedLeft = Math.max(0, this.rootedLeft - dt);
    const rooted = this.rootedLeft > 0 && this.loco === 'ground';
    let fx = 0;
    let fz = 0;
    if (!this.combatDrive && !rooted) {
      if (input.isDown('KeyW')) fz += 1;
      if (input.isDown('KeyS')) fz -= 1;
      if (input.isDown('KeyA')) fx -= 1;
      if (input.isDown('KeyD')) fx += 1;
    }
    // À bord : le yaw caméra (monde) est exprimé dans le repère local du wagon —
    // W pousse toujours vers l'avant-caméra, quel que soit le cap du train
    const yaw = this.cameraYaw.yaw - (this.frame ? this.frame.yaw() : 0);
    // forward caméra projeté sur XZ = (-sin yaw, -cos yaw) ; right = (cos yaw, -sin yaw)... (voir ThirdPersonCamera)
    const fwdX = -Math.sin(yaw);
    const fwdZ = -Math.cos(yaw);
    const rightX = Math.cos(yaw);
    const rightZ = -Math.sin(yaw);
    let wishX = fwdX * fz + rightX * fx;
    let wishZ = fwdZ * fz + rightZ * fx;
    const wishLen = Math.hypot(wishX, wishZ);
    const moving = wishLen > 0.01;
    if (moving) {
      wishX /= wishLen;
      wishZ /= wishLen;
    }

    // ---- Sprint & endurance ----
    const st = this.stamina;
    const wantSprint = input.isDown('ShiftLeft') && moving && this.loco === 'ground';
    if (st.exhausted && st.value >= MOVEMENT.staminaMinToSprint) st.exhausted = false;
    st.sprinting = wantSprint && !st.exhausted && st.value > 0;
    if (st.sprinting) {
      st.value = Math.max(0, st.value - MOVEMENT.staminaDrainPerS * dt);
      this.sprintStopTime = this.elapsed;
      if (st.value === 0) st.exhausted = true;
    } else if (this.gliding && this.loco === 'air') {
      // Plané (M7) : drain continu — épuisée = DÉCROCHAGE. La montée (M9)
      // coûte plus cher : voler librement n'est pas gratuit
      const climbing = this.spaceArmed && input.isDown('Space');
      st.value = Math.max(0, st.value - (climbing ? GLIDER.staminaClimbPerS : GLIDER.staminaPerS) * dt);
      this.sprintStopTime = this.elapsed;
      if (st.value === 0) {
        st.exhausted = true;
        this.gliding = false;
      }
    } else if (
      this.loco !== 'climb' && this.loco !== 'vault' && // zéro regen accroché
      this.elapsed - this.sprintStopTime > MOVEMENT.staminaRegenDelayS
    ) {
      st.value = Math.min(st.max, st.value + MOVEMENT.staminaRegenPerS * dt);
    }

    // ---- Branches paroi : la grimpe et le vault possèdent tout le pas ----
    if (this.loco === 'climb') {
      this.climbStep(dt, wishX, wishZ);
      this.applyMode();
      return;
    }
    if (this.loco === 'vault') {
      this.vaultStep(dt);
      this.applyMode();
      return;
    }
    this.wallHitSlope = 0;

    // ---- Vitesse horizontale ----
    const targetSpeed = moving ? (st.sprinting ? MOVEMENT.sprintSpeed : MOVEMENT.runSpeed) : 0;
    // Glissance (M6) : sur la glace, tout devient mou — accélération faible,
    // longue glissade sans input, grands arcs, demi-tour qui « patine »
    const onIce = this.loco === 'ground' && !this.frame
      && (this.g.getSurface?.(this.position.x, this.position.z) ?? 'default') === 'ice';
    const accel = onIce ? ICE.accel : MOVEMENT.accelGround;
    const decel = onIce ? ICE.decel : MOVEMENT.accelGround;
    const turnRateDeg = onIce ? ICE.turnRateDegPerS : MOVEMENT.turnRateDegPerS;
    const revBrake = onIce ? ICE.reverseBrakeDecel : MOVEMENT.reverseBrakeDecel;
    if (this.loco === 'ground') {
      // Steering en arc : la trajectoire TOURNE à vitesse angulaire bornée au
      // lieu de sauter instantanément vers la direction voulue — le personnage
      // dessine des virages au lieu de zigzaguer, et le modèle (qui suit la
      // vélocité) ne glisse plus en travers de son déplacement.
      let speed = this.speed;
      let ang = speed > 0.01 ? Math.atan2(this.velocity.x, this.velocity.z) : this.heading;
      this.pivoting = false;
      if (moving) {
        const wishAng = Math.atan2(wishX, wishZ);
        let diff = wishAng - ang;
        while (diff > Math.PI) diff -= 2 * Math.PI;
        while (diff < -Math.PI) diff += 2 * Math.PI;
        const reverse = Math.abs(diff) > (MOVEMENT.reverseAngleDeg * Math.PI) / 180;
        if (speed <= MOVEMENT.steerSnapSpeed) {
          // Départ (ou fin de pivot) : on part directement dans la bonne direction
          ang = wishAng;
          speed = Math.min(targetSpeed, speed + accel * dt);
        } else if (reverse) {
          // Demi-tour : freinage-pivot — on plante l'appui, la direction
          // s'inverse une fois la vitesse retombée (branche ci-dessus)
          this.pivoting = true;
          speed = Math.max(0, speed - revBrake * dt);
        } else {
          const maxTurn = (turnRateDeg * Math.PI / 180) * dt;
          ang += Math.min(Math.max(diff, -maxTurn), maxTurn);
          speed += Math.min(Math.max(targetSpeed - speed, -accel * dt), accel * dt);
        }
      } else {
        speed = Math.max(0, speed - decel * dt);
      }
      this.velocity.x = Math.sin(ang) * speed;
      this.velocity.z = Math.cos(ang) * speed;
    } else if (!(this.gliding && !moving)) {
      // En l'air : contrôle vectoriel amorti (conserve l'élan du saut).
      // En PLANÉ sans input : l'élan est conservé tel quel (vol Genshin) —
      // d'où le garde ci-dessus. Avec input : accel/vitesse du planeur.
      const aTarget = this.gliding ? GLIDER.maxSpeed : targetSpeed;
      const tx = wishX * aTarget;
      const tz = wishZ * aTarget;
      const dvx = tx - this.velocity.x;
      const dvz = tz - this.velocity.z;
      const dvLen = Math.hypot(dvx, dvz);
      const maxDv = (this.gliding ? GLIDER.accel : MOVEMENT.accelAir) * dt;
      if (dvLen > maxDv && dvLen > 0) {
        this.velocity.x += (dvx / dvLen) * maxDv;
        this.velocity.z += (dvz / dvLen) * maxDv;
      } else {
        this.velocity.x = tx;
        this.velocity.z = tz;
      }
    }

    // ---- Saut, planeur & gravité ----
    this.glideCooldown = Math.max(0, this.glideCooldown - dt);
    // wasPressed N'EST PAS consommé : mémoriser si on était DÉJÀ en l'air avant
    // le saut, sinon l'appui de saut ouvrirait les ailes sur la même frame
    const wasAirAtStart = this.loco === 'air';
    const updraft = !this.frame && this.wind
      ? this.wind.updraftAt(this.position.x, this.position.y, this.position.z)
      : 0;
    // Décollage par colonne de vent (même depuis le sol)
    if (this.loco === 'ground' && updraft > 0) {
      this.loco = 'air';
      this.velocity.y = Math.max(this.velocity.y, 2);
    }
    if (this.loco === 'ground' && !this.combatDrive && !rooted && input.wasPressed('Space')) {
      this.velocity.y = MOVEMENT.jumpVelocity;
      this.loco = 'air';
    }
    // Ouverture du plané (Espace en l'air, planeur débloqué, hors wagon).
    // FERMETURE (M9) : un TAP court d'Espace en vol — le MAINTIEN fait monter
    if (wasAirAtStart && this.loco === 'air' && this.gliderUnlocked && !this.frame
      && this.glideCooldown <= 0 && !this.gliding && input.wasPressed('Space')) {
      this.gliding = true;
      this.glideCooldown = GLIDER.toggleCooldownS;
      this.spaceArmed = false; // le front d'ouverture ne compte pas comme maintien
      this.spaceHold = 0;
    }
    let wantUp = false;
    let wantDown = false;
    if (this.gliding && this.loco === 'air') {
      if (input.isDown('Space')) {
        if (this.spaceArmed) {
          this.spaceHold += dt;
          wantUp = true; // montée immédiate — un tap ne lève que ~1 m avant de fermer
        }
      } else {
        // Tap bref → replier les ailes. Deux formes : maintien court observé
        // puis relâché, OU appui+relâche dans le MÊME pas fixe (isDown n'a
        // jamais été vu à vrai — seul wasPressed en témoigne)
        const subFrameTap = input.wasPressed('Space');
        if (this.spaceArmed && ((this.spaceHold > 0 && this.spaceHold <= GLIDER.tapCloseS) || subFrameTap)) {
          this.gliding = false;
          this.glideCooldown = GLIDER.toggleCooldownS;
        }
        this.spaceArmed = true;
        this.spaceHold = 0;
      }
      wantDown = !wantUp && input.isDown('ShiftLeft'); // Maj = piqué (le sprint est sol-only)
    } else {
      this.spaceArmed = false;
      this.spaceHold = 0;
    }
    if (this.loco === 'air') {
      if (updraft > 0) {
        // Porté par le vent : ascension bornée ; les ailes s'ouvrent d'elles-mêmes
        this.velocity.y = Math.min(this.velocity.y + updraft * dt, WINDCOLS.maxRise);
        if (this.gliderUnlocked) this.gliding = true;
      } else if (this.gliding) {
        // Vol libre (M9) : vitesse verticale CIBLÉE (montée/piqué/plané neutre),
        // approche à accélération bornée — le plané neutre converge vers le
        // même −sinkRate qu'avant (gates du défi des vents intacts)
        const vTarget = wantUp ? GLIDER.riseRate : wantDown ? -GLIDER.diveRate : -GLIDER.sinkRate;
        const dv = vTarget - this.velocity.y;
        const maxDv = GLIDER.vertAccel * dt;
        this.velocity.y += Math.max(-maxDv, Math.min(maxDv, dv));
        // Freinage de chute : jamais plus vite que la chute cible — le clamp
        // instantané du M7 (ouvrir les ailes en pleine chute stoppe net)
        if (vTarget <= 0 && this.velocity.y < vTarget) this.velocity.y = vTarget;
      } else {
        this.velocity.y += MOVEMENT.gravity * dt;
      }
    }
    // Tendance verticale lissée pour le rendu (battement d'ailes, buste)
    const vertGoal = this.gliding ? (wantUp ? 1 : wantDown ? -1 : 0) : 0;
    this.glideVert += (vertGoal - this.glideVert) * Math.min(1, dt * 6);

    // ---- Intégration avec glissement sur pente raide (axes séparés) ----
    const tryMove = (dx: number, dz: number): boolean => {
      const nx = this.position.x + dx;
      const nz = this.position.z + dz;
      if (!this.g.inBounds(nx, nz)) return false;
      // Obstacles statiques (troncs, rochers, clôture) — le slide par axes
      // ci-dessous fournit le contournement
      if (this.obs?.blocked(nx, nz, CHARACTER.capsuleRadius)) return false;
      const slope = this.g.getSlopeDeg(nx, nz);
      const newH = this.g.getHeight(nx, nz);
      // Mur souple : pente trop raide ET montée. Seuil quasi nul : un seuil fixe
      // par pas (ex. 5 cm) laisserait grimper n'importe quelle falaise à basse
      // vitesse (montée par pas < seuil) — confirmé par la review.
      if (slope > MOVEMENT.maxWalkableSlopeDeg && newH > this.position.y + 0.001) {
        // Contact avec un mur de pente : mémorisé pour tryAttach. TOUT refus de
        // pente compte — le joueur s'équilibre pile sur la ligne des 50°, où la
        // pente échantillonnée reste sous minSlopeDeg ; c'est la sonde à 0,45 m
        // (qui lit plus profond dans la paroi) qui juge la grimpabilité. Les
        // refus bornes/obstacles ne comptent pas (pas d'accroche sur une clôture).
        this.wallHitSlope = Math.max(this.wallHitSlope, slope);
        return false;
      }
      this.position.x = nx;
      this.position.z = nz;
      return true;
    };
    const stepX = (this.velocity.x + this.impulseX) * dt;
    const stepZ = (this.velocity.z + this.impulseZ) * dt;
    if (!tryMove(stepX, stepZ)) {
      const movedX = tryMove(stepX, 0);
      const movedZ = tryMove(0, stepZ);
      if (!movedX) this.velocity.x = 0;
      if (!movedZ) this.velocity.z = 0;
    }
    const impDecay = Math.exp(-dt / 0.08);
    this.impulseX *= impDecay;
    this.impulseZ *= impDecay;

    // ---- Suivi du sol / atterrissage ----
    const groundH = this.g.getHeight(this.position.x, this.position.z);
    if (this.loco === 'ground') {
      if (this.position.y - groundH > UP_EPS) {
        this.loco = 'air'; // sorti d'un rebord
      } else {
        this.position.y = groundH;
        this.velocity.y = 0;
      }
    } else {
      this.position.y += this.velocity.y * dt;
      // Plafond du wagon : le saut à bord est un petit hop borné
      if (this.frame) {
        const maxY = this.frame.ceilingY - CHARACTER.heightMeters;
        if (this.position.y > maxY) {
          this.position.y = maxY;
          if (this.velocity.y > 0) this.velocity.y = 0;
        }
      }
      // Contact = atterrissage, même en pleine ascension : en sautant vers une
      // pente montante, le sol peut « rattraper » le personnage avant l'apex —
      // sans ce clamp il s'enfonce sous le terrain puis s'y téléporte.
      if (this.position.y <= groundH) {
        this.position.y = groundH;
        this.velocity.y = 0;
        this.loco = 'ground';
      }
    }
    // Atterrissage / accroche : les ailes se replient
    if (this.loco !== 'air') this.gliding = false;

    // ---- Orientation du modèle (amortie) ----
    if (this.combatDrive) {
      this.heading = this.combatHeading; // cap forcé par l'auto-aim (déjà lissé)
    } else if (this.speed > 0.5) {
      const targetHeading = Math.atan2(this.velocity.x, this.velocity.z);
      let diff = targetHeading - this.heading;
      while (diff > Math.PI) diff -= 2 * Math.PI;
      while (diff < -Math.PI) diff += 2 * Math.PI;
      this.heading += diff * (1 - Math.exp(-dt / MOVEMENT.turnSmoothTime));
    }

    // ---- Accroche à une paroi grimpable rencontrée ce pas ----
    this.tryAttach(wishX, wishZ, moving);

    this.applyMode();
    // Hors paroi : le buste se redresse et le modèle revient sur l'ancre
    this.lean += (0 - this.lean) * (1 - Math.exp(-dt / 0.08));
    this.wallOff.multiplyScalar(Math.exp(-dt / CLIMB.offsetSmoothTime));
  }

  // ---- Grimpe ----

  /** Accroche (sol ou air) : gates communs puis recherche de l'ancre sur la paroi. */
  private tryAttach(wishX: number, wishZ: number, moving: boolean): void {
    if (this.frame && !this.frame.allowClimb) return; // pas de grimpe sur le wagon
    if (!moving || this.wallHitSlope <= 0) return;
    if (this.stamina.exhausted || this.elapsed < this.releaseUntil) return;

    const p1x = this.position.x + wishX * CLIMB.attachProbe;
    const p1z = this.position.z + wishZ * CLIMB.attachProbe;
    const slopeP1 = this.g.getSlopeDeg(p1x, p1z);
    if (slopeP1 < CLIMB.minSlopeDeg || slopeP1 > CLIMB.maxSlopeDeg) return;
    this.g.getNormal(p1x, p1z, _n);
    const oLen = Math.hypot(_n.x, _n.z);
    if (oLen < 1e-4) return;
    // Poussée VERS la paroi requise (élimine l'accroche en marche rasante)
    if ((wishX * -_n.x + wishZ * -_n.z) / oLen < CLIMB.attachDot) return;

    if (this.loco === 'air') {
      // Point de contact À L'ALTITUDE COURANTE (la paroi devant nous à hauteur du corps)
      let sHit = -1;
      for (let s = CLIMB.airProbeStep; s <= CLIMB.airProbeMax + 1e-6; s += CLIMB.airProbeStep) {
        if (this.g.getHeight(this.position.x + wishX * s, this.position.z + wishZ * s) >= this.position.y) {
          sHit = s;
          break;
        }
      }
      if (sHit < 0) return;
      const sMid = sHit - CLIMB.airProbeStep / 2;
      const s2 = this.g.getHeight(this.position.x + wishX * sMid, this.position.z + wishZ * sMid) >= this.position.y ? sMid : sHit;
      const ax = this.position.x + wishX * s2;
      const az = this.position.z + wishZ * s2;
      const ah = this.g.getHeight(ax, az);
      if (Math.abs(ah - this.position.y) > CLIMB.airSnapTol) return;
      const aSlope = this.g.getSlopeDeg(ax, az);
      if (aSlope < CLIMB.minSlopeDeg || aSlope > CLIMB.maxSlopeDeg) return;
      this.enterClimb(ax, ah, az, aSlope);
      return;
    }

    // Au sol : la paroi doit MONTER, puis marche d'ancre jusqu'à la pente grimpable
    if (this.g.getHeight(p1x, p1z) < this.position.y + CLIMB.attachMinRise) return;
    for (let i = 1; i <= CLIMB.anchorSteps; i++) {
      const ax = this.position.x + wishX * CLIMB.anchorStep * i;
      const az = this.position.z + wishZ * CLIMB.anchorStep * i;
      const aSlope = this.g.getSlopeDeg(ax, az);
      if (aSlope >= CLIMB.minSlopeDeg) {
        if (aSlope > CLIMB.maxSlopeDeg) return;
        this.enterClimb(ax, this.g.getHeight(ax, az), az, aSlope);
        return;
      }
    }
  }

  private enterClimb(x: number, y: number, z: number, slope: number): void {
    this.position.set(x, y, z);
    this.velocity.set(0, 0, 0);
    this.loco = 'climb';
    this.climbRate = 0;
    this.sprintStopTime = this.elapsed; // arme le délai de regen pour le lâcher
    console.info(`[Climb] attach slope=${slope.toFixed(0)}`);
  }

  /** Un pas de grimpe : lâcher, décroche bas, déplacement tangent, drain, vault. */
  private climbStep(dt: number, wishX: number, wishZ: number): void {
    if (this.input.wasPressed('Space')) {
      this.forceRelease(true);
      return;
    }

    const slopeHere = this.g.getSlopeDeg(this.position.x, this.position.z);
    // Pied de paroi / sortie latérale : la pente sous l'ancre redevient marchable
    if (slopeHere < CLIMB.detachSlopeDeg) {
      this.loco = 'ground';
      this.position.y = this.g.getHeight(this.position.x, this.position.z);
      this.velocity.set(0, 0, 0);
      this.climbRate = 0;
      return;
    }

    this.g.getNormal(this.position.x, this.position.z, _n);
    const oLen = Math.hypot(_n.x, _n.z);
    if (oLen < 1e-4) {
      this.loco = 'ground';
      this.climbRate = 0;
      return;
    }
    const ox = _n.x / oLen;
    const oz = _n.z / oLen;

    // Projection de l'input caméra-relatif sur le plan tangent :
    // a = montée (ligne de plus grande pente), b = traversée (courbe de niveau)
    let a = wishX * -ox + wishZ * -oz;
    let b = wishX * oz + wishZ * -ox;
    const len = Math.hypot(a, b);
    if (len > 1) {
      a /= len;
      b /= len;
    }

    if (len < 0.05) {
      // Suspension immobile : gratuite (zéro drain — la regen est déjà coupée)
      this.climbRate = 0;
      this.velocity.set(0, 0, 0);
    } else {
      const st = this.stamina;
      st.value = Math.max(0, st.value - CLIMB.staminaDrainPerS * dt);
      this.sprintStopTime = this.elapsed;
      if (st.value === 0) {
        st.exhausted = true;
        this.forceRelease(false);
        return;
      }

      // Repère tangent unitaire fermé : u = amont SUR la surface (‖u‖=1 car
      // n.y² + oLen² = 1), r = latéral horizontal. Pas en abscisse curviligne :
      // la composante XZ se contracte d'elle-même en cos θ, jamais de survitesse Y.
      const step = CLIMB.climbSpeed * dt;
      const dxW = (-ox * _n.y * a + oz * b) * step;
      const dyW = oLen * a * step;
      const dzW = (-oz * _n.y * a + -ox * b) * step;

      const nx = this.position.x + dxW;
      const nz = this.position.z + dzW;
      const yExpected = this.position.y + dyW;
      const hNew = this.g.getHeight(nx, nz);
      // Bornes du monde (ex-clamp) : on reste ancré ce pas plutôt que de glisser
      if (this.g.inBounds(nx, nz) && Math.abs(hNew - yExpected) <= CLIMB.moveGuard) {
        this.velocity.set((nx - this.position.x) / dt, (hNew - this.position.y) / dt, (nz - this.position.z) / dt);
        this.position.set(nx, hNew, nz);
      } else {
        // Anomalie de crête : on reste ancré ce pas (le check de vault répond)
        this.velocity.set(0, 0, 0);
      }
      this.climbRate = CLIMB.climbSpeed * len * (a < -0.3 ? -1 : 1);

      // Sommet : le terrain juste au-dessus redevient marchable → vault scripté
      if (a > 0.1) {
        const p2x = this.position.x - ox * CLIMB.vaultProbeAhead;
        const p2z = this.position.z - oz * CLIMB.vaultProbeAhead;
        const rise = this.g.getHeight(p2x, p2z) - this.position.y;
        if (
          this.g.getSlopeDeg(p2x, p2z) < CLIMB.detachSlopeDeg &&
          rise > -0.5 && rise < CLIMB.vaultMaxRise &&
          this.g.inBounds(p2x, p2z) &&
          !this.obs?.blocked(p2x, p2z, CHARACTER.capsuleRadius)
        ) {
          this.vaultFrom.copy(this.position);
          this.vaultTo.set(p2x, this.g.getHeight(p2x, p2z), p2z);
          this.vaultT = 0;
          this.loco = 'vault';
          this.climbRate = 0;
          console.info(`[Climb] vault (${p2x.toFixed(1)}, ${p2z.toFixed(1)})`);
          return;
        }
      }
    }

    // Cap face à la paroi + buste incliné vers elle (lissés — la paroi est en arc)
    const targetHeading = Math.atan2(-ox, -oz);
    let diff = targetHeading - this.heading;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    this.heading += diff * (1 - Math.exp(-dt / CLIMB.headingSmoothTime));
    _off.set(ox * CLIMB.modelOffset, 0, oz * CLIMB.modelOffset);
    this.wallOff.lerp(_off, 1 - Math.exp(-dt / CLIMB.offsetSmoothTime));
    const leanTarget = Math.min(
      (CLIMB.leanFrac * (90 - slopeHere) * Math.PI) / 180,
      (CLIMB.leanMaxDeg * Math.PI) / 180,
    );
    this.lean += (leanTarget - this.lean) * (1 - Math.exp(-dt / 0.08));
  }

  /** Lâcher la paroi : hop arrière (Espace) ou chute pure (épuisement). */
  private forceRelease(hop: boolean): void {
    this.g.getNormal(this.position.x, this.position.z, _n);
    const oLen = Math.hypot(_n.x, _n.z);
    const ox = oLen > 1e-4 ? _n.x / oLen : 0;
    const oz = oLen > 1e-4 ? _n.z / oLen : 1;
    this.loco = 'air';
    this.climbRate = 0;
    this.releaseUntil = this.elapsed + CLIMB.reattachCooldownS;
    if (hop) this.velocity.set(ox * CLIMB.releaseHopSpeed, CLIMB.releaseHopUp, oz * CLIMB.releaseHopSpeed);
    else this.velocity.set(0, 0, 0);
    console.info(`[Climb] release ${hop ? 'hop' : 'exhausted'}`);
  }

  /** Franchissement scripté du rebord : lerp + petit arc, input ignoré. */
  private vaultStep(dt: number): void {
    this.vaultT += dt / CLIMB.vaultDurationS;
    const t = Math.min(this.vaultT, 1);
    const k = t * t * (3 - 2 * t);
    this.position.lerpVectors(this.vaultFrom, this.vaultTo, k);
    this.position.y += Math.sin(Math.PI * t) * CLIMB.vaultArc;
    this.velocity.set(0, 0, 0);
    if (this.vaultT >= 1) {
      this.position.copy(this.vaultTo);
      this.position.y = this.g.getHeight(this.position.x, this.position.z);
      this.loco = 'ground';
    }
    this.lean += (0 - this.lean) * (1 - Math.exp(-dt / 0.08));
    this.wallOff.multiplyScalar(Math.exp(-dt / CLIMB.offsetSmoothTime));
  }

  // ---- Mode d'animation ----
  // `pivoting` maintient 'walk' pendant le freinage-pivot du demi-tour (la
  // vitesse passe par ~0, l'anim flasherait idle en plein virage). Un simple
  // garde sur l'input ferait marcher sur place face à un mur/pente bloquante
  // (vitesse zéroée par tryMove mais touches enfoncées) — trouvé en revue
  private applyMode(): void {
    if (this.loco === 'climb') this.mode = 'climb';
    else if (this.loco === 'air' && this.gliding) this.mode = 'glide';
    else if (this.loco !== 'ground') this.mode = 'air'; // air + vault (anim jump)
    else if (this.speed < 0.2 && !this.pivoting) this.mode = 'idle';
    else if (this.speed < 3.4) this.mode = 'walk';
    else if (this.speed < (MOVEMENT.runSpeed + MOVEMENT.sprintSpeed) / 2) this.mode = 'run';
    else this.mode = 'sprint';
  }
}

const _n = new Vector3();
const _off = new Vector3();
const _fo = new Vector3();
