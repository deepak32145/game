import * as THREE from 'three';

// Player models. Each player is a jointed figure (about 1.8 m tall) with a shaped torso,
// tapered limbs, a painted face, and a team shirt whose number is drawn onto a texture.
// A rig stands with feet at y = 0 and faces +Z.

const SKINS = ['#e3b089', '#c98e5f', '#a86f45', '#8a5a36', '#d9a273', '#b97d50'];
const HAIR = ['#141210', '#1f1712', '#2b1d14'];

const mat = (color, roughness = 0.8) => new THREE.MeshStandardMaterial({ color, roughness });
const WHITE = mat(0xf4f4f0, 0.65);
const DARK = mat(0x15151b, 0.7);
const WOOD = mat(0xdcb878, 0.55);
const SOLE = mat(0x2b2b30, 0.9);

function solid(mesh) {
  mesh.castShadow = true;
  return mesh;
}

// A tapered limb section hanging down from its origin.
function tube(rTop, rBottom, length, material) {
  const geo = new THREE.CylinderGeometry(rTop, rBottom, length, 12);
  geo.translate(0, -length / 2, 0);
  return solid(new THREE.Mesh(geo, material));
}

function orb(radius, material, sx = 1, sy = 1, sz = 1) {
  const m = solid(new THREE.Mesh(new THREE.SphereGeometry(radius, 14, 10), material));
  m.scale.set(sx, sy, sz);
  return m;
}

function canvasTexture(size) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return { canvas, tex };
}

// ---- kits -------------------------------------------------------------------

export function makeKit({ plain = false } = {}) {
  return {
    shirt: mat('#ffffff', 0.78),
    trousers: mat('#ffffff', 0.82),
    accent: mat('#ffffff', 0.6),
    color: '#3366cc',
    accentColor: '#ffffff',
    short: '',
    plain, // plain kits (umpire) have no number or panels
    rigs: [],
  };
}

export function setKitColors(kit, color, accent, short = '') {
  Object.assign(kit, { color, accentColor: accent, short });
  kit.shirt.color.set(color);
  kit.trousers.color.set(color).multiplyScalar(0.7);
  kit.accent.color.set(accent);
  kit.rigs.forEach((rig) => paintJersey(rig, kit));
  (kit.avatars || []).forEach((avatar) => avatar.paint(kit));
}

export function makeUmpireKit() {
  const kit = makeKit({ plain: true });
  kit.color = '#f4f4f0';
  kit.shirt.color.set('#f4f4f0');
  kit.trousers.color.set('#15151b');
  kit.accent.color.set('#15151b');
  return kit;
}

