// Модель ножа: меш, физическое тело и расчёт броска.
// Локальные оси ножа: +Y — к острию, X — ширина лезвия, Z — толщина (нормаль плоскости клинка).
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { fitModel, baseMaterial, tintedMaterial, setMaterial } from './assets';

/** Металлическая спица — та же модель бамбуковой, но серая и с блеском (материал общий). */
let metalNeedleMat: THREE.MeshStandardMaterial | null = null;

export const BLADE = { halfW: 0.014, len: 0.13, halfT: 0.002, density: 7.8 };
export const HANDLE = { halfW: 0.011, len: 0.1, halfT: 0.008, density: 0.9 };

export const TIP_LOCAL = new THREE.Vector3(0, BLADE.len, 0);
/** Где пальцы держат нож: за лезвие, ближе к острию (так нож лучше закручивается). */
export const GRIP_LOCAL = new THREE.Vector3(0, BLADE.len * 0.8, 0);

const bladeMass = 2 * BLADE.halfW * BLADE.len * 2 * BLADE.halfT * BLADE.density;
const handleMass = 2 * HANDLE.halfW * HANDLE.len * 2 * HANDLE.halfT * HANDLE.density;
/** Центр масс ножа в локальных координатах (Rapier считает его так же из плотностей). */
export const COM_LOCAL = new THREE.Vector3(
  0,
  (bladeMass * (BLADE.len / 2) - handleMass * (HANDLE.len / 2)) / (bladeMass + handleMass),
  0,
);

/** Точки корпуса, по которым определяем, что коснулось земли первым. */
export const HULL_POINTS_LOCAL: THREE.Vector3[] = (() => {
  const pts: THREE.Vector3[] = [];
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      pts.push(new THREE.Vector3(sx * BLADE.halfW, 0, sz * BLADE.halfT));
      pts.push(new THREE.Vector3(sx * BLADE.halfW, BLADE.len * 0.7, sz * BLADE.halfT));
      pts.push(new THREE.Vector3(sx * HANDLE.halfW, 0, sz * HANDLE.halfT));
      pts.push(new THREE.Vector3(sx * HANDLE.halfW, -HANDLE.len, sz * HANDLE.halfT));
    }
  return pts;
})();

/** Из чего спица: бамбуковая (лёгкие ножи) или металлическая (тяжёлые). */
export type NeedleKind = 'bamboo' | 'metal';

/**
 * Вязальная спица того же размера, что и физическое тело ножа: острие — в TIP_LOCAL,
 * шарик-навершие — на конце «рукоятки». Цвет навершия — цвет владельца.
 */
export function createNeedleMesh(kind: NeedleKind, knobColor: number, knobR = 0.038): THREE.Group {
  const group = new THREE.Group();
  // Толще настоящей: сверху и издалека тонкую спицу не разглядеть. Физическое тело — прежнее.
  const r = 0.011;
  const tipLen = 0.035;
  const bottom = -HANDLE.len;
  const shaftLen = BLADE.len - tipLen - bottom;
  const mat = kind === 'metal'
    ? new THREE.MeshStandardMaterial({ color: 0xc9ced4, metalness: 0.85, roughness: 0.3 })
    : new THREE.MeshStandardMaterial({ color: 0xd9b77a, roughness: 0.7 });

  const knob = new THREE.Mesh(
    new THREE.SphereGeometry(knobR, 16, 12),
    new THREE.MeshStandardMaterial({ color: knobColor, roughness: 0.6 }),
  );
  knob.position.y = bottom;
  knob.castShadow = true;
  group.add(knob);

  // Модель спицы лежит вдоль Z, острие — к −Z; поворот на +90° вокруг X ставит острие в +Y.
  const model = fitModel('needle', {
    rotation: new THREE.Euler(Math.PI / 2, 0, 0), anchor: 'center',
  });
  if (model) {
    const len = BLADE.len - bottom;
    // fitModel без height подгоняет самую длинную сторону к 1 — растягиваем до длины спицы.
    model.scale.setScalar(len);
    model.position.y = (BLADE.len + bottom) / 2;
    if (kind === 'metal') {
      const base = baseMaterial('needle');
      if (base) {
        metalNeedleMat ??= Object.assign(tintedMaterial(base, 0xd4d9de, 1), { metalness: 0.8, roughness: 0.35 });
        setMaterial(model, metalNeedleMat);
      }
    }
    group.add(model);
    return group;
  }

  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(r, r, shaftLen, 12), mat);
  shaft.position.y = bottom + shaftLen / 2;
  const tip = new THREE.Mesh(new THREE.ConeGeometry(r, tipLen, 12), mat);
  tip.position.y = BLADE.len - tipLen / 2;
  for (const m of [shaft, tip]) {
    m.castShadow = true;
    group.add(m);
  }
  return group;
}

export interface KnifeBody {
  body: RAPIER.RigidBody;
  colliders: RAPIER.Collider[];
}

