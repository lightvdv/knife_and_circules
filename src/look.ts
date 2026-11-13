// Внешний вид сеттинга «Бабушкин половик»: комната, плетёный половик, валяные коты, лапа, клубки, нитки.
// Половик, коты, лапа, клубки и мебель — GLB-модели из 3D AI Studio (src/assets.ts);
// если модель не загрузилась, рисуется процедурная замена из простых форм.
// Пол, обои и нитка — текстуры материалов из того же сервиса (public/textures).
// Правила и физика отсюда не зависят: это только то, как всё выглядит.
import * as THREE from 'three';
import { fitModel, rawModel, baseMaterial, tintedMaterial, setMaterial } from './assets';

/**
 * Масштаб: игровые единицы на настоящий метр. Половик (радиус 1,5) при M = 1,8 — около 1,7 м
 * в поперечнике: большой бабушкин половик, на котором коты маленькие.
 */
const M = 1.8;
/** Высота сидящего кота (≈ 0,29 м по-настоящему; кот на четырёх лапах). */
export const CAT_HEIGHT = 0.29 * M;

// ---------- Текстуры из файлов ----------
const texLoader = new THREE.TextureLoader();
const texCache = new Map<string, THREE.Texture>();
/** Текстура из public/textures; color — цветовая (sRGB), иначе карта нормалей и т. п. */
function fileTexture(name: string, color: boolean, repeat?: [number, number]): THREE.Texture {
  const key = `${name}:${repeat?.join('x') ?? ''}`;
  let t = texCache.get(key);
  if (!t) {
    t = texLoader.load(`${import.meta.env.BASE_URL}textures/${name}.jpg`);
    if (color) t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    if (repeat) t.repeat.set(...repeat);
    texCache.set(key, t);
  }
  return t;
}

// ---------- Палитра ----------
/** Приглушённые цвета лоскутов половика. */
const RAG_COLORS = ['#b89a6e', '#8c9a7a', '#cdbfa5', '#9a6b52', '#7d8a99', '#a88f6a', '#6f7a63', '#c4a98a'];
/** Пол: крашеные доски «как у бабушки» (красно-коричневая половая краска). */
const FLOOR_COLOR = '#6a3c29';
export const ROOM_COLOR = 0xd8c9ad;
/** Яркие клубки — по цвету кота-владельца. */
export const YARN_COLORS = [0xf0a23a, 0x4f86c6];
/** Окрас котов: рыжий и серый полосатый. */
const CAT_COATS = [
  { base: '#d98a3d', stripe: '#a85a22', belly: 0xf3e2c8 },
  { base: '#8f949a', stripe: '#4f545a', belly: 0xe9e6df },
];

// ---------- Текстуры ----------
function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Случайное число с фиксированным зерном — чтобы половик всегда был один и тот же. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

/** Мелкая «шерстяная» неровность: светлый шум, умножается на цвет материала. */
let feltNoise: THREE.CanvasTexture | null = null;
function feltTexture(): THREE.CanvasTexture {
  if (feltNoise) return feltNoise;
  const rand = rng(7);
  feltNoise = canvasTexture(256, 256, (g) => {
    g.fillStyle = '#e8e8e8';
    g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 2600; i++) {
      const v = 190 + rand() * 65;
      g.strokeStyle = `rgba(${v},${v},${v},0.55)`;
      g.lineWidth = 0.6 + rand();
      const x = rand() * 256;
      const y = rand() * 256;
      const a = rand() * Math.PI * 2;
      const l = 2 + rand() * 5;
      g.beginPath();
      g.moveTo(x, y);
      g.quadraticCurveTo(x + Math.cos(a + 1) * l, y + Math.sin(a + 1) * l, x + Math.cos(a) * l * 1.6, y + Math.sin(a) * l * 1.6);
      g.stroke();
    }
  });
  feltNoise.wrapS = feltNoise.wrapT = THREE.RepeatWrapping;
  return feltNoise;
}

