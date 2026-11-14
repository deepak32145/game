import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { addHeadgear, makeBat, makePads, makeGlove } from './models.js';
import { reachArms } from './players.js';

// Realistic skinned human models (Microsoft Rocketbox avatars, MIT licence; see public/models/LICENSE.txt).
//
// The models have no cricket animations, so each one is driven by a hidden "rig" from players.js:
// every frame the rig is posed as before, and its joint rotations are copied onto the model's bones.
// The shirt and trousers areas of the model's texture are repainted in the team colours.

const BASES = [
  { id: 'm11', glb: '/models/m11.glb', body: '/models/m11_body.jpg', head: '/models/m11_head.jpg' },
  { id: 'm16', glb: '/models/m16.glb', body: '/models/m16_body.jpg', head: '/models/m16_head.jpg' },
];
// Skin tone multipliers, so the same two models give several different-looking players.
const TONES = [[0.8, 0.68, 0.6], [1, 1, 1], [0.66, 0.54, 0.47], [0.9, 0.8, 0.72]];
const TEX = 512;
const DOWN = new THREE.Vector3(0, -1, 0);

const BONE_NAMES = {
  root: 'Bip01', pelvis: 'Bip01_Pelvis', spine: 'Bip01_Spine', spine1: 'Bip01_Spine1', spine2: 'Bip01_Spine2',
  head: 'Bip01_Head',
  armL: 'Bip01_L_UpperArm', foreL: 'Bip01_L_Forearm', handL: 'Bip01_L_Hand',
  armR: 'Bip01_R_UpperArm', foreR: 'Bip01_R_Forearm', handR: 'Bip01_R_Hand',
  thighL: 'Bip01_L_Thigh', calfL: 'Bip01_L_Calf', footL: 'Bip01_L_Foot',
  thighR: 'Bip01_R_Thigh', calfR: 'Bip01_R_Calf', footR: 'Bip01_R_Foot',
};
// Limbs whose rest direction is straightened to hang down, matching the driving rig's rest pose.
const LIMBS = [['armL', 'foreL'], ['foreL', 'handL'], ['armR', 'foreR'], ['foreR', 'handR'],
  ['thighL', 'calfL'], ['calfL', 'footL'], ['thighR', 'calfR'], ['calfR', 'footR']];

const norm = (name) => name.replace(/[\s_]+/g, '_');

function findBones(scene) {
  const byName = new Map();
  scene.traverse((n) => byName.set(norm(n.name), n));
  const bones = {};
  for (const [key, name] of Object.entries(BONE_NAMES)) {
    bones[key] = byName.get(name);
    if (!bones[key]) throw new Error(`avatar bone missing: ${name}`);
  }
  return bones;
}

