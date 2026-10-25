// Живая 3D-сцена экрана входа: те же объекты, что в рендере (куб, шар, карточка с кольцом, монеты),
// мягкий свет, тень на прозрачной плоскости, лёгкий параллакс за курсором. Three.js (MIT) лежит в vendor/three.
import * as THREE from "three";
import { RoundedBoxGeometry } from "./vendor/three/RoundedBoxGeometry.js";
import { RoomEnvironment } from "./vendor/three/RoomEnvironment.js";

const COLORS = { red: 0xef3124, violet: 0x6a4dff, green: 0x0cc44d, white: 0xf7f7f9, grey: 0xc9ccd3 };

export function mount(container) {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.NoToneMapping;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer); scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture; scene.environmentIntensity = 0.45;
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  camera.position.set(4.9, 4.4, 6.4); camera.lookAt(0.1, 0.3, 0.1);

  scene.add(new THREE.HemisphereLight(0xffffff, 0xd9dde6, 0.7));
  const key = new THREE.DirectionalLight(0xffffff, 2.4); key.position.set(4, 7, 5); key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048); key.shadow.radius = 6; key.shadow.bias = -0.0005;
  Object.assign(key.shadow.camera, { left: -5, right: 5, top: 5, bottom: -5, near: 1, far: 25 }); scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.6); fill.position.set(-6, 3, 2); scene.add(fill);

  const mat = (color, extra = {}) => new THREE.MeshPhysicalMaterial({ color, roughness: 0.32, metalness: 0, clearcoat: 0.5, clearcoatRoughness: 0.2, ...extra });
  const group = new THREE.Group(); scene.add(group);
  const add = (geo, m, pos, rot = [0, 0, 0]) => { const mesh = new THREE.Mesh(geo, m); mesh.position.set(...pos); mesh.rotation.set(...rot); mesh.castShadow = mesh.receiveShadow = true; group.add(mesh); return mesh; };

  const cube = add(new RoundedBoxGeometry(1.5, 1.5, 1.5, 6, 0.3), mat(COLORS.red), [0.1, 0.75, 0.2], [0, 0.32, 0]);
  const ball = add(new THREE.SphereGeometry(0.62, 64, 48), mat(COLORS.violet), [1.55, 0.62, -1.2]);
  const card = add(new RoundedBoxGeometry(2.2, 0.16, 1.35, 4, 0.07), mat(COLORS.white, { roughness: 0.3 }), [-1.5, 0.08, 1.15], [0, -0.21, 0]);
  const line = (w, x, z) => add(new RoundedBoxGeometry(w, 0.06, 0.14, 2, 0.025), mat(COLORS.grey, { clearcoat: 0 }), [x, 0.19, z], [0, -0.21, 0]);
  line(1.0, -1.85, 0.95); line(0.6, -2.05, 1.3);
  const ring = add(new THREE.TorusGeometry(0.26, 0.06, 24, 64), mat(COLORS.green), [-0.85, 0.19, 1.5], [Math.PI / 2, 0, 0]);
  const coin = (y, c) => add(new THREE.CylinderGeometry(0.48, 0.48, 0.13, 64), mat(c), [1.6, y, 0.9]);
  coin(0.065, COLORS.grey); coin(0.2, COLORS.grey); coin(0.335, COLORS.red);

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), new THREE.ShadowMaterial({ opacity: 0.18 }));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);

  const floaters = [[cube, 0.06, 0.0], [ball, 0.1, 1.3], [ring, 0.03, 2.1]].map(([m, amp, ph]) => ({ m, amp, ph, y: m.position.y }));
  let target = { x: 0, y: 0 }, cur = { x: 0, y: 0 }, raf = 0, running = true;
  const onMove = (e) => { const r = container.getBoundingClientRect(); target = { x: ((e.clientX - r.left) / r.width - 0.5) * 2, y: ((e.clientY - r.top) / r.height - 0.5) * 2 }; };
  window.addEventListener("pointermove", onMove, { passive: true });

  const resize = () => { const w = container.clientWidth || 560, h = container.clientHeight || 340; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); };
  const ro = new ResizeObserver(resize); ro.observe(container); resize();

  const t0 = performance.now();
  const frame = () => {
    if (!running) return;
    const t = (performance.now() - t0) / 1000;
    cur.x += (target.x - cur.x) * 0.04; cur.y += (target.y - cur.y) * 0.04;
    group.rotation.y = cur.x * 0.18 + (reduce ? 0 : Math.sin(t * 0.25) * 0.05);
    group.rotation.x = cur.y * 0.06;
    if (!reduce) for (const f of floaters) f.m.position.y = f.y + Math.sin(t * 0.9 + f.ph) * f.amp;
    cube.rotation.y = 0.32 + (reduce ? 0 : Math.sin(t * 0.4) * 0.08);
    renderer.render(scene, camera);
    if (!reduce) raf = requestAnimationFrame(frame);
  };
  frame();
  const onVis = () => { running = !document.hidden; if (running && !raf) frame(); if (!running) { cancelAnimationFrame(raf); raf = 0; } };
  document.addEventListener("visibilitychange", onVis);
  return () => { running = false; cancelAnimationFrame(raf); ro.disconnect(); window.removeEventListener("pointermove", onMove); document.removeEventListener("visibilitychange", onVis); renderer.dispose(); renderer.domElement.remove(); };
}