/** Материал «валяная шерсть»: матовый, с мягким бархатным отливом по краям. */
export function feltMaterial(color: THREE.ColorRepresentation, map?: THREE.Texture): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color, map: map ?? feltTexture(), roughness: 1, metalness: 0,
    sheen: 1, sheenRoughness: 0.6, sheenColor: new THREE.Color(0xffffff).lerp(new THREE.Color(color), 0.4),
  });
}

/** Пол из крашеных досок: материал из сервиса (цвет + нормали); size — сторона плоскости пола. */
export function floorMaterial(size: number): THREE.MeshLambertMaterial {
  const rep = (3 * size) / (2 * ROOM_HALF); // 3 картины на комнату: доски ≈ 17 см
  const map = fileTexture('floor_paint', true, [rep, rep]);
  map.offset.set(0.5 - rep / 2, 0.5 - rep / 2);
  return new THREE.MeshLambertMaterial({ map, color: 0x8f786c }); // пол — фон, приглушаем
}

/** Пол из крашеных досок (процедурный, прежний вариант). */
export function floorTexture(): THREE.Texture {
  const rand = rng(11);
  const t = canvasTexture(512, 512, (g) => {
    const plank = 64;
    for (let i = 0; i < 512 / plank; i++) {
      const shade = 0.88 + rand() * 0.2;
      const base = new THREE.Color(FLOOR_COLOR).multiplyScalar(shade);
      g.fillStyle = `#${base.getHexString()}`;
      g.fillRect(i * plank, 0, plank, 512);
      // Протёртости краски и волокна дерева вдоль доски.
      for (let k = 0; k < 40; k++) {
        g.strokeStyle = `rgba(${rand() < 0.5 ? '40,18,8' : '170,110,70'},${0.05 + rand() * 0.08})`;
        g.lineWidth = 1 + rand() * 2;
        const x = i * plank + 4 + rand() * (plank - 8);
        g.beginPath();
        g.moveTo(x, 0);
        g.bezierCurveTo(x + rand() * 6 - 3, 170, x + rand() * 6 - 3, 340, x + rand() * 4 - 2, 512);
        g.stroke();
      }
      // Стык досок.
      g.fillStyle = 'rgba(30,12,4,0.65)';
      g.fillRect(i * plank, 0, 2, 512);
      // Поперечный стык в случайном месте.
      const y = rand() * 512;
      g.fillRect(i * plank, y, plank, 2);
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(8, 8);
  return t;
}

/**
 * Плетёный тряпичный половик: концентрические косички из лоскутов.
 * Рисуется на квадратной текстуре, центр — центр половика.
 */
export function rugTexture(): THREE.Texture {
  const rand = rng(23);
  const S = 1024;
  return canvasTexture(S, S, (g) => {
    const c = S / 2;
    g.fillStyle = '#6b5a45';
    g.fillRect(0, 0, S, S);
    const ring = 15; // ширина косички, px
    let color = RAG_COLORS[0];
    let left = 0;
    for (let r = ring / 2, idx = 0; r < c; r += ring, idx++) {
      // Лоскут одного цвета идёт 1–3 витка, потом меняется.
      if (left-- <= 0) {
        color = RAG_COLORS[Math.floor(rand() * RAG_COLORS.length)];
        left = 1 + Math.floor(rand() * 3);
      }
      const n = Math.max(8, Math.floor((2 * Math.PI * r) / 9));
      const base = new THREE.Color(color);
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2 + idx * 0.37;
        const x = c + Math.cos(a) * r;
        const y = c + Math.sin(a) * r;
        const tint = base.clone().multiplyScalar(0.85 + rand() * 0.3);
        g.save();
        g.translate(x, y);
        // Косичка: «ёлочка» из наклонённых петель, чередующихся влево-вправо.
        g.rotate(a + Math.PI / 2 + (k % 2 ? 0.55 : -0.55));
        g.fillStyle = `#${tint.getHexString()}`;
        g.beginPath();
        g.ellipse(0, 0, 7.5, 4.2, 0, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = 'rgba(40,28,18,0.35)';
        g.lineWidth = 1.1;
        g.stroke();
        g.restore();
      }
    }
  });
}

/** Обмотка клубка: много перекрещивающихся нитей. Одна текстура на цвет. */
const yarnCache = new Map<number, THREE.Texture>();
function yarnTexture(color: number): THREE.Texture {
  let t = yarnCache.get(color);
  if (!t) yarnCache.set(color, (t = drawYarn(color)));
  return t;
}
function drawYarn(color: number): THREE.Texture {
  const rand = rng(color);
  const base = new THREE.Color(color);
  return canvasTexture(256, 128, (g) => {
    g.fillStyle = `#${base.clone().multiplyScalar(0.75).getHexString()}`;
    g.fillRect(0, 0, 256, 128);
    for (let layer = 0; layer < 3; layer++) {
      const tilt = (rand() - 0.5) * 1.6;
      for (let i = 0; i < 26; i++) {
        const y0 = rand() * 128;
        g.strokeStyle = `#${base.clone().multiplyScalar(0.8 + rand() * 0.45).getHexString()}`;
        g.lineWidth = 2 + rand() * 1.5;
        g.beginPath();
        for (let x = 0; x <= 256; x += 8) {
          const y = y0 + Math.sin((x / 256) * Math.PI * 2 + layer) * 18 * tilt + (x / 256) * 30 * tilt;
          if (x === 0) g.moveTo(x, y);
          else g.lineTo(x, y);
        }
        g.stroke();
      }
    }
  });
}

/** Полосы «табби» по бокам кота (на сфере полосы идут меридианами). */
function tabbyTexture(base: string, stripe: string): THREE.Texture {
  const rand = rng(base.length * 97 + stripe.charCodeAt(1));
  return canvasTexture(256, 128, (g) => {
    g.fillStyle = base;
    g.fillRect(0, 0, 256, 128);
    g.strokeStyle = stripe;
    g.globalAlpha = 0.7;
    for (let i = 0; i < 14; i++) {
      const x0 = (i / 14) * 256 + rand() * 6;
      g.lineWidth = 4 + rand() * 4;
      g.beginPath();
      g.moveTo(x0, 8);
      g.bezierCurveTo(x0 + rand() * 14 - 7, 40, x0 + rand() * 14 - 7, 80, x0 + rand() * 8 - 4, 118);
      g.stroke();
    }
    // Шерстяной шум поверх.
    g.globalAlpha = 1;
    for (let i = 0; i < 1500; i++) {
      g.fillStyle = `rgba(255,255,255,${rand() * 0.08})`;
      g.fillRect(rand() * 256, rand() * 128, 2, 1);
    }
  });
}

// ---------- Объекты ----------

/** Верх половика: тонировка земель и нитки лежат выше (0,007 и больше). */
const RUG_TOP = 0.005;

/**
 * Половик: тонкий диск с фото настоящего плетёного половика сверху (public/textures/rug_top.jpg)
 * и тёмным краем. Если фото не загрузится — процедурная текстура косичек.
 */
export function createRug(radius: number): THREE.Group {
  const group = new THREE.Group();
  const photo = texLoader.load(`${import.meta.env.BASE_URL}textures/rug_top.jpg`);
  photo.colorSpace = THREE.SRGBColorSpace;
  photo.anisotropy = 8;
  // Круг на фото чуть меньше кадра — берём середину, чтобы на краю не было белого фона.
  photo.repeat.set(0.965, 0.965);
  photo.offset.set(0.0175, 0.0175);
  const disc = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius * 1.01, RUG_TOP, 128, 1),
    [
      new THREE.MeshStandardMaterial({ color: 0x7d6a55, roughness: 1 }), // бок
      new THREE.MeshStandardMaterial({ map: photo, color: 0xe2d8ca, roughness: 1 }), // верх
      new THREE.MeshStandardMaterial({ color: 0x7d6a55, roughness: 1 }), // низ
    ],
  );
  // У цилиндра UV верхней крышки — квадрат вокруг круга, как у CircleGeometry.
  disc.position.y = RUG_TOP / 2;
  disc.receiveShadow = true;
  group.add(disc);
  return group;
}

/** Прежний процедурный половик (запасной вариант). */
export function createRugProcedural(radius: number): THREE.Group {
  const group = new THREE.Group();
  const top = new THREE.Mesh(
    new THREE.CircleGeometry(radius, 128),
    new THREE.MeshStandardMaterial({ map: rugTexture(), roughness: 1 }),
  );
  top.rotation.x = -Math.PI / 2;
  top.position.y = 0.004;
  top.receiveShadow = true;
  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(radius, 0.018, 8, 128),
    feltMaterial(0x6b5a45),
  );
  rim.rotation.x = -Math.PI / 2;
  rim.position.y = 0.006;
  rim.receiveShadow = true;
  group.add(top, rim);
  return group;
}

