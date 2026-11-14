import * as THREE from 'three';

// Static stadium: outfield, pitch, rope, boards, stands, floodlights, lights.
// Units are metres. The pitch runs along Z: bowler's stumps at -STUMP_Z, batter's at +STUMP_Z.
// +X is the off side for a right-handed batter.
export const STUMP_Z = 10.06;
export const BOUNDARY = 65;

function canvasTexture(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

// The outfield, seen from above: canvas x is world x, canvas y is world z (the pitch runs up and down).
function grassTexture() {
  return canvasTexture(2048, 2048, (g, w, h) => {
    const m = w / 148; // pixels per metre
    const cx = w / 2;
    const cy = h / 2;
    // Mown in a chequerboard, like a ground prepared for a big match
    const band = 6 * m;
    for (let i = 0; i < w / band; i++) {
      for (let j = 0; j < h / band; j++) {
        g.fillStyle = (i + j) % 2 ? '#2b8842' : '#31964a';
        g.fillRect(i * band, j * band, band + 1, band + 1);
      }
    }
    for (let i = 0; i < 60000; i++) {
      g.fillStyle = Math.random() > 0.5 ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.05)';
      g.fillRect(Math.random() * w, Math.random() * h, 2, 4);
    }
    // Uneven wear across the outfield
    for (let i = 0; i < 70; i++) {
      const x = Math.random() * w;
      const y = Math.random() * h;
      const r = 40 + Math.random() * 120;
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, Math.random() > 0.5 ? 'rgba(190,200,120,0.07)' : 'rgba(10,50,20,0.08)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grad;
      g.fillRect(x - r, y - r, r * 2, r * 2);
    }

    // The square: closely cut turf around the match pitch, with used pitches either side
    g.fillStyle = 'rgba(96,170,92,0.28)';
    g.fillRect(cx - 14 * m, cy - 15 * m, 28 * m, 30 * m);
    for (const k of [-3, -2, -1, 1, 2, 3]) {
      g.fillStyle = Math.abs(k) === 1 ? 'rgba(196,184,128,0.3)' : 'rgba(170,180,120,0.16)';
      g.fillRect(cx + k * 3.6 * m - 1.5 * m, cy - 11.5 * m, 3 * m, 23 * m);
    }
    // Bowlers' run-ups worn into the grass at both ends
    for (const s of [-1, 1]) {
      const grad = g.createLinearGradient(0, cy + s * 11 * m, 0, cy + s * 27 * m);
      grad.addColorStop(0, 'rgba(150,135,85,0.5)');
      grad.addColorStop(1, 'rgba(150,135,85,0)');
      g.fillStyle = grad;
      g.fillRect(cx - 1.6 * m, Math.min(cy + s * 11 * m, cy + s * 27 * m), 3.2 * m, 16 * m);
    }

    // Inner fielding circle
    g.strokeStyle = 'rgba(255,255,255,0.8)';
    g.lineWidth = 3;
    g.setLineDash([10, 22]);
    g.beginPath();
    g.arc(cx, cy, 27.4 * m, 0, Math.PI * 2);
    g.stroke();
  });
}

