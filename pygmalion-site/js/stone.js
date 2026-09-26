// ===========================================================================
// The stone material shared by the studio and the gallery viewer.
// ===========================================================================
import * as THREE from 'three';

const DEFAULT_TEXTURE = new URL('../assets/stone.jpg', import.meta.url).href;

// Returns a MeshStandardMaterial that draws the stone photo (triplanar), the
// paint layer (a 'paint' vertex attribute) and fine bump detail.
export function createStoneMaterial(renderer, textureUrl = DEFAULT_TEXTURE) {
  // ---------------------------------------------------------------------------
  // Stone surface: a photo of real stone (assets/stone.jpg).
  // The mesh is rebuilt constantly and has no UV coordinates, so the photo is
  // applied with *triplanar mapping*: it's projected along X, Y and Z in world
  // space and blended by which way the surface faces. Nothing ever stretches,
  // and freshly carved surfaces pick up stone that matches their surroundings.
  // The photo's light/dark detail doubles as a bump map, so cracks and chips
  // catch the light. Paint arrives as a per-vertex colour laid over the stone.
  // ---------------------------------------------------------------------------
  const STONE_TILE = 1.2;     // world units covered by one repeat of the photo
  const STONE_BUMP = 0.6;     // how strongly the photo's detail affects lighting (0 = flat)

  const stoneUniforms = {
    uStone: { value: new THREE.DataTexture(new Uint8Array([150, 140, 120, 255]), 1, 1) },
    uTile:  { value: STONE_TILE },
    uBump:  { value: STONE_BUMP },
  };
  stoneUniforms.uStone.value.needsUpdate = true;          // grey placeholder until the photo decodes
  new THREE.TextureLoader().load(textureUrl, tex => {
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    stoneUniforms.uStone.value = tex;
  });

  const STONE_GLSL = /* glsl */`
  uniform sampler2D uStone; uniform float uTile; uniform float uBump;
  varying vec3 vWPos; varying vec3 vWNrm; varying vec4 vPaint; varying mat3 vNMat;
  vec3 lin(vec3 c) { return pow(c, vec3(2.2)); }   // sRGB-ish colour -> linear

  // Each projection gets its own offset so the three views don't line up
  // and make the repeat obvious at the block's edges.
  vec3 stoneColor(vec3 p, vec3 n) {
    vec3 w = pow(abs(n), vec3(4.0)); w /= (w.x + w.y + w.z);
    vec3 q = p / uTile;
    return texture2D(uStone, q.zy + vec2(0.31, 0.17)).rgb * w.x
         + texture2D(uStone, q.xz + vec2(0.63, 0.41)).rgb * w.y
         + texture2D(uStone, q.xy).rgb * w.z;
  }
  float stoneHeight(vec3 p, vec3 n) { return dot(stoneColor(p, n), vec3(0.299, 0.587, 0.114)); }
  `;
  const material = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0 });
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, stoneUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 paint;\nvarying vec3 vWPos; varying vec3 vWNrm; varying vec4 vPaint; varying mat3 vNMat;')
      // Object-space coordinates: a broken-off piece keeps exactly the stone
      // pattern it had on the block while it tumbles.
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vWPos = transformed;
        vWNrm = normalize(objectNormal);
        vNMat = normalMatrix;
        vPaint = paint;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + STONE_GLSL)
      .replace('#include <map_fragment>', `#include <map_fragment>
        diffuseColor.rgb = mix(stoneColor(vWPos, normalize(vWNrm)), lin(vPaint.rgb), vPaint.a);`)
      // Bump: tilt the lighting normal along the slope of the photo's brightness.
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        if (uBump > 0.0) {
          vec3 wn = normalize(vWNrm);
          float e = uTile / 700.0;                         // ~1.5 texels
          float h0 = stoneHeight(vWPos, wn);
          vec3 g = vec3(stoneHeight(vWPos + vec3(e,0,0), wn) - h0,
                        stoneHeight(vWPos + vec3(0,e,0), wn) - h0,
                        stoneHeight(vWPos + vec3(0,0,e), wn) - h0) / e;
          g -= dot(g, wn) * wn;
          normal = normalize(normal - uBump * 0.012 * (vNMat * g));
        }`);
  };
  return material;
}
