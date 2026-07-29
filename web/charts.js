// charts.js — ECharts wrappers that read their colours from the CSS theme.
//
// Nothing here hardcodes a hex value. The palette lives in style.css as custom
// properties, so light and dark stay in sync with the rest of the page and a
// theme switch is a re-render rather than a second colour table to maintain.

const COMPACT = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

/** Axis ticks read `7.7M`, never `7,700,000`. Long tick labels were the single
 *  biggest source of visual noise in the old charts — they forced a wide left
 *  gutter and pushed the plot area into a strip. */
const tickFmt = v => COMPACT.format(v);

function css(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function theme() {
  return {
    ink:   css('--ink'),
    ink2:  css('--ink-2'),
    ink3:  css('--ink-3'),
    line:  css('--line'),
    lineStrong: css('--line-strong'),
    panel: css('--panel'),
    accent: css('--accent'),
    // --cat-*, not --tok-* + --accent: several of those resolve to the same
    // hex, which put two identical colours in one donut legend.
    series: [
      css('--cat-1'), css('--cat-2'), css('--cat-3'),
      css('--cat-4'), css('--cat-5'), css('--cat-6'),
    ],
  };
}

// ECharts instances outlive the DOM nodes the router throws away. Rather than
// couple charts.js to the router, sweep for orphans on every new mount.
const live = new Set();

function sweep() {
  for (const c of live) {
    const dom = c.getDom();
    if (!dom || !dom.isConnected) { c.dispose(); live.delete(c); }
  }
}

function mount(el) {
  if (!el) return null;
  sweep();
  const existing = echarts.getInstanceByDom(el);
  if (existing) existing.dispose();
  const c = echarts.init(el, null, { renderer: 'svg' });
  live.add(c);
  return c;
}

/** Merge new data into a chart that is already on screen.
 *
 *  `mount` disposes and rebuilds, which is right for a navigation and wrong for
 *  a live tick — rebuilding restarts the entry animation and makes the page
 *  flinch every 30 seconds. setOption merges, so the line just moves. */
export function patch(el, option) {
  const c = el && echarts.getInstanceByDom(el);
  if (!c) return false;
  c.setOption(option);
  return true;
}

let resizeBound = false;
function bindResize() {
  if (resizeBound) return;
  resizeBound = true;
  let t;
  window.addEventListener('resize', () => {
    clearTimeout(t);
    t = setTimeout(() => { sweep(); live.forEach(c => c.resize()); }, 80);
  });
}

function base(t) {
  return {
    textStyle: { color: t.ink2, fontFamily: 'Inter, system-ui, sans-serif' },
    color: t.series,
    grid: { left: 4, right: 6, top: 20, bottom: 2, containLabel: true },
    animationDuration: 260,
  };
}

function xAxis(t, data, extra = {}) {
  return {
    type: 'category',
    data,
    boundaryGap: true,
    axisLine: { lineStyle: { color: t.line } },
    axisTick: { show: false },
    axisLabel: { color: t.ink3, fontSize: 10, hideOverlap: true },
    ...extra,
  };
}

function yAxis(t, extra = {}) {
  return {
    type: 'value',
    axisLine: { show: false },
    axisTick: { show: false },
    splitLine: { lineStyle: { color: t.line, type: 'dashed' } },
    axisLabel: { color: t.ink3, fontSize: 10, formatter: tickFmt },
    ...extra,
  };
}

function tooltip(t, extra = {}) {
  return {
    trigger: 'axis',
    backgroundColor: t.panel,
    borderColor: t.lineStrong,
    borderWidth: 1,
    padding: [9, 12],
    textStyle: { color: t.ink, fontFamily: 'Inter, system-ui, sans-serif', fontSize: 12 },
    extraCssText: 'box-shadow: 0 8px 24px rgba(0,0,0,.18); border-radius: 8px;',
    ...extra,
  };
}

/** A number with no axes, no grid and no labels. Used inside stat tiles, where
 *  the shape of the trend is the whole message and the values are already
 *  printed above it. */
export function sparkline(el, values, color, onSelect) {
  const c = mount(el);
  if (!c) return null;
  bindResize();
  if (onSelect) {
    el.style.cursor = 'crosshair';
    // Same trick as the hero line: a 1.5px stroke is not a click target, so map
    // the x pixel back to an index across the whole box.
    c.getZr().on('click', e => {
      const w = el.clientWidth || 1;
      const i = Math.round((e.offsetX / w) * (values.length - 1));
      if (i >= 0 && i < values.length) onSelect(i);
    });
  }
  const t = theme();
  const hue = color || t.accent;
  c.setOption({
    grid: { left: 0, right: 0, top: 2, bottom: 0 },
    xAxis: { type: 'category', show: false, boundaryGap: false, data: values.map((_, i) => i) },
    yAxis: { type: 'value', show: false, min: 0 },
    tooltip: { show: false },
    series: [{
      type: 'line',
      data: values,
      smooth: 0.35,
      showSymbol: false,
      lineStyle: { width: 1.5, color: hue },
      areaStyle: {
        color: {
          type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [
            { offset: 0, color: hue + '4d' },
            { offset: 1, color: hue + '00' },
          ],
        },
      },
    }],
    animation: false,
  });
  return c;
}

/** The hero trend: one filled line, minimal furniture, dates on the x-axis. */
export function areaChart(el, { x, values, color, valueFormatter, tickFormatter, onSelect }) {
  const c = mount(el);
  if (!c) return null;
  bindResize();
  const t = theme();
  const hue = color || t.accent;
  c.setOption({
    ...base(t),
    grid: { left: 4, right: 8, top: 12, bottom: 0, containLabel: true },
    tooltip: tooltip(t, {
      axisPointer: { type: 'line', lineStyle: { color: t.lineStrong } },
      valueFormatter: valueFormatter || (v => Number(v).toLocaleString()),
    }),
    xAxis: xAxis(t, x, { boundaryGap: false }),
    yAxis: yAxis(t, {
      splitNumber: 3,
      axisLabel: { color: t.ink3, fontSize: 10, formatter: tickFormatter || tickFmt },
    }),
    series: [{
      type: 'line',
      data: values,
      smooth: 0.3,
      showSymbol: false,
      lineStyle: { width: 2, color: hue },
      itemStyle: { color: hue },
      areaStyle: {
        color: {
          type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [
            { offset: 0, color: hue + '3d' },
            { offset: 1, color: hue + '00' },
          ],
        },
      },
    }],
  });

  // A line drawn with showSymbol:false has almost nothing to hit, so listening
  // for series clicks would mean asking the user to hit a 2px stroke. Take the
  // click anywhere in the plot area and map the x pixel back to a category.
  if (onSelect) {
    el.style.cursor = 'crosshair';
    c.getZr().on('click', e => {
      const pt = [e.offsetX, e.offsetY];
      if (!c.containPixel('grid', pt)) return;
      const i = Math.round(c.convertFromPixel({ seriesIndex: 0 }, pt)[0]);
      if (i >= 0 && i < x.length) onSelect(i);
    });
  }
  return c;
}

export function barChart(el, { categories, values, color, horizontal, onSelect }) {
  const c = mount(el);
  if (!c) return null;
  bindResize();
  const t = theme();
  const cat = xAxis(t, categories, { axisLabel: { color: t.ink3, fontSize: 10, hideOverlap: true } });
  const val = yAxis(t);
  c.setOption({
    ...base(t),
    // containLabel measures text a hair narrower than the SVG renderer draws it,
    // which shaves the first character off whichever label is longest. The left
    // slack absorbs that; the right margin is for the last x-axis tick, which
    // otherwise sits half outside the viewBox.
    grid: horizontal
      ? { left: 14, right: 20, top: 12, bottom: 2, containLabel: true }
      : base(t).grid,
    tooltip: tooltip(t, { axisPointer: { type: 'shadow' }, valueFormatter: v => Number(v).toLocaleString() }),
    // Horizontal is the right default for long category names: rotated labels
    // are unreadable and eat a third of the chart's height.
    xAxis: horizontal ? { ...val } : cat,
    // No explicit label width here on purpose. containLabel measures the text it
    // is actually going to draw; pin a width as well and the two disagree, which
    // clips the first character off the longest label. Callers truncate the
    // strings instead, which is the only place that knows what's safe to cut.
    yAxis: horizontal
      ? { ...cat, type: 'category', inverse: true, axisLabel: { color: t.ink2, fontSize: 11 } }
      : val,
    series: [{
      type: 'bar',
      data: values,
      itemStyle: {
        color: color || t.accent,
        borderRadius: horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0],
      },
      barMaxWidth: 22,
    }],
  });
  if (onSelect) c.on('click', p => onSelect(p.dataIndex, p.name));
  return c;
}

