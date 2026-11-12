import './style.css';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  circlePolygon, halfPlane, intersect, union, difference, components, regionArea, pointInRegion, largestInscribed,
  distToBoundary,
  type Region, type Vec2,
} from './geometry';
import {
  createKnifeMesh, createKnifeBody, planRelease, landingTime,
  TIP_LOCAL, GRIP_LOCAL, HULL_POINTS_LOCAL, HELD_TIP_ANGLE, type KnifeBody, type Release,
} from './knife';
import {
  crackFrom, markHit, canPlaceMark, splitPieces, capturedPieces, guardingMark,
  MARK_R, MARK_HP, MARKS_PER_PLAYER, MIN_PIECE, GUARD_DAMAGE, type Crack, type Mark,
} from './rules';
import { BOT_LEVELS, botPlaceMarks, botTarget, type BotLevel } from './bot';

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
const BOT = 1; // бот играет за красных
const WALK_SPEED = 0.8; // м/с, шаг по своей земле
const LOOK_SENS = 0.004; // рад на пиксель при повороте правой кнопкой

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
 * Ножи. assist — какую долю ошибки в закрутке игра исправляет сама (закрутка подтягивается к ближайшему
 * целому числу оборотов; допуск ≈ ±0,11 / (1 − assist) оборота). damage — сколько прочности снимает с метки.
 * wobble — шатание: случайное отклонение направления броска, σ в градусах.
 */
type KnifeId = 'super' | 'easy' | 'medium' | 'real';
const KNIVES: Record<KnifeId, { label: string; assist: number; damage: number; wobble: number }> = {
  super: { label: 'Супер лёгкий нож', assist: 0.9, damage: 1, wobble: 4 },
  easy: { label: 'Лёгкий нож', assist: 0.7, damage: 1, wobble: 3 },
  medium: { label: 'Средний нож', assist: 0.4, damage: 2, wobble: 2 },
  real: { label: 'Реалистичный нож', assist: 0, damage: 3, wobble: 1 },
};
const BOT_KNIFE: KnifeId = 'medium';

