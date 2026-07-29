import { api, fmt, state, $ } from '/web/app.js';

const esc = s => fmt.htmlSafe(s);

// Rows are ordered cheapest-tier-last so the table reads like a price list, and
// the `_`-prefixed keys in pricing.json are provenance notes, not models.
const TIER_ORDER = ['fable', 'opus', 'sonnet', 'haiku', 'gpt'];

export default async function (root) {
  const cur = await api('/api/plan');
  const plans = Object.entries(cur.pricing.plans);
  const models = Object.entries(cur.pricing.models)
    .sort((a, b) => (TIER_ORDER.indexOf(a[1].tier) - TIER_ORDER.indexOf(b[1].tier))
                    || b[1].input - a[1].input
                    || a[0].localeCompare(b[0]));
  const notes = Object.entries(cur.pricing)
    .filter(([k, v]) => k.startsWith('_') && typeof v === 'string')
    .map(([, v]) => v);
  root.innerHTML = `
    <div class="card">
      <h2>Settings</h2>
      <h3 style="margin-top:16px">Plan</h3>
      <p class="muted" style="margin:0 0 12px">Sets how cost is displayed. API mode shows pay-per-token rates. Subscription modes show what you actually pay each month.</p>
      <div class="flex">
        <select id="plan">
          ${plans.map(([k,v]) => `<option value="${k}" ${k===cur.plan?'selected':''}>${v.label}${v.monthly?` — $${v.monthly}/mo`:''}</option>`).join('')}
        </select>
        <button class="primary" id="save">Save</button>
        <span id="msg" class="muted"></span>
      </div>

      <hr class="divider">

      <h3>Pricing table</h3>
      <p class="muted" style="margin:0 0 12px">
        Edit <code>pricing.json</code> in the project root to change rates.
        <b>The server reads it once at startup</b> — restart the dashboard after editing, not just reload the page.
      </p>
      ${notes.map(n => `<p class="muted" style="margin:0 0 8px;font-size:11px">${esc(n)}</p>`).join('')}
      <table>
        <thead><tr><th>model</th><th>tier</th><th class="num">input</th><th class="num">output</th><th class="num">cache read</th><th class="num">cache 5m</th><th class="num">cache 1h</th></tr></thead>
        <tbody>
          ${models.map(([k,v]) => `
            <tr><td><span class="badge ${v.tier}">${esc(k)}</span></td>
              <td class="muted">${esc(v.tier)}</td>
              <td class="num">$${v.input.toFixed(2)}</td>
              <td class="num">$${v.output.toFixed(2)}</td>
              <td class="num">$${v.cache_read.toFixed(2)}</td>
              <td class="num">$${v.cache_create_5m.toFixed(2)}</td>
              <td class="num">$${v.cache_create_1h.toFixed(2)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
      <p class="muted" style="margin-top:8px;font-size:11px">
        Rates per 1M tokens, USD. ${models.length} models priced.
        Anthropic bills cache reads at a tenth of input and cache writes at a premium
        (1.25× for the 5-minute TTL, 2× for the hour); OpenAI charges nothing to write cache,
        which is why the gpt rows are zero there.
      </p>

      <h3 style="margin-top:20px">Tier fallbacks</h3>
      <p class="muted" style="margin:0 0 12px">
        Used when a model has no exact row above — a model released after this table was written
        still gets costed, and is flagged as an estimate rather than dropped.
      </p>
      <table>
        <thead><tr><th>tier</th><th class="num">input</th><th class="num">output</th><th class="num">cache read</th></tr></thead>
        <tbody>
          ${Object.entries(cur.pricing.tier_fallback).map(([k,v]) => `
            <tr><td><span class="badge ${k}">${esc(k)}</span></td>
              <td class="num">$${v.input.toFixed(2)}</td>
              <td class="num">$${v.output.toFixed(2)}</td>
              <td class="num">$${v.cache_read.toFixed(2)}</td>
            </tr>`).join('')}
        </tbody>
      </table>

      <hr class="divider">

      <h3>Privacy</h3>
      <p class="muted">Press <code>Cmd/Ctrl + B</code> anywhere to blur prompt text and other sensitive content for screenshots.</p>
    </div>`;

  $('#save').addEventListener('click', async () => {
    const plan = $('#plan').value;
    await fetch('/api/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan }) });
    state.plan = plan;
    document.getElementById('plan-pill').textContent = plan;
    $('#msg').textContent = 'Saved.';
    $('#msg').style.color = 'var(--good)';
  });
}
