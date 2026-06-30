import './style.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import GUI from 'lil-gui';

// Global Configuration Object
const config = {
  rotationSpeed: 0.05,
  highResMode: true,
  showAtmosphere: false,
  showClouds: true,
  sunIntensity: 3.0,
  showISS: true
};

// Setup Scene and Camera
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(0, 0, 5);

// Setup Lighting
const ambientLight = new THREE.AmbientLight(0xffffff, 0.05); // low light for dark side
scene.add(ambientLight);
const sunLight = new THREE.DirectionalLight(0xffffff, config.sunIntensity);
sunLight.position.set(5, 3, 5);
scene.add(sunLight);

// Setup WebGL Renderer
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
// Output encoding and tone mapping for realism
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
document.querySelector('#app').appendChild(renderer.domElement);

// Setup Controls
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.minDistance = 1.2;
controls.maxDistance = 10;
controls.enablePan = false; // Prevent panning away from Earth

// Texture Loader Setup
const textureLoader = new THREE.TextureLoader();
const maxAnisotropy = renderer.capabilities.getMaxAnisotropy();

function optimizeTexture(texture) {
  texture.anisotropy = maxAnisotropy;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  return texture;
}

const earthColorMap = optimizeTexture(textureLoader.load('/textures/earth_atmos_2048.jpg'));
const earthNormalMap = optimizeTexture(textureLoader.load('/textures/earth_normal_2048.jpg'));
const earthSpecularMap = optimizeTexture(textureLoader.load('/textures/earth_specular_2048.jpg'));
const earthCloudsMap = optimizeTexture(textureLoader.load('/textures/earth_clouds_1024.png'));
const earthLightsMap = optimizeTexture(textureLoader.load('/textures/earth_lights_2048.jpg'));
earthColorMap.colorSpace = THREE.SRGBColorSpace;

// Earth Group to hold Earth and Clouds
const earthGroup = new THREE.Group();
earthGroup.rotation.z = -23.4 * Math.PI / 180; // axial tilt
scene.add(earthGroup);

// Earth Mesh
const earthGeometry = new THREE.SphereGeometry(1, 64, 64);
// Earth Material
const earthMaterial = new THREE.MeshPhongMaterial({
  color: 0xffffff, // White base to multiply with color map
  emissive: 0x000000,
  specular: 0x000000,
  shininess: 0,
  map: earthColorMap
});

// Custom Shader Injection for Dynamic Night Lights
earthMaterial.onBeforeCompile = (shader) => {
  shader.uniforms.tLights = { value: earthLightsMap };
  shader.uniforms.sunDirection = { value: new THREE.Vector3().copy(sunLight.position).normalize() };
  // Luminance cutoff (low/high) used to mask the lights texture's background,
  // and an overall brightness for the city lights. Defaults are tuned for the
  // 2k lights map (which has a bright purple base); the high-res toggle lowers
  // the cutoff for the much darker 8k Black Marble map.
  shader.uniforms.uNightCutoff = { value: new THREE.Vector2(0.20, 0.45) };
  shader.uniforms.uNightIntensity = { value: 2.0 };

  // Expose the sun direction uniform so we can update it later
  earthMaterial.userData.shader = shader;

  // Declare the custom uniforms at global scope (uniforms cannot be declared
  // inside main(), which would make the fragment shader fail to compile and
  // leave the Earth black/untextured).
  shader.fragmentShader = shader.fragmentShader.replace(
    'void main() {',
    `
    uniform sampler2D tLights;
    uniform vec3 sunDirection;
    uniform vec2 uNightCutoff;
    uniform float uNightIntensity;

    void main() {`
  );

  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <dithering_fragment>',
    `
    #include <dithering_fragment>

    // sunDirection is already supplied in view space from the animation loop,
    // so it must NOT be transformed again here (doing so applies the camera
    // rotation twice and flips day/night when the camera orbits).
    vec3 viewSunDir = normalize(sunDirection);
    vec3 viewNormal = normalize(vNormal);
    
    float dotNL = dot(viewNormal, viewSunDir);
    // Soft terminator: a gradual dusk band reads more naturally than a hard edge.
    float dayFactor = smoothstep(-0.12, 0.18, dotNL);

    // Day side: use the texture's true colors (neutral tint) so warm
    // terrain like the Sahara stays tan/yellow instead of going purple.
    vec3 dayColor = diffuseColor.rgb;

    // Night side: mask out the lights texture's dark background using its
    // perceptual luminance, then keep the texture's own (warm) colors so the
    // city lights read realistically. The cutoff/intensity are uniforms so the
    // 8k Black Marble map and the 2k fallback can each be tuned correctly.
    vec3 lightsTex = texture2D(tLights, vMapUv).rgb;
    float lightsLuma = dot(lightsTex, vec3(0.299, 0.587, 0.114));
    float cityMask = smoothstep(uNightCutoff.x, uNightCutoff.y, lightsLuma);
    vec3 nightColor = lightsTex * cityMask * uNightIntensity;

    // Final composite: night-side city lights blended into the lit day color.
    gl_FragColor.rgb = mix(nightColor, dayColor, dayFactor);
    `
  );
};

