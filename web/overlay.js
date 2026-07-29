// overlay.js — the one focused layer, shared by every drill-down.
//
// Breakdowns started life inline, injected part-way down whichever page you
// were on. That put the answer to "what made this number" among six other
// cards, and left you scrolling to find what you'd just asked for. As a layer
// it gets the screen to itself and leaves cleanly, and — because it's one
// implementation — Overview and Savings can't drift apart.

import { $, $$, fmt } from '/web/app.js';

const h = fmt.htmlSafe;
let el = null;

export function closeOverlay() {
  if (!el) return;
  el.remove();
  el = null;
  document.removeEventListener('keydown', onKey);
  // A scan that arrived while this was open has been waiting for it to close.
  window.dispatchEvent(new Event('overlay-closed'));
}

function onKey(e) {
  if (e.key === 'Escape') closeOverlay();
}

/** Open (or reuse) the layer and return the node to render into. */
export function openOverlay() {
  if (el) return el;
  el = document.createElement('div');
  el.className = 'overlay';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  // mousedown, not click, and only on the backdrop itself: a click that starts
  // on a row and drifts onto the backdrop should not dismiss the thing you're
  // reading.
  el.addEventListener('mousedown', e => { if (e.target === el) closeOverlay(); });
  document.body.appendChild(el);
  document.addEventListener('keydown', onKey);
  return el;
}

/** Standard chrome: title, a figure, optional controls, close button, body. */
export function overlayShell({ title, amount, amountClass = '', controls = '', body }) {
  const node = openOverlay();
  node.innerHTML = `<div class="overlay-card">
    <div class="overlay-head">
      <h3>${h(title)}</h3>
      ${amount ? `<span class="amount ${amountClass}">${amount}</span>` : ''}
      <span class="spacer"></span>
      ${controls}
      <button class="iconbtn" data-close aria-label="Close">✕</button>
    </div>
    <div class="overlay-body">${body}</div>
  </div>`;
  $('[data-close]', node).addEventListener('click', closeOverlay);
  return node;
}

/** A segmented control for the overlay header or body. */
export const seg = (items, active, attr) => `<div class="seg">${items.map(i => `
  <button data-${attr}="${i.key}" class="${i.key === active ? 'active' : ''}">${h(i.label)}</button>`).join('')}</div>`;

/** A table the user can re-sort by clicking a heading.
 *
 *  Sorting happens here rather than on the server because these lists are a few
 *  thousand rows at most — a round trip per click would be slower and would
 *  lose the scroll position inside the box. */
export function sortable(root, cols, rows, initialKey) {
  if (!root) return;
  let key = initialKey;
  let dir = 'desc';

  const compare = (a, b) => {
    const col = cols.find(c => c.key === key) || cols[0];
    const va = col.value(a);
    const vb = col.value(b);
    const r = typeof va === 'number' && typeof vb === 'number'
      ? va - vb
      : String(va).localeCompare(String(vb));
    return dir === 'asc' ? r : -r;
  };

  const draw = () => {
    const sorted = rows.slice().sort(compare);
    root.innerHTML = `<table>
      <thead><tr>${cols.map(c => `
        <th class="sortable${c.num ? ' num' : ''}" data-key="${c.key}"
            aria-sort="${c.key === key ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}"
        >${h(c.label)}</th>`).join('')}</tr></thead>
      <tbody>${sorted.map(r => `<tr>${cols.map(c =>
        `<td class="${c.cls || ''}${c.num ? ' num' : ''}">${c.render(r)}</td>`).join('')}</tr>`).join('')
        || `<tr><td colspan="${cols.length}" class="empty">nothing here</td></tr>`}</tbody>
    </table>`;

    $$('th[data-key]', root).forEach(th => th.addEventListener('click', () => {
      const next = th.dataset.key;
      if (next === key) {
        dir = dir === 'asc' ? 'desc' : 'asc';
      } else {
        key = next;
        // Money and counts are interesting from the top; names and dates from
        // the start. Defaulting each the other way costs a click on nearly
        // every column.
        dir = (cols.find(c => c.key === next) || {}).num ? 'desc' : 'asc';
      }
      draw();
    }));
  };

  draw();
}
