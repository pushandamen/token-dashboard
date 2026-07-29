// app.js — router, state, fetch helpers

export const $  = (sel, root=document) => root.querySelector(sel);
export const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));

const COMPACT = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
export const fmt = {
  int:   n => (n ?? 0).toLocaleString(),
  compact: n => COMPACT.format(n ?? 0),
  usd:   n => n == null ? '—' : '$' + Number(n).toFixed(2),
  usd4:  n => n == null ? '—' : '$' + Number(n).toFixed(4),
  pct:   n => n == null ? '—' : (n * 100).toFixed(0) + '%',
  short: (s, n=80) => s == null ? '' : (s.length > n ? s.slice(0, n - 1) + '…' : s),
  htmlSafe: s => (s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
  modelClass: m => {
    const s = (m || '').toLowerCase();
    if (s.includes('fable') || s.includes('mythos')) return 'fable';
    if (s.includes('opus'))   return 'opus';
    if (s.includes('sonnet')) return 'sonnet';
    if (s.includes('haiku'))  return 'haiku';
    if (s.includes('gpt') || s.includes('codex')) return 'gpt';
    return '';
  },
  modelShort: m => (m || '').replace('claude-', ''),
  // Absolute paths eat a whole line before saying anything. The home prefix is
  // the part that never identifies the file, so only that goes.
  tildePath: s => (s ?? '').replace(/\/Users\/[^/\s]+\//g, '~/'),
  ts: t => (t || '').slice(0, 16).replace('T', ' '),
};

export async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}

export const state = { plan: 'api', planSet: false, pricing: null };

/** An ⓘ button that explains a number. `text` may contain blank lines. */
export const tip = text => text
  ? `<button type="button" class="why" data-tip="${fmt.htmlSafe(text)}" aria-label="What this means">ⓘ</button>`
  : '';

/** One floating tooltip for the whole app, delegated off document so it keeps
 *  working after any tab re-renders. Shows on hover, keyboard focus, or tap;
 *  click pins it open so long explanations can be read at leisure. */
function installTooltips() {
  const el = document.createElement('div');
  el.className = 'tipbox';
  el.setAttribute('role', 'tooltip');
  document.body.appendChild(el);
  let pinned = null;

  const show = target => {
    el.textContent = target.dataset.tip;
    el.classList.add('on');
    const r = target.getBoundingClientRect();
    // Keep it on screen: left-align to the anchor, pull back from the edge,
    // and flip above when there isn't room below.
    let left = r.left;
    if (left + el.offsetWidth > window.innerWidth - 12) left = window.innerWidth - el.offsetWidth - 12;
    el.style.left = Math.max(12, left) + 'px';
    const below = r.bottom + 8;
    el.style.top = (below + el.offsetHeight > window.innerHeight - 12
      ? Math.max(12, r.top - el.offsetHeight - 8)
      : below) + 'px';
  };
  const hide = () => { el.classList.remove('on'); pinned = null; };

  document.addEventListener('mouseover', e => {
    const t = e.target.closest?.('[data-tip]');
    if (t && !pinned) show(t);
  });
  document.addEventListener('mouseout', e => {
    if (!pinned && e.target.closest?.('[data-tip]')) hide();
  });
  document.addEventListener('focusin', e => {
    const t = e.target.closest?.('[data-tip]');
    if (t) show(t);
  });
  document.addEventListener('focusout', () => { if (!pinned) hide(); });
  document.addEventListener('click', e => {
    const t = e.target.closest?.('[data-tip]');
    if (!t) return hide();
    if (pinned === t) return hide();
    pinned = t;
    show(t);
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') hide(); });
  window.addEventListener('scroll', () => { if (!pinned) hide(); }, { passive: true });
}

const ROUTES = {
  '/overview': () => import('/web/routes/overview.js'),
  '/prompts':  () => import('/web/routes/prompts.js'),
  '/sessions': () => import('/web/routes/sessions.js'),
  '/projects': () => import('/web/routes/projects.js'),
  '/skills':   () => import('/web/routes/skills.js'),
  '/savings':  () => import('/web/routes/savings.js'),
  '/tips':     () => import('/web/routes/tips.js'),
  '/settings': () => import('/web/routes/settings.js'),
};

function buildTopbar() {
  const wrap = document.createElement('header');
  wrap.className = 'topbar';
  wrap.innerHTML = `
    <div class="brand">Token Dashboard</div>
    <nav>
      ${Object.keys(ROUTES).map(p => `<a href="#${p}" data-route="${p}">${p.slice(1)}</a>`).join('')}
    </nav>
    <div class="spacer"></div>
    <span class="pill" id="plan-pill">api</span>
    <span class="pill muted" title="Cmd/Ctrl+B blurs sensitive text">⌘B blur</span>
  `;
  document.body.prepend(wrap);
}

function setActiveTab(routeKey) {
  $$('header.topbar nav a').forEach(a => a.classList.toggle('active', a.dataset.route === routeKey));
}

async function render() {
  const hash = location.hash.replace(/^#/, '') || '/overview';
  const path = hash.split('?')[0];
  let key = path;
  if (path.startsWith('/sessions/')) key = '/sessions';
  setActiveTab(key);
  const loader = ROUTES[key] || ROUTES['/overview'];
  const mod = await loader();
  $('#app').innerHTML = '';
  try {
    await mod.default($('#app'));
  } catch (e) {
    $('#app').innerHTML = `<div class="card"><h2>Error</h2><pre>${fmt.htmlSafe(String(e.stack || e))}</pre></div>`;
  }
}

async function firstRun() {
  // Server-side flag first: a plan chosen once shouldn't be asked for again in
  // every new browser profile. localStorage stays as a fallback for anyone who
  // dismissed it before the flag existed.
  if (state.planSet || localStorage.getItem('td.plan-set')) return;
  const plans = Object.entries(state.pricing.plans);
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h2>Welcome — pick your plan</h2>
      <p>This sets how costs are displayed. Change it later in Settings.</p>
      <select id="firstplan" style="width:100%">
        ${plans.map(([k,v]) => `<option value="${k}">${v.label}${v.monthly ? ` — $${v.monthly}/mo` : ''}</option>`).join('')}
      </select>
      <div class="actions">
        <div class="spacer"></div>
        <button class="primary" id="firstsave">Continue</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  await new Promise(res => $('#firstsave', overlay).addEventListener('click', async () => {
    const plan = $('#firstplan', overlay).value;
    await fetch('/api/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan }) });
    localStorage.setItem('td.plan-set', '1');
    overlay.remove();
    res();
  }));
  state.plan = (await api('/api/plan')).plan;
}

async function boot() {
  buildTopbar();
  installTooltips();
  const planResp = await api('/api/plan');
  state.plan = planResp.plan;
  state.planSet = !!planResp.plan_set;
  state.pricing = planResp.pricing;
  $('#plan-pill').textContent = state.plan;

  await firstRun();

  window.addEventListener('hashchange', render);
  await render();

  // Privacy blur (Cmd+B / Ctrl+B)
  window.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      document.body.classList.toggle('privacy-on');
    }
  });

  // SSE diff stream
  try {
    const es = new EventSource('/api/stream');
    es.onmessage = ev => {
      try {
        const evt = JSON.parse(ev.data);
        if (evt.type === 'scan') render();
      } catch {}
    };
  } catch {}
}

boot();