/** Шерстяная нитка по ломаной: цилиндры по отрезкам и шарики на стыках. */
/**
 * Материал шерстяной нитки. Текстура — снимок скрученной красной нитки на сером фоне:
 * берём только полосу с ниткой (см. threadUVs). Красная — как есть, другие — обесцвеченная и перекрашенная.
 */
const threadMats = new Map<number, THREE.MeshStandardMaterial>();
function threadMaterial(color: number, red: boolean): THREE.MeshStandardMaterial {
  let m = threadMats.get(color);
  if (!m) {
    const base = new THREE.MeshStandardMaterial({
      map: fileTexture('thread_color', true),
      normalMap: fileTexture('thread_normal', false),
      roughness: 1,
    });
    m = red ? base : tintedMaterial(base, new THREE.Color(color).multiplyScalar(2.2), 1);
    m.userData.keep = true; // общий на все нитки — не освобождать при пересборке
    threadMats.set(color, m);
  }
  return m;
}

/** UV цилиндра нитки: вдоль нитки — повтор каждые 6 радиусов, по кругу — полоса снимка, где нитка. */
function threadUVs(geo: THREE.CylinderGeometry, len: number, r: number) {
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    const around = uv.getX(i);
    const along = uv.getY(i);
    // Без шва по кругу: туда и обратно по полосе 0,36…0,64.
    uv.setXY(i, (along * len) / (6 * r), 0.36 + 0.28 * Math.abs(2 * around - 1));
  }
  uv.needsUpdate = true;
}

