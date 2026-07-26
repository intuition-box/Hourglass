import * as THREE from 'three';
import {
  CAPACITY,
  S,
  SAND_INSET,
  SAND_SPAN,
  clamp,
  drainLevel,
  heapLevel,
  smoothstep,
} from './geometry';

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

const DOWN = new THREE.Vector3(0, -1, 0);
const AXES = [
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(0, 1, 0),
  new THREE.Vector3(0, 0, 1),
] as const;

/** Order the die visits its faces, matching the order the accesses are listed. */
const CYCLE: AxisIndex[] = [1, 0, 2];

/**
 * One value per axis, from the mark's palette: Y light, X mid, Z deep.
 *
 * Not the mark's literal three hexes. Lighting compresses value differences —
 * at the mark's spacing the three faces shade into one green — so the ends are
 * pushed apart until the axes stay legible under shading.
 */
const SAND = [
  { tone: 0x3fd0a2, glow: 0x0d4d3a },
  { tone: 0xc4ffe9, glow: 0x1a7a5c },
  { tone: 0x0e6349, glow: 0x062a20 },
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
 * The sand inside one pyramid: a square frustum between two levels on the axis.
 *
 * Every face keeps the same slope whatever the fill, so the normals are fixed at
 * build time and only 36 positions move — no rebuild, no recompute, no garbage.
 */
class PyramidSand {
  readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.BufferGeometry;
  private readonly position: Float32Array;
  private lo = NaN;
  private hi = NaN;

  constructor(material: THREE.Material) {
    this.position = new Float32Array(36 * 3);
    const normal = new Float32Array(36 * 3);
    const k = Math.SQRT1_2;
    // four walls leaning in at 45°, then the two square caps
    const faces: Array<[number, number, number]> = [
      [k, -k, 0],
      [-k, -k, 0],
      [0, -k, k],
      [0, -k, -k],
      [0, 1, 0],
      [0, -1, 0],
    ];
    for (let f = 0; f < 6; f++) {
      for (let v = 0; v < 6; v++) {
        const i = (f * 6 + v) * 3;
        normal[i] = faces[f][0];
        normal[i + 1] = faces[f][1];
        normal[i + 2] = faces[f][2];
      }
    }
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.position, 3));
    this.geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
    this.mesh = new THREE.Mesh(this.geometry, material);
    this.mesh.frustumCulled = false;
  }

  /**
   * @param sign +1 for the pyramid on +Y, -1 for the one on -Y
   * @param lo   axial distance where the body starts (0 = the apex, at the neck)
   * @param hi   axial distance of the free surface
   */
  update(sign: number, lo: number, hi: number): void {
    const a = sign * lo;
    const b = sign * hi;
    if (this.lo === a && this.hi === b) return;
    this.lo = a;
    this.hi = b;

    // half-width equals distance from the centre — that is what makes the six
    // pyramids tile the cube exactly
    const wLo = lo * SAND_INSET;
    const wHi = hi * SAND_INSET;
    const p = this.position;
    let i = 0;
    const quad = (
      x1: number, y1: number, z1: number,
      x2: number, y2: number, z2: number,
      x3: number, y3: number, z3: number,
      x4: number, y4: number, z4: number,
    ) => {
      p[i++] = x1; p[i++] = y1; p[i++] = z1;
      p[i++] = x2; p[i++] = y2; p[i++] = z2;
      p[i++] = x3; p[i++] = y3; p[i++] = z3;
      p[i++] = x1; p[i++] = y1; p[i++] = z1;
      p[i++] = x3; p[i++] = y3; p[i++] = z3;
      p[i++] = x4; p[i++] = y4; p[i++] = z4;
    };
    const w = sign > 0 ? 1 : -1; // keep the winding outward when the piece flips
    quad(wLo, a, w * wLo, wHi, b, w * wHi, wHi, b, -w * wHi, wLo, a, -w * wLo);
    quad(-wLo, a, -w * wLo, -wHi, b, -w * wHi, -wHi, b, w * wHi, -wLo, a, w * wLo);
    quad(-w * wLo, a, wLo, -w * wHi, b, wHi, w * wHi, b, wHi, w * wLo, a, wLo);
    quad(w * wLo, a, -wLo, w * wHi, b, -wHi, -w * wHi, b, -wHi, -w * wLo, a, -wLo);
    quad(-wHi, b, -w * wHi, wHi, b, -w * wHi, wHi, b, w * wHi, -wHi, b, w * wHi);
    quad(-wLo, a, w * wLo, wLo, a, w * wLo, wLo, a, -w * wLo, -wLo, a, -w * wLo);

    this.geometry.attributes.position.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
  }
}

