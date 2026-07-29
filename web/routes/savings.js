import { api, fmt, $, $$ } from '/web/app.js';

// Savings — what the optimizations were worth, kept honest about which figures
// are arithmetic and which are attributed. Every dollar on this page carries an
// ⓘ explaining how it was computed; the text comes from the API's `basis`
// fields so the explanation can't drift from the maths.

const h = fmt.htmlSafe;

/** An ⓘ that explains a number. Native title= so it works without any JS. */
const why = txt => txt
  ? `<span class="why" tabindex="0" title="${h(txt)}" aria-label="How this was computed: ${h(txt)}">ⓘ</span>`
  : '';

const tile = (label, value, cls, basis) => `
  <div class="card tile">
    <div class="tile-label">${h(label)} ${why(basis)}</div>
    <div class="tile-value ${cls || ''}">${value}</div>
  </div>`;

export default async function (root) {
  const s = await api('/api/savings');
  const noHistory = !s.history.first_day;

  root.innerHTML = `
    <div class="card">
      <h2>Savings</h2>
      <p class="muted" style="margin:0">
        ${noHistory ? 'No history scanned yet.' : `
          ${h(s.history.first_day)} → ${h(s.history.last_day)}
          · ${s.history.weeks} weeks
          · $${fmt.int(Math.round(s.spend.total_usd))} spent
          (Claude ${fmt.usd(s.spend.claude_usd)} + Codex ${fmt.usd(s.spend.codex_usd)})`}
      </p>
    </div>

    <div class="grid-3" style="margin-top:16px">
      ${tile('Saved — exact', fmt.usd(s.headline.exact_usd), 'good', s.cache.basis)}
      ${tile('Saved — attributed', fmt.usd(s.headline.attributed_usd), '', s.waste.basis)}
      ${tile('Total saved so far', fmt.usd(s.headline.total_usd), 'good', s.headline.basis)}
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
      <h3>Prompt caching ${why(c.basis)}</h3>
      <p class="muted" style="margin:0 0 12px">
        The single biggest lever, and the only savings figure here that needs no assumptions.
      </p>
      <table>
        <tbody>
          <tr><td>Tokens served from cache</td><td class="num">${fmt.int(c.read_tokens)}</td></tr>
          <tr><td>Tokens written to cache</td><td class="num">${fmt.int(c.write_tokens)}</td></tr>
          <tr><td>Cache hit rate</td><td class="num">${c.hit_rate_pct == null ? '—' : c.hit_rate_pct + '%'}</td></tr>
          <tr><td>Saved on reads (vs full input price)</td><td class="num good">${fmt.usd(c.gross_saved_usd)}</td></tr>
          <tr><td>Paid as write premium</td><td class="num bad">−${fmt.usd(c.write_premium_usd).slice(1)}</td></tr>
          <tr class="total"><td><b>Net saved by caching</b></td><td class="num good"><b>${fmt.usd(c.net_saved_usd)}</b></td></tr>
        </tbody>
      </table>
    </div>`;
}

function changeCard(s) {
  const rows = s.change_points;
  if (!rows.length) {
    return `<div class="card" style="margin-top:16px"><h3>Detected changes</h3>
      <p class="muted">Nothing stepped down sharply enough to flag yet. Needs a couple of weeks either side of a change.</p></div>`;
  }
  return `
    <div class="card" style="margin-top:16px">
      <h3>Detected changes — name the ones you recognise</h3>
      <p class="muted" style="margin:0 0 12px">
        These are days a metric fell and stayed down. The dashboard can see the drop;
        only you know what you changed. Label one and it sticks.
      </p>
      <table>
        <thead><tr>
          <th>when</th><th>what moved</th><th class="num">before → after</th>
          <th class="num">drop</th><th class="num">per week</th><th>your label</th>
        </tr></thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td>${h(r.date)}</td>
              <td class="sensitive">${h(fmt.short(fmt.tildePath(r.metric), 64))}</td>
              <td class="num">${fmt.int(Math.round(r.before_per_day))} → ${fmt.int(Math.round(r.after_per_day))} <span class="muted">/day</span></td>
              <td class="num good">−${r.drop_pct}%</td>
              <td class="num">${
                r.saved_usd_per_week != null
                  ? `<b class="good">${fmt.usd(r.saved_usd_per_week)}</b>`
                  : r.saved_per_week != null
                    ? `${fmt.int(Math.round(r.saved_per_week))} <span class="muted">${h(r.unit)}</span>`
                    : `<span class="muted">rate</span>`
              }</td>
              <td>
                <input class="label-in" data-key="${h(r.key)}" value="${h(r.label || '')}"
                       placeholder="what did you change?" maxlength="200">
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
      <p class="muted" style="margin-top:8px;font-size:11px">
        A per-week dollar figure appears only where the metric is a token count. Call counts and
        per-turn rates are shown in their own units rather than guessed into dollars.
      </p>
    </div>`;
}

