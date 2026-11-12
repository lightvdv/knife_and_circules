// Обработка кадра «под советский мультфильм»: сцена рисуется в текстуру, затем один проход по экрану
// превращает её в картинку, нарисованную гуашью на бумаге:
// - фильтр Кувахары сглаживает мелкие детали в мазки (фото-текстуры и модели из сервиса
//   перестают выглядеть «мыльным фото», становятся заливками краски);
// - по скачкам глубины рисуется мягкий тёмно-коричневый контур, как у рисованного фона;
// - тональная кривая, тёплая приглушённая палитра без чистого чёрного и белого;
// - фактура бумаги поверх.
import * as THREE from 'three';

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  #include <packing>
  uniform sampler2D tColor;
  uniform sampler2D tDepth;
  uniform vec2 texel;
  uniform float radius;
  uniform float lineWidth;
  uniform float cameraNear;
  uniform float cameraFar;
  varying vec2 vUv;

  const int MAX_R = 6;

  float viewDepth(vec2 uv) {
    return -perspectiveDepthToViewZ(texture2D(tDepth, uv).x, cameraNear, cameraFar);
  }

  // Классический фильтр Кувахары: из четырёх квадрантов вокруг пикселя берём среднее того,
  // где цвет ровнее всего. Края предметов остаются резкими, а внутри — плоские мазки.
  vec3 kuwahara(vec2 uv) {
    vec3 m[4];
    vec3 s[4];
    for (int k = 0; k < 4; k++) { m[k] = vec3(0.0); s[k] = vec3(0.0); }
    int r = int(radius);
    float n = float((r + 1) * (r + 1));
    for (int j = -MAX_R; j <= 0; j++) {
      if (j < -r) continue;
      for (int i = -MAX_R; i <= 0; i++) {
        if (i < -r) continue;
        vec3 c;
        // Тональная компрессия до усреднения: яркое солнце не растекается пятнами.
        c = texture2D(tColor, uv + vec2(i, j) * texel).rgb; c /= 1.0 + c; m[0] += c; s[0] += c * c;
        c = texture2D(tColor, uv + vec2(-i, j) * texel).rgb; c /= 1.0 + c; m[1] += c; s[1] += c * c;
        c = texture2D(tColor, uv + vec2(i, -j) * texel).rgb; c /= 1.0 + c; m[2] += c; s[2] += c * c;
        c = texture2D(tColor, uv + vec2(-i, -j) * texel).rgb; c /= 1.0 + c; m[3] += c; s[3] += c * c;
      }
    }
    vec3 best = m[0] / n;
    float minVar = 1e9;
    for (int k = 0; k < 4; k++) {
      vec3 mean = m[k] / n;
      vec3 v = abs(s[k] / n - mean * mean);
      float var = v.r + v.g + v.b;
      if (var < minVar) { minVar = var; best = mean; }
    }
    return best / max(vec3(1e-4), 1.0 - best); // обратно из сжатого диапазона
  }

  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
  }

  vec3 aces(vec3 x) {
    return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
  }

  void main() {
    vec3 col = kuwahara(vUv);

    // Контур: относительный скачок глубины к соседям.
    float d = viewDepth(vUv);
    vec2 o = texel * lineWidth;
    float dl = viewDepth(vUv - vec2(o.x, 0.0));
    float dr = viewDepth(vUv + vec2(o.x, 0.0));
    float du = viewDepth(vUv + vec2(0.0, o.y));
    float dd = viewDepth(vUv - vec2(0.0, o.y));
    // Вторая производная: линия только там, где край, а не на наклонной плоскости (пол вдали).
    float edge = (abs(dl + dr - 2.0 * d) + abs(du + dd - 2.0 * d)) / d;
    float line = smoothstep(0.015, 0.05, edge);

    // Свет и цвет: плёночная кривая, затем в sRGB.
    col = aces(col * 0.85);
    col = pow(col, vec3(1.0 / 2.2));

    // Палитра гуаши: чуть приглушить, согреть, тени — тёплый коричневый вместо чёрного.
    float g = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(vec3(g), col, 0.92);
    col *= vec3(1.03, 1.0, 0.9);
    vec3 shadowInk = vec3(0.17, 0.11, 0.08);
    vec3 paperWhite = vec3(0.97, 0.93, 0.84);
    col = shadowInk + col * (paperWhite - shadowInk);

    // Контур — тёмно-коричневая краска, не чёрная тушь.
    col = mix(col, vec3(0.22, 0.14, 0.1), line * 0.85);

    // Бумага: мелкое зерно и крупные неровности пигмента.
    vec2 px = gl_FragCoord.xy;
    float grain = noise(px * 0.7) * 0.5 + noise(px * 0.23) * 0.5;
    float blotch = noise(px * 0.008) * 0.6 + noise(px * 0.02) * 0.4;
    col *= 0.94 + 0.07 * grain;
    col *= 0.95 + 0.08 * blotch;

    // Лёгкая виньетка.
    vec2 c = vUv - 0.5;
    col *= 1.0 - 0.35 * dot(c, c);

    gl_FragColor = vec4(col, 1.0);
  }
`;

/** Рисует сцену через гуашевую обработку. Вызывать вместо renderer.render. */
export class PaintRenderer {
  private target: THREE.WebGLRenderTarget;
  private quadScene = new THREE.Scene();
  private quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private material: THREE.ShaderMaterial;

  constructor(private renderer: THREE.WebGLRenderer) {
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      depthTexture: new THREE.DepthTexture(1, 1),
    });
    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        tColor: { value: this.target.texture },
        tDepth: { value: this.target.depthTexture },
        texel: { value: new THREE.Vector2() },
        radius: { value: 3 },
        lineWidth: { value: 1 },
        cameraNear: { value: 0.1 },
        cameraFar: { value: 100 },
      },
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    quad.frustumCulled = false;
    this.quadScene.add(quad);
  }

  /** Размер в пикселях устройства. */
  setSize(width: number, height: number) {
    this.target.setSize(width, height);
    const u = this.material.uniforms;
    u.texel.value.set(1 / width, 1 / height);
    // Размер мазка и толщина линии — от высоты кадра, чтобы на телефоне и мониторе было одинаково.
    u.radius.value = THREE.MathUtils.clamp(Math.round(height / 260), 2, 6);
    u.lineWidth.value = Math.max(1, height / 800);
  }

  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    const u = this.material.uniforms;
    u.cameraNear.value = camera.near;
    u.cameraFar.value = camera.far;
    this.renderer.setRenderTarget(this.target);
    this.renderer.render(scene, camera);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.quadScene, this.quadCamera);
  }
}
