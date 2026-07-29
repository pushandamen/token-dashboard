import { api, fmt, tip, $, $$ } from '/web/app.js';

// Savings — written to be read by someone who has not thought about token
// pricing before. Every number gets a plain sentence next to it, and an ⓘ that
// says what it means for your usage and what to do about it. The ⓘ is a real
// tooltip (hover, focus, or tap), not a native title= — those take a second to
// appear, can't be clicked, and collapse line breaks.

const h = fmt.htmlSafe;

const tile = (label, value, sub, cls, tipText) => `
  <div class="card tile">
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

  yourChanges: `Everything above is what caching does for you automatically. This is the part you caused.

It compares what you're doing now against your own worst week — huge tool results, context being rebuilt over and over — and prices the gap.

It assumes you'd still be at your worst if you'd changed nothing, so read it as a fair estimate, not a fact.`,

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

  perTurn: `Roughly what one turn costs you, averaged over the week.

Falling means the work itself got leaner — shorter context, fewer wasted reads — regardless of how much you did.

It's a rate, so it never gets added into a dollar total. A quiet week and an efficient week look identical in a total; they look different here.`,

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
    root.innerHTML = `<div class="card"><h2>Savings</h2>
      <p class="muted">Nothing scanned yet. Run <code>python3 cli.py scan</code> first.</p></div>`;
    return;
  }

  root.innerHTML = `
    <div class="card">
      <h2>Savings</h2>
      <p class="lede">
        Over the last <b>${s.history.weeks} weeks</b> your tokens were worth
        <b>${fmt.usd(s.spend.total_usd)}</b>.
        Without caching, the same work would have cost
        <b>${fmt.usd(s.spend.without_caching_usd)}</b> —
        so you paid about <b>${s.spend.discount_pct}% less</b> than the sticker price.
      </p>
    </div>

    <div class="grid-3" style="margin-top:16px">
      ${tile('What you used', fmt.usd(s.spend.total_usd),
             `Claude ${fmt.usd(s.spend.claude_usd)} + Codex ${fmt.usd(s.spend.codex_usd)}`,
             '', TIPS.spent)}
      ${tile('Saved by caching', fmt.usd(s.headline.exact_usd),
             'Automatic. Exact figure.', 'good', TIPS.caching)}
      ${tile('Saved by your changes', fmt.usd(s.headline.attributed_usd),
             'Your doing. Best estimate.', 'good', TIPS.yourChanges)}
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
}

function cacheCard(s) {
  const c = s.cache;
  return `
    <div class="card" style="margin-top:16px">
      <h3>Where the caching saving comes from ${tip(TIPS.caching)}</h3>
      <p class="muted" style="margin:0 0 12px">
        ${fmt.compact(c.read_tokens)} tokens were re-read from cache instead of being paid for in full.
      </p>
      <table>
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
      </table>
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
    return `<div class="card" style="margin-top:16px"><h3>Things that changed</h3>
      <p class="muted">Nothing has dropped sharply enough to flag yet. This needs a couple of weeks either side of a change to spot one.</p></div>`;
  }
  const named = rows.filter(r => r.label).length;
  return `
    <div class="card" style="margin-top:16px">
      <h3>Things that changed — what did you do? ${tip(TIPS.changePoints)}</h3>
      <p class="muted" style="margin:0 0 12px">
        On each of these days, something dropped and stayed down. We can see the drop but not the cause —
        write in what you changed and it'll be remembered.
        ${named ? `<b>${named} of ${rows.length} named so far.</b>` : ''}
      </p>
      <table>
        <thead><tr>
          <th>day</th><th>what dropped</th><th class="num">how much</th>
          <th class="num">worth</th><th>what did you change?</th>
        </tr></thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td class="nowrap">${h(r.date)}</td>
              <td class="sensitive">${h(fmt.short(fmt.tildePath(r.metric), 58))}
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
      </table>
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
    <div class="card" style="margin-top:16px">
      <h3>Habits that cost tokens ${tip(TIPS.waste)}</h3>
      <p class="muted" style="margin:0 0 12px">
        Where you are now, against the worst week you've ever had.
      </p>
      <table>
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
      </table>
    </div>`;
}

function efficiencyCard(s) {
  const e = s.efficiency;
  const pts = e.series.filter(p => p.tokens_per_turn);
  if (pts.length < 2) return '';
  const peak = Math.max(...pts.map(p => p.tokens_per_turn), 1);
  const better = e.change_pct < 0;
  return `
    <div class="card" style="margin-top:16px">
      <h3>What one turn costs you ${tip(TIPS.perTurn)}</h3>
      <p class="lede" style="font-size:14px">
        An average turn went from <b>${fmt.int(e.first_tokens_per_turn)}</b> tokens to
        <b>${fmt.int(e.latest_tokens_per_turn)}</b> —
        <b class="${better ? 'good' : 'bad'}">${better ? 'down' : 'up'} ${Math.abs(e.change_pct)}%</b>.
        ${better ? 'The work itself got leaner.' : 'Turns are getting heavier — worth a look at what changed.'}
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
    <div class="card" style="margin-top:16px">
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
    <div class="card" style="margin-top:16px">
      <h3>Codex ${tip(TIPS.codex)}</h3>
      <p class="lede" style="font-size:14px">
        <b>${fmt.int(c.sessions)}</b> Codex runs used <b>${fmt.usd(c.cost_usd)}</b> —
        ${((100 * c.cost_usd) / (s.spend.total_usd || 1)).toFixed(1)}% of your total.
      </p>
      <table>
        <tbody>
          <tr><td>Model</td><td class="num">${c.models.map(m => `<span class="badge ${fmt.modelClass(m)}">${h(m)}</span>`).join(' ')}</td></tr>
          <tr><td>Text it read</td><td class="num">${fmt.compact(c.input_tokens + c.cache_read_tokens)} <span class="muted">(${cachedPct}% cached)</span></td></tr>
          <tr><td>Text it wrote</td><td class="num">${fmt.compact(c.output_tokens)} <span class="muted">incl. ${fmt.compact(c.reasoning_tokens)} thinking</span></td></tr>
        </tbody>
      </table>
    </div>`;
}

function unpricedCard(s) {
  const u = s.spend.unpriced_models;
  if (!u.length) return '';
  return `
    <div class="card" style="margin-top:16px">
      <h3><span class="badge bad">missing</span> Models with no price ${tip(TIPS.gap)}</h3>
      <p class="muted" style="margin:0 0 12px">
        Their tokens are left out of every figure on this page. Add them to <code>pricing.json</code> and restart.
      </p>
      <table>
        <thead><tr><th>model</th><th class="num">tokens</th></tr></thead>
        <tbody>${u.map(m => `<tr><td>${h(m.model)}</td><td class="num">${fmt.int(m.billable_tokens)}</td></tr>`).join('')}</tbody>
      </table>
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