function wasteCard(s) {
  const w = s.waste;
  if (!w.items.length) return '';
  return `
    <div class="card" style="margin-top:16px">
      <h3>Waste avoided, against your own worst week ${why(w.basis)}</h3>
      <table>
        <thead><tr><th>pattern</th><th class="num">worst 7d</th><th class="num">last 7d</th><th class="num">down</th><th class="num">$/week</th></tr></thead>
        <tbody>
          ${w.items.map(i => `
            <tr>
              <td>${h(i.label)}<div class="muted" style="font-size:11px">${h(i.note)}</div></td>
              <td class="num">${fmt.int(i.peak_per_week)} <span class="muted">${h(i.unit)}</span></td>
              <td class="num">${fmt.int(i.current_per_week)}</td>
              <td class="num ${i.reduction_pct ? 'good' : 'muted'}">${i.reduction_pct == null ? '—' : '−' + i.reduction_pct + '%'}</td>
              <td class="num">${i.saved_usd_per_week == null ? '<span class="muted">not priced</span>' : `<b class="good">${fmt.usd(i.saved_usd_per_week)}</b>`}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

function efficiencyCard(s) {
  const e = s.efficiency;
  if (!e.series.length) return '';
  const pts = e.series.filter(p => p.tokens_per_turn);
  const peak = Math.max(...pts.map(p => p.tokens_per_turn), 1);
  return `
    <div class="card" style="margin-top:16px">
      <h3>Tokens per turn, by week ${why('Billable tokens (input + output + cache writes) divided by user turns. A rate, so it is never summed into a dollar total — it says whether the work got leaner, independently of how much of it you did.')}</h3>
      <p class="muted" style="margin:0 0 12px">
        ${e.first_tokens_per_turn == null ? '—' : `
          ${fmt.int(e.first_tokens_per_turn)} → ${fmt.int(e.latest_tokens_per_turn)} tokens/turn
          <b class="${e.change_pct < 0 ? 'good' : 'bad'}">${e.change_pct > 0 ? '+' : ''}${e.change_pct}%</b>`}
      </p>
      <div class="bars">
        ${pts.map(p => `
          <div class="bar-col" title="${h(p.week)} (from ${h(p.starting)}) — ${fmt.int(p.tokens_per_turn)} tokens/turn over ${fmt.int(p.turns)} turns">
            <span class="bar-fill" style="height:${Math.max(2, 100 * p.tokens_per_turn / peak)}%"></span>
            <span class="bar-lab">${h((p.starting || '').slice(5))}</span>
          </div>`).join('')}
      </div>
    </div>`;
}

function projectionCard(s) {
  const p = s.projection;
  return `
    <div class="card" style="margin-top:16px">
      <h3>Run-rate <span class="badge warn">forecast</span> ${why(p.basis)}</h3>
      <table>
        <tbody>
          <tr><td>Last 7 days</td><td class="num">${fmt.usd(p.last_7d_usd)}</td></tr>
          <tr><td>Annualised at that rate</td><td class="num">${fmt.usd(p.annual_run_rate_usd)}</td></tr>
          <tr><td>Annualised if you were still at your worst week</td><td class="num bad">${fmt.usd(p.annual_at_peak_usd)}</td></tr>
          <tr class="total"><td><b>Avoided per year, at current habits</b></td><td class="num good"><b>${fmt.usd(p.annual_avoided_usd)}</b></td></tr>
        </tbody>
      </table>
      <p class="muted" style="margin-top:8px;font-size:11px">Excluded from the totals at the top — it hasn't happened.</p>
    </div>`;
}

function codexCard(s) {
  const c = s.codex;
  if (!c.sessions) return '';
  return `
    <div class="card" style="margin-top:16px">
      <h3>Codex ${why('Read from ~/.codex/sessions rollout logs, not from Claude Code transcripts — Claude only records that the codex command ran, never what it spent. Priced at OpenAI rates: uncached input, cached input, and output each at their own rate.')}</h3>
      <p class="muted" style="margin:0 0 12px">
        What <code>/grill-me-codex</code> and friends spent outside Claude Code.
      </p>
      <table>
        <tbody>
          <tr><td>Sessions</td><td class="num">${fmt.int(c.sessions)} <span class="muted">over ${fmt.int(c.turns)} turns</span></td></tr>
          <tr><td>Models</td><td class="num">${c.models.map(m => `<span class="badge ${fmt.modelClass(m)}">${h(m)}</span>`).join(' ')}</td></tr>
          <tr><td>Input (uncached / cached)</td><td class="num">${fmt.int(c.input_tokens)} / ${fmt.int(c.cache_read_tokens)}</td></tr>
          <tr><td>Output <span class="muted">incl. ${fmt.int(c.reasoning_tokens)} reasoning</span></td><td class="num">${fmt.int(c.output_tokens)}</td></tr>
          <tr class="total"><td><b>API-equivalent cost</b></td><td class="num"><b>${fmt.usd(c.cost_usd)}</b></td></tr>
        </tbody>
      </table>
      <p class="muted" style="margin-top:8px;font-size:11px">
        API-equivalent: if your Codex runs go through a ChatGPT subscription, this is what the
        same tokens would have cost on the API, not money you were charged.
      </p>
    </div>`;
}

function unpricedCard(s) {
  const u = s.spend.unpriced_models;
  if (!u.length) return '';
  return `
    <div class="card" style="margin-top:16px">
      <h3><span class="badge bad">gap</span> Models with no price</h3>
      <p class="muted" style="margin:0 0 12px">
        These tokens are missing from every total on this page. Add them to <code>pricing.json</code>.
      </p>
      <table>
        <thead><tr><th>model</th><th class="num">billable tokens</th></tr></thead>
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
