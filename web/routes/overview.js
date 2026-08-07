import {
  api, fmt, tip, state, $$,
  readRange, sinceIso, withSince, periodControl, wirePeriod, rangeSpan,
  projectLabeller,
} from '/web/app.js';
import { metricChart, donutChart, patch } from '/web/charts.js';
import { overlayShell, closeOverlay } from '/web/overlay.js';
import { shortTool } from '/web/routes/view-tools.js';

// Overview answers three questions in order, and nothing else:
//   1. was this worth it?           → the cost cell
//   2. where did it go?             → ranked projects, model split
//   3. what should I do about it?   → Worth fixing
//
// Laid out as Adaline's project dashboard is: the period picker IS the page
// heading (it governs every number below it, and the sidebar already says which
// page you're on), a thin strip of counts sits beside it, and the metrics are
// borderless cells — name left, figure right, trend filling the rest. Session
// and prompt counts stay in the strip rather than earning a cell, because a
// day-by-day chart of "how many sessions" says nothing the number doesn't.

const h = fmt.htmlSafe;
const money = n => (n == null ? '—' : Math.abs(n) >= 100 ? fmt.usd0(n) : fmt.usd(n));

// --- the hero ----------------------------------------------------------------

/** The value is the anchor — it's the figure you came to see, and it's what
 *  every other number on the page is a share of.
 *
 *  The return multiple rides underneath it rather than replacing it. On a
 *  subscription the cost is not money you spent, and the ratio is what makes
 *  that concrete: same shape as ROAS, read the same way. It needs the dollars
 *  next to it to mean anything, which is the argument for keeping them first. */
function heroModel(totals, range) {
  const plan = state.pricing && state.pricing.plans[state.plan];
  const monthly = plan && plan.monthly;
  const cost = totals.cost_usd || 0;

  // "All time" has no defensible denominator — we don't know how many months of
  // subscription the history covers — so the multiple is simply left off.
  if (!monthly || !range.days) {
    return {
      label: 'Estimated cost',
      value: fmt.usd(cost),
      support: monthly ? `you pay $${monthly}/mo on ${h(plan.label)}` : '',
      whyText: costWhy(totals),
    };
  }

  // Normalise the WORK to a month, never the plan. Prorating the subscription
  // invents prices nobody is charged — a "$23.33 plan" over 7 days, a "$300
  // plan" over 90 — and reads as though the fee scales with the window. The fee
  // is $100 a month whatever range is selected, so that stays the denominator
  // and the work becomes a monthly rate.
  const perMonth = range.days ? cost * (30 / range.days) : cost;
  const mult = monthly > 0 ? perMonth / monthly : 0;
  const times = mult >= 10 ? Math.round(mult) : mult.toFixed(1);
  return {
    // On a subscription this figure is value received, not money spent, so
    // "cost" is actively the wrong word. It is not a *saving* either — the
    // Savings tab already uses that for the caching figure, and two numbers
    // called "saved" an order of magnitude apart would be worse than a dull
    // label. What it measures is the work, so that's what it says.
    label: 'Work delivered',
    value: fmt.usd(cost),
    support: (range.days === 30 ? '' : 'at this pace, ')
      + `<b>${times}×</b> your $${monthly}/mo ${h(plan.label)} plan`,
    whyText: returnWhy(totals, plan, perMonth, range),
  };
}

function returnWhy(totals, plan, perMonth, range) {
  const parts = [
    `What the work you did would have cost at pay-as-you-go API rates, against what you actually pay for ${plan.label}. Same shape as ROAS: return over spend, read as a multiple.`,
    range.days === 30
      ? `One month of ${plan.label} is $${plan.monthly}, and this window is a month, so it's a straight comparison.`
      : `The plan is $${plan.monthly} a month no matter which window you pick, so the plan price is left alone and the work is scaled instead: ${range.days} days at this rate works out to ${money(perMonth)} a month.`,
    'Above 1× the plan is paying for itself.',
    'It is NOT a measure of how well you work. A wasteful month scores higher than a careful one, because waste costs API dollars too. For that, look at what one prompt costs on the Savings tab.',
  ];
  if (totals.cost_estimated) {
    parts.push('One of your models has no exact price listed, so it was costed at its family\'s rate. Close, but approximate.');
  }
  const gaps = totals.unpriced_models || [];
  if (gaps.length) {
    parts.push('NOT counted — no price on file for '
      + gaps.map(g => `${g.model} (${fmt.int(g.billable_tokens)} tokens)`).join(', ')
      + '. Add them to pricing.json and restart.');
  }
  return parts.join('\n\n');
}

/** Say what the cost figure actually is, in plain words, including what it leaves out. */
function costWhy(totals) {
  const parts = [
    'What these tokens would cost at pay-as-you-go API rates.',
    'Each model has its own price, and input, output and cache tokens are charged '
    + 'differently — this adds all of it up. Cache reads are the cheap ones, at a '
    + 'tenth of normal input.',
  ];
  if (totals.cost_estimated) {
    parts.push('One of your models has no exact price listed, so it was costed at its '
      + 'family\'s rate. Close, but approximate.');
  }
  const gaps = totals.unpriced_models || [];
  if (gaps.length) {
    parts.push('NOT counted here — no price on file for '
      + gaps.map(g => `${g.model} (${fmt.int(g.billable_tokens)} tokens)`).join(', ')
      + '. Add them to pricing.json and restart to bring them in.');
  }
  parts.push('If you\'re on a Max or Pro subscription you didn\'t pay this — it\'s what '
    + 'the same work would have cost per-token.');
  return parts.join('\n\n');
}

