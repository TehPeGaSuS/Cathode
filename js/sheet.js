// Action sheets: a bottom sheet on phones, a small centred dialog on desktop
// (same markup, the CSS decides). Used for the overflow menu, nick/line/buffer
// actions, confirmations and short prompts.

import { overlayOpened, overlayClosed } from './layout.js';

let current = null;   // { overlay, onClose }

function hide() {
  if (!current) return;
  const { overlay, onClose } = current;
  current = null;
  overlay.remove();
  if (onClose) onClose();
}

export function closeSheet() {
  if (!current) return;
  hide();
  overlayClosed('sheet');
}

/**
 * openSheet({ title, subtitleHtml, items, onClose })
 *   items: [{ label, icon?, hint?, danger?, checked?, disabled?, onSelect }]
 *          or 'sep' for a divider
 * Selecting an item closes the sheet first, then runs onSelect.
 */
export function openSheet({ title, subtitleHtml, items = [], body, onClose }) {
  if (current) hide();

  const overlay = document.createElement('div');
  overlay.className = 'sheet-overlay';
  overlay.addEventListener('click', e => { if (e.target === overlay) closeSheet(); });

  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  if (title) sheet.setAttribute('aria-label', title);

  const handle = document.createElement('div');
  handle.className = 'sheet-handle';
  sheet.appendChild(handle);

  if (title || subtitleHtml) {
    const hdr = document.createElement('div');
    hdr.className = 'sheet-hdr';
    if (title) {
      const t = document.createElement('div');
      t.className   = 'sheet-title';
      t.textContent = title;
      hdr.appendChild(t);
    }
    if (subtitleHtml) {
      const s = document.createElement('div');
      s.className = 'sheet-sub';
      s.innerHTML = subtitleHtml;   // caller passes already-escaped HTML
      hdr.appendChild(s);
    }
    sheet.appendChild(hdr);
  }

  if (body) sheet.appendChild(body);

  const list = document.createElement('div');
  list.className = 'sheet-items';
  for (const it of items) {
    if (it === 'sep') {
      const sep = document.createElement('div');
      sep.className = 'sheet-sep';
      list.appendChild(sep);
      continue;
    }
    const btn = document.createElement('button');
    btn.type      = 'button';
    btn.className = 'sheet-item' + (it.danger ? ' danger' : '');
    btn.disabled  = !!it.disabled;
    const icon  = document.createElement('span');
    icon.className   = 'sheet-icon';
    icon.textContent = it.icon || '';
    const label = document.createElement('span');
    label.className   = 'sheet-label';
    label.textContent = it.label;
    btn.append(icon, label);
    if (it.checked !== undefined) {
      btn.setAttribute('role', 'menuitemcheckbox');
      btn.setAttribute('aria-checked', String(!!it.checked));
      const sw = document.createElement('span');
      sw.className = 'sheet-switch' + (it.checked ? ' on' : '');
      btn.appendChild(sw);
    } else if (it.hint) {
      const h = document.createElement('span');
      h.className   = 'sheet-hint';
      h.textContent = it.hint;
      btn.appendChild(h);
    }
    btn.addEventListener('click', () => {
      // Run the action first: it may open the next sheet (kick → reason),
      // which then simply replaces this one.
      const mine = current;
      if (mine) mine.onClose = null;
      if (it.onSelect) it.onSelect();
      if (current === mine) closeSheet();
    });
    list.appendChild(btn);
  }
  if (items.length) sheet.appendChild(list);

  overlay.appendChild(sheet);
  document.body.appendChild(overlay);
  current = { overlay, onClose };
  overlayOpened('sheet', hide);
  // Keyboard users: focus the first actionable control
  const first = sheet.querySelector('input, select, .sheet-item:not(:disabled)');
  if (first && !('ontouchstart' in window)) first.focus();
  return sheet;
}

/** Yes/no confirmation. Resolves true only when confirmed. */
export function confirmSheet({ title, message, confirmLabel = 'OK', danger = false }) {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    openSheet({
      title,
      subtitleHtml: message ? escHtml(message) : undefined,
      items: [
        { label: confirmLabel, danger, onSelect: () => finish(true) },
        { label: 'Cancel', onSelect: () => finish(false) },
      ],
      onClose: () => finish(false),
    });
  });
}

/**
 * Short text prompt, optionally with a <select> (e.g. which IRC server).
 * Resolves { value, choice } or null when cancelled.
 */
export function promptSheet({ title, message, placeholder = '', value = '',
                              confirmLabel = 'OK', danger = false, required = true,
                              choices = null, choiceLabel = '', choice = null }) {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };

    const form = document.createElement('form');
    form.className = 'sheet-form';
    let select = null;
    if (choices && choices.length > 1) {
      const lab = document.createElement('label');
      lab.className   = 'sheet-field-label';
      lab.textContent = choiceLabel;
      select = document.createElement('select');
      for (const c of choices) {
        const o = document.createElement('option');
        o.value = c; o.textContent = c;
        if (c === choice) o.selected = true;
        select.appendChild(o);
      }
      lab.appendChild(select);
      form.appendChild(lab);
    }
    const input = document.createElement('input');
    input.type         = 'text';
    input.placeholder  = placeholder;
    input.value        = value;
    input.autocomplete = 'off';
    input.spellcheck   = false;
    input.setAttribute('autocapitalize', 'off');
    input.enterKeyHint = 'done';
    form.appendChild(input);

    const row = document.createElement('div');
    row.className = 'sheet-form-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button'; cancel.className = 'btn-secondary'; cancel.textContent = 'CANCEL';
    const ok = document.createElement('button');
    ok.type = 'submit'; ok.className = 'btn-primary' + (danger ? ' btn-danger' : '');
    ok.textContent = confirmLabel.toUpperCase();
    row.append(cancel, ok);
    form.appendChild(row);

    cancel.addEventListener('click', () => { finish(null); closeSheet(); });
    form.addEventListener('submit', e => {
      e.preventDefault();
      const v = input.value.trim();
      if (required && !v) { input.focus(); return; }
      finish({ value: v, choice: select ? select.value : choice });
      closeSheet();
    });

    openSheet({
      title,
      subtitleHtml: message ? escHtml(message) : undefined,
      body: form,
      onClose: () => finish(null),
    });
    input.focus();
  });
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
