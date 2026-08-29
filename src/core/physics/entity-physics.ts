/**
 * 实体运动积分。**服务端模拟、客户端预测、生物 AI 共用这一份。**
 *
 * 共用不是为了省代码，是为了让"回滚重放"天然精确：客户端预测走的每一步
 * 和服务端权威跑的每一步是同一段代码，重放时不会有一丁点漂移。
 * 前作两边各写一套，结果是玩家在斜坡和台阶上被反复拉回去，且极难定位。
 *
 * 数值全部照抄 MC 1.0 的 `EntityLivingBase.moveEntityWithHeading`：
 *
 *   地面摩擦 f = 方块滑度 × 0.91（普通方块 0.6 → 0.546），空中 f = 0.91
 *   加速度   = 0.1 × (0.16277136 / f³)，空中固定 0.02
 *   移动后   motionY = (motionY − 0.08) × 0.98；motionX/Z ×= f
 *
 * 那个 `0.16277136 / f³` 看着像魔数，其实是 0.546³ —— 它让**普通地面上的
 * 加速度正好等于 0.1**，而冰面（滑度 0.98）上的加速度按同一式子自动变小。
 * 于是"冰上加速慢、但停得也慢"这个手感是从一条公式里长出来的，不是调出来的。
 */
import {
  GRAVITY, DRAG_VERTICAL, JUMP_VELOCITY, STEP_HEIGHT,
  PLAYER_WIDTH, PLAYER_HEIGHT, FRICTION_DEFAULT,
} from '../constants.ts';
import { stateId } from '../world/chunk.ts';
import type { BlockView } from '../world/block-view.ts';
import {
  collideMove, setBodyBox, makeBox, type Box, type CollisionTables,
} from './block-collision.ts';

/** 空中的水平摩擦 */
const AIR_FRICTION = 0.91;
/** 地面加速度基数（MC 的 landMovementFactor） */
const MOVE_FACTOR_GROUND = 0.1;
/** 空中加速度（MC 的 jumpMovementFactor），只有地面的五分之一 */
const MOVE_FACTOR_AIR = 0.02;
/** 疾跑倍率 */
const SPRINT_MULTIPLIER = 1.3;
/** 潜行时输入被压到三成 */
const SNEAK_INPUT_SCALE = 0.3;
/** 疾跑起跳时额外获得的前冲，这是"疾跑跳"能跨 4 格的原因 */
const SPRINT_JUMP_BOOST = 0.2;
/** moveFlying 里判定"有输入"的阈值 */
const INPUT_EPSILON = 1e-4;
/**
 * 输入衰减。MC 的 `EntityLivingBase.onLivingUpdate` 在调用
 * moveEntityWithHeading 之前有一行 `moveStrafing *= 0.98F; moveForward *= 0.98F;`。
 *
 * 少了它，行走/疾跑/潜行三个速度会**同时**高出 2.05%：
 * 4.405 / 5.727 / 1.322，而 MC 的实测值是 4.317 / 5.612 / 1.295。
 * 三个数被同一个系数拉偏，正是"漏了一处公共乘数"的指纹 ——
 * 补上之后三个数分别落到 4.317 / 5.612 / 1.295，逐个吻合。
 */
const INPUT_DECAY = 0.98;

/** 一个受物理驱动的实体 */
export interface Body {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  /** 弧度，0 朝 +Z，与 client/camera.ts 一致 */
  yaw: number;
  onGround: boolean;
  width: number;
  height: number;
}

/** 一帧的移动意图 */
export interface MoveInput {
  /** −1..1，正值向前 */
  forward: number;
  /** −1..1，正值向右 */
  strafe: number;
  jump: boolean;
  sneak: boolean;
  sprint: boolean;
}

export function makeBody(x: number, y: number, z: number, yaw = 0): Body {
  return {
    x, y, z, vx: 0, vy: 0, vz: 0, yaw,
    onGround: false, width: PLAYER_WIDTH, height: PLAYER_HEIGHT,
  };
}

export function emptyInput(): MoveInput {
  return { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false };
}

/** 脚下方块的滑度。冰是 0.98，其余 0.6 */
function slipperinessBelow(world: BlockView, tables: PhysicsTables, body: Body): number {
  const x = Math.floor(body.x);
  const y = Math.floor(body.y) - 1;
  const z = Math.floor(body.z);
  const id = stateId(world.getState(x, y, z));
  if (id === 0) return FRICTION_DEFAULT;
  return tables.slipperiness[id] ?? FRICTION_DEFAULT;
}

export interface PhysicsTables extends CollisionTables {
  /** 按方块 id 索引的滑度 */
  readonly slipperiness: Float32Array;
}

/**
 * MC 的 `moveFlying`：把前后/左右输入按朝向转成速度增量。
 *
 * 注意归一化只在长度**大于 1** 时才做（`if (len < 1) len = 1`）——
 * 于是斜着走不会比直走快，但摇杆推一半也不会被放大到满速。
 */
