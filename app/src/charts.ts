// Plain inline SVG, no charting library — kept consistent with the rest of app/ (vanilla TS,
// esbuild-bundled, no framework). Curve math and axis rounding follow the same approach T3 Code's
// usage chart uses (apps/web/src/components/usage/UsageProviderChart.tsx, MIT licensed): monotone
// cubic interpolation so a curve can never overshoot spiky data, and a "nice" axis max so the
// tallest value is never clipped.
import {h, svgEl} from './ui';

interface ChartPoint { x: number; y: number; }

/** Shape-preserving cubic tangents (Fritsch-Carlson). */
function monotoneTangents(points: readonly ChartPoint[]): number[] {
  const count = points.length;
  if (count < 2) return [0];
  const slopes: number[] = [];
  for (let i = 0; i < count - 1; i += 1) {
    const dx = points[i + 1]!.x - points[i]!.x;
    const dy = points[i + 1]!.y - points[i]!.y;
    slopes.push(dx === 0 ? 0 : dy / dx);
  }
  const tangents = new Array<number>(count).fill(0);
  tangents[0] = slopes[0] ?? 0;
  tangents[count - 1] = slopes[count - 2] ?? 0;
  for (let i = 1; i < count - 1; i += 1) {
    const previous = slopes[i - 1] ?? 0;
    const next = slopes[i] ?? 0;
    tangents[i] = previous * next <= 0 ? 0 : (previous + next) / 2;
  }
  for (let i = 0; i < count - 1; i += 1) {
    const slope = slopes[i] ?? 0;
    if (slope === 0) { tangents[i] = 0; tangents[i + 1] = 0; continue; }
    const a = (tangents[i] ?? 0) / slope;
    const b = (tangents[i + 1] ?? 0) / slope;
    const magnitude = a * a + b * b;
    if (magnitude > 9) {
      const scale = 3 / Math.sqrt(magnitude);
      tangents[i] = scale * a * slope;
      tangents[i + 1] = scale * b * slope;
    }
  }
  return tangents;
}

