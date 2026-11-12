import './style.css';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  circlePolygon, halfPlane, intersect, union, difference, components, regionArea, pointInRegion, largestInscribed,
  distToBoundary,
  type Region, type Vec2,
} from './geometry';
import {
  createNeedleMesh, createKnifeBody, planRelease, landingTime,
  TIP_LOCAL, GRIP_LOCAL, HULL_POINTS_LOCAL, HELD_TIP_ANGLE, type KnifeBody, type Release, type NeedleKind,
} from './knife';
import {
  createRug, createCat, createPaw, createYarnBall, threadMesh, floorMaterial, createRoom, ROOM_COLOR, PAW_FIT,
} from './look';
import { loadModels } from './assets';
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
/** Цвет кота-игрока: им тонируется его половина половика (рыжий — тёплая охра, серый — холодный серо-синий). */
const COLORS = [0xe39b3c, 0x6e8fb3];
const NAMES = ['Рыжий', 'Серый'];
/** Нитка по границе территорий и нитка разреза. */
const BORDER_COLOR = 0xd8262c;
const CUT_COLOR = 0xf3ead8;
/**
 * Камера «из-за плеча»: выше и позади точки броска. Бросок по-прежнему летит из руки на высоте EYE_HEIGHT,
 * камера только показывает. Наклон и расстояние подобраны так, чтобы половик целиком влезал по ширине
 * и чужая половина читалась не хуже своей.
 */
const CAM = {
  height: 1.55, // высота камеры, м (чуть выше глаз кота, вставшего на задние лапы)
  back: 0.7, // насколько камера позади кота, м
  ahead: 0.6, // куда смотрим: доля пути от себя до соперника
  onRug: 0.95, // камера не дальше этой доли радиуса от центра — «стоим на половике»
  fovPortrait: 72,
  portraitLookAhead: 0.55, // на телефоне взгляд дальше точки, от которой строится камера, м
  fovLandscape: 52,
  fovWide: 60,
};
const CIRCLE_AREA = Math.PI * CIRCLE_R * CIRCLE_R;
const BOT = 1; // бот играет за красных
const KNIVES_PER_PLAYER = 5; // сколько ножей у каждого в начале партии
const WALK_SPEED = 0.8; // м/с, шаг по своей земле
const RUN_SPEED = 1.8; // м/с, перебежка по тапу
const TAP_MAX = 0.025; // жест короче этого (в высотах экрана) — тап, а не бросок
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
  owner: number;
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

/** Нож, оставшийся на поле: воткнулся или упал. */
interface FieldKnife {
  owner: number;
  mesh: THREE.Group;
  pos: Vec2;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const UP = new THREE.Vector3(0, 1, 0);

async function main() {
  const loadingEl = $('message');
  loadingEl.textContent = 'Загрузка…';
  await Promise.all([
    RAPIER.init(),
    loadModels((done, total) => (loadingEl.textContent = `Загрузка… ${done} из ${total}`)),
  ]);
  loadingEl.textContent = '';

  // ---------- Рендер ----------
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  $('app').appendChild(renderer.domElement);
  const canvas = renderer.domElement;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(ROOM_COLOR);
  scene.fog = new THREE.Fog(ROOM_COLOR, 14, 40);

  const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.02, 100);
  scene.add(camera); // нужно, чтобы лапа со спицей (дочерний объект камеры) рисовалась

