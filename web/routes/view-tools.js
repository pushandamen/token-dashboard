import { api, fmt, readRange, sinceIso, withSince, rangeControl, wireRange, $$ } from '/web/app.js';
import { barChart } from '/web/charts.js';
import { openDrawer } from '/web/routes/overview.js';

const h = fmt.htmlSafe;

/** `mcp__claude-in-chrome__computer` → `chrome:computer`. The prefix is the same
 *  on every MCP row, so it's pure width — and long enough to push the real names
 *  off the axis. */
export function shortTool(name) {
  const s = String(name || '');
  if (!s.startsWith('mcp__')) return fmt.short(s, 18);
  const parts = s.slice(5).split('__');
  const server = (parts[0] || '').replace(/^claude-in-/, '').replace(/^plugin_/, '');
  const tool = parts.slice(1).join('_') || server;
  return fmt.short(`${server}:${tool}`, 18);
}

export async function view(root) {
  const range = readRange();
  const tools = await api(withSince('/api/tools', sinceIso(range)));
  const calls = tools.reduce((s, t) => s + t.calls, 0);
  const top = tools.slice(0, 12);

  root.innerHTML = `
    <div class="card-head">
      <span class="spacer"></span>
      ${rangeControl(range)}
    </div>

    <div class="row cols-3">
      <div class="card stat">
        <div class="stat-label">Tools used</div>
        <div class="stat-value">${fmt.int(tools.length)}</div>
      </div>
      <div class="card stat">
        <div class="stat-label">Calls</div>
        <div class="stat-value">${fmt.int(calls)}</div>
      </div>
      <div class="card stat">
        <div class="stat-label">Result tokens</div>
        <div class="stat-value">${fmt.compact(tools.reduce((s, t) => s + (t.result_tokens || 0), 0))}</div>
        <div class="stat-sub">recorded where the transcript carries a size</div>
      </div>
    </div>

    ${top.length ? `
      <div class="card" style="margin-top:14px">
        <div class="card-head"><h3>Most-used</h3></div>
        <p class="card-note">Click a bar to see where it's called from.</p>
        <div id="ch-tools" style="height:${Math.max(200, top.length * 26)}px"></div>
      </div>` : ''}

    <div class="card" style="margin-top:14px">
      <div class="card-head"><h3>All tools</h3></div>
      <div class="table-wrap">
        <table id="tools">
          <thead><tr>
            <th>tool</th><th class="num">calls</th>
            <th class="num">share</th><th class="num">result tokens</th>
          </tr></thead>
          <tbody>
            ${tools.map(t => `
              <tr data-tool="${h(t.tool_name)}" style="cursor:pointer">
                <td title="${h(t.tool_name)}">${h(shortTool(t.tool_name))}</td>
                <td class="num">${fmt.int(t.calls)}</td>
                <td class="num">${calls ? (100 * t.calls / calls).toFixed(1) + '%' : '—'}</td>
                <td class="num">${t.result_tokens ? fmt.compact(t.result_tokens) : '<span class="muted">—</span>'}</td>
              </tr>`).join('') || '<tr><td colspan="4" class="empty">no tool calls in this range</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>`;

  wireRange(root);
  $$('[data-tool]', root).forEach(tr => tr.addEventListener('click', () =>
    openDrawer('tool', tr.dataset.tool, tr.dataset.tool)));

  if (top.length) {
    barChart(document.getElementById('ch-tools'), {
      horizontal: true,
      categories: top.map(t => shortTool(t.tool_name)),
      values: top.map(t => t.calls),
      color: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
      onSelect: i => openDrawer('tool', top[i].tool_name, top[i].tool_name),
    });
  }
}