/**
 * Apex at the origin, square base of half-width `height` at that distance along
 * +Y. The wide radius goes first: CylinderGeometry puts `radiusTop` at +height/2,
 * so passing the zero second is what keeps the apex pointing at the cube's
 * centre rather than out through the middle of a face.
 */
function pyramidGeometry(height: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(height * Math.SQRT2, 0, height, 4, 1);
  g.rotateY(Math.PI / 4); // corners onto the cube's corners
  g.translate(0, height / 2, 0);
  return g;
}

/** One hourglass: two opposite pyramids, apex to apex, on its die axis. */
class Hourglass {
  readonly group = new THREE.Group();
  /** Fraction of the sand charge sitting in the +Y pyramid. */
  fillPlus = 1;
  /** +1 when local +Y points straight down. */
  gravity = -1;
  /** How much of the flow rate gravity allows right now. */
  gate = 0;

  private readonly tone: THREE.Color;
  private readonly toneIdle: THREE.Color;
  private readonly glow: THREE.Color;
  private readonly glowIdle: THREE.Color;
  private readonly glass: readonly THREE.MeshPhysicalMaterial[];
  private readonly sandMat: THREE.MeshStandardMaterial;
  private readonly streamMat: THREE.MeshBasicMaterial;
  private readonly grainMat: THREE.PointsMaterial;
  private readonly plus: PyramidSand;
  private readonly minus: PyramidSand;
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

    /* One glass material per piece, not one per hourglass: a shell only earns
       its place over sand that isn't there. Over a full pyramid it adds nothing
       but a bright rim along the edges, so each fades out as its own sand fills
       it. Additive, because six stacked panes of ordinary transparency would fog
       the core grey. Low clearcoat for the same reason as the fade — a hard
       specular line reads as a border drawn around the volume. */
    const glass = () =>
      new THREE.MeshPhysicalMaterial({
        color: 0x16302e,
        metalness: 0,
        roughness: 0.08,
        transparent: true,
        opacity: 0.26,
        blending: THREE.AdditiveBlending,
        clearcoat: 0.3,
        clearcoatRoughness: 0.2,
        side: THREE.DoubleSide,
        depthWrite: false,
        envMapIntensity: 1.1,
      });
    this.glass = [glass(), glass()]; // [+Y piece, -Y piece]
    const shell = pyramidGeometry(S);
    this.glass.forEach((mat, i) => {
      const piece = new THREE.Mesh(shell, mat);
      if (i === 1) piece.rotation.z = Math.PI;
      piece.renderOrder = 10;
      this.group.add(piece);
    });
    this.disposables.push(shell, ...this.glass);

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
    this.plus = new PyramidSand(this.sandMat);
    this.minus = new PyramidSand(this.sandMat);
    this.group.add(this.plus.mesh, this.minus.mesh);
    this.disposables.push(this.sandMat, this.plus, this.minus);

    // the falling column, square to match the rest of the object
    const white = new THREE.Color(0xffffff);
    this.streamMat = new THREE.MeshBasicMaterial({
      color: this.tone.clone().lerp(white, 0.35),
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const streamGeo = new THREE.CylinderGeometry(0.016, 0.026, 1, 4, 1, true);
    streamGeo.rotateY(Math.PI / 4);
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
      const r = Math.sqrt(Math.random()) * 0.02;
      this.jitter[i * 2] = Math.cos(a) * r;
      this.jitter[i * 2 + 1] = Math.sin(a) * r;
    }
  }

