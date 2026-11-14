import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { buildWorld, buildStumps, STUMP_Z, BOUNDARY } from './world.js';
import {
  makeKit, setKitColors, makeUmpireKit, makeHumanoid, makeBatter, makeBat,
  poseStand, poseRun, poseReady, poseArmsUp, poseCatch, poseBowl, poseBatter, pickShot,
} from './players.js';
import { sfx } from './sound.js';
import { loadAvatars, makeAvatar } from './avatars.js';

// The live 3D match view. It owns no game state: every frame it reads the ball
// timeline that Match.jsx keeps in `animRef.current` and poses the scene to match.
//
// line   -> x = line * LINE_M  (+x is the off side)
// length -> distance of the bounce in front of the batter's stumps

const v = (x, y, z) => new THREE.Vector3(x, y, z);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;

const LINE_M = 0.75;
const CONTACT_Z = STUMP_Z - 1.22;
const RELEASE = v(0.45, 2.05, -(STUMP_Z - 1.1));
const BALL_R = 0.075;
const bounceZ = (length) => STUMP_Z - (1.7 + 8.3 * length);
const ZONE = { near: bounceZ(0), far: bounceZ(1), halfW: 1.3 * LINE_M };

const CAMS = {
  bat: { pos: v(0.8, 3.3, 20.5), look: v(0, 0.1, -4), fov: 26, follow: 1.5 },
  bowl: { pos: v(0, 8, -32), look: v(0, 0.2, 4), fov: 15, follow: 2.4 },
  aim: { pos: v(0, 9, -13), look: v(0, 0, 5), fov: 30, follow: 1 },
};

const FIELDERS = [
  [22, 8], [20, -6], [9, -24], [-9, -24], [-21, -4], [-22, 9], [22, -50], [-48, -16], [44, 6],
];

const HIT_ANGLE = { straight: 0.08, off: 1.15, leg: -1.2 };
const HIT_DIST = { 0: 11, 1: 24, 2: 40, 3: 52, 4: 70, 6: 88 };

// Ball position on its way down the pitch. p = 0 at release, 1 at the bat.
function deliveryPos(d, p, out) {
  const bz = bounceZ(d.length);
  const pb = (bz - RELEASE.z) / (CONTACT_Z - RELEASE.z);
  const lineX = d.line * LINE_M;
  const loop = d.kind === 'spin' || d.variation === 'slow' ? 0.9 : 0.25;
  out.z = lerp(RELEASE.z, CONTACT_Z, p);
  if (p < pb) {
    const q = p / pb;
    out.x = lerp(RELEASE.x, lineX, q);
    out.y = lerp(RELEASE.y, BALL_R, q) + Math.sin(Math.PI * q) * loop;
  } else {
    const q = (p - pb) / Math.max(0.05, 1 - pb);
    out.x = lerp(lineX, d.finalLine * LINE_M, q);
    const rise = 0.3 + 1.25 * d.length;
    out.y = BALL_R + (rise - BALL_R) * Math.sin(Math.min(q, 1.6) * Math.PI * 0.5);
  }
  return pb;
}

