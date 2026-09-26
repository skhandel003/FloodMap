"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";

const EARTH_TEXTURE_URL = "/textures/earth-blue-marble.jpg";

// Fraction of the viewport height where the top edge of the globe sits
const GLOBE_TOP = 0.6;
// Radians per second (one full turn every ~3.5 minutes)
const SPIN_SPEED = 0.03;
// Starts with Alberta just west of centre so it drifts into view
const INITIAL_SPIN = 0.25;
// Tilts the north pole away from the viewer so mid-latitudes fill the visible cap
const POLE_TILT = -0.35;
const AXIS_ROLL = 0.2;
const ATMOSPHERE_SCALE = 1.06;

const NORMAL_VERTEX_SHADER = /* glsl */ `
  varying vec3 vNormal;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Back faces of a larger sphere: brightest at the globe's edge, fading to nothing outwards
const HALO_FRAGMENT_SHADER = /* glsl */ `
  uniform float edge;
  varying vec3 vNormal;
  void main() {
    float f = clamp(-vNormal.z / edge, 0.0, 1.0);
    gl_FragColor = vec4(0.35, 0.65, 1.0, 1.0) * pow(f, 3.0) * 0.4;
  }
`;

// Front faces just above the surface: blue haze that thickens towards the limb
const HAZE_FRAGMENT_SHADER = /* glsl */ `
  varying vec3 vNormal;
  void main() {
    float rim = 1.0 - clamp(vNormal.z, 0.0, 1.0);
    gl_FragColor = vec4(0.4, 0.7, 1.0, 1.0) * pow(rim, 4.0) * 0.6;
  }
`;

/**
 * EarthGlobe - Slowly rotating 3D earth for the landing page background
 *
 * Features:
 * - three.js sphere wrapped in NASA Blue Marble imagery with an atmosphere glow
 * - Orthographic camera so the globe rises from the bottom of the viewport
 * - Fades in once the texture has loaded
 * - Falls back to a static photo when WebGL is unavailable
 */
export function EarthGlobe() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isReady, setIsReady] = useState(false);
  const [hasFailed, setHasFailed] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let isDisposed = false;
    let cleanup: (() => void) | undefined;

    const initialize = async () => {
      // Dynamically import three.js to keep it out of the server bundle
      const THREE = await import("three");

      let texture: InstanceType<typeof THREE.Texture>;
      try {
        texture = await new THREE.TextureLoader().loadAsync(EARTH_TEXTURE_URL);
      } catch (error) {
        console.error("Failed to load earth texture:", error);
        if (!isDisposed) setHasFailed(true);
        return;
      }
      if (isDisposed) {
        texture.dispose();
        return;
      }

      let renderer: InstanceType<typeof THREE.WebGLRenderer>;
      try {
        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      } catch (error) {
        console.error("WebGL unavailable, showing static background:", error);
        texture.dispose();
        setHasFailed(true);
        return;
      }

      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = renderer.capabilities.getMaxAnisotropy();

      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setClearColor(0x000000, 0);
      renderer.domElement.style.display = "block";
      renderer.domElement.style.width = "100%";
      renderer.domElement.style.height = "100%";
      container.appendChild(renderer.domElement);

      const scene = new THREE.Scene();
      // Frustum is set in pixels by layout()
      const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 50000);
      camera.position.z = 20000;

      scene.add(new THREE.AmbientLight(0xffffff, 0.9));
      const sun = new THREE.DirectionalLight(0xffffff, 2.4);
      sun.position.set(-0.5, 1, 0.7);
      scene.add(sun);

      const sphereGeometry = new THREE.SphereGeometry(1, 128, 64);
      const earthMaterial = new THREE.MeshStandardMaterial({
        map: texture,
        roughness: 0.9,
        metalness: 0,
      });
      const hazeMaterial = new THREE.ShaderMaterial({
        vertexShader: NORMAL_VERTEX_SHADER,
        fragmentShader: HAZE_FRAGMENT_SHADER,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
      });
      const haloMaterial = new THREE.ShaderMaterial({
        vertexShader: NORMAL_VERTEX_SHADER,
        fragmentShader: HALO_FRAGMENT_SHADER,
        uniforms: {
          edge: { value: Math.sqrt(1 - 1 / ATMOSPHERE_SCALE ** 2) },
        },
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
      });

      const spin = new THREE.Group();
      spin.rotation.y = INITIAL_SPIN;
      spin.add(new THREE.Mesh(sphereGeometry, earthMaterial));

      const haze = new THREE.Mesh(sphereGeometry, hazeMaterial);
      haze.scale.setScalar(1.002);
      const halo = new THREE.Mesh(sphereGeometry, haloMaterial);
      halo.scale.setScalar(ATMOSPHERE_SCALE);

      const tilt = new THREE.Group();
      tilt.rotation.set(POLE_TILT, 0, AXIS_ROLL);
      tilt.add(spin, haze, halo);

      const earth = new THREE.Group();
      earth.add(tilt);
      scene.add(earth);

      const layout = () => {
        const width = container.clientWidth;
        const height = container.clientHeight;
        if (width === 0 || height === 0) return;

        renderer.setSize(width, height, false);
        camera.left = -width / 2;
        camera.right = width / 2;
        camera.top = height / 2;
        camera.bottom = -height / 2;
        camera.updateProjectionMatrix();

        const radius = Math.max(width * 0.62, height * 0.55);
        earth.scale.setScalar(radius);
        earth.position.y = height / 2 - GLOBE_TOP * height - radius;
      };

      const resizeObserver = new ResizeObserver(layout);
      resizeObserver.observe(container);
      layout();

      let animationFrame = 0;
      let lastTime = performance.now();
      const tick = (time: number) => {
        // Clamp so a backgrounded tab doesn't jump the globe forward on return
        const delta = Math.min((time - lastTime) / 1000, 0.1);
        lastTime = time;
        spin.rotation.y += SPIN_SPEED * delta;
        renderer.render(scene, camera);
        animationFrame = requestAnimationFrame(tick);
      };
      // Always spins, even with OS "reduce motion" on - the slow turn is the page's centrepiece
      animationFrame = requestAnimationFrame(tick);

      setIsReady(true);

      cleanup = () => {
        cancelAnimationFrame(animationFrame);
        resizeObserver.disconnect();
        sphereGeometry.dispose();
        earthMaterial.dispose();
        hazeMaterial.dispose();
        haloMaterial.dispose();
        texture.dispose();
        renderer.dispose();
        renderer.domElement.remove();
      };
    };

    initialize();

    return () => {
      isDisposed = true;
      cleanup?.();
    };
  }, []);

  if (hasFailed) {
    return (
      <div className="absolute inset-0">
        <Image
          src="/vimal-s-GBg3jyGS-Ug-unsplash.jpg"
          alt=""
          fill
          className="object-cover"
          priority
        />
        <div className="absolute inset-0 bg-gradient-to-b from-black/60 via-black/50 to-black/70" />
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      aria-hidden="true"
      className={`pointer-events-none absolute inset-0 transition-opacity duration-1000 ${
        isReady ? "opacity-100" : "opacity-0"
      }`}
    />
  );
}
