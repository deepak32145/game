import * as THREE from 'three';
import { makeHumanoid, makeBat, makeReachArm, SHOULDER } from './models.js';

export { makeKit, setKitColors, makeUmpireKit, makeHumanoid, makeBat } from './models.js';

// Poses and animation for the player rigs built in models.js.
// Rotating a hanging limb by +x swings it backwards; +z on the left arm lifts it out to the side.

// ---- poses ------------------------------------------------------------------

export function resetPose(h) {
  h.hips.position.set(0, 0.95, 0);
  h.hips.rotation.set(0, 0, 0);
  h.chest.rotation.set(0, 0, 0);
  h.head.rotation.set(0, 0, 0);
  for (const k of ['armL', 'armR', 'elbowL', 'elbowR', 'legL', 'legR', 'kneeL', 'kneeR']) {
    if (h[k]) h[k].rotation.set(0, 0, 0);
  }
}

export function poseStand(h, t = 0) {
  resetPose(h);
  h.chest.rotation.x = 0.03 + Math.sin(t * 1.6) * 0.012;
  if (h.armL) {
    h.armL.rotation.z = 0.1;
    h.armR.rotation.z = -0.1;
    h.elbowL.rotation.x = h.elbowR.rotation.x = -0.15;
  }
}

export function poseRun(h, phase) {
  resetPose(h);
  const s = Math.sin(phase);
  h.hips.position.y = 0.93 + Math.abs(Math.cos(phase)) * 0.05;
  h.chest.rotation.x = 0.22;
  h.legL.rotation.x = s * 0.85;
  h.legR.rotation.x = -s * 0.85;
  h.kneeL.rotation.x = 0.35 + Math.max(0, s) * 1.0;
  h.kneeR.rotation.x = 0.35 + Math.max(0, -s) * 1.0;
  if (h.armL) {
    h.armL.rotation.x = -s * 0.9;
    h.armR.rotation.x = s * 0.9;
    h.elbowL.rotation.x = h.elbowR.rotation.x = -1.3;
  }
}

export function poseReady(h, amount = 1) {
  resetPose(h);
  h.hips.position.y = 0.95 - 0.13 * amount;
  h.legL.rotation.x = h.legR.rotation.x = -0.55 * amount;
  h.legL.rotation.z = 0.14 * amount;
  h.legR.rotation.z = -0.14 * amount;
  h.kneeL.rotation.x = h.kneeR.rotation.x = 1.0 * amount;
  h.chest.rotation.x = 0.5 * amount;
  if (h.armL) {
    h.armL.rotation.x = h.armR.rotation.x = -0.55 * amount;
    h.elbowL.rotation.x = h.elbowR.rotation.x = -0.5 * amount;
  }
}

export function poseArmsUp(h, t = 0) {
  resetPose(h);
  h.hips.position.y = 0.95 + Math.abs(Math.sin(t * 7)) * 0.12;
  h.armL.rotation.z = 2.7;
  h.armR.rotation.z = -2.7;
  h.chest.rotation.x = -0.1;
}

export function poseCatch(h) {
  resetPose(h);
  h.armL.rotation.x = h.armR.rotation.x = -2.5;
  h.armL.rotation.z = -0.15;
  h.armR.rotation.z = 0.15;
  h.chest.rotation.x = -0.15;
}

const smooth = (x) => x * x * (3 - 2 * x);
const lerp = (a, b, t) => a + (b - a) * t;

