import { api, fmt, state, $ } from '/web/app.js';

const h = fmt.htmlSafe;

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
    <div class="pagehead">
      <h2>Settings</h2>
      <span class="spacer"></span>
      <a href="#/overview">← back to Overview</a>
    </div>

    <div class="section tight">
      <div class="section-head"><h3>How you pay</h3></div>
      <p class="card-note">
        Sets how cost is displayed. API mode shows pay-per-token rates; subscription
        modes also show what you actually pay each month.
      </p>
      <div class="flex">
        <select id="plan">
          ${plans.map(([k, v]) => `<option value="${k}" ${k === cur.plan ? 'selected' : ''}>${h(v.label)}${v.monthly ? ` — $${v.monthly}/mo` : ''}</option>`).join('')}
        </select>
        <button class="primary" id="save">Save</button>
        <span id="msg" class="muted"></span>
      </div>
    </div>

    <div class="section">
      <div class="section-head">
        <h3>Pricing table</h3>
        <span class="spacer"></span>
        <span class="badge">${models.length} models</span>
      </div>
      <p class="card-note">
        Edit <code>pricing.json</code> in the project root to change rates.
        <b>The server reads it once at startup</b> — restart Token Meter after editing,
        not just reload the page.
      </p>
      ${notes.map(n => `<p class="card-note">${h(n)}</p>`).join('')}
      <div class="table-wrap">
        <table class="pricing">
          <thead><tr>
            <th>model</th><th>tier</th>
            <th class="num">input</th><th class="num">output</th>
            <th class="num">cache read</th><th class="num">cache 5m</th><th class="num">cache 1h</th>
          </tr></thead>
          <tbody>
            ${models.map(([k, v]) => `
              <tr>
                <td><span class="badge ${h(v.tier)}">${h(k)}</span></td>
                <td class="muted">${h(v.tier)}</td>
                <td class="num">$${v.input.toFixed(2)}</td>
                <td class="num">$${v.output.toFixed(2)}</td>
                <td class="num">$${v.cache_read.toFixed(2)}</td>
                <td class="num">$${v.cache_create_5m.toFixed(2)}</td>
                <td class="num">$${v.cache_create_1h.toFixed(2)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <p class="card-note" style="margin:12px 0 0">
        Rates per 1M tokens, USD. Anthropic bills cache reads at a tenth of input and
        cache writes at a premium (1.25× for the 5-minute TTL, 2× for the hour);
        OpenAI charges nothing to write cache, which is why the gpt rows are zero there.
      </p>
    </div>

    <div class="section">
      <div class="section-head"><h3>Tier fallbacks</h3></div>
      <p class="card-note">
        Used when a model matches no exact row above — a model released after this
        table was written still gets costed, and is flagged as an estimate rather
        than silently dropped.
      </p>
      <div class="table-wrap">
        <table class="pricing">
          <thead><tr><th>tier</th><th class="num">input</th><th class="num">output</th><th class="num">cache read</th></tr></thead>
          <tbody>
            ${Object.entries(cur.pricing.tier_fallback).map(([k, v]) => `
              <tr>
                <td><span class="badge ${h(k)}">${h(k)}</span></td>
                <td class="num">$${v.input.toFixed(2)}</td>
                <td class="num">$${v.output.toFixed(2)}</td>
                <td class="num">$${v.cache_read.toFixed(2)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <div class="section">
      <div class="section-head"><h3>Privacy &amp; appearance</h3></div>
      <p class="card-note" style="margin-bottom:6px">
        <b>⌘/Ctrl + B</b>, or the ◐ button at the bottom of the sidebar, blurs prompt
        text and other sensitive content — for screenshots and screen-shares.
      </p>
      <p class="card-note" style="margin:0">
        The ☀/☾ button switches theme. Your choice is remembered on this machine;
        without one, Token Meter follows your operating system.
      </p>
    </div>`;

  $('#save').addEventListener('click', async () => {
    const plan = $('#plan').value;
    await fetch('/api/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan }),
    });
    state.plan = plan;
    document.getElementById('plan-pill').textContent = plan;
    $('#msg').textContent = 'Saved.';
    $('#msg').style.color = 'var(--pos)';
  });
}
