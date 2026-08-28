/**
 * 键鼠输入。
 *
 * 按键状态用 event.code（物理位置）而不是 event.key（字符），这样非 QWERTY 布局下
 * WASD 依然在同一个物理位置上，与 MC 的行为一致。
 *
 * 鼠标走 Pointer Lock。自动化测试通过 injectKey / injectLook 绕开真实输入，
 * 所以 __mc.press() 不需要真的合成 DOM 事件。
 */

export interface InputSnapshot {
  readonly forward: boolean;
  readonly back: boolean;
  readonly left: boolean;
  readonly right: boolean;
  readonly up: boolean;
  readonly down: boolean;
  readonly sprint: boolean;
  readonly sneak: boolean;
  /** 本帧累积的鼠标偏移（弧度），读取后清零 */
  readonly dYaw: number;
  readonly dPitch: number;
}

const KEY_BINDINGS: Record<string, keyof Omit<InputSnapshot, 'dYaw' | 'dPitch'>> = {
  KeyW: 'forward',
  KeyS: 'back',
  KeyA: 'left',
  KeyD: 'right',
  Space: 'up',
  ShiftLeft: 'sneak',
  ShiftRight: 'sneak',
  ControlLeft: 'sprint',
  KeyQ: 'down',
};

/** 鼠标灵敏度：像素 -> 弧度 */
const MOUSE_SENSITIVITY = 0.0022;

export class Input {
  private readonly down = new Set<string>();
  /** 由自动化注入的按键，与真实按键取并集 */
  private readonly injected = new Set<string>();
  private accYaw = 0;
  private accPitch = 0;
  private locked = false;
  private readonly canvas: HTMLCanvasElement;
  private readonly listeners: (() => void)[] = [];

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;

    const onKeyDown = (e: KeyboardEvent): void => {
      this.down.add(e.code);
      // 空格会滚动页面，Tab 会切焦点，都要拦
      if (e.code === 'Space' || e.code === 'Tab') e.preventDefault();
    };
    const onKeyUp = (e: KeyboardEvent): void => {
      this.down.delete(e.code);
    };
    const onBlur = (): void => {
      // 失焦时清空，否则切回来会发现自己还在往前走
      this.down.clear();
    };
    const onMouseMove = (e: MouseEvent): void => {
      if (!this.locked) return;
      this.accYaw += e.movementX * MOUSE_SENSITIVITY;
      this.accPitch += e.movementY * MOUSE_SENSITIVITY;
    };
    const onClick = (): void => {
      if (!this.locked) void canvas.requestPointerLock();
    };
    const onLockChange = (): void => {
      this.locked = document.pointerLockElement === canvas;
      if (!this.locked) this.down.clear();
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    window.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('click', onClick);
    document.addEventListener('pointerlockchange', onLockChange);

    this.listeners.push(
      () => window.removeEventListener('keydown', onKeyDown),
      () => window.removeEventListener('keyup', onKeyUp),
      () => window.removeEventListener('blur', onBlur),
      () => window.removeEventListener('mousemove', onMouseMove),
      () => canvas.removeEventListener('click', onClick),
      () => document.removeEventListener('pointerlockchange', onLockChange),
    );
  }

  get pointerLocked(): boolean {
    return this.locked;
  }

  /** 取本帧输入快照并清空鼠标累积量 */
  sample(): InputSnapshot {
    const has = (code: string): boolean => this.down.has(code) || this.injected.has(code);
    const snap: InputSnapshot = {
      forward: has('KeyW'),
      back: has('KeyS'),
      left: has('KeyA'),
      right: has('KeyD'),
      up: has('Space'),
      down: has('KeyQ'),
      sprint: has('ControlLeft'),
      sneak: has('ShiftLeft') || has('ShiftRight'),
      dYaw: this.accYaw,
      dPitch: this.accPitch,
    };
    this.accYaw = 0;
    this.accPitch = 0;
    return snap;
  }

  /** 供 __mc.press() 使用 */
  injectKeyDown(code: string): void {
    this.injected.add(code);
  }

  injectKeyUp(code: string): void {
    this.injected.delete(code);
  }

  /** 供 __mc.look() 使用，单位是弧度 */
  injectLook(dYaw: number, dPitch: number): void {
    this.accYaw += dYaw;
    this.accPitch += dPitch;
  }

  dispose(): void {
    for (const off of this.listeners) off();
    this.listeners.length = 0;
    this.down.clear();
    this.injected.clear();
  }
}

export { KEY_BINDINGS };
