import { api, fmt, tip, readParam, writeParams, segmented, onSeg } from '/web/app.js';

const h = fmt.htmlSafe;
const money = n => (n == null ? '—' : Math.abs(n) >= 100 ? fmt.usd0(n) : fmt.usd(n));

const SORTS = [
  { key: 'tokens', label: 'Most expensive' },
  { key: 'recent', label: 'Most recent' },
];

const COST_WHY = `Everything this prompt set off, priced at API rates.

A prompt owns every turn that follows it until you type the next one — so a prompt that kicks off a twenty-tool agent run costs all twenty turns, not just the first reply. That's what "turns" counts.`;

export async function view(root) {
  const key = readParam('sort', 'tokens');
  const sort = SORTS.find(s => s.key === key) || SORTS[0];
  const rows = await api('/api/prompts?limit=200&sort=' + encodeURIComponent(sort.key));

  root.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h3>${fmt.int(rows.length)} prompts ${tip(COST_WHY)}</h3>
        <span class="spacer"></span>
        ${segmented(SORTS, sort.key, 'sort')}
      </div>
      <div class="table-wrap">
        <table id="prompts">
          <thead><tr>
            <th class="num">cost</th>
            <th>prompt</th>
            <th>project</th>
            <th>model</th>
            <th class="num">turns</th>
            <th class="num">billable</th>
            <th>when</th>
          </tr></thead>
          <tbody>
            ${rows.map((r, i) => `
              <tr data-i="${i}" style="cursor:pointer">
                <td class="num">${money(r.cost_usd)}</td>
                <td class="blur-sensitive">${h(fmt.short(r.prompt_text, 80))}</td>
                <td class="blur-sensitive" title="${h(r.project_slug)}">${h(r.project_name || r.project_slug)}</td>
                <td>${(r.models || [r.model]).slice(0, 2).map(m =>
                  `<span class="badge ${fmt.modelClass(m)}">${h(fmt.modelShort(m))}</span>`).join(' ')}</td>
                <td class="num">${fmt.int(r.turns)}</td>
                <td class="num">${fmt.compact(r.billable_tokens)}</td>
                <td class="mono">${fmt.ts(r.timestamp)}</td>
              </tr>`).join('') || '<tr><td colspan="7" class="empty">no prompts yet</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
    <div id="drawer"></div>`;

  onSeg(root, 'sort', k => writeParams({ sort: k }));

  root.querySelectorAll('#prompts tbody tr[data-i]').forEach(tr => {
    tr.addEventListener('click', () => {
      const r = rows[Number(tr.dataset.i)];
      const drawer = document.getElementById('drawer');
      drawer.innerHTML = `
        <div class="card">
          <div class="card-head">
            <h3>Prompt detail</h3>
            <span class="spacer"></span>
            ${(r.models || [r.model]).map(m =>
              `<span class="badge ${fmt.modelClass(m)}">${h(fmt.modelShort(m))}</span>`).join(' ')}
          </div>
          <pre class="blur-sensitive">${h(r.prompt_text || '')}</pre>
          <div class="flex" style="margin-top:12px;flex-wrap:wrap;gap:14px">
            <span class="muted mono">${fmt.ts(r.timestamp)}</span>
            <span class="muted">${money(r.cost_usd)} over ${fmt.int(r.turns)} turns ·
              ${fmt.int(r.billable_tokens)} billable · ${fmt.int(r.cache_read_tokens)} cache read</span>
            <span class="spacer"></span>
            <a href="#/sessions/${encodeURIComponent(r.session_id)}">Open session →</a>
          </div>
        </div>`;
      drawer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  });
}
