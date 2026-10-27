const form = document.getElementById('form');
const urlInput = document.getElementById('url');
const qualityWrap = document.getElementById('qualityWrap');
const qualitySelect = document.getElementById('quality');
const submitBtn = document.getElementById('submit');
const hint = document.getElementById('hint');
const list = document.getElementById('list');
const empty = document.getElementById('empty');
const count = document.getElementById('count');

const state = new Map(); // job id → last known job

const fmtDuration = (s) =>
  s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : '';
const fmtSize = (b) => {
  if (!b) return '';
  const n = Number(b);
  if (n > 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n > 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(n / 1024)} KB`;
};

/** Files are transient: done + expiresAt means "still downloadable". */
function fileState(job) {
  if (job.status !== 'done') return 'pending';
  if (!job.expiresAt) return job.deliveredAt ? 'delivered' : 'expired';
  return new Date(job.expiresAt) > new Date() ? 'available' : 'expired';
}

form.addEventListener('change', (e) => {
  if (e.target.name === 'format') qualityWrap.hidden = e.target.value !== 'mp4';
});

async function createJob(payload) {
  const res = await fetch('/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? 'เพิ่มงานไม่สำเร็จ');
  return data;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  hint.textContent = '';
  const format = form.querySelector('input[name="format"]:checked').value;
  submitBtn.disabled = true;
  try {
    await createJob({
      url: urlInput.value.trim(),
      format,
      quality: format === 'mp4' ? qualitySelect.value : undefined,
    });
    urlInput.value = '';
    await refresh();
  } catch (err) {
    hint.textContent = err.message;
  } finally {
    submitBtn.disabled = false;
  }
});

list.addEventListener('click', async (e) => {
  const again = e.target.closest('.again');
  if (again) {
    const job = state.get(again.dataset.id);
    if (!job) return;
    again.disabled = true;
    try {
      await createJob({ url: job.url, format: job.format, quality: job.quality });
      await refresh();
    } catch (err) {
      hint.textContent = err.message;
      again.disabled = false;
    }
    return;
  }

  const btn = e.target.closest('.del');
  if (btn) {
    btn.disabled = true;
    await fetch(`/api/jobs/${btn.dataset.id}`, { method: 'DELETE' });
    await refresh();
  }
});

let firstRender = true;

function metaBits(job, file) {
  const bits = [job.format.toUpperCase()];
  if (job.format === 'mp4') bits.push(`${job.quality}p`);
  if (job.duration) bits.push(fmtDuration(job.duration));
  if (job.fileSize) bits.push(fmtSize(job.fileSize));
  if (file === 'available') {
    const mins = Math.max(1, Math.ceil((new Date(job.expiresAt) - Date.now()) / 60000));
    bits.push(`ลบในอีก ${mins} นาที`);
  }
  if (file === 'delivered') bits.push('ดาวน์โหลดแล้ว · ไฟล์ถูกลบ');
  if (file === 'expired') bits.push('หมดอายุ · ไฟล์ถูกลบ');
  return bits;
}

function row(job) {
  const file = fileState(job);
  const li = document.createElement('li');
  li.className = 'job';
  li.dataset.id = job.id;

  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = job.title ?? job.url;

  const meta = document.createElement('div');
  meta.className = 'meta';
  for (const bit of metaBits(job, file)) {
    const span = document.createElement('span');
    span.textContent = bit;
    meta.append(span);
  }
  if (job.status === 'error' && job.error) {
    const err = document.createElement('span');
    err.className = 'err';
    err.textContent = job.error.slice(0, 140);
    meta.append(err);
  }

  const actions = document.createElement('div');
  actions.className = 'actions';

  const LABEL = {
    queued: 'รอคิว',
    error: 'ผิดพลาด',
    available: 'พร้อมโหลด',
    delivered: 'โหลดแล้ว',
    expired: 'หมดอายุ',
  };
  const pill = document.createElement('span');
  pill.className = `pill ${job.status}`;
  pill.dataset.file = file;
  pill.textContent =
    job.status === 'processing'
      ? `${job.progress}%`
      : job.status === 'done'
        ? LABEL[file]
        : (LABEL[job.status] ?? job.status);
  actions.append(pill);

  if (file === 'available') {
    const a = document.createElement('a');
    a.className = 'dl';
    a.href = `/api/jobs/${job.id}/file`;
    a.textContent = 'ดาวน์โหลด';
    actions.append(a);
  } else if (job.status === 'done') {
    const again = document.createElement('button');
    again.className = 'again';
    again.type = 'button';
    again.dataset.id = job.id;
    again.textContent = 'แปลงใหม่';
    actions.append(again);
  }

  const del = document.createElement('button');
  del.className = 'del';
  del.type = 'button';
  del.dataset.id = job.id;
  del.title = 'ลบงานนี้ออกจากรายการ';
  del.textContent = '✕';
  actions.append(del);

  li.append(title, meta, actions);

  if (job.status === 'processing') {
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.style.width = `${job.progress}%`;
    li.append(bar);
  }
  return li;
}

function render(jobs) {
  count.textContent = String(jobs.length);
  empty.hidden = jobs.length > 0;
  state.clear();

  for (const job of jobs) {
    state.set(job.id, job);
    const existing = list.querySelector(`[data-id="${job.id}"]`);
    const next = row(job);
    if (existing) existing.replaceWith(next);
    else list.append(next);
  }

  const seen = new Set(jobs.map((j) => j.id));
  for (const li of [...list.children]) {
    if (!seen.has(li.dataset.id)) li.remove();
  }

  // Keep the DOM in the server's order (newest first); new jobs are appended
  // above, so they have to be moved into place afterwards.
  for (const job of jobs) {
    const li = list.querySelector(`[data-id="${job.id}"]`);
    if (li && li !== list.lastElementChild) list.append(li);
  }

  if (firstRender) {
    firstRender = false;
    list.querySelectorAll('.bar').forEach((b) => (b.style.transition = 'none'));
  }
}

async function refresh() {
  try {
    const res = await fetch('/api/jobs');
    if (!res.ok) return;
    render(await res.json());
  } catch {
    /* server restarting — try again on next tick */
  }
}

refresh();
setInterval(refresh, 2000);
