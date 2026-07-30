import { api, fmt, readRange, sinceIso, withSince, rangeControl, wireRange, projectLabeller } from '/web/app.js';

const h = fmt.htmlSafe;
const money = n => (n == null ? '—' : Math.abs(n) >= 100 ? fmt.usd0(n) : fmt.usd(n));

export async function view(root) {
  const range = readRange();
  const rows = await api(withSince('/api/projects', sinceIso(range)));
  const label = projectLabeller(rows);
  const sorted = [...rows].sort((a, b) => (b.cost_usd || 0) - (a.cost_usd || 0));

  root.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h3>${fmt.int(sorted.length)} project${sorted.length === 1 ? '' : 's'}</h3>
        <span class="spacer"></span>
        ${rangeControl(range)}
      </div>
      <p class="card-note">
        Sorted by estimated cost. Cache reads are billed at a tenth of input, so a
        high cache-read column next to a low cost is the shape you want.
      </p>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>project</th>
            <th class="num">cost</th>
            <th class="num">sessions</th>
            <th class="num">prompts</th>
            <th class="num">billable tokens</th>
            <th class="num">cache reads</th>
          </tr></thead>
          <tbody>
            ${sorted.map(r => `
              <tr>
                <td class="blur-sensitive" title="${h(r.project_slug)}">${h(label(r))}</td>
                <td class="num">${money(r.cost_usd)}</td>
                <td class="num">${fmt.int(r.sessions)}</td>
                <td class="num">${fmt.int(r.turns)}</td>
                <td class="num">${fmt.int(r.billable_tokens)}</td>
                <td class="num">${fmt.int(r.cache_read_tokens)}</td>
              </tr>`).join('') || '<tr><td colspan="6" class="empty">no projects in this range</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>`;

  wireRange(root);
}
