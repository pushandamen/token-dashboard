import { api, fmt, readRange, sinceIso, withSince, rangeControl, wireRange } from '/web/app.js';

const h = fmt.htmlSafe;

export async function view(root) {
  const range = readRange();
  const list = await api(withSince('/api/sessions?limit=100', sinceIso(range)));

  root.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h3>${fmt.int(list.length)} session${list.length === 1 ? '' : 's'}</h3>
        <span class="spacer"></span>
        ${rangeControl(range)}
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>started</th><th>project</th>
            <th class="num">prompts</th><th class="num">tokens</th><th>id</th>
          </tr></thead>
          <tbody>
            ${list.map(s => `
              <tr>
                <td class="mono">${fmt.ts(s.started)}</td>
                <td class="blur-sensitive" title="${h(s.project_slug)}">
                  <a href="#/sessions/${encodeURIComponent(s.session_id)}">${h(s.project_name || s.project_slug)}</a>
                </td>
                <td class="num">${fmt.int(s.turns)}</td>
                <td class="num">${fmt.int(s.tokens)}</td>
                <td><a class="mono" href="#/sessions/${encodeURIComponent(s.session_id)}">${h(s.session_id.slice(0, 8))}…</a></td>
              </tr>`).join('') || '<tr><td colspan="5" class="empty">no sessions in this range</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>`;

  wireRange(root);
}