/** How this period compares with the one before it.
 *
 *  Two things make a comparison unreadable, and both are handled here rather
 *  than shown raw. A near-empty baseline produces "↑ 12532%" or "↑ 128×", which
 *  is arithmetically true and says nothing except that the history doesn't go
 *  back far enough — so past 20× it is suppressed and says so instead. And
 *  spending more is up-and-bad, so the arrow reports direction while the colour
 *  reports whether you wanted it.
 *
 *  Returned in two pieces because they belong in two places. The reference sets
 *  a bare ↑ beside the figure and nothing else — so `chip` rides in the metric
 *  head, and `vs`, which is a sentence, drops to the note underneath. Putting
 *  both on the head line pushed a 40-character clause into the same row as the
 *  number it qualifies. */
function deltaChip(now, prev, label) {
  if (!now) return { chip: '', vs: '' };
  if (!prev || !isFinite(now / prev) || now / prev >= 20) {
    return {
      chip: '',
      vs: prev
        ? `Not enough earlier history to compare — ${money(prev)} in the ${h(label)}`
        : 'Not enough earlier history to compare',
    };
  }
  const ratio = now / prev;
  const pct = Math.round((ratio - 1) * 100);
  const flat = Math.abs(pct) < 2;
  const cls = flat ? 'flat' : pct > 0 ? 'rising' : 'falling';
  const arrow = flat ? '→' : pct > 0 ? '↑' : '↓';
  // Between 2× and 20× a percentage gets hard to size ("↑ 940%"), so those read
  // as a multiple. Either way the baseline sits next to it in dollars.
  const size = ratio >= 2 ? `${ratio.toFixed(1)}×`
    : ratio <= 0.5 ? `${(1 / ratio).toFixed(1)}× less`
    : `${Math.abs(pct)}%`;
  return {
    chip: `<span class="delta ${cls}">${arrow} ${size}</span>`,
    vs: `vs ${h(label)} (${money(prev)})`,
  };
}

/** The cost cell's sub-line. Three short clauses on one row — what the multiple
 *  means, how the period compares, and what clicking the chart does — rather
 *  than three stacked rows of chrome above a chart that is the actual content. */
const costNote = (hero, delta) =>
  [hero.support, delta.vs, 'Click any day for its breakdown'].filter(Boolean).join(' · ');

/** Tip titles carry absolute paths. Left whole they wrap to three lines each and
 *  turn the most actionable card on the page into a wall. */
function tipCard(t) {
  return `
    <div class="fix">
      <div class="fix-head">
        <span class="badge">${h(t.category)}</span>
        <strong class="blur-sensitive" title="${h(fmt.tildePath(t.title))}">${h(fmt.short(fmt.tildePath(t.title), 76))}</strong>
        <span class="spacer"></span>
        <button class="ghost" data-dismiss="${h(t.key)}" title="Hide for 14 days">✕</button>
      </div>
      <p class="fix-body blur-sensitive">${h(fmt.tildePath(t.body))}</p>
    </div>`;
}

const WINDOW_WHY = `Claude Code meters you on a rolling window, and this is what you have put through the current one.

There is no "remaining" figure here on purpose. Your cap is never written to disk — /status asks Anthropic for it live — so any percentage would be a guess dressed up as a measurement. This is the half that can be measured: what you have used, from your own transcripts.`;

/** What has gone through the current rolling window.
 *
 *  This used to be its own visual register — inline `12px` facts with the values
 *  bolded mid-sentence — which made it the fifth different kind of row on the
 *  page. It now reuses the same value-over-label stat pattern as the strip
 *  beside the picker, so there is one way to show a figure here, not two.
 *
 *  It is NOT merged into that strip, though it sits directly under it. These are
 *  two different time bases: the picker's strip counts the selected range, this
 *  counts the live rolling window. Putting "5,116 prompts" and "76 prompts" in
 *  one row under one heading would read as a contradiction. The leader on the
 *  left is what keeps them straight. */
function windowStrip(w) {
  if (!w || !w.turns) return '';
  const started = (w.first_activity || w.since).slice(11, 16);
  const billable = w.input_tokens + w.output_tokens
    + w.cache_create_5m_tokens + w.cache_create_1h_tokens;
  const stat = (v, l) => `<div class="s"><div class="s-v">${v}</div><div class="s-l">${h(l)}</div></div>`;
  return `<div class="window-strip">
    <div class="ws-lead">
      <span class="dot"></span>Current ${w.hours}h window ${tip(WINDOW_WHY)}
    </div>
    <div class="statstrip">
      ${stat(h(started), 'since')}
      ${stat(fmt.int(w.prompts), 'prompts')}
      ${stat(fmt.int(w.turns), 'turns')}
      ${stat(fmt.compact(billable), 'billable')}
      ${stat(money(w.cost_usd), 'of work')}
    </div>
    <span class="spacer"></span>
    <div class="ws-models">
      ${(w.models || []).slice(0, 2).map(m =>
        `<span class="badge ${fmt.modelClass(m)}">${h(fmt.modelShort(m))}</span>`).join(' ')}
    </div>
  </div>`;
}

