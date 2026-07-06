// Deterministic SVG placeholders that read as scientific scatter figures,
// encoded as data URIs. No network assets — offline-friendly.

// Small seeded PRNG so figures are stable across renders and builds.
function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

interface Cluster {
  cx: number;
  cy: number;
  color: string;
  spread: number;
  n: number;
}

function scatter(width: number, height: number, clusters: Cluster[], seed: number): string {
  const rng = makeRng(seed);
  const dots: string[] = [];
  for (const c of clusters) {
    for (let i = 0; i < c.n; i++) {
      const angle = rng() * Math.PI * 2;
      const radius = rng() * c.spread;
      const x = (c.cx + Math.cos(angle) * radius).toFixed(1);
      const y = (c.cy + Math.sin(angle) * radius).toFixed(1);
      const r = (1.2 + rng() * 1.3).toFixed(1);
      dots.push(`<circle cx="${x}" cy="${y}" r="${r}" fill="${c.color}" opacity="0.72"/>`);
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="#ffffff"/>${dots.join(
    "",
  )}</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const HERO = {
  neuron: "#5b9bd5",
  muscle: "#bcbd22",
  immune: "#2ca02c",
  ciliated: "#17becf",
  germline: "#e377c2",
  progenitor: "#ff7f0e",
};

export const umapAtlas = scatter(
  640,
  420,
  [
    { cx: 250, cy: 260, color: HERO.neuron, spread: 130, n: 420 },
    { cx: 470, cy: 300, color: HERO.muscle, spread: 70, n: 150 },
    { cx: 500, cy: 150, color: HERO.immune, spread: 55, n: 120 },
    { cx: 300, cy: 180, color: HERO.progenitor, spread: 45, n: 90 },
    { cx: 360, cy: 250, color: HERO.germline, spread: 40, n: 70 },
    { cx: 330, cy: 320, color: HERO.ciliated, spread: 40, n: 70 },
  ],
  7,
);

export const umapBySite = scatter(
  320,
  260,
  [
    { cx: 150, cy: 130, color: "#9aa0a6", spread: 100, n: 300 },
    { cx: 210, cy: 90, color: "#9aa0a6", spread: 40, n: 60 },
  ],
  11,
);

export const umapByType = scatter(
  320,
  260,
  [
    { cx: 120, cy: 150, color: "#4c78a8", spread: 55, n: 120 },
    { cx: 210, cy: 110, color: "#f58518", spread: 45, n: 90 },
    { cx: 180, cy: 190, color: "#54a24b", spread: 45, n: 90 },
    { cx: 100, cy: 90, color: "#e45756", spread: 35, n: 70 },
    { cx: 240, cy: 180, color: "#b279a2", spread: 35, n: 70 },
  ],
  13,
);

export const citationScatter = scatter(
  360,
  300,
  [
    { cx: 120, cy: 90, color: "#8c8c8c", spread: 60, n: 80 },
    { cx: 230, cy: 200, color: "#3b6ea5", spread: 40, n: 30 },
  ],
  17,
);
