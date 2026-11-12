import './style.css';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  circlePolygon, halfPlane, intersect, union, splitByLine, regionArea, pointInRegion, largestInscribed,
  type Region, type Vec2,
} from './geometry';
import {
  createKnifeMesh, createKnifeBody, planRelease, landingTime,
  TIP_LOCAL, GRIP_LOCAL, HULL_POINTS_LOCAL, HELD_TIP_ANGLE, type KnifeBody, type Release,
} from './knife';

// ---------- Параметры игры ----------
const CIRCLE_R = 1.5; // радиус круга, м
const FOOT_R = 0.11; // сколько места нужно, чтобы встать хотя бы одной ногой
const STICK_MAX_ANGLE = THREE.MathUtils.degToRad(40); // допустимый наклон ножа от вертикали
const STICK_MIN_SPEED = 1.5; // м/с
const STICK_DEPTH = 0.035; // насколько нож уходит в землю
const EYE_HEIGHT = 1.45;
const PHYS_DT = 1 / 120;
const COLORS = [0x3b82f6, 0xe5484d];
const NAMES = ['Синий', 'Красный'];
const CIRCLE_AREA = Math.PI * CIRCLE_R * CIRCLE_R;

/**
 * Бросок свайпом. Нож держат за лезвие остриём вниз; чтобы воткнуться, он должен сделать в воздухе
 * ровно один полный оборот. Длина рывка — дальность (в пределах круга), резкость рывка — закрутка.
 * Скорости жеста — в высотах экрана в секунду, чтобы на телефоне и мониторе ощущалось одинаково.
 */
const SWIPE = {
  minSwipe: 0.3,
  minLength: 0.05,
  fullLength: 0.5, // длина рывка (в высотах экрана), дающая максимальную дальность
  speedMin: 1.0, // м/с при самом коротком рывке
  speedMax: 3.3, // м/с при полном рывке — это примерно дальний край круга
  spinPerSwipe: 4.4, // рад/с закрутки на 1 высоту экрана/с резкости (≈ 1 оборот при резкости 2,5)
  maxSpin: 30,
  elevation: THREE.MathUtils.degToRad(25),
  maxYaw: THREE.MathUtils.degToRad(70),
  releaseWindow: 0.07,
};

/**
 * Уровни сложности. assist — какую долю ошибки в закрутке игра исправляет сама: закрутка подтягивается
 * к ближайшему целому числу оборотов за реальное время полёта. Допуск ≈ ±0,11 / (1 − assist) оборота.
 */
type Level = 'easy' | 'medium' | 'real';
const LEVELS: Record<Level, { label: string; assist: number; hint: string }> = {
  easy: { label: 'Легко', assist: 0.7, hint: 'игра сильно помогает с закруткой' },
  medium: { label: 'Средне', assist: 0.4, hint: 'игра немного помогает с закруткой' },
  real: { label: 'Реалистично', assist: 0, hint: 'никакой помощи — всё в твоей руке' },
};

type Phase = 'aim' | 'gesture' | 'flying' | 'choose' | 'wait' | 'over';

interface FlyingKnife {
  kb: KnifeBody;
  mesh: THREE.Group;
  release: Release;
  t0: number;
  simTime: number;
  contacted: boolean;
  contactTime: number;
  stuck: boolean;
}

interface Sample { x: number; y: number; t: number }

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const UP = new THREE.Vector3(0, 1, 0);

