/**
 * 着色器编译与 uniform 管理。
 *
 * 编译失败时把 GLSL 源码带行号一起打出来 —— 着色器报错只给一个行号而没有上下文时，
 * 定位成本极高，而这类错误在开发期非常频繁。
 */

export class ShaderError extends Error {}

function compileStage(gl: WebGL2RenderingContext, type: number, source: string, label: string): WebGLShader {
  const shader = gl.createShader(type);
  if (shader === null) throw new ShaderError(`createShader 失败 (${label})`);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? '(无日志)';
    gl.deleteShader(shader);
    throw new ShaderError(`${label} 编译失败:\n${log}\n${withLineNumbers(source)}`);
  }
  return shader;
}

function withLineNumbers(src: string): string {
  return src
    .split('\n')
    .map((line, i) => `${String(i + 1).padStart(4, ' ')} | ${line}`)
    .join('\n');
}

export class Shader {
  readonly program: WebGLProgram;
  readonly name: string;
  private readonly gl: WebGL2RenderingContext;
  private readonly uniforms = new Map<string, WebGLUniformLocation | null>();

  // 注意：不能用构造函数参数属性（readonly name = ...），那不是可擦除语法，
  // Node 的类型剥离跑不了。见 docs/RULES.md 第 2 条。
  constructor(gl: WebGL2RenderingContext, vertexSrc: string, fragmentSrc: string, name = 'shader') {
    this.gl = gl;
    this.name = name;
    const vs = compileStage(gl, gl.VERTEX_SHADER, vertexSrc, `${name}.vert`);
    const fs = compileStage(gl, gl.FRAGMENT_SHADER, fragmentSrc, `${name}.frag`);
    const program = gl.createProgram();
    if (program === null) throw new ShaderError(`createProgram 失败 (${name})`);
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    // 链接后就可以删掉阶段对象了，program 会保留引用
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program) ?? '(无日志)';
      gl.deleteProgram(program);
      throw new ShaderError(`${name} 链接失败:\n${log}`);
    }
    this.program = program;
  }

  use(): void {
    this.gl.useProgram(this.program);
  }

  /** uniform 位置带缓存 —— getUniformLocation 每帧调用是常见的性能陷阱 */
  loc(name: string): WebGLUniformLocation | null {
    let cached = this.uniforms.get(name);
    if (cached === undefined) {
      cached = this.gl.getUniformLocation(this.program, name);
      this.uniforms.set(name, cached);
    }
    return cached;
  }

  setMat4(name: string, value: Float32Array): void {
    const l = this.loc(name);
    if (l !== null) this.gl.uniformMatrix4fv(l, false, value);
  }

  setVec2(name: string, x: number, y: number): void {
    const loc = this.loc(name);
    if (loc !== null) this.gl.uniform2f(loc, x, y);
  }

  setVec3(name: string, x: number, y: number, z: number): void {
    const l = this.loc(name);
    if (l !== null) this.gl.uniform3f(l, x, y, z);
  }

  setVec4(name: string, x: number, y: number, z: number, w: number): void {
    const l = this.loc(name);
    if (l !== null) this.gl.uniform4f(l, x, y, z, w);
  }

  setFloat(name: string, value: number): void {
    const l = this.loc(name);
    if (l !== null) this.gl.uniform1f(l, value);
  }

  setInt(name: string, value: number): void {
    const l = this.loc(name);
    if (l !== null) this.gl.uniform1i(l, value);
  }

  dispose(): void {
    this.gl.deleteProgram(this.program);
    this.uniforms.clear();
  }
}