// The match pitch: dry, rolled and worn, with cracks, footmarks and scuffed creases.
function pitchTexture() {
  return canvasTexture(512, 2048, (g, w, h) => {
    const pxX = w / 3.05;
    const pxZ = h / 24;
    const cx = w / 2;
    const cy = h / 2;
    g.fillStyle = '#c9b07a';
    g.fillRect(0, 0, w, h);

    // Roller streaks along the length
    for (let i = 0; i < 260; i++) {
      g.fillStyle = Math.random() > 0.5 ? 'rgba(255,245,215,0.05)' : 'rgba(110,80,35,0.05)';
      g.fillRect(Math.random() * w, 0, 1 + Math.random() * 5, h);
    }
    // Dry and damp patches
    for (let i = 0; i < 90; i++) {
      const x = Math.random() * w;
      const y = Math.random() * h;
      const r = 30 + Math.random() * 90;
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, Math.random() > 0.5 ? 'rgba(226,210,160,0.2)' : 'rgba(150,118,66,0.16)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grad;
      g.fillRect(x - r, y - r, r * 2, r * 2);
    }
    for (let i = 0; i < 9000; i++) {
      g.fillStyle = Math.random() > 0.5 ? 'rgba(90,65,30,0.1)' : 'rgba(255,250,225,0.09)';
      g.fillRect(Math.random() * w, Math.random() * h, 2, 3);
    }

    // Grass creeping in from the edges and left long at the ends
    for (const [x0, x1] of [[0, 46], [w, w - 46]]) {
      const grad = g.createLinearGradient(x0, 0, x1, 0);
      grad.addColorStop(0, 'rgba(70,140,70,0.6)');
      grad.addColorStop(1, 'rgba(70,140,70,0)');
      g.fillStyle = grad;
      g.fillRect(Math.min(x0, x1), 0, 46, h);
    }
    for (const [y0, y1] of [[0, 110], [h, h - 110]]) {
      const grad = g.createLinearGradient(0, y0, 0, y1);
      grad.addColorStop(0, 'rgba(70,140,70,0.65)');
      grad.addColorStop(1, 'rgba(70,140,70,0)');
      g.fillStyle = grad;
      g.fillRect(0, Math.min(y0, y1), w, 110);
    }

    // Cracks in the dry surface
    g.lineCap = 'round';
    for (let i = 0; i < 34; i++) {
      let x = 50 + Math.random() * (w - 100);
      let y = cy + (Math.random() - 0.5) * 17 * pxZ;
      g.strokeStyle = 'rgba(70,48,22,' + (0.3 + Math.random() * 0.35) + ')';
      g.lineWidth = 0.8 + Math.random() * 1.2;
      g.beginPath();
      g.moveTo(x, y);
      const steps = 5 + Math.floor(Math.random() * 7);
      for (let k = 0; k < steps; k++) {
        x += (Math.random() - 0.5) * 26;
        y += (Math.random() - 0.3) * 46;
        g.lineTo(x, y);
      }
      g.stroke();
    }

    for (const s of [-1, 1]) {
      const crease = cy + s * (STUMP_Z - 1.22) * pxZ;
      // Bowlers' footmarks either side of the stumps, and the batter's guard scratched at the crease
      for (const side of [-1, 1]) {
        const grad = g.createRadialGradient(0, 0, 4, 0, 0, 60);
        grad.addColorStop(0, 'rgba(92,66,34,0.55)');
        grad.addColorStop(1, 'rgba(92,66,34,0)');
        g.save();
        g.translate(cx + side * 0.5 * pxX, crease - s * 0.5 * pxZ);
        g.scale(0.75, 2.2);
        g.fillStyle = grad;
        g.fillRect(-60, -60, 120, 120);
        g.restore();
      }
      const wear = g.createRadialGradient(cx, crease, 4, cx, crease, 95);
      wear.addColorStop(0, 'rgba(105,76,38,0.5)');
      wear.addColorStop(1, 'rgba(105,76,38,0)');
      g.fillStyle = wear;
      g.fillRect(0, crease - 110, w, 220);
      g.strokeStyle = 'rgba(60,42,20,0.6)';
      g.lineWidth = 2;
      for (let k = -2; k <= 2; k++) {
        g.beginPath();
        g.moveTo(cx + k * 9, crease - 16);
        g.lineTo(cx + k * 9 + (Math.random() - 0.5) * 6, crease + 30);
        g.stroke();
      }
    }

    // Crease markings, slightly scuffed
    g.fillStyle = 'rgba(255,255,255,0.94)';
    for (const s of [-1, 1]) {
      g.fillRect(cx - 1.32 * pxX, cy + s * STUMP_Z * pxZ - 3, 2.64 * pxX, 6); // bowling crease
      g.fillRect(0, cy + s * (STUMP_Z - 1.22) * pxZ - 3, w, 6); // popping crease
      for (const side of [-1, 1]) {
        const top = cy + s * (STUMP_Z - 1.22) * pxZ;
        g.fillRect(cx + side * 1.32 * pxX - 3, Math.min(top, top + s * 2.44 * pxZ), 6, 2.44 * pxZ);
      }
    }
    for (let i = 0; i < 500; i++) {
      const s = Math.random() > 0.5 ? 1 : -1;
      g.fillStyle = 'rgba(190,165,115,0.55)';
      g.fillRect(Math.random() * w, cy + s * (STUMP_Z - 1.22) * pxZ - 4 + Math.random() * 8, 4, 2);
    }
  });
}

