import { state } from './state.js';

const el  = id => document.getElementById(id);
const esc = s  => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

// ─── Upload dispatch ──────────────────────────────────────────────────────────
export async function uploadFile(file) {
  const s       = state.settings;
  const backend = s.uploadBackend || 'none';
  if (backend === 'none') {
    showUploadError('No upload backend configured. Open ⚙ Settings to set one up.');
    return;
  }
  setUploadState('uploading');
  try {
    let url;
    if (backend === 'filehost') url = await uploadToFilehost(file, s.filehostUrl);
    else if (backend === 'imgur') url = await uploadToImgur(file, s.imgurClientId);

    setUploadState('ok');
    setTimeout(() => setUploadState('idle'), 2000);

    const input = el('chat-input');
    const pos   = input.selectionStart || input.value.length;
    const sep   = input.value.length > 0 && !input.value.endsWith(' ') ? ' ' : '';
    input.value = input.value.slice(0, pos) + sep + url + input.value.slice(pos);
    input.focus();
    input.selectionStart = input.selectionEnd = pos + sep.length + url.length;
  } catch (err) {
    setUploadState('err');
    setTimeout(() => setUploadState('idle'), 3000);
    showUploadError(`Upload failed: ${err.message}`);
  }
}

async function uploadToFilehost(file, baseUrl) {
  if (!baseUrl) throw new Error('Filehost URL not configured in Settings.');
  const url  = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
  const form = new FormData();
  form.append('file', file, file.name);
  const res  = await fetch(url, { method: 'POST', body: form });
  if (res.status === 413) throw new Error('File too large for the upload server.');
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  const text = (await res.text()).trim();
  if (!text.startsWith('http')) throw new Error(summarizeUnexpectedResponse(text));
  return text;
}

// Turn an unexpected (non-URL) filehost response — an HTML info/error page,
// a PHP warning dump, etc. — into a short plain-text summary instead of
// dumping the raw markup into the UI.
function summarizeUnexpectedResponse(text) {
  const isHtml = /^<(!doctype|html)/i.test(text);
  if (!isHtml) return `Unexpected response: ${text.slice(0, 200)}`;
  const plain = text
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return `Upload rejected by server (file may exceed the size limit): ${plain.slice(0, 200)}`;
}

async function uploadToImgur(file, clientId) {
  if (!clientId) throw new Error('Imgur Client ID not configured in Settings.');
  const form = new FormData();
  form.append('image', file);
  const res  = await fetch('https://api.imgur.com/3/image', {
    method:  'POST',
    headers: { Authorization: `Client-ID ${clientId}` },
    body:    form,
  });
  const json = await res.json();
  if (!json.success) throw new Error(json.data?.error || 'Imgur upload failed');
  return json.data.link;
}

function setUploadState(s) {
  const btn = el('upload-btn');
  btn.classList.remove('uploading', 'upload-ok', 'upload-err');
  if      (s === 'uploading') { btn.classList.add('uploading'); btn.textContent = '⏳'; }
  else if (s === 'ok')        { btn.classList.add('upload-ok'); btn.textContent = '✓'; }
  else if (s === 'err')       { btn.classList.add('upload-err'); btn.textContent = '✗'; }
  else                         { btn.textContent = '📎'; }
}

function showUploadError(msg) {
  const box = el('messages');
  if (!box) return;
  const row = document.createElement('div');
  row.className  = 'msg-row msg-system';
  row.style.color = 'var(--status-disc)';
  row.innerHTML  =
    `<span class="msg-time"></span>` +
    `<span class="msg-prefix">upload</span>` +
    `<span class="msg-sep"></span>` +
    `<span class="msg-text">${esc(msg)}</span>`;
  box.appendChild(row);
  if (state.scroll.pinned) box.scrollTop = box.scrollHeight;
}

// ─── Drag & drop and clipboard paste ─────────────────────────────────────────
export function initDragDrop() {
  let dragCounter = 0;

  window.addEventListener('dragenter', e => {
    if (!e.dataTransfer.types.includes('Files')) return;
    dragCounter++;
    el('drag-overlay').style.display = 'flex';
  });

  window.addEventListener('dragleave', () => {
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      el('drag-overlay').style.display = 'none';
    }
  });

  window.addEventListener('dragover', e => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
  });

  window.addEventListener('drop', e => {
    e.preventDefault();
    dragCounter = 0;
    el('drag-overlay').style.display = 'none';
    if (!state.connected) return;
    const files = [...e.dataTransfer.files];
    if (files.length) uploadFile(files[0]);
  });

  // Paste image from clipboard
  el('chat-input').addEventListener('paste', e => {
    const items     = [...(e.clipboardData?.items || [])];
    const imageItem = items.find(i => i.kind === 'file' && i.type.startsWith('image/'));
    if (!imageItem) return;
    e.preventDefault();
    const file = imageItem.getAsFile();
    if (file) uploadFile(file);
  });
}
