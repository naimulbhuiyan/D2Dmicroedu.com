'use strict';
/* microedu.com — frontend logic. Same API contract as before; new design,
   photo / group / anonymous registration, hourly / bidding / free pricing. */
const $ = id => document.getElementById(id);
let token = localStorage.getItem('microedu_token') || localStorage.getItem('d2d_token') || '';
let me = null, myRanking = 0, photoDataUrl = '';
const teacherPricing = {};
const PLANS = ['Basic', 'Plus', 'Teacher Plus'];
let myTimeBalance = 0;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initials = n => String(n || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';

async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, ...opts });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Request failed');
  return d;
}
function msg(el, text, ok = true) { el.textContent = text; el.className = 'msg ' + (ok ? 'ok' : 'err'); }
function saveToken(t) { token = t; localStorage.setItem('microedu_token', t); localStorage.removeItem('d2d_token'); }
function fillPlans() { $('subPlan').innerHTML = PLANS.map(p => `<option>${p}</option>`).join(''); }
fillPlans();
const fmtMins = m => { m = Math.round(Number(m) || 0); const h = Math.floor(m / 60), r = m % 60; return h ? `${h}h ${r}m` : `${r}m`; };

/* ---------- photo: personal / group / anonymous ---------- */
function photoMode() { const r = document.querySelector('input[name="photoMode"]:checked'); return r ? r.value : 'personal'; }
document.querySelectorAll('input[name="photoMode"]').forEach(r => r.onchange = () => {
  const mode = photoMode();
  const gw = $('groupNameWrap'); if (gw) gw.classList.toggle('hidden', mode !== 'group');
  $('rPhotoFile').disabled = mode === 'anonymous';
  if (mode === 'anonymous') { photoDataUrl = ''; $('photoPreview').classList.remove('show'); }
});
$('rPhotoFile').onchange = () => {
  const f = $('rPhotoFile').files[0];
  if (!f) return;
  const img = new Image();
  img.onload = () => {
    const max = 480, scale = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    photoDataUrl = c.toDataURL('image/jpeg', 0.82);
    $('photoPreview').src = photoDataUrl;
    $('photoPreview').classList.add('show');
    URL.revokeObjectURL(img.src);
  };
  img.src = URL.createObjectURL(f);
};

/* ---------- pricing choice (teacher profile form) ---------- */
$('tPricing').onchange = () => {
  const v = $('tPricing').value;
  $('tRateLabel').textContent = v === 'bidding' ? 'Starting bid (BDT)' : 'Rate (BDT / hour)';
  $('tRate').disabled = v === 'free';
  if (v === 'free') $('tRate').value = 0; else if (!$('tRate').value || Number($('tRate').value) === 0) $('tRate').value = 500;
};
function priceText(cv) {
  if (!cv) return 'BDT 500/hr';
  const t = cv.pricing_type || 'hourly';
  if (t === 'free') return 'Free service';
  if (t === 'bidding') return 'Bidding · from BDT ' + (cv.rate_bdt_per_hour || 500);
  return 'BDT ' + (cv.rate_bdt_per_hour || 500) + '/hr';
}
function priceChip(cv) {
  const t = (cv && cv.pricing_type) || 'hourly';
  return `<span class="chip price-${t}">${esc(priceText(cv))}</span>`;
}
function displayName(p) {
  if (p.anonymous || p.photo_mode === 'anonymous') return 'Anonymous member';
  if (p.photo_mode === 'group' && p.group_name) return p.group_name;
  return p.name;
}
function avatarHtml(p, big = false) {
  if (!p.anonymous && p.photo_mode !== 'anonymous' && p.photo_data)
    return `<span class="avatar${big ? ' big' : ''}"><img src="${p.photo_data}" alt=""></span>`;
  if (p.anonymous || p.photo_mode === 'anonymous')
    return `<span class="avatar${big ? ' big' : ''}">🕶️</span>`;
  return `<span class="avatar${big ? ' big' : ''}">${esc(initials(p.name))}</span>`;
}

/* ---------- registration (step 1: basic — learn right away) ---------- */
$('regForm').onsubmit = async e => {
  e.preventDefault();
  if ($('rPass').value !== $('rPass2').value) return msg($('regMsg'), 'Passwords do not match', false);
  const mode = photoMode();
  try {
    const d = await api('/api/register', { method: 'POST', body: JSON.stringify({
      name: $('rName').value, email: $('rEmail').value, password: $('rPass').value,
      phone: $('rPhone').value, mobile: $('rMobile').value,
      picture: $('rPhotoFile').files[0] ? $('rPhotoFile').files[0].name : '',
      photo_mode: mode, group_name: $('rGroupName').value,
      photo_data: mode === 'anonymous' ? '' : photoDataUrl,
    }) });
    saveToken(d.token); me = d.person; showProfile(d.person, d.cv);
    msg($('regMsg'), 'Registered and signed in: ' + d.person.name + ' — you can learn now. To teach, complete your teacher profile in the dashboard.');
    loadAll();
  } catch (err) { msg($('regMsg'), err.message, false); }
};

