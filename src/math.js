/***************************************************************************
 * 1. DETERMINISTIC PRNG & 2D SIMPLEX/GRADIENT NOISE ENGINE
 ***************************************************************************/
export class SeededRNG {
  /**
   * @param {string} seedStr
   */
  constructor(seedStr) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < seedStr.length; i++) {
      h = Math.imul(h ^ seedStr.charCodeAt(i), 16777619);
    }
    /** @type {number} */
    this.state = h >>> 0 || 123456789;
  }
  /**
   * @returns {number}
   */
  next() {
    // Mulberry32
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /**
   * @param {number} min
   * @param {number} max
   * @returns {number}
   */
  range(min, max) {
    return min + this.next() * (max - min);
  }
  /**
   * @param {number} min
   * @param {number} max
   * @returns {number}
   */
  int(min, max) {
    return Math.floor(this.range(min, max + 1));
  }
  /**
   * @template T
   * @param {readonly T[]} arr
   * @returns {T}
   */
  pick(arr) {
    return arr[Math.floor(this.next() * arr.length)];
  }
}

export class FastNoise2D {
  /**
   * @param {SeededRNG} rng
   */
  constructor(rng) {
    /** @type {Uint8Array} */
    this.perm = new Uint8Array(512);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng.next() * (i + 1));
      const tmp = p[i];
      p[i] = p[j];
      p[j] = tmp;
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }
  /**
   * @param {number} t
   * @returns {number}
   */
  fade(t) {
    return t * t * t * (t * (t * 6 - 15) + 10);
  }
  /**
   * @param {number} a
   * @param {number} b
   * @param {number} t
   * @returns {number}
   */
  lerp(a, b, t) {
    return a + t * (b - a);
  }
  /**
   * @param {number} hash
   * @param {number} x
   * @param {number} y
   * @returns {number}
   */
  grad(hash, x, y) {
    const h = hash & 7;
    const u = h < 4 ? x : y;
    const v = h < 4 ? y : x;
    return ((h & 1) !== 0 ? -u : u) + ((h & 2) !== 0 ? -2.0 * v : 2.0 * v);
  }
  /**
   * @param {number} x
   * @param {number} y
   * @returns {number}
   */
  noise(x, y) {
    const X = Math.floor(x) & 255;
    const Y = Math.floor(y) & 255;
    x -= Math.floor(x);
    y -= Math.floor(y);
    const u = this.fade(x);
    const v = this.fade(y);
    const A = this.perm[X] + Y;
    const B = this.perm[X + 1] + Y;
    const res = this.lerp(
      this.lerp(
        this.grad(this.perm[A], x, y),
        this.grad(this.perm[B], x - 1, y),
        u,
      ),
      this.lerp(
        this.grad(this.perm[A + 1], x, y - 1),
        this.grad(this.perm[B + 1], x - 1, y - 1),
        u,
      ),
      v,
    );
    return Math.max(0, Math.min(1, res * 0.5 + 0.5)); // strictly clamped [0, 1]
  }
  /**
   * @param {number} x
   * @param {number} y
   * @param {number} [octaves]
   * @param {number} [persistence]
   * @param {number} [lacunarity]
   * @returns {number}
   */
  fbm(x, y, octaves = 4, persistence = 0.5, lacunarity = 2.0) {
    let total = 0;
    let frequency = 1;
    let amplitude = 1;
    let maxValue = 0;
    for (let i = 0; i < octaves; i++) {
      total += this.noise(x * frequency, y * frequency) * amplitude;
      maxValue += amplitude;
      amplitude *= persistence;
      frequency *= lacunarity;
    }
    return total / maxValue;
  }

  /**
   * 2D Gradient Noise with Analytic Partial Derivatives `(val, dx, dy)`
   * (Inigo Quilez formulation using quintic C2 fade curve `6t^5 - 15t^4 + 10t^3` and `dfade/dt = 30t^2(t-1)^2`).
   * @param {number} x
   * @param {number} y
   * @returns {{ val: number, dx: number, dy: number }}
   */
  noiseDeriv(x, y) {
    const X = Math.floor(x) & 255;
    const Y = Math.floor(y) & 255;
    const fx = x - Math.floor(x);
    const fy = y - Math.floor(y);

    const u = this.fade(fx);
    const v = this.fade(fy);
    const du = 30.0 * fx * fx * (fx - 1.0) * (fx - 1.0);
    const dv = 30.0 * fy * fy * (fy - 1.0) * (fy - 1.0);

    const A = this.perm[X] + Y;
    const B = this.perm[X + 1] + Y;
    const va = this.grad(this.perm[A], fx, fy);
    const vb = this.grad(this.perm[B], fx - 1, fy);
    const vc = this.grad(this.perm[A + 1], fx, fy - 1);
    const vd = this.grad(this.perm[B + 1], fx - 1, fy - 1);

    const k0 = va;
    const k1 = vb - va;
    const k2 = vc - va;
    const k3 = va - vb - vc + vd;

    const rawVal = k0 + k1 * u + k2 * v + k3 * u * v;
    const dx = (k1 + k3 * v) * du * 0.5;
    const dy = (k2 + k3 * u) * dv * 0.5;
    return {
      val: Math.max(0, Math.min(1, rawVal * 0.5 + 0.5)),
      dx,
      dy,
    };
  }

  /**
   * Inigo Quilez Analytic Derivative-Eroded fBm (`1 / (1 + k * |∇H|²)`):
   * Suppresses high-frequency octaves on steep slopes to produce wide, flat-bottomed
   * alluvial valleys and sharp, water-eroded mountain ridge crests in a single pass.
   * @param {number} x
   * @param {number} y
   * @param {number} [octaves]
   * @param {number} [erosionStrength]
   * @returns {number}
   */
  fbmEroded(x, y, octaves = 5, erosionStrength = 1.45) {
    let total = 0;
    let maxWeight = 0;
    let amp = 0.52;
    let px = x;
    let py = y;
    let sumDx = 0;
    let sumDy = 0;

    // 2D octave rotation matrix (cos ≈ 0.8, sin ≈ 0.6) to break grid axis alignment across octaves
    for (let i = 0; i < octaves; i++) {
      const n = this.noiseDeriv(px, py);
      sumDx += n.dx;
      sumDy += n.dy;
      const slopeAtten =
        1.0 / (1.0 + erosionStrength * (sumDx * sumDx + sumDy * sumDy));
      total += amp * n.val * slopeAtten;
      maxWeight += amp * 0.82;
      amp *= 0.5;
      const nx = (0.8 * px - 0.6 * py) * 2.02;
      const ny = (0.6 * px + 0.8 * py) * 2.02;
      px = nx;
      py = ny;
    }
    return Math.max(0, Math.min(1, total / (maxWeight || 1)));
  }
}