function crowdTexture() {
  return canvasTexture(1024, 512, (g, w, h) => {
    g.fillStyle = '#121828';
    g.fillRect(0, 0, w, h);
    const colors = ['#e63946', '#f1faee', '#a8dadc', '#ffb703', '#fb8500', '#8ecae6', '#ffffff', '#c77dff', '#90be6d', '#f4a261'];
    const skins = ['#e0ac7e', '#c68642', '#8d5524', '#f1c27d'];
    const rows = 30;
    const rowH = h / rows;
    for (let r = 0; r < rows; r++) {
      const y = r * rowH;
      g.fillStyle = r % 2 ? '#1a2236' : '#161d30';
      g.fillRect(0, y, w, rowH);
      for (let x = 2; x < w; x += 9) {
        if (Math.random() < 0.12) continue;
        g.fillStyle = colors[Math.floor(Math.random() * colors.length)];
        g.fillRect(x, y + rowH * 0.45, 7, rowH * 0.55);
        g.fillStyle = skins[Math.floor(Math.random() * skins.length)];
        g.beginPath();
        g.arc(x + 3.5, y + rowH * 0.32, 2.6, 0, Math.PI * 2);
        g.fill();
      }
    }
  });
}

function boardTexture() {
  return canvasTexture(2048, 64, (g, w, h) => {
    const panels = [
      ['#0b3d91', '#ffffff', 'PITCH DUEL'],
      ['#f4d35e', '#14213d', 'LIVE CRICKET'],
      ['#c1121f', '#ffffff', 'HIT IT BIG'],
      ['#14213d', '#22c55e', 'PITCH DUEL'],
    ];
    const pw = w / panels.length;
    g.font = 'bold 40px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    panels.forEach(([bg, fg, text], i) => {
      g.fillStyle = bg;
      g.fillRect(i * pw, 0, pw, h);
      g.fillStyle = fg;
      g.fillText(text, i * pw + pw / 2, h / 2 + 2);
    });
  });
}

function glowTexture() {
  return canvasTexture(128, 128, (g) => {
    const grad = g.createRadialGradient(64, 64, 2, 64, 64, 64);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.25, 'rgba(220,235,255,0.55)');
    grad.addColorStop(1, 'rgba(200,220,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
  });
}