export function threadMesh(
  segments: [THREE.Vector3, THREE.Vector3][], color: number, r: number, red = false,
): THREE.Group {
  const group = new THREE.Group();
  const mat = threadMaterial(color, red);
  const joint = new THREE.SphereGeometry(r, 10, 8);
  for (const [a, b] of segments) {
    const len = a.distanceTo(b);
    if (len < 1e-4) continue;
    const geo = new THREE.CylinderGeometry(r, r, len, 8, 1, true);
    threadUVs(geo, len, r);
    const m = new THREE.Mesh(geo, mat);
    m.position.copy(a).add(b).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    m.castShadow = true;
    group.add(m);
    for (const p of [a, b]) {
      const j = new THREE.Mesh(joint, mat);
      j.position.copy(p);
      group.add(j);
    }
  }
  return group;
}

/** Клубок: размер — прочность метки (1 — маленький, 3 — большой), с хвостиком нитки. */
/** Клубок-модель кремовый — перекрашиваем в цвет владельца (материал общий на всех клубков игрока). */
const yarnMats: THREE.Material[] = [];

export function createYarnBall(owner: number, hp: number): THREE.Group {
  const r = [0, 0.05, 0.07, 0.09][hp] ?? 0.09;
  const color = YARN_COLORS[owner];
  const model = fitModel('yarn', { height: 2 * r, rotY: hp * 1.3 + owner * 0.7 });
  const base = baseMaterial('yarn');
  if (model && base) {
    yarnMats[owner] ??= tintedMaterial(base, new THREE.Color(color).multiplyScalar(1.25), 1);
    setMaterial(model, yarnMats[owner]);
    return model;
  }
  const group = new THREE.Group();
  const ball = new THREE.Mesh(new THREE.SphereGeometry(r, 28, 20), feltMaterial(0xffffff, yarnTexture(color)));
  ball.position.y = r;
  ball.rotation.set(0.4 * owner + 0.3 * hp, hp, 0.2);
  ball.castShadow = true;
  group.add(ball);
  // Хвостик нитки, лежащий на половике.
  const tail = new THREE.CatmullRomCurve3([
    new THREE.Vector3(r * 0.7, r * 0.5, r * 0.4),
    new THREE.Vector3(r * 1.3, 0.008, r * 0.6),
    new THREE.Vector3(r * 2.2, 0.006, r * 0.2),
    new THREE.Vector3(r * 3.0, 0.006, r * 0.7),
  ]);
  group.add(new THREE.Mesh(new THREE.TubeGeometry(tail, 16, 0.006, 6), feltMaterial(color)));
  return group;
}