function applyInputAcceleration(body: Body, strafe: number, forward: number, accel: number): void {
  const lenSq = strafe * strafe + forward * forward;
  if (lenSq < INPUT_EPSILON) return;
  let len = Math.sqrt(lenSq);
  if (len < 1) len = 1;
  const scale = accel / len;
  const s = strafe * scale;
  const f = forward * scale;
  const sin = Math.sin(body.yaw);
  const cos = Math.cos(body.yaw);
  // yaw 0 朝 +Z：前进方向是 (−sin, cos)，右方向是 (cos, sin)
  body.vx += s * cos - f * sin;
  body.vz += f * cos + s * sin;
}

const stepBox = makeBox();
const tryBox = makeBox();

/**
 * 推进一个 tick。
 *
 * @returns 本 tick 实际发生的位移，供落地伤害与移动统计使用
 */
export function stepBody(
  world: BlockView,
  tables: PhysicsTables,
  body: Body,
  input: MoveInput,
): { dx: number; dy: number; dz: number } {
  const startX = body.x;
  const startY = body.y;
  const startZ = body.z;

  let strafe = input.strafe;
  let forward = input.forward;
  if (input.sneak) {
    strafe *= SNEAK_INPUT_SCALE;
    forward *= SNEAK_INPUT_SCALE;
  }
  strafe *= INPUT_DECAY;
  forward *= INPUT_DECAY;

  // 起跳。疾跑起跳额外给一份朝向前冲 —— 疾跑跳能跨 4 格靠的就是这 0.2
  if (input.jump && body.onGround) {
    body.vy = JUMP_VELOCITY;
    if (input.sprint) {
      body.vx -= Math.sin(body.yaw) * SPRINT_JUMP_BOOST;
      body.vz += Math.cos(body.yaw) * SPRINT_JUMP_BOOST;
    }
  }

  // 摩擦取自**脚下**方块，且在加速之前先算一次
  const friction = body.onGround ? slipperinessBelow(world, tables, body) * AIR_FRICTION : AIR_FRICTION;
  const accel = body.onGround
    ? MOVE_FACTOR_GROUND * (input.sprint ? SPRINT_MULTIPLIER : 1) * (0.16277136 / (friction * friction * friction))
    : MOVE_FACTOR_AIR * (input.sprint ? SPRINT_MULTIPLIER : 1);
  applyInputAcceleration(body, strafe, forward, accel);

  // --- 位移与碰撞 ---
  setBodyBox(stepBox, body.x, body.y, body.z, body.width, body.height);
  const wasOnGround = body.onGround;
  const moved = collideMove(world, tables, stepBox, body.vx, body.vy, body.vz);

  // 上台阶：水平被挡住且人在地上时，抬高 STEP_HEIGHT 再试一次，
  // 谁走得更远用谁。没有这一步，半砖和台阶就得靠跳，走路会一步一顿。
  if ((moved.hitX || moved.hitZ) && wasOnGround) {
    // 从**原始位置**重来一遍：先抬 STEP_HEIGHT，再按原速度水平走，最后贴回地面。
    setBodyBox(tryBox, body.x, body.y, body.z, body.width, body.height);
    const up = collideMove(world, tables, tryBox, 0, STEP_HEIGHT, 0);
    const over = collideMove(world, tables, tryBox, body.vx, 0, body.vz);
    const down = collideMove(world, tables, tryBox, 0, -up.dy, 0);

    const stepDist = over.dx * over.dx + over.dz * over.dz;
    const flatDist = moved.dx * moved.dx + moved.dz * moved.dz;
    if (stepDist > flatDist + 1e-9) {
      body.x = (tryBox.minX + tryBox.maxX) / 2;
      body.y = tryBox.minY;
      body.z = (tryBox.minZ + tryBox.maxZ) / 2;
      body.onGround = down.hitY || wasOnGround;
      // 只有**抬高之后仍然**被挡住的轴才清零速度。
      // 无条件清零的话，每上一级半砖都会顿一下再重新加速 ——
      // 走一段楼梯就是一路一顿一顿的，手感立刻不对。
      if (over.hitX) body.vx = 0;
      if (over.hitZ) body.vz = 0;
      applyPostMoveDamping(body, friction);
      return { dx: body.x - startX, dy: body.y - startY, dz: body.z - startZ };
    }
  }

  body.x = (stepBox.minX + stepBox.maxX) / 2;
  body.y = stepBox.minY;
  body.z = (stepBox.minZ + stepBox.maxZ) / 2;

  // 撞到东西就把那一轴的速度清零，否则会"贴着墙持续加速"，
  // 一旦离开墙面就会以攒下来的速度弹射出去
  body.onGround = moved.hitY && body.vy <= 0;
  if (moved.hitX) body.vx = 0;
  if (moved.hitY) body.vy = 0;
  if (moved.hitZ) body.vz = 0;

  applyPostMoveDamping(body, friction);
  return { dx: body.x - startX, dy: body.y - startY, dz: body.z - startZ };
}

/** 位移之后的重力与阻尼。顺序照抄 MC：先重力再阻尼，水平摩擦最后 */
function applyPostMoveDamping(body: Body, friction: number): void {
  body.vy = (body.vy - GRAVITY) * DRAG_VERTICAL;
  body.vx *= friction;
  body.vz *= friction;
}