// A node's rotation relative to the model root (not including the root's own transform).
function rootQuat(node, root, out) {
  out.identity();
  for (let n = node; n && n !== root; n = n.parent) out.premultiply(n.quaternion);
  return out;
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to load ${url}`));
    img.src = url;
  });
}

function pixelsOf(img) {
  const c = document.createElement('canvas');
  c.width = c.height = TEX;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, TEX, TEX);
  return g.getImageData(0, 0, TEX, TEX).data;
}

// Every Rocketbox body texture uses the same layout, so clothing is found by position:
// trousers in the top corners, the shirt down the middle, sleeves above the bare arms.
function classify(src) {
  const cls = new Uint8Array(TEX * TEX); // 0 keep, 1 shirt, 2 trousers, 3 skin
  const lum = new Float32Array(TEX * TEX);
  const sum = [0, 0, 0, 0];
  const count = [0, 0, 0, 0];
  const k = 1024 / TEX;
  for (let y = 0; y < TEX; y++) {
    for (let x = 0; x < TEX; x++) {
      const i = y * TEX + x;
      const r = src[i * 4], g = src[i * 4 + 1], b = src[i * 4 + 2];
      const X = x * k, Y = y * k;
      const skin = r > 95 && r > g * 1.08 && g > b * 0.95 && r - b > 25;
      let c = 0;
      if (Y < 450 && (X < 300 || X > 724)) c = 2;
      else if (X > 320 && X < 705 && Y < 890) c = 1;
      else if (X > 380 && X < 650 && Y >= 880 && Y < 965) c = 1;
      else if ((X < 325 || X > 700) && Y >= 440) c = skin ? 3 : Y < 640 ? 1 : 0;
      cls[i] = c;
      lum[i] = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      sum[c] += lum[i];
      count[c] += 1;
    }
  }
  for (let i = 0; i < lum.length; i++) lum[i] /= sum[cls[i]] / count[cls[i]] || 1; // relative to the garment's average
  return { cls, lum };
}

let loading = null;

// Loads the models once. Resolves to null if anything fails, and the game keeps its simple figures.
export function loadAvatars() {
  if (!loading) {
    const loader = new GLTFLoader();
    loading = Promise.all(
      BASES.map(async (def) => {
        const [gltf, bodyImg, headImg] = await Promise.all([
          loader.loadAsync(def.glb), loadImage(def.body), loadImage(def.head),
        ]);
        const scene = gltf.scene;
        scene.updateMatrixWorld(true);
        const bones = findBones(scene);

        // Reference pose: the bind pose with arms and legs straightened to hang down.
        const q = new THREE.Quaternion();
        const a = new THREE.Vector3();
        const b = new THREE.Vector3();
        const ref = {};
        for (const key of Object.keys(bones)) ref[key] = rootQuat(bones[key], scene, new THREE.Quaternion());
        const length = {};
        for (const [from, to] of LIMBS) {
          bones[from].getWorldPosition(a);
          bones[to].getWorldPosition(b);
          length[from] = a.distanceTo(b);
          q.setFromUnitVectors(b.sub(a).normalize(), DOWN);
          ref[from].premultiply(q);
        }
        const src = pixelsOf(bodyImg);
        return {
          scene, ref, length,
          hipHeight: bones.root.position.y,
          src, ...classify(src),
          headPixels: pixelsOf(headImg),
          headTextures: new Map(),
        };
      })
    ).catch((err) => {
      console.warn('Realistic player models could not be loaded; using simple figures.', err);
      return null;
    });
  }
  return loading;
}

function headTexture(base, toneIndex) {
  if (!base.headTextures.has(toneIndex)) {
    const tone = TONES[toneIndex];
    const c = document.createElement('canvas');
    c.width = c.height = TEX;
    const g = c.getContext('2d');
    const img = g.createImageData(TEX, TEX);
    const s = base.headPixels;
    for (let i = 0; i < s.length; i += 4) {
      img.data[i] = s[i] * tone[0];
      img.data[i + 1] = s[i + 1] * tone[1];
      img.data[i + 2] = s[i + 2] * tone[2];
      img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.flipY = false;
    tex.anisotropy = 4;
    base.headTextures.set(toneIndex, tex);
  }
  return base.headTextures.get(toneIndex);
}

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const qH = new THREE.Quaternion();
const qC = new THREE.Quaternion();
const qA = new THREE.Quaternion();
const qB = new THREE.Quaternion();
const qT = new THREE.Quaternion();
const qP = new THREE.Quaternion();
const vA = new THREE.Vector3();
const vB = new THREE.Vector3();

// opts: { seed, number, headgear, pads, gloves, bat }
export function makeAvatar(bases, rig, kit, opts = {}) {
  const { seed = 0, number = 1, headgear = 'cap', pads = false, gloves = false, bat = false } = opts;
  const base = bases[seed % bases.length];
  const toneIndex = Math.floor(seed / bases.length) % TONES.length;
  const tone = TONES[toneIndex];

  const object = SkeletonUtils.clone(base.scene);
  const bones = findBones(object);

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = TEX;
  const ctx = canvas.getContext('2d');
  const bodyTex = new THREE.CanvasTexture(canvas);
  bodyTex.colorSpace = THREE.SRGBColorSpace;
  bodyTex.flipY = false;
  bodyTex.anisotropy = 4;
  const bodyMat = new THREE.MeshStandardMaterial({ map: bodyTex, roughness: 0.85 });
  const headMat = new THREE.MeshStandardMaterial({ map: headTexture(base, toneIndex), roughness: 0.75 });
  object.traverse((m) => {
    if (!m.isMesh) return;
    m.material = /head/i.test(m.material.name) ? headMat : bodyMat;
    m.castShadow = true;
    m.frustumCulled = false; // the bounding box does not follow the animated bones
  });

  // Equipment follows the bones but is not skinned, so it lives beside the model.
  const gear = {};
  if (headgear !== 'none') {
    gear.head = new THREE.Group();
    addHeadgear(gear.head, headgear, kit);
    gear.head.scale.setScalar(0.94);
    object.add(gear.head);
  }
  if (pads) gear.pads = [makePads(kit), makePads(kit)].map((p) => (object.add(p), p));
  if (gloves) gear.gloves = [makeGlove(), makeGlove()].map((g) => (object.add(g), g));
  if (bat) {
    gear.bat = makeBat();
    object.add(gear.bat);
  }

  // Hide the driving rig's own body; a batter's rig keeps its bat visible.
  rig.root.traverse((m) => {
    if (m.isMesh) m.visible = false;
  });
  if (rig.bat) rig.bat.traverse((m) => (m.visible = true));

  const setBone = (key, delta) => {
    const bone = bones[key];
    qT.multiplyQuaternions(delta, base.ref[key]);
    rootQuat(bone.parent, object, qP).invert();
    bone.quaternion.multiplyQuaternions(qP, qT);
  };
  const rootPos = (bone, out) => object.worldToLocal(bone.getWorldPosition(out));
  const scale = base.hipHeight / 0.95;
  const shoulders = [new THREE.Vector3(), new THREE.Vector3()];

  const avatar = {
    object,
    paint(k) {
      const shirt = new THREE.Color(k.color).convertLinearToSRGB();
      const sr = shirt.r * 255, sg = shirt.g * 255, sb = shirt.b * 255;
      const tk = k.plain ? [21 / 255 / shirt.r, 21 / 255 / shirt.g, 27 / 255 / shirt.b] : [0.7, 0.7, 0.7];
      const img = ctx.createImageData(TEX, TEX);
      const { src, cls, lum } = base;
      for (let i = 0, p = 0; i < cls.length; i++, p += 4) {
        const c = cls[i];
        if (c === 1) {
          const f = clamp(1 + (lum[i] - 1) * 0.7, 0.4, 1.6);
          img.data[p] = sr * f; img.data[p + 1] = sg * f; img.data[p + 2] = sb * f;
        } else if (c === 2) {
          const f = clamp(1 + (lum[i] - 1) * 0.5, 0.5, 1.5);
          img.data[p] = sr * tk[0] * f; img.data[p + 1] = sg * tk[1] * f; img.data[p + 2] = sb * tk[2] * f;
        } else if (c === 3) {
          img.data[p] = src[p] * tone[0]; img.data[p + 1] = src[p + 1] * tone[1]; img.data[p + 2] = src[p + 2] * tone[2];
        } else {
          img.data[p] = src[p]; img.data[p + 1] = src[p + 1]; img.data[p + 2] = src[p + 2];
        }
        img.data[p + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);

      if (!k.plain) {
        const light = 0.299 * shirt.r + 0.587 * shirt.g + 0.114 * shirt.b > 0.6;
        const text = (str, x, y, px, flip) => {
          ctx.save();
          ctx.translate(x, y);
          if (flip) ctx.rotate(Math.PI); // the back of the shirt is stored upside down
          ctx.font = `bold ${px}px Arial, sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.lineWidth = px / 8;
          ctx.strokeStyle = light ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.55)';
          ctx.strokeText(str, 0, 0);
          ctx.fillStyle = light ? '#14161c' : '#ffffff';
          ctx.fillText(str, 0, 0);
          ctx.restore();
        };
        text(String(number), 257, 118, 80, true);
        text(k.short, 257, 186, 26, true);
        text(k.short, 257, 302, 22, false);
        text(String(number), 257, 344, 32, false);
      }
      bodyTex.needsUpdate = true;
    },

    // Copy the rig's current pose onto the model.
    update() {
      object.position.copy(rig.root.position);
      object.quaternion.copy(rig.root.quaternion);

      // Torso and legs
      bones.root.position.set(rig.hips.position.x * scale, base.hipHeight + (rig.hips.position.y - 0.95) * scale, 0);
      qH.copy(rig.hips.quaternion);
      qC.multiplyQuaternions(qH, rig.chest.quaternion);
      setBone('pelvis', qH);
      setBone('spine', qA.copy(qH).slerp(qC, 0.33));
      setBone('spine1', qA.copy(qH).slerp(qC, 0.66));
      setBone('spine2', qC);
      setBone('head', qA.multiplyQuaternions(qC, rig.head.quaternion));
      for (const [side, leg, knee] of [['L', rig.legL, rig.kneeL], ['R', rig.legR, rig.kneeR]]) {
        qA.multiplyQuaternions(qH, leg.quaternion);
        setBone('thigh' + side, qA);
        setBone('calf' + side, qB.multiplyQuaternions(qA, knee.quaternion));
        setBone('foot' + side, qT.identity());
      }

      // Arms: a batter's are solved to reach the bat, everyone else's follow the rig's joints
      if (rig.arms) {
        object.updateMatrixWorld(true);
        rig.root.updateMatrixWorld(true);
        rig.root.worldToLocal(bones.armL.getWorldPosition(shoulders[0]));
        rig.root.worldToLocal(bones.armR.getWorldPosition(shoulders[1]));
        reachArms(rig, shoulders, base.length.armL, base.length.foreL);
        setBone('armL', rig.arms[0].upper.quaternion);
        setBone('foreL', rig.arms[0].fore.quaternion);
        setBone('armR', rig.arms[1].upper.quaternion);
        setBone('foreR', rig.arms[1].fore.quaternion);
      } else {
        for (const [side, arm, elbow] of [['L', rig.armL, rig.elbowL], ['R', rig.armR, rig.elbowR]]) {
          qA.multiplyQuaternions(qC, arm.quaternion);
          setBone('arm' + side, qA);
          setBone('fore' + side, qB.multiplyQuaternions(qA, elbow.quaternion));
        }
      }

      if (!gear.head && !gear.pads && !gear.gloves && !gear.bat) return;
      object.updateMatrixWorld(true);
      if (gear.head) {
        qA.multiplyQuaternions(qC, rig.head.quaternion);
        rootPos(bones.head, vA).add(vB.set(0, 0.085, 0.022).applyQuaternion(qA));
        gear.head.position.copy(vA);
        gear.head.quaternion.copy(qA);
      }
      if (gear.pads) {
        [['calfL', rig.legL, rig.kneeL], ['calfR', rig.legR, rig.kneeR]].forEach(([key, leg, knee], i) => {
          rootPos(bones[key], gear.pads[i].position);
          gear.pads[i].quaternion.multiplyQuaternions(qH, leg.quaternion).multiply(knee.quaternion);
        });
      }
      if (gear.gloves) {
        [['handL', 'foreL'], ['handR', 'foreR']].forEach(([hand, fore], i) => {
          // The glove points along the forearm, a little past the wrist
          rootQuat(bones[fore], object, qA).multiply(qT.copy(base.ref[fore]).invert());
          rootPos(bones[hand], vA).add(vB.set(0, -0.06, 0).applyQuaternion(qA));
          gear.gloves[i].position.copy(vA);
          gear.gloves[i].quaternion.copy(qA);
        });
      }
      if (gear.bat) {
        rootQuat(bones.foreR, object, qA).multiply(qT.copy(base.ref.foreR).invert());
        rootPos(bones.handR, vA).add(vB.set(0, -0.07, 0.02).applyQuaternion(qA));
        gear.bat.position.copy(vA);
        gear.bat.quaternion.copy(qA);
      }
    },
  };

  kit.avatars = kit.avatars || [];
  kit.avatars.push(avatar);
  avatar.paint(kit);
  return avatar;
}
