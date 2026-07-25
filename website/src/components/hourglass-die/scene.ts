import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { CAPACITY, L, clamp, innerR, levelAt, profileR, smoothstep } from './profile';

/**
 * The three-axis hourglass die, as a framework-free scene.
 *
 * A cube of glass holding three hourglasses, one per axis, sharing a neck at the
 * centre. Gravity is evaluated per axis every frame, so whichever face is down,
 * the vertical hourglass is the one that runs.
 *
 * Differs from the standalone playground in three ways the landing page needs:
 * no orbit controls (drag fights page scroll), `setActive` for targeted rolls,
 * and settle/roll callbacks so the surrounding copy can follow the die.
 */

export type AxisIndex = 0 | 1 | 2;

export interface DieOptions {
  reducedMotion?: boolean;
  /** Seconds for a full bulb to empty. */
  drainSeconds?: number;
  /** Fires when a roll finishes, and once on mount. */
  onSettle?: (axis: AxisIndex) => void;
  /** Fires the moment a roll begins. */
  onRollStart?: () => void;
}

const S = 1.0; // cube half-size
const DOWN = new THREE.Vector3(0, -1, 0);
const AXES = [
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(0, 1, 0),
  new THREE.Vector3(0, 0, 1),
] as const;

/** Order the die visits its faces, matching the order the accesses are listed. */
const CYCLE: AxisIndex[] = [1, 0, 2];

/** One colour per axis: X blue, Y green, Z violet. */
const SAND = [
  { tone: 0x00c8ff, glow: 0x004659 },
  { tone: 0x1fff9f, glow: 0x0b5937 },
  { tone: 0xa855ff, glow: 0x3b1e59 },
] as const;

const RAD = 40;
const WALL_ROWS = 26;
const CAP_ROWS = 8;
const GRAINS = 80;

// The ring angles never change, so the trig is table lookups, not 10k calls.
const RING_COS = new Float32Array(RAD + 1);
const RING_SIN = new Float32Array(RAD + 1);
for (let c = 0; c <= RAD; c++) {
  const a = (c / RAD) * Math.PI * 2;
  RING_COS[c] = Math.cos(a);
  RING_SIN[c] = Math.sin(a);
}

const scratch = new THREE.Vector3();

/**
 * A fixed-topology lathe grid whose vertices are rewritten in place. No
 * per-frame allocation, and no work at all unless the shape actually moved —
 * which is what keeps the two resting hourglasses free.
 */
class SandSurface {
  readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.BufferGeometry;
  private readonly position: Float32Array;
  private readonly normal: Float32Array;
  private readonly rows: number;
  private readonly meridianR: Float32Array;
  private readonly meridianY: Float32Array;
  private readonly shape = [NaN, NaN, NaN, NaN, NaN];

