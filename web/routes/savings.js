import { api, fmt, tip, $, $$, projectLabeller } from '/web/app.js';
import { openOverlay, closeOverlay, overlayShell, seg, sortable } from '/web/overlay.js';

// Savings — written to be read by someone who has not thought about token
// pricing before. Every number gets a plain sentence next to it, and an ⓘ that
// says what it means for your usage and what to do about it. The ⓘ is a real
// tooltip (hover, focus, or tap), not a native title= — those take a second to
// appear, can't be clicked, and collapse line breaks.

const h = fmt.htmlSafe;

const tile = (label, value, sub, cls, tipText, of) => `
  <div class="card tile${of ? ' clickable' : ''}"${of ? ` data-of="${of}" role="button" tabindex="0"` : ''}>
    <div class="tile-label">${h(label)} ${tip(tipText)}</div>
    <div class="tile-value ${cls || ''}">${value}</div>
    <div class="tile-sub">${sub}</div>
  </div>`;

// --- the plain-language explanations -----------------------------------------

const TIPS = {
  spent: `What your tokens would cost at pay-as-you-go API rates.

Every model has its own price, and input, output and cache tokens are each charged differently — this adds all of it up.

If you're on a Max or Pro subscription you did not actually pay this. It's what the same work would have cost per-token.`,

  caching: `Claude re-sends the whole conversation — plus your CLAUDE.md — on every single turn. That would be ruinous at full price, so repeated text is cached and billed at a tenth.

This is the difference between what you paid and what you'd have paid with no cache at all.

To keep it working for you: stay in longer sessions, and avoid editing CLAUDE.md or your tool list mid-session. Any change near the start of the prompt throws the whole cache away, and you pay full price to build it again.`,

  yourChanges: `Everything in the caching figure happens automatically. This is the part you caused.

It takes your worst week's daily rate for each habit — huge tool results, context rebuilt over and over — and adds up, day by day, how far under it you came.

Only days you actually beat your worst count. A steady week at your worst rate adds nothing, which is why this is a much smaller number than the caching one.

It still assumes you'd have stayed at your worst if you'd changed nothing, so read it as a fair estimate rather than a fact.`,

  hitRate: `Of everything Claude read, this much came from cache instead of being paid for in full.

Higher is cheaper, and it is the single biggest lever on your bill.

Below about 70% usually means sessions keep restarting, or something early in the prompt keeps changing and invalidating everything after it.`,

  writePremium: `Putting text into the cache costs 25% more than reading it once — double, for the one-hour cache.

It pays for itself on the second turn that reuses it. But if you keep starting fresh sessions, you pay the premium and never collect.

This is subtracted from the saving above, so the number you see is genuinely net.`,

  changePoints: `Days when something you do dropped sharply and stayed down — a file you stopped re-reading, context rebuilds falling off.

The dashboard can see the drop and price it. It cannot know what you did, because nothing records that.

Name the ones you recognise and the label sticks.`,

  waste: `Habits that cost tokens, measured now against the worst 7 days you've ever had.

"Down 23%" means you're doing 23% less of it than at your peak.

Where a pattern is counted in tokens it gets a dollar figure. Where it's counted in calls, it doesn't — guessing a token cost per call would be inventing a number.`,

  perTurn: `What one prompt of yours costs, on average, for the whole week.

A "prompt" here means something you actually typed. Claude Code files tool results as user messages too, but those aren't turns — counting them would divide this number by about eight and make everything look cheaper than it is.

Rising isn't automatically bad. It usually means each prompt is doing more: longer agent runs, more tool calls, more files touched. It's worth a look when it climbs and you don't think you asked for more.

It's a rate, so it never gets added into a dollar total. A quiet week and an efficient week look the same in a total; they look different here.`,

  forecast: `Last week's spend, multiplied out to a year.

A guess, not a promise — it assumes every week looks like the last one, which it won't.

Useful for one thing: deciding whether an optimization is worth an afternoon of your time.`,

  codex: `Tokens spent by Codex, not by Claude.

When a skill like /grill-me-codex hands work to Codex, that runs as a separate program. Claude's own logs record that it happened but not what it cost, so this is read from Codex's own session files.

"Cached" input is repeat text charged at a tenth, same idea as Claude's cache. If your Codex runs go through a ChatGPT subscription, this is what those tokens would have cost on the API — not money you were charged.`,

  gap: `These models have no price in pricing.json, so their tokens are missing from every figure on this page.

They aren't being counted as free by accident — they're listed here so you can see the hole. Add them to the file and restart the dashboard.`,
};