async function main() {
  await RAPIER.init();

  // ---------- Рендер ----------
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  $('app').appendChild(renderer.domElement);
  const canvas = renderer.domElement;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xb9cfdc);
  scene.fog = new THREE.Fog(0xb9cfdc, 10, 28);

  const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.02, 100);
  scene.add(camera); // нужно, чтобы нож в руке (дочерний объект камеры) рисовался

  scene.add(new THREE.HemisphereLight(0xe6f2ff, 0x6b5a45, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(3, 6, 2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -4, right: 4, top: 4, bottom: -4, near: 0.5, far: 20 });
  sun.shadow.camera.updateProjectionMatrix();
  scene.add(sun);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(40, 40),
    new THREE.MeshStandardMaterial({ map: dirtTexture(), roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const groove = new THREE.Mesh(
    new THREE.RingGeometry(CIRCLE_R - 0.012, CIRCLE_R + 0.012, 160),
    new THREE.MeshBasicMaterial({ color: 0x3b2a1a }),
  );
  groove.rotation.x = -Math.PI / 2;
  groove.position.y = 0.007;
  scene.add(groove);

  // ---------- Физика ----------
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = PHYS_DT;
  const groundBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
  const groundCollider = world.createCollider(
    RAPIER.ColliderDesc.cuboid(20, 0.5, 20).setFriction(0.9).setRestitution(0.1),
    groundBody,
  );
  const eventQueue = new RAPIER.EventQueue(true);

  // ---------- Состояние ----------
  const initialRegions = (): [Region, Region] => {
    const circle = circlePolygon(CIRCLE_R);
    return [intersect(circle, halfPlane([0, 0], [1, 0], 1)), intersect(circle, halfPlane([0, 0], [1, 0], -1))];
  };
  let regions = initialRegions();
  let cur = 0;
  let phase: Phase = 'aim';
  let level: Level = loadLevel();
  let knife: FlyingKnife | null = null;
  let pieces: [Region, Region] | null = null;
  let hovered = -1;
  const stands: Vec2[] = [[0, 0], [0, 0]];
  let pendingTimer: number | undefined;
  let gesture: Sample[] = [];
  let trail: Sample[] = [];

  // ---------- Объекты сцены ----------
  const territoryGroups = [new THREE.Group(), new THREE.Group()];
  territoryGroups.forEach((g) => scene.add(g));
  const choiceGroup = new THREE.Group();
  scene.add(choiceGroup);

  const figures = COLORS.map((c) => createFigure(c));
  figures.forEach((f) => scene.add(f.group));

  // Нож в руке: пальцы держат лезвие у острия, нож висит остриём вниз.
  const hand = new THREE.Group();
  const heldKnife = createKnifeMesh();
  heldKnife.position.copy(GRIP_LOCAL).multiplyScalar(-1);
  hand.add(heldKnife);
  const skin = new THREE.MeshStandardMaterial({ color: 0xf1c7a0, roughness: 0.8 });
  const thumb = new THREE.Mesh(new THREE.CapsuleGeometry(0.009, 0.025, 4, 8), skin);
  thumb.position.set(0, 0, 0.008);
  thumb.rotation.z = Math.PI / 2;
  const finger = thumb.clone();
  finger.position.z = -0.008;
  hand.add(thumb, finger);
  camera.add(hand);

  // ---------- HUD ----------
  const msgEl = $('message');
  const infoEl = $('throwinfo');
  const levelSelect = $<HTMLSelectElement>('level');
  const trailCanvas = $<HTMLCanvasElement>('trail');
  const trailCtx = trailCanvas.getContext('2d')!;
  const setMessage = (t: string) => (msgEl.textContent = t);

  for (const [key, l] of Object.entries(LEVELS)) levelSelect.add(new Option(l.label, key));
  levelSelect.value = level;
  levelSelect.addEventListener('change', () => {
    level = levelSelect.value as Level;
    saveLevel(level);
    updateHud();
    levelSelect.blur();
  });

  function updateHud() {
    $('turn').innerHTML =
      `<span class="dot" style="background:#${COLORS[cur].toString(16).padStart(6, '0')}"></span>Ход: ${NAMES[cur]}`;
    for (let i = 0; i < 2; i++) $(`score${i}`).textContent = `${Math.round((regionArea(regions[i]) / CIRCLE_AREA) * 100)}%`;
    $('hint').innerHTML =
      `<b>Рывок вверх</b>: <b>длина — дальность</b>, <b>резкость — закрутка</b> (нужен ровно один оборот), вбок — направление · ` +
      `<b>${LEVELS[level].label}</b>: ${LEVELS[level].hint}`;
  }

  function rebuildTerritories() {
    for (let i = 0; i < 2; i++) {
      clearGroup(territoryGroups[i]);
      territoryGroups[i].add(regionMesh(regions[i], COLORS[i], 0.5, 0.003));
      stands[i] = largestInscribed(regions[i]).center;
      figures[i].group.position.set(stands[i][0], 0, stands[i][1]);
    }
    figures[0].group.lookAt(stands[1][0], 0, stands[1][1]);
    figures[1].group.lookAt(stands[0][0], 0, stands[0][1]);
    updateHud();
  }

  function rebuildChoice() {
    clearGroup(choiceGroup);
    if (!pieces) return;
    pieces.forEach((piece, i) =>
      choiceGroup.add(regionMesh(piece, i === hovered ? COLORS[cur] : 0xffffff, i === hovered ? 0.75 : 0.25, 0.006)),
    );
  }

  // ---------- Камера ----------
  const camPos = new THREE.Vector3(0, 4, 4);
  const camLook = new THREE.Vector3();
  const isFirstPerson = () => phase !== 'choose' && phase !== 'over';

  /** Глаза игрока: стоит на своём месте и смотрит на землю соперника. */
  function firstPersonView(p: number) {
    const [x, z] = stands[p];
    const eye = new THREE.Vector3(x, EYE_HEIGHT, z);
    const [ox, oz] = stands[1 - p];
    const dist = Math.max(0.3, Math.hypot(ox - x, oz - z));
    const yaw = Math.atan2(oz - z, ox - x);
    const pitch = THREE.MathUtils.clamp(Math.atan2(EYE_HEIGHT, dist), 0.05, 1.45);
    const dir = new THREE.Vector3(Math.cos(pitch) * Math.cos(yaw), -Math.sin(pitch), Math.cos(pitch) * Math.sin(yaw));
    return { pos: eye, look: eye.clone().add(dir) };
  }

  /** Вид сверху со стороны бросающего — чтобы выбрать кусок. */
  function overview() {
    const [x, z] = stands[cur];
    const side = new THREE.Vector3(x, 0, z);
    if (side.lengthSq() < 1e-4) side.set(0, 0, cur === 0 ? 1 : -1);
    side.normalize();
    const halfH = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const k = Math.max(1, (CIRCLE_R + 0.4) / (halfH * camera.aspect) / 4.6);
    return { pos: side.multiplyScalar(2.2 * k).addScaledVector(UP, 4.0 * k), look: new THREE.Vector3() };
  }

  function updateCamera(dt: number, snap = false) {
    const v = isFirstPerson() ? firstPersonView(cur) : overview();
    const a = snap ? 1 : 1 - Math.exp(-dt * 5);
    camPos.lerp(v.pos, a);
    camLook.lerp(v.look, a);
    camera.position.copy(camPos);
    camera.lookAt(camLook);
    const settled = camPos.distanceTo(v.pos) < 0.05;
    figures.forEach((f, i) => (f.group.visible = !(isFirstPerson() && i === cur && camPos.distanceTo(v.pos) < 1)));

    // Нож в пальцах; по ходу рывка кисть отводится назад и вперёд.
    hand.visible = settled && (phase === 'aim' || phase === 'gesture');
    const u = phase === 'gesture' ? Math.min(1, gestureLength() / SWIPE.fullLength) : 0;
    hand.position.set(0.2, -0.22 + u * 0.06, -0.5 - u * 0.12);
    hand.rotation.set(-(HELD_TIP_ANGLE - u * 0.7), 0, 0);
  }

  function cameraBasis() {
    const fwd = new THREE.Vector3();
    camera.getWorldDirection(fwd);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) fwd.set(1, 0, 0);
    fwd.normalize();
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    return { fwd, right, yaw: Math.atan2(fwd.z, fwd.x) };
  }

  /** Положение пальцев с ножом в мире (справа-снизу от глаз). */
  function handWorld() {
    const { fwd, right } = cameraBasis();
    return camera.position.clone().addScaledVector(right, 0.2).addScaledVector(UP, -0.2).addScaledVector(fwd, 0.25);
  }

  // ---------- Бросок ----------
  function removeKnife() {
    if (!knife) return;
    world.removeRigidBody(knife.kb.body);
    scene.remove(knife.mesh);
    disposeObject(knife.mesh);
    knife = null;
  }

  function launchRelease(release: Release) {
    removeKnife();
    const mesh = createKnifeMesh();
    scene.add(mesh);
    knife = {
      kb: createKnifeBody(world, planRelease(release)), mesh, release,
      t0: performance.now() / 1000, simTime: 0, contacted: false, contactTime: 0, stuck: false,
    };
    phase = 'flying';
    setMessage('');
    infoEl.textContent =
      `${release.speed.toFixed(1)} м/с · вращение ${(release.spin / (2 * Math.PI)).toFixed(1)} об/с`;
  }

  /** Бросок из жеста. На лёгких уровнях закрутку немного поправляет игра. */
  function swipeRelease(yawOffset: number, speed: number, spin: number): Release {
    const { yaw } = cameraBasis();
    const r: Release = {
      hand: handWorld(),
      yaw: yaw + yawOffset,
      elevation: SWIPE.elevation,
      speed,
      spin,
      tipAngle: HELD_TIP_ANGLE,
      roll: 0,
    };
    const assist = LEVELS[level].assist;
    if (assist > 0) {
      const t = landingTime(r);
      const turns = (spin * t) / (2 * Math.PI);
      const ideal = (2 * Math.PI * Math.max(1, Math.round(turns))) / t;
      r.spin = THREE.MathUtils.lerp(spin, ideal, assist);
    }
    return r;
  }

  /** Длина жеста в высотах экрана. */
  function gestureLength(samples = gesture): number {
    if (samples.length < 2) return 0;
    const a = samples[0];
    const b = samples[samples.length - 1];
    return Math.hypot(b.x - a.x, b.y - a.y) / innerHeight;
  }

  /** Скорость в конце жеста (высоты экрана в секунду). */
  function releaseVelocity(samples: Sample[], window: number) {
    const last = samples[samples.length - 1];
    let first = samples[samples.length - 2];
    for (let i = samples.length - 2; i >= 0 && last.t - samples[i].t <= window; i--) first = samples[i];
    const dt = Math.max(1e-3, last.t - first.t);
    return { vx: (last.x - first.x) / dt / innerHeight, vy: (first.y - last.y) / dt / innerHeight };
  }

  function finishSwipe() {
    const samples = gesture;
    gesture = [];
    phase = 'aim';
    if (samples.length < 2) return;
    const { vx, vy } = releaseVelocity(samples, SWIPE.releaseWindow); // вверх по экрану — вперёд
    const s = Math.hypot(vx, vy);
    const len = gestureLength(samples);
    if (vy <= 0 || s < SWIPE.minSwipe || len < SWIPE.minLength) {
      setMessage('Сделай резкий рывок вперёд — вверх по экрану');
      return;
    }
    const yawOffset = THREE.MathUtils.clamp(Math.atan2(vx, vy), -SWIPE.maxYaw, SWIPE.maxYaw);
    const u = Math.min(1, (len - SWIPE.minLength) / (SWIPE.fullLength - SWIPE.minLength));
    const speed = THREE.MathUtils.lerp(SWIPE.speedMin, SWIPE.speedMax, u);
    const spin = Math.min(SWIPE.maxSpin, s * SWIPE.spinPerSwipe);
    launchRelease(swipeRelease(yawOffset, speed, spin));
  }

  function stepPhysics(now: number) {
    if (!knife) return;
    const b = knife.kb.body;
    const t = b.translation();
    const r = b.rotation();
    const v = b.linvel();
    const prePos = new THREE.Vector3(t.x, t.y, t.z);
    const preRot = new THREE.Quaternion(r.x, r.y, r.z, r.w);
    const preVel = new THREE.Vector3(v.x, v.y, v.z);

    world.step(eventQueue);
    if (!knife.contacted) knife.simTime += PHYS_DT;

    let hitGround = false;
    eventQueue.drainCollisionEvents((h1, h2, started) => {
      if (started && (h1 === groundCollider.handle || h2 === groundCollider.handle)) hitGround = true;
    });
    if (hitGround && !knife.contacted) {
      knife.contacted = true;
      knife.contactTime = now;
      const turns = (knife.release.spin * knife.simTime) / (2 * Math.PI);
      infoEl.textContent += ` · ${turns.toFixed(2)} об. за ${knife.simTime.toFixed(2)} с`;
      tryStick(prePos, preRot, preVel);
    }
  }

  /** Первое касание земли: решаем, воткнулся ли нож. */
  function tryStick(prePos: THREE.Vector3, preRot: THREE.Quaternion, preVel: THREE.Vector3) {
    if (!knife) return;
    const toWorld = (p: THREE.Vector3) => p.clone().applyQuaternion(preRot).add(prePos);
    const tip = toWorld(TIP_LOCAL);
    const lowestOther = Math.min(...HULL_POINTS_LOCAL.map((p) => toWorld(p).y));
    const tipDir = new THREE.Vector3(0, 1, 0).applyQuaternion(preRot);
    const angle = Math.acos(THREE.MathUtils.clamp(-tipDir.y, -1, 1));

    let fail = '';
    if (tip.y > lowestOther + 0.002) fail = 'Нож ударился рукояткой или плашмя';
    else if (angle > STICK_MAX_ANGLE) fail = `Не воткнулся: наклон ${Math.round(THREE.MathUtils.radToDeg(angle))}°`;
    else if (preVel.length() < STICK_MIN_SPEED) fail = 'Слишком слабый бросок';
    if (fail) {
      // Подсказка для обучения: в какую сторону ошибся с закруткой.
      const made = (knife.release.spin * knife.simTime) / (2 * Math.PI);
      const delta = made - Math.max(1, Math.round(made));
      const advice = Math.abs(delta) < 0.03 ? '' : delta > 0
        ? ` — перекрутил на ${delta.toFixed(2)} оборота`
        : ` — недокрутил на ${(-delta).toFixed(2)} оборота`;
      setMessage(`${fail}${advice}. Ход переходит к игроку ${NAMES[1 - cur]}`);
      return;
    }

    const b = knife.kb.body;
    const origin = prePos.clone().addScaledVector(tipDir, (-STICK_DEPTH - tip.y) / tipDir.y);
    const entry = tip.clone().addScaledVector(tipDir, -tip.y / tipDir.y);
    b.setBodyType(RAPIER.RigidBodyType.Fixed, false);
    b.setTranslation(origin, false);
    b.setRotation(preRot, false);
    knife.stuck = true;

    const sx = new THREE.Vector3(1, 0, 0).applyQuaternion(preRot);
    const len = Math.hypot(sx.x, sx.z) || 1;
    onStuck([entry.x, entry.z], [sx.x / len, sx.z / len]);
  }

  function onStuck(p: Vec2, dir: Vec2) {
    const opp = 1 - cur;
    if (!pointInRegion(p, regions[opp])) {
      const where = pointInRegion(p, regions[cur]) ? 'Воткнулся в свою землю' : 'Мимо круга';
      setMessage(`${where}. Ход переходит к игроку ${NAMES[opp]}`);
      phase = 'wait';
      pendingTimer = window.setTimeout(nextTurn, 1500);
      return;
    }
    const [a, b] = splitByLine(regions[opp], p, dir);
    if (regionArea(a) < 1e-5 || regionArea(b) < 1e-5) {
      setMessage('Линия не разрезала землю. Бросай ещё');
      phase = 'aim';
      return;
    }
    pieces = [a, b];
    hovered = -1;
    // Даём полюбоваться воткнувшимся ножом, потом поднимаем камеру для выбора.
    phase = 'wait';
    setMessage('Воткнулся!');
    pendingTimer = window.setTimeout(() => {
      phase = 'choose';
      rebuildChoice();
      setMessage('Нажми на кусок, который забираешь');
    }, 900);
  }

  function take(idx: number) {
    if (!pieces) return;
    const opp = 1 - cur;
    const gained = regionArea(pieces[idx]);
    regions[cur] = union(regions[cur], pieces[idx]);
    regions[opp] = pieces[1 - idx];
    pieces = null;
    rebuildChoice();
    rebuildTerritories();
    removeKnife();

    if (largestInscribed(regions[opp]).radius < FOOT_R) {
      gameOver(cur);
      return;
    }
    phase = 'aim';
    setMessage(`Отрезал ${Math.round((gained / CIRCLE_AREA) * 100)}% круга. Бросай ещё!`);
  }

  function nextTurn() {
    pendingTimer = undefined;
    removeKnife();
    cur = 1 - cur;
    phase = 'aim';
    updateHud();
    setMessage(`Бросает ${NAMES[cur]}`);
  }

  function gameOver(winner: number) {
    phase = 'over';
    setMessage('');
    $('overlay-title').textContent = `Победил ${NAMES[winner]}!`;
    $('overlay').hidden = false;
  }

  function reset() {
    if (pendingTimer !== undefined) clearTimeout(pendingTimer);
    pendingTimer = undefined;
    removeKnife();
    regions = initialRegions();
    pieces = null;
    rebuildChoice();
    cur = 0;
    phase = 'aim';
    gesture = [];
    infoEl.textContent = '';
    $('overlay').hidden = true;
    rebuildTerritories();
    setMessage(`Бросает ${NAMES[cur]}`);
  }

  // ---------- Ввод ----------
  const raycaster = new THREE.Raycaster();
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  function groundPoint(clientX: number, clientY: number): THREE.Vector3 | null {
    const rect = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const p = new THREE.Vector3();
    return raycaster.ray.intersectPlane(groundPlane, p) ? p : null;
  }

  function hoverPiece(clientX: number, clientY: number) {
    if (phase !== 'choose' || !pieces) return;
    const p = groundPoint(clientX, clientY);
    const h = !p ? -1 : pointInRegion([p.x, p.z], pieces[0]) ? 0 : pointInRegion([p.x, p.z], pieces[1]) ? 1 : -1;
    if (h !== hovered) {
      hovered = h;
      rebuildChoice();
    }
  }

  const addSample = (ev: PointerEvent) => {
    const s = { x: ev.clientX, y: ev.clientY, t: ev.timeStamp / 1000 };
    gesture.push(s);
    trail.push(s);
  };

  canvas.addEventListener('pointerdown', (ev) => {
    if (!ev.isPrimary || ev.button !== 0) return;
    if (phase === 'choose') {
      hoverPiece(ev.clientX, ev.clientY);
      if (hovered >= 0) take(hovered);
      return;
    }
    if (phase !== 'aim') return;
    phase = 'gesture';
    gesture = [];
    trail = [];
    addSample(ev);
    canvas.setPointerCapture(ev.pointerId);
  });
  canvas.addEventListener('pointermove', (ev) => {
    if (!ev.isPrimary) return;
    if (phase === 'gesture') {
      const coalesced = ev.getCoalescedEvents?.() ?? [];
      for (const e of coalesced.length ? coalesced : [ev]) addSample(e);
    }
    hoverPiece(ev.clientX, ev.clientY);
  });
  canvas.addEventListener('pointerup', (ev) => {
    if (!ev.isPrimary || ev.button !== 0 || phase !== 'gesture') return;
    addSample(ev);
    finishSwipe();
  });
  canvas.addEventListener('pointercancel', () => {
    gesture = [];
    if (phase === 'gesture') phase = 'aim';
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  $('restart').addEventListener('click', reset);
  $('overlay-restart').addEventListener('click', reset);

  function resize() {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    trailCanvas.width = innerWidth * devicePixelRatio;
    trailCanvas.height = innerHeight * devicePixelRatio;
  }
  resize();
  addEventListener('resize', resize);

  // След свайпа на экране.
  function drawTrail(nowSec: number) {
    const ctx = trailCtx;
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    trail = trail.filter((s) => nowSec - s.t < 0.45);
    ctx.lineCap = 'round';
    for (let i = 1; i < trail.length; i++) {
      const a = 1 - (nowSec - trail[i].t) / 0.45;
      ctx.strokeStyle = `rgba(255,255,255,${(a * 0.8).toFixed(3)})`;
      ctx.lineWidth = 2 + a * 6;
      ctx.beginPath();
      ctx.moveTo(trail[i - 1].x, trail[i - 1].y);
      ctx.lineTo(trail[i].x, trail[i].y);
      ctx.stroke();
    }
  }

  // ---------- Цикл ----------
  let acc = 0;
  let last = performance.now();
  function frame(nowMs: number) {
    const dt = Math.min(0.1, (nowMs - last) / 1000);
    last = nowMs;
    update(nowMs / 1000, dt);
    drawTrail(nowMs / 1000);
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }

  function update(now: number, dt: number) {
    if (knife && !knife.stuck) {
      acc += dt;
      while (acc >= PHYS_DT && knife && !knife.stuck) {
        stepPhysics(now);
        acc -= PHYS_DT;
      }
    } else acc = 0;

    if (knife) {
      const t = knife.kb.body.translation();
      const r = knife.kb.body.rotation();
      knife.mesh.position.set(t.x, t.y, t.z);
      knife.mesh.quaternion.set(r.x, r.y, r.z, r.w);

      // Не воткнулся: ждём, пока нож успокоится, и передаём ход.
      if (phase === 'flying' && !knife.stuck) {
        const settled = knife.contacted && (now - knife.contactTime > 1.2 || knife.kb.body.isSleeping());
        const lost = now - knife.t0 > 6;
        if (settled || lost) {
          if (lost && !knife.contacted) setMessage(`Нож улетел. Ход переходит к игроку ${NAMES[1 - cur]}`);
          phase = 'wait';
          pendingTimer = window.setTimeout(nextTurn, 700);
        }
      }
    }
    updateCamera(dt);
  }

  rebuildTerritories();
  updateCamera(0, true);
  setMessage(`Бросает ${NAMES[cur]}`);
  requestAnimationFrame(frame);

  if (import.meta.env.DEV) {
    // Хук для отладки и автотестов из консоли.
    (window as unknown as Record<string, unknown>).__game = {
      /** Бросок напрямую: отклонение от взгляда (°), скорость (м/с), закрутка (рад/с). */
      throwSwipe(yawDeg: number, speed: number, spin: number) {
        if (phase !== 'aim') return `phase=${phase}`;
        launchRelease(swipeRelease(THREE.MathUtils.degToRad(yawDeg), speed, spin));
        return 'thrown';
      },
      setLevel(l: Level) {
        levelSelect.value = l;
        levelSelect.dispatchEvent(new Event('change'));
      },
      /** Прокрутить симуляцию без requestAnimationFrame (когда вкладка не рисуется). */
      simulate(seconds: number) {
        let now = performance.now() / 1000;
        for (let t = 0; t < seconds; t += 1 / 60) update((now += 1 / 60), 1 / 60);
        drawTrail(now);
        renderer.render(scene, camera);
      },
      choose(i: number) {
        if (phase === 'choose') take(i);
      },
      get state() {
        return {
          phase, cur, level, areas: regions.map(regionArea), message: msgEl.textContent, info: infoEl.textContent,
          stands, pieceAreas: pieces?.map(regionArea),
        };
      },
    };
  }
}

// ---------- Вспомогательное ----------
function loadLevel(): Level {
  try {
    const l = localStorage.getItem('knives.level');
    if (l && l in LEVELS) return l as Level;
  } catch { /* хранилище недоступно */ }
  return 'easy';
}

function saveLevel(l: Level) {
  try {
    localStorage.setItem('knives.level', l);
  } catch { /* хранилище недоступно */ }
}

function dirtTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d')!;
  g.fillStyle = '#8a6a4a';
  g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 9000; i++) {
    const v = 70 + Math.random() * 80;
    g.fillStyle = `rgba(${v + 45},${v + 20},${v - 15},0.28)`;
    g.beginPath();
    g.arc(Math.random() * 512, Math.random() * 512, Math.random() * 3 + 0.5, 0, Math.PI * 2);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(10, 10);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function regionMesh(region: Region, color: number, opacity: number, y: number): THREE.Group {
  const group = new THREE.Group();
  if (!region.length) return group;
  const toV = (ring: [number, number][]) => ring.slice(0, -1).map(([x, z]) => new THREE.Vector2(x, -z));
  const shapes = region.map((poly) => {
    const shape = new THREE.Shape(toV(poly[0]));
    for (let h = 1; h < poly.length; h++) shape.holes.push(new THREE.Path(toV(poly[h])));
    return shape;
  });
  const mesh = new THREE.Mesh(
    new THREE.ShapeGeometry(shapes),
    new THREE.MeshStandardMaterial({ color, transparent: true, opacity, roughness: 1, side: THREE.DoubleSide, depthWrite: false }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = y;
  mesh.receiveShadow = true;
  group.add(mesh);
  const lineMat = new THREE.LineBasicMaterial({ color: 0x2a1d12 });
  for (const poly of region)
    for (const ring of poly)
      group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(ring.map(([x, z]) => new THREE.Vector3(x, y + 0.001, z))), lineMat));
  return group;
}

function createFigure(color: number) {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.7 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.11, 0.5, 6, 16), mat);
  body.position.y = 0.42;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.1, 20, 16), new THREE.MeshStandardMaterial({ color: 0xf1c7a0, roughness: 0.8 }));
  head.position.y = 0.86;
  for (const m of [body, head]) {
    m.castShadow = true;
    group.add(m);
  }
  const footRing = new THREE.Mesh(
    new THREE.RingGeometry(FOOT_R - 0.01, FOOT_R, 40),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7 }),
  );
  footRing.rotation.x = -Math.PI / 2;
  footRing.position.y = 0.01;
  group.add(footRing);
  return { group };
}

function disposeObject(obj: THREE.Object3D) {
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose();
    const mat = m.material;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else mat?.dispose();
  });
}

function clearGroup(g: THREE.Group) {
  for (const child of [...g.children]) {
    g.remove(child);
    disposeObject(child);
  }
}

main();
