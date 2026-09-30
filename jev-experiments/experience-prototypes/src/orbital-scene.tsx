/** The 3D Orbital rescue arena, split out so Snake doesn't download three.js. */
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { State } from "../../local-models-and-games/arcade/engine";

export default function OrbitalScene({ state }: { state: State }) {
  const host = useRef<HTMLDivElement>(null),
    latest = useRef(state);
  latest.current = state;
  const [error, setError] = useState("");
  useEffect(() => {
    const el = host.current!;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    } catch {
      setError(
        "3D rendering is unavailable in this browser. The state and decisions remain below.",
      );
      return;
    }
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setClearColor("#101d24");
    renderer.shadowMap.enabled = true;
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog("#101d24", 28, 70);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(12, 10, 14);
    camera.zoom = 1.2;
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 2, 0);
    controls.enableDamping = true;
    controls.minDistance = 9;
    controls.maxDistance = 38;
    controls.maxPolarAngle = Math.PI * 0.48;
    scene.add(new THREE.HemisphereLight("#d7fff2", "#263247", 2));
    const light = new THREE.DirectionalLight("#fff4d2", 3);
    light.position.set(4, 15, 7);
    light.castShadow = true;
    scene.add(light);
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(80, 80),
      new THREE.MeshStandardMaterial({ color: "#13252d", roughness: 0.85 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.45;
    floor.receiveShadow = true;
    scene.add(floor);
    const grid = new THREE.GridHelper(14, 14, "#456c71", "#294750");
    grid.position.y = -0.4;
    scene.add(grid);
    const box = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(12, 5, 12)),
      new THREE.LineBasicMaterial({
        color: "#4e777c",
        transparent: true,
        opacity: 0.32,
      }),
    );
    box.position.y = 2.5;
    scene.add(box);
    const beacon = new THREE.Mesh(
      new THREE.TorusGeometry(0.7, 0.07, 10, 40),
      new THREE.MeshStandardMaterial({
        color: "#9de4d5",
        emissive: "#56a496",
        emissiveIntensity: 1,
      }),
    );
    beacon.rotation.x = -Math.PI / 2;
    beacon.position.set(0, 0.05, 0);
    scene.add(beacon);
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.45, 0.65, 2, 24, 1, true),
      new THREE.MeshBasicMaterial({
        color: "#9de4d5",
        transparent: true,
        opacity: 0.12,
        side: THREE.DoubleSide,
      }),
    );
    beam.position.y = 1;
    scene.add(beam);
    const drone = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.32, 1),
      new THREE.MeshStandardMaterial({
        color: "#b6dfdd",
        metalness: 0.5,
        roughness: 0.2,
      }),
    );
    body.castShadow = true;
    drone.add(body);
    const rotors: THREE.Mesh[] = [];
    for (const x of [-0.4, 0.4])
      for (const z of [-0.4, 0.4]) {
        const rotor = new THREE.Mesh(
          new THREE.TorusGeometry(0.22, 0.025, 6, 20),
          new THREE.MeshStandardMaterial({
            color: "#f3e3b8",
            emissive: "#897c41",
          }),
        );
        rotor.rotation.x = Math.PI / 2;
        rotor.position.set(x, 0.06, z);
        drone.add(rotor);
        rotors.push(rotor);
      }
    scene.add(drone);
    const cores = Array.from({ length: 3 }, () => {
      const m = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.32),
        new THREE.MeshStandardMaterial({
          color: "#a8e68d",
          emissive: "#5b963a",
          emissiveIntensity: 1.2,
          metalness: 0.25,
          roughness: 0.25,
        }),
      );
      scene.add(m);
      return m;
    });
    const hazards = Array.from({ length: 5 }, () => {
      const g = new THREE.Group();
      const ball = new THREE.Mesh(
        new THREE.IcosahedronGeometry(0.55, 1),
        new THREE.MeshStandardMaterial({
          color: "#d47367",
          emissive: "#642d2a",
          wireframe: true,
        }),
      );
      g.add(ball);
      scene.add(g);
      return g;
    });
    const particles = new THREE.BufferGeometry();
    const xyz = [];
    for (let i = 0; i < 120; i++)
      xyz.push(Math.sin(i * 43) * 30, 7 + (i % 18), Math.cos(i * 31) * 30);
    particles.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(xyz, 3),
    );
    scene.add(
      new THREE.Points(
        particles,
        new THREE.PointsMaterial({ color: "#adcfce", size: 0.035 }),
      ),
    );
    const resize = new ResizeObserver(() => {
      const w = el.clientWidth,
        h = el.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    });
    resize.observe(el);
    let raf = 0;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const target = new THREE.Vector3();
    function frame(t: number) {
      const s = latest.current;
      target.set(s.drone!.x, s.drone!.y, s.drone!.z!);
      drone.position.lerp(target, reduce ? 1 : 0.18);
      body.rotation.y = reduce ? 0 : t * 0.001;
      s.cores!.forEach((p, i) => {
        cores[i].visible = true;
        cores[i].position.set(
          p.x,
          p.y + (reduce ? 0 : Math.sin(t * 0.002 + i) * 0.09),
          p.z!,
        );
        cores[i].rotation.y = reduce ? 0 : t * 0.001;
      });
      for (let i = s.cores!.length; i < 3; i++) cores[i].visible = false;
      s.hazards!.forEach((p, i) => {
        hazards[i].position.set(p.x, p.y, p.z!);
        hazards[i].rotation.y = reduce ? 0 : t * 0.0004;
      });
      controls.update();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      resize.disconnect();
      controls.dispose();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        if (m.material) {
          const mats = Array.isArray(m.material) ? m.material : [m.material];
          mats.forEach((x) => x.dispose());
        }
      });
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);
  return (
    <div
      className="orbital-canvas"
      ref={host}
      aria-label="Interactive 3D drone rescue arena"
    >
      {error && <p>{error}</p>}
      <span className="camera-hint">Drag to orbit · scroll to zoom</span>
    </div>
  );
}