/* ---------- teacher profile (step 2: complete profile to teach) ---------- */
$('teacherForm').onsubmit = async e => {
  e.preventDefault();
  const cv = {
    education: $('tEducation').value, university: $('tUniversity').value, profession: $('tProfession').value,
    position: $('tPosition').value, experience: $('tExperience').value, speciality: $('tSpeciality').value,
    subjects: $('tSubjects').value, level: $('tLevel').value, address: $('tAddress').value,
    available_time: $('tAvail').value, rate_bdt_per_hour: $('tRate').value,
    pricing_type: $('tPricing').value, expertise_time: $('tExpTime').value,
    accepts_time_exchange: $('tTimeEx').checked,
    cv_file_name: $('tFile').files[0] ? $('tFile').files[0].name : '',
  };
  try {
    const d = await api('/api/teacher-profile', { method: 'POST', body: JSON.stringify({ cv }) });
    showProfile(d.person, d.cv);
    msg($('teacherMsg'), 'Teacher profile saved — you are now in the teacher list.');
    loadAll();
  } catch (err) { msg($('teacherMsg'), err.message, false); }
};
function prefillTeacherForm(cv) {
  if (!cv) return;
  const set = (id, v) => { if (v) $(id).value = v; };
  set('tEducation', cv.education); set('tUniversity', cv.university); set('tProfession', cv.profession);
  set('tPosition', cv.position); set('tExperience', cv.experience); set('tSpeciality', cv.speciality);
  set('tSubjects', cv.subjects); set('tLevel', cv.level); set('tAddress', cv.address);
  set('tAvail', cv.available_time); set('tExpTime', cv.expertise_time);
  if (cv.pricing_type) $('tPricing').value = cv.pricing_type;
  if (cv.rate_bdt_per_hour) $('tRate').value = cv.rate_bdt_per_hour;
  $('tTimeEx').checked = !!Number(cv.accepts_time_exchange || 0);
}

/* ---------- sign in / profile ---------- */
$('signForm').onsubmit = async e => {
  e.preventDefault();
  try {
    const d = await api('/api/signin', { method: 'POST', body: JSON.stringify({ email: $('sEmail').value, password: $('sPass').value }) });
    saveToken(d.token); me = d.person; showProfile(d.person, d.cv);
    msg($('signMsg'), 'Welcome, ' + d.person.name);
    loadAll();
  } catch (err) { msg($('signMsg'), err.message, false); }
};
$('signOut').onclick = () => {
  token = ''; me = null; myTimeBalance = 0;
  localStorage.removeItem('microedu_token'); localStorage.removeItem('d2d_token');
  $('profileBox').classList.add('hidden');
  $('teacherCard').classList.add('hidden');
  $('adminCard').classList.add('hidden');
  msg($('signMsg'), 'Signed out');
};

/* ---------- microedu admin: extension approvals (site owner, member #1) ---------- */
async function loadExtensions() {
  try {
    const d = await api('/api/extensions');
    $('extList').innerHTML = d.extensions.length ? d.extensions.map(r => `<div class="req-card"><p><b>GID: ${esc(r.gid)}</b> · ${esc(r.subject)} — ${esc(r.topic)}<br>+${r.extension_minutes} min requested${r.class_start ? ' · Class: ' + esc(new Date(r.class_start).toLocaleString()) : ''}</p><button class="btn btn-primary btn-sm" onclick="approveExt('${r.gid}')">Approve +${r.extension_minutes} min</button></div>`).join('') : '<p class="muted">No extension requests waiting.</p>';
  } catch (e) { /* not the admin */ }
}
window.approveExt = async gid => { try { await api('/api/requests/extend/approve', { method: 'POST', body: JSON.stringify({ gid }) }); loadExtensions(); loadMine(); } catch (e) { alert(e.message); } };
function showProfile(p, cv) {
  if (!p) return;
  $('profileBox').classList.remove('hidden');
  $('teacherCard').classList.remove('hidden');
  fillPlans();
  if (p.id === 1) { $('adminCard').classList.remove('hidden'); loadExtensions(); }
  const isTeacher = !!(cv && Number(cv.teacher_ready || 0));
  const appear = p.photo_mode === 'anonymous' ? '🕶️ Anonymous (public lists hide your name & photo)'
    : p.photo_mode === 'group' ? '👥 Group' + (p.group_name ? ': ' + esc(p.group_name) : '')
    : '📷 Personal photo';
  $('profileContent').innerHTML = `<div class="t-head">${avatarHtml(p, true)}<div><h3>${esc(p.name)}</h3><small>${isTeacher ? '👩‍🏫 Teacher · ' : 'Member · '}${esc(p.email)}${p.phone ? ' · ' + esc(p.phone) : ''}</small><br><small>Appearing as: ${appear}</small></div></div>` +
    (isTeacher ? `<p class="t-meta" style="margin-top:12px">${esc(cv.education)}, ${esc(cv.university)} · ${esc(cv.profession)}${cv.position ? ' (' + esc(cv.position) + ')' : ''}<br>
    Experience: ${esc(cv.experience)} · Speciality: ${esc(cv.speciality)}<br>
    Subjects: ${esc(cv.subjects)} · Level: ${esc(cv.level)}<br>
    Price: <b>${esc(priceText(cv))}</b>${Number(cv.accepts_time_exchange || 0) ? ' · ⏳ Accepts time exchange' : ''}<br>
    Address: ${esc(cv.address)} · Available: ${esc(cv.available_time || '-')}${cv.expertise_time ? '<br>Expertise-wise time: ' + esc(cv.expertise_time) : ''} · CV file: ${esc(cv.cv_file_name || '-')}</p>`
    : '<p class="muted" style="margin-top:12px">You can learn from any teacher with this account. To teach, complete your teacher profile below.</p>');
  prefillTeacherForm(cv);
  loadTimebank();
}

/* ---------- subscription ---------- */
$('subBtn').onclick = async () => {
  try {
    const d = await api('/api/subscriptions', { method: 'POST', body: JSON.stringify({ plan: $('subPlan').value, months: $('subMonths').value }) });
    const s = d.subscription;
    $('subList').innerHTML = `<p>${esc(s.plan)} · ${s.months} month(s) · BDT ${s.amount_bdt} · Status: <b>${esc(s.status)}</b> <button class="btn btn-primary btn-sm" id="subConfirm">Confirm Payment</button></p>`;
    $('subConfirm').onclick = async () => {
      const c = await api('/api/subscriptions/confirm', { method: 'POST', body: JSON.stringify({ id: s.id }) });
      $('subList').innerHTML = `<p>${esc(c.subscription.plan)} · ${c.subscription.months} month(s) · BDT ${c.subscription.amount_bdt} · Status: <b>${esc(c.subscription.status)}</b></p>`;
      loadPeople();
    };
    msg($('subMsg'), 'Subscription created — Pending');
  } catch (e) { msg($('subMsg'), e.message, false); }
};