  /** Sand still available in the upper pyramid, 0..1. */
  get remaining(): number {
    return this.gravity > 0 ? 1 - this.fillPlus : this.fillPlus;
  }

  step(dt: number, quaternion: THREE.Quaternion, drain: number): void {
    const pull = -scratch.copy(AXES[this.axis]).applyQuaternion(quaternion).y;
    // Lying flat, `pull` is zero give or take float noise; keeping the last real
    // sign stops the resting sand from flipping ends.
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

    /* Upper pyramid drains into its own apex — the funnel already points the
       right way — so its sand is a pyramid growing from the neck. The lower one
       stacks on its base, so its sand is a frustum climbing toward the neck. */
    const upperTop = drainLevel(inUpper * CAPACITY);
    const lowerTop = heapLevel(inLower * CAPACITY);
    const upper = lower > 0 ? this.minus : this.plus;
    const lowerSand = lower > 0 ? this.plus : this.minus;
    upper.mesh.visible = inUpper * CAPACITY > 0.002;
    lowerSand.mesh.visible = inLower * CAPACITY > 0.002;
    if (upper.mesh.visible) upper.update(-lower, 0, upperTop);
    if (lowerSand.mesh.visible) lowerSand.update(lower, SAND_SPAN, lowerTop);

    // idle axes keep their colour, just unlit — their sand is visibly parked,
    // not missing
    const active = this.gate > 0.5;
    this.sandMat.color.copy(active ? this.tone : this.toneIdle);
    this.sandMat.emissive.copy(active ? this.glow : this.glowIdle);
    // each shell dims as its own pyramid fills, so a solid volume has no rim
    const lit = active ? 0.26 : 0.15;
    this.glass[0].opacity = lit * (1 - clamp(this.fillPlus * CAPACITY, 0, 1));
    this.glass[1].opacity = lit * (1 - clamp((1 - this.fillPlus) * CAPACITY, 0, 1));

    const drop = lower * lowerTop;
    const run = flowing > 0.02 && inUpper > 0.001;
    this.stream.visible = run;
    this.streamMat.opacity = run ? 0.7 * flowing : 0;
    if (run) {
      this.stream.position.set(0, drop / 2, 0);
      this.stream.scale.set(1, Math.abs(drop), 1);
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
        p[i * 3 + 1] = drop * f * f;
        p[i * 3 + 2] = this.jitter[i * 2 + 1] * spread;
      }
      this.grainGeo.attributes.position.needsUpdate = true;
    }
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
  private lastTime = 0;
  private pending = 0;
  private elapsed = 0;
  private sampled = 0;
  private slow = 0;

  private orbit = Math.PI * 0.28;
  private spinDir = 1;
  /** Which end of each axis is the emptier one; -1 for +Y, +1 for -Y. */
  private readonly emptier = [0, 0, 0];
  private pointerX = 0;
  private pointerY = 0;
  private aimX = 0;
  private aimY = 0;

  private readonly roll = {
    active: false,
    t: 0,
    duration: 0.55,
    from: new THREE.Quaternion(),
    to: new THREE.Quaternion(),
  };

