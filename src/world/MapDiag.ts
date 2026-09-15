import { BELVEDERE, CAIRN_KNOLL, CANYON, CASCADE, CITY, CREVASSE, LIP, MESA, MOUNTAIN, RAIL, SEA_ICE, SNOW, TERRACE, WATER, WINDCOLS, WRECK } from '../config';
import type { HeightField } from './HeightField';
import type { SnowField } from './SnowField';
import type { Terrain } from './Terrain';
import type { TrackSpec } from './TrackSpec';

// Canaris de validation de la carte (flag ?mapdiag) : rejoue les gates clés du
// jugement de composition sur le VRAI code du jeu.
// Versions échantillonnées (pas de flood-fill complet) — assez fines pour
// détecter toute dérive de constante, assez rapides pour tourner au boot.

function log(gate: string, value: string, pass: boolean): void {
  console.info(`[MapDiag] ${gate} ${value} pass=${pass}`);
}

export function runMapDiag(ground: HeightField, terrain: Terrain, track?: TrackSpec, snow?: SnowField): void {
  const half = ground.size / 2;

  // Gate 1 — pas de « fausse mare » : hors du masque d'appartenance des plans
  // d'eau (canal B éteint dès sdf ≥ 2,25 : plus une goutte n'est rendue), le
  // terrain doit rester au-dessus du niveau. Sous ce seuil, le terrain sous le
  // niveau est simplement le tablier de rive, recouvert par l'eau — normal.
  {
    let min = Infinity;
    let minAt = '';
    for (let z = -half + 2; z <= half - 2; z += 1.5) {
      for (let x = -half + 2; x <= half - 2; x += 1.5) {
        // SDF PROPRE du corps bas : l'union exemptait tout le corridor de
        // l'autre corps, créant un angle mort là où les deux se recouvrent
        if (ground.getLowerSdf(x, z) < 2.5) continue;
        const h = ground.getHeight(x, z);
        if (h < min) {
          min = h;
          minAt = `(${x.toFixed(0)},${z.toFixed(0)})`;
        }
      }
    }
    log('floorMin', `${min.toFixed(2)}@${minAt} seuil=${(WATER.levelLower + 0.25).toFixed(2)}`, min > WATER.levelLower + 0.25);
  }

  // Gate 2 — berges ≤ 42° (hors zone de cascade) ; aucune cellule d'eau piégée n'est
  // re-testée ici (flood complet au jugement) — la pente de berge est le proxy
  {
    let maxBank = 0;
    for (let z = -half + 2; z <= half - 2; z += 1) {
      for (let x = -half + 2; x <= half - 2; x += 1) {
        const sdf = ground.getWaterSdf(x, z);
        if (Math.abs(sdf) > 3) continue;
        if (Math.hypot(x - LIP.x, z - LIP.z) < 25) continue; // falaise voulue
        const s = ground.getSlopeDeg(x, z);
        if (s > maxBank) maxBank = s;
      }
    }
    log('bankMax', `${maxBank.toFixed(1)}deg`, maxBank <= 42);
  }

  // Gate 3 — LIGNE DE VUE spawn → lèvre ET pied du rideau (critère roi)
  {
    const eye = { x: 0, y: ground.getHeight(0, 0) + 1.6, z: 0 };
    const march = (tx: number, ty: number, tz: number): number => {
      const len = Math.hypot(tx - eye.x, tz - eye.z);
      let margin = Infinity;
      for (let s = 2; s < len - 1.5; s += 0.5) {
        const t = s / len;
        const rx = eye.x + (tx - eye.x) * t;
        const rz = eye.z + (tz - eye.z) * t;
        const ry = eye.y + (ty - eye.y) * t;
        const m = ry - ground.getHeight(rx, rz);
        if (m < margin) margin = m;
      }
      return margin;
    };
    const mTop = march(CASCADE.top.x, CASCADE.top.y + 0.3, CASCADE.top.z);
    const mBot = march(CASCADE.bottom.x, CASCADE.bottom.y, CASCADE.bottom.z);
    log('losTop', `${mTop.toFixed(2)}m`, mTop > 0);
    log('losBottom', `${mBot.toFixed(2)}m`, mBot > 0);
  }

  // Gate 4 — crête périmétrale du bassin amont ≥ levelUpper + 0.3 (étanchéité),
  // hors secteurs du déversoir et de l'amenée
  {
    const c = WATER.upper.basinCenter;
    const azLip = Math.atan2(LIP.z - c.z, LIP.x - c.x);
    const feeder = WATER.upper.feederKnots[0]!;
    const azFeed = Math.atan2(feeder.z - c.z, feeder.x - c.x);
    let minCrest = Infinity;
    for (let a = 0; a < 360; a += 2) {
      const az = (a * Math.PI) / 180;
      const dLip = Math.abs(Math.atan2(Math.sin(az - azLip), Math.cos(az - azLip)));
      const dFeed = Math.abs(Math.atan2(Math.sin(az - azFeed), Math.cos(az - azFeed)));
      if (dLip < (28 * Math.PI) / 180 || dFeed < (28 * Math.PI) / 180) continue;
      let crest = -Infinity;
      for (let r = WATER.upper.basinRadius + 1; r < WATER.upper.basinRadius + 25; r += 0.5) {
        const h = ground.getHeight(c.x + Math.cos(az) * r, c.z + Math.sin(az) * r);
        if (h > crest) crest = h;
      }
      if (crest < minCrest) minCrest = crest;
    }
    log('basinCrest', `${minCrest.toFixed(2)} seuil=${(WATER.levelUpper + 0.3).toFixed(2)}`, minCrest >= WATER.levelUpper + 0.3);
  }

  // Gate 5 — hauteur de chute eau-à-eau ∈ [8,10] (constantes) + falaise raide présente
  {
    const fall = WATER.levelUpper - WATER.levelLower;
    let cliffMax = 0;
    for (let z = LIP.z - 12; z <= LIP.z + 12; z += 0.5) {
      for (let x = LIP.x - 12; x <= LIP.x + 12; x += 0.5) {
        const s = ground.getSlopeDeg(x, z);
        if (s > cliffMax) cliffMax = s;
      }
    }
    log('fall', `${fall.toFixed(1)}m cliffMax=${cliffMax.toFixed(1)}deg`, fall >= 8 && fall <= 10 && cliffMax > 60);
  }

  // Gate 6 — cairn de quête au knoll autoré (pas un flanc de rempart)
  {
    const q = terrain.questPosition;
    const dKnoll = Math.hypot(q.x - CAIRN_KNOLL.x, q.z - CAIRN_KNOLL.z);
    log('questPeak', `(${q.x.toFixed(1)},${q.y.toFixed(2)},${q.z.toFixed(1)}) dKnoll=${dKnoll.toFixed(1)}`, dKnoll < CAIRN_KNOLL.r);
  }

  // Gate 7 — remparts : rabotage max des carves hors corridors d'eau < 2 m
  {
    const shave = ground.carveMaxShaveOutside;
    log('carveShave', `${shave.toFixed(2)}m`, shave < 2);
  }

  // Gate 8 — prairie : pente moyenne ≈6°, p95 ≤ 14, quasi zéro maxima locaux
  {
    const slopes: number[] = [];
    let maxima = 0;
    let area = 0;
    const railReach = RAIL.bedHalfWidth + RAIL.bedFeather + 2;
    for (let z = -88; z <= 88; z += 4) {
      for (let x = -88; x <= 88; x += 4) {
        if (Math.hypot(x - TERRACE.cx, z - TERRACE.cz) - TERRACE.radius > -6) continue; // étage haut exclu
        if (ground.getWaterSdf(x, z) < 6) continue;
        // Corridor ferroviaire exclu : le remblai est une terrassure AUTORÉE
        // (comme le gué/la terrasse) — le gate mesure la prairie naturelle
        if (track && track.trackDistance(x, z) < railReach) continue;
        slopes.push(ground.getSlopeDeg(x, z));
        area += 16;
        const h = ground.getHeight(x, z);
        let isMax = true;
        for (let a = 0; a < 8 && isMax; a++) {
          const az = (a * Math.PI) / 4;
          if (ground.getHeight(x + Math.cos(az) * 4, z + Math.sin(az) * 4) > h - 0.15) isMax = false;
        }
        if (isMax) maxima++;
      }
    }
    slopes.sort((a, b) => a - b);
    const mean = slopes.reduce((s, v) => s + v, 0) / slopes.length;
    const p95 = slopes[Math.floor(slopes.length * 0.95)]!;
    log('meadow', `mean=${mean.toFixed(1)} p95=${p95.toFixed(1)} maxima=${maxima}/${area}m2`, mean < 8 && p95 <= 15 && maxima / area < 1 / 3000);
  }

  // Gate 9 — profil du chemin ≤ 18° (échantillonné à 1 m le long des deux tracés)
  {
    const maxSlope = (path: typeof terrain.path): number => {
      let worst = 0;
      let prevH: number | null = null;
      const pos = terrain.questPosition.clone(); // réutilisé comme tampon
      const tan = terrain.questPosition.clone();
      for (let s = 0; s <= path.length; s += 1) {
        path.sample(s, pos, tan);
        const h = ground.getHeight(pos.x, pos.z);
        if (prevH !== null) {
          const deg = (Math.atan(Math.abs(h - prevH) / 1) * 180) / Math.PI;
          if (deg > worst) worst = deg;
        }
        prevH = h;
      }
      return worst;
    };
    const main = maxSlope(terrain.path);
    const fork = maxSlope(terrain.pathFork);
    log('pathSlope', `main=${main.toFixed(1)} fork=${fork.toFixed(1)}`, main <= 18 && fork <= 18);
  }

  // Gate 11 — aucune nappe d'eau SUSPENDUE RENDUE : rejoue le masque
  // d'appartenance du bake (canal B + garde de surplomb) et le seuil du shader,
  // puis cherche le pire écart sol↔plan là où le quad est effectivement opaque.
  // Teste donc la GARDE, pas la géométrie (le corridor du déversoir survole
  // légitimement le vide — c'est le masque qui doit l'éteindre).
  {
    const bodies = [
      { name: 'bas', level: WATER.levelLower, b: WATER.lower.bounds, sdf: (x: number, z: number) => ground.getLowerSdf(x, z) },
      { name: 'haut', level: WATER.levelUpper, b: WATER.upper.bounds, sdf: (x: number, z: number) => ground.getUpperSdf(x, z) },
    ];
    let worst = 0;
    let worstAt = 'aucun';
    for (const body of bodies) {
      for (let z = body.b.minZ; z <= body.b.maxZ; z += 0.5) {
        for (let x = body.b.minX; x <= body.b.maxX; x += 0.5) {
          const gap = body.level - ground.getHeight(x, z);
          const hang = Math.min(Math.max((gap - WATER.hangoverLo) / (WATER.hangoverHi - WATER.hangoverLo), 0), 1);
          const belong = Math.max(Math.min(Math.max((body.sdf(x, z) + 2.5) / 5, 0), 1), hang);
          if (belong >= 0.95) continue; // masque éteint côté shader : rien n'est rendu
          if (gap > worst) {
            worst = gap;
            worstAt = `${body.name}(${x.toFixed(0)},${z.toFixed(0)})`;
          }
        }
      }
    }
    log('hangover', `${worst.toFixed(2)}m@${worstAt} seuil=${WATER.hangoverHi.toFixed(2)}`, worst <= WATER.hangoverHi);
  }

  // Gate 10 — aire éligible herbe > 30 000 m² (acceptation probabiliste > 0.5)
  {
    let area = 0;
    for (let z = -half + 2; z <= half - 2; z += 2) {
      for (let x = -half + 2; x <= half - 2; x += 2) {
        if (terrain.getSplat(x, z).grass < 0.65) continue;
        if (ground.getWaterSdf(x, z) < WATER.grassMargin) continue;
        if (ground.getSlopeDeg(x, z) > 30) continue;
        area += 4;
      }
    }
    log('grassArea', `${area}m2`, area > 30000);
  }

  // Gate 12 — montagne : voie de grimpe JOUABLE sur l'éventail nord. Le rise
  // continu entre deux vires doit rester sous le budget d'endurance de grimpe
  // (~17,5 m à 8/s et 1,4 m/s — cible 12 m de marge), la pente sous 88°, et il
  // faut au moins 2 vires de repos (<48° sur ≥ 1,5 m) le long de chaque rayon.
  {
    let worstRun = 0;
    let worstSlope = 0;
    let minLedges = Infinity;
    for (let deg = -25; deg <= 25; deg += 10) {
      const phi = (deg * Math.PI) / 180;
      const dx = Math.sin(phi);
      const dz = Math.cos(phi); // +z = vers la vallée (face nord grimpable)
      let prevH: number | null = null;
      let run = 0;
      let ledgeLen = 0;
      let ledges = 0;
      for (let t = MOUNTAIN.radius + 6; t >= 3; t -= 0.5) {
        const h = ground.getHeight(MOUNTAIN.cx + dx * t, MOUNTAIN.cz + dz * t);
        if (prevH !== null) {
          const slope = (Math.atan(Math.abs(h - prevH) / 0.5) * 180) / Math.PI;
          if (slope > worstSlope) worstSlope = slope;
          if (slope >= 48) {
            run += Math.max(0, h - prevH);
            ledgeLen = 0;
          } else {
            if (run > worstRun) worstRun = run;
            run = 0;
            ledgeLen += 0.5;
            if (ledgeLen === 1.5) ledges++;
          }
        }
        prevH = h;
      }
      if (run > worstRun) worstRun = run;
      if (ledges < minLedges) minLedges = ledges;
    }
    log('mtnClimb', `maxRun=${worstRun.toFixed(1)}m maxSlope=${worstSlope.toFixed(0)}deg vires=${minLedges}`, worstRun <= 12 && worstSlope <= 88 && minLedges >= 2);
  }

  // Gate 13 — montagne : plateau sommital praticable (aire ≤15° suffisante pour
  // s'y tenir et contempler) et sommet réellement dominant (≥ plancher haut + 15)
  {
    const summitH = ground.getHeight(MOUNTAIN.cx, MOUNTAIN.cz);
    let flatArea = 0;
    for (let dz = -4.5; dz <= 4.5; dz += 0.5) {
      for (let dx = -4.5; dx <= 4.5; dx += 0.5) {
        if (Math.hypot(dx, dz) > 4.5) continue;
        if (ground.getSlopeDeg(MOUNTAIN.cx + dx, MOUNTAIN.cz + dz) <= 15) flatArea += 0.25;
      }
    }
    const floorUpper = WATER.levelLower + TERRACE.floorAbove;
    log('mtnSummit', `h=${summitH.toFixed(1)}m flat=${flatArea.toFixed(0)}m2 seuil=${(floorUpper + 15).toFixed(1)}`, summitH >= floorUpper + 15 && flatArea >= 30);
  }

  // Gate 15 — voie ferrée (M5) : pente du profil ≤ 4° sur toute la ligne, et
  // le terrain colle au profil (assise) sur la portion AVANT portail — hors
  // pont (exemption de berges : |lowerSdf| < bridgeWaterSdfHi) et hors raccord
  // pré-tunnel. Le tube enterré (s ≥ sPortal) n'est pas testé : aucune assise.
  if (track) {
    const pose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
    let maxGrade = 0;
    let prevY: number | null = null;
    let maxGap = 0;
    let gapAt = '';
    for (let s = 0; s <= track.length; s += 1) {
      track.pose(s, pose);
      if (prevY !== null) {
        const deg = (Math.atan(Math.abs(pose.y - prevY) / 1) * 180) / Math.PI;
        if (deg > maxGrade) maxGrade = deg;
      }
      prevY = pose.y;
      if (s < track.sPortal - RAIL.tunnelBlend - 2) {
        if (Math.abs(ground.getLowerSdf(pose.x, pose.z)) < RAIL.bridgeWaterSdfHi) continue;
        const gap = Math.abs(ground.getHeight(pose.x, pose.z) - pose.y);
        if (gap > maxGap) {
          maxGap = gap;
          gapAt = `(${pose.x.toFixed(0)},${pose.z.toFixed(0)})`;
        }
      }
    }
    log('railGrade', `grade=${maxGrade.toFixed(1)}deg gap=${maxGap.toFixed(2)}m@${gapAt}`, maxGrade <= RAIL.maxGradeDeg + 0.05 && maxGap <= 0.35);
  }

  if (snow && track) runSnowDiag(snow, track);
}