/* ---------- teachers & requests ---------- */
function calcTotal() { const h = Number($('qHours').value) || 1; $('qTotal').textContent = 'BDT ' + (h * 500); }
$('qHours').oninput = calcTotal;

function renderTeacherCard(t, suggested = false) {
  teacherPricing[t.id] = { pricing: (t.cv && t.cv.pricing_type) || 'hourly', rate: (t.cv && t.cv.rate_bdt_per_hour) || 500, acceptsTime: !!(t.cv && Number(t.cv.accepts_time_exchange || 0)) };
  const subjects = (t.cv && t.cv.subjects ? t.cv.subjects : '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 4);
  const matchNote = suggested && t.matched && t.matched.length ? `<p class="match-note">✨ Matches: ${esc(t.matched.join(', '))}</p>` : '';
  return `<div class="t-card${suggested ? ' suggested' : ''}">
    <div class="t-head">${avatarHtml(t)}<div><h3>${esc(displayName(t))}</h3><small>${esc(t.cv?.profession || '')}${t.cv?.university ? ' · ' + esc(t.cv.university) : ''}</small></div></div>
    <p class="t-meta">${esc(t.cv?.education || '')} · ${esc(t.cv?.experience || '')}${t.cv?.speciality ? '<br>Speciality: ' + esc(t.cv.speciality) : ''}</p>
    ${matchNote}
    <div class="chips">${subjects.map(s => `<span class="chip">${esc(s)}</span>`).join('')}${priceChip(t.cv)}${teacherPricing[t.id].acceptsTime ? '<span class="chip time-ex">⏳ Accepts time exchange</span>' : ''}</div>
    ${t.cv?.available_time || t.cv?.expertise_time ? `<p class="t-meta">🕒 ${esc(t.cv.expertise_time || t.cv.available_time)}</p>` : ''}
    <div class="t-foot"><span class="rate">${esc(priceText(t.cv))}</span><button class="btn btn-primary btn-sm" onclick="requestTeacher(${t.id})">Request</button></div>
  </div>`;
}
async function loadTeachers() {
  try {
    const d = await api('/api/teachers');
    $('teacherList').innerHTML = d.teachers.length ? d.teachers.map(t => renderTeacherCard(t)).join('') : '<p class="muted">No teachers yet — register free and complete your teacher profile to be the first.</p>';
  } catch (e) { /* list stays as-is */ }
}
$('suggestBtn').onclick = async () => {
  try {
    const qs = new URLSearchParams({ level: $('qLevel').value, subject: $('qSubject').value, chapter: $('qChapter').value, topic: $('qTopic').value });
    const d = await api('/api/suggest?' + qs.toString());
    $('suggestTitle').classList.remove('hidden');
    $('suggestList').innerHTML = d.teachers.length ? d.teachers.map(t => renderTeacherCard(t, true)).join('') : '<p class="muted">No teachers yet.</p>';
    $('suggestList').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (e) { msg($('reqMsg'), e.message, false); }
};
window.requestTeacher = async id => {
  const info = teacherPricing[id] || { pricing: 'hourly', rate: 500, acceptsTime: false };
  const payload = { teacher_id: id, level: $('qLevel').value, subject: $('qSubject').value, chapter: $('qChapter').value, topic: $('qTopic').value, hours: $('qHours').value, available_time: $('qTime').value, class_start: $('qStart').value ? new Date($('qStart').value).toISOString() : null };
  if (info.pricing === 'bidding') {
    const offer = prompt('This teacher works by bidding. Your offer for the whole class (BDT):', info.rate);
    if (offer === null) return;
    payload.offer_amount = Number(offer) || 0;
  } else if (info.acceptsTime && info.pricing !== 'free') {
    const need = Math.round((Number(payload.hours) || 1) * 60);
    if (myTimeBalance >= need && confirm(`Pay with your time-bank credit? This class needs ${fmtMins(need)} and you have ${fmtMins(myTimeBalance)}.\n\nOK = pay with time credit · Cancel = pay with money`)) {
      payload.pay_with = 'time';
    }
  }
  try {
    const d = await api('/api/requests', { method: 'POST', body: JSON.stringify(payload) });
    const paidNote = d.request.pay_with === 'time' ? `Paid with time credit (${fmtMins(Math.round((Number(d.request.hours) || 1) * 60))})` : `Amount: BDT ${d.request.amount_bdt}`;
    msg($('reqMsg'), `Request sent to microedu. GID: ${d.request.gid} · ${paidNote} · Status: Pending — microedu finalizes it from both sides, then your meeting is organized. The class link stays hidden; use the Join Class button at class time.`);
    loadMine();
  } catch (e) { msg($('reqMsg'), e.message, false); }
};
function tracker(r) {
  const steps = ['Pending', 'Confirm', 'Ongoing', 'Done'];
  const cur = steps.indexOf(r.status);
  return `<span class="tracker">${steps.map((s, i) => `<b class="${i <= cur ? 'on' : ''}">${s}</b>`).join('')}</span>`;
}
function escrowLine(r) {
  if (r.pay_with === 'time') {
    const t = { 'Held': ['held', 'Time credit reserved with microedu'], 'Released': ['released', 'Time credit given to the teacher'], 'Refunded': ['refunded', 'Time credit returned'] }[r.escrow_status] || ['unpaid', 'Time credit not reserved yet'];
    return `<span class="escrow ${t[0]}">⏳ ${fmtMins(Math.round((Number(r.hours) || 1) * 60))} · ${t[1]}</span>`;
  }
  if (Number(r.amount_bdt) === 0) {
    return r.escrow_status === 'Released'
      ? `<span class="escrow released">🎁 Free class — teacher earned ${fmtMins(Math.round((Number(r.hours) || 1) * 60))} time credit</span>`
      : '<span class="escrow held">🎁 Free class — no payment needed</span>';
  }
  const m = { 'Held': ['held', 'Paid — held with microedu'], 'Released': ['released', 'Released to the teacher'], 'Refunded': ['refunded', 'Refunded to the student'] }[r.escrow_status] || ['unpaid', 'Not paid yet'];
  return `<span class="escrow ${m[0]}">💰 BDT ${r.amount_bdt} · ${m[1]}</span>`;
}
async function loadMine() {
  if (!token) return;
  try {
    const d = await api('/api/my-requests');
    const render = (r, mine) => {
      const btns = [];
      if (r.status !== 'Done' && r.status !== 'Cancelled') btns.push(`<button class="btn btn-primary btn-sm" onclick="advance('${r.gid}','${r.status === 'Pending' ? 'Confirm' : r.status === 'Confirm' ? 'Ongoing' : 'Done'}')">${r.status === 'Pending' ? 'Confirm Payment' : r.status === 'Confirm' ? 'Start (Ongoing)' : 'Mark Done'}</button>`);
      if (['Confirm', 'Ongoing'].includes(r.status)) btns.push(`<button class="btn btn-orange btn-sm" onclick="joinClass('${r.gid}')">Join Class</button>`);
      if (['Confirm', 'Ongoing'].includes(r.status) && r.extension_status !== 'Requested') btns.push(`<button class="btn btn-ghost btn-sm" onclick="extendReq('${r.gid}')">Request +30 min</button>`);
      if (mine === 'student' && r.escrow_status === 'Held' && r.status !== 'Done') btns.push(`<button class="btn btn-ghost btn-sm" onclick="refundReq('${r.gid}')">Problem? Refund to me</button>`);
      const when = r.class_start ? `<br>🗓️ ${esc(new Date(r.class_start).toLocaleString())} · ${r.hours} hr` : (r.available_time ? `<br>🗓️ ${esc(r.available_time)}` : '');
      const ext = r.extension_status === 'Requested' ? '<p class="muted">⏳ Extension requested — waiting for microedu</p>' : r.extension_status === 'Approved' ? `<p class="muted">✅ Extra ${r.extension_minutes} min approved by microedu</p>` : '';
      return `<div class="req-card"><p><b>GID: ${esc(r.gid)}</b> · ${esc(r.subject)} — ${esc(r.topic)}<br>${r.hours} hr × BDT ${r.rate_bdt_per_hour} = <b>BDT ${r.amount_bdt}</b>${when}</p>${tracker(r)}<p>${escrowLine(r)}</p>${ext}${btns.length ? `<p style="display:flex;gap:8px;flex-wrap:wrap">${btns.join('')}</p>` : ''}</div>`;
    };
    $('myRequests').innerHTML = d.asStudent.map(r => render(r, 'student')).join('') || '<p class="muted">None yet</p>';
    $('teacherReqs').innerHTML = d.asTeacher.map(r => render(r, 'teacher')).join('') || '<p class="muted">None yet</p>';
    loadWallet();
  } catch (e) { /* not signed in */ }
}
window.joinClass = async gid => { try { const d = await api('/api/requests/join', { method: 'POST', body: JSON.stringify({ gid }) }); window.open(d.class_link, '_blank'); } catch (e) { alert(e.message); } };
window.extendReq = async gid => { try { await api('/api/requests/extend', { method: 'POST', body: JSON.stringify({ gid, minutes: 30 }) }); alert('Extension requested — microedu will approve it.'); loadMine(); } catch (e) { alert(e.message); } };
window.refundReq = async gid => { if (!confirm('Refund this class in full? The booking will be cancelled.')) return; try { await api('/api/payments/refund', { method: 'POST', body: JSON.stringify({ gid }) }); loadMine(); } catch (e) { alert(e.message); } };
window.advance = async (gid, status) => { try { await api('/api/payments/confirm', { method: 'POST', body: JSON.stringify({ gid, status }) }); loadMine(); } catch (e) { alert(e.message); } };

/* ---------- time bank ---------- */
async function loadTimebank() {
  if (!token) return;
  try {
    const d = await api('/api/timebank');
    myTimeBalance = Number(d.balance_minutes) || 0;
    $('tbBalance').textContent = fmtMins(myTimeBalance);
    $('tbEntries').innerHTML = d.entries.map(en => `<p>${en.kind === 'earn' ? '➕ Earned' : '➖ Spent'} ${fmtMins(Math.abs(en.minutes))} — ${esc(en.topic || 'Class')} ${en.gid ? '(' + esc(en.gid) + ')' : ''}</p>`).join('') || '<p class="muted">No entries yet — teach a free class to earn time credit.</p>';
  } catch (e) { /* not signed in */ }
}

/* ---------- wallet & feedback ---------- */
async function loadWallet() {
  if (!token) return;
  try {
    const d = await api('/api/wallet');
    $('wBalance').textContent = 'BDT ' + d.balance;
    $('wEntries').innerHTML = d.entries.map(en => `<p>${esc(en.topic || '')} ${en.gid ? '(' + esc(en.gid) + ')' : ''} — BDT ${en.amount_bdt} (${esc(en.kind)})</p>`).join('') || '<p class="muted">No entries</p>';
  } catch (e) { /* not signed in */ }
}
$('wBtn').onclick = async () => { try { const d = await api('/api/wallet/withdraw', { method: 'POST', body: JSON.stringify({ amount: $('wAmt').value }) }); msg($('wMsg'), 'Withdrawn. New balance: BDT ' + d.balance); loadWallet(); } catch (e) { msg($('wMsg'), e.message, false); } };
document.querySelectorAll('#fStars span').forEach(s => s.onclick = () => { myRanking = Number(s.dataset.v); document.querySelectorAll('#fStars span').forEach(x => x.classList.toggle('on', Number(x.dataset.v) <= myRanking)); });
$('fBtn').onclick = async () => { try { await api('/api/feedback', { method: 'POST', body: JSON.stringify({ gid: $('fGid').value, comment: $('fComment').value, ranking: myRanking, complain: $('fComplain').value }) }); msg($('fMsg'), 'Feedback saved'); } catch (e) { msg($('fMsg'), e.message, false); } };

/* ---------- people & stats ---------- */
async function loadPeople() {
  try {
    const d = await api('/api/people');
    $('peopleCounts').textContent = `Total members: ${d.total} · Teachers: ${d.counts.teachers} · Teach for time exchange: ${d.counts.time_teachers}`;
    $('statTeachers').textContent = d.counts.teachers;
    $('statStudents').textContent = d.total;
    $('statTotal').textContent = d.counts.time_teachers;
    $('peopleBody').innerHTML = d.people.map(p => `<tr><td>${p.id}</td><td>${p.cv && Number(p.cv.teacher_ready || 0) ? '👩‍🏫 Teacher' : 'Member'}</td><td>${!p.anonymous && p.photo_data ? `<img class="thumb" src="${p.photo_data}" alt=""> ` : ''}${esc(displayName(p))}</td><td>${esc(p.email || '—')}</td><td>${esc(p.cv?.education || '')}</td><td>${esc(p.cv?.university || '')}</td><td>${esc(p.cv?.profession || '')}</td><td>${esc(p.cv?.experience || '')}</td><td>${p.subscription ? esc(p.subscription.plan) + ' (' + esc(p.subscription.status) + ')' : ''}</td></tr>`).join('');
  } catch (e) { /* table stays as-is */ }
}
$('refreshPeople').onclick = loadPeople;

function loadAll() { loadTeachers(); loadPeople(); loadMine(); }
loadAll();

/* ---------- language switcher (EN / বাংলা) ----------
   English originals are captured from the DOM at load, so only the
   Bengali strings live here. Static page text only; dynamic messages
   and teacher cards stay in English in this version. */
const BN = {
  announce: 'আগাম পেমেন্ট করুন <b>bKash</b>-এ &nbsp;·&nbsp; কোনো সমস্যা হলে সম্পূর্ণ টাকা ফেরত &nbsp;·&nbsp; যেকোনো বিষয়ের যেকোনো অংশে সাহায্য, যেকোনো সময়',
  navHow: 'কীভাবে কাজ করে', navFind: 'শিক্ষক খুঁজুন', navSub: 'সাবস্ক্রিপশন', navPeople: 'নিবন্ধিত সদস্য', navHelp: 'আমার সাহায্য লাগবে',
  helpEyebrow: '— আমার সাহায্য লাগবে', helpTitle: 'কোথায় <span class="u-line">আটকে</span> আছেন বলুন।',
  helpSub: 'আপনার লেভেল, বিষয় আর নির্দিষ্ট টপিক লিখুন। microedu মিলিয়ে শিক্ষক সাজেস্ট করবে — তারপর রিকোয়েস্ট পাঠান microedu-র কাছে, আমরা দুই পক্ষ থেকে ফাইনাল করে আপনার মিটিং আয়োজন করে দেব। তার আগে কোনো সরাসরি যোগাযোগ নেই।',
  suggestBtn: '✨ আমার জন্য শিক্ষক সাজেস্ট করুন', suggestTitle: 'আপনার জন্য সাজেস্ট করা',
  regNote: 'আপাতত এটুকুই — এই অ্যাকাউন্ট দিয়েই যেকোনো শিক্ষকের কাছে শিখতে পারবেন। পড়াতে চাইলে সাইন ইন করে ড্যাশবোর্ড থেকে শিক্ষক প্রোফাইল সম্পূর্ণ করুন।',
  teacherCardTitle: '👩‍🏫 শিক্ষক হোন — আপনার প্রোফাইল সম্পূর্ণ করুন',
  teacherCardNote: 'প্রতিটি ঘর পূরণ করা বাধ্যতামূলক — ছাত্রদের প্রতি শিক্ষকের দায়বদ্ধতা থাকে। সেভ করলেই আপনার নিজের রেটসহ আপনি শিক্ষক তালিকায় আসবেন। দামের কোনো সিলিং নেই: ঘণ্টা হিসেবে, বিডিংয়ে, অথবা সম্পূর্ণ ফ্রি — যেভাবে খুশি পড়ান।',
  timeExLabel: 'আমি টাইম এক্সচেঞ্জে রাজি — ছাত্ররা তাদের টাইম-ব্যাংক ক্রেডিট দিয়ে আমার কাছে শিখতে পারবে, আর ফ্রি পড়ালে আমার টাইম ক্রেডিট জমবে',
  saveTeacherBtn: 'আমার শিক্ষক প্রোফাইল সেভ করুন',
  timeBankTitle: 'আমার টাইম ব্যাংক', lblTimeBalance: 'টাইম ক্রেডিট:',
  timeBankNote: 'ফ্রি ক্লাস পড়ালেই সেই সময় এখানে জমবে। যেসব শিক্ষক টাইম এক্সচেঞ্জে রাজি, তাদের কাছে এই ক্রেডিট দিয়ে শিখতে পারবেন।',
  basicPlanText: 'শেখা শুরু করা শিক্ষার্থীদের জন্য', plusPlanText: 'নিয়মিত শিক্ষার্থী ও নতুন শিক্ষকদের জন্য', teacherPlusText: 'যেসব শিক্ষক নিয়মিত পড়ান তাদের জন্য',
  signInBtn: 'সাইন ইন', joinFree: 'ফ্রি যোগ দিন',
  heroPill: '🎓 মাইক্রো এডু. সাপোর্ট — লাইভ ১-টু-১ অনলাইন টিউশন',
  heroTitle: 'একটা টপিকে আটকে গেছেন?<br>আসল শিক্ষকের কাছে <span class="u-line">লাইভ</span> শিখুন।',
  heroLead: 'একবার রেজিস্টার করুন, যাচাই করা শিক্ষক বেছে নিন, ঠিক কোন অধ্যায় বা টপিকে আটকে আছেন তা লিখুন — আর আপনার সময়ে লাইভ ক্লাসে যোগ দিন। যেকোনো বিষয়, যেকোনো লেভেল, বাংলাদেশের যেকোনো জায়গা থেকে।',
  heroFind: 'শিক্ষক খুঁজুন →', heroJoinTeacher: 'শিক্ষক হিসেবে যোগ দিন',
  heroP1: '✔ যাচাই করা শিক্ষকের সিভি', heroP2: '✔ ঘণ্টায় মাত্র ৫০০ টাকা থেকে', heroP3: '✔ সম্পূর্ণ টাকা ফেরতের গ্যারান্টি',
  fc1t: 'বিশ্বস্ত শিক্ষক', fc1s: 'প্রতিটি প্রোফাইলে বিস্তারিত সিভি',
  fc2t: 'লাইভ ক্লাসের লিংক', fc2s: 'Google Meet, আপনার সময়ে',
  feat1t: 'যেকোনো বিষয়ের যেকোনো অংশ', feat1p: 'একটা গ্রাফ, একটা অধ্যায়, একটা কঠিন টপিক — ঠিক যে অংশে আটকে আছেন সেটুকুই চান। পুরো কোর্স লাগবে না।',
  feat2t: 'আগে পেমেন্ট, ঝুঁকি নেই', feat2p: 'bKash-এ আগাম পেমেন্ট করুন। ক্লাসে কোনো সমস্যা হলে সম্পূর্ণ টাকা ফেরত পাবেন। সহজ ও নিরাপদ।',
  feat3t: 'আপনার সময়ে', feat3p: 'শিক্ষককে জানান কখন আপনি ফ্রি আছেন। সকাল, সন্ধ্যা বা গভীর রাত — ক্লাস হবে আপনার সুবিধামতো সময়ে।',
  howEyebrow: '— কীভাবে কাজ করে', howTitle: 'তিন ধাপেই আপনার <span class="u-line">ক্লাস</span>।',
  step1t: 'একবার রেজিস্টার করুন — ফ্রি', step1p: 'একটি সহজ ফর্ম — নাম, ইমেইল, ফোন। ছাত্র/শিক্ষক আলাদা নয়: যে কেউ শিখতে পারে, আর শিক্ষক প্রোফাইল সম্পূর্ণ করলেই যে কেউ পড়াতে পারে।',
  step2t: 'শিক্ষক ও টপিক বেছে নিন', step2p: 'একজন শিক্ষক বেছে নিন, আপনার লেভেল, বিষয়, অধ্যায় ও নির্দিষ্ট টপিক লিখুন, আর ঘণ্টা ও সময় ঠিক করুন।',
  step3t: 'পেমেন্ট করে ক্লাসে যোগ দিন', step3p: 'পেমেন্ট নিশ্চিত করুন, ক্লাসের স্ট্যাটাস দেখুন — Pending → Confirm → Ongoing → Done — আর ক্লাস লিংক দিয়ে যোগ দিন।',
  startNow: 'এখনই শুরু করুন →',
  studentEyebrow: '— ছাত্রদের জন্য', findTitle: 'আপনার <span class="u-line">শিক্ষক</span> খুঁজুন।',
  findSub: 'সব শিক্ষক দেখুন, অথবা উপরের <b>আমার সাহায্য লাগবে</b> অংশে আপনার টপিক অনুযায়ী সাজেশন নিন। <b>Request</b> চাপলেই আপনার রিকোয়েস্ট microedu-র কাছে যাবে।',
  reqCardTitle: 'আপনার কীসে সাহায্য দরকার?',
  lblLevel: 'লেভেল', lblSubject: 'বিষয়', lblChapter: 'অধ্যায়', lblTopic: 'টপিক', lblHours: 'ঘণ্টা', lblYourTime: 'আপনার ফ্রি সময়',
  phTime: 'আজ সন্ধ্যা ৭টা', estTotal: 'আনুমানিক মোট:', estNote: '(চূড়ান্ত মূল্য নির্ভর করবে আপনার শিক্ষকের নিজের রেটের ওপর)',
  teachersTitle: 'আমাদের শিক্ষকগণ', myReqTitle: 'আমার রিকোয়েস্টসমূহ',
  statsTitle: 'বাংলাদেশে বাড়তে থাকা একটি শিক্ষা কমিউনিটি',
  statTeachers: 'নিবন্ধিত শিক্ষক', statStudents: 'নিবন্ধিত সদস্য', statTotal: 'সময়ের বদলে শেখান', statRate: 'টাকা/ঘণ্টা থেকে শুরু',
  whyEyebrow: '— কেন microedu.com', whyTitle: 'আসল শিক্ষক, আসল <span class="u-line">সিভি</span>, আসল ক্লাস।',
  whySub: 'প্রতিটি সদস্য বিস্তারিত সিভি দিয়ে রেজিস্টার করেন — শিক্ষা, বিশ্ববিদ্যালয়, অভিজ্ঞতা, বিশেষ দক্ষতা ও বিষয়। শিক্ষকের কার্ডে যা দেখবেন, ঠিক সেটাই তিনি রেজিস্টার করেছেন।',
  tick1: 'প্রতিটি শিক্ষকের প্রোফাইলের পেছনে বিস্তারিত সিভি',
  tick2: 'প্রতিটি ক্লাসে পরিষ্কার স্ট্যাটাস: Pending → Confirm → Ongoing → Done',
  tick3: 'শিক্ষকের আয় জমে ওয়ালেটে, যেকোনো সময় উত্তোলন',
  tick4: 'ক্লাসের পর ছাত্ররা রেটিং, রিভিউ ও অভিযোগ জানাতে পারে',
  meetTeachers: 'শিক্ষকদের দেখুন →',
  subEyebrow: '— সাবস্ক্রিপশন', subTitle: 'সবার জন্য সহজ <span class="u-line">প্ল্যান</span>।',
  subSubText: 'প্রতিটি সদস্যের জন্য একটি প্ল্যান তালিকা — একই অ্যাকাউন্টে শিখুন ও পড়ান। মেয়াদ বেছে নিন ১, ৩, ৬ বা ১২ মাস। স্ট্যাটাস শুরু হয় Pending দিয়ে — কনফার্ম করলেই সক্রিয়।',
  perMonth: '/মাস', popular: 'জনপ্রিয়',
  lblPlan: 'প্ল্যান', lblDuration: 'মেয়াদ (মাস)', subscribeBtn: 'সাবস্ক্রাইব করুন',
  joinEyebrow: '— শিক্ষক হিসেবে যোগ দিন', joinTitle: 'যা জানেন তাই পড়ান।<br>আর <span class="u-line">আয়</span> করুন।',
  joinSub: 'এক মিনিটে ফ্রি রেজিস্টার করুন, তারপর ড্যাশবোর্ড থেকে শিক্ষক প্রোফাইল সম্পূর্ণ করুন। নিজের রেট নিজে ঠিক করুন — ঘণ্টা হিসেবে, বিডিংয়ে, অথবা সম্পূর্ণ ফ্রি। ফ্রি পড়ালে সময়টা জমবে আপনার টাইম ব্যাংকে, অন্য শিক্ষকের কাছে শেখার জন্য।',
  regTeacherBtn: 'শিক্ষক হিসেবে রেজিস্টার করুন →',
  regEyebrow: '— রেজিস্ট্রেশন', regTitle: 'সবার জন্য একটি <span class="u-line">ফর্ম</span>।',
  regSub: 'শুধু নাম, ইমেইল আর ফোন — এক মিনিটে রেজিস্টার করে এখনই শেখা শুরু করুন। ছাত্র/শিক্ষক আলাদা নয়। পড়াতে চাইলে পরে ড্যাশবোর্ড থেকে শিক্ষক প্রোফাইল সম্পূর্ণ করুন।',
  photoQ: 'আপনি কীভাবে দেখাতে চান?',
  photoPersonal: 'আমার ছবি', photoPersonalSub: 'আপনার নিজের প্রোফাইল ছবি',
  photoGroup: 'গ্রুপ ছবি', photoGroupSub: 'কোনো গ্রুপ / টিমের জন্য',
  photoAnon: 'অজ্ঞাত (Anonymous)', photoAnonSub: 'নাম ও ছবি লুকানো থাকবে',
  lblPhoto: 'ছবি', lblGroupName: 'গ্রুপের নাম (গ্রুপ ছবি হলে)', phGroupName: 'যেমন: Dhaka Study Circle',
  cvTitle: 'আপনার বিস্তারিত সিভি', mandatory: '(বাধ্যতামূলক)',
  lblFullName: 'পুরো নাম *', phName: 'আপনার পুরো নাম', lblEmail: 'ইমেইল *', phEmail: 'you@example.com',
  lblPassword: 'পাসওয়ার্ড *', phPass: 'একটি পাসওয়ার্ড দিন', lblPassword2: 'আবার পাসওয়ার্ড *', phPass2: 'একই পাসওয়ার্ড আবার',
  lblPhone: 'ফোন', lblMobile: 'মোবাইল', phPhone: '01XXXXXXXXX',
  lblEducation: 'শিক্ষাগত যোগ্যতা *', phEducation: 'মাস্টার্স সম্পন্ন / অনার্স সম্পন্ন',
  lblUniversity: 'বিশ্ববিদ্যালয় / প্রতিষ্ঠান *', phUniversity: 'ঢাকা বিশ্ববিদ্যালয়',
  lblProfession: 'পেশা *', phProfession: 'শিক্ষক / ছাত্র / প্রকৌশলী',
  lblPosition: 'পদবি', phPosition: 'প্রভাষক, SSC পরীক্ষার্থী…',
  lblExperience: 'অভিজ্ঞতা *', phExperience: '৫ বছর পড়ানোর অভিজ্ঞতা',
  lblSpeciality: 'বিশেষ দক্ষতা / স্কিল *', phSpeciality: 'পরিসংখ্যান, Excel, ইংরেজি',
  lblSubjects: 'বিষয়সমূহ *', phSubjects: 'পরিসংখ্যান, Excel',
  lblLevelCv: 'লেভেল *', phLevelCv: 'অনার্স / HSC / SSC',
  lblAddress: 'ঠিকানা *', phAddress: 'জেলা, বিভাগ',
  lblAvail: 'প্রতিদিনের ফ্রি সময়', phAvail: 'সন্ধ্যা ৬টা – রাত ১০টা',
  lblPricing: 'আপনি কীভাবে চার্জ করবেন?', priceHourly: 'ঘণ্টার রেট', priceBidding: 'বিডিং (ছাত্ররা দাম প্রস্তাব করবে)', priceFree: 'ফ্রি সার্ভিস',
  lblClassTime: 'ক্লাসের তারিখ ও সময়', joinNote: 'ক্লাসের লিংক লুকানো থাকে — আপনি ও আপনার শিক্ষক শুধু এই সময়ে Join Class বোতাম দিয়ে ঢুকতে পারবেন।',
  adminTitle: '🛡️ microedu অ্যাডমিন — সময় বাড়ানোর অনুরোধ',
  lblRate: 'রেট (টাকা / ঘণ্টা)',
  lblExpTime: 'বিষয়ভিত্তিক সময়', phExpTime: 'পরিসংখ্যান: শনি–বৃহস্পতি সন্ধ্যা ৬–৮টা · Excel: শুক্রবার সকাল ১০টা–১২টা',
  lblCvFile: 'সিভি ফাইল (ফাইলের নাম সংরক্ষিত হয়)', regSubmit: 'রেজিস্টার করুন — সম্পূর্ণ ফ্রি',
  dashEyebrow: '— আমার ড্যাশবোর্ড', dashTitle: 'আবার <span class="u-line">স্বাগতম</span>।',
  phYourPass: 'আপনার পাসওয়ার্ড', signOutBtn: 'সাইন আউট', myProfile: 'আমার প্রোফাইল (আমার সিভি থেকে)',
  walletTitle: 'আমার ওয়ালেট', forTeachers: '(শিক্ষকদের জন্য)', lblBalance: 'ব্যালেন্স:',
  lblWithdrawAmt: 'উত্তোলনের পরিমাণ (টাকা)', withdrawBtn: 'উত্তোলন করুন',
  reqToMeTitle: 'আমার কাছে আসা রিকোয়েস্ট', feedbackTitle: '⭐ মূল্যায়ন / ফিডব্যাক',
  lblGid: 'ক্লাস GID', lblComment: 'মন্তব্য', phComment: 'ক্লাস কেমন ছিল?',
  lblRanking: 'র্যাংকিং', lblComplain: 'অভিযোগ', phComplain: 'কোনো সমস্যা? জানান — সমস্যা থাকলে সম্পূর্ণ টাকা ফেরত',
  feedbackBtn: 'ফিডব্যাক জমা দিন',
  peopleEyebrow: '— কমিউনিটি', peopleTitle: 'নিবন্ধিত <span class="u-line">সদস্য</span>।',
  thId: 'আইডি', thRole: 'ধরন', thName: 'নাম', thEmail: 'ইমেইল', thEducation: 'শিক্ষা', thUniversity: 'বিশ্ববিদ্যালয়', thProfession: 'পেশা', thExperience: 'অভিজ্ঞতা', thSubscription: 'সাবস্ক্রিপশন',
  refreshBtn: 'রিফ্রেশ',
  ctaTitle: 'আপনার পরের ক্লাস মাত্র এক টপিক দূরে।', ctaSub: 'ঠিক কোন অংশে আটকে আছেন তা জানান — বাকিটা শিক্ষক সামলে নেবেন।', ctaBtn: 'microedu.com-এ যোগ দিন — ফ্রি',
  footAbout: 'মাইক্রো এডু. সাপোর্ট — বাংলাদেশজুড়ে যাচাই করা শিক্ষকদের কাছ থেকে যেকোনো বিষয়ের যেকোনো অংশে, যেকোনো সময় সরাসরি অনলাইন টিউশন সাপোর্ট।',
  footExplore: 'ঘুরে দেখুন', regLink: 'রেজিস্ট্রেশন', footKnow: 'জেনে রাখুন',
  know1: '💳 bKash-এ আগাম পেমেন্ট', know2: '🛡️ সমস্যা হলে সম্পূর্ণ টাকা ফেরত', know3: '📍 ঢাকা, বাংলাদেশ', know4: '🕒 আপনার ফ্রি সময়ে সাপোর্ট',
  footCopy: '© ২০২৬ microedu.com — মাইক্রো এডু. সাপোর্ট', footTag: 'সবার জন্য একটি রেজিস্ট্রেশন — একই অ্যাকাউন্টে শিখুন ও পড়ান',
};
const i18nOriginals = [];
function captureOriginals() {
  document.querySelectorAll('[data-i18n]').forEach(el => i18nOriginals.push([el, 'text', el.textContent]));
  document.querySelectorAll('[data-i18n-html]').forEach(el => i18nOriginals.push([el, 'html', el.innerHTML]));
  document.querySelectorAll('[data-i18n-ph]').forEach(el => i18nOriginals.push([el, 'ph', el.getAttribute('placeholder') || '']));
}
function applyLang(lang) {
  for (const [el, kind, orig] of i18nOriginals) {
    const key = el.getAttribute(kind === 'text' ? 'data-i18n' : kind === 'html' ? 'data-i18n-html' : 'data-i18n-ph');
    const val = lang === 'bn' && BN[key] !== undefined ? BN[key] : orig;
    if (kind === 'text') el.textContent = val;
    else if (kind === 'html') el.innerHTML = val;
    else el.setAttribute('placeholder', val);
  }
  document.documentElement.lang = lang === 'bn' ? 'bn' : 'en';
  $('langEn').classList.toggle('sel', lang !== 'bn');
  $('langBn').classList.toggle('sel', lang === 'bn');
  localStorage.setItem('microedu_lang', lang);
}
captureOriginals();
$('langEn').onclick = () => applyLang('en');
$('langBn').onclick = () => applyLang('bn');
if (localStorage.getItem('microedu_lang') === 'bn') applyLang('bn');