// Bowling action. tb = seconds relative to the moment of release.
export function poseBowl(h, tb, runPhase) {
  if (tb < -0.36) {
    poseRun(h, runPhase);
    return;
  }
  resetPose(h);
  if (tb <= 0) {
    const u = (tb + 0.36) / 0.36;
    h.hips.position.y = 0.95 + Math.sin(Math.PI * u) * 0.2;
    h.chest.rotation.x = lerp(-0.2, 0.4, u);
    h.armR.rotation.x = lerp(0.5, Math.PI, smooth(u));
    h.armL.rotation.x = lerp(-2.7, -0.4, smooth(u));
    h.legL.rotation.x = lerp(0.3, -0.75, u);
    h.legR.rotation.x = lerp(-0.4, 0.55, u);
    h.kneeR.rotation.x = 0.7 * u;
  } else {
    const v = Math.min(tb / 0.3, 1);
    h.chest.rotation.x = lerp(0.4, 0.6, v) * (1 - Math.max(0, tb - 0.5));
    h.armR.rotation.x = lerp(Math.PI, 5.3, smooth(v));
    h.armL.rotation.x = lerp(-0.4, 0.6, v);
    h.legL.rotation.x = lerp(-0.75, 0.2, v);
    h.legR.rotation.x = lerp(0.55, -0.7, v);
    h.kneeR.rotation.x = 0.7;
  }
}

// ---- batter -----------------------------------------------------------------
// Batter-local axes (the rig is turned side-on): +x towards the bowler, +z the off side.

const v3 = (x, y, z) => new THREE.Vector3(x, y, z);

// One batting pose: where the hands are, where the bat points, and what the body does.
//   twist  shoulders turning towards the bowler (radians)
//   lean   bending forward over the ball
//   stride front foot towards the bowler (+) or back foot towards the stumps (-), in metres
//   crouch how far the hips sink
const pose = (h, d, twist = 0, lean = 0.3, stride = 0, crouch = 0.06) => ({
  hands: v3(...h), dir: v3(...d).normalize(), twist, lean, stride, crouch,
});

const STANCE = pose([0.06, 0.8, 0.24], [-0.25, -0.96, 0.08], 0, 0.32, 0, 0.07);
const BACKLIFT = pose([-0.16, 1.12, 0.2], [-0.6, 0.78, 0.15], -0.25, 0.28, 0, 0.07);
const RUNNING = pose([0.1, 0.95, 0.3], [0.2, -0.3, 0.93], 0, 0.2, 0, 0);

// Each stroke is three poses: contact, follow-through, finish.
const hold = (p) => [p, p, p];
const SHOTS = {
  frontDefend: hold(pose([0.42, 0.78, 0.22], [0.1, -0.99, 0.02], 0.15, 0.5, 0.45, 0.1)),
  backDefend: hold(pose([0.12, 0.98, 0.2], [0.05, -1, 0], 0.2, 0.2, -0.22, 0)),
  straightDrive: [
    pose([0.45, 0.82, 0.22], [0.3, -0.95, 0], 0.3, 0.45, 0.5, 0.1),
    pose([0.5, 1.35, 0.18], [0.55, 0.83, 0], 0.7, 0.3, 0.5, 0.08),
    pose([0.3, 1.5, 0.1], [-0.2, 0.9, -0.3], 0.9, 0.2, 0.5, 0.05),
  ],
  coverDrive: [
    pose([0.4, 0.84, 0.4], [0.3, -0.8, 0.5], 0.15, 0.5, 0.5, 0.1),
    pose([0.35, 1.35, 0.4], [0.5, 0.6, 0.6], 0.45, 0.3, 0.5, 0.08),
    pose([0.2, 1.5, 0.2], [-0.3, 0.85, 0.4], 0.6, 0.2, 0.5, 0.05),
  ],
  cut: [
    pose([0.2, 1.05, 0.5], [0.25, -0.15, 0.95], -0.2, 0.3, -0.25, 0.05),
    pose([0.05, 1.2, 0.45], [-0.5, 0.3, 0.8], -0.45, 0.25, -0.25, 0.03),
    pose([-0.05, 1.3, 0.35], [-0.75, 0.55, 0.35], -0.5, 0.2, -0.25, 0.02),
  ],
  pull: [
    pose([0.3, 1.15, 0.2], [0.9, -0.1, 0.4], 0.6, 0.2, -0.22, 0.03),
    pose([0.1, 1.3, -0.1], [-0.3, 0.1, -0.95], 1.5, 0.15, -0.22, 0.02),
    pose([-0.1, 1.35, -0.1], [-0.8, 0.3, -0.5], 1.9, 0.1, -0.22, 0.02),
  ],
  flick: [
    pose([0.38, 0.82, 0.12], [0.25, -0.95, -0.15], 0.5, 0.45, 0.4, 0.1),
    pose([0.3, 1.2, -0.1], [0.2, 0.3, -0.93], 1.1, 0.3, 0.4, 0.07),
    pose([0.15, 1.4, -0.12], [-0.3, 0.75, -0.6], 1.4, 0.2, 0.4, 0.05),
  ],
};