/** A metric cell, as the reference draws one: name on the left, figure on the
 *  right at the same size, the trend filling the rest. No border, no fill — the
 *  grid gap is what separates them.
 *
 *  `key` is the server's own metric key (see METRICS in db.py) and is used for
 *  all four of the DOM hooks — the drill-down, the live value patch, the chart
 *  node and the chart's data. One key space, so a rename can't leave three of
 *  them agreeing and the fourth silently 400ing, which is exactly what had
 *  happened to cache_read and cache_create. */
const metricCell = ({ label, value, title, key, why, note, delta, tall, lead, drill = true }) => `
  <div class="metric${lead ? ' lead' : ''}${drill ? ' clickable' : ''}"${drill
      ? ` data-metric="${h(key)}" role="button" tabindex="0" title="Open the ${h(label.toLowerCase())} breakdown"`
      : ''}>
    <div class="metric-head">
      <span class="metric-label">${h(label)}${why ? tip(why) : ''}</span>
      <span class="metric-value" data-statval="${h(key)}" title="${h(title || String(value))}">${value}</span>
      ${delta || ''}
    </div>
    ${note ? `<p class="metric-note" data-note="${h(key)}">${note}</p>` : ''}
    <div class="metric-chart${tall ? ' tall' : ''}" data-chart="${h(key)}"></div>
  </div>`;

/** A figure in the strip beside the picker. Counts, not trends: a sparkline of
 *  "how many sessions per day" says nothing a number doesn't, and the reference
 *  keeps its strip to bare values for the same reason. */
const stripStat = ({ label, value, title, key, why }) => `
  <div class="s clickable" data-metric="${h(key)}" role="button" tabindex="0"
       title="Open the ${h(label.toLowerCase())} breakdown">
    <div class="s-v" data-statval="${h(key)}" title="${h(title || String(value))}">${value}</div>
    <div class="s-l">${h(label)}${why ? tip(why) : ''}</div>
  </div>`;

/** Ranked horizontal bars beat a grouped bar chart here: project names are long,
 *  the ordering is the message, and a rotated x-axis label is unreadable. */
function rankedProjects(projects) {
  // Slice FIRST, then label. Labelling the full set and slicing afterwards put
  // "footy-tourney · Second-Brain" on screen with its sibling ranked out of the
  // top 7 — a qualifier answering a question the reader cannot see being asked.
  // Disambiguation is for on-screen ambiguity; the full slug stays in `title`.
  const top = projects
    .slice()
    .sort((a, b) => (b.cost_usd || 0) - (a.cost_usd || 0)
                 || (b.billable_tokens || 0) - (a.billable_tokens || 0))
    .slice(0, 7);
  const label = projectLabeller(top);
  const rows = top.map(p => ({
    name: label(p), cost: p.cost_usd || 0, tokens: p.billable_tokens || 0,
  }));
  if (!rows.length) return '<div class="empty">no projects in this range</div>';
  const max = Math.max(...rows.map(r => r.cost), 0.0001);
  return rows.map(r => `
    <a class="bar-row" href="#/activity?view=projects" title="${h(r.name)} — ${fmt.int(r.tokens)} billable tokens">
      <span class="bar-name blur-sensitive">${h(r.name)}</span>
      <span class="bar-val">${money(r.cost)}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${Math.max(2, 100 * r.cost / max)}%"></span></span>
    </a>`).join('');
}

// --- data --------------------------------------------------------------------

async function load(range) {
  const since = sinceIso(range);
  const prevUntil = range.days ? since : null;
  const prevSince = range.days
    ? new Date(Date.now() - range.days * 2 * 86400 * 1000).toISOString()
    : null;

  const [totals, prevTotals, projects, daily, byModel, tips, win] = await Promise.all([
    api(withSince('/api/overview', since)),
    prevSince
      ? api(`/api/overview?since=${encodeURIComponent(prevSince)}&until=${encodeURIComponent(prevUntil)}`)
      : Promise.resolve(null),
    api(withSince('/api/projects', since)),
    api(withSince('/api/daily', since)),
    api(withSince('/api/by-model', since)),
    api('/api/tips'),
    api('/api/window'),
  ]);
  return { totals, prevTotals, projects, daily, byModel, tips, win };
}

/** Top 5 by cost, then one honest "other". A scrolling legend is a legend
 *  nobody reads, and past five slices the tail is rounding error. */