/**
 * Валяный кот, сидит мордой по +Z (как ждёт Object3D.lookAt).
 * body — всё, кроме кольца-следа: его прячем, когда смотрим глазами этого кота.
 */
export function createCat(coat: number): { group: THREE.Group; body: THREE.Group } {
  // Перед модели (после поправки FRONT) — +X; у нас морда кота — по +Z.
  const model = fitModel(coat === 0 ? 'cat_ginger' : 'cat_gray', { height: CAT_HEIGHT, rotY: -Math.PI / 2 });
  if (model) {
    const group = new THREE.Group();
    group.add(model);
    return { group, body: model };
  }
  const c = CAT_COATS[coat];
  const fur = feltMaterial(0xffffff, tabbyTexture(c.base, c.stripe));
  const plain = feltMaterial(c.base);
  const belly = feltMaterial(c.belly);
  const dark = new THREE.MeshStandardMaterial({ color: 0x1b1612, roughness: 0.4 });
  const pink = feltMaterial(0xd98c8c);

  const body = new THREE.Group();
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, pos: [number, number, number], scale?: [number, number, number]) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(...pos);
    if (scale) m.scale.set(...scale);
    m.castShadow = true;
    body.add(m);
    return m;
  };
  const sphere = new THREE.SphereGeometry(1, 28, 20);

  // Туловище — груша: широкий низ, грудь светлее.
  add(sphere, fur, [0, 0.27, -0.04], [0.22, 0.27, 0.24]);
  add(sphere, belly, [0, 0.33, 0.1], [0.13, 0.17, 0.1]);
  // Передние лапы.
  for (const sx of [-1, 1]) {
    add(new THREE.CapsuleGeometry(0.045, 0.2, 6, 12), plain, [sx * 0.08, 0.14, 0.12]);
    add(sphere, belly, [sx * 0.08, 0.03, 0.15], [0.055, 0.035, 0.07]);
    // Задние лапы — бугры по бокам.
    add(sphere, fur, [sx * 0.15, 0.1, -0.02], [0.08, 0.1, 0.15]);
  }
  // Голова.
  const head = new THREE.Group();
  head.position.set(0, 0.6, 0.05);
  body.add(head);
  const addH = (geo: THREE.BufferGeometry, mat: THREE.Material, pos: [number, number, number], scale?: [number, number, number]) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(...pos);
    if (scale) m.scale.set(...scale);
    m.castShadow = true;
    head.add(m);
    return m;
  };
  addH(sphere, fur, [0, 0, 0], [0.16, 0.14, 0.14]);
  addH(sphere, belly, [0, -0.04, 0.11], [0.075, 0.055, 0.05]);
  addH(sphere, pink, [0, -0.01, 0.155], [0.018, 0.013, 0.01]);
  for (const sx of [-1, 1]) {
    const ear = addH(new THREE.ConeGeometry(0.055, 0.1, 4), plain, [sx * 0.09, 0.13, -0.01]);
    ear.rotation.z = -sx * 0.35;
    addH(sphere, dark, [sx * 0.055, 0.025, 0.12], [0.022, 0.028, 0.015]);
  }
  // Хвост обвивает лапы.
  const tail = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0.08, -0.25),
    new THREE.Vector3(0.18, 0.04, -0.2),
    new THREE.Vector3(0.24, 0.035, 0.0),
    new THREE.Vector3(0.18, 0.035, 0.17),
    new THREE.Vector3(0.06, 0.04, 0.22),
  ]);
  const tailMesh = new THREE.Mesh(new THREE.TubeGeometry(tail, 24, 0.035, 10), fur);
  tailMesh.castShadow = true;
  body.add(tailMesh);

  const group = new THREE.Group();
  group.add(body);
  return { group, body };
}

