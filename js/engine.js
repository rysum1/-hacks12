// ===========================================================================
// Sculpting engine: the stone block as a signed distance field on a 3D
// grid, the tools that change it (chisel, hammer, sandpaper, paint), meshing
// (Surface Nets), and saving/loading sculptures. No Three.js in here, so the
// studio and the gallery viewer can both use it.
// ===========================================================================
// ---------------------------------------------------------------------------
// SculptVolume: the "clay". Stores a signed distance field (SDF) on a 3D grid.
//   field < 0  -> inside the material
//   field > 0  -> empty space
// Carving/adding are just min/max operations with a sphere SDF, and the
// visible surface is extracted with Surface Nets (a simpler cousin of
// Marching Cubes that gives smooth, watertight meshes).
// ---------------------------------------------------------------------------
// Small 3D value-noise helpers (used for rough, irregular fracture surfaces).
function hash3i(x, y, z, seed) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 1440662683) + Math.imul(seed, 1103515245)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise3(x, y, z, seed) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  let fx = x - xi, fy = y - yi, fz = z - zi;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
  const l = (a, b, t) => a + (b - a) * t, H = (a, b, c) => hash3i(xi + a, yi + b, zi + c, seed);
  return l(l(l(H(0, 0, 0), H(1, 0, 0), fx), l(H(0, 1, 0), H(1, 1, 0), fx), fy),
           l(l(H(0, 0, 1), H(1, 0, 1), fx), l(H(0, 1, 1), H(1, 1, 1), fx), fy), fz);
}
function fbm3(x, y, z, seed) {
  return 0.6 * vnoise3(x, y, z, seed) + 0.3 * vnoise3(x * 2.1, y * 2.1, z * 2.1, seed + 7) + 0.1 * vnoise3(x * 4.3, y * 4.3, z * 4.3, seed + 13);
}

// The five chip shapes. Each returns a signed-distance function in the chip's
// local frame (u forward, v across, w out of the surface); negative = inside.
// Every shape pokes a little above the surface so the chip breaks cleanly out.
function sdBox(u, v, w, bu, bv, bw) {
  const qu = Math.abs(u) - bu, qv = Math.abs(v) - bv, qw = Math.abs(w) - bw;
  return Math.hypot(Math.max(qu, 0), Math.max(qv, 0), Math.max(qw, 0)) + Math.min(Math.max(qu, qv, qw), 0);
}
const CHIP_SHAPES = ['wedge', 'block', 'shard', 'flake', 'splinter'];
// Each factory takes (size, st) where st = sin(chisel tilt) and returns the
// distance function, tagged with:
//   ext  - half-extents [u, v, w] (for a tight bounding box)
//   thin - its thinnest feature (so the chip's own grid can be fine enough)
const shapeFn = (fn, ext, thin) => Object.assign(fn, { ext, thin });
const CHIP_SDF = {
  // Triangular prism: flat top at the surface, V-shaped bottom, runs across the blade.
  wedge: s => {
    const top = 0.15 * s, half = 0.6 * s, apex = -0.6 * s, hv = 0.5 * s;
    const el = Math.hypot(top - apex, half), nu = (top - apex) / el, nw = -half / el;
    return shapeFn((u, v, w) => Math.max(Math.abs(v) - hv, w - top, (Math.abs(u) - half) * nu + (w - top) * nw) - 0.02 * s,
                   [0.62 * s, 0.52 * s, 0.62 * s], 0.3 * s);
  },
  // Chunky rounded cube.
  block: s => shapeFn((u, v, w) => sdBox(u, v, w + 0.15 * s, 0.45 * s, 0.42 * s, 0.38 * s) - 0.07 * s,
                      [0.52 * s, 0.49 * s, 0.6 * s], 0.4 * s),
  // Four-sided pyramid pointing into the stone.
  shard: s => {
    const top = 0.12 * s, half = 0.5 * s, apex = -0.75 * s;
    const el = Math.hypot(top - apex, half), nx = (top - apex) / el, nw = -half / el;
    const side = (x, w) => (Math.abs(x) - half) * nx + (w - top) * nw;
    return shapeFn((u, v, w) => Math.max(w - top, side(u, w), side(v, w)) - 0.015 * s,
                   [0.52 * s, 0.52 * s, 0.77 * s], 0.25 * s);
  },
  // Thin oval slab - the typical glancing-blow flake.
  flake: (s, st) => {
    const ra = s * (0.9 + 0.4 * st), rb = 0.7 * s, rc = 0.22 * s;
    return shapeFn((u, v, w) => {
      w += 0.05 * s;
      const k0 = Math.hypot(u / ra, v / rb, w / rc), k1 = Math.hypot(u / (ra * ra), v / (rb * rb), w / (rc * rc));
      return k1 > 0 ? k0 * (k0 - 1) / k1 : -rc;
    }, [ra, rb, rc + 0.05 * s], rc);
  },
  // Flat, plank-like sliver lying along the direction of the blow: wide across,
  // thin top-to-bottom, tapering toward both ends. The shallower the strike
  // (past ~65 deg), the longer and thinner it gets, shaved from just under
  // the surface - a skimmed sliver.
  splinter: (s, st) => {
    const shallow = Math.min(1, Math.max(0, (st - 0.9) / 0.096));      // 0 at 65 deg .. 1 at 85 deg
    const th = s * (0.12 - 0.06 * shallow);                             // half-thickness 0.12s -> 0.06s
    const W = s * (0.34 + 0.06 * shallow);                              // half-width at the middle
    const L = s * (0.9 + 0.6 * shallow);                                // half-length 0.9s -> 1.5s
    const sink = th * (0.4 + 0.2 * shallow);                            // how far below the surface
    const bevel = 0.35 * th;                                            // softened edges
    return shapeFn((u, v, w) => {
      w += sink;
      const taper = 1 - 0.55 * (u / L) * (u / L);                       // narrower toward the ends
      return Math.max(Math.abs(v) - W * taper, Math.abs(w) - th + bevel, Math.abs(u) - L) - bevel;
    }, [L, W, th + sink], th);
  },
};