function modelSlices(byModel) {
  const priced = byModel
    .map(m => ({ name: fmt.modelShort(m.model) || 'unknown', model: m.model, value: m.cost_usd || 0 }))
    .filter(d => d.value > 0)
    .sort((a, b) => b.value - a.value);
  // Slices worth under 1% are legend rows that read "0%" next to a real dollar
  // figure. They go into `other` with the rest of the tail, and `other` only
  // appears if it is itself worth seeing.
  const sum = priced.reduce((a, d) => a + d.value, 0);
  const big = priced.filter(d => d.value / (sum || 1) >= 0.01).slice(0, 5);
  const rest = priced.filter(d => !big.includes(d));
  const tail = rest.reduce((a, d) => a + d.value, 0);
  if (rest.length) big.push({ name: `other (${rest.length})`, model: null, value: tail });
  return big;
}

// Axis categories are truncated to fit, so a click handler can't read the real
// key back off the label. Keep the originals alongside.
const keys = { days: [], models: [], tools: [] };

// --- render ------------------------------------------------------------------

/** Overview with nothing to show.
 *
 *  Rendering the normal page against an empty database produced five empty chart
 *  wells, a column of zeros and no next step — which is what a stranger sees on
 *  first run, since the scan has not happened yet. Savings already knew to say
 *  "Nothing scanned yet"; Overview, the landing route, did not.
 *
 *  Two different nothings, and telling them apart is the whole value: an empty
 *  DATABASE needs a command, an empty RANGE needs a wider range. The period head
 *  stays above this either way, so the picker is still there to widen. */
function emptyOverview(scanned) {
  if (!scanned) {
    return `<div class="blank">
      <h3>Nothing scanned yet</h3>
      <p>Token Meter reads the transcripts Claude Code writes to
        <code>~/.claude/projects</code>. Nothing has been read into the database
        yet, so there is nothing to cost.</p>
      <p>Run <code>python3 cli.py scan</code> in the project directory, then reload
        this page. A first scan over a lot of history takes a few minutes; after
        that it only reads what is new.</p>
    </div>`;
  }
  return `<div class="blank">
      <h3>Nothing in this range</h3>
      <p>There is usage on record, just none inside the window you picked. Choose a
        wider range above — <b>All time</b> will always show something.</p>
    </div>`;
}

