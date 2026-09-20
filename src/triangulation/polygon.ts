// SPDX-License-Identifier: Apache-2.0
/**
 * Polygon-with-holes triangulation by ear clipping.
 *
 * Pipeline: loop cleanup → orientation normalisation (outer CCW, holes CW) →
 * convex fast path → hole bridging (rightmost hole vertex, +X ray, visible
 * outer vertex) → ear clipping on a doubly linked list → degenerate-vertex
 * filtering → forced-ear fallback. The fallback guarantees termination on
 * self-intersecting or numerically hostile input; callers are told how many
 * ears had to be forced so they can report a diagnostic.
 */

export interface TriangulationResult {
  /** Triangle vertex indices referring to the input vertex numbering. */
  indices: number[];
  /** Number of ears clipped without a valid ear test (0 for clean input). */
  forced: number;
  /** False when a loop was unusable (e.g. hole outside the outer boundary). */
  ok: boolean;
}

class Nodes {
  vi: Int32Array;
  x: Float64Array;
  y: Float64Array;
  prev: Int32Array;
  next: Int32Array;
  count = 0;

  constructor(capacity: number) {
    this.vi = new Int32Array(capacity);
    this.x = new Float64Array(capacity);
    this.y = new Float64Array(capacity);
    this.prev = new Int32Array(capacity);
    this.next = new Int32Array(capacity);
  }

  add(vi: number, x: number, y: number, last: number): number {
    const i = this.count++;
    this.vi[i] = vi;
    this.x[i] = x;
    this.y[i] = y;
    if (last < 0) {
      this.prev[i] = i;
      this.next[i] = i;
    } else {
      const n = this.next[last]!;
      this.next[i] = n;
      this.prev[i] = last;
      this.prev[n] = i;
      this.next[last] = i;
    }
    return i;
  }

  remove(i: number): void {
    const p = this.prev[i]!, n = this.next[i]!;
    this.next[p] = n;
    this.prev[n] = p;
  }
}