export default async function (root) {
  const s = await api('/api/savings');

  if (!s.history.first_day) {
    root.innerHTML = `
      <div class="pagehead"><h2>Savings</h2></div>
      <div class="card"><div class="empty">
        Nothing scanned yet. Run <code>python3 cli.py scan</code> first.
      </div></div>`;
    return;
  }

  root.innerHTML = `
    <div class="pagehead">
      <h2>Savings</h2>
      <span class="sub">last ${s.history.weeks} weeks</span>
    </div>

    <div class="section tight">
      <p class="lede">
        Over the last <b>${s.history.weeks} weeks</b> your tokens were worth
        <b>${fmt.usd(s.spend.total_usd)}</b>.
        Without caching, the same work would have cost
        <b>${fmt.usd(s.spend.without_caching_usd)}</b> —
        so you paid about <b>${s.spend.discount_pct}% less</b> than the sticker price.
      </p>
    </div>

    <div class="grid-3" style="margin-top:14px">
      ${tile('Work delivered', fmt.usd(s.spend.total_usd),
             `Claude ${fmt.usd(s.spend.claude_usd)} + Codex ${fmt.usd(s.spend.codex_usd)}`,
             '', TIPS.spent, 'spend')}
      ${tile('Caching paid for itself', fmt.usd(s.headline.exact_usd),
             'Automatic. Exact figure.', 'good', TIPS.caching, 'caching')}
      ${tile('Your own improvements', fmt.usd(s.headline.attributed_usd),
             'Measured against your worst week.', 'good', TIPS.yourChanges)}
    </div>

    ${cacheCard(s)}
    ${changeCard(s)}
    ${wasteCard(s)}
    ${efficiencyCard(s)}
    ${projectionCard(s)}
    ${codexCard(s)}
    ${unpricedCard(s)}
  `;

  wireLabels(root);
  wireTiles(root);
}

// --- the breakdown overlay ---------------------------------------------------
//
// Click a tile, get the breakdown as a layer over the page. It lived inline
// first, part-way down a page that already carries seven cards, so the answer
// to "what made this number" arrived buried among six other things. A layer
// gets the screen to itself and leaves when you're done with it.

const VIEWS = [
  {
    key: 'spend',
    tab: 'Work delivered',
    title: 'Work delivered',
    col: 'cost_usd',
    colLabel: 'cost',
    plain: true,
    lead: 'Where the work happened. Costed at pay-as-you-go API rates.',
  },
  {
    key: 'caching',
    tab: 'Caching',
    title: 'Caching paid for itself',
    col: 'cache_saved_usd',
    colLabel: 'saved',
    lead: 'Where the caching saving came from — long sessions re-reading a stable prompt. '
        + 'Net of the premium paid to write those cache entries, so these add up to the headline.',
  },
];

const SORTS = [
  { key: 'amount', label: 'Biggest' },
  { key: 'recent', label: 'Newest' },
  { key: 'oldest', label: 'Oldest' },
  { key: 'project', label: 'Project' },
];

const TOP_N = 12;
const cache = {};
let ui = { of: 'spend', list: 'sessions', sort: 'amount', showAll: false };

function wireTiles(root) {
  $$('[data-of]', root).forEach(el => {
    const open = () => {
      ui = { of: el.dataset.of, list: 'sessions', sort: 'amount', showAll: false };
      openPanel();
    };
    el.addEventListener('click', open);
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
  });
}

function openPanel() {
  openOverlay();
  draw();
}

function sortRows(rows, view) {
  const when = r => String(r.started || r.timestamp || '');
  const name = r => (r.project_name || r.project_slug || '').toLowerCase();
  const copy = rows.slice();
  if (ui.sort === 'recent') copy.sort((a, b) => when(b).localeCompare(when(a)));
  else if (ui.sort === 'oldest') copy.sort((a, b) => when(a).localeCompare(when(b)));
  else if (ui.sort === 'project') copy.sort((a, b) => name(a).localeCompare(name(b)) || (b[view.col] || 0) - (a[view.col] || 0));
  else copy.sort((a, b) => (b[view.col] || 0) - (a[view.col] || 0));
  return copy;
}