export default async function renderOverview(root) {
  const range = readRange();
  const d = await load(range);
  const { totals, prevTotals, tips } = d;

  // Nothing in the selected window. One extra request, and only on this path, to
  // find out whether the database is empty or just this range is.
  const blank = !totals.sessions && !d.daily.length;
  let everScanned = true;
  if (blank) {
    try { everScanned = !!(await api('/api/overview')).sessions; } catch { everScanned = false; }
  }

  const cacheCreate = (totals.cache_create_5m_tokens || 0) + (totals.cache_create_1h_tokens || 0);
  const prevLabel = range.days ? `previous ${range.days} days` : '';
  const hero = heroModel(totals, range);
  const costDelta = deltaChip(totals.cost_usd, prevTotals && prevTotals.cost_usd, prevLabel);

  // The picker is the page's title. Overview needs no <h2> of its own — the
  // sidebar already says where you are, and the reference proves that the
  // control governing every number below reads better as the heading than a
  // word that repeats the nav item you just clicked.
  const head = `
    <div class="period-head">
      <div>
        ${periodControl(range)}
        <div class="period-sub" id="period-sub">${h(rangeSpan(range))}</div>
      </div>
      <div class="statstrip" id="statstrip">
        ${stripStat({
          label: 'Sessions', value: fmt.int(totals.sessions), key: 'sessions',
          why: 'One run of Claude Code, from `claude` to exit. Each session is a single transcript file.',
        })}
        ${stripStat({
          label: 'Prompts', value: fmt.int(totals.turns), key: 'turns',
          why: 'Messages you actually typed. Tool results are filed as user messages too, but those aren\'t prompts — counting them would inflate this about eightfold.',
        })}
      </div>
    </div>`;

  const body = blank ? emptyOverview(everScanned) : `
    <div id="window-strip">${windowStrip(d.win)}</div>

    <div class="metric-grid one">
      ${metricCell({
        // drill:false — "cost" is not one of the server's METRICS, and this
        // cell's drill-down is per-day off the chart itself, not a breakdown of
        // the whole figure. Leaving it clickable would send by=metric&key=cost
        // and 400.
        label: hero.label, value: hero.value, key: 'cost', tall: true, drill: false, lead: true,
        why: hero.whyText,
        delta: costDelta.chip,
        note: costNote(hero, costDelta),
      })}
    </div>

    <div class="metric-grid" style="margin-top:32px">
      ${metricCell({
        label: 'Input', value: fmt.compact(totals.input_tokens),
        title: fmt.int(totals.input_tokens) + ' tokens', key: 'input',
        why: 'New text sent to Claude — yours and tool results. Billed at the full input rate.',
      })}
      ${metricCell({
        label: 'Output', value: fmt.compact(totals.output_tokens),
        title: fmt.int(totals.output_tokens) + ' tokens', key: 'output',
        why: 'Text Claude wrote back. The most expensive rate per token.',
      })}
      ${metricCell({
        label: 'Cache read', value: fmt.compact(totals.cache_read_tokens),
        title: fmt.int(totals.cache_read_tokens) + ' tokens', key: 'cache_read',
        why: 'Re-used text billed at a tenth of input — your CLAUDE.md, files already read, the conversation so far. High is good.',
      })}
      ${metricCell({
        label: 'Cache create', value: fmt.compact(cacheCreate),
        title: fmt.int(cacheCreate) + ' tokens', key: 'cache_create',
        why: 'Writing something into the cache for the first time. Costs a premium once, then pays for itself on the next turn that reuses it.',
      })}
    </div>

    <div class="section">
      <div class="row split">
        <div>
          <div class="section-head">
            <h3>Where it went</h3>
            <span class="spacer"></span>
            <a href="#/activity?view=projects">All projects →</a>
          </div>
          <div id="where-body">${rankedProjects(d.projects)}</div>
        </div>

        <div class="donut-col">
          <div class="section-head"><h3>By model</h3></div>
          <p class="card-note">Share of API-equivalent cost, not of tokens — a Haiku token and an Opus token are not the same money. Click a slice for its projects.</p>
          <div id="ch-model" class="chart-donut"></div>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-head">
        <h3>Worth fixing</h3>
        <span class="spacer"></span>
        <span class="badge" id="tips-count">${tips.length}</span>
      </div>
      <div id="tips-body">
        ${tips.length === 0
          ? `<div class="empty">Nothing to flag. Patterns are detected over the last 7 days — check back after more activity.</div>`
          : tips.slice(0, 4).map(tipCard).join('')
            + (tips.length > 4 ? `
              <details class="more">
                <summary>${tips.length - 4} more</summary>
                ${tips.slice(4).map(tipCard).join('')}
              </details>` : '')}
      </div>
    </div>

    <details class="card glossary" style="margin-top:38px">
      <summary><h3 style="margin:0">What do these numbers mean?</h3><span class="muted" style="font-size:11.5px">— click to expand</span></summary>
      <dl>
        <dt>Session</dt><dd>One run of Claude Code (from <code>claude</code> to exit). Each session is a single <code>.jsonl</code> file.</dd>
        <dt>Prompt</dt><dd>One message you typed. Each triggers a response, possibly with many tool calls in between.</dd>
        <dt>Input tokens</dt><dd>The new text you (and tool results) sent to Claude. Billed at the full input rate.</dd>
        <dt>Output tokens</dt><dd>The text Claude wrote back. Billed at the highest rate — usually the biggest cost driver per turn.</dd>
        <dt>Cache read</dt><dd>Tokens re-used from a cache (your CLAUDE.md, previously-read files, the conversation so far). ~10× cheaper than fresh input. High counts mean good cost hygiene.</dd>
        <dt>Cache create</dt><dd>Writing something into the cache for the first time. A one-time premium that pays off on the next turn.</dd>
        <dt>Billable tokens</dt><dd>Input + output + cache create. Cache reads are billed separately, and much cheaper.</dd>
      </dl>
    </details>`;

  root.innerHTML = head + body;

  wirePeriod(root);
  wireDismiss(root);
  wireTiles(root);
  if (!blank) drawCharts(d);
}

const METRIC_LABEL = {
  sessions: 'Sessions', turns: 'Prompts', input: 'Input',
  output: 'Output', cache_read: 'Cache read', cache_create: 'Cache create',
};

function wireTiles(root) {
  $$('[data-metric]', root).forEach(el => {
    const open = () => openDrawer('metric', el.dataset.metric, METRIC_LABEL[el.dataset.metric] || el.dataset.metric);
    el.addEventListener('click', open);
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
  });
}

function wireDismiss(root) {
  $$('[data-dismiss]', root).forEach(b => {
    b.addEventListener('click', async () => {
      await fetch('/api/tips/dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: b.dataset.dismiss }),
      });
      b.closest('.fix').remove();
    });
  });
}

/** Daily series, keyed the same way as the cells that display them. */
function seriesFor(daily) {
  return {
    cost:         daily.map(x => x.cost_usd ?? 0),
    input:        daily.map(x => x.input_tokens),
    output:       daily.map(x => x.output_tokens),
    cache_read:   daily.map(x => x.cache_read_tokens),
    cache_create: daily.map(x => x.cache_create_tokens),
  };
}

function drawCharts(d) {
  const { daily, byModel } = d;
  keys.days = daily.map(x => x.day);
  const x = daily.map(v => fmt.day(v.day));
  const series = seriesFor(daily);

  // All five charts are the same green. They are five independent charts, not
  // five series in one, so a different hue per cell would encode nothing — and
  // one data colour is the reference's most consistent rule. The label says
  // which metric it is; the colour has no second job.
  metricChart(document.querySelector('[data-chart="cost"]'), {
    x,
    values: series.cost,
    valueFormatter: v => fmt.usd(v),
    onSelect: i => openDrawer('day', keys.days[i], fmt.day(keys.days[i])),
  });

  // No click handler on the token charts: the whole cell is already the target,
  // and two different results depending on which pixel you hit is worse than one.
  for (const k of ['input', 'output', 'cache_read', 'cache_create']) {
    metricChart(document.querySelector(`[data-chart="${k}"]`), {
      x,
      values: series[k],
      valueFormatter: v => fmt.int(v) + ' tokens',
    });
  }

  const slices = modelSlices(byModel);
  keys.models = slices.map(s => s.model);
  donutChart(document.getElementById('ch-model'), slices, {
    centerValue: money(slices.reduce((a, x) => a + x.value, 0)),
    centerLabel: 'TOTAL',
    valueFormat: money,
    formatter: p => `${p.name}<br/><b>${fmt.usd(p.value)}</b> (${p.percent.toFixed(1)}%)`,
    // The "other" slice is an aggregate with no single model behind it.
    onSelect: (i, name) => keys.models[i] && openDrawer('model', keys.models[i], name),
  });

}