function curvePath(points: readonly ChartPoint[]): string {
  if (points.length === 0) return '';
  if (points.length === 1) return `M${points[0]!.x.toFixed(2)},${points[0]!.y.toFixed(2)}`;
  const tangents = monotoneTangents(points);
  let path = `M${points[0]!.x.toFixed(2)},${points[0]!.y.toFixed(2)}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const from = points[i]!;
    const to = points[i + 1]!;
    const dx = to.x - from.x;
    const c1x = from.x + dx / 3;
    const c1y = from.y + ((tangents[i] ?? 0) * dx) / 3;
    const c2x = to.x - dx / 3;
    const c2y = to.y - ((tangents[i + 1] ?? 0) * dx) / 3;
    path += ` C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${to.x.toFixed(2)},${to.y.toFixed(2)}`;
  }
  return path;
}

function niceAxisMax(peak: number, steps = 4): number {
  if (peak <= 0) return 0;
  const rawStep = peak / steps;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const step = (normalized > 5 ? 10 : normalized > 2 ? 5 : normalized > 1 ? 2 : 1) * magnitude;
  return Math.ceil(peak / step) * step;
}

/** A compact trend line with no axis. */
export function sparklineChart(values: readonly number[], color = 'currentColor'): SVGSVGElement {
  const width = 96;
  const height = 24;
  const finite = values.filter(Number.isFinite);
  const svg = svgEl('svg', {class: 'sparkline', viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none', 'aria-hidden': 'true'});
  if (finite.length < 2) return svg;
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const range = Math.max(max - min, 1e-6);
  const step = width / (finite.length - 1);
  const points = finite.map((value, index) => ({x: index * step, y: height - 2 - ((value - min) / range) * (height - 4)}));
  const line = curvePath(points);
  svg.append(
    svgEl('path', {d: `${line} L${width},${height} L0,${height} Z`, fill: color, 'fill-opacity': '0.14'}),
    svgEl('path', {d: line, fill: 'none', stroke: color, 'stroke-width': '1.6', 'stroke-linecap': 'round', 'vector-effect': 'non-scaling-stroke'})
  );
  return svg;
}

export interface ChartSeries { readonly label: string; readonly color: string; readonly values: readonly number[]; }

/** Multi-series line chart with gridlines, a legend, and start/mid/end category labels. */
export function lineChart(categories: readonly string[], series: readonly ChartSeries[], formatValue: (value: number) => string): HTMLElement {
  const width = 960;
  const height = 200;
  const topPad = 10;
  const peak = Math.max(1e-9, ...series.flatMap(item => item.values));
  const axisMax = niceAxisMax(peak) || peak;
  const toY = (value: number) => height - (value / axisMax) * (height - topPad);
  const stepX = categories.length > 1 ? width / (categories.length - 1) : 0;
  const gridTicks = 4;
  const ticks = Array.from({length: gridTicks + 1}, (_, index) => (axisMax / gridTicks) * index);

  const svg = svgEl('svg', {class: 'line-chart-svg', viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': 'multi-series chart'});
  for (const tick of ticks) {
    const y = toY(tick);
    svg.append(svgEl('line', {class: 'chart-grid-line', x1: '0', x2: String(width), y1: y.toFixed(2), y2: y.toFixed(2)}));
  }
  const byWeight = [...series].sort((a, b) => Math.max(...b.values, 0) - Math.max(...a.values, 0));
  const pointsByLabel = new Map<string, ChartPoint[]>();
  for (const item of byWeight) {
    const points = item.values.map((value, index) => ({x: index * stepX, y: toY(value)}));
    pointsByLabel.set(item.label, points);
    const line = curvePath(points);
    if (line) svg.append(svgEl('path', {d: `${line} L${width},${height} L0,${height} Z`, fill: item.color, 'fill-opacity': '0.12'}));
  }
  for (const item of byWeight) {
    const line = curvePath(pointsByLabel.get(item.label) ?? []);
    if (line) svg.append(svgEl('path', {d: line, fill: 'none', stroke: item.color, 'stroke-width': '2', 'stroke-linecap': 'round', 'vector-effect': 'non-scaling-stroke'}));
  }
  if (categories.length > 0 && stepX > 0) {
    categories.forEach((category, index) => {
      const detail = series.map(item => `${item.label} ${formatValue(item.values[index] ?? 0)}`).join(' · ');
      svg.append(svgEl('rect', {class: 'chart-hit-area', x: String(index * stepX - stepX / 2), y: '0', width: String(stepX), height: String(height)}, [
        svgEl('title', {}, [`${category} — ${detail}`])
      ]));
    });
  }

  const axisColumn = h('div', {class: 'chart-y-axis'}, ticks.slice().reverse().map(tick => h('span', {style: `top:${((toY(tick) / height) * 100).toFixed(2)}%`}, [tick === 0 ? '0' : formatValue(tick)])));
  const legend = h('div', {class: 'chart-legend'}, series.map(item => h('span', {class: 'chart-legend-item'}, [h('span', {class: 'chart-legend-swatch', style: `background:${item.color}`}), item.label])));
  const axisLabels = h('div', {class: 'chart-axis-labels'}, [
    h('span', {}, [categories[0] ?? '']),
    h('span', {}, [categories[Math.floor(categories.length / 2)] ?? '']),
    h('span', {}, [categories.at(-1) ?? ''])
  ]);
  return h('div', {class: 'line-chart'}, [
    legend,
    h('div', {class: 'line-chart-body'}, [axisColumn, h('div', {class: 'line-chart-plot'}, [svg])]),
    axisLabels
  ]);
}

export function metricCard(label: string, value: string, detail: string | Node): HTMLElement {
  return h('div', {class: 'metric-card'}, [h('span', {class: 'metric-label'}, [label]), h('strong', {}, [value]), h('span', {class: 'metric-detail'}, [detail])]);
}