async function draw() {
  const view = VIEWS.find(v => v.key === ui.of) || VIEWS[0];

  const shell = (amount, body) => {
    const node = overlayShell({
      title: view.title,
      amount,
      amountClass: view.plain ? 'plain' : '',
      controls: seg(VIEWS.map(v => ({ key: v.key, label: v.tab })), view.key, 'view'),
      body,
    });
    $$('[data-view]', node).forEach(b => b.addEventListener('click', () => {
      ui = { of: b.dataset.view, list: ui.list, sort: ui.sort, showAll: false };
      draw();
    }));
    return node;
  };

  if (!cache[view.key]) {
    shell('', '<div class="empty">Loading…</div>');
    try {
      cache[view.key] = await api('/api/savings/breakdown?of=' + encodeURIComponent(view.key));
    } catch {
      return shell('', '<div class="empty">Couldn\'t load that breakdown.</div>');
    }
    if (ui.of !== view.key) return;   // switched while loading
  }

  const d = cache[view.key];
  const total = ui.list === 'sessions' ? d.session_total : d.prompt_total;
  const rows = sortRows(ui.list === 'sessions' ? d.sessions : d.prompts, view);
  const top = rows.slice(0, TOP_N);
  const topSum = top.reduce((a, r) => a + (r[view.col] || 0), 0);
  const share = total ? Math.round(100 * topSum / total) : 0;

  shell(fmt.usd(total), `
    <p class="card-note" style="margin:0 0 14px">${h(view.lead)}</p>

    <div class="list-meta" style="margin-bottom:12px">
      ${seg([{ key: 'sessions', label: 'Sessions' }, { key: 'prompts', label: 'Prompts' }], ui.list, 'list')}
      ${seg(SORTS, ui.sort, 'sort')}
      <span class="spacer"></span>
      <span>${fmt.int(rows.length)} ${ui.list}</span>
    </div>

    <p class="lede" style="font-size:13.5px;margin:0 0 12px">
      ${ui.sort === 'amount'
        ? `The top ${top.length} account for <b>${fmt.usd(topSum)}</b> of ${fmt.usd(total)} — <b>${share}%</b>.`
        : `Showing ${top.length} of ${fmt.int(rows.length)}, ${
            ui.sort === 'project' ? 'grouped by project' : ui.sort === 'recent' ? 'newest first' : 'oldest first'
          }.`}
    </p>

    ${ui.showAll ? '' : `<div>${bars(top, view)}</div>`}

    <div class="list-meta" style="margin-top:12px">
      <span class="spacer"></span>
      <button class="ghost" data-toggle-all>${
        ui.showAll ? '← back to the ranked list' : `show all ${fmt.int(rows.length)} as a sortable table`}</button>
    </div>
    ${ui.showAll ? '<div class="table-scroll" id="sv-table"></div>' : ''}
  `);

  $$('[data-list]', document).forEach(b => b.addEventListener('click', () => {
    ui.list = b.dataset.list; ui.showAll = false; draw();
  }));
  $$('[data-sort]', document).forEach(b => b.addEventListener('click', () => {
    ui.sort = b.dataset.sort; draw();
  }));
  $('[data-toggle-all]', document).addEventListener('click', () => {
    ui.showAll = !ui.showAll; draw();
  });

  if (ui.showAll) {
    sortable($('#sv-table', document),
             ui.list === 'sessions' ? sessionCols(view, rows) : promptCols(view, rows),
             rows, view.col);
  }
}

/** Ranked bars, same pattern as "Where it went" on the Overview. A proportional
 *  bar answers "how much of the total is this" without arithmetic; a column of
 *  dollar figures does not. */
function bars(rows, view) {
  if (!rows.length) return '<div class="empty">nothing here yet</div>';
  const max = Math.max(...rows.map(r => r[view.col] || 0), 0.0001);
  const projLabel = projectLabeller(rows);
  return rows.map(r => {
    const value = r[view.col] || 0;
    const isPrompt = r.prompt_text !== undefined;
    const label = isPrompt ? fmt.short(r.prompt_text, 76) : projLabel(r);
    return `<a class="bar-row" href="#/sessions/${encodeURIComponent(r.session_id)}"
               title="${h(r.prompt_text || r.project_name || r.project_slug)}">
      <span class="bar-name blur-sensitive">${h(label)}
        <span class="muted mono" style="font-size:11px">${h(fmt.ts(r.started || r.timestamp))}</span></span>
      <span class="bar-val">${fmt.usd(value)}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${Math.max(2, 100 * value / max)}%"></span></span>
    </a>`;
  }).join('');
}