  constructor(material: THREE.Material) {
    this.rows = WALL_ROWS + CAP_ROWS;
    const cols = RAD + 1;
    const n = this.rows * cols;
    this.position = new Float32Array(n * 3);
    this.normal = new Float32Array(n * 3);
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.position, 3));
    this.geometry.setAttribute('normal', new THREE.BufferAttribute(this.normal, 3));

    const index: number[] = [];
    for (let r = 0; r < this.rows - 1; r++) {
      for (let c = 0; c < RAD; c++) {
        const a = r * cols + c;
        const b = a + 1;
        const d = a + cols;
        const e = d + 1;
        index.push(a, d, b, b, d, e);
      }
    }
    this.geometry.setIndex(index);
    this.mesh = new THREE.Mesh(this.geometry, material);
    this.mesh.frustumCulled = false;

    this.meridianR = new Float32Array(this.rows);
    this.meridianY = new Float32Array(this.rows);
  }

  /**
   * @param sign   +1 for the bulb on +Y, -1 for the one on -Y
   * @param tFrom  level where the sand body starts (0 = neck, 1 = far end)
   * @param tTo    level of the free surface
   * @param cap    how far the free surface pulls toward the neck
   * @param capPow 1 = straight cone (a heap), >1 = funnel (a crater)
   */
  update(sign: number, tFrom: number, tTo: number, cap: number, capPow: number): void {
    const was = this.shape;
    if (
      was[0] === sign &&
      was[4] === capPow &&
      Math.abs(was[1] - tFrom) < 2e-4 &&
      Math.abs(was[2] - tTo) < 2e-4 &&
      Math.abs(was[3] - cap) < 2e-4
    ) {
      return;
    }
    was[0] = sign;
    was[1] = tFrom;
    was[2] = tTo;
    was[3] = cap;
    was[4] = capPow;

    const mR = this.meridianR;
    const mY = this.meridianY;
    const rimR = innerR(tTo);
    for (let r = 0; r < this.rows; r++) {
      let t: number;
      if (r < WALL_ROWS) {
        t = tFrom + (tTo - tFrom) * (r / (WALL_ROWS - 1));
        mR[r] = innerR(t);
      } else {
        const v = (r - WALL_ROWS + 1) / CAP_ROWS;
        t = tTo - cap * Math.pow(v, capPow);
        mR[r] = rimR * (1 - v);
      }
      mY[r] = sign * t * L;
    }

    /* Normals analytically instead of computeVertexNormals(): on a surface of
       revolution the meridian tangent (dR, dY) gives the normal (dY, -dR), and
       that sign convention already matches the index winding above. O(rows)
       instead of a cross product per triangle. */
    const p = this.position;
    const nrm = this.normal;
    const last = this.rows - 1;
    let k = 0;
    for (let r = 0; r <= last; r++) {
      const a = r > 0 ? r - 1 : 0;
      const b = r < last ? r + 1 : last;
      const dR = mR[b] - mR[a];
      const dY = mY[b] - mY[a];
      const len = Math.sqrt(dR * dR + dY * dY);
      const nr = len > 1e-9 ? dY / len : 1;
      const ny = len > 1e-9 ? -dR / len : 0;
      const radius = mR[r];
      const y = mY[r];
      for (let c = 0; c <= RAD; c++) {
        const cos = RING_COS[c];
        const sin = RING_SIN[c];
        p[k] = cos * radius;
        p[k + 1] = y;
        p[k + 2] = sin * radius;
        nrm[k] = cos * nr;
        nrm[k + 1] = ny;
        nrm[k + 2] = sin * nr;
        k += 3;
      }
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.normal.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
  }
}

/** One hourglass, authored along its own local Y and rotated onto its die axis. */
class Hourglass {
  readonly group = new THREE.Group();
  /** Fraction of the sand charge sitting in the +Y bulb. */
  fillPlus = 1;
  /** +1 when local +Y points straight down. */
  gravity = -1;
  /** How much of the flow rate gravity allows right now. */
  gate = 0;

  private readonly tone: THREE.Color;
  private readonly toneIdle: THREE.Color;
  private readonly glow: THREE.Color;
  private readonly glowIdle: THREE.Color;
  private readonly glassMat: THREE.MeshPhysicalMaterial;
  private readonly sandMat: THREE.MeshStandardMaterial;
  private readonly streamMat: THREE.MeshBasicMaterial;
  private readonly grainMat: THREE.PointsMaterial;
  private readonly plus: SandSurface;
  private readonly minus: SandSurface;
  private readonly stream: THREE.Mesh;
  private readonly grains: THREE.Points;
  private readonly grainGeo: THREE.BufferGeometry;
  private readonly phase: Float32Array;
  private readonly jitter: Float32Array;
  private readonly disposables: Array<{ dispose(): void }> = [];