class SculptVolume {
  constructor({ size = [2, 1.2, 1], cell = 0.025, pad = 3 } = {}) {
    this.size = size;
    this.pad = pad;
    this.baseJ = 0;   // set in reset(): grid row of the block's base (the "ground" it stands on)
    this.h = cell;                                         // grid spacing (world units)
    this.n = size.map(s => Math.ceil(s / cell) + 1 + 2 * pad); // points per axis
    this.origin = this.n.map(n => -(n - 1) * cell / 2);    // grid centred on 0,0,0
    this.field = new Float32Array(this.n[0] * this.n[1] * this.n[2]);
    // Paint lives in the same grid: RGBA per point (A = how much paint covers it).
    // Because it's stored in 3D, it stays put when the mesh is rebuilt.
    this.paint = new Uint8Array(this.field.length * 4);
    this.reset();
  }

  // Fill the grid with the SDF of a rectangular prism.
  reset() {
    this.paint.fill(0);
    const [nx, ny, nz] = this.n, h = this.h, o = this.origin;
    this.baseJ = Math.ceil((-this.size[1] / 2 - o[1]) / h) + 1;
    const b = this.size.map(s => s / 2);
    let idx = 0;
    for (let k = 0; k < nz; k++) {
      const qz = Math.abs(o[2] + k * h) - b[2];
      for (let j = 0; j < ny; j++) {
        const qy = Math.abs(o[1] + j * h) - b[1];
        for (let i = 0; i < nx; i++, idx++) {
          const qx = Math.abs(o[0] + i * h) - b[0];
          const ox = Math.max(qx, 0), oy = Math.max(qy, 0), oz = Math.max(qz, 0);
          this.field[idx] = Math.hypot(ox, oy, oz) + Math.min(Math.max(qx, qy, qz), 0);
        }
      }
    }
  }

  // Smooth brush weight: 1 at the centre, easing to 0 at the rim (no hard edge).
  static falloff(t) { if (t >= 1) return 0; const u = 1 - t * t; return u * u; }