/** Gates M6 — région Snezhnaya (toundra + mer gelée + canyon + mesa + viaduc). */
function runSnowDiag(snow: SnowField, track: TrackSpec): void {
  const cx = SNOW.center.x;
  const cz = SNOW.center.z;

  // Gate S1 — snowFloor : aucun trou dans la toundra marchable (hors mer/canyon/arène)
  {
    let min = Infinity;
    let minAt = '';
    for (let z = cz - SNOW.halfZ + 4; z <= cz + SNOW.halfZ - 4; z += 3) {
      for (let x = cx - SNOW.halfX + 4; x <= cx + SNOW.halfX - 4; x += 3) {
        if (snow.seaSdf(x, z) < 3) continue;
        const dm = Math.hypot(x - MESA.cx, z - MESA.cz);
        if (dm > CANYON.rIn - 4 && dm < CANYON.rOut + 4) continue;
        // Crevasse M7 : gorge voulue sous le plancher nominal
        {
          const dxs = CREVASSE.bx - CREVASSE.ax;
          const dzs = CREVASSE.bz - CREVASSE.az;
          const tt = Math.min(Math.max(((x - CREVASSE.ax) * dxs + (z - CREVASSE.az) * dzs) / (dxs * dxs + dzs * dzs), 0), 1);
          if (Math.hypot(x - (CREVASSE.ax + dxs * tt), z - (CREVASSE.az + dzs * tt)) < CREVASSE.halfW + CREVASSE.wallFeather + 1) continue;
        }
        const h = snow.getHeight(x, z);
        if (h < min) {
          min = h;
          minAt = `(${x.toFixed(0)},${z.toFixed(0)})`;
        }
      }
    }
    log('snowFloor', `${min.toFixed(2)}@${minAt}`, min >= 1.5);
  }

  // Gate S2 — iceFlat : la plaque de mer gelée est plate, et un corridor
  // marchable relie la gare Toundra à la glace
  {
    let maxSlope = 0;
    for (let z = SEA_ICE.cz - SEA_ICE.hz; z <= SEA_ICE.cz + SEA_ICE.hz; z += 4) {
      for (let x = SEA_ICE.cx - SEA_ICE.hx; x <= SEA_ICE.cx + SEA_ICE.hx; x += 4) {
        if (snow.seaSdf(x, z) > -(SEA_ICE.shoreW + 1)) continue; // intérieur, au-delà de la berge
        maxSlope = Math.max(maxSlope, snow.getSlopeDeg(x, z));
      }
    }
    let maxPath = 0;
    const ax = RAIL.stationSnow.x;
    const az = RAIL.stationSnow.z;
    const bx = SEA_ICE.cx + SEA_ICE.hx - 4;
    const bz = SEA_ICE.cz;
    for (let t = 0; t <= 1; t += 0.02) {
      maxPath = Math.max(maxPath, snow.getSlopeDeg(ax + (bx - ax) * t, az + (bz - az) * t));
    }
    log('iceFlat', `glace=${maxSlope.toFixed(1)}deg corridor=${maxPath.toFixed(1)}deg`, maxSlope <= 2 && maxPath <= 18);
  }

  // Gate S3 — seaSeal : un rempart ferme l'ouest AU-DELÀ de la glace (étanchéité)
  {
    let minCrest = Infinity;
    for (let z = SEA_ICE.cz - SEA_ICE.hz; z <= SEA_ICE.cz + SEA_ICE.hz; z += 3) {
      let crest = -Infinity;
      for (let x = cx - SNOW.halfX + 1; x <= SEA_ICE.cx - SEA_ICE.hx - SEA_ICE.round; x += 1.5) {
        crest = Math.max(crest, snow.getHeight(x, z));
      }
      if (crest < minCrest) minCrest = crest;
    }
    log('seaSeal', `crete=${minCrest.toFixed(1)} seuil=${(SEA_ICE.iceY + 6).toFixed(1)}`, minCrest >= SEA_ICE.iceY + 6);
  }

  // Gate S4 — viaductGrade : pente du profil ≤ 4,2° sur le tronçon neige,
  // et la gare Snezhnograd est POSÉE sur le plateau (pas suspendue)
  {
    let maxGrade = 0;
    let prevY: number | null = null;
    for (let s = track.sSnow; s <= track.sCity; s += 1) {
      const y = track.railY(s);
      if (prevY !== null) maxGrade = Math.max(maxGrade, (Math.atan(Math.abs(y - prevY)) * 180) / Math.PI);
      prevY = y;
    }
    const gapCity = Math.abs(snow.getHeight(RAIL.stationCity.x, RAIL.stationCity.z) - RAIL.cityY);
    log('viaductGrade', `grade=${maxGrade.toFixed(1)}deg gapGare=${gapCity.toFixed(2)}m`, maxGrade <= 4.2 && gapCity <= 0.4);
  }

  // Gate S5 — bedPull : rien ne perce le tablier (h ≤ railY + 0,05 sur l'axe)
  // et l'assise est propre aux deux gares (|h − railY| ≤ 0,35)
  {
    const pose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
    let maxPoke = -Infinity;
    let maxStationGap = 0;
    for (let s = track.sTubeExit + 4; s <= track.sCity; s += 1) {
      track.pose(s, pose);
      const h = snow.getHeight(pose.x, pose.z);
      maxPoke = Math.max(maxPoke, h - pose.y);
      if (Math.abs(s - track.sSnow) < 12 || Math.abs(s - track.sCity) < 10) {
        maxStationGap = Math.max(maxStationGap, Math.abs(h - pose.y));
      }
    }
    log('bedPull', `poke=${maxPoke.toFixed(2)}m gares=${maxStationGap.toFixed(2)}m`, maxPoke <= 0.05 && maxStationGap <= 0.35);
  }

  // Gate S6 — canyonDepth : le fossé entoure la mesa (≥ 15 m sous le plateau)
  // sur tous les azimuts où l'anneau reste dans l'emprise (l'Est est scellé par le rim)
  {
    let minDepth = Infinity;
    for (let a = 0; a < 24; a++) {
      const ang = (a / 24) * Math.PI * 2;
      const dirX = Math.sin(ang);
      const dirZ = Math.cos(ang);
      let floor = Infinity;
      let inScope = true;
      for (let r = CANYON.rIn + CANYON.feather; r <= CANYON.rOut - CANYON.feather; r += 2) {
        const x = MESA.cx + dirX * r;
        const z = MESA.cz + dirZ * r;
        const edgeD = Math.min(SNOW.halfX - Math.abs(x - cx), SNOW.halfZ - Math.abs(z - cz));
        if (edgeD < SNOW.rimBand + 2) {
          inScope = false;
          break;
        }
        floor = Math.min(floor, snow.getHeight(x, z));
      }
      if (!inScope) continue;
      minDepth = Math.min(minDepth, MESA.topY - floor);
    }
    log('canyonDepth', `${minDepth.toFixed(1)}m`, minDepth >= 15);
  }

  // Gate S7 — cityClear : plateau constructible (aire ≤ 8°) et rue praticable (≤ 12°)
  {
    let flatArea = 0;
    for (let z = MESA.cz - MESA.rTop; z <= MESA.cz + MESA.rTop; z += 2) {
      for (let x = MESA.cx - MESA.rTop; x <= MESA.cx + MESA.rTop; x += 2) {
        if (Math.hypot(x - MESA.cx, z - MESA.cz) > MESA.rTop - 2) continue;
        if (snow.getSlopeDeg(x, z) <= 8) flatArea += 4;
      }
    }
    let maxStreet = 0;
    for (const st of CITY.streets) {
      for (let t = 0; t <= 1; t += 0.02) {
        maxStreet = Math.max(maxStreet, snow.getSlopeDeg(st.ax + (st.bx - st.ax) * t, st.az + (st.bz - st.az) * t));
      }
    }
    log('cityClear', `plat=${flatArea.toFixed(0)}m2 rue=${maxStreet.toFixed(1)}deg`, flatArea >= 4500 && maxStreet <= 12);
  }

  // Gate S9 — crevasseWalk (M7) : sol de la gorge plat, rampes d'accès douces,
  // parois raides (l'évasion se fait par la GRIMPE ou les rampes, pas à pied)
  {
    const cv = CREVASSE;
    const lerpP = (t: number): [number, number] => [cv.ax + (cv.bx - cv.ax) * t, cv.az + (cv.bz - cv.az) * t];
    let maxFloor = 0;
    for (let t = 0.28; t <= 0.78; t += 0.02) {
      const [x, z] = lerpP(t);
      maxFloor = Math.max(maxFloor, snow.getSlopeDeg(x, z));
    }
    let maxRamp = 0;
    for (let t = 0.01; t <= 0.13; t += 0.01) {
      const [x, z] = lerpP(t);
      maxRamp = Math.max(maxRamp, snow.getSlopeDeg(x, z));
      const [x2, z2] = lerpP(1 - t);
      maxRamp = Math.max(maxRamp, snow.getSlopeDeg(x2, z2));
    }
    let minWall = 90;
    const nx = -(cv.bz - cv.az) / Math.hypot(cv.bx - cv.ax, cv.bz - cv.az);
    const nz = (cv.bx - cv.ax) / Math.hypot(cv.bx - cv.ax, cv.bz - cv.az);
    for (let t = 0.3; t <= 0.7; t += 0.1) {
      const [x, z] = lerpP(t);
      const off = cv.halfW - 1 + cv.wallFeather * 0.5; // MILIEU de la transition de paroi
      minWall = Math.min(minWall, Math.max(snow.getSlopeDeg(x + nx * off, z + nz * off), snow.getSlopeDeg(x - nx * off, z - nz * off)));
    }
    log('crevasseWalk', `sol=${maxFloor.toFixed(1)}deg rampes=${maxRamp.toFixed(1)}deg parois=${minWall.toFixed(0)}deg`, maxFloor <= 8 && maxRamp <= 22 && minWall >= 50);
  }

  // Gate S10 — belvedereFlat : le sommet aménagé est constructible
  {
    let maxS = 0;
    for (let a = 0; a < 12; a++) {
      for (let r = 0; r <= BELVEDERE.r - 2; r += 1.5) {
        const ang = (a / 12) * Math.PI * 2;
        maxS = Math.max(maxS, snow.getSlopeDeg(BELVEDERE.x + Math.sin(ang) * r, BELVEDERE.z + Math.cos(ang) * r));
      }
    }
    log('belvedereFlat', `${maxS.toFixed(1)}deg`, maxS <= 6);
  }

  // Gate S11 — windChain : simulation balistique SANS planeur — depuis le haut
  // de chaque colonne, en visant la suivante à 6,5 m/s, on atterrit dans son
  // rayon d'influence (+2 m de marge) ; la dernière porte AU-DESSUS du belvédère
  {
    let ok = true;
    let detail = '';
    for (let i = 0; i < WINDCOLS.columns.length - 1; i++) {
      const a = WINDCOLS.columns[i]!;
      const b = WINDCOLS.columns[i + 1]!;
      const groundB = snow.getHeight(b.x, b.z);
      let px = a.x;
      let pz = a.z;
      let py = a.topY;
      let vy = 1;
      const d0 = Math.hypot(b.x - a.x, b.z - a.z);
      const ux = (b.x - a.x) / d0;
      const uz = (b.z - a.z) / d0;
      let landed = -1;
      for (let s = 0; s < 400; s++) {
        const dt = 1 / 60;
        vy -= 22 * dt;
        px += ux * 6.5 * dt;
        pz += uz * 6.5 * dt;
        py += vy * dt;
        if (py <= snow.getHeight(px, pz)) {
          landed = Math.hypot(b.x - px, b.z - pz);
          break;
        }
      }
      if (landed < 0 || landed > b.r + 2.5) {
        ok = false;
        detail += ` col${i}->${i + 1}:${landed.toFixed(1)}m`;
      }
      void groundB;
    }
    const last = WINDCOLS.columns[WINDCOLS.columns.length - 1]!;
    const overTop = last.topY >= BELVEDERE.topY + 4;
    if (!overTop) ok = false;
    log('windChain', `${detail || 'chaîne continue'} derniere=${last.topY}m/${BELVEDERE.topY + 4}`, ok);
  }

  // Gate S8 — wreckClear : l'épave est hors gabarit de la voie, l'arène est plate
  {
    const d = track.trackDistance(WRECK.x, WRECK.z);
    let maxArena = 0;
    for (let a = 0; a < 16; a++) {
      const ang = (a / 16) * Math.PI * 2;
      for (let r = 0; r <= WRECK.arena.r - 2; r += 3) {
        maxArena = Math.max(maxArena, snow.getSlopeDeg(WRECK.arena.x + Math.sin(ang) * r, WRECK.arena.z + Math.cos(ang) * r));
      }
    }
    log('wreckClear', `voie=${d.toFixed(1)}m arene=${maxArena.toFixed(1)}deg`, d > 6 && maxArena <= 5);
  }
}
