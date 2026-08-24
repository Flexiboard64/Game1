(() => {
  const WORLD_SCALE = 3;
  const PLAYER_SPEED = 220;
  const SPRITE_HEIGHT = 96;
  const ENEMY_HEIGHT = 88;
  const ENEMY_COUNT = 12;
  const MIN_SPAWN_DIST = 200;
  const ARRIVE_DIST = 3;
  let WORLD_W = 1106 * WORLD_SCALE;
  let WORLD_H = 681 * WORLD_SCALE;
  let WALK_INSET = 0;

  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  const hint = document.getElementById("hint");

  const camera = { x: 0, y: 0 };
  const player = {
    x: WORLD_W / 2,
    y: WORLD_H / 2,
    facing: "right",
    targetX: WORLD_W / 2,
    targetY: WORLD_H / 2,
    moving: false,
  };

  const sprites = { left: null, right: null };
  const enemySprites = [];
  const enemies = [];
  let worldImage = null;
  let lastTime = 0;
  let marker = null;

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(window.innerWidth * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function chromaKey(image) {
    const off = document.createElement("canvas");
    off.width = image.width;
    off.height = image.height;
    const octx = off.getContext("2d");
    octx.drawImage(image, 0, 0);
    const data = octx.getImageData(0, 0, off.width, off.height);
    const px = data.data;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i] < 28 && px[i + 1] < 28 && px[i + 2] < 28) {
        px[i + 3] = 0;
      }
    }
    octx.putImageData(data, 0, 0);
    return off;
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  function screenToWorld(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: camera.x + (clientX - rect.left),
      y: camera.y + (clientY - rect.top),
    };
  }

  function randomRange(min, max) {
    return min + Math.random() * (max - min);
  }

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function spawnEnemies() {
    enemies.length = 0;
    let attempts = 0;
    while (enemies.length < ENEMY_COUNT && attempts < ENEMY_COUNT * 20) {
      attempts += 1;
      const x = randomRange(WALK_INSET, WORLD_W - WALK_INSET);
      const y = randomRange(WALK_INSET, WORLD_H - WALK_INSET);
      if (Math.hypot(x - player.x, y - player.y) < MIN_SPAWN_DIST) continue;
      enemies.push({
        x,
        y,
        sprite: enemySprites[Math.floor(Math.random() * enemySprites.length)],
      });
    }
  }

  function setTarget(clientX, clientY) {
    const world = screenToWorld(clientX, clientY);
    player.targetX = clamp(world.x, WALK_INSET, WORLD_W - WALK_INSET);
    player.targetY = clamp(world.y, WALK_INSET, WORLD_H - WALK_INSET);
    player.moving = true;
    marker = { x: player.targetX, y: player.targetY, life: 1 };
    hint.classList.add("hidden");
  }

  function updateCamera() {
    const viewW = window.innerWidth;
    const viewH = window.innerHeight;
    camera.x = clamp(player.x - viewW / 2, 0, Math.max(0, WORLD_W - viewW));
    camera.y = clamp(player.y - viewH / 2, 0, Math.max(0, WORLD_H - viewH));
  }

  function update(dt) {
    if (player.moving) {
      const dx = player.targetX - player.x;
      const dy = player.targetY - player.y;
      const dist = Math.hypot(dx, dy);

      if (Math.abs(dx) > 1) {
        player.facing = dx > 0 ? "right" : "left";
      }

      if (dist <= ARRIVE_DIST) {
        player.x = player.targetX;
        player.y = player.targetY;
        player.moving = false;
      } else {
        const step = PLAYER_SPEED * dt;
        const ratio = Math.min(1, step / dist);
        player.x += dx * ratio;
        player.y += dy * ratio;
      }
    }

    if (marker) {
      marker.life -= dt * 0.7;
      if (marker.life <= 0) marker = null;
    }

    updateCamera();
  }

  function drawTerrain() {
    ctx.fillStyle = "#1a3d18";
    ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
    ctx.drawImage(worldImage, -camera.x, -camera.y, WORLD_W, WORLD_H);
  }

  function drawMarker() {
    if (!marker) return;
    const x = marker.x - camera.x;
    const y = marker.y - camera.y;
    ctx.save();
    ctx.globalAlpha = Math.max(0, marker.life);
    ctx.strokeStyle = "rgb(238, 255, 0)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 12 + (1 - marker.life) * 10, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fillStyle = "rgb(238, 255, 0)";
    ctx.fill();
    ctx.restore();
  }

  function drawEnemies() {
    for (const enemy of enemies) {
      const sprite = enemy.sprite;
      const scale = ENEMY_HEIGHT / sprite.height;
      const w = sprite.width * scale;
      const h = ENEMY_HEIGHT;
      const sx = enemy.x - camera.x - w / 2;
      const sy = enemy.y - camera.y - h;
      ctx.drawImage(sprite, sx, sy, w, h);
    }
  }

  function drawPlayer() {
    const sprite = sprites[player.facing];
    const scale = SPRITE_HEIGHT / sprite.height;
    const w = sprite.width * scale;
    const h = SPRITE_HEIGHT;
    const sx = player.x - camera.x - w / 2;
    const sy = player.y - camera.y - h;

    ctx.drawImage(sprite, sx, sy, w, h);
  }

  function loop(now) {
    const dt = Math.min(0.05, (now - lastTime) / 1000 || 0);
    lastTime = now;
    update(dt);
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    drawTerrain();
    drawMarker();
    drawEnemies();
    drawPlayer();
    requestAnimationFrame(loop);
  }

  function onPointer(e) {
    e.preventDefault();
    const point = e.changedTouches ? e.changedTouches[0] : e;
    setTarget(point.clientX, point.clientY);
  }

  window.addEventListener("resize", resize);
  canvas.addEventListener("pointerdown", onPointer, { passive: false });
  document.addEventListener("gesturestart", (e) => e.preventDefault());

  resize();

  Promise.all([
    loadImage("leftSprite.png"),
    loadImage("rightSprite.png"),
    loadImage("World.png"),
    loadImage("enemy1.png"),
    loadImage("enemy2.png"),
    loadImage("enemy3.png"),
    loadImage("enemy4.png"),
  ])
    .then(([left, right, world, ...enemyImages]) => {
      sprites.left = chromaKey(left);
      sprites.right = chromaKey(right);
      enemySprites.push(...enemyImages.map(chromaKey));
      worldImage = world;
      WORLD_W = world.width * WORLD_SCALE;
      WORLD_H = world.height * WORLD_SCALE;
      WALK_INSET = Math.round(Math.min(WORLD_W, WORLD_H) * 0.16);
      player.x = player.targetX = WORLD_W / 2;
      player.y = player.targetY = WORLD_H / 2;
      spawnEnemies();
      updateCamera();
      requestAnimationFrame(loop);
    })
    .catch((err) => {
      console.error(err);
      hint.textContent = "Could not load images";
    });
})();