  // Grid index range for a box (centre +- half-extents), kept off the shell.
  _rangeBox(center, he) {
    const h = this.h, o = this.origin, lo = [0, 0, 0], hi = [0, 0, 0];
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.max(1, Math.floor((center[a] - he[a] - o[a]) / h));
      hi[a] = Math.min(this.n[a] - 2, Math.ceil((center[a] + he[a] - o[a]) / h));
    }
    return { lo, hi };
  }

  // Grid index range covered by a brush, kept off the outer shell of the grid
  // so the mesh can never open up at the boundary.
  _range(center, radius) {
    const h = this.h, o = this.origin, lo = [0, 0, 0], hi = [0, 0, 0];
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.max(1, Math.floor((center[a] - radius - o[a]) / h));
      hi[a] = Math.min(this.n[a] - 2, Math.ceil((center[a] + radius - o[a]) / h));
    }
    return { lo, hi };
  }

  // Carve or add material. `depth` is how far the surface moves at the brush
  // centre for this one dab; it fades smoothly to nothing at the rim, which is
  // what makes strokes read as soft grooves instead of chains of round pits.
  brush(center, radius, depth, mode) {
    const [nx, ny] = this.n, h = this.h, o = this.origin, f = this.field;
    const { lo, hi } = this._range(center, radius);
    const sign = mode === 'add' ? -1 : 1;     // raising the field removes material
    for (let k = lo[2]; k <= hi[2]; k++) {
      const dz = o[2] + k * h - center[2];
      for (let j = lo[1]; j <= hi[1]; j++) {
        const dy = o[1] + j * h - center[1];
        let idx = lo[0] + nx * (j + ny * k);
        for (let i = lo[0]; i <= hi[0]; i++, idx++) {
          const dx = o[0] + i * h - center[0];
          const w = SculptVolume.falloff(Math.sqrt(dx * dx + dy * dy + dz * dz) / radius);
          if (w > 0) f[idx] += sign * depth * w;
        }
      }
    }
  }

  // Relax the field toward the average of its neighbours: sands off ridges,
  // tool marks and stair-steps while keeping the overall shape.
  smooth(center, radius, amount) {
    const [nx, ny] = this.n, h = this.h, o = this.origin, f = this.field;
    const { lo, hi } = this._range(center, radius);
    const sx = hi[0] - lo[0] + 1, sy = hi[1] - lo[1] + 1, sz = hi[2] - lo[2] + 1;
    const out = new Float32Array(sx * sy * sz);
    const Y = nx, Z = nx * ny;
    let t = 0;
    for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++, t++) {
      const idx = i + nx * (j + ny * k);
      const dx = o[0] + i * h - center[0], dy = o[1] + j * h - center[1], dz = o[2] + k * h - center[2];
      const w = amount * SculptVolume.falloff(Math.sqrt(dx * dx + dy * dy + dz * dz) / radius);
      const avg = (f[idx - 1] + f[idx + 1] + f[idx - Y] + f[idx + Y] + f[idx - Z] + f[idx + Z]) / 6;
      out[t] = f[idx] + (avg - f[idx]) * w;
    }
    t = 0;   // write back after reading, so the result doesn't depend on loop order
    for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++, t++)
      f[i + nx * (j + ny * k)] = out[t];
  }

  // Paint onto the surface. Only grid points within ~2 cells of the surface are
  // coloured, so paint is a thin skin: carving through it exposes bare stone.
  // rgb: [0..255]x3, amount: 0..1 coverage per dab, erase: remove paint instead.
  paintSphere(center, radius, rgb, amount, erase = false) {
    const [nx, ny] = this.n, h = this.h, o = this.origin, f = this.field, P = this.paint;
    const { lo, hi } = this._range(center, radius);
    const band = 2 * h;
    for (let k = lo[2]; k <= hi[2]; k++) {
      const dz = o[2] + k * h - center[2];
      for (let j = lo[1]; j <= hi[1]; j++) {
        const dy = o[1] + j * h - center[1];
        let idx = lo[0] + nx * (j + ny * k);
        for (let i = lo[0]; i <= hi[0]; i++, idx++) {
          if (f[idx] > band || f[idx] < -band) continue;
          const dx = o[0] + i * h - center[0];
          const w = amount * SculptVolume.falloff(Math.sqrt(dx * dx + dy * dy + dz * dz) / radius);
          if (w <= 0) continue;
          const q = idx * 4, a = P[q + 3] / 255;
          if (erase) { P[q + 3] = Math.floor(P[q + 3] * (1 - w)); continue; }
          const t = a > 0 ? w : 1;                       // unpainted: take the colour outright
          for (let c = 0; c < 3; c++) P[q + c] = Math.round(P[q + c] + (rgb[c] - P[q + c]) * t);
          P[q + 3] = Math.min(255, Math.ceil(255 * (a + (1 - a) * w)));
        }
      }
    }
  }

  // Field value at any world point (trilinear); outside the grid = empty space.
  sample(x, y, z) {
    const [nx, ny, nz] = this.n, h = this.h, o = this.origin, f = this.field;
    const gx = (x - o[0]) / h, gy = (y - o[1]) / h, gz = (z - o[2]) / h;
    if (gx < 0 || gy < 0 || gz < 0 || gx >= nx - 1 || gy >= ny - 1 || gz >= nz - 1) return 1;
    const i = gx | 0, j = gy | 0, k = gz | 0, fx = gx - i, fy = gy - j, fz = gz - k;
    const b = i + nx * (j + ny * k), Y = nx, Z = nx * ny;
    const l = (a, c, t) => a + (c - a) * t;
    return l(l(l(f[b], f[b + 1], fx), l(f[b + Y], f[b + Y + 1], fx), fy),
             l(l(f[b + Z], f[b + Z + 1], fx), l(f[b + Z + Y], f[b + Z + Y + 1], fx), fy), fz);
  }
  // Outward direction at a point (unit), from the field gradient.
  gradient(x, y, z) {
    const e = this.h;
    const g = [this.sample(x + e, y, z) - this.sample(x - e, y, z),
               this.sample(x, y + e, z) - this.sample(x, y - e, z),
               this.sample(x, y, z + e) - this.sample(x, y, z - e)];
    const len = Math.hypot(g[0], g[1], g[2]) || 1;
    return [g[0] / len, g[1] / len, g[2] / len];
  }

  // Copy a box of the grid out as its own small grid (used for broken pieces).
  // keep(idx, value) decides the piece's field value at each point.
  _cutOut(lo, hi, keep) {
    const [nx, ny] = this.n, h = this.h, o = this.origin, f = this.field, P = this.paint;
    const sn = [hi[0] - lo[0] + 1, hi[1] - lo[1] + 1, hi[2] - lo[2] + 1];
    const field = new Float32Array(sn[0] * sn[1] * sn[2]);
    const paint = new Uint8Array(field.length * 4);
    let t = 0, count = 0;
    for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) for (let i = lo[0]; i <= hi[0]; i++, t++) {
      const idx = i + nx * (j + ny * k);
      let v = keep(idx, i, j, k);
      // The piece's outer shell must be empty so its mesh is closed.
      if (i === lo[0] || i === hi[0] || j === lo[1] || j === hi[1] || k === lo[2] || k === hi[2]) v = Math.max(v, h);
      field[t] = v;
      if (v < 0) count++;
      paint[t * 4] = P[idx * 4]; paint[t * 4 + 1] = P[idx * 4 + 1];
      paint[t * 4 + 2] = P[idx * 4 + 2]; paint[t * 4 + 3] = P[idx * 4 + 3];
    }
    return { field, paint, n: sn, h, count,
             origin: [o[0] + lo[0] * h, o[1] + lo[1] * h, o[2] + lo[2] * h] };
  }

  // Strike with a chisel. Removes a chip of one of the CHIP_SHAPES from the
  // stone and returns that chip as its own grid (or null if the blow hit
  // nothing solid). The hole and the falling chip are the same shape.
  //   tip   - point on the surface where the blade lands
  //   n     - outward surface normal (unit)
  //   t     - unit tangent the chip breaks toward (away from the handle)
  //   tilt  - radians: 0 = driven straight in (pit), larger = glancing (long flake)
  //   size  - chip size in world units, rough - 0..1 surface grit, seed - random seed
  //   shape - one of CHIP_SHAPES
  chisel(tip, n, t, tilt, size, rough, seed, shape = 'wedge') {
    const setup = this._chipSetup(tip, n, t, tilt, size, rough, seed, shape);
    const piece = this._chipGrid(setup);
    if (!piece.bitStone) return null;                        // blade hit only air
    // The block loses the chip. The hole is grown by a hair so even a chip
    // thinner than the block's grid still leaves a visible groove.
    const [nx, ny] = this.n, h = this.h, o = this.origin, f = this.field, chip = setup.chip;
    const grow = 0.3 * h;
    const { lo, hi } = this._rangeBox(setup.center, setup.he);
    for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) {
      let idx = lo[0] + nx * (j + ny * k);
      for (let i = lo[0]; i <= hi[0]; i++, idx++)
        f[idx] = Math.max(f[idx], grow - chip(o[0] + i * h, o[1] + j * h, o[2] + k * h));
    }
    return piece;
  }

  // Hammer: knock a rectangular block out of the stone.
  //   c      - point on the surface at the middle of the rectangle
  //   u, v   - unit tangent axes of the rectangle, n - outward normal
  //   hu, hv - half width / half height of the rectangle
  //   depth  - how deep below the surface the cut goes
  // Everything inside that footprint, from the cut line out past the surface,
  // comes away as one piece. apply=false only builds the piece (for previews).
  hammer(c, u, v, n, hu, hv, depth, seed, apply = true) {
    const [nx, ny] = this.n, h = this.h, o = this.origin, f = this.field;
    const outer = 0.3;                                      // reach above the surface (bumps included)
    const cw = (outer - depth) / 2, hw = (outer + depth) / 2;
    const amp = apply ? 0.25 * h : 0, freq = 6;             // faintly rough break faces (skipped in previews)
    const box = (x, y, z) => {
      const dx = x - c[0], dy = y - c[1], dz = z - c[2];
      const lu = dx * u[0] + dy * u[1] + dz * u[2], lv = dx * v[0] + dy * v[1] + dz * v[2], lw = dx * n[0] + dy * n[1] + dz * n[2];
      const d = sdBox(lu, lv, lw - cw, hu, hv, hw);
      return amp ? d + amp * (2 * fbm3(x * freq, y * freq, z * freq, seed) - 1) : d;
    };
    const center = [0, 1, 2].map(a => c[a] + n[a] * cw);
    const he = [0, 1, 2].map(a => Math.abs(u[a]) * hu + Math.abs(v[a]) * hv + Math.abs(n[a]) * hw + amp + 2 * h);
    const { lo, hi } = this._rangeBox(center, he);
    const plo = lo.map(x => Math.max(0, x - 1)), phi = hi.map((x, a) => Math.min(this.n[a] - 1, x + 1));
    let stone = 0;
    // The piece = stone AND box (keeps the stone's real outer faces).
    const piece = this._cutOut(plo, phi, (idx, i, j, k) => {
      const d = box(o[0] + i * h, o[1] + j * h, o[2] + k * h);
      if (d < 0 && f[idx] < 0) stone++;
      return Math.max(f[idx], d);
    });
    if (!stone) return null;
    if (apply) {
      for (let k = lo[2]; k <= hi[2]; k++) for (let j = lo[1]; j <= hi[1]; j++) {
        let idx = lo[0] + nx * (j + ny * k);
        for (let i = lo[0]; i <= hi[0]; i++, idx++) f[idx] = Math.max(f[idx], -box(o[0] + i * h, o[1] + j * h, o[2] + k * h));
      }
    }
    return piece;
  }

  // Same chip as chisel() with the same arguments, without cutting anything:
  // lets the app show exactly what a strike will break off before it happens.
  // Built on a coarser grid so it's fast enough to update while aiming.
  // piece.bitStone === 0 means the blade would only hit air.
  chipPreview(tip, n, t, tilt, size, rough, seed, shape = 'wedge') {
    return this._chipGrid(this._chipSetup(tip, n, t, tilt, size, rough, seed, shape), true);
  }

  _chipSetup(tip, n, t, tilt, size, rough, seed, shape) {
    const h = this.h, st = Math.sin(tilt);
    const b = [n[1] * t[2] - n[2] * t[1], n[2] * t[0] - n[0] * t[2], n[0] * t[1] - n[1] * t[0]];
    // Local chip frame: u = forward (ahead of the blade), v = across, w = out of the surface.
    // Glancing blows shift the chip forward, ahead of where the blade lands.
    const fwd = size * 0.45 * st;
    const cx = tip[0] + t[0] * fwd, cy = tip[1] + t[1] * fwd, cz = tip[2] + t[2] * fwd;
    const sdf = CHIP_SDF[shape](size, st);
    const amp = size * 0.04 * (0.5 + rough), freq = 3 / size;   // a little grit, shape stays clean
    const chip = (x, y, z) => {
      const dx = x - cx, dy = y - cy, dz = z - cz;
      const u = dx * t[0] + dy * t[1] + dz * t[2], v = dx * b[0] + dy * b[1] + dz * b[2], w = dx * n[0] + dy * n[1] + dz * n[2];
      return sdf(u, v, w) + amp * (2 * fbm3(x * freq, y * freq, z * freq, seed) - 1);
    };
    // Axis-aligned box around the (rotated) chip.
    const [eu, ev, ew] = sdf.ext, pad = amp + 2 * h;
    const he = [0, 1, 2].map(a => Math.abs(t[a]) * eu + Math.abs(b[a]) * ev + Math.abs(n[a]) * ew + pad);
    return { chip, he, center: [cx, cy, cz], thin: sdf.thin, shape };
  }

  // The chip gets its OWN grid, built straight from the shape and fine enough
  // for its thinnest part, so slim splinters stay crisp.
  _chipGrid({ chip, he, center, thin, shape }, preview = false) {
    const [nx, ny] = this.n, h = this.h, o = this.origin, P = this.paint;
    const hp = preview ? Math.max(h / 2, Math.min(h, thin / 1.2))
                       : Math.max(h / 4, Math.min(h / 2, thin / 1.5));
    const pn = he.map(e => Math.ceil(2 * e / hp) + 3);
    const po = center.map((c0, a) => c0 - he[a] - hp);
    const pf = new Float32Array(pn[0] * pn[1] * pn[2]), pp = new Uint8Array(pf.length * 4);
    let t0 = 0, count = 0, bitStone = 0;
    for (let k = 0; k < pn[2]; k++) for (let j = 0; j < pn[1]; j++) for (let i = 0; i < pn[0]; i++, t0++) {
      const x = po[0] + i * hp, y = po[1] + j * hp, z = po[2] + k * hp;
      let d = chip(x, y, z);
      if (i === 0 || j === 0 || k === 0 || i === pn[0] - 1 || j === pn[1] - 1 || k === pn[2] - 1) d = Math.max(d, hp);
      pf[t0] = d;
      if (d < 0) { count++; if (this.sample(x, y, z) < 0) bitStone++; }
      // Paint: nearest point of the main grid.
      const gi = Math.min(nx - 1, Math.max(0, Math.round((x - o[0]) / h)));
      const gj = Math.min(ny - 1, Math.max(0, Math.round((y - o[1]) / h)));
      const gk = Math.min(this.n[2] - 1, Math.max(0, Math.round((z - o[2]) / h)));
      const q = (gi + nx * (gj + ny * gk)) * 4;
      pp[t0 * 4] = P[q]; pp[t0 * 4 + 1] = P[q + 1]; pp[t0 * 4 + 2] = P[q + 2]; pp[t0 * 4 + 3] = P[q + 3];
    }
    return { field: pf, paint: pp, n: pn, origin: po, h: hp, count, bitStone, shape };
  }

  // Flood-fill the solid stone starting from the base. Any chunk that isn't
  // connected to the bottom of the block has nothing holding it up, so it is
  // cut out of the block and returned as separate pieces (which then fall).
  detachFloating() {
    const [nx, ny, nz] = this.n, f = this.field, N = f.length, h = this.h;
    const label = new Int32Array(N);            // 0 = not visited
    const queue = new Int32Array(N);            // each chunk ends up as one contiguous run
    const Y = nx, Z = nx * ny, comps = [];
    let tail = 0;
    for (let s = 0; s < N; s++) {
      if (f[s] >= 0 || label[s]) continue;
      const id = comps.length + 1, start = tail;
      const lo = [nx, ny, nz], hi = [0, 0, 0];
      let head = tail, anchored = false;
      label[s] = id; queue[tail++] = s;
      while (head < tail) {
        const q = queue[head++];
        const k = (q / Z) | 0, r = q - k * Z, j = (r / nx) | 0, i = r - j * nx;
        if (j <= this.baseJ) anchored = true;
        if (i < lo[0]) lo[0] = i; if (i > hi[0]) hi[0] = i;
        if (j < lo[1]) lo[1] = j; if (j > hi[1]) hi[1] = j;
        if (k < lo[2]) lo[2] = k; if (k > hi[2]) hi[2] = k;
        // Solid points never sit on the grid's outer shell, so neighbours are in range.
        const nb = [q - 1, q + 1, q - Y, q + Y, q - Z, q + Z];
        for (let m = 0; m < 6; m++) { const qq = nb[m]; if (f[qq] < 0 && !label[qq]) { label[qq] = id; queue[tail++] = qq; } }
      }
      comps.push({ id, start, end: tail, anchored, lo, hi });
    }
    // If the base itself was carved away, the biggest chunk stays put.
    if (comps.length && !comps.some(c => c.anchored))
      comps.reduce((a, c) => (c.end - c.start > a.end - a.start ? c : a)).anchored = true;

    const pieces = [];
    for (const c of comps) {
      if (c.anchored) continue;
      const lo = c.lo.map(v => Math.max(0, v - 2)), hi = c.hi.map((v, a) => Math.min(this.n[a] - 1, v + 2));
      // Inside the box, only this chunk counts as solid.
      pieces.push(this._cutOut(lo, hi, idx => (f[idx] < 0 && label[idx] !== c.id) ? h : f[idx]));
      for (let q = c.start; q < c.end; q++) { const idx = queue[q]; f[idx] = Math.max(-f[idx], 0.25 * h); }
    }
    return pieces;
  }

  snapshot() { return { field: this.field.slice(), paint: this.paint.slice() }; }
  restore(s) { this.field.set(s.field); this.paint.set(s.paint); }

  // Surface Nets: one vertex per grid cell that the surface passes through,
  // one quad per grid edge that crosses the surface.
  mesh() { return SculptVolume.meshGrid(this); }

  // Works on any grid object { field, paint, n, origin, h } - the main block or
  // a small broken-off piece - so fragments are meshed the same way.
  static meshGrid(g) {
    const [nx, ny, nz] = g.n, h = g.h, o = g.origin, f = g.field;
    const cx = nx - 1, cy = ny - 1, cz = nz - 1;
    const pStride = [1, nx, nx * ny];      // point index strides
    const cStride = [1, cx, cx * cy];      // cell index strides
    const cellVert = new Int32Array(cx * cy * cz).fill(-1);
    const pos = [], nrm = [], col = [];
    const P = g.paint;
    const v = new Float32Array(8);
    // Field gradient at a grid point (central differences) = outward normal.
    const gx = (i, j, k) => f[Math.min(i + 1, nx - 1) + nx * (j + ny * k)] - f[Math.max(i - 1, 0) + nx * (j + ny * k)];
    const gy = (i, j, k) => f[i + nx * (Math.min(j + 1, ny - 1) + ny * k)] - f[i + nx * (Math.max(j - 1, 0) + ny * k)];
    const gz = (i, j, k) => f[i + nx * (j + ny * Math.min(k + 1, nz - 1))] - f[i + nx * (j + ny * Math.max(k - 1, 0))];

    // Corner offsets and the 12 cube edges (pairs of corner ids).
    const cornerOff = [];
    for (let c = 0; c < 8; c++) cornerOff.push(pStride[0] * (c & 1) + pStride[1] * ((c >> 1) & 1) + pStride[2] * ((c >> 2) & 1));
    const edges = [];
    for (let c = 0; c < 8; c++) for (let bit = 1; bit < 8; bit <<= 1) if (!(c & bit)) edges.push(c, c | bit);

    // Pass 1: place a vertex in every cell that straddles the surface.
    let vcount = 0;
    for (let k = 0; k < cz; k++) for (let j = 0; j < cy; j++) for (let i = 0; i < cx; i++) {
      const base = i + nx * (j + ny * k);
      let mask = 0;
      for (let c = 0; c < 8; c++) { v[c] = f[base + cornerOff[c]]; if (v[c] < 0) mask |= 1 << c; }
      if (mask === 0 || mask === 255) continue;
      let sx = 0, sy = 0, sz = 0, cnt = 0;
      for (let e = 0; e < 24; e += 2) {
        const a = edges[e], b = edges[e + 1];
        if ((v[a] < 0) === (v[b] < 0)) continue;
        const t = v[a] / (v[a] - v[b]);            // where along the edge f == 0
        sx += (a & 1) + t * ((b & 1) - (a & 1));
        sy += ((a >> 1) & 1) + t * (((b >> 1) & 1) - ((a >> 1) & 1));
        sz += ((a >> 2) & 1) + t * (((b >> 2) & 1) - ((a >> 2) & 1));
        cnt++;
      }
      const fx = sx / cnt, fy = sy / cnt, fz = sz / cnt;
      pos.push(o[0] + (i + fx) * h, o[1] + (j + fy) * h, o[2] + (k + fz) * h);
      // Blend the corner gradients at the vertex position -> smooth shading
      // that follows the true surface rather than the triangle facets.
      let ax = 0, ay = 0, az = 0;
      for (let c = 0; c < 8; c++) {
        const bx = c & 1, by = (c >> 1) & 1, bz = (c >> 2) & 1;
        const w = (bx ? fx : 1 - fx) * (by ? fy : 1 - fy) * (bz ? fz : 1 - fz);
        ax += w * gx(i + bx, j + by, k + bz); ay += w * gy(i + bx, j + by, k + bz); az += w * gz(i + bx, j + by, k + bz);
      }
      const len = Math.hypot(ax, ay, az) || 1;
      nrm.push(ax / len, ay / len, az / len);
      // Paint colour at the vertex: blend the 8 corners, weighted by how much
      // paint each has, so unpainted corners don't darken the colour.
      let pr = 0, pg = 0, pb = 0, pa = 0;
      for (let c = 0; c < 8; c++) {
        const bx = c & 1, by = (c >> 1) & 1, bz = (c >> 2) & 1;
        const q = (base + cornerOff[c]) * 4, a = P[q + 3];
        if (!a) continue;
        const w = (bx ? fx : 1 - fx) * (by ? fy : 1 - fy) * (bz ? fz : 1 - fz) * a;
        pr += w * P[q]; pg += w * P[q + 1]; pb += w * P[q + 2]; pa += w;
      }
      if (pa > 0) col.push(pr / pa, pg / pa, pb / pa, pa);   // pa = weighted coverage (0..255)
      else col.push(0, 0, 0, 0);
      cellVert[i + cx * (j + cy * k)] = vcount++;
    }

    // Pass 2: stitch quads across every sign-changing grid edge.
    const idx = [];
    const p = [0, 0, 0];
    for (p[2] = 0; p[2] < nz; p[2]++) for (p[1] = 0; p[1] < ny; p[1]++) for (p[0] = 0; p[0] < nx; p[0]++) {
      const pi = p[0] + nx * (p[1] + ny * p[2]);
      const f0 = f[pi];
      for (let a = 0; a < 3; a++) {
        const u = (a + 1) % 3, w = (a + 2) % 3;
        if (p[a] >= g.n[a] - 1) continue;
        if (p[u] < 1 || p[u] > g.n[u] - 2 || p[w] < 1 || p[w] > g.n[w] - 2) continue;
        const inside0 = f0 < 0, inside1 = f[pi + pStride[a]] < 0;
        if (inside0 === inside1) continue;
        const cb = p[0] + cx * (p[1] + cy * p[2]);
        const c00 = cellVert[cb - cStride[u] - cStride[w]];
        const c10 = cellVert[cb - cStride[w]];
        const c11 = cellVert[cb];
        const c01 = cellVert[cb - cStride[u]];
        if (inside0) idx.push(c00, c10, c11, c00, c11, c01);   // normal points toward +a
        else         idx.push(c00, c11, c10, c00, c01, c11);   // normal points toward -a
      }
    }
    return { positions: new Float32Array(pos), normals: new Float32Array(nrm),
             colors: Uint8Array.from(col, Math.round), indices: new Uint32Array(idx) };
  }
}