// --- drill-down --------------------------------------------------------------

export async function openDrawer(kind, key, label) {
  if (!key) return;
  overlayShell({ title: label, body: '<div class="empty">Loading…</div>' });

  // A day is an absolute date, so the range filter would only ever exclude it.
  const since = kind === 'day' ? null : sinceIso(readRange());
  const url = `/api/breakdown?by=${kind}&key=${encodeURIComponent(key)}`
    + (since ? `&since=${encodeURIComponent(since)}` : '');

  let data;
  try {
    data = await api(url);
  } catch {
    return overlayShell({ title: label, body: '<div class="empty">Couldn\'t load that breakdown.</div>' });
  }

  const card = kind === 'day' ? dayCard(data)
    : kind === 'model' ? modelCard(data)
    : kind === 'metric' ? metricCard(data)
    : toolCard(data);

  const node = overlayShell({ title: label, amount: card.amount, amountClass: 'plain', body: card.body });

  // A day link inside a metric breakdown swaps the overlay for that day.
  $$('[data-day]', node).forEach(a => a.addEventListener('click', e => {
    e.preventDefault();
    openDrawer('day', a.dataset.day, fmt.day(a.dataset.day));
  }));
  // Following a session link means leaving this page, so the layer must go.
  $$('a[href^="#/sessions/"]', node).forEach(a => a.addEventListener('click', closeOverlay));
}

const miniTable = (head, rows) => `
  <div class="table-wrap"><table>
    <thead><tr>${head}</tr></thead>
    <tbody>${rows || '<tr><td colspan="4" class="empty">nothing here</td></tr>'}</tbody>
  </table></div>`;

function dayCard(d) {
  const projLabel = projectLabeller(d.projects);
  const sessLabel = projectLabeller(d.sessions);
  const promptLabel = projectLabeller(d.prompts || []);
  const cost = d.models.reduce((s, m) => s + (m.cost_usd || 0), 0);
  const billable = m => (m.input_tokens || 0) + (m.output_tokens || 0)
    + (m.cache_create_5m_tokens || 0) + (m.cache_create_1h_tokens || 0);
  const prompts = d.prompts || [];
  return { amount: `${money(cost)} · ${fmt.int(d.prompt_count || 0)} prompts`, body: `
    <h4 style="margin:10px 0 8px">Prompts that cost the most${
      d.prompt_count > prompts.length ? ` <span class="muted" style="font-weight:400;text-transform:none;letter-spacing:0">top ${prompts.length} of ${fmt.int(d.prompt_count)}</span>` : ''}</h4>
    ${miniTable('<th class="num">cost</th><th>prompt</th><th>project</th><th>model</th><th class="num">turns</th><th>at</th>',
      prompts.map(p => `
        <tr>
          <td class="num">${money(p.cost_usd)}</td>
          <td class="blur-sensitive" title="${h(p.prompt_text)}">${h(fmt.short(p.prompt_text, 64))}</td>
          <td class="blur-sensitive"><a href="#/sessions/${encodeURIComponent(p.session_id)}">${h(promptLabel(p))}</a></td>
          <td>${(p.models || []).slice(0, 2).map(m =>
            `<span class="badge ${fmt.modelClass(m)}">${h(fmt.modelShort(m))}</span>`).join(' ')}</td>
          <td class="num">${fmt.int(p.turns)}</td>
          <td class="mono">${h((p.timestamp || '').slice(11, 16))}</td>
        </tr>`).join(''))}

    <div class="drawer-grid" style="margin-top:18px">
      <div>
        <h4>By model</h4>
        ${miniTable('<th>model</th><th class="num">turns</th><th class="num">billable</th><th class="num">cost</th>',
          d.models.slice().sort((a, b) => b.cost_usd - a.cost_usd).map(m => `
            <tr>
              <td><span class="badge ${fmt.modelClass(m.model)}">${h(fmt.modelShort(m.model))}</span></td>
              <td class="num">${fmt.int(m.turns)}</td>
              <td class="num">${fmt.compact(billable(m))}</td>
              <td class="num">${money(m.cost_usd)}</td>
            </tr>`).join(''))}
      </div>
      <div>
        <h4>By project</h4>
        ${miniTable('<th>project</th><th class="num">billable</th><th class="num">cost</th>',
          d.projects.map(p => `
            <tr>
              <td class="blur-sensitive" title="${h(p.project_slug)}">${h(projLabel(p))}</td>
              <td class="num">${fmt.compact(p.billable_tokens)}</td>
              <td class="num">${money(p.cost_usd)}</td>
            </tr>`).join(''))}
      </div>
      <div>
        <h4>Biggest sessions</h4>
        ${miniTable('<th>at</th><th>project</th><th class="num">prompts</th><th class="num">billable</th>',
          d.sessions.map(s => `
            <tr>
              <td class="mono">${h((s.started || '').slice(11, 16))}</td>
              <td class="blur-sensitive"><a href="#/sessions/${encodeURIComponent(s.session_id)}">${h(sessLabel(s))}</a></td>
              <td class="num">${fmt.int(s.turns)}</td>
              <td class="num">${fmt.compact(s.billable_tokens)}</td>
            </tr>`).join(''))}
      </div>
      <div>
        <h4>Tools called</h4>
        ${miniTable('<th>tool</th><th class="num">calls</th><th class="num">result tokens</th>',
          d.tools.map(t => `
            <tr>
              <td>${h(shortTool(t.tool_name))}</td>
              <td class="num">${fmt.int(t.calls)}</td>
              <td class="num">${t.result_tokens ? fmt.compact(t.result_tokens) : '<span class="muted">—</span>'}</td>
            </tr>`).join(''))}
      </div>
    </div>` };
}