  constructor(
    readonly axis: AxisIndex,
    grain: THREE.Texture,
  ) {
    if (axis === 0) this.group.rotation.z = -Math.PI / 2;
    if (axis === 2) this.group.rotation.x = Math.PI / 2;

    this.tone = new THREE.Color(SAND[axis].tone);
    this.toneIdle = this.tone.clone().multiplyScalar(0.6);
    this.glow = new THREE.Color(SAND[axis].glow);
    this.glowIdle = this.glow.clone().multiplyScalar(0.4);

    // glass envelope: one closed lathe from -L to +L
    const pts: THREE.Vector2[] = [];
    const N = 112;
    for (let i = 0; i <= N; i++) {
      const t = -1 + (2 * i) / N;
      pts.push(new THREE.Vector2(Math.max(profileR(Math.abs(t)), 0.0005), t * L));
    }
    this.glassMat = new THREE.MeshPhysicalMaterial({
      color: 0x1b3a37,
      metalness: 0,
      roughness: 0.05,
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      clearcoat: 1,
      clearcoatRoughness: 0.03,
      side: THREE.DoubleSide,
      depthWrite: false,
      envMapIntensity: 1.6,
    });
    const latheGeo = new THREE.LatheGeometry(pts, 48);
    const envelope = new THREE.Mesh(latheGeo, this.glassMat);
    envelope.renderOrder = 10;
    this.group.add(envelope);
    this.disposables.push(latheGeo, this.glassMat);

    // Sand stays opaque: transparent materials are sorted per object, and every
    // object here shares the same centre, so anything translucent would flicker.
    this.sandMat = new THREE.MeshStandardMaterial({
      color: this.tone,
      roughness: 0.95,
      metalness: 0,
      envMapIntensity: 0.55,
      emissive: this.glow.clone(),
      side: THREE.DoubleSide,
    });
    this.plus = new SandSurface(this.sandMat);
    this.minus = new SandSurface(this.sandMat);
    this.group.add(this.plus.mesh, this.minus.mesh);
    this.disposables.push(this.sandMat, this.plus, this.minus);

    // the falling column
    const white = new THREE.Color(0xffffff);
    this.streamMat = new THREE.MeshBasicMaterial({
      color: this.tone.clone().lerp(white, 0.35),
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const streamGeo = new THREE.CylinderGeometry(0.013, 0.024, 1, 12, 1, true);
    this.stream = new THREE.Mesh(streamGeo, this.streamMat);
    this.stream.renderOrder = 20;
    this.group.add(this.stream);
    this.disposables.push(streamGeo, this.streamMat);

    // loose grains around the column
    this.grainGeo = new THREE.BufferGeometry();
    this.grainGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(GRAINS * 3), 3));
    this.grainMat = new THREE.PointsMaterial({
      size: 0.035,
      map: grain,
      color: this.tone.clone().lerp(white, 0.65),
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.grains = new THREE.Points(this.grainGeo, this.grainMat);
    this.grains.renderOrder = 30;
    this.grains.frustumCulled = false;
    this.group.add(this.grains);
    this.disposables.push(this.grainGeo, this.grainMat);

    this.phase = new Float32Array(GRAINS);
    this.jitter = new Float32Array(GRAINS * 2);
    for (let i = 0; i < GRAINS; i++) {
      this.phase[i] = Math.random();
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * 0.022;
      this.jitter[i * 2] = Math.cos(a) * r;
      this.jitter[i * 2 + 1] = Math.sin(a) * r;
    }
  }

  /** Sand still available in the upper bulb, 0..1. */
  get remaining(): number {
    return this.gravity > 0 ? 1 - this.fillPlus : this.fillPlus;
  }

  step(dt: number, quaternion: THREE.Quaternion, drain: number): void {
    const pull = -scratch.copy(AXES[this.axis]).applyQuaternion(quaternion).y;
    // Lying flat, `pull` is zero give or take float noise; keeping the last real
    // sign stops the resting sand from flipping between heap and crater shapes.
    if (Math.abs(pull) > 0.05) this.gravity = pull > 0 ? 1 : -1;
    this.gate = smoothstep(0.45, 0.9, Math.abs(pull));

    const flowing = this.gate * (this.remaining > 0 ? 1 : 0);
    if (flowing > 0) {
      const d = (dt / drain) * this.gate;
      this.fillPlus = clamp(this.fillPlus + (this.gravity > 0 ? d : -d), 0, 1);
    }
    this.render(dt, flowing);
  }

  private render(dt: number, flowing: number): void {
    const lower = this.gravity > 0 ? 1 : -1;
    const inLower = this.gravity > 0 ? this.fillPlus : 1 - this.fillPlus;
    const inUpper = 1 - inLower;

    this.drawBulb(lower > 0 ? this.minus : this.plus, -lower, inUpper, false);
    const lowerSurface = this.drawBulb(lower > 0 ? this.plus : this.minus, lower, inLower, true);

    // idle axes keep their colour, just unlit — their sand is visibly parked,
    // not missing
    const active = this.gate > 0.5;
    this.sandMat.color.copy(active ? this.tone : this.toneIdle);
    this.sandMat.emissive.copy(active ? this.glow : this.glowIdle);
    this.glassMat.opacity = active ? 0.55 : 0.34;

    const run = flowing > 0.02 && inUpper > 0.001;
    this.stream.visible = run;
    this.streamMat.opacity = run ? 0.7 * flowing : 0;
    if (run) {
      this.stream.position.set(0, lowerSurface / 2, 0);
      this.stream.scale.set(1, Math.abs(lowerSurface), 1);
    }

    this.grains.visible = run;
    if (run) {
      this.grainMat.opacity = 0.85 * flowing;
      const p = this.grainGeo.attributes.position.array as Float32Array;
      for (let i = 0; i < GRAINS; i++) {
        this.phase[i] = (this.phase[i] + dt * (1.7 + (i % 7) * 0.09)) % 1;
        const f = this.phase[i];
        const spread = 0.35 + f * 0.9;
        p[i * 3] = this.jitter[i * 2] * spread;
        p[i * 3 + 1] = lowerSurface * f * f;
        p[i * 3 + 2] = this.jitter[i * 2 + 1] * spread;
      }
      this.grainGeo.attributes.position.needsUpdate = true;
    }
  }

  /** @returns local Y of the free surface at the centre */
  private drawBulb(surface: SandSurface, sign: number, share: number, isLower: boolean): number {
    const vol = clamp(share * CAPACITY, 0, 1);
    if (vol < 0.004) {
      surface.mesh.visible = false;
      return sign * 0.02 * L;
    }
    surface.mesh.visible = true;

    if (isLower) {
      // sand rests against the far end and piles up toward the neck
      const t = levelAt(1 - vol);
      const heap = Math.min(innerR(t) / 0.8, 0.2, Math.max(t - 0.03, 0));
      surface.update(sign, 1, t, heap, 1);
      return sign * (t - heap) * L;
    }
    // sand sits on the neck; the funnel above the hole only forms as it drains,
    // so a freshly turned bulb reads as full rather than as a cone
    const t = levelAt(vol);
    const dug = smoothstep(1, 0.55, share);
    const crater = Math.min(innerR(t) * 0.85, Math.max(t - 0.02, 0)) * dug;
    surface.update(sign, 0, t, crater, 1.9);
    return sign * (t - crater) * L;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}

export class HourglassDie {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly die = new THREE.Group();
  private readonly glasses: Hourglass[];
  private readonly envMap: THREE.Texture;
  private readonly grain: THREE.Texture;
  private readonly disposables: Array<{ dispose(): void }> = [];
  private readonly observer: ResizeObserver;

  private readonly reducedMotion: boolean;
  private readonly drain: number;
  private readonly onSettle?: (axis: AxisIndex) => void;
  private readonly onRollStart?: () => void;

  private pixelRatio: number;
  private running = false;
  private autoCycle = true;
  private lastTime = 0;
  private pending = 0;
  private elapsed = 0;
  private sampled = 0;
  private slow = 0;

  private orbit = Math.PI * 0.28;
  private pointerX = 0;
  private pointerY = 0;
  private aimX = 0;
  private aimY = 0;

  private readonly roll = {
    active: false,
    t: 0,
    duration: 1.15,
    from: new THREE.Quaternion(),
    to: new THREE.Quaternion(),
    wobbleAxis: new THREE.Vector3(),
    wobble: 0,
    cooldown: 0,
  };
  private readonly spin = new THREE.Quaternion();

  constructor(
    private readonly container: HTMLElement,
    options: DieOptions = {},
  ) {
    this.reducedMotion = options.reducedMotion ?? false;
    this.drain = options.drainSeconds ?? 11;
    this.onSettle = options.onSettle;
    this.onRollStart = options.onRollStart;
    this.roll.duration = this.reducedMotion ? 0.35 : 1.15;

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    });
    /* The scene is fill-bound — five large blended surfaces stacked over the same
       pixels — so resolution is the cheapest lever. Start at 1.5x rather than the
       full 2x a retina panel reports, and step down once if frames stay slow. */
    this.pixelRatio = Math.min(window.devicePixelRatio, 1.5);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;
    // absolute so the advantage chips can sit over the same box
    this.renderer.domElement.style.position = 'absolute';
    this.renderer.domElement.style.inset = '0';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);

    this.envMap = this.buildEnvironment();
    this.scene.environment = this.envMap;

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.08));
    const key = new THREE.DirectionalLight(0xffffff, 0.85);
    key.position.set(3, 6, 4);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x58e6b8, 0.45);
    rim.position.set(-4, -1, -3);
    this.scene.add(rim);

    this.scene.add(this.die);
    this.buildShell();
    this.grain = this.buildGrainTexture();
    this.glasses = [new Hourglass(0, this.grain), new Hourglass(1, this.grain), new Hourglass(2, this.grain)];
    for (const h of this.glasses) this.die.add(h.group);

    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
    this.resize();

    container.addEventListener('pointermove', this.handlePointer);
    container.addEventListener('pointerleave', this.handlePointerLeave);

    // Start face-down on Y with every charge in its +end bulb, which the identity
    // orientation puts on top — so the Y hourglass is already running.
    this.render(0);
    this.onSettle?.(1);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.renderer.setAnimationLoop(this.tick);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.renderer.setAnimationLoop(null);
  }

  /** Stop the die picking its own faces — the visitor is driving now. */
  setAutoCycle(on: boolean): void {
    this.autoCycle = on;
  }

  /** Roll so `axis` stands vertical, landing with sand in the upper bulb. */
  setActive(axis: AxisIndex): void {
    if (this.roll.active) return;
    if (this.activeIndex() === axis && this.glasses[axis].remaining > 0.02) return;
    this.startRoll(axis);
  }

  dispose(): void {
    this.stop();
    this.observer.disconnect();
    this.container.removeEventListener('pointermove', this.handlePointer);
    this.container.removeEventListener('pointerleave', this.handlePointerLeave);
    for (const h of this.glasses) h.dispose();
    for (const d of this.disposables) d.dispose();
    this.grain.dispose();
    this.envMap.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  /* ---------------------------------------------------------------- */

  private handlePointer = (e: PointerEvent) => {
    const r = this.container.getBoundingClientRect();
    this.aimX = ((e.clientX - r.left) / r.width) * 2 - 1;
    this.aimY = ((e.clientY - r.top) / r.height) * 2 - 1;
  };

  private handlePointerLeave = () => {
    this.aimX = 0;
    this.aimY = 0;
  };

  private resize(): void {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  private buildEnvironment(): THREE.Texture {
    const env = new THREE.Scene();
    const box = new THREE.BoxGeometry(1, 1, 1);
    const materials: THREE.Material[] = [];
    const lit = (hex: number, gain: number) => {
      const m = new THREE.MeshBasicMaterial({ color: new THREE.Color(hex).multiplyScalar(gain) });
      materials.push(m);
      return m;
    };
    const put = (mat: THREE.Material, sx: number, sy: number, sz: number, x: number, y: number, z: number) => {
      const m = new THREE.Mesh(box, mat);
      m.scale.set(sx, sy, sz);
      m.position.set(x, y, z);
      env.add(m);
    };
    const roomMat = new THREE.MeshBasicMaterial({ color: 0x08080a, side: THREE.BackSide });
    materials.push(roomMat);
    const room = new THREE.Mesh(box, roomMat);
    room.scale.setScalar(22);
    env.add(room);

    put(lit(0xffffff, 1.5), 9, 0.1, 9, 0, 7, 0); // key, overhead
    put(lit(0x58e6b8, 1.1), 0.1, 6, 7, -6, 0.5, 0); // mint, left
    put(lit(0x3aa3ff, 0.9), 0.1, 6, 7, 6, 0.5, 0); // stream blue, right
    put(lit(0xffffff, 0.45), 7, 5, 0.1, 0, 1, -6.5); // rim, behind
    put(lit(0x16262b, 1.0), 9, 0.1, 9, 0, -7, 0); // floor bounce

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const rt = pmrem.fromScene(env, 0.03);
    pmrem.dispose();
    box.dispose();
    for (const m of materials) m.dispose();
    return rt.texture;
  }

  private buildShell(): void {
    /* The shell is drawn as two passes — far faces first, near faces last — so
       the contents sort correctly between them. `transmission` is deliberately
       not used: three leaves transparent objects out of the transmission buffer,
       which would erase the hourglasses inside. */
    const geometry = new RoundedBoxGeometry(2 * S, 2 * S, 2 * S, 6, 0.09);
    /* Additive: the panes contribute their reflections and nothing else, so the
       walls read as glass instead of fogging the contents grey. */
    const shellMaterial = (side: THREE.Side, opacity: number, iridescence: number) =>
      new THREE.MeshPhysicalMaterial({
        color: 0x0c1a1c,
        metalness: 0,
        roughness: 0.04,
        iridescence,
        iridescenceIOR: 1.34,
        clearcoat: 1,
        clearcoatRoughness: 0.02,
        transparent: true,
        opacity,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side,
        envMapIntensity: 1.7,
      });

    const farMat = shellMaterial(THREE.BackSide, 0.35, 0);
    const nearMat = shellMaterial(THREE.FrontSide, 0.6, 0.7);
    const far = new THREE.Mesh(geometry, farMat);
    far.renderOrder = 0;
    const near = new THREE.Mesh(geometry, nearMat);
    near.renderOrder = 40;
    this.die.add(far, near);

    const edgeGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(1.944, 1.944, 1.944));
    const edgeMat = new THREE.LineBasicMaterial({
      color: 0x58e6b8,
      transparent: true,
      opacity: 0.34,
      depthWrite: false,
    });
    const edges = new THREE.LineSegments(edgeGeo, edgeMat);
    edges.renderOrder = 41;
    this.die.add(edges);

    // Where the three necks cross. Also hides the only place the envelopes touch.
    const nodeGeo = new THREE.IcosahedronGeometry(0.062, 2);
    const nodeMat = new THREE.MeshPhysicalMaterial({
      color: 0x101014,
      metalness: 0.9,
      roughness: 0.22,
      emissive: 0x0d3a2e,
    });
    this.die.add(new THREE.Mesh(nodeGeo, nodeMat));

    this.disposables.push(geometry, farMat, nearMat, edgeGeo, edgeMat, nodeGeo, nodeMat);
  }

  private buildGrainTexture(): THREE.Texture {
    const c = document.createElement('canvas');
    c.width = 32;
    c.height = 32;
    const ctx = c.getContext('2d');
    if (ctx) {
      const g = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.35, 'rgba(255,255,255,0.7)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 32, 32);
    }
    return new THREE.CanvasTexture(c);
  }

  private activeIndex(): AxisIndex {
    let best: AxisIndex = 1;
    let bestPull = -1;
    for (let i = 0; i < 3; i++) {
      const pull = Math.abs(scratch.copy(AXES[i]).applyQuaternion(this.die.quaternion).y);
      if (pull > bestPull) {
        bestPull = pull;
        best = i as AxisIndex;
      }
    }
    return best;
  }

  private startRoll(axis: AxisIndex): void {
    // Land with the fuller bulb on top, so the hourglass always has something to run.
    const sgn = this.glasses[axis].fillPlus >= 0.5 ? -1 : 1;
    const down = AXES[axis].clone().multiplyScalar(sgn);
    const land = new THREE.Quaternion().setFromUnitVectors(down, DOWN);
    const twist = new THREE.Quaternion().setFromAxisAngle(DOWN, (Math.floor(Math.random() * 4) * Math.PI) / 2);
    this.roll.from.copy(this.die.quaternion);
    this.roll.to.copy(twist.multiply(land));
    this.roll.wobbleAxis.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
    this.roll.wobble = this.reducedMotion
      ? 0
      : (Math.random() < 0.5 ? -1 : 1) * Math.PI * (1.1 + Math.random() * 0.6);
    this.roll.t = 0;
    this.roll.active = true;
    this.roll.cooldown = 0;
    this.onRollStart?.();
  }

  private stepRoll(dt: number): void {
    if (!this.roll.active) return;
    this.roll.t = Math.min(1, this.roll.t + dt / this.roll.duration);
    const t = this.roll.t;
    const e = t < 0.5 ? 4 * t ** 3 : 1 - Math.pow(-2 * t + 2, 3) / 2; // easeInOutCubic
    this.die.quaternion.slerpQuaternions(this.roll.from, this.roll.to, e);
    this.spin.setFromAxisAngle(this.roll.wobbleAxis, this.roll.wobble * Math.sin(Math.PI * e));
    this.die.quaternion.multiply(this.spin);
    this.die.position.y = this.reducedMotion ? 0 : Math.sin(Math.PI * e) * 0.42;
    if (this.roll.t >= 1) {
      this.roll.active = false;
      this.die.quaternion.copy(this.roll.to);
      this.die.position.y = 0;
      this.onSettle?.(this.activeIndex());
    }
  }

  /* Cap at 60fps. A 120Hz panel would otherwise ask for twice the frames for an
     animation that gains nothing from them. The threshold sits well below 16.7ms
     so a jittery 60Hz display never trips it and drops to 30. */
  private tick = () => {
    const now = performance.now();
    const raw = Math.min((now - this.lastTime) / 1000, 0.05);
    this.lastTime = now;
    this.pending += raw;
    if (this.pending < 1 / 70) return;
    const dt = this.pending;
    this.pending = 0;
    this.watchFrames(dt);
    this.render(dt);
  };

  // One-way quality step-down: sample two seconds of frames, and if a third of
  // them missed 24ms, drop to 1x and stop measuring.
  private watchFrames(dt: number): void {
    if (this.pixelRatio <= 1) return;
    this.sampled++;
    if (dt > 0.024) this.slow++;
    if (this.sampled < 120) return;
    if (this.slow > 40) {
      this.pixelRatio = 1;
      this.renderer.setPixelRatio(1);
    }
    this.sampled = 0;
    this.slow = 0;
  }

  private render(dt: number): void {
    this.elapsed += dt;

    this.stepRoll(dt);
    if (!this.roll.active && !this.reducedMotion) {
      this.die.position.y = Math.sin(this.elapsed * 0.9) * 0.025;
    }

    for (const h of this.glasses) h.step(dt, this.die.quaternion, this.drain);

    const active = this.glasses[this.activeIndex()];
    if (!this.roll.active) {
      if (active.remaining <= 0.001 || active.gate < 0.4) this.roll.cooldown += dt;
      else this.roll.cooldown = 0;
      if (this.autoCycle && this.roll.cooldown > 0.9) {
        const next = CYCLE[(CYCLE.indexOf(active.axis) + 1) % CYCLE.length];
        this.startRoll(next);
      }
    }

    // Camera orbits the die rather than the die spinning: the face that landed
    // down has to stay down, or the metaphor breaks.
    if (!this.reducedMotion) this.orbit += dt * 0.12;
    this.pointerX += (this.aimX - this.pointerX) * Math.min(1, dt * 3);
    this.pointerY += (this.aimY - this.pointerY) * Math.min(1, dt * 3);
    const radius = 7.8;
    this.camera.position.set(
      Math.sin(this.orbit) * radius + this.pointerX * 0.35,
      2.5 - this.pointerY * 0.3,
      Math.cos(this.orbit) * radius,
    );
    this.camera.lookAt(0, 0, 0);

    /* The chips read these to drift with the die. Writing CSS variables keeps
       the parallax out of React — no per-frame re-render. */
    const style = this.container.style;
    style.setProperty('--die-x', (Math.sin(this.orbit) * 0.5 + this.pointerX * 0.5).toFixed(3));
    style.setProperty('--die-y', (Math.cos(this.orbit * 0.7) * 0.5 - this.pointerY * 0.5).toFixed(3));

    this.renderer.render(this.scene, this.camera);
  }
}
