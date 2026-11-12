// Модель ножа: меш, физическое тело и расчёт броска.
// Локальные оси ножа: +Y — к острию, X — ширина лезвия, Z — толщина (нормаль плоскости клинка).
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';

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

export function createKnifeMesh(): THREE.Group {
  const group = new THREE.Group();

  const shape = new THREE.Shape();
  const hw = BLADE.halfW;
  shape.moveTo(-hw, 0);
  shape.lineTo(hw, 0);
  shape.lineTo(hw, BLADE.len * 0.62);
  shape.quadraticCurveTo(hw * 0.6, BLADE.len * 0.9, 0, BLADE.len);
  shape.lineTo(-hw, BLADE.len * 0.8);
  shape.closePath();
  const bladeGeo = new THREE.ExtrudeGeometry(shape, { depth: BLADE.halfT * 2, bevelEnabled: false });
  bladeGeo.translate(0, 0, -BLADE.halfT);
  const blade = new THREE.Mesh(
    bladeGeo,
    new THREE.MeshStandardMaterial({ color: 0xd8dde3, metalness: 0.9, roughness: 0.25 }),
  );
  blade.castShadow = true;
  group.add(blade);

  const guard = new THREE.Mesh(
    new THREE.BoxGeometry(HANDLE.halfW * 2.8, 0.008, HANDLE.halfT * 2.4),
    new THREE.MeshStandardMaterial({ color: 0x555a60, metalness: 0.7, roughness: 0.4 }),
  );
  guard.castShadow = true;
  group.add(guard);

  const handleGeo = new THREE.BoxGeometry(HANDLE.halfW * 2, HANDLE.len, HANDLE.halfT * 2);
  handleGeo.translate(0, -HANDLE.len / 2, 0);
  const handle = new THREE.Mesh(handleGeo, new THREE.MeshStandardMaterial({ color: 0x6b3e1f, roughness: 0.8 }));
  handle.castShadow = true;
  group.add(handle);

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