function modelCard(d) {
  const cost = d.projects.reduce((s, p) => s + (p.cost_usd || 0), 0);
  // Same rule as rankedProjects: label only what is rendered.
  const top = d.projects.slice().sort((a, b) => b.cost_usd - a.cost_usd).slice(0, 12);
  const projLabel = projectLabeller(top);
  return { amount: money(cost), body: `
    <div class="drawer-grid">
      <div>
        <h4>Which projects used it</h4>
        ${miniTable('<th>project</th><th class="num">turns</th><th class="num">cost</th>',
          top.map(p => `
            <tr>
              <td class="blur-sensitive" title="${h(p.project_slug)}">${h(projLabel(p))}</td>
              <td class="num">${fmt.int(p.turns)}</td>
              <td class="num">${money(p.cost_usd)}</td>
            </tr>`).join(''))}
      </div>
      <div>
        <h4>Day by day</h4>
        ${miniTable('<th>day</th><th class="num">turns</th><th class="num">cost</th>',
          d.days.slice(-14).reverse().map(x => `
            <tr>
              <td class="mono">${h(x.day)}</td>
              <td class="num">${fmt.int(x.turns)}</td>
              <td class="num">${money(x.cost_usd)}</td>
            </tr>`).join(''))}
      </div>
    </div>` };
}

/** A stat tile, opened. Counts, not dollars — these metrics are volumes, and
 *  pricing a cache-read count would mean re-deriving a number the cost cards
 *  already show properly. */
function metricCard(d) {
  // bars() renders only the first 8, so label those 8 — not all of them.
  // Sorted explicitly because bars() scales widths off the max of what it gets.
  const topProjects = d.projects.slice().sort((a, b) => (b.value || 0) - (a.value || 0)).slice(0, 8);
  const projLabel = projectLabeller(topProjects);
  const sessLabel = projectLabeller(d.sessions);
  const n = v => fmt.int(v);
  const bars = rows => {
    if (!rows.length) return '<div class="empty">nothing in this range</div>';
    const max = Math.max(...rows.map(r => r.value), 1);
    return rows.slice(0, 8).map(r => `
      <div class="bar-row">
        <span class="bar-name blur-sensitive">${h(r.name)}</span>
        <span class="bar-val">${fmt.compact(r.value)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${Math.max(2, 100 * r.value / max)}%"></span></span>
      </div>`).join('');
  };
  const busiest = d.days.slice().sort((a, b) => b.value - a.value).slice(0, 8);
  // The overlay's title already names the metric, so the server's label repeated
  // it — "Input" above "7,264,761 input tokens". Keep the unit, drop the noun.
  const unit = /tokens$/.test(d.label || '') ? ' tokens' : '';
  return { amount: `${n(d.total)}${unit}`, body: `
    <div class="drawer-grid">
      <div>
        <h4>By project</h4>
        ${bars(topProjects.map(p => ({ name: projLabel(p), value: p.value })))}
      </div>
      <div>
        <h4>${d.models.length ? 'By model' : 'Busiest days'}</h4>
        ${d.models.length
          ? bars(d.models.map(m => ({ name: fmt.modelShort(m.model), value: m.value })))
          : bars(busiest.map(x => ({ name: fmt.day(x.day), value: x.value })))}
      </div>
      <div>
        <h4>Top sessions</h4>
        ${miniTable('<th>started</th><th>project</th><th class="num">' + h(d.label) + '</th>',
          d.sessions.map(x => `
            <tr>
              <td class="mono">${fmt.ts(x.started)}</td>
              <td class="blur-sensitive"><a href="#/sessions/${encodeURIComponent(x.session_id)}">${h(sessLabel(x))}</a></td>
              <td class="num">${fmt.compact(x.value)}</td>
            </tr>`).join(''))}
      </div>
      <div>
        <h4>${d.models.length ? 'Busiest days' : 'Day by day'}</h4>
        ${miniTable('<th>day</th><th class="num">' + h(d.label) + '</th>',
          busiest.map(x => `
            <tr>
              <td class="mono"><a href="#" data-day="${h(x.day)}">${h(x.day)}</a></td>
              <td class="num">${fmt.compact(x.value)}</td>
            </tr>`).join(''))}
      </div>
    </div>` };
}

