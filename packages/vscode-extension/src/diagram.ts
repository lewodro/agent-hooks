export function renderKnotDiagram(): string {
  const hooks = [
    { name: "DynamicLTV", color: "#E63946", knot: "slip" },
    { name: "TimeTriggerLiq", color: "#5BC0EB", knot: "timer" },
    { name: "WhitelistBorrow", color: "#9D6BFF", knot: "lock" },
    { name: "AntiMEVLiq", color: "#7CB07A", knot: "bowline" },
    { name: "AutoHedge", color: "#FFD976", knot: "helix" },
    { name: "ReputationRate", color: "#F0EAD6", knot: "rolling" },
  ];
  const ropes = hooks
    .map((h, i) => {
      const y = 80 + i * 60;
      return `<g>
        <path d="M40,${y} C200,${y - 20} 360,${y + 20} 520,${y}" stroke="${h.color}" stroke-width="10" fill="none" stroke-linecap="round" />
        <circle cx="520" cy="${y}" r="6" fill="#FFD93D" />
        <text x="540" y="${y + 4}" fill="#F0EAD6" font-family="Space Mono, monospace" font-size="14">${h.name}</text>
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
      background: #3D2817;
      color: #F0EAD6;
      font-family: "Space Mono", monospace;
    }
    .frame { padding: 32px; }
    h1 { font-size: 1.25rem; letter-spacing: 0.08em; }
    p { color: #D4AF37; font-size: 0.85rem; max-width: 540px; }
  </style>
</head>
<body>
  <div class="frame">
    <h1>AGENT HOOKS — HOOK DESIGNER</h1>
    <p>Tie hooks together to compose a knot. Each rope is a different lifecycle handler. The brass LED on the right tells you which hooks fire on the next event.</p>
    <svg viewBox="0 0 760 460" width="100%" height="460">
      <rect width="760" height="460" fill="#3D2817" />
      <rect x="0" y="0" width="760" height="460" fill="url(#leather)" opacity="0.08" />
      ${ropes}
      <defs>
        <pattern id="leather" patternUnits="userSpaceOnUse" width="40" height="40">
          <rect width="40" height="40" fill="#3D2817" />
          <path d="M0 20 Q20 0 40 20" stroke="#5C3A1E" stroke-width="1" fill="none" />
        </pattern>
      </defs>
    </svg>
  </div>
</body>
</html>`;
}