  // Ровный дневной свет из окна, без «золотого часа».
  scene.add(new THREE.HemisphereLight(0xfff4e2, 0x6a4a35, 1.25));
  const sun = new THREE.DirectionalLight(0xfff1dc, 1.7);
  sun.position.set(-3, 6, 2.5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -4, right: 4, top: 4, bottom: -4, near: 0.5, far: 20 });
  sun.shadow.camera.updateProjectionMatrix();
  scene.add(sun);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(40, 40),
    floorMaterial(40),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  scene.add(createRug(CIRCLE_R), createRoom());

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
  /** Ножи в руке у каждого и ножи, лежащие на поле. */
  const inHand = [KNIVES_PER_PLAYER, KNIVES_PER_PLAYER];
  let field: FieldKnife[] = [];
  const stands: Vec2[] = [[0, 0], [0, 0]];
  let pendingTimer: number | undefined;
  let gesture: Sample[] = [];
  let trail: Sample[] = [];
  let clock = 0; // игровое время, с
  /** Сколько внутренних рёбер своей земли оказались не границей (швы, «усики») — для отладки. */
  let seams = 0;
  /** Обзор сверху во время своего хода: видно всю свою землю, тап — перебежать. */
  let overviewMode = false;
  /** Куда перебегает кот после тапа. */
  let moveTo: Vec2 | null = null;

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

  const figures = COLORS.map((c, i) => createFigure(c, i));
  figures.forEach((f) => scene.add(f.group));

  // Спица в лапе: лапа держит её у острия, спица висит остриём вниз.
  const hand = new THREE.Group();
  let heldKnife = new THREE.Group();
  let heldKey = '';
  let paws = [createPaw(0), createPaw(1)];
  paws.forEach((p) => hand.add(p));
  camera.add(hand);
  /** Пересобрать лапы (после подгонки PAW_FIT в отладке). */
  function rebuildPaws() {
    paws.forEach((p) => hand.remove(p));
    paws = [createPaw(0), createPaw(1)];
    paws.forEach((p) => hand.add(p));
    heldKey = '';
    updateHeld();
  }

  /** Какая спица у игрока: лёгкие ножи — бамбуковые, тяжёлые — металлические. */
  const needleKind = (p: number): NeedleKind => (knifeOf(p).assist >= 0.7 ? 'bamboo' : 'metal');
  const needleMesh = (p: number) => createNeedleMesh(needleKind(p), COLORS[p]);

  /** Обновить спицу и окрас лапы под того, чьими глазами смотрим. */
  function updateHeld() {
    const p = viewer();
    const key = `${p}:${needleKind(p)}`;
    paws.forEach((paw, i) => (paw.visible = i === p));
    if (key === heldKey) return;
    heldKey = key;
    hand.remove(heldKnife);
    disposeObject(heldKnife);
    heldKnife = createNeedleMesh(needleKind(p), COLORS[p], 0.014); // вблизи шарик меньше
    heldKnife.position.copy(GRIP_LOCAL).multiplyScalar(-1);
    heldKnife.scale.set(0.6, 1, 0.6); // вблизи спица не должна выглядеть палкой
    hand.add(heldKnife);
  }

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
    for (let i = 0; i < 2; i++)
      $(`score${i}`).textContent = `${Math.round((regionArea(regions[i]) / CIRCLE_AREA) * 100)}% · ножей ${inHand[i]}`;
    const myTurn = phase === 'aim' && !isBot(cur);
    $('overview').hidden = !myTurn;
    $('overview').textContent = overviewMode ? 'Назад' : 'Обзор';
    const canCollect = myTurn ? pickable(cur).length : 0;
    $('collect').hidden = !canCollect;
    $('collect').textContent = `Собрать ножи (${canCollect})`;
    knifeSelect.value = knives[selectedPlayer()];
    const k = knifeOf(cur);
    $('hint').innerHTML = phase === 'place'
      ? `Нажми на свою землю, чтобы поставить метку: первая — прочность 1, вторая — 2, третья — 3. ` +
        `Кусок под целой меткой не отрезать: вместо этого метка теряет прочность.`
      : `<b>Рывок вверх</b>: длина — дальность, резкость — закрутка (нужен один оборот), вбок — направление · ` +
        `<b>Тап по своей земле</b> — перебежать, <b>«Обзор»</b> — вся земля сверху, <b>вбок</b> — осмотреться · ` +
        `<b>Правая кнопка</b> — осмотреться, <b>WASD</b> — шаг · ` +
        `Нож, не отрезавший землю, остаётся в поле; ножи на земле соперника не забрать, пока не отрежешь её · <b>${k.label}</b>: помощь ${Math.round(k.assist * 100)}%, ` +
        `урон по метке ${k.damage}, шатание ±${k.wobble}°`;
    updateHeld();
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

  /** Тап по экрану: если попали в свою землю, где можно сидеть, — кот перебегает туда. */
  function tryMoveTo(clientX: number, clientY: number): boolean {
    if (phase !== 'aim' || isBot(cur)) return false;
    const g = groundPoint(clientX, clientY);
    if (!g) return false;
    const p: Vec2 = [g.x, g.z];
    if (!pointInRegion(p, regions[cur])) return false;
    if (!canStand(p, regions[cur])) {
      setMessage('Здесь не сесть — слишком близко к краю');
      return true;
    }
    moveTo = p;
    return true;
  }

  /** Перебежка по прямой; упёрлись в край своей земли — остановились. */
  function stepMove(dt: number) {
    if (!moveTo) return;
    if (phase !== 'aim' && phase !== 'gesture') {
      moveTo = null;
      return;
    }
    const [x, z] = stands[cur];
    const dx = moveTo[0] - x;
    const dz = moveTo[1] - z;
    const d = Math.hypot(dx, dz);
    const step = Math.min(d, RUN_SPEED * dt);
    const next: Vec2 = d < 1e-4 ? moveTo : [x + (dx / d) * step, z + (dz / d) * step];
    if (!canStand(next, regions[cur])) {
      moveTo = null;
      return;
    }
    stands[cur] = next;
    figures[cur].group.position.set(next[0], 0, next[1]);
    figures[cur].group.lookAt(stands[1 - cur][0], 0, stands[1 - cur][1]);
    lastManual = clock;
    if (step >= d) moveTo = null;
  }

  function setOverview(on: boolean) {
    overviewMode = on && phase === 'aim' && !isBot(cur);
    updateHud();
  }

  function rebuildTerritories() {
    for (let i = 0; i < 2; i++) {
      clearGroup(territoryGroups[i]);
      territoryGroups[i].add(regionMesh(regions[i], COLORS[i], 0.32, 0.007));
      // Игрок остаётся, где стоял, если там ещё есть место; иначе — на самое просторное место.
      if (!canStand(stands[i], regions[i])) stands[i] = largestInscribed(regions[i]).center;
      figures[i].group.position.set(stands[i][0], 0, stands[i][1]);
    }
    figures[0].group.lookAt(stands[1][0], 0, stands[1][1]);
    figures[1].group.lookAt(stands[0][0], 0, stands[0][1]);
    territoryGroups[0].add(threadMesh(borderSegments().map(([a, b]) => [
      new THREE.Vector3(a[0], 0.014, a[1]), new THREE.Vector3(b[0], 0.014, b[1]),
    ]), BORDER_COLOR, 0.016, true));
    updateHud();
  }

  /**
   * Где лежит красная нитка: только там, где по разные стороны — земли разных котов.
   * Просто брать все стороны многоугольников нельзя: после объединения кусков в них бывают
   * швы между своими же кусками и «усики» (ребро туда и обратно) — нитка ложилась поперёк своей земли.
   */
  function borderSegments(): [Vec2, Vec2][] {
    const out: [Vec2, Vec2][] = [];
    const EPS = 0.006;
    seams = 0;
    for (const poly of regions[0])
      for (const ring of poly)
        for (let k = 0; k + 1 < ring.length; k++) {
          const a = ring[k];
          const b = ring[k + 1];
          const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
          if (len < 1e-4) continue;
          const m: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
          if (Math.hypot(m[0], m[1]) > CIRCLE_R - 0.02) continue; // край половика
          // Пробуем по точке с каждой стороны ребра.
          const n: Vec2 = [-(b[1] - a[1]) / len * EPS, (b[0] - a[0]) / len * EPS];
          const l: Vec2 = [m[0] + n[0], m[1] + n[1]];
          const r: Vec2 = [m[0] - n[0], m[1] - n[1]];
          const mixed = (pointInRegion(l, regions[0]) && pointInRegion(r, regions[1])) ||
            (pointInRegion(l, regions[1]) && pointInRegion(r, regions[0]));
          if (mixed) out.push([a, b]);
          else seams++;
        }
    return out;
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
      // Зона защиты — светлое пятно с кольцом цвета владельца.
      const disc = new THREE.Mesh(
        new THREE.CircleGeometry(MARK_R, 48),
        new THREE.MeshBasicMaterial({ color: 0xfff6e0, transparent: true, opacity: 0.18, depthWrite: false }),
      );
      disc.rotation.x = -Math.PI / 2;
      disc.position.y = 0.009;
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(MARK_R - 0.014, MARK_R, 48),
        new THREE.MeshBasicMaterial({ color: COLORS[m.owner], transparent: true, opacity: 0.85, depthWrite: false }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.01;
      // Клубок: чем прочнее метка, тем он больше; при уроне — уменьшается.
      g.add(disc, ring, createYarnBall(m.owner, Math.min(MARK_HP, m.hp)));
      marksGroup.add(g);
    }
  }

  function rebuildCracks() {
    clearGroup(cracksGroup);
    // Воткнутая спица тянет светлую нитку разреза.
    const segs = cracks.map((k): [THREE.Vector3, THREE.Vector3] => [
      new THREE.Vector3(k.a[0], 0.018, k.a[1]),
      new THREE.Vector3(k.b[0], 0.018, k.b[1]),
    ]);
    cracksGroup.add(threadMesh(segs, CUT_COLOR, 0.008));
  }

  // ---------- Камера ----------
  const camPos = new THREE.Vector3(0, 4, 4);
  const camLook = new THREE.Vector3();
  /** Поворот взгляда игрока относительно направления на соперника (правая кнопка мыши). */
  const look = [{ yaw: 0, pitch: 0 }, { yaw: 0, pitch: 0 }];
  /** Поворот взгляда: правой кнопкой (вбок и вверх-вниз) или пальцем вбок (только вбок). */
  let lookDrag: { x: number; y: number; yawOnly?: boolean } | null = null;
  const keys = new Set<string>();
  let lastManual = -1; // когда игрок последний раз крутил камеру или шагал (для отзывчивости камеры)
  const isFirstPerson = () => phase !== 'place' && phase !== 'over' && !overviewMode;

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

  /**
   * Камера «из-за плеча» игрока p: за котом и чуть выше его глаз, на постоянной высоте —
   * кот не может приподняться. Своего кота не видно — только лапа со спицей.
   * Камера всегда над половиком: если сзади мало места, она подходит ближе к коту (но не поднимается).
   * Поворот взгляда (правая кнопка, палец вбок): вбок — кот поворачивается, камера остаётся за ним;
   * вверх-вниз — только наклон головы, камера на месте.
   */
  function shoulderView(p: number) {
    const fp = firstPersonView(p);
    const [x, z] = stands[p];
    const [ox, oz] = stands[1 - p];
    const fwd = new THREE.Vector3(Math.cos(fp.yaw), 0, Math.sin(fp.yaw));
    const back = Math.min(CAM.back, rayToCircle([x, z], [-fwd.x, -fwd.z], CIRCLE_R * CAM.onRug));
    const pos = new THREE.Vector3(x, CAM.height, z).addScaledVector(fwd, -back);
    // Куда смотрим без наклона головы: на точку между собой и соперником
    // (в высоком кадре — дальше: снизу и так много своей земли).
    let ahead = Math.max(0.6, Math.hypot(ox - x, oz - z) * CAM.ahead);
    if (camera.aspect < 1) ahead += CAM.portraitLookAhead;
    const basePitch = Math.atan2(CAM.height, back + ahead);
    const pitch = THREE.MathUtils.clamp(basePitch + look[p].pitch, -0.3, 1.5);
    const dir = fwd.clone().multiplyScalar(Math.cos(pitch)).addScaledVector(UP, -Math.sin(pitch));
    return { pos, look: pos.clone().add(dir) };
  }

  function updateCamera(dt: number, snap = false) {
    const v = isFirstPerson() ? shoulderView(viewer()) : overview();
    const rate = clock - lastManual < 0.25 ? 30 : 5; // свои повороты и шаги — без задержки
    const a = snap ? 1 : 1 - Math.exp(-dt * rate);
    camPos.lerp(v.pos, a);
    camLook.lerp(v.look, a);
    camera.position.copy(camPos);
    camera.lookAt(camLook);
    const settled = camPos.distanceTo(v.pos) < 0.05;
    // Своего кота в кадре нет — только его след на половике.
    figures.forEach((f, i) => (f.body.visible = !(isFirstPerson() && i === viewer())));

    // Лапа со спицей в правом нижнем углу; по ходу рывка лапа отводится назад и вперёд.
    hand.visible = settled && isFirstPerson() && !isBot(cur) && (phase === 'aim' || phase === 'gesture');
    const u = phase === 'gesture' ? Math.min(1, gestureLength() / SWIPE.fullLength) : 0;
    const depth = 0.5;
    const hh = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * depth;
    const hw = hh * camera.aspect;
    hand.position.set(hw * 0.62, -hh * 0.62 + u * 0.05, -depth - u * 0.1);
    hand.scale.setScalar(0.8);
    hand.rotation.set(-(HELD_TIP_ANGLE - u * 0.7), 0, -0.15);
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

  /** Брошенный нож остаётся лежать (или торчать) там, где оказался. */
  function parkKnife() {
    if (!knife) return;
    const t = knife.kb.body.translation();
    world.removeRigidBody(knife.kb.body);
    field.push({ owner: knife.owner, mesh: knife.mesh, pos: [t.x, t.z] });
    knife = null;
  }

  /** Свои ножи, которые можно подобрать: всё, что не на земле соперника. */
  const pickable = (p: number) => field.filter((k) => k.owner === p && !pointInRegion(k.pos, regions[1 - p]));

  function takeBack(list: FieldKnife[]) {
    for (const k of list) {
      scene.remove(k.mesh);
      disposeObject(k.mesh);
      inHand[k.owner]++;
    }
    field = field.filter((k) => !list.includes(k));
  }

  /** Вместо броска собрать свои ножи. */
  function collect() {
    if (phase !== 'aim') return;
    overviewMode = false;
    const list = pickable(cur);
    if (!list.length) return;
    takeBack(list);
    passTurn(`${NAMES[cur]} собирает ножи: +${list.length}`, 1200);
    updateHud();
  }

  function launchRelease(release: Release) {
    removeKnife();
    if (inHand[cur] <= 0) return;
    inHand[cur]--;
    const mesh = needleMesh(cur);
    scene.add(mesh);
    knife = {
      owner: cur,
      kb: createKnifeBody(world, planRelease(release)), mesh, release,
      t0: performance.now() / 1000, simTime: 0, contacted: false, contactTime: 0, stuck: false,
    };
    phase = 'flying';
    updateHud();
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
    const len = gestureLength(samples);
    // Короткое касание без рывка — тап: перебежать по своей земле.
    if (len < TAP_MAX) {
      const last = samples[samples.length - 1];
      if (!tryMoveTo(last.x, last.y)) setMessage('Рывок вверх — бросок, тап по своей земле — перебежать');
      return;
    }
    if (samples.length < 2) return;
    if (inHand[cur] <= 0) {
      setMessage('Спиц в лапе нет — собери свои');
      return;
    }
    const { vx, vy } = releaseVelocity(samples, SWIPE.releaseWindow); // вверх по экрану — вперёд
    const s = Math.hypot(vx, vy);
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
      passTurn(mark.hp > 0 ? `Попал в метку! Осталось прочности: ${mark.hp}` : 'Метка пробита!');
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
        ? `Метка защитила землю, осталось прочности: ${guard.hp}`
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
    // Отрезал — выдернул свой нож; заодно забрал свои ножи, лежавшие на отрезанной земле.
    removeKnife();
    inHand[cur]++;
    const found = field.filter((k) => k.owner === cur && captured.some((piece) => pointInRegion(k.pos, piece)));
    takeBack(found);
    updateHud();
    const extra = found.length ? ` и ещё +${found.length}` : '';
    passTurn(`Отрезал ${Math.round((gained / CIRCLE_AREA) * 100)}% круга! Нож вернулся${extra}`, 2000);
  }

  function nextTurn() {
    pendingTimer = undefined;
    parkKnife();
    cracks = [];
    rebuildCracks();
    cur = 1 - cur;
    phase = 'aim';
    overviewMode = false;
    moveTo = null;
    updateHud();
    if (inHand[cur] === 0 && !pickable(cur).length) {
      gameOver(1 - cur, `У игрока ${NAMES[cur]} кончились ножи`);
      return;
    }
    setMessage(inHand[cur] === 0 && !isBot(cur)
      ? 'Ножи кончились — нажми «Собрать ножи»'
      : `Бросает ${NAMES[cur]}`);
    if (isBot(cur)) pendingTimer = window.setTimeout(botThrow, 1400);
  }

  function gameOver(winner: number, reason = '') {
    phase = 'over';
    setMessage(reason);
    const why = reason ? ` ${reason}.` : '';
    $('overlay-title').textContent = `Победил ${NAMES[winner]}${isBot(winner) ? ' (бот)' : ''}!${why}`;
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
    setMessage(`${NAMES[p]}: поставь метки на свою землю — первая с прочностью 1`);
  }

  function placeMark(c: Vec2): boolean {
    if (phase !== 'place' || !canPlaceMark(c, regions[cur], marks)) return false;
    const placed = marks.filter((m) => m.owner === cur).length;
    marks.push({ owner: cur, c, hp: Math.min(MARK_HP, placed + 1) }); // первая — 1, вторая — 2, третья — 3
    rebuildMarks();
    const left = MARKS_PER_PLAYER - placed - 1;
    if (left > 0) setMessage(`${NAMES[cur]}: следующая метка — прочность ${placed + 2}`);
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
    // Нечем бросать или последний нож, а подобрать можно несколько — собирает.
    const pk = pickable(cur).length;
    if (inHand[cur] === 0 || (inHand[cur] === 1 && pk >= 2)) {
      collect();
      return;
    }
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
    takeBack(field);
    inHand[0] = inHand[1] = KNIVES_PER_PLAYER;
    regions = initialRegions();
    stands[0] = [0, 0];
    stands[1] = [0, 0];
    for (const l of look) l.yaw = l.pitch = 0;
    marks = [];
    cracks = [];
    gesture = [];
    overviewMode = false;
    moveTo = null;
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
    if (overviewMode) {
      // В обзоре тап только выбирает, куда перебежать.
      if (tryMoveTo(ev.clientX, ev.clientY)) setOverview(false);
      else setMessage('Тапни по своей земле — кот перебежит туда');
      return;
    }
    phase = 'gesture';
    gesture = [];
    trail = [];
    gestureKind = 'undecided';
    addSample(ev);
    canvas.setPointerCapture(ev.pointerId);
  });

  /**
   * Что за жест: решаем по первым пикселям движения. В основном вбок — осмотреться (поворот взгляда),
   * иначе — бросок (рывок вверх; его отклонение вбок задаёт направление броска).
   */
  let gestureKind: 'undecided' | 'throw' = 'undecided';
  const GESTURE_DECIDE_PX = 12;
  function classifyGesture(ev: PointerEvent): boolean {
    if (gestureKind !== 'undecided' || !gesture.length) return false;
    const dx = ev.clientX - gesture[0].x;
    const dy = ev.clientY - gesture[0].y;
    if (Math.hypot(dx, dy) < GESTURE_DECIDE_PX) return false;
    if (Math.abs(dx) > 1.3 * Math.abs(dy)) {
      phase = 'aim';
      gesture = [];
      trail = [];
      lookDrag = { x: ev.clientX, y: ev.clientY, yawOnly: true };
      return true;
    }
    gestureKind = 'throw';
    return false;
  }
  canvas.addEventListener('pointermove', (ev) => {
    if (lookDrag) {
      const l = look[viewer()];
      l.yaw += (ev.clientX - lookDrag.x) * LOOK_SENS;
      if (!lookDrag.yawOnly) l.pitch = THREE.MathUtils.clamp(l.pitch + (ev.clientY - lookDrag.y) * LOOK_SENS, -1.2, 0.9);
      lookDrag = { ...lookDrag, x: ev.clientX, y: ev.clientY };
      lastManual = clock;
      return;
    }
    if (!ev.isPrimary) return;
    if (phase === 'gesture' && classifyGesture(ev)) return;
    if (phase === 'gesture') {
      const coalesced = ev.getCoalescedEvents?.() ?? [];
      for (const e of coalesced.length ? coalesced : [ev]) addSample(e);
    }
    hoverGhost(ev.clientX, ev.clientY);
  });
  canvas.addEventListener('pointerup', (ev) => {
    if (ev.button === 2 || (lookDrag?.yawOnly && ev.isPrimary)) {
      lookDrag = null;
      return;
    }
    if (!ev.isPrimary || ev.button !== 0 || phase !== 'gesture') return;
    addSample(ev);
    finishSwipe();
  });
  canvas.addEventListener('pointercancel', () => {
    if (lookDrag?.yawOnly) lookDrag = null;
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
  $('collect').addEventListener('click', collect);
  $('overview').addEventListener('click', (e) => {
    setOverview(!overviewMode);
    (e.currentTarget as HTMLElement).blur();
  });
  $('overlay-restart').addEventListener('click', reset);
  // Для сравнения можно играть и вертикально — подсказку «поверни телефон» убираем до перезагрузки.
  $('rotate-skip').addEventListener('click', () => document.body.classList.add('allow-portrait'));

  function resize() {
    camera.aspect = innerWidth / innerHeight;
    // В узком вертикальном кадре чуть шире угол, чтобы половик не уезжал вдаль.
    // На очень широком (телефон горизонтально) — тоже чуть шире, иначе кот-соперник упирается в верх кадра.
    camera.fov = camera.aspect < 1 ? CAM.fovPortrait : camera.aspect > 1.9 ? CAM.fovWide : CAM.fovLandscape;
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
    stepMove(dt);
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
      collect,
      /** Подогнать модель лапы: paw({ size, arm: [x, y, z], hole: [x, y, z], flip }). */
      paw(fit: { size?: number; arm?: number[]; hole?: number[]; flip?: boolean }) {
        if (fit.size !== undefined) PAW_FIT.size = fit.size;
        if (fit.arm) PAW_FIT.arm.fromArray(fit.arm);
        if (fit.hole) PAW_FIT.hole.fromArray(fit.hole);
        if (fit.flip !== undefined) PAW_FIT.flip = fit.flip;
        rebuildPaws();
        return { ...PAW_FIT, arm: PAW_FIT.arm.toArray(), hole: PAW_FIT.hole.toArray() };
      },
      /** Где на экране (в CSS-пикселях) точка поля x, z на высоте y. */
      project(x: number, z: number, y = 0) {
        const v = new THREE.Vector3(x, y, z).project(camera);
        return [Math.round((v.x + 1) / 2 * innerWidth), Math.round((1 - v.y) / 2 * innerHeight)];
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
          stands, marks, seams, regions, cracks: cracks.length, inHand, field: field.map((k) => ({ owner: k.owner, pos: k.pos })), flashes: flashes.length, camera: camera.position.toArray(), look: camLook.toArray(),
        };
      },
    };
  }
}

