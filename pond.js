(() => {
  'use strict';

  // =========================================================================
  // ASCII KOI POND — Original Interactive Typographic Pond Engine
  // Cell shader architecture: main(x, y, t, pointer) -> { glyph, color }
  // Supports live 60fps interaction AND deterministic frame-by-frame capture.
  // =========================================================================

  const IS_CAPTURE = new URLSearchParams(window.location.search).get('capture') === '1';
  const FIXED_DT = 1 / 60;
  const PREWARM_FRAMES = 210; // 3.5s pre-roll so frame 0 is already lush & in motion

  // Cell metrics: 192x60 grid at 1920x1080
  const CELL_W = 10;
  const CELL_H = 18;
  const ASPECT = CELL_W / CELL_H; // 0.55555... world units per column

  // -------------------------------------------------------------------------
  // Seeded Deterministic PRNG (Mulberry32) & Fast Coordinate Hash
  // -------------------------------------------------------------------------
  function createRng(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hash2(x, y, s = 0) {
    let n = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 1442695041);
    n = (n ^ (n >>> 13)) | 0;
    n = Math.imul(n, 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function smoothstep(e0, e1, x) {
    const u = clamp((x - e0) / (e1 - e0), 0, 1);
    return u * u * (3 - 2 * u);
  }

  function angleDiff(a, b) {
    let d = (b - a + Math.PI) % (Math.PI * 2);
    if (d < 0) d += Math.PI * 2;
    return d - Math.PI;
  }

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  // Quantized color string cache (cuts string allocations & Canvas fillStyle switches dramatically)
  const colorCache = new Map();
  function rgbStr(r, g, b) {
    const rq = (r & 0xfc);
    const gq = (g & 0xfc);
    const bq = (b & 0xfc);
    const key = (rq << 16) | (gq << 8) | bq;
    let s = colorCache.get(key);
    if (s === undefined) {
      s = `rgb(${rq},${gq},${bq})`;
      colorCache.set(key, s);
    }
    return s;
  }

  function mixRgb(c1, c2, t) {
    const u = clamp(t, 0, 1);
    return [
      c1[0] + (c2[0] - c1[0]) * u,
      c1[1] + (c2[1] - c1[1]) * u,
      c1[2] + (c2[2] - c1[2]) * u,
    ];
  }

  function scaleRgb(c, m) {
    return [
      clamp(c[0] * m, 0, 255),
      clamp(c[1] * m, 0, 255),
      clamp(c[2] * m, 0, 255),
    ];
  }

  // -------------------------------------------------------------------------
  // 4 Original Pond Presets (1: Calm, 2: Rain, 3: Sunset, 4: Moonlight)
  // -------------------------------------------------------------------------
  const PRESETS = [
    {
      id: 1,
      key: 'calm',
      name: 'CALM',
      subtitle: 'SUNLIT JADE POND',
      bg: hexToRgb('#051317'),
      bgEdge: hexToRgb('#030b0e'),
      waterLow: hexToRgb('#0c2b30'),
      waterMid: hexToRgb('#17484e'),
      waterHigh: hexToRgb('#2d7c7c'),
      causticBright: hexToRgb('#67b8ac'),
      rippleColor: hexToRgb('#9ae8db'),
      rippleSub: hexToRgb('#4ca39c'),
      padDark: hexToRgb('#14472c'),
      padMid: hexToRgb('#236d40'),
      padBright: hexToRgb('#48a35c'),
      padVein: hexToRgb('#7ad17b'),
      padShadow: hexToRgb('#030c0e'),
      blossomOuter: hexToRgb('#f4a9ba'),
      blossomInner: hexToRgb('#fff1dc'),
      blossomCore: hexToRgb('#ffd257'),
      foodBright: hexToRgb('#ffd86e'),
      foodDim: hexToRgb('#c78d36'),
      wakeColor: hexToRgb('#7ad4cc'),
      rainColor: hexToRgb('#8fc5d9'),
      sparkleColor: hexToRgb('#9be8d8'),
      koiTint: hexToRgb('#fffaf2'),
      koiTintAmt: 0.0,
      koiHighlight: hexToRgb('#fff8d6'),
      hudAccent: '#7ce5d2',
      hudMuted: '#4e7c7b',
      hudBg: 'rgba(4, 15, 19, 0.78)',
      hudBorder: 'rgba(104, 200, 184, 0.28)',
      waterGlyphs: [' ', ' ', '.', ',', ':', '~', '-', '=', '~'],
      causticGlyphs: ['·', ':', ';', '~', '≈', '+', '*'],
      swimSpeedMul: 1.0,
      finFreqMul: 1.0,
      currentSpeed: 0.85,
      ambientRippleRate: 0.9,
      rainIntensity: 0.0,
      sunsetGlow: 0.0,
      moonSparkle: 0.0,
    },
    {
      id: 2,
      key: 'rain',
      name: 'RAIN',
      subtitle: 'SILVER SHOWER RIPPLES',
      bg: hexToRgb('#060d15'),
      bgEdge: hexToRgb('#03070d'),
      waterLow: hexToRgb('#0f2030'),
      waterMid: hexToRgb('#1b384f'),
      waterHigh: hexToRgb('#34607d'),
      causticBright: hexToRgb('#6fa4be'),
      rippleColor: hexToRgb('#bce4f7'),
      rippleSub: hexToRgb('#5f94b2'),
      padDark: hexToRgb('#12362a'),
      padMid: hexToRgb('#1f5440'),
      padBright: hexToRgb('#397e61'),
      padVein: hexToRgb('#65ad8a'),
      padShadow: hexToRgb('#03080f'),
      blossomOuter: hexToRgb('#cf9fb5'),
      blossomInner: hexToRgb('#e5e8f0'),
      blossomCore: hexToRgb('#d8c47a'),
      foodBright: hexToRgb('#f5cf7a'),
      foodDim: hexToRgb('#a88647'),
      wakeColor: hexToRgb('#9fd2e8'),
      rainColor: hexToRgb('#a8d8f0'),
      sparkleColor: hexToRgb('#d0eeff'),
      koiTint: hexToRgb('#9cbcd4'),
      koiTintAmt: 0.22,
      koiHighlight: hexToRgb('#d6f0ff'),
      hudAccent: '#9fd7f2',
      hudMuted: '#537388',
      hudBg: 'rgba(5, 12, 20, 0.80)',
      hudBorder: 'rgba(130, 195, 230, 0.30)',
      waterGlyphs: [' ', '.', '`', ',', ':', ';', '~', '-', '~'],
      causticGlyphs: [':', ';', '~', '-', '/', '≈', '+'],
      swimSpeedMul: 1.24,
      finFreqMul: 1.32,
      currentSpeed: 1.35,
      ambientRippleRate: 2.2,
      rainIntensity: 1.0,
      sunsetGlow: 0.0,
      moonSparkle: 0.0,
    },
    {
      id: 3,
      key: 'sunset',
      name: 'SUNSET',
      subtitle: 'AMBER & ROSE REFLECTION',
      bg: hexToRgb('#120812'),
      bgEdge: hexToRgb('#09040a'),
      waterLow: hexToRgb('#28121f'),
      waterMid: hexToRgb('#4d212b'),
      waterHigh: hexToRgb('#8f4036'),
      causticBright: hexToRgb('#f09948'),
      rippleColor: hexToRgb('#ffd27d'),
      rippleSub: hexToRgb('#c96a48'),
      padDark: hexToRgb('#262b17'),
      padMid: hexToRgb('#444b21'),
      padBright: hexToRgb('#787531'),
      padVein: hexToRgb('#b89b49'),
      padShadow: hexToRgb('#0a040a'),
      blossomOuter: hexToRgb('#ff8a7a'),
      blossomInner: hexToRgb('#ffe2b0'),
      blossomCore: hexToRgb('#ffbe3b'),
      foodBright: hexToRgb('#ffe484'),
      foodDim: hexToRgb('#d4863b'),
      wakeColor: hexToRgb('#f7b56b'),
      rainColor: hexToRgb('#f2b680'),
      sparkleColor: hexToRgb('#ffe38f'),
      koiTint: hexToRgb('#ff7b36'),
      koiTintAmt: 0.16,
      koiHighlight: hexToRgb('#ffe699'),
      hudAccent: '#ffb963',
      hudMuted: '#8f5d52',
      hudBg: 'rgba(18, 8, 16, 0.80)',
      hudBorder: 'rgba(245, 162, 85, 0.32)',
      waterGlyphs: [' ', '.', '-', '~', '=', ':', '-', '~', '='],
      causticGlyphs: ['-', '=', '~', '≈', ':', '*', '+'],
      swimSpeedMul: 0.84,
      finFreqMul: 0.86,
      currentSpeed: 0.65,
      ambientRippleRate: 0.75,
      rainIntensity: 0.0,
      sunsetGlow: 1.0,
      moonSparkle: 0.0,
    },
    {
      id: 4,
      key: 'moonlight',
      name: 'MOONLIGHT',
      subtitle: 'INDIGO & SILVER GLIDE',
      bg: hexToRgb('#040712'),
      bgEdge: hexToRgb('#02040a'),
      waterLow: hexToRgb('#0b132b'),
      waterMid: hexToRgb('#16244a'),
      waterHigh: hexToRgb('#334e80'),
      causticBright: hexToRgb('#94b4e3'),
      rippleColor: hexToRgb('#e2f0ff'),
      rippleSub: hexToRgb('#6a8bc2'),
      padDark: hexToRgb('#152430'),
      padMid: hexToRgb('#263d4d'),
      padBright: hexToRgb('#4d6d7d'),
      padVein: hexToRgb('#90b5c7'),
      padShadow: hexToRgb('#02040b'),
      blossomOuter: hexToRgb('#b8cde8'),
      blossomInner: hexToRgb('#f2f7ff'),
      blossomCore: hexToRgb('#d8e8ff'),
      foodBright: hexToRgb('#e8e4b8'),
      foodDim: hexToRgb('#8a93a8'),
      wakeColor: hexToRgb('#bcd8ff'),
      rainColor: hexToRgb('#c8dfff'),
      sparkleColor: hexToRgb('#f4f9ff'),
      koiTint: hexToRgb('#9cbef0'),
      koiTintAmt: 0.24,
      koiHighlight: hexToRgb('#ffffff'),
      hudAccent: '#c8dfff',
      hudMuted: '#53678f',
      hudBg: 'rgba(4, 8, 20, 0.82)',
      hudBorder: 'rgba(165, 198, 245, 0.30)',
      waterGlyphs: [' ', ' ', '.', '·', ':', '~', '-', '·', '~'],
      causticGlyphs: ['·', ':', '~', '+', '*', '°', '≈'],
      swimSpeedMul: 0.74,
      finFreqMul: 0.76,
      currentSpeed: 0.45,
      ambientRippleRate: 0.65,
      rainIntensity: 0.0,
      sunsetGlow: 0.0,
      moonSparkle: 1.0,
    },
  ];

  // Blend helper for smooth preset transitions
  function blendPresetVisuals(pA, pB, u) {
    if (u >= 0.999) return pB;
    if (u <= 0.001) return pA;
    return {
      id: u < 0.5 ? pA.id : pB.id,
      name: u < 0.5 ? pA.name : pB.name,
      subtitle: u < 0.5 ? pA.subtitle : pB.subtitle,
      bg: mixRgb(pA.bg, pB.bg, u),
      bgEdge: mixRgb(pA.bgEdge, pB.bgEdge, u),
      waterLow: mixRgb(pA.waterLow, pB.waterLow, u),
      waterMid: mixRgb(pA.waterMid, pB.waterMid, u),
      waterHigh: mixRgb(pA.waterHigh, pB.waterHigh, u),
      causticBright: mixRgb(pA.causticBright, pB.causticBright, u),
      rippleColor: mixRgb(pA.rippleColor, pB.rippleColor, u),
      rippleSub: mixRgb(pA.rippleSub, pB.rippleSub, u),
      padDark: mixRgb(pA.padDark, pB.padDark, u),
      padMid: mixRgb(pA.padMid, pB.padMid, u),
      padBright: mixRgb(pA.padBright, pB.padBright, u),
      padVein: mixRgb(pA.padVein, pB.padVein, u),
      padShadow: mixRgb(pA.padShadow, pB.padShadow, u),
      blossomOuter: mixRgb(pA.blossomOuter, pB.blossomOuter, u),
      blossomInner: mixRgb(pA.blossomInner, pB.blossomInner, u),
      blossomCore: mixRgb(pA.blossomCore, pB.blossomCore, u),
      foodBright: mixRgb(pA.foodBright, pB.foodBright, u),
      foodDim: mixRgb(pA.foodDim, pB.foodDim, u),
      wakeColor: mixRgb(pA.wakeColor, pB.wakeColor, u),
      rainColor: mixRgb(pA.rainColor, pB.rainColor, u),
      sparkleColor: mixRgb(pA.sparkleColor, pB.sparkleColor, u),
      koiTint: mixRgb(pA.koiTint, pB.koiTint, u),
      koiTintAmt: lerp(pA.koiTintAmt, pB.koiTintAmt, u),
      koiHighlight: mixRgb(pA.koiHighlight, pB.koiHighlight, u),
      hudAccent: pB.hudAccent,
      hudMuted: pB.hudMuted,
      hudBg: pB.hudBg,
      hudBorder: pB.hudBorder,
      waterGlyphs: u < 0.5 ? pA.waterGlyphs : pB.waterGlyphs,
      causticGlyphs: u < 0.5 ? pA.causticGlyphs : pB.causticGlyphs,
      swimSpeedMul: lerp(pA.swimSpeedMul, pB.swimSpeedMul, u),
      finFreqMul: lerp(pA.finFreqMul, pB.finFreqMul, u),
      currentSpeed: lerp(pA.currentSpeed, pB.currentSpeed, u),
      ambientRippleRate: lerp(pA.ambientRippleRate, pB.ambientRippleRate, u),
      rainIntensity: lerp(pA.rainIntensity, pB.rainIntensity, u),
      sunsetGlow: lerp(pA.sunsetGlow, pB.sunsetGlow, u),
      moonSparkle: lerp(pA.moonSparkle, pB.moonSparkle, u),
    };
  }

  // -------------------------------------------------------------------------
  // Directional ASCII Glyph Helpers
  // -------------------------------------------------------------------------
  // Return an orientation-aware stroke glyph for a given tangent angle (radians)
  function angleStroke(angle, bold = false) {
    let a = ((angle % Math.PI) + Math.PI) % Math.PI; // [0, PI)
    const oct = Math.round((a / Math.PI) * 8) % 8;
    if (bold) {
      // 0: horiz, 1/2: diag down-right (\), 3/4: vert (|), 5/6: diag up-right (/)
      const map = ['=', '=', '\\', '\\', '|', '/', '/', '='];
      return map[oct];
    }
    const map = ['-', '-', '\\', '\\', '|', '/', '/', '-'];
    return map[oct];
  }

  function rippleArcGlyph(angle, strength) {
    // Tangent of circle at polar angle `angle` is `angle + PI/2`
    const tang = angle + Math.PI * 0.5;
    let a = ((tang % Math.PI) + Math.PI) % Math.PI;
    const oct = Math.round((a / Math.PI) * 8) % 8;
    if (strength > 0.72) {
      return ['=', '~', '\\', ')', '|', '(', '/', '='][oct];
    }
    if (strength > 0.42) {
      return ['-', '~', '\\', ')', '|', '(', '/', '-'][oct];
    }
    return ['·', '.', ',', ':', ':', ',', '.', '·'][oct];
  }

  // -------------------------------------------------------------------------
  // Authentic Nishikigoi Varieties (8 distinct fish of mixed sizes)
  // -------------------------------------------------------------------------
  const KOI_SPECIES = [
    {
      // 0: Large Kohaku (Snow Ivory + Bold Vermilion Red saddles)
      name: 'Kohaku',
      length: 15.2,
      radius: 1.98,
      baseDepth: 0.22,
      speed: 7.4,
      baseColor: hexToRgb('#fffaf0'),
      mark1Color: hexToRgb('#ff4624'),
      mark2Color: hexToRgb('#e02814'),
      finColor: hexToRgb('#fff3dc'),
      bellyColor: hexToRgb('#e8dfcc'),
      eyeColor: hexToRgb('#100c0c'),
      pattern: 'kohaku',
      orbitCenter: [0.36, 0.46],
      orbitRx: 0.24,
      orbitRy: 0.22,
      orbitPhase: 0.4,
      orbitDir: 1,
    },
    {
      // 1: Large Showa (Slate-Charcoal + Fiery Crimson-Orange + Bright Ivory)
      name: 'Showa',
      length: 14.5,
      radius: 1.90,
      baseDepth: 0.32,
      speed: 7.1,
      baseColor: hexToRgb('#4b5668'),
      mark1Color: hexToRgb('#ff5a26'),
      mark2Color: hexToRgb('#f7f9fc'),
      finColor: hexToRgb('#e8f0fa'),
      bellyColor: hexToRgb('#647185'),
      eyeColor: hexToRgb('#ffd24d'),
      pattern: 'showa',
      orbitCenter: [0.64, 0.50],
      orbitRx: 0.23,
      orbitRy: 0.24,
      orbitPhase: 2.3,
      orbitDir: -1,
    },
    {
      // 2: Medium-Large Yamabuki Ogon (Molten Metallic Gold)
      name: 'Yamabuki',
      length: 13.6,
      radius: 1.78,
      baseDepth: 0.19,
      speed: 7.8,
      baseColor: hexToRgb('#ffc436'),
      mark1Color: hexToRgb('#fff08a'),
      mark2Color: hexToRgb('#e08e1b'),
      finColor: hexToRgb('#fff2ad'),
      bellyColor: hexToRgb('#d99929'),
      eyeColor: hexToRgb('#1a1208'),
      pattern: 'ogon',
      orbitCenter: [0.52, 0.36],
      orbitRx: 0.27,
      orbitRy: 0.18,
      orbitPhase: 4.1,
      orbitDir: 1,
    },
    {
      // 3: Medium-Large Tancho (Pure Pearl White + Scarlet Forehead Crown)
      name: 'Tancho',
      length: 13.0,
      radius: 1.72,
      baseDepth: 0.38,
      speed: 7.2,
      baseColor: hexToRgb('#f7fbff'),
      mark1Color: hexToRgb('#ff2929'),
      mark2Color: hexToRgb('#d8e4f2'),
      finColor: hexToRgb('#eef6ff'),
      bellyColor: hexToRgb('#cedaeb'),
      eyeColor: hexToRgb('#121822'),
      pattern: 'tancho',
      orbitCenter: [0.46, 0.62],
      orbitRx: 0.26,
      orbitRy: 0.19,
      orbitPhase: 1.1,
      orbitDir: -1,
    },
    {
      // 4: Medium Sanke (Warm Cream + Vivid Tangerine + Crisp Ink Flecks)
      name: 'Sanke',
      length: 11.8,
      radius: 1.56,
      baseDepth: 0.27,
      speed: 8.3,
      baseColor: hexToRgb('#fff6e3'),
      mark1Color: hexToRgb('#ff6d29'),
      mark2Color: hexToRgb('#2a3140'),
      finColor: hexToRgb('#ffedd1'),
      bellyColor: hexToRgb('#e6dac2'),
      eyeColor: hexToRgb('#111114'),
      pattern: 'sanke',
      orbitCenter: [0.28, 0.62],
      orbitRx: 0.19,
      orbitRy: 0.20,
      orbitPhase: 3.3,
      orbitDir: 1,
    },
    {
      // 5: Medium Asagi (Luminous Sky-Indigo reticulated back + Coral-Orange flanks)
      name: 'Asagi',
      length: 11.4,
      radius: 1.52,
      baseDepth: 0.48,
      speed: 7.6,
      baseColor: hexToRgb('#72a8db'),
      mark1Color: hexToRgb('#ff7e47'),
      mark2Color: hexToRgb('#a6d8f7'),
      finColor: hexToRgb('#ffae87'),
      bellyColor: hexToRgb('#f07240'),
      eyeColor: hexToRgb('#0e1420'),
      pattern: 'asagi',
      orbitCenter: [0.73, 0.42],
      orbitRx: 0.18,
      orbitRy: 0.24,
      orbitPhase: 5.2,
      orbitDir: 1,
    },
    {
      // 6: Smaller Benigoi (Vivid Fiery Persimmon-Red)
      name: 'Benigoi',
      length: 10.2,
      radius: 1.38,
      baseDepth: 0.34,
      speed: 8.8,
      baseColor: hexToRgb('#ff5829'),
      mark1Color: hexToRgb('#ffa442'),
      mark2Color: hexToRgb('#d43013'),
      finColor: hexToRgb('#ffba80'),
      bellyColor: hexToRgb('#d94420'),
      eyeColor: hexToRgb('#190d0a'),
      pattern: 'benigoi',
      orbitCenter: [0.58, 0.66],
      orbitRx: 0.22,
      orbitRy: 0.16,
      orbitPhase: 0.9,
      orbitDir: -1,
    },
    {
      // 7: Smaller Shiro Utsuri (High-contrast Slate-Charcoal & Snow-White)
      name: 'ShiroUtsuri',
      length: 9.8,
      radius: 1.34,
      baseDepth: 0.44,
      speed: 8.4,
      baseColor: hexToRgb('#f5faff'),
      mark1Color: hexToRgb('#354054'),
      mark2Color: hexToRgb('#c8dbf2'),
      finColor: hexToRgb('#edf6ff'),
      bellyColor: hexToRgb('#cddbe8'),
      eyeColor: hexToRgb('#0e1015'),
      pattern: 'utsuri',
      orbitCenter: [0.35, 0.32],
      orbitRx: 0.21,
      orbitRy: 0.17,
      orbitPhase: 4.8,
      orbitDir: 1,
    },
  ];

  // -------------------------------------------------------------------------
  // Lily Pad Blueprints (normalized positions, radii, notches, blossoms)
  // -------------------------------------------------------------------------
  const PAD_SPECS = [
    { nx: 0.13, ny: 0.22, r: 5.8, notch: 0.45, blossom: true,  rotSpd: 0.045 },
    { nx: 0.21, ny: 0.15, r: 3.9, notch: 2.15, blossom: false, rotSpd: -0.055 },
    { nx: 0.85, ny: 0.21, r: 6.2, notch: 3.65, blossom: true,  rotSpd: -0.038 },
    { nx: 0.78, ny: 0.13, r: 3.7, notch: 1.20, blossom: false, rotSpd: 0.060 },
    { nx: 0.14, ny: 0.77, r: 6.4, notch: 5.45, blossom: true,  rotSpd: 0.040 },
    { nx: 0.24, ny: 0.84, r: 4.1, notch: 3.90, blossom: false, rotSpd: -0.052 },
    { nx: 0.84, ny: 0.78, r: 5.7, notch: 2.55, blossom: false, rotSpd: -0.044 },
    { nx: 0.75, ny: 0.85, r: 3.8, notch: 0.85, blossom: false, rotSpd: 0.058 },
    // Two mid-pond stepping pads that koi weave around and occasionally swim underneath!
    { nx: 0.39, ny: 0.29, r: 4.3, notch: 1.65, blossom: false, rotSpd: 0.048 },
    { nx: 0.64, ny: 0.67, r: 4.5, notch: 4.65, blossom: true,  rotSpd: -0.042 },
  ];

  // -------------------------------------------------------------------------
  // Deterministic Capture Choreography Timeline (15.0s = 900 frames @ 60fps)
  // -------------------------------------------------------------------------
  // 0.0–3.5s   : Calm — graceful swimming, pointer enters & drops food; 3-5 koi swarm!
  // 3.5–7.0s   : Rain — rain glyphs & ripples surge; click at 4.65s sends big ring & koi DART AWAY!
  // 7.0–11.0s  : Sunset — amber/rose glow; pointer sweeps S-curve dropping food trail, koi school follows!
  // 11.0–15.0s : Moonlight — indigo/silver; click at 12.15s sends moonlit ripple & dart, then serene glide!
  function getScriptedInput(t) {
    let presetId = 1;
    if (t >= 11.0) presetId = 4;
    else if (t >= 7.0) presetId = 3;
    else if (t >= 3.5) presetId = 2;

    let active = false;
    let nx = 0.5;
    let ny = 0.5;
    let dropFood = false;
    let click = false;

    // Act 1 (Calm): pointer glides in 0.75s..2.55s dropping food cluster center-left-to-center
    if (t >= 0.75 && t <= 2.65) {
      active = true;
      const u = clamp((t - 0.75) / 1.80, 0, 1);
      const su = u * u * (3 - 2 * u);
      nx = lerp(0.34, 0.57, su) + Math.sin(u * Math.PI * 2) * 0.035;
      ny = lerp(0.56, 0.45, su) - Math.sin(u * Math.PI) * 0.05;
      dropFood = t <= 2.45;
    }
    // Act 2 (Rain): pointer arrives near koi cluster & clicks sharply at t=4.65s
    else if (t >= 4.25 && t <= 5.10) {
      active = true;
      const u = clamp((t - 4.25) / 0.40, 0, 1);
      nx = lerp(0.62, 0.51, u);
      ny = lerp(0.38, 0.49, u);
      dropFood = false;
      if (Math.abs(t - 4.65) < FIXED_DT * 0.55) {
        click = true;
      }
    }
    // Act 3 (Sunset): pointer trails food along a wide flowing S-curve across pond
    else if (t >= 7.30 && t <= 10.25) {
      active = true;
      const u = clamp((t - 7.30) / 2.85, 0, 1);
      nx = lerp(0.24, 0.76, u);
      ny = 0.48 - Math.sin(u * Math.PI * 1.65) * 0.15 + Math.cos(u * Math.PI * 0.8) * 0.04;
      dropFood = t <= 10.05;
    }
    // Act 4 (Moonlight): second click ripple under moonlight at t=12.15s
    else if (t >= 11.75 && t <= 12.60) {
      active = true;
      const u = clamp((t - 11.75) / 0.40, 0, 1);
      nx = lerp(0.70, 0.61, u);
      ny = lerp(0.44, 0.51, u);
      dropFood = false;
      if (Math.abs(t - 12.15) < FIXED_DT * 0.55) {
        click = true;
      }
    }

    return { presetId, active, nx, ny, dropFood, click };
  }

  // -------------------------------------------------------------------------
  // Main Pond Simulation & Cell-Shader Engine
  // -------------------------------------------------------------------------
  class AsciiKoiPond {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d', { alpha: false });
      this.cols = 192;
      this.rows = 60;
      this.worldW = this.cols * ASPECT;
      this.worldH = this.rows;

      this.resize(IS_CAPTURE ? 1920 : window.innerWidth, IS_CAPTURE ? 1080 : window.innerHeight);

      this.paused = false;
      this.currentFrame = -1;
      this.cellOut = { glyph: ' ', color: '#000000' };

      // Live pointer state
      this.livePointer = {
        active: false,
        wx: this.worldW * 0.5,
        wy: this.worldH * 0.5,
        prevWx: this.worldW * 0.5,
        prevWy: this.worldH * 0.5,
        vx: 0,
        vy: 0,
        down: false,
        lastDropDist: 0,
        moveCooldown: 0,
      };

      this.reset();
    }

    resize(pixelW, pixelH) {
      const w = Math.max(640, Math.round(pixelW));
      const h = Math.max(360, Math.round(pixelH));
      this.pixelW = w;
      this.pixelH = h;
      this.canvas.width = w;
      this.canvas.height = h;

      this.cols = Math.max(96, Math.round(w / CELL_W));
      this.rows = Math.max(34, Math.round(h / CELL_H));
      this.cellW = w / this.cols;
      this.cellH = h / this.rows;
      this.worldW = this.cols * (this.cellW / this.cellH);
      this.worldH = this.rows;
      this.aspect = this.cellW / this.cellH;

      const N = this.cols * this.rows;
      // Compact per-cell layer buffers populated by agents, then read by main(x, y, t, pointer)
      this.koiDepth = new Float32Array(N);
      this.koiGlyph = new Array(N);
      this.koiR = new Uint8Array(N);
      this.koiG = new Uint8Array(N);
      this.koiB = new Uint8Array(N);
      this.koiKind = new Uint8Array(N); // 0=none, 1=shadow, 2=fin, 3=body, 4=dorsal, 5=eye
      this.koiShade = new Float32Array(N);

      this.padMask = new Uint8Array(N); // 0=none, 1=shadow, 2=leaf, 3=vein, 4=rim, 5=blossomOuter, 6=blossomInner, 7=blossomCore
      this.padGlyph = new Array(N);
      this.padShade = new Float32Array(N);

      this.foodMask = new Uint8Array(N); // 0=none, 1=ring, 2=crumb
      this.foodGlyph = new Array(N);
      this.foodLife = new Float32Array(N);

      this.wakeMask = new Float32Array(N);
      this.wakeGlyph = new Array(N);

      this.rainMask = new Uint8Array(N); // 0=none, 1=streak, 2=splash
      this.rainGlyph = new Array(N);
      this.rainAlpha = new Float32Array(N);
    }

    reset() {
      this.rng = createRng(20261124);
      this.t = 0;
      this.simTime = 0;
      this.presetIdx = 0;
      this.prevPresetIdx = 0;
      this.presetBlend = 1.0;
      this.preset = PRESETS[0];

      this.ripples = [];
      this.foods = [];
      this.wakes = [];
      this.rainDrops = [];
      this.floatingPetals = [];
      this.ambientRippleTimer = 0.4;
      this.foodDropCooldown = 0;

      // Pointer visible cursor state (in world coords)
      this.pointer = {
        active: false,
        wx: this.worldW * 0.5,
        wy: this.worldH * 0.5,
        vx: 0,
        vy: 0,
        clickFlash: 0,
      };

      // Initialize Lily Pads
      this.pads = PAD_SPECS.map((s, idx) => ({
        id: idx,
        baseX: s.nx * this.worldW,
        baseY: s.ny * this.worldH,
        x: s.nx * this.worldW,
        y: s.ny * this.worldH,
        r: s.r * (this.worldH / 60),
        notch: s.notch,
        rotSpd: s.rotSpd,
        blossom: s.blossom,
        bobPhase: this.rng() * Math.PI * 2,
        bobAmp: 0.35 + this.rng() * 0.25,
        rippleLift: 0,
      }));

      // Initialize Koi with articulated 14-node spines
      this.kois = KOI_SPECIES.map((sp, idx) => {
        const scale = this.worldH / 60;
        const length = sp.length * scale;
        const radius = sp.radius * scale;
        const numNodes = 14;
        const segLen = length / (numNodes - 1);

        const ang = sp.orbitPhase;
        const x0 = (sp.orbitCenter[0] + Math.cos(ang) * sp.orbitRx) * this.worldW;
        const y0 = (sp.orbitCenter[1] + Math.sin(ang) * sp.orbitRy) * this.worldH;
        const headAng = Math.atan2(
          Math.cos(ang) * sp.orbitRy * sp.orbitDir,
          -Math.sin(ang) * sp.orbitRx * sp.orbitDir
        );

        const spine = [];
        for (let i = 0; i < numNodes; i++) {
          spine.push({
            x: x0 - Math.cos(headAng) * segLen * i,
            y: y0 - Math.sin(headAng) * segLen * i,
            ang: headAng,
          });
        }

        return {
          id: idx,
          spec: sp,
          length,
          radius,
          segLen,
          spine,
          x: x0,
          y: y0,
          vx: Math.cos(headAng) * sp.speed,
          vy: Math.sin(headAng) * sp.speed,
          angle: headAng,
          turnRate: 0,
          speed: sp.speed * scale,
          baseSpeed: sp.speed * scale,
          depth: sp.baseDepth,
          targetDepth: sp.baseDepth,
          swimPhase: this.rng() * Math.PI * 2,
          finPhase: this.rng() * Math.PI * 2,
          orbitAngle: sp.orbitPhase,
          orbitSpeed: (0.20 + this.rng() * 0.08) * sp.orbitDir,
          wanderPhase: this.rng() * 10,
          startleTimer: 0,
          startleDirX: 0,
          startleDirY: 0,
          pendingStartle: null, // { delay, dx, dy, strength }
          diveTimer: (idx % 3 === 0) ? 2.5 : 0, // hero koi occasionally dives beneath lily pads
          nibbleFlash: 0,
          wakeCooldown: 0,
          seed: 100 + idx * 37,
        };
      });

      // Floating subtle surface motes / duckweed / pollen
      for (let i = 0; i < 36; i++) {
        this.floatingPetals.push({
          x: this.rng() * this.worldW,
          y: this.rng() * this.worldH,
          glyph: i % 5 === 0 ? ',' : i % 3 === 0 ? '.' : '·',
          speed: 0.45 + this.rng() * 0.65,
          phase: this.rng() * Math.PI * 2,
        });
      }

      // Pre-populate rain pool (lush slanted streaks & splashes in Rain preset)
      for (let i = 0; i < 140; i++) {
        this.rainDrops.push({
          x: this.rng() * this.worldW,
          y: this.rng() * this.worldH,
          z: this.rng(), // 1 = high in air, 0 = hits pond surface
          speed: 1.65 + this.rng() * 0.90,
          splashTimer: 0,
          splashX: 0,
          splashY: 0,
        });
      }

      // Pre-warm pond so frame 0 opens on an already-graceful living scene
      for (let i = 0; i < PREWARM_FRAMES; i++) {
        this.step(FIXED_DT, true);
      }
      this.t = 0;
      this.currentFrame = -1;
    }

    setPreset(id, instant = false) {
      const idx = clamp((id | 0) - 1, 0, PRESETS.length - 1);
      if (idx === this.presetIdx && !instant) return;
      if (instant) {
        this.prevPresetIdx = idx;
        this.presetIdx = idx;
        this.presetBlend = 1.0;
        this.preset = PRESETS[idx];
      } else {
        this.prevPresetIdx = this.presetIdx;
        this.presetIdx = idx;
        this.presetBlend = 0.0;
      }
    }

    // Emit expanding ripple ring (isClick = true creates a bold startle shockwave)
    spawnRipple(wx, wy, isClick = false, customMaxR = 0) {
      if (this.ripples.length > 48) {
        this.ripples.shift();
      }
      const scale = this.worldH / 60;
      const maxR = customMaxR || (isClick ? 34.0 * scale : (5.5 + this.rng() * 5.0) * scale);
      const speed = isClick ? 17.5 * scale : (6.8 + this.rng() * 2.5) * scale;
      this.ripples.push({
        x: wx,
        y: wy,
        r: isClick ? 0.8 : 0.3,
        maxR,
        speed,
        strength: isClick ? 1.55 : 0.62,
        isClick,
        age: 0,
        maxAge: maxR / speed,
      });

      if (isClick) {
        this.pointer.clickFlash = 1.0;
        // Startle nearby koi away from the click ripple!
        for (const koi of this.kois) {
          const dx = koi.x - wx;
          const dy = koi.y - wy;
          const dist = Math.hypot(dx, dy);
          const startleRadius = 33.0 * scale;
          if (dist < startleRadius) {
            const nx = dist > 0.01 ? dx / dist : Math.cos(koi.angle);
            const ny = dist > 0.01 ? dy / dist : Math.sin(koi.angle);
            const proximity = 1 - dist / startleRadius;
            // Short physical travel delay so closer koi bolt immediately and farther ones bolt as ring hits
            const delay = Math.min(0.28, (dist / speed) * 0.42);
            koi.pendingStartle = {
              delay,
              dx: nx,
              dy: ny,
              strength: 0.65 + proximity * 0.85,
            };
          }
        }
        // Extra bob impulse to nearby lily pads
        for (const pad of this.pads) {
          const d = Math.hypot(pad.x - wx, pad.y - wy);
          if (d < 26 * scale) {
            pad.rippleLift = Math.max(pad.rippleLift, (1 - d / (26 * scale)) * 1.4);
          }
        }
      }
    }

    // Drop a visible food crumb (with gentle scatter)
    dropFood(wx, wy, count = 1) {
      const scale = this.worldH / 60;
      for (let i = 0; i < count; i++) {
        if (this.foods.length > 52) this.foods.shift();
        const ang = this.rng() * Math.PI * 2;
        const rad = count > 1 ? (0.4 + this.rng() * 2.2) * scale : this.rng() * 0.7 * scale;
        const fx = clamp(wx + Math.cos(ang) * rad, 3.0, this.worldW - 3.0);
        const fy = clamp(wy + Math.sin(ang) * rad, 3.0, this.worldH - 3.0);
        // Avoid dropping directly inside the core of a lily pad
        let blocked = false;
        for (const pad of this.pads) {
          if (Math.hypot(fx - pad.x, fy - pad.y) < pad.r * 0.88) {
            blocked = true;
            break;
          }
        }
        if (blocked) continue;
        this.foods.push({
          x: fx,
          y: fy,
          vx: (this.rng() - 0.5) * 0.45,
          vy: (this.rng() - 0.5) * 0.45,
          age: 0,
          maxAge: 14.0,
          phase: this.rng() * Math.PI * 2,
          size: 0.7 + this.rng() * 0.6,
        });
        if (i === 0) {
          this.spawnRipple(fx, fy, false, 4.2 * scale);
        }
      }
    }

    spawnWake(x, y, strength = 0.8, glyph = null) {
      if (this.wakes.length > 140) this.wakes.shift();
      this.wakes.push({
        x,
        y,
        age: 0,
        maxAge: 0.65 + this.rng() * 0.45,
        strength,
        glyph: glyph || (this.rng() < 0.35 ? 'o' : this.rng() < 0.7 ? '°' : '~'),
      });
    }

    // -----------------------------------------------------------------------
    // Fixed-timestep Physics & Behavior Update
    // -----------------------------------------------------------------------
    step(dt, isPrewarm = false) {
      this.simTime += dt;
      if (!isPrewarm) {
        this.t += dt;
      }

      // Smooth preset crossfade (0.45s)
      if (this.presetBlend < 1.0) {
        this.presetBlend = Math.min(1.0, this.presetBlend + dt / 0.45);
      }
      this.preset = blendPresetVisuals(
        PRESETS[this.prevPresetIdx],
        PRESETS[this.presetIdx],
        smoothstep(0, 1, this.presetBlend)
      );
      const P = this.preset;
      const scale = this.worldH / 60;

      // Capture-mode scripted pointer / presets / clicks
      if (!isPrewarm && IS_CAPTURE) {
        const script = getScriptedInput(this.t);
        if (script.presetId !== PRESETS[this.presetIdx].id) {
          this.setPreset(script.presetId, false);
        }
        const newWx = script.nx * this.worldW;
        const newWy = script.ny * this.worldH;
        this.pointer.vx = (newWx - this.pointer.wx) / dt;
        this.pointer.vy = (newWy - this.pointer.wy) / dt;
        this.pointer.wx = newWx;
        this.pointer.wy = newWy;
        this.pointer.active = script.active;

        this.foodDropCooldown -= dt;
        if (script.dropFood && this.foodDropCooldown <= 0) {
          this.dropFood(newWx, newWy, 2);
          this.foodDropCooldown = 0.14;
        }
        if (script.click) {
          this.spawnRipple(newWx, newWy, true);
        }
      } else if (!isPrewarm) {
        // Sync live pointer into simulation pointer
        this.pointer.active = this.livePointer.active;
        this.pointer.wx = this.livePointer.wx;
        this.pointer.wy = this.livePointer.wy;
        this.pointer.vx = this.livePointer.vx;
        this.pointer.vy = this.livePointer.vy;
        this.livePointer.vx *= 0.85;
        this.livePointer.vy *= 0.85;
      }

      if (this.pointer.clickFlash > 0) {
        this.pointer.clickFlash = Math.max(0, this.pointer.clickFlash - dt * 2.5);
      }

      // Ambient subtle water ripples
      this.ambientRippleTimer -= dt * P.ambientRippleRate;
      if (this.ambientRippleTimer <= 0) {
        this.ambientRippleTimer = 0.55 + this.rng() * 0.95;
        const rx = (0.08 + this.rng() * 0.84) * this.worldW;
        const ry = (0.08 + this.rng() * 0.84) * this.worldH;
        this.spawnRipple(rx, ry, false, (4.0 + this.rng() * 3.8) * scale);
      }

      // Update Rain (active when P.rainIntensity > 0.05)
      if (P.rainIntensity > 0.02) {
        for (const d of this.rainDrops) {
          if (d.splashTimer > 0) {
            d.splashTimer = Math.max(0, d.splashTimer - dt * 3.8);
          }
          d.z -= d.speed * dt * (0.7 + 0.5 * P.rainIntensity);
          d.x -= 2.2 * dt * scale;
          d.y += 4.8 * dt * scale;
          if (d.z <= 0) {
            // Raindrop strikes the water surface!
            const sx = ((d.x % this.worldW) + this.worldW) % this.worldW;
            const sy = ((d.y % this.worldH) + this.worldH) % this.worldH;
            d.splashX = sx;
            d.splashY = sy;
            d.splashTimer = 1.0;
            if (this.rng() < 0.36 * P.rainIntensity) {
              this.spawnRipple(sx, sy, false, (3.2 + this.rng() * 3.8) * scale);
            }
            d.x = this.rng() * this.worldW;
            d.y = this.rng() * this.worldH;
            d.z = 0.75 + this.rng() * 0.45;
          }
        }
      }

      // Update Lily Pads (gentle tether bobbing + slow rotation + ripple bob)
      for (const pad of this.pads) {
        pad.notch += pad.rotSpd * dt * (0.7 + 0.4 * P.currentSpeed);
        pad.rippleLift *= Math.pow(0.18, dt);
        const bobX = Math.sin(this.simTime * 0.52 + pad.bobPhase) * pad.bobAmp * scale;
        const bobY = Math.cos(this.simTime * 0.43 + pad.bobPhase * 1.3) * pad.bobAmp * 0.7 * scale;
        pad.x = pad.baseX + bobX + Math.sin(this.simTime * 5.0 + pad.id) * pad.rippleLift * 0.28;
        pad.y = pad.baseY + bobY + Math.cos(this.simTime * 4.6 + pad.id) * pad.rippleLift * 0.22;
      }

      // Update Floating Petals / Duckweed motes
      for (const m of this.floatingPetals) {
        m.x += (0.55 * P.currentSpeed + Math.sin(this.simTime * 0.7 + m.phase) * 0.25) * m.speed * dt;
        m.y += (0.22 * P.currentSpeed + Math.cos(this.simTime * 0.5 + m.phase) * 0.20) * m.speed * dt;
        if (m.x > this.worldW) m.x -= this.worldW;
        if (m.y > this.worldH) m.y -= this.worldH;
      }

      // Update Ripples
      for (let i = this.ripples.length - 1; i >= 0; i--) {
        const rp = this.ripples[i];
        rp.age += dt;
        rp.r += rp.speed * dt;
        if (rp.age >= rp.maxAge || rp.r >= rp.maxR) {
          this.ripples.splice(i, 1);
        }
      }

      // Update Food Crumbs
      for (let i = this.foods.length - 1; i >= 0; i--) {
        const f = this.foods[i];
        f.age += dt;
        f.x += (f.vx + 0.28 * P.currentSpeed) * dt;
        f.y += (f.vy + 0.10 * P.currentSpeed) * dt;
        f.vx *= Math.pow(0.35, dt);
        f.vy *= Math.pow(0.35, dt);
        if (f.age >= f.maxAge || f.x < 1 || f.x > this.worldW - 1 || f.y < 1 || f.y > this.worldH - 1) {
          this.foods.splice(i, 1);
        }
      }

      // Update Wake Bubbles
      for (let i = this.wakes.length - 1; i >= 0; i--) {
        const w = this.wakes[i];
        w.age += dt;
        if (w.age >= w.maxAge) {
          this.wakes.splice(i, 1);
        }
      }

      // Update Koi Agents
      this.updateKois(dt, P, scale);
    }

    updateKois(dt, P, scale) {
      const marginX = 5.5 * scale;
      const marginY = 4.2 * scale;

      for (const koi of this.kois) {
        // Trigger pending click startle once shockwave reaches fish
        if (koi.pendingStartle) {
          koi.pendingStartle.delay -= dt;
          if (koi.pendingStartle.delay <= 0) {
            const ps = koi.pendingStartle;
            koi.startleTimer = 1.15 + ps.strength * 0.45;
            koi.startleDirX = ps.dx;
            koi.startleDirY = ps.dy;
            // Immediate sharp burst away from ripple center!
            const burstAng = Math.atan2(ps.dy, ps.dx) + (this.rng() - 0.5) * 0.35;
            koi.angle = koi.angle + angleDiff(koi.angle, burstAng) * 0.65;
            koi.speed = koi.baseSpeed * (2.35 + ps.strength * 0.75);
            koi.targetDepth = clamp(koi.spec.baseDepth + 0.25, 0.25, 0.85);
            koi.pendingStartle = null;
            this.spawnWake(koi.spine[10].x, koi.spine[10].y, 1.0, 'o');
            this.spawnWake(koi.spine[12].x, koi.spine[12].y, 0.9, '°');
          }
        }

        if (koi.startleTimer > 0) {
          koi.startleTimer = Math.max(0, koi.startleTimer - dt);
        }
        if (koi.nibbleFlash > 0) {
          koi.nibbleFlash = Math.max(0, koi.nibbleFlash - dt * 3.0);
        }

        // Periodic gentle dive urge so koi naturally weave under lily pads at times
        koi.diveTimer -= dt;
        if (koi.diveTimer < -4.0) {
          koi.diveTimer = 3.5 + this.rng() * 4.0;
        }
        const wantsDiveUnderPad = koi.diveTimer > 0 && koi.diveTimer < 2.2;

        // 1. Default curved orbit target around the pond
        koi.orbitAngle += koi.orbitSpeed * dt * P.swimSpeedMul;
        const sp = koi.spec;
        const figure8 = Math.sin(koi.orbitAngle * 2.0 + koi.id) * 0.045;
        let targetX = (sp.orbitCenter[0] + Math.cos(koi.orbitAngle) * sp.orbitRx + figure8) * this.worldW;
        let targetY = (sp.orbitCenter[1] + Math.sin(koi.orbitAngle) * sp.orbitRy) * this.worldH;

        let desiredSpeed = koi.baseSpeed * P.swimSpeedMul;
        let chasingFood = false;
        let nearestFoodIdx = -1;
        let nearestFoodDist = 42.0 * scale;

        // 2. Food swarming behavior (when not currently startled!)
        if (koi.startleTimer <= 0.15 && this.foods.length > 0) {
          for (let fi = 0; fi < this.foods.length; fi++) {
            const f = this.foods[fi];
            const d = Math.hypot(f.x - koi.x, f.y - koi.y);
            // Slight individual jitter so fish fan around food rather than stacking identically
            const score = d + (fi % 3 === koi.id % 3 ? -2.2 : 0);
            if (score < nearestFoodDist) {
              nearestFoodDist = score;
              nearestFoodIdx = fi;
            }
          }
          if (nearestFoodIdx !== -1) {
            const f = this.foods[nearestFoodIdx];
            chasingFood = true;
            targetX = f.x;
            targetY = f.y;
            desiredSpeed = koi.baseSpeed * (1.35 + 0.35 * P.swimSpeedMul);
            koi.targetDepth = 0.16 + (koi.id % 3) * 0.06; // rise toward surface to feed!

            // Eat crumb when mouth reaches it
            const mouthDist = Math.hypot(f.x - koi.x, f.y - koi.y);
            if (mouthDist < 2.35 * scale) {
              this.foods.splice(nearestFoodIdx, 1);
              koi.nibbleFlash = 1.0;
              this.spawnRipple(f.x, f.y, false, 5.2 * scale);
              this.spawnWake(f.x, f.y, 0.95, 'o');
              this.spawnWake(f.x + (this.rng() - 0.5) * 1.2, f.y + (this.rng() - 0.5) * 1.0, 0.7, '°');
            }
          }
        }

        // 3. Compute steering vector
        let steerX = 0;
        let steerY = 0;

        if (koi.startleTimer > 0) {
          // Dart away urgently from click point!
          const urgency = smoothstep(0, 0.9, koi.startleTimer);
          steerX += koi.startleDirX * (3.2 + urgency * 2.5);
          steerY += koi.startleDirY * (3.2 + urgency * 2.5);
          desiredSpeed = koi.baseSpeed * (1.1 + urgency * 1.9);
          koi.targetDepth = clamp(sp.baseDepth + 0.25, 0.35, 0.82);
        } else {
          const toX = targetX - koi.x;
          const toY = targetY - koi.y;
          const toD = Math.hypot(toX, toY) + 0.001;
          const pull = chasingFood ? 2.65 : 1.15;
          steerX += (toX / toD) * pull;
          steerY += (toY / toD) * pull;
          if (!chasingFood) {
            koi.targetDepth = wantsDiveUnderPad ? 0.68 : sp.baseDepth + Math.sin(this.simTime * 0.5 + koi.id) * 0.08;
          }
        }

        // 4. Lily pad weaving (soft avoidance unless diving under a pad!)
        let underPad = false;
        for (const pad of this.pads) {
          const dx = koi.x - pad.x;
          const dy = koi.y - pad.y;
          const d = Math.hypot(dx, dy) + 0.001;
          if (d < pad.r * 1.05) {
            underPad = true;
          }
          const avoidR = pad.r + koi.radius * 1.85;
          if (d < avoidR && !wantsDiveUnderPad && koi.startleTimer < 0.3) {
            // Steer tangentially around the pad so movement is graceful, not bouncy
            const push = (1 - d / avoidR) * (chasingFood ? 1.1 : 1.75);
            steerX += (dx / d) * push;
            steerY += (dy / d) * push;
          }
        }
        if (underPad) {
          // Ensure koi smoothly sits underneath the floating pad!
          koi.targetDepth = Math.max(koi.targetDepth, 0.58);
        }

        // 5. Gentle koi-to-koi separation (keeps overlaps readable without stacking)
        for (const other of this.kois) {
          if (other.id === koi.id) continue;
          const dx = koi.x - other.x;
          const dy = koi.y - other.y;
          const d = Math.hypot(dx, dy) + 0.001;
          const sepR = (koi.radius + other.radius) * (chasingFood ? 1.95 : 2.45);
          if (d < sepR) {
            const w = (1 - d / sepR) * (chasingFood ? 1.15 : 1.45);
            steerX += (dx / d) * w;
            steerY += (dy / d) * w;
          }
        }

        // 6. Soft pond boundary containment
        if (koi.x < marginX) steerX += ((marginX - koi.x) / marginX) * 3.8;
        if (koi.x > this.worldW - marginX) steerX -= ((koi.x - (this.worldW - marginX)) / marginX) * 3.8;
        if (koi.y < marginY) steerY += ((marginY - koi.y) / marginY) * 3.8;
        if (koi.y > this.worldH - marginY) steerY -= ((koi.y - (this.worldH - marginY)) / marginY) * 3.8;

        // Apply angular steering with natural max turn rate
        const desiredAngle = Math.atan2(steerY, steerX);
        const diff = angleDiff(koi.angle, desiredAngle);
        const maxTurn = (koi.startleTimer > 0 ? 7.2 : chasingFood ? 4.4 : 2.35) * dt;
        const dAng = clamp(diff, -maxTurn, maxTurn);
        koi.angle += dAng;
        koi.turnRate = lerp(koi.turnRate, dAng / dt, 0.25);

        // Smooth speed & depth updates
        koi.speed = lerp(koi.speed, desiredSpeed, clamp(dt * (koi.startleTimer > 0 ? 5.5 : 3.0), 0, 1));
        koi.depth = lerp(koi.depth, koi.targetDepth, clamp(dt * 2.2, 0, 1));

        // Swim & fin wave phase advances faster with speed & startle
        const speedRatio = koi.speed / Math.max(0.1, koi.baseSpeed);
        koi.swimPhase += dt * (4.4 + speedRatio * 3.4) * P.finFreqMul;
        koi.finPhase += dt * (3.1 + speedRatio * 2.1) * P.finFreqMul;

        // Subtle head yaw oscillation from swimming stroke
        const headSway = Math.sin(koi.swimPhase) * (koi.startleTimer > 0 ? 0.14 : 0.055);
        const moveAng = koi.angle + headSway;

        koi.vx = Math.cos(moveAng) * koi.speed;
        koi.vy = Math.sin(moveAng) * koi.speed;
        koi.x = clamp(koi.x + koi.vx * dt, 1.5, this.worldW - 1.5);
        koi.y = clamp(koi.y + koi.vy * dt, 1.5, this.worldH - 1.5);

        // Articulated spine follow-the-leader kinematics + traveling tail wave!
        const spNodes = koi.spine;
        spNodes[0].x = koi.x;
        spNodes[0].y = koi.y;
        spNodes[0].ang = moveAng;

        const waveAmpBase = (koi.startleTimer > 0 ? 0.24 : 0.115) * koi.radius;
        for (let i = 1; i < spNodes.length; i++) {
          const prev = spNodes[i - 1];
          const cur = spNodes[i];
          const dx = cur.x - prev.x;
          const dy = cur.y - prev.y;
          let segAng = Math.atan2(dy, dx);

          // Limit maximum bend between adjacent vertebrae so fish curves gracefully
          const backAng = prev.ang + Math.PI;
          const bend = angleDiff(backAng, segAng);
          const maxBend = i < 4 ? 0.26 : 0.42;
          segAng = backAng + clamp(bend, -maxBend, maxBend);

          // Add progressive lateral swimming wave down spine -> tail
          const u = i / (spNodes.length - 1);
          const wave = Math.sin(koi.swimPhase - u * 5.2) * waveAmpBase * (0.15 + u * u * 1.45);
          const perpX = -Math.sin(segAng);
          const perpY = Math.cos(segAng);

          cur.x = prev.x + Math.cos(segAng) * koi.segLen + perpX * wave * dt * 16.0;
          cur.y = prev.y + Math.sin(segAng) * koi.segLen + perpY * wave * dt * 16.0;
          // Re-enforce exact segment length after lateral wave impulse
          const ndx = cur.x - prev.x;
          const ndy = cur.y - prev.y;
          const nd = Math.hypot(ndx, ndy) + 0.0001;
          cur.x = prev.x + (ndx / nd) * koi.segLen;
          cur.y = prev.y + (ndy / nd) * koi.segLen;
          cur.ang = Math.atan2(prev.y - cur.y, prev.x - cur.x);
        }

        // Emit subtle bubble/swirl wake when darting or swimming fast
        koi.wakeCooldown -= dt;
        if ((koi.startleTimer > 0.1 || speedRatio > 1.38) && koi.wakeCooldown <= 0) {
          const tail = spNodes[spNodes.length - 1];
          this.spawnWake(tail.x, tail.y, koi.startleTimer > 0 ? 0.95 : 0.55);
          koi.wakeCooldown = koi.startleTimer > 0 ? 0.055 : 0.13;
        }
      }
    }

    // -----------------------------------------------------------------------
    // Procedural Koi Color Pattern in Local Spine Coordinates (u, vNorm)
    // -----------------------------------------------------------------------
    sampleKoiMarkColor(koi, u, vNorm, isFin) {
      const sp = koi.spec;
      if (isFin) return sp.finColor;

      // Soft organic pattern wave locked to body coordinates
      const p1 = Math.sin(u * 13.5 + koi.id * 1.7) * 0.55 + Math.cos(vNorm * 3.1 + u * 6.5) * 0.45;
      const p2 = Math.sin(u * 21.0 - vNorm * 3.8 + koi.id * 2.9);

      switch (sp.pattern) {
        case 'kohaku': {
          // Bold red-vermilion saddles over snow-ivory body
          const headPatch = (u > 0.03 && u < 0.24 && Math.abs(vNorm) < 0.82) && (p1 > -0.15);
          const midPatch = (u > 0.34 && u < 0.62 && p1 > -0.08);
          if (headPatch || midPatch) {
            return Math.abs(vNorm) < 0.35 ? sp.mark1Color : sp.mark2Color;
          }
          return sp.baseColor;
        }
        case 'showa': {
          // Charcoal base with dramatic fiery crimson bands and pearl-white breaks
          if (p1 > 0.22 && u > 0.06 && u < 0.68) return sp.mark1Color;
          if (p2 > 0.38 && u > 0.12 && u < 0.65) return sp.mark2Color;
          return sp.baseColor;
        }
        case 'ogon': {
          // Shimmering molten gold with luminous dorsal crest
          if (Math.abs(vNorm) < 0.34) return sp.mark1Color;
          if (Math.abs(vNorm) > 0.72) return sp.mark2Color;
          return sp.baseColor;
        }
        case 'tancho': {
          // Iconic crimson forehead circle on pure pearl-white body
          const du = (u - 0.11) * 8.5;
          const dv = vNorm * 1.35;
          if (du * du + dv * dv < 0.52) return sp.mark1Color;
          return Math.abs(vNorm) > 0.75 ? sp.mark2Color : sp.baseColor;
        }
        case 'sanke': {
          // Warm cream with tangerine patches and crisp small ink flecks
          if (p2 > 0.68 && u > 0.18 && u < 0.64) return sp.mark2Color;
          if (p1 > 0.06 && u > 0.06 && u < 0.64) return sp.mark1Color;
          return sp.baseColor;
        }
        case 'asagi': {
          // Reticulated slate-indigo dorsal scales + bright coral-orange flanks
          if (Math.abs(vNorm) > 0.56) return sp.mark1Color;
          return ((Math.floor(u * 26) + Math.floor((vNorm + 1) * 4)) & 1) === 0
            ? sp.baseColor
            : sp.mark2Color;
        }
        case 'benigoi': {
          // Vivid persimmon-red with bright amber spine highlights
          if (Math.abs(vNorm) < 0.36 && u < 0.68) return sp.mark1Color;
          if (Math.abs(vNorm) > 0.76) return sp.mark2Color;
          return sp.baseColor;
        }
        case 'utsuri': {
          // Dramatic high-contrast charcoal & snow-white bands
          if (p1 > 0.05 && u > 0.05 && u < 0.68) return sp.mark1Color;
          return Math.abs(vNorm) > 0.76 ? sp.mark2Color : sp.baseColor;
        }
        default:
          return sp.baseColor;
      }
    }

    // -----------------------------------------------------------------------
    // Rasterize Agents into Per-Cell Layer Buffers for main(x, y, t, pointer)
    // -----------------------------------------------------------------------
    buildAgentBuffers() {
      const N = this.cols * this.rows;
      this.koiDepth.fill(99.0);
      this.koiKind.fill(0);
      this.padMask.fill(0);
      this.foodMask.fill(0);
      this.wakeMask.fill(0);
      this.rainMask.fill(0);

      const cols = this.cols;
      const rows = this.rows;
      const asp = this.aspect;
      const P = this.preset;

      // 1. Rasterize Koi (body, dorsal scales, eyes, sweeping pectoral/pelvic/veiltail fins, floor shadows)
      for (const koi of this.kois) {
        const spNodes = koi.spine;
        const segCount = spNodes.length - 1;
        const maxR = koi.radius;
        const padMargin = maxR * 3.1;

        // Compute tight bounding box in cell space
        let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
        for (let i = 0; i < spNodes.length; i++) {
          const nd = spNodes[i];
          if (nd.x < minX) minX = nd.x;
          if (nd.x > maxX) maxX = nd.x;
          if (nd.y < minY) minY = nd.y;
          if (nd.y > maxY) maxY = nd.y;
        }

        const c0 = clamp(Math.floor((minX - padMargin) / asp), 0, cols - 1);
        const c1 = clamp(Math.ceil((maxX + padMargin) / asp), 0, cols - 1);
        const r0 = clamp(Math.floor(minY - padMargin), 0, rows - 1);
        const r1 = clamp(Math.ceil(maxY + padMargin), 0, rows - 1);

        // Dynamic pectoral fin sweep angles (left & right flap with finPhase + steering turnRate)
        const finFlap = Math.sin(koi.finPhase) * 0.24;
        const turnFlare = clamp(koi.turnRate * 0.16, -0.35, 0.35);

        // Shadow offset increases with koi height above pond floor
        const shOffX = 0.85 + (1 - koi.depth) * 1.15;
        const shOffY = 0.65 + (1 - koi.depth) * 0.90;

        // Precompute pectoral fin anchor points at spine node 3 (~u=0.23)
        const pecNode = spNodes[3];
        const pecAng = pecNode.ang;
        const pecLen = maxR * 2.55;
        const pecWid = maxR * 0.96;
        const leftSweep = pecAng + 2.08 + finFlap + Math.max(0, turnFlare);
        const rightSweep = pecAng - 2.08 - finFlap + Math.min(0, turnFlare);
        const lCos = Math.cos(leftSweep), lSin = Math.sin(leftSweep);
        const rCos = Math.cos(rightSweep), rSin = Math.sin(rightSweep);

        // Pelvic fin anchors at spine node 6 (~u=0.47)
        const pelNode = spNodes[6];
        const pelAng = pelNode.ang;
        const pelLen = maxR * 1.38;
        const pelWid = maxR * 0.56;
        const plSweep = pelAng + 2.34 + Math.sin(koi.finPhase - 0.9) * 0.22;
        const prSweep = pelAng - 2.34 - Math.sin(koi.finPhase - 0.9) * 0.22;
        const plCos = Math.cos(plSweep), plSin = Math.sin(plSweep);
        const prCos = Math.cos(prSweep), prSin = Math.sin(prSweep);

        // Precompute shadow pass (fast coarse check) & main fish pass
        for (let cy = r0; cy <= r1; cy++) {
          const wy = cy + 0.5;
          const rowOff = cy * cols;
          for (let cx = c0; cx <= c1; cx++) {
            const wx = (cx + 0.5) * asp;
            const idx = rowOff + cx;

            // Find closest projection onto articulated spine polyline
            let bestDistSq = 1e9;
            let bestU = 0;
            let bestV = 0;
            let bestAng = koi.angle;

            for (let s = 0; s < segCount; s++) {
              const a = spNodes[s];
              const b = spNodes[s + 1];
              const abx = b.x - a.x;
              const aby = b.y - a.y;
              const abLenSq = abx * abx + aby * aby + 1e-6;
              const proj = clamp(((wx - a.x) * abx + (wy - a.y) * aby) / abLenSq, 0, 1);
              const px = a.x + abx * proj;
              const py = a.y + aby * proj;
              const dx = wx - px;
              const dy = wy - py;
              const dSq = dx * dx + dy * dy;
              if (dSq < bestDistSq) {
                bestDistSq = dSq;
                bestU = (s + proj) / segCount;
                const tang = Math.atan2(-aby, -abx);
                bestAng = tang;
                bestV = -Math.sin(tang) * dx + Math.cos(tang) * dy;
              }
            }

            const dist = Math.sqrt(bestDistSq);

            // Check soft floor shadow (offset down-right) if cell has no nearer koi yet
            if (dist > maxR * 1.15 && this.koiKind[idx] === 0) {
              const swx = wx - shOffX;
              const swy = wy - shOffY;
              let shHit = false;
              for (let k = 1; k <= 10; k += 3) {
                const nd = spNodes[k];
                const ddx = swx - nd.x;
                const ddy = swy - nd.y;
                const sr = maxR * (k === 10 ? 0.65 : 1.05);
                if (ddx * ddx + ddy * ddy < sr * sr) {
                  shHit = true;
                  break;
                }
              }
              if (shHit) {
                this.koiKind[idx] = 1;
                this.koiDepth[idx] = 0.98;
                this.koiGlyph[idx] = '.';
                continue;
              }
            }

            // Early reject if far from spine & fins
            if (dist > maxR * 2.85) continue;

            // Only draw if this koi is nearer than any koi already in this cell
            if (koi.depth >= this.koiDepth[idx] && this.koiKind[idx] > 1) continue;

            // --- A. Body & Flowing Veiltail Caudal Fin ---
            let hitKind = 0; // 2=fin, 3=body, 4=dorsal, 5=eye
            let glyph = ' ';
            let isFin = false;
            let vNorm = 0;
            let shade = 1.0;

            if (bestU <= 0.68) {
              // Main sculpted koi torso: blunt snout -> broad shoulders -> graceful taper
              let halfW;
              if (bestU < 0.09) {
                halfW = maxR * 0.88 * Math.sqrt(clamp(bestU / 0.09, 0.05, 1));
              } else if (bestU < 0.25) {
                halfW = maxR * lerp(0.88, 1.06, smoothstep(0.09, 0.25, bestU));
              } else {
                const tu = (bestU - 0.25) / 0.43;
                halfW = maxR * lerp(1.06, 0.24, Math.pow(tu, 1.25));
              }

              if (dist <= halfW) {
                vNorm = bestV / (halfW + 0.001);
                const absV = Math.abs(vNorm);
                shade = 0.74 + 0.26 * Math.sqrt(Math.max(0, 1 - absV * absV));

                // Glossy eyes near snout
                if (bestU > 0.05 && bestU < 0.125 && absV > 0.36 && absV < 0.86) {
                  hitKind = 5;
                  glyph = 'o';
                }
                // Dorsal spine ridge with shimmering scale glyphs
                else if (absV < 0.30 && bestU > 0.13 && bestU < 0.65) {
                  hitKind = 4;
                  const scaleWave = Math.sin(bestU * 26.0 - koi.swimPhase * 1.4);
                  if (koi.nibbleFlash > 0.4 && bestU < 0.28) {
                    glyph = '*';
                  } else if (bestU < 0.34) {
                    glyph = scaleWave > 0.15 ? '@' : '#';
                  } else if (bestU < 0.52) {
                    glyph = scaleWave > 0.1 ? '%' : '8';
                  } else {
                    glyph = angleStroke(bestAng, true);
                  }
                }
                // Outer body contour uses directional strokes so turns read crisply
                else if (absV > 0.72) {
                  hitKind = 3;
                  glyph = angleStroke(bestAng, false);
                }
                // Mid flanks: overlapping scale characters
                else {
                  hitKind = 3;
                  const fl = ((Math.floor(bestU * 24) + (vNorm > 0 ? 1 : 0)) & 3);
                  if (bestU < 0.14) glyph = 'O';
                  else glyph = fl === 0 ? 'S' : fl === 1 ? '0' : fl === 2 ? '8' : 's';
                }
              }
            } else {
              // Flowing forked veiltail caudal fin (u in 0.68..1.0)
              const tu = (bestU - 0.68) / 0.32;
              const tailHalfW = maxR * (0.26 + Math.pow(tu, 0.78) * 1.56);
              // Forked V-notch cleft between upper & lower veiltail lobes
              const cleftHalfW = tu > 0.44 ? maxR * ((tu - 0.44) / 0.56) * 0.46 : 0;
              const absV = Math.abs(bestV);

              if (absV <= tailHalfW && absV >= cleftHalfW) {
                hitKind = 2;
                isFin = true;
                vNorm = bestV / (tailHalfW + 0.001);
                shade = 1.0 - tu * 0.28;
                // Flowing translucent veil glyphs that ripple visibly with tail wave
                const waveGlyph = Math.sin(koi.swimPhase * 1.4 + bestV * 2.1 - tu * 3.0);
                if (tu > 0.78) {
                  glyph = waveGlyph > 0.25 ? '~' : waveGlyph > -0.25 ? '≈' : "'";
                } else if (absV > tailHalfW * 0.68) {
                  glyph = angleStroke(bestAng + (bestV > 0 ? -0.35 : 0.35), false);
                } else {
                  glyph = tu > 0.42 ? (waveGlyph > 0 ? '~' : ':') : '=';
                }
              }
            }

            // --- B. Sweeping Pectoral & Pelvic Fins ---
            if (hitKind === 0) {
              const ldx = wx - pecNode.x;
              const ldy = wy - pecNode.y;
              const lAlong = ldx * lCos + ldy * lSin;
              const lAcross = -ldx * lSin + ldy * lCos;
              if (lAlong > 0.05 && lAlong < pecLen) {
                const fu = lAlong / pecLen;
                const fw = pecWid * Math.sin(fu * Math.PI) * (0.70 + 0.45 * fu);
                if (Math.abs(lAcross) < fw) {
                  hitKind = 2;
                  isFin = true;
                  shade = 0.98 - fu * 0.26;
                  glyph = fu > 0.74 ? (Math.sin(koi.finPhase + fu * 4) > 0 ? '~' : ',')
                    : Math.abs(lAcross) > fw * 0.50 ? angleStroke(leftSweep, false) : '~';
                }
              }

              if (hitKind === 0) {
                const rAlong = ldx * rCos + ldy * rSin;
                const rAcross = -ldx * rSin + ldy * rCos;
                if (rAlong > 0.05 && rAlong < pecLen) {
                  const fu = rAlong / pecLen;
                  const fw = pecWid * Math.sin(fu * Math.PI) * (0.70 + 0.45 * fu);
                  if (Math.abs(rAcross) < fw) {
                    hitKind = 2;
                    isFin = true;
                    shade = 0.98 - fu * 0.26;
                    glyph = fu > 0.74 ? (Math.sin(koi.finPhase - fu * 4) > 0 ? '~' : "'")
                      : Math.abs(rAcross) > fw * 0.50 ? angleStroke(rightSweep, false) : '~';
                  }
                }
              }

              if (hitKind === 0) {
                const pdx = wx - pelNode.x;
                const pdy = wy - pelNode.y;
                const plA = pdx * plCos + pdy * plSin;
                const plC = -pdx * plSin + pdy * plCos;
                const prA = pdx * prCos + pdy * prSin;
                const prC = -pdx * prSin + pdy * prCos;
                if (plA > 0.05 && plA < pelLen && Math.abs(plC) < pelWid * Math.sin((plA / pelLen) * Math.PI)) {
                  hitKind = 2;
                  isFin = true;
                  shade = 0.86;
                  glyph = angleStroke(plSweep, false);
                } else if (prA > 0.05 && prA < pelLen && Math.abs(prC) < pelWid * Math.sin((prA / pelLen) * Math.PI)) {
                  hitKind = 2;
                  isFin = true;
                  shade = 0.86;
                  glyph = angleStroke(prSweep, false);
                }
              }
            }

            if (hitKind > 0) {
              let col = hitKind === 5 ? koi.spec.eyeColor : this.sampleKoiMarkColor(koi, bestU, vNorm, isFin);
              const depthFade = 1.0 - clamp((koi.depth - 0.15) * 0.36, 0, 0.34);
              let finalCol = scaleRgb(col, shade * depthFade);

              if (P.koiTintAmt > 0.001) {
                finalCol = mixRgb(finalCol, P.koiTint, P.koiTintAmt * (isFin ? 0.95 : 0.65));
              }
              if (hitKind === 4) {
                const hiAmt = 0.22 + P.moonSparkle * 0.48 + P.sunsetGlow * 0.28;
                finalCol = mixRgb(finalCol, P.koiHighlight, hiAmt);
              } else if (isFin) {
                // Luminous translucent gossamer fins
                finalCol = mixRgb(finalCol, P.koiHighlight, 0.14 + P.moonSparkle * 0.22);
              }

              this.koiDepth[idx] = koi.depth;
              this.koiKind[idx] = hitKind;
              this.koiGlyph[idx] = glyph;
              this.koiR[idx] = finalCol[0];
              this.koiG[idx] = finalCol[1];
              this.koiB[idx] = finalCol[2];
              this.koiShade[idx] = shade;
            }
          }
        }
      }

      // 2. Rasterize Floating Lily Pads & Lotus Blossoms (occlude submerged koi!)
      for (const pad of this.pads) {
        const outerR = pad.r + 1.3;
        const c0 = clamp(Math.floor((pad.x - outerR) / asp), 0, cols - 1);
        const c1 = clamp(Math.ceil((pad.x + outerR) / asp), 0, cols - 1);
        const r0 = clamp(Math.floor(pad.y - outerR), 0, rows - 1);
        const r1 = clamp(Math.ceil(pad.y + outerR), 0, rows - 1);

        for (let cy = r0; cy <= r1; cy++) {
          const wy = cy + 0.5;
          const rowOff = cy * cols;
          for (let cx = c0; cx <= c1; cx++) {
            const wx = (cx + 0.5) * asp;
            const idx = rowOff + cx;

            // Soft drop shadow beneath pad
            const sdx = wx - (pad.x + 0.55);
            const sdy = wy - (pad.y + 0.45);
            const sd = Math.hypot(sdx, sdy);
            const dx = wx - pad.x;
            const dy = wy - pad.y;
            const d = Math.hypot(dx, dy);

            // Organic scalloped pad edge
            const ang = Math.atan2(dy, dx);
            const wobble = 1.0 + Math.sin(ang * 5 + pad.id * 1.3) * 0.035 + Math.cos(ang * 3 - pad.notch) * 0.025;
            const effR = pad.r * wobble;

            // Classic V-notch cleft on each lily pad
            const notchDiff = Math.abs(angleDiff(ang, pad.notch));
            const inNotch = notchDiff < 0.24 * (0.35 + 0.65 * (d / effR));

            if (d <= effR && !inNotch) {
              const rn = d / effR;
              // Lotus blossom near center of selected pads
              if (pad.blossom && d < pad.r * 0.34) {
                const bn = d / (pad.r * 0.34);
                const petalAng = ang - pad.notch * 0.5;
                const petalWave = 0.78 + 0.22 * Math.cos(petalAng * 6);
                if (bn < 0.34) {
                  this.padMask[idx] = 7; // golden stamen core
                  this.padGlyph[idx] = '*';
                } else if (bn < 0.68 * petalWave) {
                  this.padMask[idx] = 6; // inner petals
                  this.padGlyph[idx] = bn < 0.5 ? '@' : 'o';
                } else if (bn < petalWave) {
                  this.padMask[idx] = 5; // outer petals
                  this.padGlyph[idx] = rippleArcGlyph(ang, 0.75);
                } else {
                  this.padMask[idx] = 2;
                  this.padGlyph[idx] = '%';
                  this.padShade[idx] = 0.7;
                }
                continue;
              }

              // Rolled rim highlight
              if (rn > 0.87 || (notchDiff < 0.32 && rn > 0.22)) {
                this.padMask[idx] = 4; // rim
                this.padGlyph[idx] = rippleArcGlyph(ang, 0.68);
                this.padShade[idx] = 0.75 + 0.25 * Math.cos(ang + 0.8);
              } else {
                // Radial leaf veins radiating from stem center
                const relAng = ang - pad.notch;
                const veinFrac = Math.abs(((relAng * 4 / Math.PI) % 1 + 1.5) % 1 - 0.5);
                if (rn > 0.16 && veinFrac < 0.085) {
                  this.padMask[idx] = 3; // vein
                  this.padGlyph[idx] = angleStroke(ang, false);
                  this.padShade[idx] = 0.85;
                } else {
                  this.padMask[idx] = 2; // lush leaf interior
                  const light = 0.55 + 0.45 * (0.5 - 0.5 * Math.cos(ang + 0.9) * rn);
                  this.padShade[idx] = light;
                  const h = hash2(cx, cy, pad.id);
                  if (rn < 0.22) this.padGlyph[idx] = '+';
                  else if (light > 0.76) this.padGlyph[idx] = h > 0.5 ? '%' : '&';
                  else if (light > 0.54) this.padGlyph[idx] = h > 0.5 ? '#' : ';';
                  else this.padGlyph[idx] = h > 0.45 ? ':' : ',';
                }
              }
            } else if (sd <= pad.r * 1.03 && this.padMask[idx] === 0) {
              this.padMask[idx] = 1; // pad drop shadow on water
            }
          }
        }
      }

      // 3. Rasterize Food Crumbs (and tiny nibbling halos)
      for (const f of this.foods) {
        const cx = Math.round(f.x / asp - 0.5);
        const cy = Math.round(f.y - 0.5);
        const life = 1.0 - f.age / f.maxAge;
        const pulse = Math.sin(this.simTime * 5.0 + f.phase);
        if (cx >= 0 && cx < cols && cy >= 0 && cy < rows) {
          const idx = cy * cols + cx;
          this.foodMask[idx] = 2;
          this.foodGlyph[idx] = pulse > 0.35 ? '*' : f.size > 1.0 ? '@' : 'o';
          this.foodLife[idx] = life;
        }
        // Subtle tiny floating ring around crumb so it pops cleanly
        const ringGlyphs = [
          [-1, 0, '('], [1, 0, ')'],
        ];
        for (const [ox, oy, g] of ringGlyphs) {
          const rx = cx + ox;
          const ry = cy + oy;
          if (rx >= 0 && rx < cols && ry >= 0 && ry < rows) {
            const ridx = ry * cols + rx;
            if (this.foodMask[ridx] === 0) {
              this.foodMask[ridx] = 1;
              this.foodGlyph[ridx] = g;
              this.foodLife[ridx] = life * 0.65;
            }
          }
        }
      }

      // 4. Rasterize Koi Wake Bubbles
      for (const w of this.wakes) {
        const cx = Math.round(w.x / asp - 0.5);
        const cy = Math.round(w.y - 0.5);
        if (cx >= 0 && cx < cols && cy >= 0 && cy < rows) {
          const idx = cy * cols + cx;
          const fade = (1 - w.age / w.maxAge) * w.strength;
          if (fade > this.wakeMask[idx]) {
            this.wakeMask[idx] = fade;
            this.wakeGlyph[idx] = fade > 0.45 ? w.glyph : '.';
          }
        }
      }

      // 5. Rasterize Falling Rain Streaks & Splashes (Preset 2: Rain)
      if (P.rainIntensity > 0.04) {
        const count = Math.floor(this.rainDrops.length * P.rainIntensity);
        for (let i = 0; i < count; i++) {
          const d = this.rainDrops[i];
          const sx = ((d.x % this.worldW) + this.worldW) % this.worldW;
          const sy = ((d.y % this.worldH) + this.worldH) % this.worldH;
          const cx = Math.floor(sx / asp);
          const cy = Math.floor(sy);
          if (cx >= 2 && cx < cols - 2 && cy >= 2 && cy < rows - 2) {
            const idx = cy * cols + cx;
            this.rainMask[idx] = 1;
            this.rainGlyph[idx] = d.z > 0.45 ? '/' : "'";
            this.rainAlpha[idx] = 0.70 + 0.30 * (1 - d.z);
            // 2nd & 3rd trailing streak cells for unmistakable falling rain ribbons
            const idx2 = (cy - 1) * cols + (cx + 1);
            if (this.rainMask[idx2] === 0 && d.z > 0.18) {
              this.rainMask[idx2] = 1;
              this.rainGlyph[idx2] = '/';
              this.rainAlpha[idx2] = 0.52;
            }
            const idx3 = (cy - 2) * cols + (cx + 1);
            if (this.rainMask[idx3] === 0 && d.z > 0.48) {
              this.rainMask[idx3] = 1;
              this.rainGlyph[idx3] = ':';
              this.rainAlpha[idx3] = 0.32;
            }
          }
          // Surface splash crown
          if (d.splashTimer > 0.15) {
            const spx = Math.floor(d.splashX / asp);
            const spy = Math.floor(d.splashY);
            if (spx >= 1 && spx < cols - 1 && spy >= 1 && spy < rows - 1) {
              const sidx = spy * cols + spx;
              this.rainMask[sidx] = 2;
              this.rainGlyph[sidx] = d.splashTimer > 0.55 ? '*' : 'v';
              this.rainAlpha[sidx] = d.splashTimer;
            }
          }
        }
      }
    }

    // -----------------------------------------------------------------------
    // SHADER-LIKE PER-CELL COMPOSITOR: main(x, y, t, pointer) -> { glyph, color }
    // Evaluates water caustics, ripple wave distortion, submerged koi,
    // surface rings, food, floating lily pads, rain, and preset lighting.
    // -----------------------------------------------------------------------
    main(x, y, t, pointer) {
      const idx = y * this.cols + x;
      const wx = (x + 0.5) * this.aspect;
      const wy = y + 0.5;
      const P = this.preset;
      const out = this.cellOut;

      // 1. Evaluate Ripple Field (expanding rings + wave slope for refraction)
      let rippleCrest = 0;
      let rippleAng = 0;
      let refractX = 0;
      let refractY = 0;
      let clickBoost = 0;

      const ripples = this.ripples;
      for (let i = 0; i < ripples.length; i++) {
        const rp = ripples[i];
        const dx = wx - rp.x;
        const dy = wy - rp.y;
        const dSq = dx * dx + dy * dy;
        const band = rp.isClick ? 5.6 : 2.3;
        const rMin = Math.max(0, rp.r - band);
        const rMax = rp.r + band;
        if (dSq > rMax * rMax || dSq < rMin * rMin) continue;

        const d = Math.sqrt(dSq) + 0.0001;
        const delta = d - rp.r; // 0 right on wavefront
        const env = Math.exp(-(delta * delta) / (rp.isClick ? 3.8 : 1.05));
        const lifeFade = Math.pow(1 - rp.age / rp.maxAge, 0.72);
        // Primary crest + subtle trailing harmonic ring
        const wave = Math.cos(delta * (rp.isClick ? 2.05 : 2.8)) * env * lifeFade * rp.strength;
        const absW = Math.abs(wave);

        if (absW > rippleCrest) {
          rippleCrest = absW;
          rippleAng = Math.atan2(dy, dx);
          if (rp.isClick) clickBoost = Math.max(clickBoost, absW);
        }
        refractX += (dx / d) * wave * 1.45;
        refractY += (dy / d) * wave * 1.45;
      }

      // 2. Falling Rain Layer (topmost air layer in Rain preset)
      const rMask = this.rainMask[idx];
      if (rMask > 0) {
        const c = mixRgb(P.waterHigh, P.rainColor, clamp(this.rainAlpha[idx], 0.25, 1.0));
        out.glyph = this.rainGlyph[idx];
        out.color = rgbStr(c[0], c[1], c[2]);
        return out;
      }

      // 3. Floating Lily Pads & Lotus Blossoms (occlude water & koi swimming underneath!)
      const pMask = this.padMask[idx];
      if (pMask >= 2) {
        let col;
        const sh = this.padShade[idx];
        if (pMask === 7) col = P.blossomCore;
        else if (pMask === 6) col = P.blossomInner;
        else if (pMask === 5) col = P.blossomOuter;
        else if (pMask === 4) col = mixRgb(P.padMid, P.padVein, clamp(sh, 0.2, 1.0));
        else if (pMask === 3) col = P.padVein;
        else col = mixRgb(P.padDark, P.padBright, clamp(sh, 0, 1));

        // Subtle shimmer when a strong click ripple passes beneath a lily pad rim
        if (pMask === 4 && rippleCrest > 0.35) {
          col = mixRgb(col, P.rippleColor, clamp(rippleCrest * 0.45, 0, 0.55));
        }
        out.glyph = this.padGlyph[idx];
        out.color = rgbStr(col[0], col[1], col[2]);
        return out;
      }

      // 4. Floating Food Crumbs (sit right on surface)
      const fMask = this.foodMask[idx];
      if (fMask > 0) {
        const life = this.foodLife[idx];
        const col = fMask === 2
          ? mixRgb(P.foodDim, P.foodBright, 0.45 + 0.55 * life)
          : mixRgb(P.waterHigh, P.foodDim, 0.65);
        out.glyph = this.foodGlyph[idx];
        out.color = rgbStr(col[0], col[1], col[2]);
        return out;
      }

      // 5. Subtle Interactive Pointer Reticle (delicate surface glint when pointer active)
      if (pointer.active) {
        const pd = Math.hypot(wx - pointer.wx, wy - pointer.wy);
        if (pd < 0.72) {
          out.glyph = pointer.clickFlash > 0.2 ? '*' : '+';
          const c = mixRgb(P.foodBright, P.rippleColor, pointer.clickFlash);
          out.color = rgbStr(c[0], c[1], c[2]);
          return out;
        }
        if (pd > 1.05 && pd < 1.55) {
          const pa = Math.atan2(wy - pointer.wy, wx - pointer.wx);
          out.glyph = rippleArcGlyph(pa, 0.48);
          const c = mixRgb(P.waterHigh, P.rippleColor, 0.55);
          out.color = rgbStr(c[0], c[1], c[2]);
          return out;
        }
      }

      // 6. Submerged Koi Layer (refracted slightly when strong click ripple passes over!)
      let sampleIdx = idx;
      if (clickBoost > 0.32) {
        const rx = clamp(x + Math.round(refractX * 0.85), 0, this.cols - 1);
        const ry = clamp(y + Math.round(refractY * 0.55), 0, this.rows - 1);
        sampleIdx = ry * this.cols + rx;
      }

      const kKind = this.koiKind[sampleIdx];
      if (kKind >= 2) {
        // Strong click ripple crest sparkles right across the water over the fish
        if (rippleCrest > 0.66) {
          const rCol = mixRgb(
            [this.koiR[sampleIdx], this.koiG[sampleIdx], this.koiB[sampleIdx]],
            P.rippleColor,
            clamp((rippleCrest - 0.45) * 1.15, 0.35, 0.88)
          );
          out.glyph = rippleArcGlyph(rippleAng, rippleCrest);
          out.color = rgbStr(rCol[0], rCol[1], rCol[2]);
          return out;
        }

        // Pad edge shadow softly darkens koi peeking out from under a lily pad
        let kr = this.koiR[sampleIdx];
        let kg = this.koiG[sampleIdx];
        let kb = this.koiB[sampleIdx];
        if (pMask === 1) {
          kr *= 0.55;
          kg *= 0.55;
          kb *= 0.55;
        } else if (rippleCrest > 0.25) {
          const m = clamp(rippleCrest * 0.38, 0, 0.4);
          kr = lerp(kr, P.rippleColor[0], m);
          kg = lerp(kg, P.rippleColor[1], m);
          kb = lerp(kb, P.rippleColor[2], m);
        }
        out.glyph = this.koiGlyph[sampleIdx];
        out.color = rgbStr(kr, kg, kb);
        return out;
      }

      // 7. Expanding Surface Ripple Arcs (distort & illuminate water)
      if (rippleCrest > 0.17) {
        const tCol = clamp(rippleCrest * 0.92, 0, 1);
        const col = mixRgb(P.rippleSub, P.rippleColor, tCol);
        out.glyph = rippleArcGlyph(rippleAng, rippleCrest);
        out.color = rgbStr(col[0], col[1], col[2]);
        return out;
      }

      // 8. Koi Wake Bubbles
      const wake = this.wakeMask[idx];
      if (wake > 0.14) {
        const col = mixRgb(P.waterMid, P.wakeColor, clamp(wake, 0.25, 1.0));
        out.glyph = this.wakeGlyph[idx];
        out.color = rgbStr(col[0], col[1], col[2]);
        return out;
      }

      // 9. Living Pond Water Field: soft current, caustics, sunset reflections, moon sparkles
      const u = wx / this.worldW;
      const v = wy / this.worldH;

      // Subtle pond-bank depth vignette
      const edgeDist = Math.hypot((u - 0.5) * 1.85, (v - 0.5) * 1.95);
      const vignette = 1.0 - smoothstep(0.68, 1.32, edgeDist) * 0.55;

      // Flowing water coordinates refracted by ripples
      const flow = t * P.currentSpeed;
      const fx = (wx + refractX) * 0.16 - flow * 0.32;
      const fy = (wy + refractY) * 0.19 - flow * 0.14;

      // Multi-octave organic caustic interference field
      const w1 = Math.sin(fx * 2.1 + Math.cos(fy * 1.7 + flow * 0.45));
      const w2 = Math.cos(fy * 2.5 - Math.sin(fx * 1.9 - flow * 0.38));
      const w3 = Math.sin((fx + fy) * 1.45 + flow * 0.55);
      const causticRaw = (w1 + w2 + w3 * 0.7) / 2.7; // [-1, 1]
      const caustic = Math.pow(clamp(causticRaw * 0.5 + 0.5, 0, 1), 2.15) * vignette;

      // Floor shadows (koi shadow or lily pad shadow) darken water glyphs cleanly
      if (pMask === 1 || kKind === 1) {
        if (caustic < 0.25) {
          out.glyph = ' ';
          return out;
        }
        const sc = mixRgb(P.padShadow, P.waterLow, 0.55);
        out.glyph = '.';
        out.color = rgbStr(sc[0], sc[1], sc[2]);
        return out;
      }

      // Preset 3 (Sunset): long warm horizontal reflection shimmer across middle-upper pond
      if (P.sunsetGlow > 0.05) {
        const sunBand = Math.exp(-Math.pow((u - 0.52) / 0.34, 2)) * Math.exp(-Math.pow((v - 0.42) / 0.40, 2));
        const streak = Math.sin(wy * 1.35 + Math.sin(wx * 0.25 + t * 1.4) * 2.2 + t * 1.9);
        const sunGlint = sunBand * Math.pow(clamp(streak * 0.5 + 0.5, 0, 1), 2.5) * P.sunsetGlow;
        if (sunGlint > 0.20) {
          const sc = mixRgb(P.waterHigh, P.causticBright, clamp(sunGlint * 1.35, 0, 1));
          out.glyph = sunGlint > 0.58 ? '=' : sunGlint > 0.38 ? '~' : '-';
          out.color = rgbStr(sc[0], sc[1], sc[2]);
          return out;
        }
      }

      // Preset 4 (Moonlight): crisp sparse silver starlight/moonbeam sparkles on dark indigo water
      if (P.moonSparkle > 0.05) {
        const h = hash2(x, y, 77);
        if (h > 0.972) {
          const twinkle = Math.pow(0.5 + 0.5 * Math.sin(t * (2.6 + h * 4.0) + h * 60.0), 6.0);
          if (twinkle * P.moonSparkle > 0.42) {
            const sc = mixRgb(P.causticBright, P.sparkleColor, twinkle);
            out.glyph = twinkle > 0.78 ? '*' : twinkle > 0.58 ? '+' : '·';
            out.color = rgbStr(sc[0], sc[1], sc[2]);
            return out;
          }
        }
      }

      // Bright caustic ridges vs soft ambient current texture
      if (caustic > 0.50) {
        const ci = clamp(Math.floor(((caustic - 0.50) / 0.50) * P.causticGlyphs.length), 0, P.causticGlyphs.length - 1);
        const col = mixRgb(P.waterMid, P.causticBright, clamp((caustic - 0.45) * 1.55, 0, 1));
        out.glyph = P.causticGlyphs[ci];
        out.color = rgbStr(col[0], col[1], col[2]);
        return out;
      }

      // Soft ambient water glyphs (keeps pond dense, textured, and readable without clutter)
      const cellNoise = hash2(x, y, 13);
      const density = caustic * 1.35 + cellNoise * 0.35;
      if (density < 0.38) {
        out.glyph = ' ';
        return out;
      }
      const wi = clamp(Math.floor(density * P.waterGlyphs.length), 0, P.waterGlyphs.length - 1);
      const wg = P.waterGlyphs[wi];
      if (wg === ' ') {
        out.glyph = ' ';
        return out;
      }
      const wCol = mixRgb(P.waterLow, P.waterHigh, clamp((caustic - 0.12) * 1.9, 0, 1));
      out.glyph = wg;
      out.color = rgbStr(wCol[0], wCol[1], wCol[2]);
      return out;
    }

    // -----------------------------------------------------------------------
    // Render Full Typographic Pond Frame to 2D Canvas + Discreet Monospace HUD
    // -----------------------------------------------------------------------
    draw() {
      const ctx = this.ctx;
      const P = this.preset;
      const w = this.pixelW;
      const h = this.pixelH;

      // 1. Deep-water radial gradient background
      const grad = ctx.createRadialGradient(
        w * 0.5, h * 0.48, h * 0.08,
        w * 0.5, h * 0.50, Math.max(w, h) * 0.68
      );
      grad.addColorStop(0, rgbStr(P.bg[0] + 6, P.bg[1] + 9, P.bg[2] + 10));
      grad.addColorStop(1, rgbStr(P.bgEdge[0], P.bgEdge[1], P.bgEdge[2]));
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);

      // Populate agent buffers before running the per-cell shader
      this.buildAgentBuffers();

      // 2. Evaluate main(x, y, t, pointer) across the full character grid
      // Bucket by quantized color so Canvas 2D fillStyle changes stay minimal (60fps+ smooth!)
      const fontSize = Math.round(this.cellH * 0.89);
      ctx.font = `${fontSize}px "DejaVu Sans Mono", "Liberation Mono", "JetBrains Mono", monospace`;
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';

      const cols = this.cols;
      const rows = this.rows;
      const cw = this.cellW;
      const ch = this.cellH;
      const t = this.simTime;
      const ptr = this.pointer;

      const buckets = new Map();
      for (let y = 0; y < rows; y++) {
        const py = y * ch + 1;
        for (let x = 0; x < cols; x++) {
          const cell = this.main(x, y, t, ptr);
          if (cell.glyph === ' ') continue;
          let list = buckets.get(cell.color);
          if (list === undefined) {
            list = [];
            buckets.set(cell.color, list);
          }
          list.push(cell.glyph, x * cw, py);
        }
      }

      for (const [color, list] of buckets) {
        ctx.fillStyle = color;
        for (let i = 0; i < list.length; i += 3) {
          ctx.fillText(list[i], list[i + 1], list[i + 2]);
        }
      }

      // 3. Draw floating micro-petals / pollen motes in subtle tone
      ctx.fillStyle = rgbStr(P.waterHigh[0], P.waterHigh[1], P.waterHigh[2]);
      for (const m of this.floatingPetals) {
        const cx = Math.floor(m.x / this.aspect);
        const cy = Math.floor(m.y);
        if (cx >= 0 && cx < cols && cy >= 0 && cy < rows) {
          const idx = cy * cols + cx;
          if (this.padMask[idx] === 0 && this.koiKind[idx] < 2) {
            ctx.fillText(m.glyph, cx * cw, cy * ch + 1);
          }
        }
      }

      // 4. Discreet Monospace HUD (bottom-left preset pill + bottom-right key legend)
      this.drawHud(ctx, P, w, h);
    }

    drawHud(ctx, P, w, h) {
      const padX = 22;
      const padY = 18;
      const barH = 34;
      const activePreset = PRESETS[this.presetIdx];

      ctx.save();
      ctx.font = '600 13px "DejaVu Sans Mono", "Liberation Mono", monospace';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';

      // Left pill: Title + Active Preset Name
      const leftText = `KOI POND  //  [${activePreset.id}] ${activePreset.name}  ·  ${activePreset.subtitle}`;
      const leftW = ctx.measureText(leftText).width + 26;
      const leftY = h - padY - barH;

      ctx.fillStyle = P.hudBg;
      ctx.strokeStyle = P.hudBorder;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(padX, leftY, leftW, barH, 6);
      ctx.fill();
      ctx.stroke();

      // Highlight active preset segment
      const prefix = 'KOI POND  //  ';
      const activeSeg = `[${activePreset.id}] ${activePreset.name}`;
      const suffix = `  ·  ${activePreset.subtitle}`;
      let curX = padX + 13;
      const midY = leftY + barH * 0.5 + 0.5;

      ctx.fillStyle = P.hudMuted;
      ctx.fillText(prefix, curX, midY);
      curX += ctx.measureText(prefix).width;

      ctx.fillStyle = P.hudAccent;
      ctx.fillText(activeSeg, curX, midY);
      curX += ctx.measureText(activeSeg).width;

      ctx.fillStyle = P.hudMuted;
      ctx.fillText(suffix, curX, midY);

      // Right pill: Preset switcher 1-4 + controls
      const items = PRESETS.map((pr) => ({
        label: `[${pr.id}] ${pr.name}`,
        active: pr.id === activePreset.id,
      }));
      const hint = '   MOVE: FEED · CLICK: RIPPLE';
      let rightContentW = 0;
      for (let i = 0; i < items.length; i++) {
        rightContentW += ctx.measureText(items[i].label + (i < items.length - 1 ? '  ' : '')).width;
      }
      rightContentW += ctx.measureText(hint).width;
      const rightW = rightContentW + 26;
      const rightX = w - padX - rightW;

      if (rightX > padX + leftW + 20) {
        ctx.fillStyle = P.hudBg;
        ctx.strokeStyle = P.hudBorder;
        ctx.beginPath();
        ctx.roundRect(rightX, leftY, rightW, barH, 6);
        ctx.fill();
        ctx.stroke();

        let rx = rightX + 13;
        for (let i = 0; i < items.length; i++) {
          const it = items[i];
          ctx.fillStyle = it.active ? P.hudAccent : P.hudMuted;
          ctx.fillText(it.label, rx, midY);
          rx += ctx.measureText(it.label + (i < items.length - 1 ? '  ' : '')).width;
        }
        ctx.fillStyle = P.hudMuted;
        ctx.fillText(hint, rx, midY);
      }

      ctx.restore();
    }

    // -----------------------------------------------------------------------
    // Deterministic Frame Render Hook (Pure function of frameIndex)
    // -----------------------------------------------------------------------
    renderFrame(frameIndex) {
      const target = Math.max(0, frameIndex | 0);
      if (target < this.currentFrame || this.currentFrame === -1) {
        this.reset();
        for (let f = 0; f <= target; f++) {
          this.step(FIXED_DT, false);
        }
        this.currentFrame = target;
      } else if (target > this.currentFrame) {
        for (let f = this.currentFrame + 1; f <= target; f++) {
          this.step(FIXED_DT, false);
        }
        this.currentFrame = target;
      }
      this.draw();
    }

    getInfo() {
      return {
        pixelW: this.pixelW,
        pixelH: this.pixelH,
        cols: this.cols,
        rows: this.rows,
        koiCount: this.kois.length,
        padCount: this.pads.length,
        preset: PRESETS[this.presetIdx].name,
        t: +this.t.toFixed(3),
        foods: this.foods.length,
        ripples: this.ripples.length,
      };
    }

    getDebugState() {
      return {
        frame: this.currentFrame,
        t: +this.t.toFixed(3),
        preset: PRESETS[this.presetIdx].name,
        foods: this.foods.length,
        ripples: this.ripples.length,
        startledKois: this.kois.filter((k) => k.startleTimer > 0.05).length,
        kois: this.kois.map((k) => ({
          name: k.spec.name,
          x: +(k.x / this.worldW).toFixed(2),
          y: +(k.y / this.worldH).toFixed(2),
          spd: +k.speed.toFixed(1),
          startle: +k.startleTimer.toFixed(2),
        })),
      };
    }
  }

  // -------------------------------------------------------------------------
  // Bootstrap Interactive Page & Capture API
  // -------------------------------------------------------------------------
  const canvas = document.getElementById('pond-canvas');
  const pond = new AsciiKoiPond(canvas);

  // Expose deterministic capture & inspection hook
  window.__koiPond = {
    renderFrame: (frameIndex) => pond.renderFrame(frameIndex),
    setPreset: (id, instant = false) => pond.setPreset(id, instant),
    clickAt: (nx, ny) => pond.spawnRipple(nx * pond.worldW, ny * pond.worldH, true),
    dropFoodAt: (nx, ny, count = 3) => pond.dropFood(nx * pond.worldW, ny * pond.worldH, count),
    reset: () => pond.reset(),
    getInfo: () => pond.getInfo(),
    getDebugState: () => pond.getDebugState(),
  };

  if (!IS_CAPTURE) {
    // Live Interactive Event Handlers
    const toWorld = (clientX, clientY) => {
      const rect = canvas.getBoundingClientRect();
      const nx = clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1);
      const ny = clamp((clientY - rect.top) / Math.max(1, rect.height), 0, 1);
      return [nx * pond.worldW, ny * pond.worldH];
    };

    const handlePointerMove = (clientX, clientY) => {
      const [wx, wy] = toWorld(clientX, clientY);
      const lp = pond.livePointer;
      const dist = lp.active ? Math.hypot(wx - lp.wx, wy - lp.wy) : 0;
      lp.vx = (wx - lp.wx) * 20;
      lp.vy = (wy - lp.wy) * 20;
      lp.prevWx = lp.wx;
      lp.prevWy = lp.wy;
      lp.wx = wx;
      lp.wy = wy;
      lp.active = true;
      lp.lastDropDist += dist;
      if (lp.lastDropDist >= 2.2) {
        lp.lastDropDist = 0;
        pond.dropFood(wx, wy, 1);
      }
    };

    canvas.addEventListener('pointermove', (e) => {
      handlePointerMove(e.clientX, e.clientY);
    });

    canvas.addEventListener('pointerleave', () => {
      pond.livePointer.active = false;
    });

    canvas.addEventListener('pointerdown', (e) => {
      const [wx, wy] = toWorld(e.clientX, e.clientY);
      pond.livePointer.wx = wx;
      pond.livePointer.wy = wy;
      pond.livePointer.active = true;
      pond.spawnRipple(wx, wy, true);
    });

    window.addEventListener('keydown', (e) => {
      if (e.key === '1') pond.setPreset(1);
      else if (e.key === '2') pond.setPreset(2);
      else if (e.key === '3') pond.setPreset(3);
      else if (e.key === '4') pond.setPreset(4);
      else if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        pond.paused = !pond.paused;
      } else if (e.key === 'r' || e.key === 'R') {
        pond.reset();
      } else if (e.key === 'f' || e.key === 'F') {
        pond.dropFood(pond.livePointer.wx, pond.livePointer.wy, 5);
      }
    });

    window.addEventListener('resize', () => {
      pond.resize(window.innerWidth, window.innerHeight);
    });

    // Live 60fps animation loop with fixed-step accumulator
    let lastTs = performance.now();
    let acc = 0;
    const loop = (now) => {
      const dt = Math.min(0.05, (now - lastTs) / 1000);
      lastTs = now;
      if (!pond.paused) {
        acc += dt;
        let steps = 0;
        while (acc >= FIXED_DT && steps < 3) {
          pond.step(FIXED_DT, false);
          acc -= FIXED_DT;
          steps++;
        }
      }
      pond.draw();
      requestAnimationFrame(loop);
    };
    pond.draw();
    requestAnimationFrame(loop);
  } else {
    // Capture mode: render frame 0 immediately so canvas is never blank
    pond.renderFrame(0);
  }
})();