/**
 * Кошачья лапа, держащая спицу (вид от первого лица).
 * Начало координат — точка хвата; предплечье уходит вниз-вправо к краю экрана.
 */
/** Подгонка модели лапы — вынесена, чтобы подбирать в отладке (window.__game.paw). */
export const PAW_FIT = {
  /** Длина модели (предплечье с лапой). */
  size: 0.36,
  /**
   * Точка хвата в координатах модели (куб 1×1×1): у подушечек пальцев.
   * Модель — настоящая кошачья лапа, вытянута вдоль X: пальцы на +X, срез предплечья на −X.
   */
  hole: new THREE.Vector3(0.3, 0, 0.15),
  /** Куда уходит предплечье (в координатах лапы: +X — вправо, +Y — вниз по экрану, −Z — к камере). */
  arm: new THREE.Vector3(0.7, 0.45, -1),
  /** Куда смотрят подушечки (+Z модели) — к спице. */
  pads: new THREE.Vector3(-1, -0.2, 0),
};

/** Серая лапа — та же модель, обесцвеченная. */
let grayPawMat: THREE.Material | null = null;

function modelPaw(coat: number): THREE.Group | null {
  const raw = rawModel('paw');
  if (!raw) return null;
  // Базис: −X модели (к локтю) → PAW_FIT.arm, +Z модели (подушечки) → PAW_FIT.pads.
  const x = PAW_FIT.arm.clone().normalize().negate();
  const z = PAW_FIT.pads.clone().addScaledVector(x, -PAW_FIT.pads.dot(x)).normalize();
  const y = z.clone().cross(x);
  raw.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
  raw.scale.setScalar(PAW_FIT.size);
  raw.position.copy(PAW_FIT.hole).multiplyScalar(PAW_FIT.size).applyQuaternion(raw.quaternion).negate();
  if (coat === 1) {
    const base = baseMaterial('paw');
    if (base) setMaterial(raw, (grayPawMat ??= tintedMaterial(base, 0xc4c8ce, 0.92)));
  }
  raw.traverse((o) => (o.castShadow = false));
  const g = new THREE.Group();
  g.add(raw);
  return g;
}