// Which stroke fits the chosen direction and the length of the ball (short balls are played off the back foot).
export function pickShot(dir, style, length) {
  const short = length > 0.6;
  if (style === 'defend') return short ? 'backDefend' : 'frontDefend';
  if (dir === 'off') return short ? 'cut' : 'coverDrive';
  if (dir === 'leg') return short ? 'pull' : 'flick';
  return 'straightDrive';
}

const DOWN = v3(0, -1, 0);

export function makeBatter(kit, seed, number) {
  const rig = makeHumanoid(kit, { headgear: 'helmet', pads: true, arms: false, seed, number });
  const bat = makeBat();
  rig.root.add(bat);
  const arms = [0, 1].map(() => {
    const parts = makeReachArm(kit, rig.skin);
    rig.root.add(...Object.values(parts));
    return parts;
  });
  Object.assign(rig, { bat, arms, hands: v3(), dir: v3(), twist: 0, lean: 0.3, stride: 0, crouch: 0 });
  blend(rig, STANCE, STANCE, 0);
  return rig;
}

function blend(rig, from, to, t) {
  rig.hands.lerpVectors(from.hands, to.hands, t);
  rig.dir.lerpVectors(from.dir, to.dir, t).normalize();
  for (const k of ['twist', 'lean', 'stride', 'crouch']) rig[k] = lerp(from[k], to[k], t);
}

const LEG_LENGTH = 0.87;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// Footwork and body shape for the current pose.
function applyBody(rig) {
  const s = rig.stride;
  const shift = s * 0.42; // the hips travel part of the way with the stepping foot
  const flex = Math.acos(clamp(1 - rig.crouch / LEG_LENGTH, 0.5, 1)) + 0.12;
  const frontX = 0.12 + Math.max(s, 0) - shift;
  const backX = -0.12 + Math.min(s, 0) - shift;
  const zFront = Math.asin(clamp(frontX / LEG_LENGTH, -0.9, 0.9));
  const zBack = Math.asin(clamp(backX / LEG_LENGTH, -0.9, 0.9));
  rig.hips.position.x = shift;
  rig.hips.position.y = LEG_LENGTH * Math.cos(flex) * Math.min(Math.cos(zFront), Math.cos(zBack)) + 0.085;
  rig.legL.rotation.set(-flex, 0, zFront);
  rig.legR.rotation.set(-flex, 0, zBack);
  rig.kneeL.rotation.x = rig.kneeR.rotation.x = flex * 2;
  rig.chest.rotation.set(rig.lean, rig.twist, 0);
  rig.head.rotation.set(-rig.lean * 0.5, clamp(1.2 - rig.twist * 0.85, -0.2, 1.3), 0);
}

const UPPER_ARM = 0.29;
const FOREARM = 0.27;
// Which way each elbow points: down, slightly out to its own side and behind the bat.
const ELBOW_POLE = [v3(0.55, -1, -0.3), v3(-0.55, -1, -0.3)];
const S = v3();
const T = v3();
const E = v3();
const N = v3();
const P = v3();
const BX = v3();
const BY = v3();
const BZ = v3();
const BASIS = new THREE.Matrix4();

function aim(mesh, from, to) {
  mesh.position.copy(from);
  P.subVectors(to, from);
  mesh.scale.set(1, Math.max(0.01, P.length()), 1);
  mesh.quaternion.setFromUnitVectors(DOWN, P.normalize());
}

