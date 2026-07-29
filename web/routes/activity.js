import { fmt, readParam, writeParams, segmented, onSeg } from '/web/app.js';

// Sessions, Prompts, Projects and Skills were four top-level tabs. They are all
// the same question — "slice this spend a different way" — so they're one tab
// with a segmented switch, and the nav went from eight items to three.
//
// Each view owns its own secondary control, because they genuinely differ:
// three of them filter by date range, and Prompts sorts instead (the prompts
// query has no date filter to offer, and a control that silently does nothing
// is worse than no control).

const VIEWS = [
  { key: 'sessions', label: 'Sessions', blurb: 'Every run of Claude Code, newest first. Open one to see it turn by turn.',                     load: () => import('/web/routes/view-sessions.js') },
  { key: 'prompts',  label: 'Prompts',  blurb: 'Individual prompts and what each one cost. Click a row for the full text.',                    load: () => import('/web/routes/view-prompts.js')  },
  { key: 'projects', label: 'Projects', blurb: 'Spend rolled up per project directory.',                                                       load: () => import('/web/routes/view-projects.js') },
  { key: 'skills',   label: 'Skills',   blurb: 'Which skills fired, how often, and what each one loads into context when it does.',            load: () => import('/web/routes/view-skills.js')   },
  { key: 'tools',    label: 'Tools',    blurb: 'Which tools get called, how often, and where from. Click any row for its projects and days.',   load: () => import('/web/routes/view-tools.js')    },
];

export default async function (root) {
  const key = readParam('view', 'sessions');
  const active = VIEWS.find(v => v.key === key) || VIEWS[0];

  root.innerHTML = `
    <div class="pagehead">
      <h2>Activity</h2>
      <span class="spacer"></span>
      ${segmented(VIEWS, active.key, 'view')}
    </div>
    <p class="card-note" style="margin:-8px 0 14px">${fmt.htmlSafe(active.blurb)}</p>
    <div id="view"></div>
  `;

  // Switching view resets the view-specific params — carrying a `sort` from
  // Prompts into Sessions would leave a control highlighted that isn't there.
  onSeg(root, 'view', k => writeParams({ view: k, sort: null, range: null }));

  const mod = await active.load();
  await mod.view(document.getElementById('view'));
}