  constructor(
    private readonly container: HTMLElement,
    options: DieOptions = {},
  ) {
    this.reducedMotion = options.reducedMotion ?? false;
    this.drain = options.drainSeconds ?? 11;
    this.onSettle = options.onSettle;
    this.onRollStart = options.onRollStart;
    this.roll.duration = this.reducedMotion ? 0.25 : 0.55;

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

  /** Tip the die onto the next face. */
  rollNext(): void {
    if (this.roll.active) return;
    const active = this.glasses[this.activeIndex()];
    this.startRoll(CYCLE[(CYCLE.indexOf(active.axis) + 1) % CYCLE.length]);
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

  /**
   * Turn the shorter way toward the octant where the empty pyramids are.
   *
   * The speed never changes and the camera never stops — it just picks the
   * direction that puts the see-through faces in front of the lens sooner, and
   * so keeps them there longer.
   */
  private chooseSpin(): void {
    const aim = new THREE.Vector3();
    for (let i = 0; i < 3; i++) {
      scratch.copy(AXES[i]).applyQuaternion(this.die.quaternion);
      aim.addScaledVector(scratch, this.glasses[i].fillPlus < 0.5 ? 1 : -1);
    }
    if (aim.x === 0 && aim.z === 0) return; // straight up or down: no azimuth to aim at
    const target = Math.atan2(aim.x, aim.z);
    let delta = (target - this.orbit) % (Math.PI * 2);
    if (delta > Math.PI) delta -= Math.PI * 2;
    if (delta < -Math.PI) delta += Math.PI * 2;
    // dead ahead already: keep going rather than reversing for a hair
    if (Math.abs(delta) > 0.15) this.spinDir = delta > 0 ? 1 : -1;
  }

  private startRoll(axis: AxisIndex): void {
    // Land with the fuller bulb on top, so the hourglass always has something to run.
    const sgn = this.glasses[axis].fillPlus >= 0.5 ? -1 : 1;
    /* Shortest way there: rotate from where that axis currently points to down,
       and compose onto the pose we're in. Deriving the target from the die's rest
       frame instead would spin it most of the way round to land the same face. */
    scratch.copy(AXES[axis]).multiplyScalar(sgn).applyQuaternion(this.die.quaternion);
    const turn = new THREE.Quaternion().setFromUnitVectors(scratch, DOWN);
    this.roll.from.copy(this.die.quaternion);
    this.roll.to.copy(turn.multiply(this.die.quaternion));
    this.roll.t = 0;
    this.roll.active = true;
    this.onRollStart?.();
  }

  private stepRoll(dt: number): void {
    if (!this.roll.active) return;
    this.roll.t = Math.min(1, this.roll.t + dt / this.roll.duration);
    const t = this.roll.t;
    const e = 1 - Math.pow(1 - t, 3); // easeOutCubic — leaves fast, settles soft
    this.die.quaternion.slerpQuaternions(this.roll.from, this.roll.to, e);
    this.die.position.y = this.reducedMotion ? 0 : Math.sin(Math.PI * e) * 0.14;
    if (this.roll.t >= 1) {
      this.roll.active = false;
      this.die.quaternion.copy(this.roll.to);
      this.die.position.y = 0;
      this.chooseSpin();
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

    // The last grain lands and the die goes straight over — a spent hourglass
    // sitting still reads as broken.
    const active = this.glasses[this.activeIndex()];
    if (!this.roll.active && active.remaining <= 0.001) {
      this.startRoll(CYCLE[(CYCLE.indexOf(active.axis) + 1) % CYCLE.length]);
    }

    // Camera orbits the die rather than the die spinning: the face that landed
    // down has to stay down, or the metaphor breaks.
    /* The emptier end of an axis swaps when its glass passes half. That changes
       which side is worth looking at, so re-evaluate the turn then as well as
       after a landing. */
    let swapped = false;
    for (let i = 0; i < 3; i++) {
      const end = this.glasses[i].fillPlus < 0.5 ? 1 : -1;
      if (this.emptier[i] !== end) {
        this.emptier[i] = end;
        swapped = true;
      }
    }
    if (swapped) this.chooseSpin();

    if (!this.reducedMotion) this.orbit += dt * 0.12 * this.spinDir;
    this.pointerX += (this.aimX - this.pointerX) * Math.min(1, dt * 3);
    this.pointerY += (this.aimY - this.pointerY) * Math.min(1, dt * 3);
    const radius = 8.6;
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