function aimZoneTexture() {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 512;
  const g = c.getContext('2d');
  // Canvas top is the bowler's side (short); bottom is the batter's toes (yorker).
  const bands = [
    [0.35, 'rgba(239,68,68,0.34)'],
    [0.3, 'rgba(34,197,94,0.36)'],
    [0.23, 'rgba(250,204,21,0.34)'],
    [0.12, 'rgba(59,130,246,0.4)'],
  ];
  let y = 0;
  for (const [frac, color] of bands) {
    g.fillStyle = color;
    g.fillRect(0, y, 128, frac * 512);
    y += frac * 512;
    g.fillStyle = 'rgba(255,255,255,0.6)';
    g.fillRect(0, y - 1, 128, 2);
  }
  g.fillStyle = 'rgba(255,255,255,0.35)';
  g.fillRect(63, 0, 2, 512);
  g.strokeStyle = 'rgba(255,255,255,0.9)';
  g.lineWidth = 4;
  g.strokeRect(2, 2, 124, 508);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createArena(mount, getProps, animRef) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  mount.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  // Soft all-round light so skin and cloth are shaded like real surfaces, not flat colour.
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.45;
  const camera = new THREE.PerspectiveCamera(CAMS.bat.fov, 16 / 9, 0.3, 600);
  camera.position.copy(CAMS.bat.pos);
  const camLook = CAMS.bat.look.clone();

  buildWorld(scene);
  const farStumps = buildStumps(scene, -STUMP_Z);
  const nearStumps = buildStumps(scene, STUMP_Z);

  // ---- people ----
  const batKit = makeKit();
  const fieldKit = makeKit();
  let kitKey = '';

  const add = (rig) => {
    scene.add(rig.root);
    return rig;
  };
  const batter = add(makeBatter(batKit, 1, 18));
  const nonStriker = add(makeHumanoid(batKit, { headgear: 'helmet', pads: true, gloves: true, seed: 2, number: 45 }));
  const nsBat = makeBat();
  nsBat.position.y = nonStriker.handY;
  nonStriker.elbowR.add(nsBat);
  const bowler = add(makeHumanoid(fieldKit, { seed: 3, number: 10 }));
  const keeper = add(makeHumanoid(fieldKit, { headgear: 'helmet', pads: true, gloves: true, seed: 4, number: 7 }));
  const umpireKit = makeUmpireKit();
  const umpire = add(makeHumanoid(umpireKit, { headgear: 'hat', seed: 5 }));
  umpire.root.position.set(0, 0, -STUMP_Z - 1.6);
  const fielders = FIELDERS.map(([x, z], i) => {
    const rig = add(makeHumanoid(fieldKit, { seed: i + 6, number: [3, 5, 9, 11, 14, 21, 23, 33, 77][i] }));
    rig.home = v(x, 0, z);
    return rig;
  });

  // Swap the simple figures for realistic models once they have downloaded.
  const avatars = [];
  let disposed = false;
  loadAvatars().then((bases) => {
    if (!bases || disposed) return;
    const put = (rig, kit, opts) => {
      const avatar = makeAvatar(bases, rig, kit, opts);
      scene.add(avatar.object);
      avatars.push(avatar);
    };
    put(batter, batKit, { seed: 0, number: 18, headgear: 'helmet', pads: true, gloves: true });
    put(nonStriker, batKit, { seed: 3, number: 45, headgear: 'helmet', pads: true, gloves: true, bat: true });
    put(bowler, fieldKit, { seed: 2, number: 10 });
    put(keeper, fieldKit, { seed: 5, number: 7, headgear: 'helmet', pads: true, gloves: true });
    put(umpire, umpireKit, { seed: 1, headgear: 'hat' });
    fielders.forEach((f, i) => put(f, fieldKit, { seed: i + 4, number: [3, 5, 9, 11, 14, 21, 23, 33, 77][i] }));
  });

  // ---- ball, markers ----
  const ball = new THREE.Mesh(
    new THREE.SphereGeometry(BALL_R, 16, 12),
    new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x555555, roughness: 0.4 })
  );
  ball.castShadow = true;
  scene.add(ball);
  const blob = new THREE.Mesh(
    new THREE.CircleGeometry(0.13, 16),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false })
  );
  blob.rotation.x = -Math.PI / 2;
  blob.position.y = 0.025;
  scene.add(blob);

  const zone = new THREE.Mesh(
    new THREE.PlaneGeometry(ZONE.halfW * 2, ZONE.near - ZONE.far),
    new THREE.MeshBasicMaterial({ map: aimZoneTexture(), transparent: true, depthWrite: false })
  );
  zone.rotation.x = -Math.PI / 2;
  zone.position.set(0, 0.02, (ZONE.near + ZONE.far) / 2);
  scene.add(zone);

  const marker = new THREE.Mesh(
    new THREE.RingGeometry(0.15, 0.25, 28),
    new THREE.MeshBasicMaterial({ color: 0xff3030, transparent: true, opacity: 0.95, depthWrite: false })
  );
  marker.rotation.x = -Math.PI / 2;
  marker.position.y = 0.035;
  scene.add(marker);

  // ---- helpers ----
  const ballPos = v(0, 0, 0);
  const closeDir = v(0, 0, 1);
  const tmp = v(0, 0, 0);
  const face = (rig, x, z) => {
    rig.root.rotation.y = Math.atan2(x - rig.root.position.x, z - rig.root.position.z);
  };

  // Decide once per ball where a struck ball goes and who chases it.
  function makeHit(a, r) {
    const d = a.delivery;
    const from = v(0, 0, 0);
    deliveryPos(d, clamp((a.resultAt - a.release) / d.flightMs, 0.6, 1.05), from);
    const defend = r.shot.style === 'defend';
    const loft = r.shot.style === 'loft';
    // Early swings drag the ball to leg, late ones slice it to off.
    let angle = HIT_ANGLE[defend ? 'straight' : r.shot.dir] + clamp(r.offset / 260, -1, 1) * 0.35;
    if (defend) angle *= 4;
    let dist = defend ? 3 + r.runs * 18 : HIT_DIST[r.runs] ?? 20;
    let air = loft;
    let height = r.runs === 6 ? 22 : r.runs === 4 ? 9 : 7;
    let endY = r.runs === 6 ? 9 : BALL_R;
    if (r.wicket === 'caught') {
      air = true;
      dist = loft ? 36 : 17;
      height = loft ? 14 : 5;
      endY = 1.9;
    }
    const end = v(from.x + Math.sin(angle) * dist, endY, from.z - Math.cos(angle) * dist);

    let chaser = 0;
    let best = Infinity;
    fielders.forEach((f, i) => {
      const dd = (f.home.x - end.x) ** 2 + (f.home.z - end.z) ** 2;
      if (dd < best) {
        best = dd;
        chaser = i;
      }
    });
    const target = r.wicket === 'caught' || dist < BOUNDARY ? end.clone() : end.clone().multiplyScalar(0.8);
    target.y = 0;
    return { from, end, air, height, dur: r.runs === 6 ? 2600 : 2300, chaser, target };
  }

  function updateBall(a, now) {
    const d = a.delivery;
    if (!d || now < a.release) {
      ball.visible = blob.visible = false;
      return false;
    }
    const r = a.result;
    if (r && r.contact) {
      if (!a.hit) a.hit = makeHit(a, r);
      const h = a.hit;
      const t = clamp((now - a.resultAt) / h.dur, 0, 1);
      const e = h.air ? t : 1 - (1 - t) ** 2.4;
      ballPos.lerpVectors(h.from, h.end, e);
      if (h.air) ballPos.y = lerp(h.from.y, h.end.y, e) + h.height * Math.sin(Math.PI * e);
      else {
        // Along the ground: drops off the bat, then skims and settles
        ballPos.y = BALL_R + Math.max(0, h.from.y - BALL_R) * Math.max(0, 1 - e * 9)
          + Math.abs(Math.sin(e * 16)) * 0.24 * (1 - e) ** 2;
      }
    } else {
      let p = (now - a.release) / d.flightMs;
      const stumpsP = (STUMP_Z - RELEASE.z) / (CONTACT_Z - RELEASE.z);
      p = Math.min(p, r && r.wicket ? stumpsP : 1.45);
      const pb = deliveryPos(d, p, ballPos);
      if (p >= pb && !a.bounced) {
        a.bounced = true;
        sfx.bounce();
      }
    }
    ball.visible = blob.visible = true;
    ball.position.copy(ballPos);
    blob.position.set(ballPos.x, 0.025, ballPos.z);
    const s = 1 + ballPos.y * 0.25;
    blob.scale.set(s, s, 1);
    blob.material.opacity = clamp(0.4 - ballPos.y * 0.03, 0.08, 0.4);
    return true;
  }

  function updateBowler(a, now, p, time) {
    const kind = a.delivery?.kind || p.bowlerKind || 'pace';
    const startZ = kind === 'spin' ? -14.5 : -20.5;
    bowler.root.rotation.y = 0;
    bowler.root.position.y = 0;
    if (!a.delivery) {
      bowler.root.position.set(0.6, 0, startZ);
      poseStand(bowler, time);
      return;
    }
    const run = clamp((now - a.t0) / (a.release - a.t0), 0, 1);
    const tb = (now - a.release) / 1000;
    const after = clamp(tb, 0, 0.7);
    bowler.root.position.set(0.6 + after * 1.3, 0, lerp(startZ, RELEASE.z - 0.25, run) + after * 3.2);
    if (tb > 0.75) {
      if (a.result?.wicket) poseArmsUp(bowler, time);
      else poseStand(bowler, time);
    } else {
      poseBowl(bowler, tb, ((now - a.t0) / 1000) * (kind === 'spin' ? 9 : 15));
    }
  }

  function updateBatters(a, now, time) {
    const r = a.result;
    const strikerHome = v(-0.38, 0, CONTACT_Z + 0.08);
    const nsHome = v(-1.35, 0, -CONTACT_Z);
    let state = { mode: 'stance' };

    batter.root.position.copy(strikerHome);
    batter.root.rotation.y = Math.PI / 2;
    nonStriker.root.position.copy(nsHome);
    nonStriker.root.rotation.y = 0;
    poseStand(nonStriker, time);
    nonStriker.armR.rotation.z = -0.25;

    if (a.delivery) {
      if (a.swing) {
        const t = (now - a.swing.at) / 1000;
        state = {
          mode: 'swing',
          t,
          shot: pickShot(a.swing.dir, a.swing.style, a.delivery.length),
          loft: a.swing.style === 'loft',
        };
      } else if (now > a.release - 150) {
        state = { mode: 'backlift', t: (now - a.release + 150) / 1000 };
      }
      if (r && r.wicket && !r.contact && now - a.resultAt > 350) state = { mode: 'out' };

      // Running between the wickets
      if (r && r.contact && !r.wicket && r.runs >= 1 && r.runs <= 3) {
        const legMs = Math.min(700, 1900 / r.runs);
        const tt = now - a.resultAt - 280;
        if (tt > 0) {
          const leg = Math.floor(tt / legMs);
          const done = leg >= r.runs;
          const f = done ? 1 : (tt % legMs) / legMs;
          const k = done ? r.runs - 1 : leg;
          const forward = k % 2 === 0; // striker heading to the bowler's end
          const zA = forward ? lerp(CONTACT_Z, -CONTACT_Z, f) : lerp(-CONTACT_Z, CONTACT_Z, f);
          batter.root.position.set(-0.75, 0, zA);
          nonStriker.root.position.set(-1.35, 0, -zA);
          if (!done) {
            batter.root.rotation.y = forward ? Math.PI : 0;
            nonStriker.root.rotation.y = forward ? 0 : Math.PI;
            state = { mode: 'run', phase: (tt / 1000) * 16 };
            poseRun(nonStriker, (tt / 1000) * 16 + 1.5);
          } else {
            state = { mode: 'stance' };
          }
        }
      }
    }
    poseBatter(batter, state, time);
  }

  function updateField(a, now, p, time) {
    const kind = a.delivery?.kind || p.bowlerKind || 'pace';
    keeper.root.position.set(0.3, 0, STUMP_Z + (kind === 'spin' ? 1.7 : 9.5));
    keeper.root.rotation.y = Math.PI;
    keeper.root.visible = p.camMode === 'bowl'; // he would block the batter's view of the ball
    if (a.result?.wicket) poseArmsUp(keeper, time);
    else poseReady(keeper, 1.15);

    poseStand(umpire, time);
    if (a.result && now - a.resultAt > 500) {
      if (a.result.wicket) umpire.armR.rotation.x = -2.9;
      else if (a.result.runs === 6) {
        umpire.armL.rotation.z = 2.9;
        umpire.armR.rotation.z = -2.9;
      } else if (a.result.runs === 4) umpire.armR.rotation.z = -1.5 + Math.sin(time * 9) * 0.35;
      else if (!a.result.legal) {
        umpire.armL.rotation.z = 1.5;
        umpire.armR.rotation.z = -1.5;
      }
    }

    const live = !!a.delivery;
    const h = a.hit;
    fielders.forEach((f, i) => {
      if (h && i === h.chaser) {
        const t = clamp(((now - a.resultAt) / h.dur) * 1.15, 0, 1);
        f.root.position.lerpVectors(f.home, h.target, t);
        if (t < 1 && f.home.distanceToSquared(h.target) > 1) {
          face(f, h.target.x, h.target.z);
          poseRun(f, time * 15 + i);
        } else {
          face(f, 0, CONTACT_Z);
          if (a.result.wicket === 'caught') poseCatch(f);
          else poseStand(f, time);
        }
        return;
      }
      f.root.position.copy(f.home);
      face(f, 0, CONTACT_Z);
      if (a.result?.wicket && now - a.resultAt > 400) poseArmsUp(f, time + i);
      else if (live && !a.result) poseReady(f, 0.8);
      else poseStand(f, time + i);
    });
  }

  function updateStumps(a, now) {
    const broken = a.result && a.result.wicket === 'bowled';
    const tt = broken ? (now - a.resultAt) / 1000 : 0;
    nearStumps.stumps.forEach((s, i) => {
      s.rotation.x = broken ? Math.min(1.25, tt * 7) * (0.55 + 0.25 * i) : 0;
      s.rotation.z = broken ? (i - 1) * Math.min(0.55, tt * 3) : 0;
    });
    nearStumps.bails.forEach((b, i) => {
      b.position.copy(b.userData.home);
      b.rotation.x = 0;
      if (broken) {
        b.position.x += (i ? 1 : -1) * tt * 0.9;
        b.position.z += tt * 1.6;
        b.position.y = Math.max(0.02, b.position.y + tt * 3.2 - 4.9 * tt * tt);
        b.rotation.x = tt * 14;
      }
    });
  }

  function updateMarkers(a, now, p, time) {
    zone.visible = !!p.canAim;
    const d = a.delivery;
    if (d && now >= a.release && !(a.result && a.result.contact)) {
      marker.visible = true;
      marker.material.color.set(0xffffff);
      marker.position.set(d.line * LINE_M, 0.035, bounceZ(d.length));
      marker.scale.setScalar(1);
    } else if (p.canAim && p.aim) {
      marker.visible = true;
      marker.material.color.set(0xff3030);
      marker.position.set(p.aim.line * LINE_M, 0.035, bounceZ(p.aim.length));
      marker.scale.setScalar(1 + Math.sin(time * 6) * 0.1);
    } else {
      marker.visible = false;
    }
  }

  function updateCamera(a, p, dt, ballVisible) {
    // A wicket cuts to a close-up of whoever took it: the catcher, or the bowler celebrating.
    const r = a.result;
    if (r && r.wicket) {
      const since = performance.now() - a.resultAt;
      if (since > (r.contact && a.hit ? a.hit.dur : 1500)) {
        const who = r.wicket === 'caught' && a.hit ? fielders[a.hit.chaser] : bowler;
        const at = who.root.position;
        closeDir.set(-at.x, 0, CONTACT_Z - at.z).normalize(); // they face the pitch
        camera.position.set(at.x + closeDir.x * 3.9 + closeDir.z * 1.2, 1.65, at.z + closeDir.z * 3.9 - closeDir.x * 1.2);
        camLook.set(at.x, 1.42, at.z);
        camera.fov = 28;
        camera.updateProjectionMatrix();
        camera.lookAt(camLook);
        return;
      }
    }

    const mode = p.camMode === 'bowl' ? (p.canAim ? 'aim' : 'bowl') : 'bat';
    const base = CAMS[mode];
    let look = base.look;
    let fov = base.fov;
    if (a.hit && ballVisible) {
      tmp.copy(ballPos);
      tmp.y = Math.min(tmp.y, 12) * 0.6 + 0.6;
      look = tmp;
      fov = base.fov * base.follow;
    }
    const k = 1 - Math.exp(-dt * 4.5);
    camera.position.lerp(base.pos, k);
    camLook.lerp(look, 1 - Math.exp(-dt * 6));
    camera.fov = lerp(camera.fov, fov, k);
    camera.updateProjectionMatrix();
    camera.lookAt(camLook);
  }

  // ---- input: click the pitch to aim ----
  const raycaster = new THREE.Raycaster();
  const ground = new THREE.Plane(v(0, 1, 0), 0);
  const onClick = (e) => {
    const p = getProps();
    if (!p.canAim) return;
    const rect = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.ray.intersectPlane(ground, v(0, 0, 0));
    if (!hit) return;
    if (hit.z < ZONE.far - 0.6 || hit.z > ZONE.near + 0.6 || Math.abs(hit.x) > ZONE.halfW + 0.4) return;
    p.onAim({
      line: clamp(hit.x / LINE_M, -1.3, 1.3),
      length: clamp((STUMP_Z - 1.7 - hit.z) / 8.3, 0, 1),
    });
  };
  renderer.domElement.addEventListener('click', onClick);

  // ---- sizing ----
  const resize = () => {
    const w = mount.clientWidth || 800;
    const h = mount.clientHeight || Math.round((w * 9) / 16);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(mount);
  resize();

  // ---- loop ----
  let raf = 0;
  let last = performance.now();
  const frame = () => {
    raf = requestAnimationFrame(frame);
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const time = now / 1000;
    const p = getProps();
    const a = animRef.current;

    const c = p.colors;
    const key = `${c.batColor}${c.batAccent}${c.batShort}${c.bowlColor}${c.bowlAccent}${c.bowlShort}`;
    if (key !== kitKey) {
      kitKey = key;
      setKitColors(batKit, c.batColor, c.batAccent, c.batShort);
      setKitColors(fieldKit, c.bowlColor, c.bowlAccent, c.bowlShort);
    }

    const ballVisible = updateBall(a, now);
    updateBowler(a, now, p, time);
    updateBatters(a, now, time);
    updateField(a, now, p, time);
    updateStumps(a, now);
    updateMarkers(a, now, p, time);
    for (const avatar of avatars) avatar.update();
    updateCamera(a, p, dt, ballVisible);
    renderer.render(scene, camera);
  };
  frame();

  return {
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      observer.disconnect();
      renderer.domElement.removeEventListener('click', onClick);
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    },
  };
}