/***************************************************************************
 * 2. FLAT TYPED-ARRAY MIN-HEAP
 ***************************************************************************/
/**
 * High-performance binary min-heap backed by flat typed arrays (Int32Array & Float64Array).
 * Eliminates GC pressure and per-node object allocations during A* and Priority-Flood passes.
 */
export class FlatMinHeap {
  /**
   * @param {number} [initialCapacity]
   */
  constructor(initialCapacity = 1024) {
    /** @type {number} */
    this._capacity = Math.max(1, initialCapacity || 1024);
    /** @type {Int32Array} */
    this._nodes = new Int32Array(this._capacity);
    /** @type {Float64Array} */
    this._prios = new Float64Array(this._capacity);
    /** @type {number} */
    this._size = 0;
  }

  /**
   * Current number of elements in the heap.
   * @returns {number}
   */
  get size() {
    return this._size;
  }

  /**
   * Reset the heap to empty state without releasing underlying typed arrays.
   * @returns {void}
   */
  clear() {
    this._size = 0;
  }

  /**
   * Push a node ID and its priority onto the min-heap.
   * @param {number} id
   * @param {number} priority
   * @returns {void}
   */
  push(id, priority) {
    if (this._size >= this._capacity) {
      this._grow();
    }
    let i = this._size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this._prios[p] <= priority) break;
      this._nodes[i] = this._nodes[p];
      this._prios[i] = this._prios[p];
      i = p;
    }
    this._nodes[i] = id;
    this._prios[i] = priority;
  }

  /**
   * Pop and return the node ID with the minimum priority.
   * @returns {number} Node ID, or -1 if the heap is empty.
   */
  pop() {
    if (this._size === 0) return -1;
    const top = this._nodes[0];
    this._size--;
    if (this._size > 0) {
      const lastN = this._nodes[this._size];
      const lastP = this._prios[this._size];
      let i = 0;
      const n = this._size;
      while ((i << 1) + 1 < n) {
        let c = (i << 1) + 1;
        if (c + 1 < n && this._prios[c + 1] < this._prios[c]) c++;
        if (lastP <= this._prios[c]) break;
        this._nodes[i] = this._nodes[c];
        this._prios[i] = this._prios[c];
        i = c;
      }
      this._nodes[i] = lastN;
      this._prios[i] = lastP;
    }
    return top;
  }

  /**
   * Doubles the backing buffer capacity.
   * @private
   * @returns {void}
   */
  _grow() {
    const newCap = Math.max(4, this._capacity << 1);
    const newNodes = new Int32Array(newCap);
    const newPrios = new Float64Array(newCap);
    newNodes.set(this._nodes);
    newPrios.set(this._prios);
    this._capacity = newCap;
    this._nodes = newNodes;
    this._prios = newPrios;
  }
}