const earth = new THREE.Mesh(earthGeometry, earthMaterial);
earthGroup.add(earth);

// Cloud Mesh
const cloudGeometry = new THREE.SphereGeometry(1.01, 64, 64);
const cloudMaterial = new THREE.MeshLambertMaterial({
  map: earthCloudsMap,
  transparent: true,
  opacity: 0.6, // Lowered slightly to prevent blowout
  blending: THREE.NormalBlending, // Changed from AdditiveBlending to prevent extreme brightness in sunlight
  side: THREE.DoubleSide,
  depthWrite: false
});
const clouds = new THREE.Mesh(cloudGeometry, cloudMaterial);
earthGroup.add(clouds);

// --- ISS Live Tracker ---
// ISS Group placeholder (added to earth so it rotates with the geographic surface)
const issGroup = new THREE.Group();
earth.add(issGroup);

// Load the 3D ISS model asynchronously
const gltfLoader = new GLTFLoader();
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
gltfLoader.setDRACOLoader(dracoLoader);
let issModel = null;
gltfLoader.load('/models/iss.glb', (gltf) => {
  issModel = gltf.scene;
  // Scale the model to be visible but proportional on the globe
  issModel.scale.setScalar(0.0004);
  // Use unlit material so the ISS is always clearly visible regardless of sun direction
  issModel.traverse((child) => {
    if (child.isMesh) {
      const box = new THREE.Box3().setFromObject(child);
      const size = new THREE.Vector3();
      const center = new THREE.Vector3();
      box.getSize(size);
      box.getCenter(center);

      // The main ISS structure is located closer to the origin (Y < 20).
      // The disconnected artifacts floating above are located at Y > 40.
      if (center.y > 20) {
        child.visible = false;
        console.log(`Hiding standalone mesh: "${child.name}" at Y = ${center.y.toFixed(2)} `);
      } else {
        child.material = new THREE.MeshBasicMaterial({
          map: child.material.map || null,
          color: child.material.map ? 0xffffff : child.material.color,
        });
      }
    }
  });
  issGroup.add(issModel);
  console.log('ISS 3D model loaded successfully');
}, undefined, (error) => {
  console.error('Failed to load ISS model:', error);
});

// Function to convert Latitude/Longitude/Altitude to Vector3 relative to Earth
function latLongToVector3(lat, lon, radius, altitude) {
  // Math to convert geographic coordinates to spherical coordinates in Three.js
  // phi is angle from North Pole (0) to South Pole (PI)
  const phi = (90 - lat) * (Math.PI / 180);
  // theta is angle around the equator, mapped to Three's coordinate system
  // The standard earth texture has the Prime Meridian at U=0.5 (+X axis)
  // Positive longitude (East) maps towards U=0.75 (-Z axis).
  // Let's adjust the theta calculation to correctly invert the rotation angle:
  const theta = (-lon) * (Math.PI / 180);

  // Calculate final distance from center
  // 6371 is approx Earth radius in km. We scale altitude to our sphere radius base.
  const scaledAltitude = radius * (altitude / 6371);
  const distance = radius + scaledAltitude;

  // Convert spherical to Cartesian
  // Using standard spherical coordinates mapping to Three.js (Y-up)
  const x = distance * Math.sin(phi) * Math.cos(theta);
  const z = distance * Math.sin(phi) * Math.sin(theta);
  const y = distance * Math.cos(phi);

  return new THREE.Vector3(x, y, z);
}