function orient(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

/** Signed area (positive = counter-clockwise) of vertices [start, end). */
export function signedArea(coords: ArrayLike<number>, start: number, end: number): number {
  let a = 0;
  for (let i = start, j = end - 1; i < end; j = i++) {
    a += coords[j * 2]! * coords[i * 2 + 1]! - coords[i * 2]! * coords[j * 2 + 1]!;
  }
  return a / 2;
}

/**
 * Triangulates a polygon given as packed 2D coordinates. Vertices
 * [0, holeStarts[0]) form the outer loop; each subsequent range is a hole.
 */
export function triangulatePolygon(coords: ArrayLike<number>, holeStarts: readonly number[] = []): TriangulationResult {
  const total = coords.length >> 1;
  const result: TriangulationResult = { indices: [], forced: 0, ok: true };
  if (total < 3) {
    result.ok = total === 0;
    return result;
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < total; i++) {
    const x = coords[i * 2]!, y = coords[i * 2 + 1]!;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      result.ok = false;
      return result;
    }
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const size = Math.max(maxX - minX, maxY - minY);
  if (!(size > 0)) {
    result.ok = false;
    return result;
  }
  const epsLen = size * 1e-10;
  const epsArea = size * size * 1e-14;

  const ranges: [number, number][] = [];
  const starts = [0, ...holeStarts.filter((s) => s > 0 && s < total), total];
  for (let k = 0; k + 1 < starts.length; k++) {
    if (starts[k + 1]! - starts[k]! >= 1) ranges.push([starts[k]!, starts[k + 1]!]);
  }
  const nodes = new Nodes(total + 2 * ranges.length + 4);

  const buildLoop = (start: number, end: number, ccw: boolean): number => {
    const area = signedArea(coords, start, end);
    let last = -1;
    if (area > 0 === ccw) {
      for (let i = start; i < end; i++) last = nodes.add(i, coords[i * 2]!, coords[i * 2 + 1]!, last);
    } else {
      for (let i = end - 1; i >= start; i--) last = nodes.add(i, coords[i * 2]!, coords[i * 2 + 1]!, last);
    }
    return filterPoints(nodes, last, epsLen, epsArea, false);
  };

  if (Math.abs(signedArea(coords, ranges[0]![0], ranges[0]![1])) <= epsArea) {
    result.ok = false; // zero-area outer loop (collinear or coincident points)
    return result;
  }
  let outer = buildLoop(ranges[0]![0], ranges[0]![1], true);
  if (outer < 0 || nodes.next[outer] === nodes.prev[outer]) {
    result.ok = false;
    return result;
  }

  // Convex fast path (no holes).
  if (ranges.length === 1 && isConvex(nodes, outer, epsArea)) {
    const first = outer;
    let p = nodes.next[first]!;
    while (nodes.next[p] !== first) {
      result.indices.push(nodes.vi[first]!, nodes.vi[p]!, nodes.vi[nodes.next[p]!]!);
      p = nodes.next[p]!;
    }
    return result;
  }

  if (ranges.length > 1) {
    const holes: number[] = [];
    for (let k = 1; k < ranges.length; k++) {
      const h = buildLoop(ranges[k]![0], ranges[k]![1], false);
      if (h < 0 || nodes.next[h] === nodes.prev[h]) continue; // degenerate hole: ignore
      holes.push(rightmost(nodes, h));
    }
    holes.sort((a, b) => nodes.x[b]! - nodes.x[a]!);
    for (const h of holes) {
      const bridged = bridgeHole(nodes, h, outer, epsLen);
      if (bridged < 0) {
        result.ok = false; // hole could not be connected: skip it
        continue;
      }
      outer = filterPoints(nodes, bridged, epsLen, epsArea, false);
      if (outer < 0) break;
    }
    if (outer < 0) {
      result.ok = false;
      return result;
    }
  }

  earClip(nodes, outer, epsArea, epsLen, result);
  return result;
}

function isConvex(nodes: Nodes, start: number, epsArea: number): boolean {
  let p = start;
  do {
    const a = nodes.prev[p]!, c = nodes.next[p]!;
    if (orient(nodes.x[a]!, nodes.y[a]!, nodes.x[p]!, nodes.y[p]!, nodes.x[c]!, nodes.y[c]!) <= epsArea) return false;
    p = c;
  } while (p !== start);
  return true;
}

function rightmost(nodes: Nodes, start: number): number {
  let best = start;
  let p = start;
  do {
    if (nodes.x[p]! > nodes.x[best]! || (nodes.x[p] === nodes.x[best] && nodes.y[p]! < nodes.y[best]!)) best = p;
    p = nodes.next[p]!;
  } while (p !== start);
  return best;
}

/**
 * Removes coincident and (optionally strictly) collinear vertices. Returns a
 * surviving node, or -1 when fewer than three remain.
 */
function filterPoints(nodes: Nodes, start: number, epsLen: number, epsArea: number, collinear: boolean): number {
  if (start < 0) return -1;
  let p = start;
  let end = start;
  let guard = nodes.count * 4 + 16;
  do {
    if (guard-- < 0) break;
    const n = nodes.next[p]!;
    const pr = nodes.prev[p]!;
    if (n === p || n === pr) return -1;
    const dup = Math.abs(nodes.x[p]! - nodes.x[n]!) <= epsLen && Math.abs(nodes.y[p]! - nodes.y[n]!) <= epsLen;
    const flat =
      collinear &&
      Math.abs(orient(nodes.x[pr]!, nodes.y[pr]!, nodes.x[p]!, nodes.y[p]!, nodes.x[n]!, nodes.y[n]!)) <= epsArea;
    if (dup || flat) {
      nodes.remove(p);
      p = end = pr;
      if (p === nodes.next[p]) return -1;
      continue;
    }
    p = n;
  } while (p !== end);
  const n = nodes.next[p]!;
  if (n === p || nodes.next[n] === p) return -1;
  return p;
}

/** Whether diagonal a→b lies inside the polygon in the neighbourhood of a. */
function locallyInside(nodes: Nodes, a: number, b: number): boolean {
  const p = nodes.prev[a]!, n = nodes.next[a]!;
  const ax = nodes.x[a]!, ay = nodes.y[a]!, bx = nodes.x[b]!, by = nodes.y[b]!;
  const px = nodes.x[p]!, py = nodes.y[p]!, nx = nodes.x[n]!, ny = nodes.y[n]!;
  if (orient(px, py, ax, ay, nx, ny) >= 0) {
    // convex vertex: b must lie between the directions to next and prev
    return orient(ax, ay, nx, ny, bx, by) >= 0 && orient(ax, ay, bx, by, px, py) >= 0;
  }
  // reflex vertex: b must not lie strictly inside the exterior wedge
  return orient(ax, ay, px, py, bx, by) <= 0 || orient(ax, ay, bx, by, nx, ny) <= 0;
}

function segmentsIntersect(
  p1x: number, p1y: number, p2x: number, p2y: number,
  q1x: number, q1y: number, q2x: number, q2y: number,
): boolean {
  const d1 = orient(q1x, q1y, q2x, q2y, p1x, p1y);
  const d2 = orient(q1x, q1y, q2x, q2y, p2x, p2y);
  const d3 = orient(p1x, p1y, p2x, p2y, q1x, q1y);
  const d4 = orient(p1x, p1y, p2x, p2y, q2x, q2y);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** True when segment a–b properly crosses any polygon edge. */
function crossesPolygon(nodes: Nodes, a: number, b: number): boolean {
  const ax = nodes.x[a]!, ay = nodes.y[a]!, bx = nodes.x[b]!, by = nodes.y[b]!;
  let p = a;
  do {
    const q = nodes.next[p]!;
    if (segmentsIntersect(ax, ay, bx, by, nodes.x[p]!, nodes.y[p]!, nodes.x[q]!, nodes.y[q]!)) return true;
    p = q;
  } while (p !== a);
  return false;
}

/**
 * Connects hole (entered at its rightmost vertex `m`) to the outer loop.
 * Returns a node of the merged loop or -1.
 */
function bridgeHole(nodes: Nodes, m: number, outer: number, epsLen: number): number {
  const hx = nodes.x[m]!, hy = nodes.y[m]!;
  // 1. nearest edge crossing of the +X ray from the hole vertex
  let bestX = Infinity;
  let candidate = -1;
  let p = outer;
  do {
    const q = nodes.next[p]!;
    const ay = nodes.y[p]!, by = nodes.y[q]!;
    if (ay !== by && hy >= Math.min(ay, by) && hy <= Math.max(ay, by)) {
      const ax = nodes.x[p]!, bx = nodes.x[q]!;
      const x = ax + ((hy - ay) * (bx - ax)) / (by - ay);
      if (x >= hx - epsLen && x < bestX) {
        bestX = x;
        if (Math.abs(hy - ay) <= epsLen && Math.abs(x - ax) <= epsLen) candidate = p;
        else if (Math.abs(hy - by) <= epsLen && Math.abs(x - bx) <= epsLen) candidate = q;
        else candidate = ax > bx ? p : q;
      }
    }
    p = q;
  } while (p !== outer);
  if (candidate < 0) return fallbackBridge(nodes, m, outer);

  // 2. reflex vertices inside triangle (M, I, P) may block visibility; pick the
  //    one with the smallest angle to the ray.
  const px = nodes.x[candidate]!, py = nodes.y[candidate]!;
  let best = candidate;
  let bestTan = Infinity;
  if (!(Math.abs(bestX - px) <= epsLen && Math.abs(hy - py) <= epsLen)) {
    const ix = bestX;
    const tri = (x: number, y: number): boolean => {
      const s1 = orient(hx, hy, ix, hy, x, y);
      const s2 = orient(ix, hy, px, py, x, y);
      const s3 = orient(px, py, hx, hy, x, y);
      const neg = s1 < 0 || s2 < 0 || s3 < 0;
      const pos = s1 > 0 || s2 > 0 || s3 > 0;
      return !(neg && pos);
    };
    p = outer;
    do {
      if (p !== candidate) {
        const x = nodes.x[p]!, y = nodes.y[p]!;
        if (x >= hx && tri(x, y)) {
          const pr = nodes.prev[p]!, nx = nodes.next[p]!;
          const reflex = orient(nodes.x[pr]!, nodes.y[pr]!, x, y, nodes.x[nx]!, nodes.y[nx]!) < 0;
          if (reflex || (x === px && y === py)) {
            const tan = Math.abs(hy - y) / Math.max(x - hx, 1e-300);
            if (
              locallyInside(nodes, p, m) &&
              (tan < bestTan || (tan === bestTan && x < nodes.x[best]!))
            ) {
              best = p;
              bestTan = tan;
            }
          }
        }
      }
      p = nodes.next[p]!;
    } while (p !== outer);
  }
  // Among coincident duplicates (from earlier bridges) choose one whose sector admits the bridge.
  if (!locallyInside(nodes, best, m)) {
    let q = outer;
    do {
      if (nodes.x[q] === nodes.x[best] && nodes.y[q] === nodes.y[best] && locallyInside(nodes, q, m)) {
        best = q;
        break;
      }
      q = nodes.next[q]!;
    } while (q !== outer);
  }
  if (crossesPolygon(nodes, best, m)) {
    const alt = fallbackBridge(nodes, m, outer);
    if (alt >= 0) return alt;
  }
  return splitPolygon(nodes, best, m);
}

/** Brute-force bridge: nearest outer vertex whose connection crosses nothing. */
function fallbackBridge(nodes: Nodes, m: number, outer: number): number {
  const hx = nodes.x[m]!, hy = nodes.y[m]!;
  const order: { node: number; d: number }[] = [];
  let p = outer;
  do {
    order.push({ node: p, d: (nodes.x[p]! - hx) ** 2 + (nodes.y[p]! - hy) ** 2 });
    p = nodes.next[p]!;
  } while (p !== outer);
  order.sort((a, b) => a.d - b.d);
  for (const { node } of order) {
    if (locallyInside(nodes, node, m) && !crossesPolygon(nodes, node, m) && !crossesPolygon(nodes, m, node)) {
      return splitPolygon(nodes, node, m);
    }
  }
  return -1;
}

/** Links a (outer) and b (hole) with a two-way bridge; returns a node of the merged loop. */
function splitPolygon(nodes: Nodes, a: number, b: number): number {
  const a2 = nodes.add(nodes.vi[a]!, nodes.x[a]!, nodes.y[a]!, -1);
  const b2 = nodes.add(nodes.vi[b]!, nodes.x[b]!, nodes.y[b]!, -1);
  const an = nodes.next[a]!;
  const bp = nodes.prev[b]!;
  nodes.next[a] = b;
  nodes.prev[b] = a;
  nodes.next[a2] = an;
  nodes.prev[an] = a2;
  nodes.next[b2] = a2;
  nodes.prev[a2] = b2;
  nodes.next[bp] = b2;
  nodes.prev[b2] = bp;
  return a;
}

function isEar(nodes: Nodes, ear: number, epsArea: number): boolean {
  const a = nodes.prev[ear]!, c = nodes.next[ear]!;
  const ax = nodes.x[a]!, ay = nodes.y[a]!, bx = nodes.x[ear]!, by = nodes.y[ear]!, cx = nodes.x[c]!, cy = nodes.y[c]!;
  if (orient(ax, ay, bx, by, cx, cy) <= epsArea) return false;
  const minX = Math.min(ax, bx, cx), maxX = Math.max(ax, bx, cx);
  const minY = Math.min(ay, by, cy), maxY = Math.max(ay, by, cy);
  let p = nodes.next[c]!;
  while (p !== a) {
    const x = nodes.x[p]!, y = nodes.y[p]!;
    if (x >= minX && x <= maxX && y >= minY && y <= maxY) {
      const coincident = (x === ax && y === ay) || (x === bx && y === by) || (x === cx && y === cy);
      if (!coincident) {
        const pr = nodes.prev[p]!, nx = nodes.next[p]!;
        // only reflex (or flat) vertices can invalidate an ear
        if (orient(nodes.x[pr]!, nodes.y[pr]!, x, y, nodes.x[nx]!, nodes.y[nx]!) <= epsArea) {
          if (
            orient(ax, ay, bx, by, x, y) >= 0 &&
            orient(bx, by, cx, cy, x, y) >= 0 &&
            orient(cx, cy, ax, ay, x, y) >= 0
          ) {
            return false;
          }
        }
      }
      // Vertices coincident with a, b or c are bridge duplicates; their sectors
      // are disjoint from this vertex's sector, so they cannot invalidate the ear.
    }
    p = nodes.next[p]!;
  }
  return true;
}

function earClip(nodes: Nodes, start: number, epsArea: number, epsLen: number, out: TriangulationResult): void {
  let ear = start;
  let stop = ear;
  let pass = 0;
  let guard = nodes.count * nodes.count + 64;
  while (nodes.prev[ear] !== nodes.next[ear]) {
    if (guard-- < 0) break;
    const a = nodes.prev[ear]!, c = nodes.next[ear]!;
    if (isEar(nodes, ear, epsArea)) {
      out.indices.push(nodes.vi[a]!, nodes.vi[ear]!, nodes.vi[c]!);
      nodes.remove(ear);
      ear = nodes.next[c]!;
      stop = ear;
      pass = 0;
      continue;
    }
    ear = c;
    if (ear === stop) {
      if (pass === 0) {
        // drop coincident and collinear vertices, then retry
        const f = filterPoints(nodes, ear, epsLen, epsArea, true);
        if (f < 0) return;
        ear = stop = f;
        pass = 1;
      } else {
        // forced ear: clip the most convex vertex to guarantee progress
        let best = ear;
        let bestArea = -Infinity;
        let p = ear;
        do {
          const pa = nodes.prev[p]!, pc = nodes.next[p]!;
          const ar = orient(nodes.x[pa]!, nodes.y[pa]!, nodes.x[p]!, nodes.y[p]!, nodes.x[pc]!, nodes.y[pc]!);
          if (ar > bestArea) {
            bestArea = ar;
            best = p;
          }
          p = pc;
        } while (p !== ear);
        const pa = nodes.prev[best]!, pc = nodes.next[best]!;
        if (bestArea > epsArea) out.indices.push(nodes.vi[pa]!, nodes.vi[best]!, nodes.vi[pc]!);
        nodes.remove(best);
        out.forced++;
        ear = stop = pc;
        pass = 0;
      }
    }
  }
}