// ---------------------------------------------------------------------------
// Saving and loading sculptures (the .sclp format).
// Layout before gzip:
//   "SCLP" | u8 version | u8 reserved | u16 nx, ny, nz | f64 cell, pad
//   | f64 sizeX, sizeY, sizeZ | int8 field[nx*ny*nz] | u8 paint[nx*ny*nz*4]
// (The settings are float64 so the grid rebuilds to exactly the same size.)
// The field is stored as distance in 1/32ths of a grid cell, clamped to
// +-4 cells: only the area near the surface matters, and the long flat runs
// this creates (plus mostly-empty paint) compress very well.
// ---------------------------------------------------------------------------
const SCLP_VERSION = 1, FIELD_STEPS = 32, SCLP_HEAD = 12 + 8 * 5;

export function encodeSculpture(vol) {
  const N = vol.field.length, head = SCLP_HEAD;
  const buf = new ArrayBuffer(head + N + N * 4), dv = new DataView(buf), u8 = new Uint8Array(buf);
  u8.set([83, 67, 76, 80], 0);                               // "SCLP"
  dv.setUint8(4, SCLP_VERSION);
  dv.setUint16(6, vol.n[0], true); dv.setUint16(8, vol.n[1], true); dv.setUint16(10, vol.n[2], true);
  dv.setFloat64(12, vol.h, true); dv.setFloat64(20, vol.pad, true);
  vol.size.forEach((v, i) => dv.setFloat64(28 + 8 * i, v, true));
  const q = new Int8Array(buf, head, N), k = FIELD_STEPS / vol.h;
  // Never round to 0: the sign (inside vs outside) must survive exactly.
  for (let i = 0; i < N; i++) {
    const f = vol.field[i] * k;
    q[i] = f < 0 ? Math.max(-127, Math.min(-1, Math.round(f))) : Math.min(127, Math.max(1, Math.round(f)));
  }
  u8.set(vol.paint, head + N);
  return u8;
}
export function decodeSculpture(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (String.fromCharCode(...u8.subarray(0, 4)) !== 'SCLP') throw new Error('Not a sculpture file');
  if (dv.getUint8(4) > SCLP_VERSION) throw new Error('Sculpture was made with a newer version');
  const n = [dv.getUint16(6, true), dv.getUint16(8, true), dv.getUint16(10, true)];
  const cell = dv.getFloat64(12, true), pad = dv.getFloat64(20, true);
  const size = [0, 1, 2].map(i => dv.getFloat64(28 + 8 * i, true));
  const vol = new SculptVolume({ size, cell, pad });
  if (vol.n.some((v, i) => v !== n[i])) throw new Error('Sculpture grid does not match');
  const N = vol.field.length, head = SCLP_HEAD, q = new Int8Array(u8.buffer, u8.byteOffset + head, N);
  for (let i = 0; i < N; i++) vol.field[i] = q[i] * cell / FIELD_STEPS;
  vol.paint.set(u8.subarray(head + N, head + N + N * 4));
  return vol;
}
const streamBytes = async (u8, stream) => new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(stream)).arrayBuffer());
export const packSculpture = vol => streamBytes(encodeSculpture(vol), new CompressionStream('gzip'));
export const unpackSculpture = async bytes => decodeSculpture(await streamBytes(bytes, new DecompressionStream('gzip')));

export { SculptVolume, CHIP_SHAPES, CHIP_SDF, sdBox, fbm3 };