export function createKnifeBody(world: RAPIER.World, plan: ThrowPlan): KnifeBody {
  const desc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(plan.bodyOrigin.x, plan.bodyOrigin.y, plan.bodyOrigin.z)
    .setRotation({ x: plan.rotation.x, y: plan.rotation.y, z: plan.rotation.z, w: plan.rotation.w })
    .setLinvel(plan.linvel.x, plan.linvel.y, plan.linvel.z)
    .setAngvel({ x: plan.angvel.x, y: plan.angvel.y, z: plan.angvel.z })
    .setCcdEnabled(true);
  const body = world.createRigidBody(desc);

  const blade = RAPIER.ColliderDesc.cuboid(BLADE.halfW, BLADE.len / 2, BLADE.halfT)
    .setTranslation(0, BLADE.len / 2, 0)
    .setDensity(BLADE.density)
    .setFriction(0.6)
    .setRestitution(0.25)
    .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
  const handle = RAPIER.ColliderDesc.cuboid(HANDLE.halfW, HANDLE.len / 2, HANDLE.halfT)
    .setTranslation(0, -HANDLE.len / 2, 0)
    .setDensity(HANDLE.density)
    .setFriction(0.8)
    .setRestitution(0.2)
    .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);

  return { body, colliders: [world.createCollider(blade, body), world.createCollider(handle, body)] };
}

export interface ThrowPlan {
  bodyOrigin: THREE.Vector3;
  rotation: THREE.Quaternion;
  linvel: THREE.Vector3;
  angvel: THREE.Vector3;
}

const UP = new THREE.Vector3(0, 1, 0);

/** Параметры, с которыми нож покидает руку (всё берётся из жеста). */
export interface Release {
  /** Положение пальцев, держащих лезвие, в момент отпускания. */
  hand: THREE.Vector3;
  /** Направление броска по горизонтали, рад (0 = +X, π/2 = +Z). */
  yaw: number;
  /** Угол вылета над горизонтом, рад (отрицательный — бросок вниз). */
  elevation: number;
  /** Скорость вылета, м/с. */
  speed: number;
  /** Скорость вращения «через остриё вперёд», рад/с. */
  spin: number;
  /**
   * Наклон ножа в руке в момент отпускания, рад: 0 — остриём вверх, π — остриём вниз (рукоятка вверх),
   * положительный поворот — в сторону вращения (остриё через «вперёд»).
   */
  tipAngle: number;
  /** Поворот кисти: разворот клинка вокруг его оси, рад. 0 — клинок в плоскости броска. */
  roll: number;
}

/** Хват за лезвие: в руке нож висит остриём вниз, рукоятка смотрит вверх. */
export const HELD_TIP_ANGLE = Math.PI;

/** Ориентация ножа в момент отпускания. */
export function releaseRotation(yaw: number, tipAngle: number, roll: number): THREE.Quaternion {
  const f = new THREE.Vector3(Math.cos(yaw), 0, Math.sin(yaw));
  const spinAxis = new THREE.Vector3().crossVectors(UP, f);
  const x = f.clone().applyAxisAngle(UP, -roll);
  const z = new THREE.Vector3().crossVectors(x, UP);
  return new THREE.Quaternion()
    .setFromAxisAngle(spinAxis, tipAngle)
    .multiply(new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, UP, z)));
}

/**
 * Нож вылетает с наклоном tipAngle и вращается вперёд.
 * Воткнётся он или нет, решает только физика: скорость, угол вылета, наклон и вращение.
 */
export function planRelease(r: Release): ThrowPlan {
  const f = new THREE.Vector3(Math.cos(r.yaw), 0, Math.sin(r.yaw));
  const spinAxis = new THREE.Vector3().crossVectors(UP, f);
  const rotation = releaseRotation(r.yaw, r.tipAngle, r.roll);
  const bodyOrigin = r.hand.clone().sub(GRIP_LOCAL.clone().applyQuaternion(rotation));

  const linvel = f
    .clone()
    .multiplyScalar(Math.cos(r.elevation) * r.speed)
    .addScaledVector(UP, Math.sin(r.elevation) * r.speed);
  // Ось вращения горизонтальна и перпендикулярна полёту: остриё идёт из «вверх» во «вперёд» и «вниз».
  const angvel = spinAxis.multiplyScalar(r.spin);

  return { bodyOrigin, rotation, linvel, angvel };
}

const GRAVITY = 9.81;

/**
 * Через сколько секунд нож коснётся земли остриём (если придёт остриём вниз).
 * Нужно, чтобы понять, сколько оборотов он успеет сделать при данной закрутке.
 */
export function landingTime(r: Release): number {
  const rot = releaseRotation(r.yaw, r.tipAngle, r.roll);
  const y0 = r.hand.y + COM_LOCAL.clone().sub(GRIP_LOCAL).applyQuaternion(rot).y;
  const yEnd = TIP_LOCAL.y - COM_LOCAL.y;
  const vy = Math.sin(r.elevation) * r.speed;
  // y0 + vy·t − g·t²/2 = yEnd
  const a = GRAVITY / 2;
  const disc = vy * vy - 4 * a * (yEnd - y0);
  return (vy + Math.sqrt(Math.max(0, disc))) / (2 * a);
}
