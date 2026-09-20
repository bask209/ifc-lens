// SPDX-License-Identifier: Apache-2.0
/**
 * GLSL ES 3.00 programs. Every draw is instanced: merged chunks use one
 * instance (a translation to the chunk origin), mapped definitions use one
 * instance per product. Per-object visibility/selection flags come from an
 * unsigned integer state texture indexed by object index.
 */

export const MAX_CLIP_PLANES = 6;

const COMMON_VERTEX = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in uint aObject;
layout(location = 3) in vec4 aM0;
layout(location = 4) in vec4 aM1;
layout(location = 5) in vec4 aM2;
layout(location = 6) in vec4 aM3;
uniform mat4 uViewProj;
uniform usampler2D uState;
uniform int uStateWidth;
out vec3 vNormal;
out vec3 vWorld;
flat out uint vObject;
flat out uint vFlags;
void main() {
  uint flags = texelFetch(uState, ivec2(int(aObject) % uStateWidth, int(aObject) / uStateWidth), 0).r;
  vFlags = flags;
  vObject = aObject;
  if ((flags & 1u) != 0u) {
    // hidden: place the vertex outside the clip volume
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vNormal = vec3(0.0);
    vWorld = vec3(0.0);
    return;
  }
  mat4 model = mat4(aM0, aM1, aM2, aM3);
  vec4 world = model * vec4(aPosition, 1.0);
  vWorld = world.xyz;
  vNormal = mat3(model) * aNormal;
  gl_Position = uViewProj * world;
}
`;

export const MESH_VERTEX = COMMON_VERTEX;

export const MESH_FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
in vec3 vNormal;
in vec3 vWorld;
flat in uint vObject;
flat in uint vFlags;
uniform vec4 uColor;
uniform vec4 uHighlight;
uniform vec3 uEye;
uniform vec4 uClip[${MAX_CLIP_PLANES}];
uniform int uClipCount;
uniform int uUnlit;
out vec4 outColor;
void main() {
  for (int i = 0; i < ${MAX_CLIP_PLANES}; i++) {
    if (i >= uClipCount) break;
    if (dot(uClip[i].xyz, vWorld) > uClip[i].w) discard;
  }
  vec4 base = uColor;
  bool selected = (vFlags & 2u) != 0u;
  if (selected) base = vec4(mix(base.rgb, uHighlight.rgb, uHighlight.a), max(base.a, 0.85));
  if (uUnlit == 1) {
    outColor = vec4(base.rgb, base.a);
    return;
  }
  vec3 n = normalize(vNormal);
  vec3 v = normalize(uEye - vWorld);
  if (length(vNormal) < 1e-6) n = v;
  if (dot(n, v) < 0.0) n = -n; // two-sided lighting (IFC winding is not reliable)
  vec3 key = normalize(vec3(0.35, 0.55, 0.75));
  float hemi = 0.5 + 0.5 * n.z;
  float light = 0.34 + 0.16 * hemi + 0.38 * max(dot(n, v), 0.0) + 0.16 * max(dot(n, key), 0.0);
  vec3 h = normalize(v + key);
  float spec = pow(max(dot(n, h), 0.0), 48.0) * 0.08;
  outColor = vec4(base.rgb * light + spec, base.a);
}
`;

export const PICK_FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
in vec3 vNormal;
in vec3 vWorld;
flat in uint vObject;
flat in uint vFlags;
uniform vec4 uClip[${MAX_CLIP_PLANES}];
uniform int uClipCount;
layout(location = 0) out uvec4 outId;
layout(location = 1) out uvec4 outDepth;
void main() {
  for (int i = 0; i < ${MAX_CLIP_PLANES}; i++) {
    if (i >= uClipCount) break;
    if (dot(uClip[i].xyz, vWorld) > uClip[i].w) discard;
  }
  outId = uvec4(vObject, 0u, 0u, 1u);
  outDepth = uvec4(floatBitsToUint(gl_FragCoord.z), 0u, 0u, 1u);
}
`;