function toolCard(d) {
  const projLabel = projectLabeller(d.projects);
  return { amount: `${fmt.int(d.totals.calls)} calls · ${fmt.int(d.totals.sessions)} sessions`, body: `
    <div class="drawer-grid">
      <div>
        <h4>Where it's called from</h4>
        ${miniTable('<th>project</th><th class="num">calls</th><th class="num">result tokens</th>',
          d.projects.map(p => `
            <tr>
              <td class="blur-sensitive" title="${h(p.project_slug)}">${h(projLabel(p))}</td>
              <td class="num">${fmt.int(p.calls)}</td>
              <td class="num">${p.result_tokens ? fmt.compact(p.result_tokens) : '<span class="muted">—</span>'}</td>
            </tr>`).join(''))}
      </div>
      <div>
        <h4>Day by day</h4>
        ${miniTable('<th>day</th><th class="num">calls</th><th class="num">result tokens</th>',
          d.days.slice(-14).reverse().map(x => `
            <tr>
              <td class="mono">${h(x.day)}</td>
              <td class="num">${fmt.int(x.calls)}</td>
              <td class="num">${x.result_tokens ? fmt.compact(x.result_tokens) : '<span class="muted">—</span>'}</td>
            </tr>`).join(''))}
      </div>
    </div>
    <p class="drawer-note">No dollar figure here, on purpose. A tool call's token cost isn't
      recorded against the call, so pricing one would mean inventing a number.</p>` };
}

// --- live update -------------------------------------------------------------

/** Called on a scan event instead of a full re-render.
 *
 *  Rebuilding the route every 30 seconds threw away scroll position, closed the
 *  open drawer and the "N more" fold, and restarted every chart animation. This
 *  writes new numbers into the DOM that's already there, so the page just ticks. */
export async function live(root) {
  // The empty state has none of the nodes the patches below target, so a scan
  // that finally finds data has to re-render rather than write into nothing.
  if (root.querySelector('.blank')) return void (await renderOverview(root));
  const range = readRange();
  const d = await load(range);
  const { totals, prevTotals, daily, tips } = d;
  const cacheCreate = (totals.cache_create_5m_tokens || 0) + (totals.cache_create_1h_tokens || 0);
  const prevLabel = range.days ? `previous ${range.days} days` : '';
  const hero = heroModel(totals, range);

  const costDelta = deltaChip(totals.cost_usd, prevTotals && prevTotals.cost_usd, prevLabel);
  const set = (sel, html) => { const el = root.querySelector(sel); if (el) el.innerHTML = html; };

  // Every figure is now addressed by its own metric key, so the cost cell and
  // the five token/count figures all patch through the same two selectors.
  const stats = {
    cost:         hero.value,
    sessions:     fmt.int(totals.sessions),
    turns:        fmt.int(totals.turns),
    input:        fmt.compact(totals.input_tokens),
    output:       fmt.compact(totals.output_tokens),
    cache_read:   fmt.compact(totals.cache_read_tokens),
    cache_create: fmt.compact(cacheCreate),
  };
  for (const [k, v] of Object.entries(stats)) set(`[data-statval="${k}"]`, v);

  // The delta chip is a sibling of the value, not part of it — replace it in
  // place, and add it if the previous tick had nothing to compare against.
  const head = root.querySelector('[data-statval="cost"]')?.parentElement;
  if (head) {
    head.querySelector('.delta')?.remove();
    if (costDelta.chip) head.insertAdjacentHTML('beforeend', costDelta.chip);
  }
  set('[data-note="cost"]', costNote(hero, costDelta));

  set('#where-body', rankedProjects(d.projects));
  set('#tips-count', String(tips.length));
  set('#window-strip', windowStrip(d.win));
  // The tips list itself is left alone deliberately: it holds an open <details>
  // and the dismiss buttons, and its 7-day window barely moves between scans.
  // The count is enough to say there's something new to look at.

  keys.days = daily.map(x => x.day);
  const x = daily.map(v => fmt.day(v.day));
  const series = seriesFor(daily);
  for (const [k, values] of Object.entries(series)) {
    patch(root.querySelector(`[data-chart="${k}"]`), {
      xAxis: { data: x },
      series: [{ data: values }],
    });
  }

  const slices = modelSlices(d.byModel);
  keys.models = slices.map(s => s.model);
  patch(root.querySelector('#ch-model'), {
    series: [{
      data: slices,
      label: { formatter: () => `{v|${money(slices.reduce((a, x) => a + x.value, 0))}}\n{l|TOTAL}` },
    }],
  });


  wireDismiss(root);
}
