import { api, fmt, tip, readRange, sinceIso, rangeControl, wireRange } from '/web/app.js';
import { barChart } from '/web/charts.js';

const h = fmt.htmlSafe;

const TOKENS_PER_CALL_WHY = `The size of the skill's SKILL.md — what Claude Code loads into context every time the skill fires.

It's blank for skills installed outside the three scanned roots (~/.claude/skills, scheduled-tasks, plugins). Those still show invocation counts; only the size is unknown.`;

export async function view(root) {
  const range = readRange();
  const since = sinceIso(range);
  const skills = await api('/api/skills' + (since ? '?since=' + encodeURIComponent(since) : ''));

  const invocations = skills.reduce((s, r) => s + r.invocations, 0);
  // Only skills whose size is known can contribute — summing the rest as zero
  // would understate the total and read as fact.
  const sized = skills.filter(s => s.tokens_per_call != null);
  const contextLoaded = sized.reduce((s, r) => s + r.tokens_per_call * r.invocations, 0);

  root.innerHTML = `
    <div class="card-head">
      <span class="spacer"></span>
      ${rangeControl(range)}
    </div>

    <div class="row cols-3">
      <div class="card stat">
        <div class="stat-label">Skills used</div>
        <div class="stat-value">${fmt.int(skills.length)}</div>
      </div>
      <div class="card stat">
        <div class="stat-label">Invocations</div>
        <div class="stat-value">${fmt.int(invocations)}</div>
      </div>
      <div class="card stat">
        <div class="stat-label">Context loaded ${tip(TOKENS_PER_CALL_WHY)}</div>
        <div class="stat-value">${fmt.compact(contextLoaded)}</div>
        <div class="stat-sub">${
          sized.length === skills.length
            ? 'all skills sized'
            : `${sized.length} of ${skills.length} skills sized`
        }</div>
      </div>
    </div>

    ${skills.length ? `
      <div class="card" style="margin-top:14px">
        <div class="card-head"><h3>Most-invoked</h3></div>
        <div id="ch-skills" style="height:${Math.max(180, Math.min(12, skills.length) * 26)}px"></div>
      </div>` : ''}

    <div class="card" style="margin-top:14px">
      <div class="card-head"><h3>All skills</h3></div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>skill</th>
            <th class="num">invocations</th>
            <th class="num">tokens per call</th>
            <th class="num">sessions</th>
            <th>last used</th>
          </tr></thead>
          <tbody>
            ${skills.map(s => `
              <tr>
                <td><span class="badge">${h(s.skill)}</span></td>
                <td class="num">${fmt.int(s.invocations)}</td>
                <td class="num">${s.tokens_per_call == null ? '<span class="muted">—</span>' : fmt.int(s.tokens_per_call)}</td>
                <td class="num">${fmt.int(s.sessions)}</td>
                <td class="mono">${fmt.ts(s.last_used)}</td>
              </tr>`).join('') || '<tr><td colspan="5" class="empty">no skills invoked in this range</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>`;

  wireRange(root);

  if (skills.length) {
    const top = skills.slice(0, 12);
    barChart(document.getElementById('ch-skills'), {
      horizontal: true,
      categories: top.map(t => (t.skill.length > 22 ? t.skill.slice(0, 21) + '…' : t.skill)),
      values: top.map(t => t.invocations),
      color: getComputedStyle(document.documentElement).getPropertyValue('--tok-read').trim(),
    });
  }
}