export function buildWorld(scene) {
  scene.background = new THREE.Color(0x060b18);
  scene.fog = new THREE.Fog(0x060b18, 160, 460);

  // Lights
  scene.add(new THREE.HemisphereLight(0xc6d8ff, 0x1c3a22, 1.1));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(40, 70, 30);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  Object.assign(key.shadow.camera, { left: -34, right: 34, top: 34, bottom: -34, near: 10, far: 220 });
  key.shadow.bias = -0.0004;
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xcfe0ff, 0.9);
  fill.position.set(-40, 50, -30);
  scene.add(fill);

  // Outfield
  const grass = new THREE.Mesh(
    new THREE.CircleGeometry(74, 96),
    new THREE.MeshLambertMaterial({ map: grassTexture() })
  );
  grass.rotation.x = -Math.PI / 2;
  grass.receiveShadow = true;
  scene.add(grass);

  // Pitch
  const pitch = new THREE.Mesh(
    new THREE.PlaneGeometry(3.05, 24),
    new THREE.MeshLambertMaterial({ map: pitchTexture() })
  );
  pitch.rotation.x = -Math.PI / 2;
  pitch.position.y = 0.012;
  pitch.receiveShadow = true;
  scene.add(pitch);

  // Boundary: padded cushions in sponsor colours with the rope on top
  const cushionTex = canvasTexture(256, 16, (g) => {
    ['#0b3d91', '#f4f4f0', '#c1121f', '#f4f4f0'].forEach((c, i) => {
      g.fillStyle = c;
      g.fillRect(i * 64, 0, 64, 16);
    });
  });
  cushionTex.wrapS = THREE.RepeatWrapping;
  cushionTex.repeat.set(30, 1);
  const cushions = new THREE.Mesh(
    new THREE.CylinderGeometry(BOUNDARY + 0.05, BOUNDARY + 0.35, 0.34, 160, 1, true),
    new THREE.MeshLambertMaterial({ map: cushionTex, side: THREE.DoubleSide })
  );
  cushions.position.y = 0.17;
  scene.add(cushions);
  const rope = new THREE.Mesh(
    new THREE.TorusGeometry(BOUNDARY, 0.06, 6, 160),
    new THREE.MeshLambertMaterial({ color: 0xffffff })
  );
  rope.rotation.x = Math.PI / 2;
  rope.position.y = 0.36;
  scene.add(rope);

  // Sight screens behind each bowler's arm: dark, so the white ball stands out against them
  for (const end of [-1, 1]) {
    const screen = new THREE.Mesh(
      new THREE.BoxGeometry(13, 6, 0.5),
      new THREE.MeshBasicMaterial({ color: 0x1a2236 })
    );
    screen.position.set(0, 3.2, end * 70.5);
    scene.add(screen);
    const frame = new THREE.Mesh(
      new THREE.BoxGeometry(13.6, 0.3, 0.6),
      new THREE.MeshBasicMaterial({ color: 0xd9dde6 })
    );
    frame.position.set(0, 6.3, end * 70.5);
    scene.add(frame);
  }

  // Advertising boards (seen from inside the ring, so the texture is flipped)
  const boards = boardTexture();
  boards.wrapS = THREE.RepeatWrapping;
  boards.repeat.set(-6, 1);
  const boardRing = new THREE.Mesh(
    new THREE.CylinderGeometry(68.5, 68.5, 1.2, 128, 1, true),
    new THREE.MeshBasicMaterial({ map: boards, side: THREE.BackSide })
  );
  boardRing.position.y = 0.6;
  scene.add(boardRing);

  // Stands
  const wall = new THREE.Mesh(
    new THREE.CylinderGeometry(73, 73, 2.4, 128, 1, true),
    new THREE.MeshBasicMaterial({ color: 0x0d1424, side: THREE.BackSide })
  );
  wall.position.y = 1.2;
  scene.add(wall);

  const crowd = crowdTexture();
  crowd.wrapS = THREE.RepeatWrapping;
  crowd.repeat.set(-12, 1);
  const stands = new THREE.Mesh(
    new THREE.CylinderGeometry(110, 73, 27, 128, 1, true),
    new THREE.MeshBasicMaterial({ map: crowd, color: 0xcfcfcf, side: THREE.BackSide })
  );
  stands.position.y = 2.4 + 13.5;
  scene.add(stands);

  const roof = new THREE.Mesh(
    new THREE.CylinderGeometry(104, 111, 5, 128, 1, true),
    new THREE.MeshBasicMaterial({ color: 0x1b2438, side: THREE.DoubleSide })
  );
  roof.position.y = 32;
  scene.add(roof);

  // Floodlight towers
  const glow = glowTexture();
  for (let i = 0; i < 4; i++) {
    const angle = Math.PI / 4 + (i * Math.PI) / 2;
    const x = Math.sin(angle) * 114;
    const z = Math.cos(angle) * 114;
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.8, 1.2, 52, 8),
      new THREE.MeshBasicMaterial({ color: 0x2a3348 })
    );
    pole.position.set(x, 26, z);
    scene.add(pole);
    const panel = new THREE.Mesh(
      new THREE.BoxGeometry(16, 8, 1),
      new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false })
    );
    panel.position.set(x, 54, z);
    panel.lookAt(0, 10, 0);
    scene.add(panel);
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: glow, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })
    );
    sprite.position.set(x * 0.985, 54, z * 0.985);
    sprite.scale.set(60, 60, 1);
    scene.add(sprite);
  }
}

// Three stumps and two bails, with their base at the origin of the returned group.
export function buildStumps(scene, z) {
  const group = new THREE.Group();
  group.position.z = z;
  const wood = new THREE.MeshStandardMaterial({ color: 0xf3e3b0, roughness: 0.5 });
  const stumpGeo = new THREE.CylinderGeometry(0.02, 0.02, 0.71, 8);
  stumpGeo.translate(0, 0.355, 0);
  const stumps = [-0.114, 0, 0.114].map((x) => {
    const m = new THREE.Mesh(stumpGeo, wood);
    m.position.x = x;
    m.castShadow = true;
    group.add(m);
    return m;
  });
  const bailGeo = new THREE.CylinderGeometry(0.012, 0.012, 0.11, 6);
  bailGeo.rotateZ(Math.PI / 2);
  const bails = [-0.057, 0.057].map((x) => {
    const m = new THREE.Mesh(bailGeo, wood);
    m.position.set(x, 0.72, 0);
    m.userData.home = m.position.clone();
    group.add(m);
    return m;
  });
  scene.add(group);
  return { group, stumps, bails };
}