export function donutChart(el, data, {
  formatter, onSelect, centerLabel, centerValue, valueFormat = v => String(v),
} = {}) {
  const c = mount(el);
  if (!c) return null;
  bindResize();
  const t = theme();
  const total = data.reduce((a, d) => a + (d.value || 0), 0);
  const pctOf = v => (total ? (100 * v) / total : 0);

  c.setOption({
    color: t.series,
    tooltip: tooltip(t, {
      trigger: 'item',
      formatter: formatter
        || (p => `${p.name}<br/><b>${Number(p.value).toLocaleString()}</b> (${p.percent.toFixed(1)}%)`),
    }),
    // A three-column legend — name, amount, share — because this card is about
    // money and a bare percentage makes you go back to the tooltip for the
    // figure you actually wanted. Fixed widths keep the columns aligned; a
    // chip row underneath the ring could do neither.
    legend: {
      type: 'scroll',
      orient: 'vertical',
      right: 4,
      top: 'middle',
      itemWidth: 8,
      itemHeight: 8,
      itemGap: 13,
      icon: 'circle',
      pageIconColor: t.ink2,
      pageIconInactiveColor: t.line,
      pageTextStyle: { color: t.ink3 },
      textStyle: {
        color: t.ink2,
        fontSize: 11,
        rich: {
          n: { color: t.ink2, fontSize: 11, width: 92 },
          v: { color: t.ink, fontSize: 11, fontFamily: 'monospace', width: 62, align: 'right' },
          p: { color: t.ink3, fontSize: 11, fontFamily: 'monospace', width: 34, align: 'right' },
        },
      },
      formatter: name => {
        const d = data.find(x => x.name === name);
        if (!d) return name;
        const pct = pctOf(d.value);
        // Anything that rounds to 0% still had a real cost; say "<1%" rather
        // than print a zero next to a non-zero amount.
        const shown = pct > 0 && pct < 1 ? '<1%' : Math.round(pct) + '%';
        return `{n|${name}}{v|${valueFormat(d.value)}}{p|${shown}}`;
      },
    },
    series: [{
      type: 'pie',
      center: ['27%', '50%'],
      radius: ['58%', '84%'],
      avoidLabelOverlap: true,
      padAngle: 1.5,
      itemStyle: { borderColor: t.panel, borderWidth: 2, borderRadius: 6 },
      // The hole holds the total — the number every slice is a share of.
      // Hovering swaps it for that slice, so the ring answers its own question
      // without a trip to the tooltip.
      label: {
        show: true,
        position: 'center',
        formatter: () => `{v|${centerValue || ''}}\n{l|${centerLabel || ''}}`,
        rich: {
          v: { color: t.ink, fontSize: 21, fontWeight: 500, fontFamily: 'monospace', lineHeight: 27 },
          l: { color: t.ink3, fontSize: 10, fontWeight: 600, letterSpacing: 1 },
          hv: { color: t.ink, fontSize: 19, fontWeight: 500, fontFamily: 'monospace', lineHeight: 25 },
          hl: { color: t.ink3, fontSize: 10, fontWeight: 600 },
        },
      },
      emphasis: {
        scaleSize: 7,
        label: {
          show: true,
          formatter: p => `{hv|${valueFormat(p.value)}}\n{hl|${p.name}}`,
        },
      },
      labelLine: { show: false },
      data,
    }],
  });
  if (onSelect) c.on('click', p => onSelect(p.dataIndex, p.name));
  return c;
}