// The torso texture wraps once around the body: the back is at 25% of the width, the front at 75%.
function paintJersey(rig, kit) {
  const c = rig.jersey.canvas;
  const g = c.getContext('2d');
  const W = c.width;
  const H = c.height;
  g.fillStyle = kit.color;
  g.fillRect(0, 0, W, H);

  if (!kit.plain) {
    const lum = new THREE.Color(kit.color).getHSL({}).l;
    const ink = lum > 0.55 ? '#14161c' : '#ffffff';
    g.fillStyle = kit.accentColor;
    g.fillRect(0, 0, 12, H); // side panels (under the arms)
    g.fillRect(W - 12, 0, 12, H);
    g.fillRect(W / 2 - 12, 0, 24, H);
    g.fillRect(0, 0, W, 30); // collar and shoulder yoke

    const text = (str, x, y, px) => {
      g.save();
      g.translate(x, y);
      g.scale(0.58, 1); // the shirt is wider around than it is tall
      g.font = `bold ${px}px Arial, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.lineWidth = px / 9;
      g.strokeStyle = ink === '#ffffff' ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.55)';
      g.strokeText(str, 0, 0);
      g.fillStyle = ink;
      g.fillText(str, 0, 0);
      g.restore();
    };
    text(String(rig.number), W * 0.25, 162, 92); // back
    text(kit.short, W * 0.25, 96, 30);
    text(kit.short, W * 0.75, 112, 34); // front
    text(String(rig.number), W * 0.75, 160, 40);
  }
  rig.jersey.tex.needsUpdate = true;
}

// ---- faces ------------------------------------------------------------------

const faceCache = new Map();
let headGeo = null;

// A sculpted head: a sphere pushed into shape (narrow jaw, brow, eye sockets, nose, lips, chin).
function headGeometry() {
  if (headGeo) return headGeo;
  const R = 0.105;
  const geo = new THREE.SphereGeometry(R, 40, 30);
  const p = geo.attributes.position;
  const bump = (dx, sx, dy, sy) => Math.exp(-((dx / sx) ** 2 + (dy / sy) ** 2));
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i) / R;
    const y = p.getY(i) / R;
    const z = p.getZ(i) / R;
    let sx = 0.9;
    let sz = z < 0 ? 1.06 : 0.98;
    if (y < 0) {
      sx *= 1 - 0.3 * y * y; // jaw narrows towards the chin
      if (z > 0) sz *= 1 - 0.12 * y * y;
    }
    const X = x * sx * R;
    const Y = y * 1.15 * R;
    let Z = z * sz * R;
    if (z > 0.2) {
      const ax = Math.abs(X);
      Z += 0.026 * bump(X, 0.016, Y + 0.014, 0.026); // nose
      Z += 0.005 * bump(0, 1, Y - 0.035, 0.011) * (ax < 0.07 ? 1 : 0); // brow ridge
      Z -= 0.007 * bump(ax - 0.034, 0.017, Y - 0.018, 0.011); // eye sockets
      Z += 0.006 * bump(X, 0.03, Y + 0.046, 0.011); // lips
      Z += 0.008 * bump(X, 0.03, Y + 0.097, 0.018); // chin
    }
    p.setXYZ(i, X, Y, Z);
  }
  geo.computeVertexNormals();
  headGeo = geo;
  return geo;
}

// Painted onto the head: the face is centred at 25% of the width, matching the sculpted features.
function faceTexture(seed) {
  const skin = SKINS[seed % SKINS.length];
  const variant = seed % 4; // 0 clean shaven, 1 full beard, 2 moustache, 3 stubble
  const key = skin + variant;
  if (faceCache.has(key)) return faceCache.get(key);

  const { canvas, tex } = canvasTexture(512);
  const g = canvas.getContext('2d');
  const hair = HAIR[seed % HAIR.length];
  const cx = 128;
  const ellipse = (x, y, rx, ry, fill) => {
    g.fillStyle = fill;
    g.beginPath();
    g.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    g.fill();
  };

  g.fillStyle = skin;
  g.fillRect(0, 0, 512, 512);

  // Soft light on the forehead, nose and cheekbones; shade in the hollows and under the jaw
  const glow = g.createRadialGradient(cx, 250, 10, cx, 250, 150);
  glow.addColorStop(0, 'rgba(255,236,214,0.2)');
  glow.addColorStop(1, 'rgba(255,236,214,0)');
  g.fillStyle = glow;
  g.fillRect(0, 100, 300, 320);
  for (const side of [-1, 1]) ellipse(cx + side * 62, 304, 26, 46, 'rgba(60,25,10,0.12)');
  ellipse(cx, 408, 96, 30, 'rgba(0,0,0,0.2)');

  // Hair: the crown everywhere, and down the back and sides of the head
  g.fillStyle = hair;
  g.fillRect(0, 0, 512, 152);
  g.fillRect(250, 0, 262, 338);
  g.fillRect(0, 0, 16, 296);
  g.fillRect(236, 0, 26, 296);
  ellipse(cx, 160, 92, 26, skin); // hairline over the forehead
  for (let i = 0; i < 500; i++) {
    const x = Math.random() * 512;
    const y = Math.random() * (x > 250 ? 330 : 140);
    g.strokeStyle = Math.random() > 0.5 ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.25)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + (Math.random() - 0.5) * 6, y + 10 + Math.random() * 10);
    g.stroke();
  }

  // Facial hair
  const whiskers = (alpha) => 'rgba(22,16,12,' + alpha + ')';
  if (variant === 1 || variant === 3) {
    const a = variant === 1 ? 0.82 : 0.26;
    ellipse(cx, 356, 80, 60, whiskers(a));
    ellipse(cx, 286, 62, 30, skin); // keep the cheeks clear
    ellipse(cx, 325, 20, 8, skin);
  }
  if (variant !== 0) {
    g.strokeStyle = whiskers(variant === 3 ? 0.3 : 0.85);
    g.lineWidth = 9;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(cx - 24, 308);
    g.quadraticCurveTo(cx, 298, cx + 24, 308);
    g.stroke();
  }

  for (const side of [-1, 1]) {
    const ex = cx + side * 30;
    g.strokeStyle = hair; // brow
    g.lineWidth = 7;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(ex - side * 18, 212);
    g.quadraticCurveTo(ex, 201, ex + side * 20, 208);
    g.stroke();
    ellipse(ex, 234, 15, 11, 'rgba(60,25,10,0.22)'); // socket shade
    ellipse(ex, 232, 13, 7.5, '#f6f1ea'); // eye
    ellipse(ex, 232, 6.5, 6.5, '#3a2414');
    ellipse(ex, 232, 3, 3, '#0a0605');
    ellipse(ex + 2, 230, 1.6, 1.6, '#ffffff');
    g.strokeStyle = 'rgba(25,12,6,0.85)'; // upper lid
    g.lineWidth = 2.5;
    g.beginPath();
    g.moveTo(ex - 14, 232);
    g.quadraticCurveTo(ex, 221, ex + 14, 232);
    g.stroke();
  }

  // Nose: a lit bridge with shaded sides and nostrils
  g.strokeStyle = 'rgba(255,240,225,0.28)';
  g.lineWidth = 6;
  g.beginPath();
  g.moveTo(cx, 236);
  g.lineTo(cx, 280);
  g.stroke();
  g.strokeStyle = 'rgba(70,35,20,0.38)';
  g.lineWidth = 3.5;
  g.beginPath();
  g.moveTo(cx - 7, 246);
  g.lineTo(cx - 13, 284);
  g.quadraticCurveTo(cx, 294, cx + 13, 284);
  g.lineTo(cx + 7, 246);
  g.stroke();
  for (const side of [-1, 1]) ellipse(cx + side * 7, 288, 3.2, 2.2, 'rgba(30,12,8,0.6)');

  // Mouth
  ellipse(cx, 323, 17, 6.5, 'rgba(165,85,78,0.6)');
  g.strokeStyle = 'rgba(105,42,38,0.92)';
  g.lineWidth = 3.5;
  g.beginPath();
  g.moveTo(cx - 22, 315);
  g.quadraticCurveTo(cx, 321, cx + 22, 315);
  g.stroke();

  tex.needsUpdate = true;
  tex.anisotropy = 8;
  const material = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7 });
  const result = { material, skin: mat(skin, 0.75) };
  faceCache.set(key, result);
  return result;
}

// ---- headgear ---------------------------------------------------------------

export function addHeadgear(head, type, kit) {
  if (type === 'helmet') {
    const shell = solid(new THREE.Mesh(
      new THREE.SphereGeometry(0.128, 18, 12, 0, Math.PI * 2, 0, Math.PI * 0.6),
      kit.trousers
    ));
    shell.position.y = 0.02;
    shell.scale.set(0.98, 1.05, 1.06);
    const peak = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.012, 0.07), kit.trousers);
    peak.position.set(0, 0.035, 0.15);
    peak.rotation.x = 0.2;
    head.add(shell, peak);
    for (const y of [-0.012, -0.045, -0.078]) {
      const bar = new THREE.Mesh(new THREE.TorusGeometry(0.128, 0.005, 5, 14, Math.PI), DARK);
      bar.rotation.x = Math.PI / 2;
      bar.position.set(0, y, 0.012);
      head.add(bar);
    }
    for (const side of [-1, 1]) {
      const guard = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.1, 0.09), kit.trousers);
      guard.position.set(side * 0.118, -0.04, 0);
      head.add(guard);
    }
    return;
  }
  if (type === 'hat') {
    const crown = solid(new THREE.Mesh(new THREE.CylinderGeometry(0.095, 0.108, 0.075, 18), WHITE));
    crown.position.y = 0.105;
    const brim = solid(new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.012, 22), WHITE));
    brim.position.y = 0.07;
    head.add(crown, brim);
    return;
  }
  if (type === 'cap') {
    const crown = solid(new THREE.Mesh(
      new THREE.SphereGeometry(0.113, 18, 8, 0, Math.PI * 2, 0, Math.PI * 0.5),
      kit.trousers
    ));
    crown.position.y = 0.035;
    crown.scale.set(0.96, 0.95, 1.04);
    const peak = new THREE.Mesh(new THREE.BoxGeometry(0.135, 0.01, 0.1), kit.trousers);
    peak.position.set(0, 0.045, 0.145);
    peak.rotation.x = 0.18;
    const button = new THREE.Mesh(new THREE.SphereGeometry(0.014, 8, 6), kit.accent);
    button.position.y = 0.143;
    head.add(crown, peak, button);
  }
}

// ---- body -------------------------------------------------------------------

export const SHOULDER = { x: 0.205, y: 0.5 };
const ARM = { upper: 0.28, fore: 0.25 };
const LEG = { thigh: 0.44, shin: 0.43 };

function makeArm(chest, side, kit, skin, gloves) {
  const top = new THREE.Group();
  top.position.set(side * SHOULDER.x, SHOULDER.y, 0);
  chest.add(top);
  top.add(orb(0.064, kit.shirt));
  top.add(tube(0.058, 0.05, 0.16, kit.shirt)); // sleeve
  const bicep = tube(0.046, 0.04, ARM.upper - 0.13, skin);
  bicep.position.y = -0.13;
  top.add(bicep);

  const joint = new THREE.Group();
  joint.position.y = -ARM.upper;
  top.add(joint);
  joint.add(orb(0.041, skin));
  joint.add(tube(0.04, 0.03, ARM.fore, skin));
  const hand = gloves ? orb(0.052, WHITE, 0.9, 1.25, 0.75) : orb(0.04, skin, 0.85, 1.3, 0.6);
  hand.position.y = -ARM.fore - 0.035;
  joint.add(hand);
  return { top, joint };
}

function makeLeg(hips, side, kit, pads) {
  const top = new THREE.Group();
  top.position.set(side * 0.095, 0, 0);
  hips.add(top);
  top.add(orb(0.088, kit.trousers));
  top.add(tube(0.086, 0.06, LEG.thigh, kit.trousers));

  const joint = new THREE.Group();
  joint.position.y = -LEG.thigh;
  top.add(joint);
  joint.add(orb(0.061, kit.trousers));
  joint.add(tube(0.058, 0.042, LEG.shin, kit.trousers));

  const shoe = solid(new THREE.Mesh(new THREE.CapsuleGeometry(0.046, 0.14, 4, 10), WHITE));
  shoe.rotation.x = Math.PI / 2;
  shoe.scale.set(1, 1, 0.8);
  shoe.position.set(0, -LEG.shin - 0.035, 0.055);
  const sole = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.016, 0.25), SOLE);
  sole.position.set(0, -LEG.shin - 0.072, 0.055);
  joint.add(shoe, sole);

  if (pads) {
    const pad = solid(new THREE.Mesh(new THREE.BoxGeometry(0.135, 0.46, 0.075), WHITE));
    pad.position.set(0, -0.2, 0.04);
    const knee = solid(new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.14, 10), WHITE));
    knee.rotation.z = Math.PI / 2;
    knee.position.set(0, 0.03, 0.045);
    joint.add(pad, knee);
    for (const y of [-0.08, -0.2, -0.32]) {
      const strap = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.012, 0.08), kit.accent);
      strap.position.set(0, y, 0.04);
      joint.add(strap);
    }
  }
  return { top, joint };
}

export function makeHumanoid(kit, opts = {}) {
  const { headgear = 'cap', pads = false, gloves = false, arms = true, seed = 0, number = 1 } = opts;
  const face = faceTexture(seed);
  const skin = face.skin;

  const root = new THREE.Group();
  const hips = new THREE.Group();
  hips.position.y = 0.95;
  root.add(hips);

  const pelvis = orb(0.14, kit.trousers, 1.1, 0.6, 0.74);
  pelvis.position.y = 0.035;
  hips.add(pelvis);

  const chest = new THREE.Group();
  hips.add(chest);

  // Shirt: a lathed profile (hem, waist, chest, shoulders, collar), flattened front to back.
  const profile = [
    [0.126, -0.02], [0.13, 0.1], [0.15, 0.24], [0.172, 0.38],
    [0.178, 0.47], [0.15, 0.535], [0.075, 0.57], [0.052, 0.6],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  const torsoGeo = new THREE.LatheGeometry(profile, 20);
  torsoGeo.rotateY(Math.PI / 2); // put the texture seam under the arm
  const jersey = canvasTexture(256);
  const torso = solid(new THREE.Mesh(torsoGeo, new THREE.MeshStandardMaterial({ map: jersey.tex, roughness: 0.78 })));
  torso.scale.set(1.12, 1, 0.66);
  chest.add(torso);

  const neck = tube(0.047, 0.052, 0.1, skin);
  neck.position.y = 0.665;
  chest.add(neck);

  const head = new THREE.Group();
  head.position.y = 0.735;
  chest.add(head);
  head.add(solid(new THREE.Mesh(headGeometry(), face.material)));
  for (const side of [-1, 1]) {
    const ear = orb(0.022, skin, 0.5, 1, 0.8);
    ear.position.set(side * 0.097, -0.005, 0);
    head.add(ear);
  }
  addHeadgear(head, headgear, kit);

  const rig = { root, hips, chest, head, skin, jersey, number, kit };

  if (arms) {
    const L = makeArm(chest, 1, kit, skin, gloves);
    const R = makeArm(chest, -1, kit, skin, gloves);
    Object.assign(rig, {
      armL: L.top, elbowL: L.joint, armR: R.top, elbowR: R.joint, handY: -ARM.fore - 0.04,
    });
  }
  const LL = makeLeg(hips, 1, kit, pads);
  const LR = makeLeg(hips, -1, kit, pads);
  Object.assign(rig, { legL: LL.top, kneeL: LL.joint, legR: LR.top, kneeR: LR.joint });

  kit.rigs.push(rig);
  paintJersey(rig, kit);
  return rig;
}

// Batting pads and gloves as separate pieces, for models whose legs and hands are not built here.
export function makePads(kit) {
  const group = new THREE.Group();
  const pad = solid(new THREE.Mesh(new THREE.BoxGeometry(0.135, 0.42, 0.075), WHITE));
  pad.position.set(0, -0.2, 0.055);
  const knee = solid(new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.14, 10), WHITE));
  knee.rotation.z = Math.PI / 2;
  knee.position.set(0, 0.02, 0.06);
  group.add(pad, knee);
  for (const y of [-0.08, -0.2, -0.32]) {
    const strap = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.012, 0.08), kit.accent);
    strap.position.set(0, y, 0.055);
    group.add(strap);
  }
  return group;
}

export function makeGlove() {
  return orb(0.043, WHITE, 0.95, 1.35, 0.75);
}

// ---- bat --------------------------------------------------------------------

// Held at its origin (top of the handle); the blade hangs down from there.
export function makeBat() {
  const bat = new THREE.Group();
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.019, 0.3, 10), DARK);
  handle.position.y = -0.15;
  const shoulder = solid(new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.055, 0.07, 4), WOOD));
  shoulder.position.y = -0.325;
  shoulder.rotation.y = Math.PI / 4;
  shoulder.scale.z = 0.42;
  const blade = solid(new THREE.Mesh(new THREE.BoxGeometry(0.108, 0.5, 0.042), WOOD));
  blade.position.y = -0.61;
  const sticker = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.12, 0.044), mat(0xc1272d, 0.5));
  sticker.position.y = -0.47;
  bat.add(handle, shoulder, blade, sticker);
  return bat;
}

// Free-standing arm pieces for the batter, whose arms are solved each frame to reach the bat handle.
export function makeReachArm(kit, skin) {
  const unit = (rTop, rBottom, material) => {
    const geo = new THREE.CylinderGeometry(rTop, rBottom, 1, 12);
    geo.translate(0, -0.5, 0);
    return solid(new THREE.Mesh(geo, material));
  };
  return {
    shoulder: orb(0.064, kit.shirt),
    upper: unit(0.056, 0.044, kit.shirt),
    elbow: orb(0.043, skin),
    fore: unit(0.041, 0.034, skin),
    glove: orb(0.055, WHITE, 0.9, 1.15, 0.9),
  };
}
