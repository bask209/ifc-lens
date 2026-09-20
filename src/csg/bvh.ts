// SPDX-License-Identifier: Apache-2.0
/** Axis-aligned bounding volume hierarchy over triangles (median split). */

export class TriangleBvh {
  private readonly minX: Float64Array;
  private readonly minY: Float64Array;
  private readonly minZ: Float64Array;
  private readonly maxX: Float64Array;
  private readonly maxY: Float64Array;
  private readonly maxZ: Float64Array;
  private readonly left: Int32Array;
  private readonly right: Int32Array;
  private readonly first: Int32Array;
  private readonly count: Int32Array;
  private readonly order: Uint32Array;
  private nodeCount = 0;

  constructor(positions: ArrayLike<number>, indices: ArrayLike<number>, leafSize = 4) {
    const triCount = indices.length / 3;
    const cap = Math.max(1, triCount * 2);
    this.minX = new Float64Array(cap);
    this.minY = new Float64Array(cap);
    this.minZ = new Float64Array(cap);
    this.maxX = new Float64Array(cap);
    this.maxY = new Float64Array(cap);
    this.maxZ = new Float64Array(cap);
    this.left = new Int32Array(cap).fill(-1);
    this.right = new Int32Array(cap).fill(-1);
    this.first = new Int32Array(cap);
    this.count = new Int32Array(cap);
    this.order = new Uint32Array(triCount);
    if (triCount === 0) return;
    const tb = new Float64Array(triCount * 6);
    const centroid = new Float64Array(triCount * 3);
    for (let t = 0; t < triCount; t++) {
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      for (let k = 0; k < 3; k++) {
        const v = indices[t * 3 + k]! * 3;
        const x = positions[v]!, y = positions[v + 1]!, z = positions[v + 2]!;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (z < z0) z0 = z; if (z > z1) z1 = z;
      }
      tb.set([x0, y0, z0, x1, y1, z1], t * 6);
      centroid[t * 3] = (x0 + x1) / 2;
      centroid[t * 3 + 1] = (y0 + y1) / 2;
      centroid[t * 3 + 2] = (z0 + z1) / 2;
      this.order[t] = t;
    }
    const stack: [number, number, number][] = [];
    const root = this.nodeCount++;
    stack.push([root, 0, triCount]);
    while (stack.length > 0) {
      const [node, start, end] = stack.pop()!;
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      let cx0 = Infinity, cy0 = Infinity, cz0 = Infinity, cx1 = -Infinity, cy1 = -Infinity, cz1 = -Infinity;
      for (let i = start; i < end; i++) {
        const t = this.order[i]!;
        const o = t * 6;
        if (tb[o]! < x0) x0 = tb[o]!;
        if (tb[o + 1]! < y0) y0 = tb[o + 1]!;
        if (tb[o + 2]! < z0) z0 = tb[o + 2]!;
        if (tb[o + 3]! > x1) x1 = tb[o + 3]!;
        if (tb[o + 4]! > y1) y1 = tb[o + 4]!;
        if (tb[o + 5]! > z1) z1 = tb[o + 5]!;
        const cx = centroid[t * 3]!, cy = centroid[t * 3 + 1]!, cz = centroid[t * 3 + 2]!;
        if (cx < cx0) cx0 = cx; if (cx > cx1) cx1 = cx;
        if (cy < cy0) cy0 = cy; if (cy > cy1) cy1 = cy;
        if (cz < cz0) cz0 = cz; if (cz > cz1) cz1 = cz;
      }
      this.minX[node] = x0; this.minY[node] = y0; this.minZ[node] = z0;
      this.maxX[node] = x1; this.maxY[node] = y1; this.maxZ[node] = z1;
      const n = end - start;
      if (n <= leafSize) {
        this.first[node] = start;
        this.count[node] = n;
        continue;
      }
      const ex = cx1 - cx0, ey = cy1 - cy0, ez = cz1 - cz0;
      const axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2;
      const mid = start + (n >> 1);
      // partial sort (nth element) by centroid along axis
      const slice = Array.from(this.order.subarray(start, end));
      slice.sort((a, b) => centroid[a * 3 + axis]! - centroid[b * 3 + axis]!);
      this.order.set(slice, start);
      const l = this.nodeCount++;
      const r = this.nodeCount++;
      this.left[node] = l;
      this.right[node] = r;
      this.count[node] = 0;
      stack.push([l, start, mid], [r, mid, end]);
    }
  }

  /** Calls `visit` with every triangle whose box overlaps the query box. */
  query(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, visit: (tri: number) => void): void {
    if (this.nodeCount === 0) return;
    const stack = [0];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (this.minX[node]! > x1 || this.maxX[node]! < x0 || this.minY[node]! > y1 || this.maxY[node]! < y0 || this.minZ[node]! > z1 || this.maxZ[node]! < z0) continue;
      const l = this.left[node]!;
      if (l < 0) {
        const s = this.first[node]!;
        for (let i = 0; i < this.count[node]!; i++) visit(this.order[s + i]!);
      } else {
        stack.push(l, this.right[node]!);
      }
    }
  }
}
