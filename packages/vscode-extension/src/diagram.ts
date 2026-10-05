export function renderKnotDiagram(): string {
  const hooks = [
    { name: "DynamicLTV", color: "var(--accent-primary)", knot: "slip" },
    { name: "TimeTriggerLiq", color: "var(--accent-secondary)", knot: "timer" },
    { name: "WhitelistBorrow", color: "#8B7CFF", knot: "lock" },
    { name: "AntiMEVLiq", color: "#A3E635", knot: "bowline" },
    { name: "AutoHedge", color: "#FF5DA2", knot: "helix" },
    { name: "ReputationRate", color: "var(--text-primary)", knot: "rolling" },
  ];
  const ropes = hooks
    .map((h, i) => {
      const y = 80 + i * 60;
      return `<g>
        <path d="M40,${y} C200,${y - 20} 360,${y + 20} 520,${y}" stroke="${h.color}" stroke-width="10" fill="none" stroke-linecap="round" />
        <circle cx="520" cy="${y}" r="6" fill="var(--accent-primary)" />
        <text x="540" y="${y + 4}" fill="var(--text-primary)" font-family="Space Mono, monospace" font-size="14">${h.name}</text>
      </g>`;
    })
    .join("\n");
  return /* html */ `
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Agent Hooks Hook Designer</title>
  <style>
    body {
      margin: 0;
      --accent-primary: #00FF66;
      --accent-secondary: #00E5FF;
      --background: #050811;
      --surface: #0D1322;
      --surface-raised: #1E293B;
      --text-primary: #E7F0FF;
      --text-muted: #94A3B8;
      --border: #25324A;
      background: var(--background);
      color: var(--text-primary);
      font-family: "Space Mono", monospace;
    }
    .frame { padding: 32px; }
    h1 { font-size: 1.25rem; letter-spacing: 0.08em; color: var(--accent-primary); text-shadow: 0 0 18px #00ff6640; }
    p { color: var(--accent-secondary); font-size: 0.85rem; max-width: 540px; }
    svg { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; }
  </style>
</head>
<body>
  <div class="frame">
    <h1>AGENT HOOKS — HOOK DESIGNER</h1>
    <p>Compose execution hooks as a live system. Each signal represents a lifecycle handler and highlights which agents learn from the next event.</p>
    <svg viewBox="0 0 760 460" width="100%" height="460">
      <rect width="760" height="460" fill="var(--surface)" />
      <rect x="0" y="0" width="760" height="460" fill="url(#grid)" opacity="0.32" />
      ${ropes}
      <defs>
        <pattern id="grid" patternUnits="userSpaceOnUse" width="32" height="32">
          <rect width="32" height="32" fill="var(--surface-raised)" />
          <path d="M32 0H0V32" stroke="var(--border)" stroke-width="1" fill="none" />
        </pattern>
      </defs>
    </svg>
  </div>
</body>
</html>`;
}
