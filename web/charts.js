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

const SANS = 'Inter, system-ui, sans-serif';

function theme() {
  return {
    ink:   css('--ink'),
    ink2:  css('--ink-2'),
    ink3:  css('--ink-3'),
    line:  css('--line'),
    lineStrong: css('--line-strong'),
    panel: css('--panel'),
    accent: css('--accent'),
    // The reference's single data hue. Every one-series chart is this green;
    // --cat-* only comes out when there is genuinely more than one series.
    data:  css('--data'),
    // --cat-*, not --tok-* + --accent: several of those resolve to the same
    // hex, which put two identical colours in one donut legend. --cat-1 IS the
    // data green by design, so a lone series and a first slice agree.
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
    textStyle: { color: t.ink2, fontFamily: SANS },
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
    // No axis line. The reference draws dates and nothing else — a rule under
    // every chart was one horizontal line per cell for no information.
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { color: t.ink3, fontSize: 9.5, hideOverlap: true, fontFamily: SANS },
    ...extra,
  };
}

function yAxis(t, extra = {}) {
  return {
    type: 'value',
    axisLine: { show: false },
    axisTick: { show: false },
    // Solid hairline, not dashed. Dashes read as a second kind of mark; at this
    // weight a solid rule disappears behind the data, which is the job.
    splitLine: { lineStyle: { color: t.line, type: 'solid' } },
    axisLabel: { color: t.ink3, fontSize: 9.5, formatter: tickFmt, fontFamily: SANS },
    ...extra,
  };
}

function tooltip(t, extra = {}) {
  return {
    trigger: 'axis',
    backgroundColor: t.panel,
    borderColor: t.lineStrong,
    borderWidth: 1,
    padding: [8, 11],
    textStyle: { color: t.ink, fontFamily: SANS, fontSize: 11.5 },
    extraCssText: 'box-shadow: 0 8px 22px rgba(0,0,0,.22); border-radius: 6px;',
    ...extra,
  };
}

/** A metric cell's chart, exactly as the reference draws it.
 *
 *  Dates along the bottom and nothing else: no y-axis, no tick labels, no
 *  gridlines, no axis rule. The value is already printed at the top of the cell
 *  in full, so a y-axis would be a second, worse copy of a number the reader has
 *  read — and six cells of scaffolding is what made the old grid feel busy. The
 *  trend's SHAPE is the only thing this adds, so the shape is all it draws.
 *
 *  Hovering still gives the exact figure through the tooltip, which is where a
 *  precise mid-series value belongs. */
export function metricChart(el, { x, values, color, valueFormatter, onSelect }) {
  const c = mount(el);
  if (!c) return null;
  bindResize();
  const t = theme();
  const hue = color || t.data;

  // Edge labels are centred on their tick, so half of the first and last sit
  // outside the box. Two ways to fix that, and which one is right depends on
  // how much room there is:
  //   wide  — pull the edge labels inward (alignMin/MaxLabel) and keep the line
  //           full-bleed, which is what the reference does.
  //   narrow — inset the grid instead. Pulling them inward at 406px put "29 Jun"
  //           0.1px from "2 Jul", so they read as one string. hideOverlap never
  //           fires because they do not technically overlap.
  const narrow = (el.clientWidth || 0) < 520;
  const inset = narrow ? 15 : 0;

  c.setOption({
    ...base(t),
    // bottom must clear the axis label AND its margin, or the SVG viewBox
    // shears the glyph bottoms off — at 16 every date lost 3.4px and "Jul"
    // rendered as something closer to "lul". Set explicitly rather than via
    // containLabel: there is no y-axis here, so containLabel would only
    // re-derive this one number, less predictably.
    grid: { left: inset, right: inset, top: 8, bottom: 24, containLabel: false },
    tooltip: tooltip(t, {
      axisPointer: { type: 'line', lineStyle: { color: t.lineStrong, width: 1 } },
      valueFormatter: valueFormatter || (v => Number(v).toLocaleString()),
    }),
    xAxis: xAxis(t, x, {
      boundaryGap: false,
      // Only the ends and a couple of interior ticks; the reference labels
      // roughly six points across a six-month span, never every category.
      //
      // alignMin/MaxLabel keep the grid full-bleed AND the end dates whole. A
      // label is centred on its tick, so the last one sat half outside the box
      // and rendered as "29" where it should read "29 Jul"; the alternative fix
      // — insetting the grid — stops the line short of the cell edge, which is
      // the one thing the reference never does.
      axisLabel: {
        color: t.ink3, fontSize: 9.5, fontFamily: SANS, hideOverlap: true,
        showMinLabel: true, showMaxLabel: true, margin: 9,
        ...(narrow ? {} : { alignMinLabel: 'left', alignMaxLabel: 'right' }),
      },
    }),
    yAxis: {
      type: 'value',
      show: false,
      // Floor at zero so a flat series sits on the baseline rather than being
      // auto-scaled into a dramatic-looking wiggle across three dollars.
      min: 0,
    },
    series: [{
      type: 'line',
      data: values,
      smooth: 0.32,
      showSymbol: false,
      lineStyle: { width: 1.4, color: hue },
      itemStyle: { color: hue },
      areaStyle: {
        color: {
          type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [
            { offset: 0, color: hue + '4a' },
            { offset: 1, color: hue + '00' },
          ],
        },
      },
    }],
  });

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
        color: color || t.data,
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

  // Ring at 27% with a vertical legend pinned right needs about 520px to hold
  // both. Below that the legend's three fixed columns (92+62+34) no longer fit
  // the remaining space and its text lands on the ring — measured at 406px, the
  // ring ended at 215 and the legend started at 217. Under the threshold the
  // ring goes up top and the legend sits beneath it, full width.
  const narrow = (el.clientWidth || 0) < 520;

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
      ...(narrow
        ? { left: 'center', bottom: 0, top: 'auto' }
        : { right: 4, top: 'middle' }),
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
          n: { color: t.ink2, fontSize: 11, fontFamily: SANS, width: 92 },
          v: { color: t.ink, fontSize: 11, fontFamily: SANS, width: 62, align: 'right' },
          p: { color: t.ink3, fontSize: 11, fontFamily: SANS, width: 34, align: 'right' },
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
      center: narrow ? ['50%', '30%'] : ['27%', '50%'],
      radius: narrow ? ['38%', '54%'] : ['58%', '84%'],
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
          v: { color: t.ink, fontSize: 20, fontWeight: 400, fontFamily: SANS, lineHeight: 26 },
          l: { color: t.ink3, fontSize: 10, fontWeight: 400, letterSpacing: 0.6 },
          hv: { color: t.ink, fontSize: 18, fontWeight: 400, fontFamily: SANS, lineHeight: 24 },
          hl: { color: t.ink3, fontSize: 10, fontWeight: 400 },
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