// Function to calculate accurate sun position and Earth rotation
function updateSunAndEarthRotation() {
  const now = new Date();

  // 1. Sun's Yearly Orbit (Theta in XZ plane)
  const start = new Date(now.getFullYear(), 0, 0);
  const diff = now - start;
  const dayOfYear = Math.floor(diff / (1000 * 60 * 60 * 24));
  // Summer solstice (~June 21) is day 172. 
  const daysSinceSolstice = dayOfYear - 172;
  const theta = (daysSinceSolstice / 365.25) * 2 * Math.PI;

  const distance = 5;
  // Since the parent earthGroup is tilted by -23.4 degrees on the Z-axis, placing the sun along the XZ plane creates a proper ecliptic orbit!
  sunLight.position.set(distance * Math.cos(theta), 0, -distance * Math.sin(theta));

  // 2. Earth's Daily Rotation (Genuine Real Time)
  const utcHours = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600 + now.getUTCMilliseconds() / 3600000;

  // Sub-solar longitude (where it is local solar noon): 15°/hour, 0° at 12:00 UTC.
  const subSolarLon = (12 - utcHours) * (Math.PI / 12);

  // Azimuth of the sun about the Earth's spin axis. The axis is tilted by the
  // parent earthGroup (rotation.z = -23.4°), so the sun direction must be read
  // in the group's local frame. The sun lies in the world XZ-plane (y = 0), so
  // un-tilting about Z only scales its X component by cos(tilt).
  const tilt = 23.4 * Math.PI / 180;
  const sunAzimuth = Math.atan2(Math.cos(tilt) * sunLight.position.x, sunLight.position.z);

  // With a standard equirectangular texture on THREE.SphereGeometry, a surface
  // point at longitude L sits at azimuth (L + PI/2 + earth.rotation.y). Solving
  // for the rotation that brings the sub-solar meridian under the sun:
  earth.rotation.y = sunAzimuth - Math.PI / 2 - subSolarLon;

  // Allow the clouds to drift slightly over time relative to the Earth
  clouds.rotation.y = earth.rotation.y + (now.getTime() * 0.0000001);
}

// Initial update
updateSunAndEarthRotation();

// Polling function
async function updateISSPosition() {
  if (!config.showISS) return;

  try {
    const response = await fetch('https://api.wheretheiss.at/v1/satellites/25544');
    const data = await response.json();

    // Map the real world position to our 3D globe
    const newPos = latLongToVector3(data.latitude, data.longitude, 1.0, data.altitude);

    // Update mesh position
    issGroup.position.copy(newPos);

    // Orient the ISS model to face tangent to the earth surface
    if (issModel) {
      // Make the ISS look away from center (outward from Earth)
      issGroup.lookAt(0, 0, 0);
      // Rotate 180° so the model faces the direction of travel rather than inward
      issGroup.rotateY(Math.PI);
    }

  } catch (error) {
    console.error("Failed to fetch ISS data:", error);
  }
}

// Initial fetch and set interval loop (10 seconds)
updateISSPosition();
setInterval(updateISSPosition, 10000);

// Atmospheric Glow (Fresnel effect)
const atmosphereVertexShader = `
  varying vec3 vNormal;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
  `;
const atmosphereFragmentShader = `
  varying vec3 vNormal;
  void main() {
    float intensity = pow(0.6 - dot(vNormal, vec3(0, 0, 1.0)), 4.0);
    gl_FragColor = vec4(0.3, 0.6, 1.0, 1.0) * intensity;
  }
  `;
const atmosphereMaterial = new THREE.ShaderMaterial({
  vertexShader: atmosphereVertexShader,
  fragmentShader: atmosphereFragmentShader,
  blending: THREE.AdditiveBlending,
  side: THREE.BackSide,
  transparent: true
});
const atmosphereGeometry = new THREE.SphereGeometry(1.2, 64, 64);
const atmosphere = new THREE.Mesh(atmosphereGeometry, atmosphereMaterial);
atmosphere.visible = config.showAtmosphere; // Follow config
scene.add(atmosphere);

// Procedural Starfield
function createStars() {
  const starsGeometry = new THREE.BufferGeometry();
  const count = 5000;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const color = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const r = 20 + Math.random() * 50;
    const theta = 2 * Math.PI * Math.random();
    const phi = Math.acos(2 * Math.random() - 1);
    const x = r * Math.sin(phi) * Math.cos(theta);
    const y = r * Math.sin(phi) * Math.sin(theta);
    const z = r * Math.cos(phi);
    positions[i * 3] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;

    // Varying star color (slight blue/white/yellow tints)
    const starType = Math.random();
    if (starType > 0.9) color.setHex(0xaabfff);
    else if (starType > 0.8) color.setHex(0xffddaa);
    else color.setHex(0xffffff);

    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  starsGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  starsGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const starsMaterial = new THREE.PointsMaterial({
    size: 0.1,
    vertexColors: true,
    transparent: true,
    opacity: 0.8,
    sizeAttenuation: true
  });
  return new THREE.Points(starsGeometry, starsMaterial);
}
scene.add(createStars());