const projectCol = (rows) => {
  const label = projectLabeller(rows || []);
  return {
    key: 'project', label: 'project',
    value: r => label(r).toLowerCase(),
    cls: 'blur-sensitive',
    render: r => `<a href="#/sessions/${encodeURIComponent(r.session_id)}">${h(label(r))}</a>`,
  };
};

const sessionCols = (view, rows) => [
  { key: 'started', label: 'started', cls: 'mono', value: r => r.started || '', render: r => fmt.ts(r.started) },
  projectCol(rows),
  { key: 'tokens', label: 'billable', num: true, value: r => r.billable_tokens || 0, render: r => fmt.compact(r.billable_tokens) },
  { key: 'cost_usd', label: 'cost', num: true, value: r => r.cost_usd || 0, render: r => fmt.usd(r.cost_usd) },
  { key: 'cache_saved_usd', label: 'saved', num: true, value: r => r.cache_saved_usd || 0, render: r => fmt.usd(r.cache_saved_usd) },
];

const promptCols = (view, rows) => [
  { key: 'prompt', label: 'prompt', cls: 'blur-sensitive',
    value: r => (r.prompt_text || '').toLowerCase(),
    render: r => `<span title="${h(r.prompt_text)}">${h(fmt.short(r.prompt_text, 70))}</span>` },
  projectCol(rows),
  { key: 'model', label: 'model', value: r => (r.models || []).join(),
    render: r => (r.models || []).slice(0, 2).map(m =>
      `<span class="badge ${fmt.modelClass(m)}">${h(fmt.modelShort(m))}</span>`).join(' ') },
  { key: 'turns', label: 'turns', num: true, value: r => r.turns || 0, render: r => fmt.int(r.turns) },
  { key: 'when', label: 'when', cls: 'mono', value: r => r.timestamp || '', render: r => fmt.ts(r.timestamp) },
  { key: 'cost_usd', label: 'cost', num: true, value: r => r.cost_usd || 0, render: r => fmt.usd(r.cost_usd) },
  { key: 'cache_saved_usd', label: 'saved', num: true, value: r => r.cache_saved_usd || 0, render: r => fmt.usd(r.cache_saved_usd) },
];

function cacheCard(s) {
  const c = s.cache;
  return `
    <div class="section">
      <h3>Where the caching saving comes from ${tip(TIPS.caching)}</h3>
      <p class="muted" style="margin:0 0 12px">
        ${fmt.compact(c.read_tokens)} tokens were re-read from cache instead of being paid for in full.
      </p>
      <div class="table-wrap"><table>
        <tbody>
          <tr>
            <td>If none of it had been cached</td>
            <td class="num">${fmt.usd(s.spend.without_caching_usd)}</td>
          </tr>
          <tr>
            <td>Cheaper because it was cached</td>
            <td class="num good">− ${fmt.usd(c.gross_saved_usd)}</td>
          </tr>
          <tr>
            <td>Extra you paid to put things in the cache ${tip(TIPS.writePremium)}</td>
            <td class="num bad">+ ${fmt.usd(c.write_premium_usd)}</td>
          </tr>
          <tr class="total">
            <td><b>What you actually used</b></td>
            <td class="num"><b>${fmt.usd(s.spend.total_usd)}</b></td>
          </tr>
        </tbody>
      </table></div>
      <p class="muted" style="margin-top:10px">
        <b>${c.hit_rate_pct}% of everything Claude read came from cache.</b> ${tip(TIPS.hitRate)}
        ${c.hit_rate_pct >= 90
          ? 'That is about as good as it gets — long sessions and a stable CLAUDE.md.'
          : c.hit_rate_pct >= 70
            ? 'Reasonable. Longer sessions would push it higher.'
            : 'Low — something early in your prompt is probably changing and throwing the cache away.'}
      </p>
    </div>`;
}

