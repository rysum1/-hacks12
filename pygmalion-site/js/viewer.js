// ===========================================================================
// 3D viewer for the gallery: shows one sculpture, slowly turning, and lets
// the visitor drag to look around. Loaded only when a sculpture is opened.
// ===========================================================================
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createStoneMaterial } from './stone.js';

export function createViewer(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x15171a);
  const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
  camera.position.set(2.7, 1.3, 3.6).setLength(5.6);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x404050, 1.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(3, 5, 4);
  scene.add(sun);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.autoRotate = !matchMedia('(prefers-reduced-motion: reduce)').matches;
  controls.autoRotateSpeed = 1.2;
  controls.minDistance = 2;
  controls.maxDistance = 10;
  controls.enablePan = false;
  // Stop the turntable once the visitor takes over.
  controls.addEventListener('start', () => { controls.autoRotate = false; });

  const material = createStoneMaterial(renderer);
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
  scene.add(mesh);

  const resize = () => {
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(container);

  let running = false;
  const loop = () => {
    if (!running) return;
    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  };

  return {
    // meshData: the result of SculptVolume.mesh()
    show(meshData) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(meshData.positions, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(meshData.normals, 3));
      geo.setAttribute('paint', new THREE.BufferAttribute(meshData.colors, 4, true));
      geo.setIndex(new THREE.BufferAttribute(meshData.indices, 1));
      geo.computeBoundingSphere();
      mesh.geometry.dispose();
      mesh.geometry = geo;
      camera.position.set(2.7, 1.3, 3.6).setLength(5.6);
      controls.target.set(0, 0, 0);
      controls.autoRotate = !matchMedia('(prefers-reduced-motion: reduce)').matches;
      resize();
      if (!running) { running = true; loop(); }
    },
    stop() { running = false; },
  };
}