type Opponent = 'human' | BotLevel;
type Phase = 'place' | 'aim' | 'gesture' | 'flying' | 'wait' | 'over';

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
  let marks: Mark[] = [];
  let cracks: Crack[] = [];
  let cur = 0;
  let phase: Phase = 'place';
  let opponent: Opponent = loadOpponent();
  const knives: [KnifeId, KnifeId] = [loadKnife(), loadKnife()];
  let knife: FlyingKnife | null = null;
  const stands: Vec2[] = [[0, 0], [0, 0]];
  let pendingTimer: number | undefined;
  let gesture: Sample[] = [];
  let trail: Sample[] = [];
  let clock = 0; // игровое время, с

  const isBot = (p: number) => opponent !== 'human' && p === BOT;
  const knifeOf = (p: number) => KNIVES[isBot(p) ? BOT_KNIFE : knives[p]];
  /** Чей нож показывает переключатель: в игре с ботом — человека, вдвоём — того, кто ходит. */
  const selectedPlayer = () => (opponent === 'human' ? cur : 1 - BOT);

  // ---------- Объекты сцены ----------
  const territoryGroups = [new THREE.Group(), new THREE.Group()];
  territoryGroups.forEach((g) => scene.add(g));
  const marksGroup = new THREE.Group();
  /** Вспышки на метках, потерявших прочность. */
  const flashes: { mesh: THREE.Mesh; t0: number }[] = [];
  const cracksGroup = new THREE.Group();
  scene.add(marksGroup, cracksGroup);

  const ghost = new THREE.Mesh(
    new THREE.RingGeometry(MARK_R - 0.015, MARK_R, 48),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8 }),
  );
  ghost.rotation.x = -Math.PI / 2;
  ghost.position.y = 0.012;
  ghost.visible = false;
  scene.add(ghost);

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
  const knifeSelect = $<HTMLSelectElement>('knife');
  const opponentSelect = $<HTMLSelectElement>('opponent');
  const trailCanvas = $<HTMLCanvasElement>('trail');
  const trailCtx = trailCanvas.getContext('2d')!;
  const setMessage = (t: string) => (msgEl.textContent = t);

  for (const [key, k] of Object.entries(KNIVES)) knifeSelect.add(new Option(k.label, key));
  knifeSelect.addEventListener('change', () => {
    knives[selectedPlayer()] = knifeSelect.value as KnifeId;
    saveKnife(knifeSelect.value as KnifeId);
    updateHud();
    knifeSelect.blur();
  });
  opponentSelect.add(new Option('Вдвоём', 'human'));
  for (const [key, b] of Object.entries(BOT_LEVELS)) opponentSelect.add(new Option(b.label, key));
  opponentSelect.value = opponent;
  opponentSelect.addEventListener('change', () => {
    opponent = opponentSelect.value as Opponent;
    saveOpponent(opponent);
    opponentSelect.blur();
    reset();
  });

  function updateHud() {
    const who = isBot(cur) ? `${NAMES[cur]} (бот)` : NAMES[cur];
    $('turn').innerHTML =
      `<span class="dot" style="background:#${COLORS[cur].toString(16).padStart(6, '0')}"></span>` +
      (phase === 'place' ? `Метки: ${who}` : `Ход: ${who}`);
    for (let i = 0; i < 2; i++) $(`score${i}`).textContent = `${Math.round((regionArea(regions[i]) / CIRCLE_AREA) * 100)}%`;
    knifeSelect.value = knives[selectedPlayer()];
    const k = knifeOf(cur);
    $('hint').innerHTML = phase === 'place'
      ? `Нажми на свою землю, чтобы поставить метку. Линия разреза останавливается на целой метке, а пробить метку можно только ножом.`
      : `<b>Рывок вверх</b>: длина — дальность, резкость — закрутка (нужен один оборот), вбок — направление · ` +
        `<b>Правая кнопка</b> — осмотреться, <b>WASD</b> — шаг по своей земле · ` +
        `Линия упирается в целые метки соперника · <b>${k.label}</b>: помощь ${Math.round(k.assist * 100)}%, ` +
        `урон по метке ${k.damage}, шатание ±${k.wobble}°`;
  }

  const canStand = (p: Vec2, region: Region) => pointInRegion(p, region) && distToBoundary(p, region) >= FOOT_R;

  /** Шаг по своей земле (WASD / стрелки) — чтобы бросать с другого угла. */
  function walk(dt: number) {
    if (phase !== 'aim' || isBot(cur) || viewer() !== cur || !keys.size) return;
    const k = (...codes: string[]) => (codes.some((c) => keys.has(c)) ? 1 : 0);
    const f = k('KeyW', 'ArrowUp') - k('KeyS', 'ArrowDown');
    const rt = k('KeyD', 'ArrowRight') - k('KeyA', 'ArrowLeft');
    if (!f && !rt) return;
    const yaw = firstPersonView(cur).yaw;
    let mx = Math.cos(yaw) * f - Math.sin(yaw) * rt;
    let mz = Math.sin(yaw) * f + Math.cos(yaw) * rt;
    const len = Math.hypot(mx, mz);
    mx = (mx / len) * WALK_SPEED * dt;
    mz = (mz / len) * WALK_SPEED * dt;
    const [x, z] = stands[cur];
    // Упёрлись в край — скользим вдоль него.
    for (const next of [[x + mx, z + mz], [x + mx, z], [x, z + mz]] as Vec2[]) {
      if (!canStand(next, regions[cur])) continue;
      stands[cur] = next;
      figures[cur].group.position.set(next[0], 0, next[1]);
      lastManual = clock;
      return;
    }
  }

  function rebuildTerritories() {
    for (let i = 0; i < 2; i++) {
      clearGroup(territoryGroups[i]);
      territoryGroups[i].add(regionMesh(regions[i], COLORS[i], 0.5, 0.003));
      // Игрок остаётся, где стоял, если там ещё есть место; иначе — на самое просторное место.
      if (!canStand(stands[i], regions[i])) stands[i] = largestInscribed(regions[i]).center;
      figures[i].group.position.set(stands[i][0], 0, stands[i][1]);
    }
    figures[0].group.lookAt(stands[1][0], 0, stands[1][1]);
    figures[1].group.lookAt(stands[0][0], 0, stands[0][1]);
    updateHud();
  }

  /** Снять прочность с метки и подсветить её. */
  function damageMark(m: Mark, dmg: number) {
    m.hp = Math.max(0, m.hp - dmg);
    rebuildMarks();
    const mesh = new THREE.Mesh(
      new THREE.RingGeometry(MARK_R * 0.6, MARK_R * 1.15, 48),
      new THREE.MeshBasicMaterial({ color: 0xffe066, transparent: true, opacity: 0.9, depthWrite: false }),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(m.c[0], 0.014, m.c[1]);
    scene.add(mesh);
    flashes.push({ mesh, t0: clock });
  }

  function updateFlashes() {
    for (let i = flashes.length - 1; i >= 0; i--) {
      const f = flashes[i];
      const u = (clock - f.t0) / 1.2;
      if (u >= 1) {
        scene.remove(f.mesh);
        disposeObject(f.mesh);
        flashes.splice(i, 1);
        continue;
      }
      // Две мягкие пульсации, затухая.
      (f.mesh.material as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - u) * (0.6 + 0.4 * Math.cos(u * Math.PI * 4));
      f.mesh.scale.setScalar(1 + 0.25 * u);
    }
  }

  function rebuildMarks() {
    clearGroup(marksGroup);
    for (const m of marks) {
      if (m.hp <= 0) continue;
      const g = new THREE.Group();
      g.position.set(m.c[0], 0, m.c[1]);
      const disc = new THREE.Mesh(
        new THREE.CircleGeometry(MARK_R, 48),
        new THREE.MeshBasicMaterial({ color: COLORS[m.owner], transparent: true, opacity: 0.35, depthWrite: false }),
      );
      disc.rotation.x = -Math.PI / 2;
      disc.position.y = 0.008;
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(MARK_R - 0.02, MARK_R, 48),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.009;
      g.add(disc, ring);
      // Колышки — сколько прочности осталось.
      for (let i = 0; i < m.hp; i++) {
        const a = (i / MARK_HP) * Math.PI * 2 + Math.PI / 2;
        const peg = new THREE.Mesh(
          new THREE.CylinderGeometry(0.014, 0.014, 0.05, 10),
          new THREE.MeshStandardMaterial({ color: 0xf5f0e6, roughness: 0.6 }),
        );
        peg.position.set(Math.cos(a) * MARK_R * 0.5, 0.025, Math.sin(a) * MARK_R * 0.5);
        peg.castShadow = true;
        g.add(peg);
      }
      marksGroup.add(g);
    }
  }

  function rebuildCracks() {
    clearGroup(cracksGroup);
    for (const k of cracks) {
      const dx = k.b[0] - k.a[0];
      const dz = k.b[1] - k.a[1];
      const len = Math.hypot(dx, dz);
      if (len < 1e-3) continue;
      const m = new THREE.Mesh(new THREE.BoxGeometry(len, 0.002, 0.014), new THREE.MeshBasicMaterial({ color: 0x1d130b }));
      m.position.set((k.a[0] + k.b[0]) / 2, 0.01, (k.a[1] + k.b[1]) / 2);
      m.rotation.y = -Math.atan2(dz, dx);
      cracksGroup.add(m);
    }
  }

  // ---------- Камера ----------
  const camPos = new THREE.Vector3(0, 4, 4);
  const camLook = new THREE.Vector3();
  /** Поворот взгляда игрока относительно направления на соперника (правая кнопка мыши). */
  const look = [{ yaw: 0, pitch: 0 }, { yaw: 0, pitch: 0 }];
  let lookDrag: { x: number; y: number } | null = null;
  const keys = new Set<string>();
  let lastManual = -1; // когда игрок последний раз крутил камеру или шагал (для отзывчивости камеры)
  const isFirstPerson = () => phase !== 'place' && phase !== 'over';

  /** Глаза игрока: стоит на своём месте и смотрит на землю соперника. */
  function firstPersonView(p: number) {
    const [x, z] = stands[p];
    const eye = new THREE.Vector3(x, EYE_HEIGHT, z);
    const [ox, oz] = stands[1 - p];
    const dist = Math.max(0.3, Math.hypot(ox - x, oz - z));
    const yaw = Math.atan2(oz - z, ox - x) + look[p].yaw;
    const pitch = THREE.MathUtils.clamp(Math.atan2(EYE_HEIGHT, dist) + look[p].pitch, -0.6, 1.45);
    const dir = new THREE.Vector3(Math.cos(pitch) * Math.cos(yaw), -Math.sin(pitch), Math.cos(pitch) * Math.sin(yaw));
    return { pos: eye, look: eye.clone().add(dir), yaw };
  }

  /** Вид сверху со стороны игрока — чтобы расставить метки. */
  function overview() {
    const [x, z] = stands[cur];
    const side = new THREE.Vector3(x, 0, z);
    if (side.lengthSq() < 1e-4) side.set(0, 0, cur === 0 ? 1 : -1);
    side.normalize();
    const halfH = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const k = Math.max(1, (CIRCLE_R + 0.4) / (halfH * camera.aspect) / 4.6);
    return { pos: side.multiplyScalar(2.2 * k).addScaledVector(UP, 4.0 * k), look: new THREE.Vector3() };
  }

  /** Чьими глазами смотрим: в игре с ботом — всегда глазами человека. */
  const viewer = () => (opponent === 'human' ? cur : 1 - BOT);

  function updateCamera(dt: number, snap = false) {
    const v = isFirstPerson() ? firstPersonView(viewer()) : overview();
    const rate = clock - lastManual < 0.25 ? 30 : 5; // свои повороты и шаги — без задержки
    const a = snap ? 1 : 1 - Math.exp(-dt * rate);
    camPos.lerp(v.pos, a);
    camLook.lerp(v.look, a);
    camera.position.copy(camPos);
    camera.lookAt(camLook);
    const settled = camPos.distanceTo(v.pos) < 0.05;
    figures.forEach((f, i) => (f.group.visible = !(isFirstPerson() && i === viewer() && camPos.distanceTo(v.pos) < 1)));

    // Нож в пальцах; по ходу рывка кисть отводится назад и вперёд.
    hand.visible = settled && !isBot(cur) && (phase === 'aim' || phase === 'gesture');
    const u = phase === 'gesture' ? Math.min(1, gestureLength() / SWIPE.fullLength) : 0;
    hand.position.set(0.2, -0.22 + u * 0.06, -0.5 - u * 0.12);
    hand.rotation.set(-(HELD_TIP_ANGLE - u * 0.7), 0, 0);
  }

  /** Положение пальцев с ножом в мире (справа-снизу от глаз) и направление взгляда игрока p. */
  function handAt(p: number) {
    const v = firstPersonView(p);
    const fwd = new THREE.Vector3(Math.cos(v.yaw), 0, Math.sin(v.yaw));
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const pos = v.pos.clone().addScaledVector(right, 0.2).addScaledVector(UP, -0.2).addScaledVector(fwd, 0.25);
    return { pos, yaw: v.yaw };
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

  function baseRelease(p: number, yaw: number, speed: number, spin: number): Release {
    return { hand: handAt(p).pos, yaw, elevation: SWIPE.elevation, speed, spin, tipAngle: HELD_TIP_ANGLE, roll: 0 };
  }

  /** Свойства ножа: шатание уводит направление, помощь подтягивает закрутку к целому числу оборотов. */
  function applyKnife(r: Release, p: number): Release {
    const k = knifeOf(p);
    r.yaw += gauss() * THREE.MathUtils.degToRad(k.wobble);
    if (k.assist > 0) {
      const t = landingTime(r);
      const turns = (r.spin * t) / (2 * Math.PI);
      const ideal = (2 * Math.PI * Math.max(1, Math.round(turns))) / t;
      r.spin = THREE.MathUtils.lerp(r.spin, ideal, k.assist);
    }
    return r;
  }

  function swipeRelease(yawOffset: number, speed: number, spin: number): Release {
    return applyKnife(baseRelease(cur, handAt(cur).yaw + yawOffset, speed, spin), cur);
  }

  /** Горизонтальная дальность броска с данной скоростью. */
  function throwDistance(speed: number): number {
    return Math.cos(SWIPE.elevation) * speed * landingTime(baseRelease(cur, 0, speed, 0));
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

  function passTurn(msg: string, delay = 1600) {
    setMessage(msg);
    phase = 'wait';
    pendingTimer = window.setTimeout(nextTurn, delay);
  }

  /** Нож воткнулся в точку p, клинок вдоль dir. */
  function onStuck(p: Vec2, dir: Vec2) {
    const opp = 1 - cur;
    if (!pointInRegion(p, regions[opp])) {
      const where = pointInRegion(p, regions[cur]) ? 'Воткнулся в свою землю' : 'Мимо круга';
      passTurn(`${where}. Ход переходит к игроку ${NAMES[opp]}`);
      return;
    }

    const mark = markHit(p, marks, opp);
    if (mark) {
      damageMark(mark, knifeOf(cur).damage);
      passTurn(mark.hp > 0 ? `Попал в метку! Прочность ${mark.hp} из ${MARK_HP}` : 'Метка пробита!');
      return;
    }

    const line = crackFrom(p, dir, CIRCLE_R);
    cracks = [line];
    rebuildCracks();
    const captured = capturedPieces(splitPieces(regions[opp], cracks), stands[opp]);
    if (!captured.length) {
      passTurn('Линия ничего не отрезала');
      return;
    }
    // Целая метка на отрезаемой земле (или на линии) защищает её и теряет прочность.
    const guard = guardingMark(p, captured, line, marks, opp);
    if (guard) {
      damageMark(guard, GUARD_DAMAGE);
      passTurn(guard.hp > 0
        ? `Метка защитила землю: прочность ${guard.hp} из ${MARK_HP}`
        : 'Метка защитила землю и сломалась — теперь здесь можно резать!');
      return;
    }

    let gained = 0;
    for (const piece of captured) {
      gained += regionArea(piece);
      regions[cur] = union(regions[cur], piece);
      regions[opp] = difference(regions[opp], piece);
      // Метки на отрезанной земле пропадают.
      for (const m of marks) if (m.owner === opp && pointInRegion(m.c, piece)) m.hp = 0;
    }
    // Крошки (обрывки вдоль линии) тоже отходят бросающему.
    for (const crumb of components(regions[opp])) {
      if (regionArea(crumb) >= MIN_PIECE) continue;
      regions[cur] = union(regions[cur], crumb);
      regions[opp] = difference(regions[opp], crumb);
    }
    rebuildTerritories();
    rebuildMarks();

    if (largestInscribed(regions[opp]).radius < FOOT_R) {
      setMessage('Воткнулся!');
      phase = 'wait';
      pendingTimer = window.setTimeout(() => gameOver(cur), 1200);
      return;
    }
    passTurn(`Отрезал ${Math.round((gained / CIRCLE_AREA) * 100)}% круга!`, 2000);
  }

  function nextTurn() {
    pendingTimer = undefined;
    removeKnife();
    cracks = [];
    rebuildCracks();
    cur = 1 - cur;
    phase = 'aim';
    updateHud();
    setMessage(`Бросает ${NAMES[cur]}`);
    if (isBot(cur)) pendingTimer = window.setTimeout(botThrow, 1400);
  }

  function gameOver(winner: number) {
    phase = 'over';
    setMessage('');
    $('overlay-title').textContent = `Победил ${NAMES[winner]}${isBot(winner) ? ' (бот)' : ''}!`;
    $('overlay').hidden = false;
  }

  // ---------- Метки перед партией ----------
  function startPlacement(p: number) {
    cur = p;
    phase = 'place';
    if (isBot(p)) {
      marks.push(...botPlaceMarks(regions[p], p, stands[p], marks));
      rebuildMarks();
      finishPlacement(p);
      return;
    }
    updateHud();
    setMessage(`${NAMES[p]}: поставь метки на свою землю — осталось ${MARKS_PER_PLAYER}`);
  }

  function placeMark(c: Vec2): boolean {
    if (phase !== 'place' || !canPlaceMark(c, regions[cur], marks)) return false;
    marks.push({ owner: cur, c, hp: MARK_HP });
    rebuildMarks();
    const left = MARKS_PER_PLAYER - marks.filter((m) => m.owner === cur).length;
    if (left > 0) setMessage(`${NAMES[cur]}: поставь метки на свою землю — осталось ${left}`);
    else finishPlacement(cur);
    return true;
  }

  function finishPlacement(p: number) {
    ghost.visible = false;
    if (p === 0) {
      startPlacement(1);
      return;
    }
    cur = 0;
    phase = 'aim';
    updateHud();
    setMessage(`Бросает ${NAMES[cur]}`);
  }

  // ---------- Бот ----------
  function botThrow() {
    pendingTimer = undefined;
    if (phase !== 'aim' || !isBot(cur) || opponent === 'human') return;
    aimAsBot(opponent);
  }

  /** Бросок за текущего игрока так, как бросает бот уровня level. */
  function aimAsBot(level: BotLevel) {
    const opp = 1 - cur;
    const h = handAt(cur);
    const hand2: Vec2 = [h.pos.x, h.pos.z];
    const dMin = throwDistance(SWIPE.speedMin);
    const dMax = throwDistance(SWIPE.speedMax);
    const target =
      botTarget({
        base: regions[opp], opp, oppStand: stands[opp], marks, circleR: CIRCLE_R,
        hand: hand2, reach: (d) => d >= dMin && d <= dMax, level,
      }) ?? largestInscribed(regions[opp]).center;

    // Скорость под нужную дальность (дальность растёт со скоростью), закрутка — ровно на один оборот.
    const dist = Math.hypot(target[0] - hand2[0], target[1] - hand2[1]);
    let lo = SWIPE.speedMin;
    let hi = SWIPE.speedMax;
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      if (throwDistance(mid) < dist) lo = mid;
      else hi = mid;
    }
    const noise = BOT_LEVELS[level];
    const speed = THREE.MathUtils.clamp(lo + gauss() * noise.speed, SWIPE.speedMin, SWIPE.speedMax);
    const yaw = Math.atan2(target[1] - hand2[1], target[0] - hand2[0]) + gauss() * THREE.MathUtils.degToRad(noise.yaw);
    const t = landingTime(baseRelease(cur, yaw, speed, 0));
    const spin = ((2 * Math.PI) / t) * (1 + gauss() * noise.spin);
    launchRelease(applyKnife(baseRelease(cur, yaw, speed, spin), cur));
  }

  function reset() {
    if (pendingTimer !== undefined) clearTimeout(pendingTimer);
    pendingTimer = undefined;
    removeKnife();
    regions = initialRegions();
    stands[0] = [0, 0];
    stands[1] = [0, 0];
    for (const l of look) l.yaw = l.pitch = 0;
    marks = [];
    cracks = [];
    gesture = [];
    infoEl.textContent = '';
    $('overlay').hidden = true;
    rebuildTerritories();
    rebuildMarks();
    rebuildCracks();
    startPlacement(0);
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

  function hoverGhost(clientX: number, clientY: number) {
    if (phase !== 'place') return;
    const p = groundPoint(clientX, clientY);
    ghost.visible = !!p && Math.hypot(p.x, p.z) < CIRCLE_R + 0.3;
    if (!p) return;
    ghost.position.set(p.x, 0.012, p.z);
    (ghost.material as THREE.MeshBasicMaterial).color.set(canPlaceMark([p.x, p.z], regions[cur], marks) ? 0x4ade80 : 0xf87171);
  }

  const addSample = (ev: PointerEvent) => {
    const s = { x: ev.clientX, y: ev.clientY, t: ev.timeStamp / 1000 };
    gesture.push(s);
    trail.push(s);
  };

  canvas.addEventListener('pointerdown', (ev) => {
    if (ev.button === 2 && isFirstPerson()) {
      lookDrag = { x: ev.clientX, y: ev.clientY };
      canvas.setPointerCapture(ev.pointerId);
      return;
    }
    if (!ev.isPrimary || ev.button !== 0) return;
    if (phase === 'place') {
      const p = groundPoint(ev.clientX, ev.clientY);
      if (p && !placeMark([p.x, p.z])) setMessage('Сюда нельзя: метка должна быть на твоей земле и не задевать другие метки');
      return;
    }
    if (phase !== 'aim' || isBot(cur)) return;
    phase = 'gesture';
    gesture = [];
    trail = [];
    addSample(ev);
    canvas.setPointerCapture(ev.pointerId);
  });
  canvas.addEventListener('pointermove', (ev) => {
    if (lookDrag) {
      const l = look[viewer()];
      l.yaw += (ev.clientX - lookDrag.x) * LOOK_SENS;
      l.pitch = THREE.MathUtils.clamp(l.pitch + (ev.clientY - lookDrag.y) * LOOK_SENS, -1.2, 0.9);
      lookDrag = { x: ev.clientX, y: ev.clientY };
      lastManual = clock;
      return;
    }
    if (!ev.isPrimary) return;
    if (phase === 'gesture') {
      const coalesced = ev.getCoalescedEvents?.() ?? [];
      for (const e of coalesced.length ? coalesced : [ev]) addSample(e);
    }
    hoverGhost(ev.clientX, ev.clientY);
  });
  canvas.addEventListener('pointerup', (ev) => {
    if (ev.button === 2) lookDrag = null;
    if (!ev.isPrimary || ev.button !== 0 || phase !== 'gesture') return;
    addSample(ev);
    finishSwipe();
  });
  canvas.addEventListener('pointercancel', () => {
    gesture = [];
    if (phase === 'gesture') phase = 'aim';
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLSelectElement) return;
    keys.add(e.code);
  });
  addEventListener('keyup', (e) => keys.delete(e.code));
  addEventListener('blur', () => keys.clear());
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
    clock += dt;
    walk(dt);
    updateFlashes();
    updateCamera(dt);
  }

  reset();
  updateCamera(0, true);
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
      setKnife(k: KnifeId) {
        knifeSelect.value = k;
        knifeSelect.dispatchEvent(new Event('change'));
      },
      setOpponent(o: Opponent) {
        opponentSelect.value = o;
        opponentSelect.dispatchEvent(new Event('change'));
      },
      place: (x: number, z: number) => placeMark([x, z]),
      /** Расставить метки за людей так же, как бот. */
      autoPlace() {
        for (let guard = 0; phase === 'place' && guard < 10; guard++) {
          const ms = botPlaceMarks(regions[cur], cur, stands[cur], marks);
          if (!ms.length) break;
          for (const m of ms) placeMark(m.c);
        }
      },
      /** Бросок за текущего игрока так, как бросил бы бот. */
      botThrow(level: BotLevel = 'medium') {
        if (phase !== 'aim') return ;
        if (pendingTimer !== undefined) clearTimeout(pendingTimer);
        pendingTimer = undefined;
        aimAsBot(level);
        return 'thrown';
      },
      /** Прокрутить симуляцию без requestAnimationFrame (когда вкладка не рисуется). */
      simulate(seconds: number) {
        let now = performance.now() / 1000;
        for (let t = 0; t < seconds; t += 1 / 60) update((now += 1 / 60), 1 / 60);
        drawTrail(now);
        renderer.render(scene, camera);
      },
      /** Сразу выполнить отложенное действие (смена хода, бросок бота). */
      flush() {
        if (pendingTimer === undefined) return false;
        clearTimeout(pendingTimer);
        pendingTimer = undefined;
        if (phase === 'aim' && isBot(cur)) botThrow();
        else if (phase === 'wait') nextTurn();
        return true;
      },
      get state() {
        return {
          phase, cur, opponent, knives, areas: regions.map(regionArea), message: msgEl.textContent, info: infoEl.textContent,
          stands, marks, cracks: cracks.length, flashes: flashes.length, camera: camera.position.toArray(), look: camLook.toArray(),
        };
      },
    };
  }
}

// ---------- Вспомогательное ----------
function gauss(): number {
  const u = 1 - Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
}

function load<T extends string>(key: string, ok: (v: string) => boolean, def: T): T {
  try {
    const v = localStorage.getItem(key);
    if (v && ok(v)) return v as T;
  } catch { /* хранилище недоступно */ }
  return def;
}

function save(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch { /* хранилище недоступно */ }
}

const loadKnife = () => load<KnifeId>('knives.knife', (v) => v in KNIVES, 'easy');
const saveKnife = (k: KnifeId) => save('knives.knife', k);
const loadOpponent = () => load<Opponent>('knives.opponent', (v) => v === 'human' || v in BOT_LEVELS, 'medium');
const saveOpponent = (o: Opponent) => save('knives.opponent', o);

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