function changeCard(s) {
  const rows = s.change_points;
  if (!rows.length) {
    return `<div class="section"><h3>Things that changed</h3>
      <p class="muted">Nothing has dropped sharply enough to flag yet. This needs a couple of weeks either side of a change to spot one.</p></div>`;
  }
  const named = rows.filter(r => r.label).length;
  return `
    <div class="section">
      <h3>Things that changed — what did you do? ${tip(TIPS.changePoints)}</h3>
      <p class="muted" style="margin:0 0 12px">
        On each of these days, something dropped and stayed down. We can see the drop but not the cause —
        write in what you changed and it'll be remembered.
        ${named ? `<b>${named} of ${rows.length} named so far.</b>` : ''}
      </p>
      <div class="table-wrap"><table>
        <thead><tr>
          <th>day</th><th>what dropped</th><th class="num">how much</th>
          <th class="num">worth</th><th>what did you change?</th>
        </tr></thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td class="nowrap">${h(r.date)}</td>
              <td class="blur-sensitive">${h(fmt.short(fmt.tildePath(r.metric), 58))}
                <div class="muted" style="font-size:11px">
                  ${fmt.int(Math.round(r.before_per_day))} → ${fmt.int(Math.round(r.after_per_day))} a day
                </div>
              </td>
              <td class="num good nowrap">${r.drop_pct >= 99 ? 'stopped' : `down ${Math.round(r.drop_pct)}%`}</td>
              <td class="num nowrap">${
                r.saved_usd_per_week != null
                  ? `<b class="good">${fmt.usd(r.saved_usd_per_week)}</b><div class="muted" style="font-size:11px">a week</div>`
                  : `<span class="muted">—</span>`
              }</td>
              <td>
                <input class="label-in" data-key="${h(r.key)}" value="${h(r.label || '')}"
                       placeholder="e.g. split up CLAUDE.md" maxlength="200">
              </td>
            </tr>`).join('')}
        </tbody>
      </table></div>
      <p class="muted" style="margin-top:8px;font-size:11px">
        A weekly dollar figure appears only where the thing that dropped is measured in tokens.
        Counts of file reads don't get one — the tokens a read costs aren't recorded against it,
        so any dollar figure there would be made up.
      </p>
    </div>`;
}

function wasteCard(s) {
  const w = s.waste;
  const items = w.items.filter(i => i.peak_per_week > 0);
  if (!items.length) return '';
  return `
    <div class="section">
      <h3>Habits that cost tokens ${tip(TIPS.waste)}</h3>
      <p class="muted" style="margin:0 0 12px">
        Where you are now, against the worst week you've ever had.
      </p>
      <div class="table-wrap"><table>
        <thead><tr><th>habit</th><th class="num">at your worst</th><th class="num">this week</th><th class="num">change</th><th class="num">worth</th></tr></thead>
        <tbody>
          ${items.map(i => `
            <tr>
              <td>${h(i.label)}<div class="muted" style="font-size:11px">${h(i.note)}</div></td>
              <td class="num">${fmt.compact(i.peak_per_week)} <span class="muted">${h(i.unit)}</span></td>
              <td class="num">${fmt.compact(i.current_per_week)}</td>
              <td class="num ${i.reduction_pct ? 'good' : 'muted'}">
                ${i.reduction_pct == null ? '—' : i.reduction_pct > 0 ? `down ${Math.round(i.reduction_pct)}%` : 'no change'}
              </td>
              <td class="num">${
                i.saved_usd_per_week
                  ? `<b class="good">${fmt.usd(i.saved_usd_per_week)}</b><div class="muted" style="font-size:11px">a week</div>`
                  : '<span class="muted">—</span>'
              }</td>
            </tr>`).join('')}
        </tbody>
      </table></div>
    </div>`;
}

function efficiencyCard(s) {
  const e = s.efficiency;
  const pts = e.series.filter(p => p.tokens_per_turn);
  if (pts.length < 2) return '';
  const peak = Math.max(...pts.map(p => p.tokens_per_turn), 1);
  const better = e.change_pct < 0;
  return `
    <div class="section">
      <h3>What one prompt costs you ${tip(TIPS.perTurn)}</h3>
      <p class="lede" style="font-size:14px">
        One prompt went from <b>${fmt.int(e.first_tokens_per_turn)}</b> tokens to
        <b>${fmt.int(e.latest_tokens_per_turn)}</b> —
        <b class="${better ? 'good' : ''}">${better ? 'down' : 'up'} ${Math.abs(e.change_pct)}%</b>.
        ${better
          ? 'Each prompt is doing the same work for fewer tokens.'
          : 'Each prompt is doing more — longer runs, more tool calls. Not a problem in itself, but worth a look if you didn\'t mean to ask for more.'}
      </p>
      <div class="bars">
        ${pts.map(p => `
          <div class="bar-col" data-tip="Week of ${h(p.starting)}\n${fmt.int(p.tokens_per_turn)} tokens per turn, over ${fmt.int(p.turns)} turns">
            <span class="bar-fill" style="height:${Math.max(2, 100 * p.tokens_per_turn / peak)}%"></span>
            <span class="bar-lab">${h((p.starting || '').slice(5))}</span>
          </div>`).join('')}
      </div>
    </div>`;
}

function projectionCard(s) {
  const p = s.projection;
  if (!p.last_7d_usd) return '';
  return `
    <div class="section">
      <h3>If nothing changes <span class="badge warn">guess</span> ${tip(TIPS.forecast)}</h3>
      <p class="lede" style="font-size:14px">
        You used <b>${fmt.usd(p.last_7d_usd)}</b> last week. At that pace it's
        <b>${fmt.usd(p.annual_run_rate_usd)}</b> a year — and your habit changes are keeping
        <b class="good">${fmt.usd(p.annual_avoided_usd)}</b> of that off the total.
      </p>
      <p class="muted" style="margin:0;font-size:11px">
        Left out of the figures at the top of the page, because it hasn't happened.
      </p>
    </div>`;
}

function codexCard(s) {
  const c = s.codex;
  if (!c.sessions) return '';
  const cachedPct = (c.input_tokens + c.cache_read_tokens)
    ? Math.round(100 * c.cache_read_tokens / (c.input_tokens + c.cache_read_tokens))
    : 0;
  return `
    <div class="section">
      <h3>Codex ${tip(TIPS.codex)}</h3>
      <p class="lede" style="font-size:14px">
        <b>${fmt.int(c.sessions)}</b> Codex runs used <b>${fmt.usd(c.cost_usd)}</b> —
        ${((100 * c.cost_usd) / (s.spend.total_usd || 1)).toFixed(1)}% of your total.
      </p>
      <div class="table-wrap"><table>
        <tbody>
          <tr><td>Model</td><td class="num">${c.models.map(m => `<span class="badge ${fmt.modelClass(m)}">${h(m)}</span>`).join(' ')}</td></tr>
          <tr><td>Text it read</td><td class="num">${fmt.compact(c.input_tokens + c.cache_read_tokens)} <span class="muted">(${cachedPct}% cached)</span></td></tr>
          <tr><td>Text it wrote</td><td class="num">${fmt.compact(c.output_tokens)} <span class="muted">incl. ${fmt.compact(c.reasoning_tokens)} thinking</span></td></tr>
        </tbody>
      </table></div>
    </div>`;
}

function unpricedCard(s) {
  const u = s.spend.unpriced_models;
  if (!u.length) return '';
  return `
    <div class="section">
      <h3><span class="badge bad">missing</span> Models with no price ${tip(TIPS.gap)}</h3>
      <p class="muted" style="margin:0 0 12px">
        Their tokens are left out of every figure on this page. Add them to <code>pricing.json</code> and restart.
      </p>
      <div class="table-wrap"><table>
        <thead><tr><th>model</th><th class="num">tokens</th></tr></thead>
        <tbody>${u.map(m => `<tr><td>${h(m.model)}</td><td class="num">${fmt.int(m.billable_tokens)}</td></tr>`).join('')}</tbody>
      </table></div>
    </div>`;
}

function wireLabels(root) {
  $$('.label-in', root).forEach(input => {
    let last = input.value;
    const save = async () => {
      if (input.value === last) return;
      last = input.value;
      input.classList.add('saving');
      try {
        await fetch('/api/savings/label', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: input.dataset.key, label: input.value }),
        });
        input.classList.remove('saving');
        input.classList.add('saved');
        setTimeout(() => input.classList.remove('saved'), 1200);
      } catch {
        input.classList.remove('saving');
      }
    };
    input.addEventListener('blur', save);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); });
  });
}
