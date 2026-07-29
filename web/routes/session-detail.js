import { api, fmt } from '/web/app.js';

const h = fmt.htmlSafe;

export default async function (root) {
  const id = decodeURIComponent(location.hash.split('?')[0].split('/')[2] || '');
  if (!id) {
    location.replace('#/activity?view=sessions');
    return;
  }

  const turns = await api('/api/sessions/' + encodeURIComponent(id));
  let totalIn = 0, totalOut = 0, totalCacheRd = 0;
  for (const t of turns) {
    if (t.type !== 'assistant') continue;
    totalIn += t.input_tokens || 0;
    totalOut += t.output_tokens || 0;
    totalCacheRd += t.cache_read_tokens || 0;
  }

  const slug = (turns[0] && turns[0].project_slug) || '';
  const cwd = (turns.find(t => t.cwd) || {}).cwd || '';
  const base = cwd ? cwd.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() : '';
  const project = base || slug;
  const started = (turns[0] && turns[0].timestamp) || '';
  const ended = (turns[turns.length - 1] && turns[turns.length - 1].timestamp) || '';

  root.innerHTML = `
    <div class="pagehead">
      <h2 class="blur-sensitive">${h(project) || 'Session'}</h2>
      <span class="sub mono">${h(id.slice(0, 8))}…</span>
      <span class="spacer"></span>
      <a href="#/activity?view=sessions">← all sessions</a>
    </div>

    <div class="row cols-4">
      <div class="card stat">
        <div class="stat-label">Records</div>
        <div class="stat-value">${fmt.int(turns.length)}</div>
        <div class="stat-sub mono">${fmt.ts(started)} → ${fmt.ts(ended)}</div>
      </div>
      <div class="card stat"><div class="stat-label">Input</div><div class="stat-value">${fmt.compact(totalIn)}</div></div>
      <div class="card stat"><div class="stat-label">Output</div><div class="stat-value">${fmt.compact(totalOut)}</div></div>
      <div class="card stat"><div class="stat-label">Cache read</div><div class="stat-value">${fmt.compact(totalCacheRd)}</div></div>
    </div>

    <div class="card" style="margin-top:14px">
      <div class="card-head"><h3>Turn by turn</h3></div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>time</th><th>type</th><th>model</th>
            <th>prompt / tools</th>
            <th class="num">in</th><th class="num">out</th><th class="num">cache rd</th>
          </tr></thead>
          <tbody>
            ${turns.map(t => {
              const tools = t.tool_calls_json ? JSON.parse(t.tool_calls_json) : [];
              const summary = t.prompt_text ? fmt.short(t.prompt_text, 100)
                : tools.length ? tools.map(x => x.name).join(' · ')
                : '';
              return `<tr>
                <td class="mono">${h((t.timestamp || '').slice(11, 19))}</td>
                <td>${h(t.type)}${t.is_sidechain ? ' <span class="badge">side</span>' : ''}</td>
                <td>${t.model ? `<span class="badge ${fmt.modelClass(t.model)}">${h(fmt.modelShort(t.model))}</span>` : ''}</td>
                <td class="blur-sensitive">${h(summary)}</td>
                <td class="num">${fmt.int(t.input_tokens)}</td>
                <td class="num">${fmt.int(t.output_tokens)}</td>
                <td class="num">${fmt.int(t.cache_read_tokens)}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}