// ---------- Вспомогательное ----------
/** Расстояние от точки p (внутри круга радиуса r с центром в 0) по направлению d (единичному) до края круга. */
function rayToCircle(p: Vec2, d: Vec2, r: number): number {
  const b = p[0] * d[0] + p[1] * d[1];
  const c = p[0] * p[0] + p[1] * p[1] - r * r;
  return Math.max(0, -b + Math.sqrt(Math.max(0, b * b - c)));
}

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

/** Тонировка территории поверх половика (без контуров: границу показывает нитка). */
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
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = y;
  group.add(mesh);
  return group;
}

/** Кот игрока (0 — рыжий, 1 — серый) и кольцо: сколько места ему нужно, чтобы сидеть. */
function createFigure(color: number, coat: number) {
  const { group, body } = createCat(coat);
  const footRing = new THREE.Mesh(
    new THREE.RingGeometry(FOOT_R - 0.01, FOOT_R, 40),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7 }),
  );
  footRing.rotation.x = -Math.PI / 2;
  footRing.position.y = 0.012;
  group.add(footRing);
  return { group, body };
}

function disposeObject(obj: THREE.Object3D) {
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.userData.shared) return; // копия загруженной модели: геометрия и материал общие
    m.geometry?.dispose();
    const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
    mats.forEach((x) => !x.userData.keep && x.dispose()); // keep — общий кэшированный материал
  });
}

function clearGroup(g: THREE.Group) {
  for (const child of [...g.children]) {
    g.remove(child);
    disposeObject(child);
  }
}

main();
