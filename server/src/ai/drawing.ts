// Validate path syntax and keep endpoints/control points inside the canvas.
// Curves stay inside their control-point hull; arcs use a conservative envelope.
export function pathWithinBox(d: string, box: number[]): boolean {
  const token = /[a-df-zA-DF-Z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g;
  const parts = d.match(token) || [];
  if (d.replace(token, '').replace(/[\s,]/g, '')) return false;
  let i = 0,
    x = 0,
    y = 0,
    sx = 0,
    sy = 0,
    command = '',
    previous = '',
    cx = 0,
    cy = 0;
  const [bx, by, bw, bh] = box;
  const inside = (px: number, py: number) =>
    Number.isFinite(px) && Number.isFinite(py) && px >= bx && py >= by && px <= bx + bw && py <= by + bh;
  const arity: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7 };
  if (!/^[Mm]$/.test(parts[0] || '')) return false;
  while (i < parts.length) {
    if (/^[a-z]$/i.test(parts[i])) command = parts[i++];
    const c = command.toUpperCase(),
      rel = command !== c;
    if (c === 'Z') {
      x = sx;
      y = sy;
      command = '';
      previous = 'Z';
      continue;
    }
    const n = arity[c];
    if (!n || i + n > parts.length) return false;
    const values = parts.slice(i, i + n).map(Number);
    if (values.some((v) => !Number.isFinite(v))) return false;
    i += n;
    let nx = x,
      ny = y;
    if (
      ((c === 'S' && ['C', 'S'].includes(previous)) || (c === 'T' && ['Q', 'T'].includes(previous))) &&
      !inside(2 * x - cx, 2 * y - cy)
    )
      return false;
    let ncx = x,
      ncy = y;
    if (['C', 'S', 'Q'].includes(c)) {
      const offset = c === 'C' ? 2 : 0;
      ncx = values[offset] + (rel ? x : 0);
      ncy = values[offset + 1] + (rel ? y : 0);
    }
    if (c === 'T' && ['Q', 'T'].includes(previous)) {
      ncx = 2 * x - cx;
      ncy = 2 * y - cy;
    }
    if (c === 'H') {
      nx = values[0] + (rel ? x : 0);
    } else if (c === 'V') {
      ny = values[0] + (rel ? y : 0);
    } else if (c === 'A') {
      const [rx, ry, , large, sweep, ex, ey] = values;
      if (rx < 0 || ry < 0 || ![0, 1].includes(large) || ![0, 1].includes(sweep)) return false;
      nx = ex + (rel ? x : 0);
      ny = ey + (rel ? y : 0);
      // Conservative envelope: endpoints plus the full ellipse diameter.
      if (rx && ry) {
        const rotation = (values[2] * Math.PI) / 180,
          dx = (x - nx) / 2,
          dy = (y - ny) / 2;
        const px = Math.cos(rotation) * dx + Math.sin(rotation) * dy,
          py = -Math.sin(rotation) * dx + Math.cos(rotation) * dy;
        const scale = Math.max(1, Math.hypot(px / rx, py / ry));
        const radius = Math.max(rx, ry) * scale * 2;
        if (
          Math.min(x, nx) - radius < bx ||
          Math.max(x, nx) + radius > bx + bw ||
          Math.min(y, ny) - radius < by ||
          Math.max(y, ny) + radius > by + bh
        )
          return false;
      }
    } else {
      for (let j = 0; j < values.length; j += 2) {
        nx = values[j] + (rel ? x : 0);
        ny = values[j + 1] + (rel ? y : 0);
        if (!inside(nx, ny)) return false;
      }
    }
    if (!inside(nx, ny)) return false;
    x = nx;
    y = ny;
    cx = ncx;
    cy = ncy;
    previous = c;
    if (c === 'M') {
      sx = x;
      sy = y;
      command = rel ? 'l' : 'L';
    }
  }
  return true;
}