export function createPaw(coat: number): THREE.Group {
  const model = modelPaw(coat);
  if (model) return model;
  const c = CAT_COATS[coat];
  const g = new THREE.Group();
  const fur = feltMaterial(c.base);
  const pad = feltMaterial(0xd98c8c);
  // Подушечка обхватывает спицу.
  const paw = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 18), fur);
  paw.scale.set(0.034, 0.03, 0.03);
  paw.position.set(0.004, -0.004, 0.006);
  g.add(paw);
  // Лапа висит в кадре перевёрнутой (спица остриём вниз), поэтому «к камере» здесь — это −Z,
  // а «вниз по экрану» — это +Y.
  // Пальчики обхватывают спицу спереди.
  for (let i = 0; i < 3; i++) {
    const toe = new THREE.Mesh(new THREE.SphereGeometry(0.012, 14, 10), fur);
    toe.position.set(-0.016 + i * 0.016, 0.004, -0.026);
    g.add(toe);
  }
  // Розовая подушечка выглядывает сбоку.
  const bean = new THREE.Mesh(new THREE.SphereGeometry(0.009, 12, 8), pad);
  bean.scale.set(1.4, 1, 0.6);
  bean.position.set(-0.03, 0.006, -0.012);
  g.add(bean);
  // Предплечье уходит вниз-вправо, к краю экрана и к камере.
  const dir = new THREE.Vector3(0.45, 0.8, -0.4).normalize();
  const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.026, 0.24, 8, 14), fur);
  arm.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  arm.position.copy(dir).multiplyScalar(0.14);
  g.add(arm);
  return g;
}

// ---------- Комната ----------
// Комната — рисованная декорация, как фон в мультфильме: четыре стены-картины в гуаши
// (мебель нарисована на них) и рисованный пол. Объёмные только половик и всё, что на нём.
/** Полуширина комнаты (≈ 4,1 м в поперечнике). */
export const ROOM_HALF = 2.05 * M;
/** Высота стены — по пропорции картин (3:2). */
const WALL_H = (2 * ROOM_HALF) / 1.5;

/**
 * Стены по кругу: −Z (на неё смотрит рыжий) — диван и ковёр, −X — дверь и шкаф,
 * +Z (смотрит серый) — стенка и телевизор, +X — окно.
 */
const WALLS: { name: string; crop: [number, number, number, number] }[] = [
  // crop — какую часть картины берём (доли от левого верхнего угла: левый, правый, верх, низ):
  // художник дорисовал по краям кусочки соседних стен, потолок и пол — их отрезаем.
  { name: 'wall_sofa', crop: [0.02, 0.98, 0.085, 0.925] },
  { name: 'wall_door', crop: [0.06, 0.945, 0.075, 0.915] },
  { name: 'wall_stenka', crop: [0.075, 0.925, 0.095, 0.955] },
  { name: 'wall_window', crop: [0.075, 0.935, 0.085, 0.96] },
];

function wallTexture(name: string, [l, r, t, b]: [number, number, number, number]): THREE.Texture {
  const tex = fileTexture(name, true).clone();
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.repeat.set(r - l, b - t);
  tex.offset.set(l, 1 - b); // v растёт снизу вверх
  return tex;
}

export function createRoom(): THREE.Group {
  const room = new THREE.Group();
  const W = ROOM_HALF;
  for (let i = 0; i < 4; i++) {
    const side = new THREE.Group();
    side.rotation.y = (i * Math.PI) / 2;
    // Картина не освещается сценой: свет и тени уже нарисованы.
    const wall = new THREE.Mesh(
      new THREE.PlaneGeometry(2 * W, WALL_H),
      new THREE.MeshBasicMaterial({ map: wallTexture(WALLS[i].name, WALLS[i].crop), color: 0xf4efe6 }),
    );
    wall.position.set(0, WALL_H / 2, -W);
    side.add(wall);
    room.add(side);
  }
  // Потолок — чтобы сверху (обзор) не было пустоты.
  const ceiling = new THREE.Mesh(
    new THREE.PlaneGeometry(2 * W, 2 * W),
    new THREE.MeshBasicMaterial({ color: 0xd9cdb6 }),
  );
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = WALL_H;
  room.add(ceiling);
  return room;
}