// Two-bone reach: put each shoulder, elbow and glove so the hands grip the bat handle.
function placeArms(rig, shoulders = null, upperLen = UPPER_ARM, foreLen = FOREARM) {
  // Point the bat along `dir` and keep the face of the blade towards the bowler.
  BY.copy(rig.dir).negate();
  BZ.set(1, 0, 0).addScaledVector(BY, -BY.x);
  if (BZ.lengthSq() < 0.02) BZ.set(0, 1, 0).addScaledVector(BY, -BY.y);
  BZ.normalize();
  BX.crossVectors(BY, BZ);
  rig.bat.position.copy(rig.hands);
  rig.bat.quaternion.setFromRotationMatrix(BASIS.makeBasis(BX, BY, BZ));

  rig.root.updateMatrixWorld(true);
  rig.arms.forEach((arm, i) => {
    if (shoulders) {
      S.copy(shoulders[i]);
    } else {
      S.set(i ? -SHOULDER.x : SHOULDER.x, SHOULDER.y, 0);
      rig.chest.localToWorld(S);
      rig.root.worldToLocal(S);
    }
    T.copy(rig.hands).addScaledVector(rig.dir, i ? 0.17 : 0.06); // bottom hand sits lower on the handle

    N.subVectors(T, S);
    const reach = N.length();
    N.normalize();
    const d = Math.min(reach, upperLen + foreLen - 0.004);
    const cos = (upperLen * upperLen + d * d - foreLen * foreLen) / (2 * upperLen * d);
    const sin = Math.sqrt(Math.max(0, 1 - cos * cos));
    P.copy(ELBOW_POLE[i]).addScaledVector(N, -ELBOW_POLE[i].dot(N)).normalize();
    E.copy(S).addScaledVector(N, upperLen * cos).addScaledVector(P, upperLen * sin);

    arm.shoulder.position.copy(S);
    arm.elbow.position.copy(E);
    arm.glove.position.copy(T);
    aim(arm.upper, S, E);
    aim(arm.fore, E, T);
  });
}

// Re-solves the arms for a model with its own shoulder positions (in rig space) and arm lengths.
export function reachArms(rig, shoulders, upperLen, foreLen) {
  placeArms(rig, shoulders, upperLen, foreLen);
}

// state: { mode: 'stance' | 'backlift' | 'swing' | 'run' | 'out', t, shot, loft, phase }
export function poseBatter(rig, state, time) {
  resetPose(rig);
  if (state.mode === 'run') {
    poseRun(rig, state.phase);
    blend(rig, RUNNING, RUNNING, 0);
    placeArms(rig);
    return;
  }

  if (state.mode === 'backlift') {
    blend(rig, STANCE, BACKLIFT, smooth(Math.min(state.t / 0.25, 1)));
  } else if (state.mode === 'swing') {
    const [contact, follow, finish] = SHOTS[state.shot];
    const t = state.t;
    if (t < 0.1) blend(rig, BACKLIFT, contact, (t / 0.1) ** 2); // the downswing accelerates into the ball
    else if (t < 0.3) blend(rig, contact, follow, smooth((t - 0.1) / 0.2));
    else blend(rig, follow, finish, smooth(Math.min((t - 0.3) / 0.3, 1)));
    if (state.loft && t > 0.1) {
      const k = Math.min((t - 0.1) / 0.2, 1);
      rig.hands.y += 0.12 * k;
      rig.dir.y += 0.2 * k;
      rig.dir.normalize();
      rig.lean -= 0.15 * k;
    }
  } else {
    blend(rig, STANCE, STANCE, 0);
    if (state.mode === 'stance') rig.hands.y += Math.max(0, Math.sin(time * 5)) * 0.05; // tapping the bat
  }

  applyBody(rig);
  if (state.mode === 'out') {
    rig.head.rotation.set(0.5, 0.3, 0);
    rig.chest.rotation.x = 0.45;
  }
  placeArms(rig);
}
