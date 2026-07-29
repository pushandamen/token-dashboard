// app.js — router, state, theme, fetch helpers

export const $  = (sel, root=document) => root.querySelector(sel);
export const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));

const COMPACT = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
export const fmt = {
  int:   n => (n ?? 0).toLocaleString(),
  compact: n => COMPACT.format(n ?? 0),
  usd:   n => n == null ? '—' : '$' + Number(n).toFixed(2),
  usd0:  n => n == null ? '—' : '$' + Math.round(Number(n)).toLocaleString(),
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
  modelShort: m => (m || '').replace('claude-', '').replace(/-20\d{6}$/, ''),
  // Absolute paths eat a whole line before saying anything. The home prefix is
  // the part that never identifies the file, so only that goes.
  tildePath: s => (s ?? '').replace(/\/Users\/[^/\s]+\//g, '~/'),
  ts: t => (t || '').slice(0, 16).replace('T', ' '),
  // "2026-04-21" → "21 Apr". Axis labels don't need the year twice a chart.
  day: d => {
    if (!d) return '';
    const [, m, dd] = String(d).split('-');
    const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${Number(dd)} ${MON[Number(m) - 1] || ''}`.trim();
  },
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

// --- hash query params -------------------------------------------------------
// Every view reads its own state out of the hash, so a reload or a shared link
// lands where you left off. These were duplicated in four route files.

export function hashPath() {
  return (location.hash.replace(/^#/, '').split('?')[0]) || '/overview';
}

export function readParam(name, fallback = null) {
  const q = location.hash.split('?')[1] || '';
  const m = new RegExp(`(?:^|&)${name}=([^&]*)`).exec(q);
  return m ? decodeURIComponent(m[1]) : fallback;
}

/** Merge params into the current hash without losing the ones already there. */
export function writeParams(patch) {
  const q = location.hash.split('?')[1] || '';
  const params = new URLSearchParams(q);
  for (const [k, v] of Object.entries(patch)) {
    if (v == null) params.delete(k);
    else params.set(k, v);
  }
  const s = params.toString();
  location.hash = '#' + hashPath() + (s ? '?' + s : '');
}

export const RANGES = [
  { key: '7d',  label: '7d',  days: 7 },
  { key: '30d', label: '30d', days: 30 },
  { key: '90d', label: '90d', days: 90 },
  { key: 'all', label: 'All', days: null },
];

export function readRange() {
  const k = readParam('range');
  return RANGES.find(r => r.key === k) || RANGES[1];
}

export function sinceIso(range) {
  return range.days ? new Date(Date.now() - range.days * 86400 * 1000).toISOString() : null;
}

export function withSince(url, since) {
  if (!since) return url;
  return url + (url.includes('?') ? '&' : '?') + 'since=' + encodeURIComponent(since);
}

/** A segmented control. `items` are {key,label}; returns HTML, wire with onSeg. */
export function segmented(items, activeKey, attr = 'seg') {
  return `<div class="seg" role="tablist">${items.map(i => `
    <button role="tab" aria-selected="${i.key === activeKey}" data-${attr}="${i.key}"
            class="${i.key === activeKey ? 'active' : ''}">${fmt.htmlSafe(i.label)}</button>`).join('')}</div>`;
}

export function onSeg(root, attr, handler) {
  $$(`[data-${attr}]`, root).forEach(btn => {
    btn.addEventListener('click', () => handler(btn.dataset[attr]));
  });
}

export function rangeControl(range) {
  return segmented(RANGES, range.key, 'range');
}

export function wireRange(root) {
  onSeg(root, 'range', key => writeParams({ range: key }));
}

// --- theme -------------------------------------------------------------------

export function currentTheme() {
  return document.documentElement.getAttribute('data-theme') || 'light';
}

function setTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem('tm.theme', t); } catch {}
  const btn = $('#theme-toggle');
  if (btn) {
    btn.textContent = t === 'dark' ? '☾' : '☀';
    btn.setAttribute('aria-label', t === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
  }
  // Charts bake their colours in at construction, so the only honest way to
  // recolour them is to build them again.
  render();
}

// --- tooltips ----------------------------------------------------------------

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

// --- routing -----------------------------------------------------------------

const ROUTES = {
  '/overview': () => import('/web/routes/overview.js'),
  '/activity': () => import('/web/routes/activity.js'),
  '/savings':  () => import('/web/routes/savings.js'),
  '/settings': () => import('/web/routes/settings.js'),
  '/session':  () => import('/web/routes/session-detail.js'),
};

// Eight tabs became three. The old hashes are still in bookmarks, in the HUD,
// and in links inside this app's own prose, so they redirect rather than 404.
const ALIASES = {
  '/prompts':  '/activity?view=prompts',
  '/sessions': '/activity?view=sessions',
  '/projects': '/activity?view=projects',
  '/skills':   '/activity?view=skills',
  '/tips':     '/overview',
};

const NAV = [
  { path: '/overview', label: 'Overview' },
  { path: '/activity', label: 'Activity' },
  { path: '/savings',  label: 'Savings'  },
];

// A half-filled circle sat next to a sun/moon and read as a second theme
// toggle. Privacy needs an icon that can only mean one thing, and no glyph in
// the text set does — so this one is drawn.
const EYE_OFF = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 10 8 10 8a18.5 18.5 0 0 1-2.16 3.19M6.61 6.61A18.15 18.15 0 0 0 2 12s3 8 10 8a9.12 9.12 0 0 0 5.39-1.61"/>
  <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/>
  <line x1="2" y1="2" x2="22" y2="22"/>
</svg>`;

function buildTopbar() {
  const wrap = document.createElement('header');
  wrap.className = 'topbar';
  wrap.innerHTML = `
    <div class="brand">Token Meter</div>
    <nav>
      ${NAV.map(n => `<a href="#${n.path}" data-route="${n.path}">${n.label}</a>`).join('')}
    </nav>
    <div class="spacer"></div>
    <span class="pill" id="plan-pill" title="Billing mode — change in Settings">api</span>
    <button class="live-pill" id="live-pill" title="New sessions are picked up every 30 seconds"><span class="dot"></span><span id="live-text">live</span></button>
    <button class="iconbtn" id="blur-toggle" title="Blur prompt text and paths, for screenshots (⌘B)" aria-label="Toggle privacy blur">${EYE_OFF}</button>
    <button class="iconbtn" id="theme-toggle" aria-label="Switch theme">☀</button>
    <a class="iconbtn" href="#/settings" data-route="/settings" id="gear" title="Settings" aria-label="Settings">⚙</a>
  `;
  document.body.prepend(wrap);

  $('#theme-toggle', wrap).textContent = currentTheme() === 'dark' ? '☾' : '☀';
  $('#theme-toggle', wrap).addEventListener('click', () => {
    setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
  });
  $('#blur-toggle', wrap).addEventListener('click', toggleBlur);
  $('#live-pill', wrap).addEventListener('click', () => {
    if ($('#live-pill').classList.contains('stale')) applyScan();
  });
  // A deferred update lands as soon as the thing that blocked it goes away.
  document.addEventListener('focusout', () => { if (pending) setTimeout(applyScan, 120); });
  window.addEventListener('overlay-closed', () => { if (pending) applyScan(); });
}

function toggleBlur() {
  const on = document.body.classList.toggle('privacy-on');
  $('#blur-toggle')?.classList.toggle('active', on);
}

function setActiveTab(routeKey) {
  $$('header.topbar [data-route]').forEach(a => a.classList.toggle('active', a.dataset.route === routeKey));
}

async function render() {
  const raw = location.hash.replace(/^#/, '');
  const path = raw.split('?')[0] || '/overview';

  // /sessions/<id> keeps working as a deep link; bare /sessions is an alias.
  if (path.startsWith('/sessions/')) return mount('/session', '/activity');

  if (ALIASES[path]) {
    location.replace('#' + ALIASES[path]);
    return;
  }

  return mount(ROUTES[path] ? path : '/overview');
}

// What's currently on screen, so a scan event can update it in place instead of
// throwing it away. A full re-render every 30 seconds lost the scroll position,
// closed whatever was open, and restarted every chart animation.
let mounted = { key: null, navKey: null, mod: null };

async function mount(key, navKey, keepScroll) {
  setActiveTab(navKey || key);
  const mod = await ROUTES[key]();
  const root = $('#app');
  const y = window.scrollY;
  root.innerHTML = '';
  mounted = { key, navKey, mod };
  setLive('live');
  try {
    await mod.default(root);
  } catch (e) {
    root.innerHTML = `<div class="card"><h2>Something broke</h2>
      <p class="muted">This view failed to render. The detail below is the raw error.</p>
      <pre>${fmt.htmlSafe(String(e.stack || e))}</pre></div>`;
  }
  window.scrollTo({ top: keepScroll ? y : 0 });
}

function setLive(mode) {
  const pill = $('#live-pill');
  const text = $('#live-text');
  if (!pill || !text) return;
  pill.classList.toggle('stale', mode === 'stale');
  text.textContent = mode === 'stale' ? 'new data' : 'live';
  pill.title = mode === 'stale'
    ? 'New sessions were scanned. Click to load them.'
    : 'New sessions are picked up every 30 seconds';
  if (mode === 'ticked') {
    pill.classList.add('ticked');
    setTimeout(() => pill.classList.remove('ticked'), 900);
  }
}

/** Something the scan must not interrupt.
 *
 *  Two cases, and both would be infuriating: an open breakdown vanishing
 *  mid-read, and a label you're halfway through typing being replaced. Either
 *  one defers the update — the pill goes to "new data" and it lands the moment
 *  you're done. */
function busy() {
  if (document.querySelector('.overlay')) return true;
  const el = document.activeElement;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}

/** A scan landed. Every view updates: those with a `live` export patch their
 *  numbers in place, the rest re-render with the scroll position held. */
let liveTimer = null;
let pending = false;

function onScan() {
  clearTimeout(liveTimer);
  liveTimer = setTimeout(applyScan, 350);
}

async function applyScan() {
  if (busy()) {
    pending = true;
    setLive('stale');
    return;
  }
  pending = false;
  const mod = mounted.mod;
  try {
    if (mod && typeof mod.live === 'function') await mod.live($('#app'));
    else if (mounted.key) await mount(mounted.key, mounted.navKey, true);
    setLive('ticked');
  } catch {
    setLive('stale');
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
      <h2>Welcome to Token Meter</h2>
      <p>Pick how you pay for Claude Code. This sets how cost is displayed — you can change it later in Settings.</p>
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

  window.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      toggleBlur();
    }
  });

  // SSE diff stream
  try {
    const es = new EventSource('/api/stream');
    es.onmessage = ev => {
      try {
        const evt = JSON.parse(ev.data);
        if (evt.type === 'scan') onScan();
      } catch {}
    };
  } catch {}
}

boot();
