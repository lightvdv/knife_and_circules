// Загрузка GLB-моделей (сделаны в 3D AI Studio, лежат в public/models) и выдача их копий.
// Модели грузятся один раз до старта игры. Если какая-то не загрузилась — look.ts рисует
// процедурную замену, игра от этого не ломается.
//
// Все модели из сервиса нормированы в куб 1×1×1 с центром в нуле; «перед» у мебели — по +X.
// Копии делят геометрию и материалы с оригиналом (помечены userData.shared) — их не освобождаем.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

export const MODEL_NAMES = [
  'cat_ginger', 'cat_gray', 'yarn', 'paw', 'needle',
  'stenka', 'sofa', 'tv', 'armchair', 'lamp', 'radiator', 'basket', 'slippers',
] as const;
export type ModelName = (typeof MODEL_NAMES)[number];

const cache = new Map<ModelName, THREE.Object3D>();

/**
 * Где у модели «перед»: Prism ставит модель так, как предмет стоял на эталонной картинке.
 * Значение — поворот вокруг Y, после которого перед смотрит на +X (общее правило для fitModel).
 * Перед по −Z → −π/2, по +Z → +π/2, по +X → 0. Проверено глазами по каждой модели.
 */
const FRONT: Partial<Record<ModelName, number>> = {
  cat_ginger: Math.PI / 2,
  cat_gray: -Math.PI / 2,
  stenka: -Math.PI / 2,
  sofa: -Math.PI / 2,
  armchair: -Math.PI / 2,
};

/** Загрузить все модели; onProgress — для надписи «Загрузка…». */
export async function loadModels(onProgress?: (done: number, total: number) => void): Promise<void> {
  const loader = new GLTFLoader();
  let done = 0;
  await Promise.all(MODEL_NAMES.map(async (name) => {
    try {
      const gltf = await loader.loadAsync(`${import.meta.env.BASE_URL}models/${name}.glb`);
      gltf.scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        m.userData.shared = true;
        m.castShadow = true;
        m.receiveShadow = true;
        const mat = m.material as THREE.MeshStandardMaterial;
        // Металла в комнате нет (кроме спиц — у них свой материал); шероховатость — из текстуры.
        mat.metalness = 0;
      });
      cache.set(name, gltf.scene);
    } catch (e) {
      console.warn(`Модель ${name} не загрузилась, будет процедурная замена`, e);
    }
    onProgress?.(++done, MODEL_NAMES.length);
  }));
}

export const hasModel = (name: ModelName) => cache.has(name);

/** Голая копия модели (нормированный куб 1×1×1, без подгонки). */
export function rawModel(name: ModelName): THREE.Object3D | null {
  return cache.get(name)?.clone(true) ?? null;
}

export interface FitOptions {
  /** Высота по Y после поворота. */
  height?: number;
  /** Или длина самой большой стороны. */
  size?: number;
  /** Поворот вокруг Y: перед модели (после поправки FRONT — +X); −π/2 — мордой по +Z. */
  rotY?: number;
  /** Поворот вместо rotY, если нужен произвольный. */
  rotation?: THREE.Euler;
  /** Где у результата ноль: низ модели (стоит на полу) или её центр. */
  anchor?: 'bottom' | 'center';
}

/** Копия модели нужного размера: обёртка, внутри — повёрнутая и отцентрованная модель. */
export function fitModel(name: ModelName, o: FitOptions): THREE.Group | null {
  const inner = rawModel(name);
  if (!inner) return null;
  if (o.rotation) inner.rotation.copy(o.rotation);
  else inner.rotation.y = (FRONT[name] ?? 0) + (o.rotY ?? 0);
  inner.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(inner);
  const s = box.getSize(new THREE.Vector3());
  const k = o.height !== undefined ? o.height / s.y : (o.size ?? 1) / Math.max(s.x, s.y, s.z);
  inner.scale.setScalar(k); // равномерный масштаб не мешает повороту
  const c = box.getCenter(new THREE.Vector3()).multiplyScalar(k);
  inner.position.set(-c.x, o.anchor === 'center' ? -c.y : -box.min.y * k, -c.z);
  const wrap = new THREE.Group();
  wrap.add(inner);
  return wrap;
}

/** Поменять материал у всех мешей копии (общий для всех копий — кэшируйте его сами). */
export function setMaterial(obj: THREE.Object3D, mat: THREE.Material) {
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) m.material = mat;
  });
}

/** Первый материал модели — чтобы сделать от него вариант (перекрасить, обесцветить). */
export function baseMaterial(name: ModelName): THREE.MeshStandardMaterial | null {
  let found: THREE.MeshStandardMaterial | null = null;
  cache.get(name)?.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!found && m.isMesh) found = m.material as THREE.MeshStandardMaterial;
  });
  return found;
}

/**
 * Вариант материала: обесцветить текстуру (amount 0..1) и умножить на цвет.
 * Так кремовый клубок становится цветным, а рыжая лапа — серой.
 */
export function tintedMaterial(base: THREE.MeshStandardMaterial, color: THREE.ColorRepresentation, desaturate = 0) {
  const mat = base.clone();
  mat.color.set(color);
  if (desaturate > 0) {
    mat.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <map_fragment>',
        // Обесцвечиваем саму текстуру, до умножения на цвет материала.
        `#ifdef USE_MAP
          vec4 texel = texture2D(map, vMapUv);
          float g = dot(texel.rgb, vec3(0.299, 0.587, 0.114));
          texel.rgb = mix(texel.rgb, vec3(g), ${desaturate.toFixed(3)});
          diffuseColor *= texel;
        #endif`,
      );
    };
    mat.customProgramCacheKey = () => `desat${desaturate}`;
  }
  return mat;
}