// Setup GUI
const gui = new GUI({ title: 'Earth Control Panel' });
const earthFolder = gui.addFolder('Earth Settings');
earthFolder.add(config, 'rotationSpeed', 0, 0.5, 0.01).name('Rotation Speed');
const toggleHighResMode = (value) => {
  if (value) {
    document.body.style.cursor = 'wait';

    // Load 8k textures asynchronously (JPG format only as TIF throws browser errors)
    Promise.all([
      textureLoader.loadAsync('/textures/8k_earth_daymap.jpg'),
      textureLoader.loadAsync('/textures/8k_earth_clouds.jpg'),
      textureLoader.loadAsync('/textures/8k_earth_nightmap.jpg')
    ]).then(([color8k, clouds8k, night8k]) => {

      // Apply maximum quality settings to the high-res textures
      optimizeTexture(color8k);
      optimizeTexture(clouds8k);
      optimizeTexture(night8k);

      color8k.colorSpace = THREE.SRGBColorSpace;
      // Note: we intentionally do NOT set SRGB color space for the clouds texture
      // as it is used as an alpha/diffuse map and SRGB blows out the brightness.

      earthMaterial.map = color8k;
      // Remove normal and specular maps for stylized smooth look
      earthMaterial.normalMap = null;
      earthMaterial.specularMap = null;

      // The 8k clouds JPG is white clouds on a solid black background with no
      // alpha channel. Used as a color map it would draw the black background
      // as semi-transparent black and darken the whole globe, so instead use
      // its luminance as an alpha map (dark = transparent, bright = cloud) and
      // render the clouds as plain white.
      cloudMaterial.map = null;
      cloudMaterial.alphaMap = clouds8k;
      cloudMaterial.color.set(0xffffff);
      cloudMaterial.opacity = 0.9;

      // Swap in the 8k Black Marble night map. Its background is near-black, so
      // use a low luminance cutoff to preserve dim/small-town lights.
      if (earthMaterial.userData.shader) {
        const u = earthMaterial.userData.shader.uniforms;
        u.tLights.value = night8k;
        u.uNightCutoff.value.set(0.05, 0.18);
        u.uNightIntensity.value = 2.2;
      }

      earthMaterial.needsUpdate = true;
      cloudMaterial.needsUpdate = true;

      document.body.style.cursor = 'default';
      console.log('8k textures loaded successfully');
    }).catch(err => {
      console.error('Failed to load 8k textures. Are they downloaded?', err);
      document.body.style.cursor = 'default';
    });
  } else {
    // Revert to 2k
    earthMaterial.map = earthColorMap;
    earthMaterial.normalMap = null;
    earthMaterial.specularMap = null;
    // The 2k clouds PNG has a real alpha channel, so use it as a color map.
    cloudMaterial.alphaMap = null;
    cloudMaterial.map = earthCloudsMap;
    cloudMaterial.color.set(0xffffff);
    cloudMaterial.opacity = 0.6; // Revert opacity

    // Restore the 2k lights map and its higher cutoff (its background is a
    // bright purple that needs a stronger threshold to remove).
    if (earthMaterial.userData.shader) {
      const u = earthMaterial.userData.shader.uniforms;
      u.tLights.value = earthLightsMap;
      u.uNightCutoff.value.set(0.20, 0.45);
      u.uNightIntensity.value = 2.0;
    }

    earthMaterial.needsUpdate = true;
    cloudMaterial.needsUpdate = true;
  }
};

earthFolder.add(config, 'highResMode').name('High-Res Mode (8k)').onChange(toggleHighResMode);

// Trigger initial load if default is true
if (config.highResMode) {
  toggleHighResMode(true);
}

const envFolder = gui.addFolder('Environment Settings');
envFolder.add(config, 'showAtmosphere').name('Glow').onChange((value) => {
  atmosphere.visible = value;
});
envFolder.add(config, 'showClouds').name('Clouds').onChange((v) => clouds.visible = v);
envFolder.add(config, 'sunIntensity', 0, 5, 0.1).name('Sun Intensity').onChange((v) => sunLight.intensity = v);

const osintFolder = gui.addFolder('Live Data (OSINT)');
osintFolder.add(config, 'showISS').name('Live ISS Tracker').onChange((v) => {
  issGroup.visible = v;
  if (v) updateISSPosition(); // Force update if turned back on
});

// Handle Window Resize
window.addEventListener('resize', onWindowResize, false);

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

// Animation Loop
const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const delta = clock.getDelta();

  // Calculate real-time sun position and earth rotation
  updateSunAndEarthRotation();

  // Update sun direction in the shader
  // The Three.js fragment shader's vNormal is in view space, 
  // so the sun direction must be in view space too for dot(vNormal, sunDirection) to work correctly!
  if (earthMaterial.userData.shader) {
    const sunWorldDir = sunLight.position.clone().normalize();
    sunWorldDir.transformDirection(camera.matrixWorldInverse).normalize();
    earthMaterial.userData.shader.uniforms.sunDirection.value.copy(sunWorldDir);
  }

  controls.update();
  renderer.render(scene, camera);
}

animate();
