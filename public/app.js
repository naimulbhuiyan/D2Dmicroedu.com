'use strict';
/* microedu.com — frontend logic. Same API contract as before; new design,
   photo / group / anonymous registration, hourly / bidding / free pricing. */
const $ = id => document.getElementById(id);
/* Multi-page guards: each page carries only its own sections, so every
   binding/write goes through these helpers and quietly skips missing elements. */
const on = (id, ev, fn) => { const el = $(id); if (el) el[ev] = fn; };
const setText = (id, v) => { const el = $(id); if (el) el.textContent = v; };
const setHtml = (id, v) => { const el = $(id); if (el) el.innerHTML = v; };
const hideEl = (id, hide = true) => { const el = $(id); if (el) el.classList.toggle('hidden', hide); };
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
function saveToken(t) { token = t; localStorage.setItem('microedu_token', t); localStorage.setItem('microedu_login_at', String(Date.now())); localStorage.removeItem('d2d_token'); }
/* Auto sign-out: a login lasts at most 12 hours (the server enforces the
   same limit; this clears the screen the moment the time is up). */
const SESSION_MS = 12 * 3600 * 1000;
function checkSessionExpiry() {
  if (!token) return;
  const at = Number(localStorage.getItem('microedu_login_at') || 0);
  if (!at) { localStorage.setItem('microedu_login_at', String(Date.now())); return; }
  if (Date.now() - at > SESSION_MS) {
    token = '';
    localStorage.removeItem('microedu_token'); localStorage.removeItem('d2d_token'); localStorage.removeItem('microedu_login_at');
    sessionStorage.setItem('microedu_expired', '1');
    location.reload();
  }
}
setInterval(checkSessionExpiry, 60000);
checkSessionExpiry();
if (sessionStorage.getItem('microedu_expired')) { sessionStorage.removeItem('microedu_expired'); setTimeout(() => alert('For safety, you were signed out after 12 hours. Please sign in again.'), 300); }
function fillPlans() { const s = $('subPlan'); if (s) s.innerHTML = PLANS.map(p => `<option>${p}</option>`).join(''); }
fillPlans();
const fmtMins = m => { m = Math.round(Number(m) || 0); const h = Math.floor(m / 60), r = m % 60; return h ? `${h}h ${r}m` : `${r}m`; };

/* Bilingual text for strings rendered by JavaScript (1.1–2.2): pick the
   visitor's language. Bangla is the default when no choice is stored
   (Decision B) — stored 'en' is the only thing that switches to English. */
function curLang() { return localStorage.getItem('microedu_lang') === 'en' ? 'en' : 'bn'; }
const L = o => (o && (o[curLang()] || o.en)) || '';
/* Return to the page the visitor came from after signing in or
   registering (Section 7): stored as a full path, e.g. /help?level=... */
function setReturnTo(path) { try { sessionStorage.setItem('microedu_return_to', path); } catch (e) { /* ignore */ } }
function takeReturnTo() {
  try { const to = sessionStorage.getItem('microedu_return_to'); if (to) { sessionStorage.removeItem('microedu_return_to'); return to; } } catch (e) { /* ignore */ }
  return null;
}
/* Copy a value (bKash number / exact amount) to the clipboard, with a
   short "Copied ✓" on the button itself (1.4). */
async function copyText(txt, btn) {
  let ok = false;
  try { await navigator.clipboard.writeText(txt); ok = true; }
  catch (e) {
    try { const ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta); ta.select(); ok = document.execCommand('copy'); ta.remove(); } catch (e2) { /* ignore */ }
  }
  if (btn) {
    const old = btn.textContent;
    btn.textContent = ok ? '✓ ' + L({ en: 'Copied', bn: 'কপি হয়েছে' }) : L({ en: 'Copy failed — long-press to copy', bn: 'কপি হয়নি — চেপে ধরে কপি করুন' });
    setTimeout(() => { btn.textContent = old; }, 1600);
  }
  return ok;
}
window.copyText = copyText;
/* Subject chips on I Need Help (1.3): one tap fills the subject with
   its English name, because matching runs against English CVs. */
window.setSubject = v => { const s = $('qSubject'); if (s) { s.value = v; saveHelpDraft(); s.focus(); } };
/* Fill the bKash sender number from the signed-in member's profile
   (1.4) — only into boxes the member has not typed in yet. */
function prefillSenderInputs() {
  if (!me) return;
  const v = me.mobile || me.phone || '';
  if (!v) return;
  document.querySelectorAll('[data-sender-input]').forEach(el => { if (!el.value) el.value = v; });
}

/* ---------- how a member appears: name / group name / anonymous ----------
   Photos are not used on microedu (removed by decision, 22 Nov 2026) —
   everyone is shown by name with an initials avatar, or anonymously. */
function photoMode() { const r = document.querySelector('input[name="photoMode"]:checked'); return r ? r.value : 'personal'; }
document.querySelectorAll('input[name="photoMode"]').forEach(r => r.onchange = () => {
  const gw = $('groupNameWrap'); if (gw) gw.classList.toggle('hidden', photoMode() !== 'group');
});

/* ---------- pricing choice (teacher profile form) ---------- */
on('tPricing', 'onchange', () => {
  const v = $('tPricing').value;
  $('tRateLabel').textContent = v === 'bidding' ? 'Starting bid (BDT)' : 'Rate (BDT / hour)';
  $('tRate').disabled = v === 'free';
  if (v === 'free') $('tRate').value = 0; else if (!$('tRate').value || Number($('tRate').value) === 0) $('tRate').value = 500;
});
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
on('regForm', 'onsubmit', async e => {
  e.preventDefault();
  if ($('rPass').value !== $('rPass2').value) return msg($('regMsg'), 'Passwords do not match', false);
  const mode = photoMode();
  try {
    const d = await api('/api/register', { method: 'POST', body: JSON.stringify({
      name: $('rName').value, email: $('rEmail').value, password: $('rPass').value,
      phone: $('rPhone').value, mobile: $('rMobile').value,
      picture: $('rPhotoFile').files[0] ? $('rPhotoFile').files[0].name : '',
      photo_mode: mode, group_name: $('rGroupName').value,
      photo_data: '',
    }) });
    saveToken(d.token); me = d.person; showProfile(d.person, d.cv);
    showRegSuccess(d.person);
    /* Came from another page to register? Go back there after a moment. */
    const to = takeReturnTo();
    if (to) setTimeout(() => { location.href = to; }, 2500);
    loadAll();
  } catch (err) { msg($('regMsg'), err.message, false); }
});
/* Smart welcome after registration: clear next steps, one tap each way. */
function showRegSuccess(p) {
  const el = $('regMsg');
  el.className = 'msg ok success-box';
  el.innerHTML = `🎉 <b>Welcome to microedu, ${esc(p.name)}!</b> Your account is ready and you are signed in.<br>` +
    `You can learn from any teacher right now — or teach and earn. What would you like to do?<br>` +
    `<span class="success-btns"><button type="button" class="btn btn-orange" onclick="goHelp()">🔍 I need help — find me a teacher</button>` +
    `<button type="button" class="btn btn-primary" onclick="goTeach()">👩‍🏫 Become a teacher — complete my profile</button></span>`;
  setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'center' }), 60);
}
window.goHelp = () => { location.href = 'help'; };
window.goTeach = () => {
  const c = $('teacherCard');
  if (!c) { location.href = 'dashboard#teacher'; return; }
  c.classList.remove('hidden');
  c.scrollIntoView({ behavior: 'smooth', block: 'start' });
  c.classList.add('flash');
  setTimeout(() => c.classList.remove('flash'), 2600);
};

/* ---------- teacher profile (step 2: complete profile to teach) ---------- */
on('teacherForm', 'onsubmit', async e => {
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
    clearTeacherDraft();
    msg($('teacherMsg'), 'Teacher profile saved — you are now in the teacher list.');
    loadAll();
  } catch (err) { msg($('teacherMsg'), err.message, false); }
});
function prefillTeacherForm(cv) {
  if (!cv) return;
  const set = (id, v) => { const el = $(id); if (el && v) el.value = v; };
  set('tEducation', cv.education); set('tUniversity', cv.university); set('tProfession', cv.profession);
  set('tPosition', cv.position); set('tExperience', cv.experience); set('tSpeciality', cv.speciality);
  set('tSubjects', cv.subjects); set('tLevel', cv.level); set('tAddress', cv.address);
  set('tAvail', cv.available_time); set('tExpTime', cv.expertise_time);
  if (cv.pricing_type && $('tPricing')) $('tPricing').value = cv.pricing_type;
  if (cv.rate_bdt_per_hour && $('tRate')) $('tRate').value = cv.rate_bdt_per_hour;
  if ($('tTimeEx')) $('tTimeEx').checked = !!Number(cv.accepts_time_exchange || 0);
}

/* ---------- sign in / profile ---------- */
on('signForm', 'onsubmit', async e => {
  e.preventDefault();
  try {
    const d = await api('/api/signin', { method: 'POST', body: JSON.stringify({ email: $('sEmail').value, password: $('sPass').value }) });
    saveToken(d.token); me = d.person; showProfile(d.person, d.cv);
    msg($('signMsg'), 'Welcome, ' + d.person.name);
    /* Came from another page without signing in? Go back there. */
    const to = takeReturnTo();
    if (to) { setTimeout(() => { location.href = to; }, 500); return; }
    /* Came from "I Need Help" without signing in? Continue to the form. */
    if (sessionStorage.getItem('microedu_after_login') === 'help') {
      sessionStorage.removeItem('microedu_after_login');
      setTimeout(() => { location.href = 'help'; }, 500);
      return;
    }
    loadAll();
  } catch (err) { msg($('signMsg'), err.message, false); }
});
/* ---------- forgot password (request goes to microedu admin) ---------- */
on('forgotToggle', 'onclick', () => { const f = $('forgotForm'); if (f) f.classList.toggle('hidden'); });
on('forgotForm', 'onsubmit', async e => {
  e.preventDefault();
  try {
    await api('/api/password/forgot', { method: 'POST', body: JSON.stringify({ email: $('fpEmail').value }) });
    msg($('forgotMsg'), 'Request sent. If this email is registered, microedu will reset your password and inform you on Gmail.');
  } catch (err) { msg($('forgotMsg'), err.message, false); }
});

/* ---------- microedu admin: password reset requests ---------- */
async function loadPwResets() {
  try {
    const d = await api('/api/password-resets');
    setHtml('pwResetList', d.resets.length ? d.resets.map(r => `<div class="req-card"><p><b>#${r.person_id} ${esc(r.name)}</b> · ${esc(r.email)}<br><span class="muted">Asked: ${esc(String(r.created_at || ''))}</span></p><p style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-primary btn-sm" onclick="resetPw(${r.id})">Reset password to micro1234</button><button class="btn btn-ghost btn-sm" onclick="dismissPw(${r.id})">Dismiss</button></p></div>`).join('') : '<p class="muted">No password reset requests waiting.</p>');
  } catch (e) { /* not the admin */ }
}
window.resetPw = async id => { try { const d = await api('/api/password-resets/reset', { method: 'POST', body: JSON.stringify({ id }) }); alert('Password reset to micro1234 for ' + d.email + ' — please inform the member on Gmail.'); loadPwResets(); } catch (e) { alert(e.message); } };
window.dismissPw = async id => { try { await api('/api/password-resets/dismiss', { method: 'POST', body: JSON.stringify({ id }) }); loadPwResets(); } catch (e) { alert(e.message); } };

on('signOut', 'onclick', () => {
  me = null; myTimeBalance = 0;
  clearSession();
  hideEl('profileBox'); hideEl('teacherCard'); hideEl('adminCard'); hideEl('dashMain'); hideEl('flowCard');
  /* Nothing private stays on screen after sign-out: profile, requests,
     wallet, time bank and admin lists are all emptied, not just hidden. */
  ['profileContent', 'myRequests', 'teacherReqs', 'wEntries', 'tbEntries', 'extList', 'pwResetList', 'flowSteps', 'flowFor'].forEach(id => { const el = $(id); if (el) el.innerHTML = ''; });
  const bn = $('doNowBanner'); if (bn) { bn.classList.add('hidden'); bn.innerHTML = ''; }
  const ml = $('myRatingLine'); if (ml) ml.textContent = '';
  const wb = $('wBalance'); if (wb) wb.textContent = 'BDT 0';
  const tb = $('tbBalance'); if (tb) tb.textContent = '0 min';
  const sf = $('signForm'); if (sf) sf.classList.remove('hidden');
  msg($('signMsg'), 'Signed out');
});

/* ---------- edit my details & change password (dashboard) ---------- */
on('detailsForm', 'onsubmit', async e => {
  e.preventDefault();
  const payload = { name: $('dName').value, phone: $('dPhone').value, mobile: $('dMobile').value, photo_mode: $('dPhotoMode').value, group_name: $('dGroupName').value };
  try {
    const d = await api('/api/me/update', { method: 'POST', body: JSON.stringify(payload) });
    me = d.person;
    showProfile(d.person, d.cv);
    msg($('detailsMsg'), 'Your details are saved.');
    loadAll();
  } catch (err) { msg($('detailsMsg'), err.message, false); }
});
on('passForm', 'onsubmit', async e => {
  e.preventDefault();
  if ($('pNew').value !== $('pNew2').value) return msg($('passMsg'), 'The two new passwords do not match', false);
  try {
    await api('/api/me/password', { method: 'POST', body: JSON.stringify({ current_password: $('pCurrent').value, new_password: $('pNew').value }) });
    $('pCurrent').value = ''; $('pNew').value = ''; $('pNew2').value = '';
    msg($('passMsg'), 'Password changed. Use the new password next time you sign in.');
  } catch (err) { msg($('passMsg'), err.message, false); }
});
function prefillDetailsForm(p) {
  if (!p || !$('dName')) return;
  $('dName').value = p.name || '';
  $('dPhone').value = p.phone || '';
  $('dMobile').value = p.mobile || '';
  $('dPhotoMode').value = p.photo_mode || 'personal';
  $('dGroupName').value = p.group_name || '';
  const at = $('anonToggle'); if (at) at.checked = p.photo_mode === 'anonymous';
}
/* Anonymous mode toggle: one switch for the whole member — as a teacher
   AND as a student, their name, photo and phone stay hidden from other
   members; qualifications still show. microedu still sees the details. */
on('anonToggle', 'change', async e => {
  const on_ = e.target.checked;
  try {
    const d = await api('/api/me/update', { method: 'POST', body: JSON.stringify({ photo_mode: on_ ? 'anonymous' : 'personal' }) });
    me = d.person;
    prefillDetailsForm(d.person);
    msg($('anonMsg'), on_ ? 'Anonymous mode is ON — members now see you only as “Anonymous”.' : 'Anonymous mode is OFF — your name and photo are visible again.');
    loadAll();
  } catch (err) { e.target.checked = !on_; msg($('anonMsg'), err.message, false); }
});

/* ---------- microedu admin: extension approvals (site owner, member #1) ---------- */
async function loadExtensions() {
  try {
    const d = await api('/api/extensions');
    $('extList').innerHTML = d.extensions.length ? d.extensions.map(r => `<div class="req-card"><p><b>GID: ${esc(r.gid)}</b> · ${esc(r.subject)} — ${esc(r.topic)}<br>+${r.extension_minutes} min requested${r.class_start ? ' · Class: ' + esc(new Date(r.class_start).toLocaleString()) : ''}</p><button class="btn btn-primary btn-sm" onclick="approveExt('${r.gid}')">Approve +${r.extension_minutes} min</button></div>`).join('') : '<p class="muted">No extension requests waiting.</p>';
  } catch (e) { /* not the admin */ }
}
window.approveExt = async gid => { try { await api('/api/requests/extend/approve', { method: 'POST', body: JSON.stringify({ gid }) }); loadExtensions(); loadMine(); } catch (e) { alert(e.message); } };
function showProfile(p, cv) {
  if (!p || !$('profileBox')) return;
  $('profileBox').classList.remove('hidden');
  /* Signed in: the sign-in form goes away and the full dashboard page
     (teacher profile, wallet, time bank, requests) opens. Logged out,
     none of it is shown at all. */
  hideEl('dashMain', false);
  const sf = $('signForm'); if (sf) sf.classList.add('hidden');
  prefillDetailsForm(p);
  hideEl('teacherCard', false);
  fillPlans();
  if (p.id === 1) { hideEl('adminCard', false); loadExtensions(); loadPwResets(); loadVerify(); loadSubscribers(); }
  const isTeacher = !!(cv && Number(cv.teacher_ready || 0));
  const appear = p.photo_mode === 'anonymous' ? '🕶️ Anonymous (public lists hide your name & photo)'
    : p.photo_mode === 'group' ? '👥 Group' + (p.group_name ? ': ' + esc(p.group_name) : '')
    : '📷 Personal photo';
  const contact = [`<span>✉️ ${esc(p.email)}</span>`, p.phone ? `<span>📞 ${esc(p.phone)}</span>` : ''].filter(Boolean).join('');
  const detail = (label, value) => value ? `<div class="profile-detail"><span>${label}</span><strong>${value}</strong></div>` : '';
  const teacherDetails = isTeacher ? '<div class="profile-details">' +
    detail('Education', `${esc(cv.education)}${cv.university ? ' · ' + esc(cv.university) : ''}`) +
    detail('Profession', `${esc(cv.profession)}${cv.position ? ' · ' + esc(cv.position) : ''}`) +
    detail('Experience', esc(cv.experience)) +
    detail('Speciality', esc(cv.speciality)) +
    detail('Subjects', esc(cv.subjects)) +
    detail('Level', esc(cv.level)) +
    detail('Price', esc(priceText(cv)) + (Number(cv.accepts_time_exchange || 0) ? ' · Accepts time exchange' : '')) +
    detail('Address', esc(cv.address)) +
    detail('Available', esc(cv.available_time || '-')) +
    detail('Expertise-wise time', esc(cv.expertise_time || '')) +
    detail('CV file', esc(cv.cv_file_name || '')) +
    '</div>' : '';
  $('profileContent').innerHTML =
    `<div class="profile-summary">${avatarHtml(p, true)}<div class="profile-main">` +
      `<div class="profile-name-row"><h3>${esc(p.name)}</h3><span class="profile-badge">${isTeacher ? '👩‍🏫 Teacher' : 'Member'}</span></div>` +
      `<div class="profile-contact">${contact}</div>` +
      `<div class="profile-appear"><span>Profile display</span><b>${appear}</b></div>` +
    `</div></div>` +
    (isTeacher ? teacherDetails
      : `<div class="profile-next"><img src="/images/teacher.webp" alt=""><div class="profile-next-text"><b>Learn anything — or become a teacher</b><p>You can learn from any teacher with this account. To teach, complete your full profile; it takes only a few minutes.</p></div><button class="btn btn-primary" type="button" onclick="goTeach()">👩‍🏫 Become a teacher</button></div>`);
  prefillTeacherForm(cv);
  /* A typed-but-unsaved teacher profile survives a session timeout:
     the draft (saved on every keystroke) wins over the saved CV. */
  restoreTeacherDraft();
  /* The bKash sender number comes from this member's own profile. */
  prefillSenderInputs();
  loadTimebank();
}

/* ---------- subscription: email list only for now (paid plans paused) ---------- */
on('subJoinBtn', 'onclick', async () => {
  const email = (($('subEmail') || {}).value || '').trim();
  if (!email) return msg($('subMsg'), 'Please enter your email address.', false);
  try {
    const d = await api('/api/subscribe', { method: 'POST', body: JSON.stringify({ email }) });
    msg($('subMsg'), d.already ? 'This email is already on the subscription list. Thank you!' : 'Thank you! Your email is now on the microedu subscription list.');
    $('subEmail').value = '';
  } catch (e) { msg($('subMsg'), e.message, false); }
});
/* microedu admin: who is on the email subscription list. */
async function loadSubscribers() {
  try {
    const d = await api('/api/subscribers');
    setHtml('subsList', d.subscribers.length ? d.subscribers.map(s => `<p>📧 <b>${esc(s.email)}</b>${s.member_id ? ` — member #${s.member_id} ${esc(s.member_name || '')}` : ' — not a registered member yet'}<br><span class="muted">Joined: ${esc(fmtWhen(s.created_at))}</span></p>`).join('') : '<p class="muted">Nobody has subscribed yet.</p>');
  } catch (e) { /* not the admin */ }
}

/* ---------- teachers & requests ---------- */
function calcTotal() { const h = Number($('qHours').value) || 1; $('qTotal').textContent = 'BDT ' + (h * 500); }
on('qHours', 'oninput', calcTotal);

function renderTeacherCard(t, suggested = false, requestable = true) {
  teacherPricing[t.id] = { pricing: (t.cv && t.cv.pricing_type) || 'hourly', rate: (t.cv && t.cv.rate_bdt_per_hour) || 500, acceptsTime: !!(t.cv && Number(t.cv.accepts_time_exchange || 0)) };
  const subjects = (t.cv && t.cv.subjects ? t.cv.subjects : '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 4);
  const matchNote = suggested && t.matched && t.matched.length ? `<p class="match-note">✨ Matches: ${esc(t.matched.join(', '))}</p>` : '';
  /* Completed classes + average stars (1.5), from feedback already
     collected. Shown for anonymous teachers too — name and phone stay
     hidden, qualifications and track record still show. */
  const done = Number(t.completed || 0);
  const statsLine = !done
    ? `<p class="t-meta">🌱 ${esc(L({ en: 'New teacher — no completed class yet', bn: 'নতুন শিক্ষক — এখনো কোনো ক্লাস শেষ হয়নি' }))}</p>`
    : `<p class="t-meta">${t.rating_avg ? `⭐ ${t.rating_avg} (${t.rating_count} rating${t.rating_count > 1 ? 's' : ''}) · ` : ''}${esc(L({ en: done + ' class' + (done > 1 ? 'es' : '') + ' done', bn: done + 'টি ক্লাস শেষ' }))}</p>`;
  return `<div class="t-card${suggested ? ' suggested' : ''}">
    <div class="t-head">${avatarHtml(t)}<div><h3>${esc(displayName(t))}</h3><small>${esc(t.cv?.profession || '')}${t.cv?.university ? ' · ' + esc(t.cv.university) : ''}</small></div></div>
    <p class="t-meta">${esc(t.cv?.education || '')} · ${esc(t.cv?.experience || '')}${t.cv?.speciality ? '<br>Speciality: ' + esc(t.cv.speciality) : ''}</p>
    ${matchNote}
    ${statsLine}
    <div class="chips">${subjects.map(s => `<span class="chip">${esc(s)}</span>`).join('')}${teacherPricing[t.id].acceptsTime ? '<span class="chip time-ex">⏳ Accepts time exchange</span>' : ''}</div>
    ${t.cv?.available_time || t.cv?.expertise_time ? `<p class="t-meta">🕒 ${esc(t.cv.expertise_time || t.cv.available_time)}</p>` : ''}
    <div class="t-foot">${priceChip(t.cv)}${requestable ? `<button class="btn btn-primary btn-sm" onclick="requestTeacher(${t.id})">Request</button>` : ''}</div>
  </div>`;
}
let suggestedIds = [];
async function loadTeachers() {
  /* No public teacher list anymore — teacher data is loaded only to power
     the name search on the I Need Help page. Teachers become visible to a
     learner as suggestions after the help form is filled. */
  try {
    const d = await api('/api/teachers');
    window.allTeachers = d.teachers;
  } catch (e) { /* search stays empty */ }
}
/* ---------- Branches: School / College / University ----------
   Placement is automatic, from each teacher's own CV (agreed rules):
   - Masters completed -> School + College + University, subject-wise
   - Honours completed -> School (Class 6-10), subject-wise
   - Honours students -> University, as peer teachers in their subject
   - Professionals & others -> University, by subject + expertise
   Only subjects that really have teachers appear, and only the teachers
   themselves are shown by name — no counts, no empty subjects. */
const BRANCH_DEFS = [
  { key: 'School', icon: '🏫', label: 'School', sub: 'Class 6–10 · SSC', level: 'School (Class 6-10)' },
  { key: 'College', icon: '🎓', label: 'College', sub: 'Class 11–12 · HSC', level: 'College (Class 11-12)' },
  { key: 'University', icon: '🏛️', label: 'University', sub: 'Honours · Masters · Professionals', level: 'University' },
];
function teacherBranches(cv) {
  if (!cv) return [];
  const edu = (cv.education || '').toLowerCase();
  const prof = (cv.profession || '').toLowerCase();
  const out = new Set();
  const masters = /master|msc|m\.sc|mph|mba|m\.phil|ph\.?d|doctor/.test(edu);
  const honours = /honou?rs|bachelor|bsc|b\.sc|bba|mbbs/.test(edu);
  const running = /running|studying|student|pursuing|ongoing|semester/.test(edu + ' ' + prof);
  if (masters) { out.add('School'); out.add('College'); out.add('University'); }
  else if (honours && !running) out.add('School');
  else if (honours && running) out.add('University');
  if (cv.speciality && prof && !/student/.test(prof)) out.add('University');
  if (!out.size && (cv.subjects || cv.speciality)) out.add('University');
  return [...out];
}
function subjectTokens(cv) {
  const raw = (cv && (cv.subjects || cv.speciality)) || '';
  const seen = new Map();
  for (const t of raw.split(/[,+/&·|]/)) {
    const s = t.trim().replace(/\s+/g, ' ');
    if (s.length >= 2 && s.length <= 40) { const k = s.toLowerCase(); if (!seen.has(k)) seen.set(k, s); }
  }
  return [...seen.values()];
}
const isPublicHealth = cv => /public health|epidemiolog|biostatistic|\bmph\b|community health/.test((((cv || {}).subjects || '') + ' ' + ((cv || {}).speciality || '') + ' ' + ((cv || {}).education || '')).toLowerCase());
function teacherChip(t, levelLabel) {
  const name = displayName(t);
  const anon = t.anonymous || t.photo_mode === 'anonymous';
  const firstSubject = (subjectTokens(t.cv || {})[0] || '');
  const href = anon ? `help?level=${encodeURIComponent(levelLabel)}&subject=${encodeURIComponent(firstSubject)}` : `help?teacher=${encodeURIComponent(name)}`;
  return `<a class="tchip" href="${href}">${avatarHtml(t)}<span>${esc(name)}</span></a>`;
}
async function loadBranches() {
  const root = $('branchRoot'); if (!root) return;
  try {
    const d = await api('/api/teachers');
    const teachers = d.teachers || [];
    const ph = teachers.filter(t => isPublicHealth(t.cv));
    if (ph.length) { $('phCard').classList.remove('hidden'); $('phList').innerHTML = `<div class="tchips">${ph.map(t => teacherChip(t, 'University')).join('')}</div>`; }
    let html = '';
    for (const b of BRANCH_DEFS) {
      const groups = new Map();
      for (const t of teachers) {
        if (!teacherBranches(t.cv).includes(b.key)) continue;
        for (const s of subjectTokens(t.cv)) {
          const k = s.toLowerCase();
          if (!groups.has(k)) groups.set(k, { label: s, teachers: [] });
          groups.get(k).teachers.push(t);
        }
      }
      if (!groups.size) continue;
      const gs = [...groups.values()].sort((a, b2) => a.label.localeCompare(b2.label));
      html += `<div class="card branch-sec"><h3>${b.icon} ${b.label} <small class="muted">${b.sub}</small></h3>` +
        gs.map(g => `<div class="subj-group"><a class="subj-head" href="help?level=${encodeURIComponent(b.level)}&subject=${encodeURIComponent(g.label)}">${esc(g.label)} →</a><div class="tchips">${g.teachers.map(t => teacherChip(t, b.level)).join('')}</div></div>`).join('') + '</div>';
    }
    root.innerHTML = html || '<p class="muted center">No teachers yet — branches appear as teachers join.</p>';
  } catch (e) { root.innerHTML = '<p class="muted center">Could not load branches.</p>'; }
}
/* Arriving from a branch: the help form comes pre-filled (level + subject,
   or the teacher's name in the search box) and suggestions run at once. */
let helpParamsDone = false;
function initHelpParams() {
  if (helpParamsDone || !$('qLevel')) return;
  helpParamsDone = true;
  const q = new URLSearchParams(location.search);
  const level = q.get('level'), subject = q.get('subject'), teacher = q.get('teacher');
  if (level) $('qLevel').value = level;
  if (subject) {
    $('qSubject').value = subject; $('qChapter').value = ''; $('qTopic').value = '';
    setTimeout(() => { const b = $('suggestBtn'); if (b) b.click(); }, 400);
  }
  if (teacher) {
    const ts = $('tSearch');
    if (ts) {
      ts.value = teacher;
      const iv = setInterval(() => { if (window.allTeachers) { clearInterval(iv); ts.dispatchEvent(new Event('input')); ts.scrollIntoView({ behavior: 'smooth', block: 'center' }); } }, 250);
      setTimeout(() => clearInterval(iv), 6000);
    }
  }
}
on('suggestBtn', 'onclick', async () => {
  const btn = $('suggestBtn'); const old = btn.textContent;
  btn.disabled = true; btn.textContent = '⏳ Finding your teachers…';
  try {
    const qs = new URLSearchParams({ level: $('qLevel').value, subject: $('qSubject').value, chapter: $('qChapter').value, topic: $('qTopic').value });
    const d = await api('/api/suggest?' + qs.toString());
    suggestedIds = d.teachers.map(t => t.id);
    $('suggestTitle').classList.remove('hidden');
    $('suggestList').innerHTML = d.teachers.length ? d.teachers.map(t => renderTeacherCard(t, true)).join('') : '<p class="muted">No teachers yet.</p>';
    $('suggestActions').classList.toggle('hidden', !d.teachers.length);
    $('suggestList').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (e) { msg($('reqMsg'), e.message, false); }
  finally { btn.disabled = false; btn.textContent = old; }
});
/* ---------- form drafts (2.3): typed fields survive a sign-in
   interruption or a session timeout — they live in localStorage and are
   restored on load, and cleared only when the form is sent/saved. */
const HELP_DRAFT_KEY = 'microedu_help_draft';
const TEACHER_DRAFT_KEY = 'microedu_teacher_draft';
const HELP_FIELDS = ['qLevel', 'qSubject', 'qChapter', 'qTopic', 'qHours', 'qTime', 'qStart'];
const TEACHER_FIELDS = ['tEducation', 'tUniversity', 'tProfession', 'tPosition', 'tExperience', 'tSpeciality', 'tSubjects', 'tLevel', 'tAddress', 'tAvail', 'tRate', 'tExpTime'];
function saveHelpDraft() {
  if (!$('qSubject')) return;
  try {
    const v = {};
    HELP_FIELDS.forEach(id => { const el = $(id); if (el) v[id] = el.value; });
    localStorage.setItem(HELP_DRAFT_KEY, JSON.stringify(v));
  } catch (e) { /* storage full/blocked: the form still works */ }
}
function restoreHelpDraft() {
  if (!$('qSubject')) return;
  try {
    const d = JSON.parse(localStorage.getItem(HELP_DRAFT_KEY) || 'null');
    if (!d) return;
    HELP_FIELDS.forEach(id => { const el = $(id); if (el && d[id] !== undefined && d[id] !== null && d[id] !== '') el.value = d[id]; });
  } catch (e) { /* bad draft: ignore */ }
}
function clearHelpDraft() { try { localStorage.removeItem(HELP_DRAFT_KEY); } catch (e) { /* ignore */ } }
function saveTeacherDraft() {
  if (!$('tEducation')) return;
  try {
    const v = {};
    TEACHER_FIELDS.forEach(id => { const el = $(id); if (el) v[id] = el.value; });
    v.tPricing = $('tPricing') ? $('tPricing').value : '';
    v.tTimeEx = $('tTimeEx') ? $('tTimeEx').checked : false;
    localStorage.setItem(TEACHER_DRAFT_KEY, JSON.stringify(v));
  } catch (e) { /* storage full/blocked: the form still works */ }
}
function restoreTeacherDraft() {
  if (!$('tEducation')) return;
  try {
    const d = JSON.parse(localStorage.getItem(TEACHER_DRAFT_KEY) || 'null');
    if (!d) return;
    TEACHER_FIELDS.forEach(id => { const el = $(id); if (el && d[id]) el.value = d[id]; });
    if (d.tPricing && $('tPricing')) $('tPricing').value = d.tPricing;
    if ($('tTimeEx')) $('tTimeEx').checked = !!d.tTimeEx;
  } catch (e) { /* bad draft: ignore */ }
}
function clearTeacherDraft() { try { localStorage.removeItem(TEACHER_DRAFT_KEY); } catch (e) { /* ignore */ } }
HELP_FIELDS.forEach(id => { const el = $(id); if (el) { el.addEventListener('input', saveHelpDraft); el.addEventListener('change', saveHelpDraft); } });
[...TEACHER_FIELDS, 'tPricing', 'tTimeEx'].forEach(id => { const el = $(id); if (el) { el.addEventListener('input', saveTeacherDraft); el.addEventListener('change', saveTeacherDraft); } });

/* ---------- the three ways to send a request (no open direct requests) ---------- */
function helpPayload(teacher_id) {
  return { teacher_id, level: $('qLevel').value, subject: $('qSubject').value, chapter: $('qChapter').value, topic: $('qTopic').value, hours: $('qHours').value, available_time: $('qTime').value, class_start: $('qStart').value ? new Date($('qStart').value).toISOString() : null };
}
async function sendRequests(ids) {
  if (!ids.length) return msg($('bulkMsg'), 'Tap "Suggest teachers for me" first.', false);
  if (!token) { msg($('bulkMsg'), 'Please register or sign in first — it takes one minute.', false); setTimeout(() => { location.href = 'register'; }, 900); return; }
  let sent = 0; let firstErr = '';
  for (const id of ids) { try { await api('/api/requests', { method: 'POST', body: JSON.stringify(helpPayload(id)) }); sent++; } catch (e) { if (!firstErr) firstErr = e.message; } }
  msg($('bulkMsg'), sent ? `✅ Request sent to ${sent} teacher(s). It is now in their dashboard — when a teacher accepts, you will see it in your dashboard and can confirm payment.` + (firstErr ? ` (${ids.length - sent} could not be sent: ${firstErr})` : '') : 'Could not send: ' + (firstErr || 'please sign in and try again.'), !!sent);
  if (sent) { clearHelpDraft(); loadMine(); }
}
window.sendToAll = () => sendRequests(suggestedIds);
window.sendToTop = n => sendRequests(suggestedIds.slice(0, n));
window.microeduChoose = () => { if (suggestedIds.length) { sendRequests([suggestedIds[0]]); msg($('bulkMsg'), 'microedu picked the best-matching teacher for you — we will finalize and arrange your class.'); } else msg($('bulkMsg'), 'Tap "Suggest teachers for me" first — microedu will pick the best match.', false); };
/* Search a teacher you already know, by part of their name. */
on('tSearch', 'oninput', () => {
  const q = $('tSearch').value.trim().toLowerCase();
  if (q.length < 2) { $('searchList').innerHTML = ''; return; }
  const hits = (window.allTeachers || []).filter(t => (displayName(t) || '').toLowerCase().includes(q)).slice(0, 6);
  $('searchList').innerHTML = hits.length ? hits.map(t => renderTeacherCard(t)).join('') : '<p class="muted">No teacher found with that name.</p>';
});
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
    clearHelpDraft();
    loadMine();
  } catch (e) { msg($('reqMsg'), e.message, false); }
};
/* When a request was sent (created_at is UTC in the database) and how
   long is left until the class — both sides asked to see these. */
function fmtWhen(s) {
  if (!s) return '';
  const d = new Date(String(s).includes('T') ? s : String(s).replace(' ', 'T') + 'Z');
  return isNaN(d) ? String(s) : d.toLocaleString();
}
function timeUntil(s) {
  if (!s) return '';
  const d = new Date(s); if (isNaN(d)) return '';
  let m = Math.round((d - Date.now()) / 60000);
  const past = m < 0; m = Math.abs(m);
  const parts = [];
  const days = Math.floor(m / 1440); if (days) parts.push(days + 'd');
  const hrs = Math.floor((m % 1440) / 60); if (hrs) parts.push(hrs + 'h');
  parts.push((m % 60) + 'm');
  return past ? parts.join(' ') + ' ago' : 'in ' + parts.join(' ');
}
function tracker(r) {
  const steps = ['Pending', 'Confirm', 'Ongoing', 'Done'];
  const cur = steps.indexOf(r.status);
  return `<span class="tracker">${steps.map((s, i) => `<b class="${i <= cur ? 'on' : ''}">${s}</b>`).join('')}</span>`;
}
/* ---------- dashboard activity flow: the member's live service as a
   6-step flow, shown only while an active service exists for this view.
   Every step is a link to where that stage lives, so the member can
   check each stage. The full 13-step flow lives on /activity. */
const FLOW_STEPS = [
  { en: 'Request sent', bn: 'রিকোয়েস্ট পাঠানো' },
  { en: 'Teacher accepts', bn: 'শিক্ষক রাজি' },
  { en: 'Payment confirmed', bn: 'পেমেন্ট নিশ্চিত' },
  { en: 'Class link ready', bn: 'ক্লাস লিংক তৈরি' },
  { en: 'Session', bn: 'সেশন' },
  { en: 'Done & paid', bn: 'শেষ ও পেমেন্ট' },
];
/* ---------- dashboard "do this now" banner (1.1) ----------
   One banner for the most urgent active service, following the As
   Student / As Teacher toggle. bannerState is pure except for the clock,
   so it is unit-testable with sample requests. mode 'card' links to the
   request card it names; mode 'join' opens the class directly. */
function bannerState(r, teacher, nowMs) {
  const now = nowMs || Date.now();
  const isMoney = r.pay_with !== 'time' && Number(r.amount_bdt) > 0;
  const start = r.class_start ? Date.parse(r.class_start) : NaN;
  const open = isNaN(start) ? NaN : start - 15 * 60000;
  const close = isNaN(start) ? NaN : start + ((Number(r.hours) || 1) * 60 + 30 + (r.extension_status === 'Approved' ? (Number(r.extension_minutes) || 0) : 0)) * 60000;
  const inWindow = !isNaN(start) && now >= open && now <= close;
  const gid = r.gid;
  const card = { en: 'See the request →', bn: 'রিকোয়েস্টটি দেখুন →' };
  if (!teacher) {
    if (r.status === 'Pending' && r.teacher_response !== 'Accepted')
      return { kind: 'waiting', gid, mode: 'card', action: card, text: { en: `Waiting — ${r.teacher_name || 'your teacher'} has not answered your ${r.subject} request yet.`, bn: `অপেক্ষা — ${r.teacher_name || 'আপনার শিক্ষক'} এখনো আপনার ${r.subject} রিকোয়েস্টের উত্তর দেননি।` } };
    if (r.status === 'Pending' && isMoney && !r.trxid)
      return { kind: 'pay', gid, mode: 'card', action: { en: 'Pay now →', bn: 'এখনই পেমেন্ট করুন →' }, text: { en: `Pay now — send BDT ${r.amount_bdt} by bKash for your ${r.subject} class, then submit the TrxID.`, bn: `এখনই পেমেন্ট করুন — ${r.subject} ক্লাসের জন্য bKash-এ ${r.amount_bdt} টাকা পাঠান, তারপর TrxID জমা দিন।` } };
    if (['Pending', 'Confirm'].includes(r.status) && isMoney && r.trxid && !Number(r.verified))
      return { kind: 'verifying', gid, mode: 'card', action: card, text: { en: 'Verifying — microedu checks the TrxID before the class. You will see Payment Confirmed here.', bn: 'যাচাই চলছে — ক্লাসের আগে microedu TrxID যাচাই করছে। এখানেই Payment Confirmed দেখতে পাবেন।' } };
    if (r.status === 'Pending' && r.teacher_response === 'Accepted' && !isMoney)
      return { kind: 'confirm', gid, mode: 'card', action: { en: 'Confirm it →', bn: 'নিশ্চিত করুন →' }, text: { en: `Your ${r.subject} class is free — tap Confirm Payment to confirm it.`, bn: `আপনার ${r.subject} ক্লাসটি ফ্রি — নিশ্চিত করতে Confirm Payment চাপুন।` } };
    if (r.status === 'Confirm' && !isNaN(start)) {
      if (inWindow) return { kind: 'join', gid, mode: 'join', action: { en: 'Join Class', bn: 'ক্লাসে যোগ দিন' }, text: { en: `Your ${r.subject} class is on now — join it.`, bn: `আপনার ${r.subject} ক্লাস এখন চলছে — যোগ দিন।` } };
      if (now < open) return { kind: 'starts', gid, mode: 'card', action: { en: 'See the class →', bn: 'ক্লাসটি দেখুন →' }, text: { en: `Your ${r.subject} class starts ${timeUntil(r.class_start)}.`, bn: `আপনার ${r.subject} ক্লাস শুরু হবে ${timeUntil(r.class_start)}।` } };
      return { kind: 'over', gid, mode: 'card', action: card, text: { en: `Your ${r.subject} class time is over — open the request to finish it, or ask microedu for a refund.`, bn: `আপনার ${r.subject} ক্লাসের সময় শেষ — রিকোয়েস্ট খুলে শেষ করুন, অথবা microedu-র কাছে টাকা ফেরত চান।` } };
    }
    if (r.status === 'Confirm')
      return { kind: 'confirmed', gid, mode: 'card', action: card, text: { en: `Payment confirmed — your ${r.subject} class link will be ready at class time.`, bn: `পেমেন্ট নিশ্চিত — ${r.subject} ক্লাসের লিংক ক্লাসের সময় তৈরি হবে।` } };
    if (r.status === 'Ongoing') {
      if (inWindow) return { kind: 'join', gid, mode: 'join', action: { en: 'Join Class', bn: 'ক্লাসে যোগ দিন' }, text: { en: `Your ${r.subject} class is in progress — join it now.`, bn: `আপনার ${r.subject} ক্লাস চলছে — এখনই যোগ দিন।` } };
      return { kind: 'ongoing', gid, mode: 'card', action: { en: 'Tap Done →', bn: 'Done চাপুন →' }, text: { en: `Your ${r.subject} class is in progress — tap Done when it finishes.`, bn: `আপনার ${r.subject} ক্লাস চলছে — শেষ হলে Done চাপুন।` } };
    }
    return null;
  }
  if (r.status === 'Pending' && r.teacher_response !== 'Accepted')
    return { kind: 'answer', gid, mode: 'card', action: { en: 'Answer it →', bn: 'উত্তর দিন →' }, text: { en: `New request — ${r.student_name || 'a student'} wants help with ${r.subject}. Accept or decline it.`, bn: `নতুন রিকোয়েস্ট — ${r.student_name || 'একজন শিক্ষার্থী'} ${r.subject}-এ সাহায্য চান। রাজি হোন বা না করুন।` } };
  if (r.status === 'Pending' && r.teacher_response === 'Accepted' && isMoney && !Number(r.verified))
    return { kind: 'waitpay', gid, mode: 'card', action: card, text: { en: `Waiting for ${r.student_name || 'the student'} to pay for the ${r.subject} class.`, bn: `${r.student_name || 'শিক্ষার্থী'}-র ${r.subject} ক্লাসের পেমেন্টের অপেক্ষায় আছি।` } };
  if (r.status === 'Pending' && r.teacher_response === 'Accepted')
    return { kind: 'waitconfirm', gid, mode: 'card', action: card, text: { en: `Waiting for ${r.student_name || 'the student'} to confirm the ${r.subject} class.`, bn: `${r.student_name || 'শিক্ষার্থী'}-র ${r.subject} ক্লাস নিশ্চিত করার অপেক্ষায় আছি।` } };
  if (r.status === 'Confirm' && !isNaN(start)) {
    if (inWindow) return { kind: 'join', gid, mode: 'join', action: { en: 'Join Class', bn: 'ক্লাসে যোগ দিন' }, text: { en: `Your ${r.subject} class with ${r.student_name || 'your student'} is on now — join it.`, bn: `আপনার ${r.student_name || 'শিক্ষার্থী'}-র সঙ্গে ${r.subject} ক্লাস এখন চলছে — যোগ দিন।` } };
    if (now < open) return { kind: 'starts', gid, mode: 'card', action: { en: 'See the class →', bn: 'ক্লাসটি দেখুন →' }, text: { en: `Your ${r.subject} class starts ${timeUntil(r.class_start)}.`, bn: `আপনার ${r.subject} ক্লাস শুরু হবে ${timeUntil(r.class_start)}।` } };
    return { kind: 'over', gid, mode: 'card', action: card, text: { en: `Your ${r.subject} class time is over — the student will mark Done.`, bn: `আপনার ${r.subject} ক্লাসের সময় শেষ — শিক্ষার্থী Done চিহ্নিত করবেন।` } };
  }
  if (r.status === 'Confirm')
    return { kind: 'confirmed', gid, mode: 'card', action: card, text: { en: `Payment received — your ${r.subject} class with ${r.student_name || 'your student'} is confirmed.`, bn: `পেমেন্ট পাওয়া গেছে — ${r.student_name || 'আপনার শিক্ষার্থী'}-র সঙ্গে ${r.subject} ক্লাস নিশ্চিত।` } };
  if (r.status === 'Ongoing') {
    if (inWindow) return { kind: 'join', gid, mode: 'join', action: { en: 'Join Class', bn: 'ক্লাসে যোগ দিন' }, text: { en: `Your ${r.subject} class is in progress — join it now.`, bn: `আপনার ${r.subject} ক্লাস চলছে — এখনই যোগ দিন।` } };
    return { kind: 'ongoing', gid, mode: 'card', action: card, text: { en: `Your ${r.subject} class is in progress — the student marks Done when it finishes.`, bn: `আপনার ${r.subject} ক্লাস চলছে — শেষ হলে শিক্ষার্থী Done চিহ্নিত করবেন।` } };
  }
  return null;
}
function renderBanner(d) {
  const bar = $('doNowBanner'); if (!bar) return;
  const teacher = (localStorage.getItem('microedu_dash_view') || 'student') === 'teacher';
  const list = d ? (teacher ? d.asTeacher : d.asStudent) || [] : [];
  const active = list.filter(r => ['Pending', 'Confirm', 'Ongoing'].includes(r.status) && !(r.on_hold_until && new Date(r.on_hold_until) > new Date()));
  const st = active.length ? bannerState(active[0], teacher) : null;
  if (!st) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
  const act = st.mode === 'join'
    ? `<button class="btn btn-orange btn-sm" type="button" onclick="joinClass('${esc(st.gid)}')">${esc(L(st.action))}</button>`
    : `<a class="btn btn-primary btn-sm" href="#req-${esc(st.gid)}" onclick="flashReq(event,'${esc(st.gid)}')">${esc(L(st.action))}</a>`;
  bar.innerHTML = `<b>👉 ${esc(L(st.text))}</b> ${act}`;
  bar.classList.remove('hidden');
}
let lastMineData = null;
function flowStage(r) {
  if (r.status === 'Done') return 6;
  if (r.status === 'Ongoing') return 4;
  if (r.status === 'Confirm') return 3;
  if (r.teacher_response === 'Accepted') return 2;
  return 1;
}
function renderFlow(d) {
  const card = $('flowCard'); if (!card) return;
  const teacher = (localStorage.getItem('microedu_dash_view') || 'student') === 'teacher';
  const list = d ? (teacher ? d.asTeacher : d.asStudent) || [] : [];
  const active = list.filter(r => ['Pending', 'Confirm', 'Ongoing'].includes(r.status) && !(r.on_hold_until && new Date(r.on_hold_until) > new Date()));
  const r = active[0];
  if (!r) { card.classList.add('hidden'); $('flowSteps').innerHTML = ''; setText('flowFor', ''); return; }
  const cur = flowStage(r);
  const lang = curLang();
  const who = teacher ? r.student_name : r.teacher_name;
  setText('flowFor', `GID: ${r.gid} · ${r.subject} — ${r.topic}` + (who ? ` · ${teacher ? 'Student' : 'Teacher'}: ${who}` : ''));
  const reqLink = `#req-${r.gid}`;
  const lastHref = teacher ? '#walletCard' : (r.pay_with === 'time' || Number(r.amount_bdt) === 0 ? '#tbBalance' : reqLink);
  const hrefs = [reqLink, reqLink, reqLink, reqLink, reqLink, lastHref];
  $('flowSteps').innerHTML = FLOW_STEPS.map((s, i) => {
    const cls = i < cur ? 'done' : i === cur ? 'now' : '';
    const mark = i < cur ? '✓ ' : (i === cur ? '● ' : '');
    const click = hrefs[i].startsWith('#req-') ? ` onclick="flashReq(event,'${esc(r.gid)}')"` : '';
    return `<a class="flow-step ${cls}" href="${hrefs[i]}"${click} title="${esc(s.en)}"><span class="flow-n">${i + 1}</span><span>${mark}${esc(s[lang])}</span></a>`;
  }).join('<span class="flow-arrow">→</span>');
  const all = $('flowAllLink');
  if (all) { all.href = teacher ? '#reqToMeCard' : '#myReqCard'; all.textContent = lang === 'bn' ? BN[teacher ? 'flowAllToMe' : 'flowAllReq'] : (teacher ? 'All requests to me →' : 'All my requests →'); }
  card.classList.remove('hidden');
}
/* Jump to a request card from a flow step and flash it, so the member
   lands exactly on the activity that step is about. */
window.flashReq = (ev, gid) => {
  const el = document.getElementById('req-' + gid);
  if (!el) return;
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 2800);
};
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
      const resp = r.teacher_response || 'Waiting';
      /* On hold: the student chose another teacher for this same help;
         these stay inactive for a day, then open again. */
      const held = !!(r.on_hold_until && new Date(r.on_hold_until) > new Date());
      const holdLine = held && r.status === 'Pending'
        ? '<p><span class="escrow held">⏸ On hold for a day — the student is trying another teacher for this help first. It opens again if that does not work out.</span></p>' : '';
      /* The teacher's answer to this request, shown to both sides. */
      const respLine = r.status === 'Cancelled' && resp === 'Declined'
        ? '<p><span class="escrow refunded">❌ The teacher declined this request</span></p>'
        : resp === 'Accepted'
          ? '<p><span class="escrow released">✅ Teacher accepted — willing to give this service</span></p>'
          : r.status === 'Pending'
            ? '<p><span class="escrow held">⏳ Waiting for the teacher to accept</span></p>'
            : '';
      if (mine === 'teacher' && r.status === 'Pending' && resp === 'Waiting' && !held) {
        btns.push(`<button class="btn btn-primary btn-sm" onclick="respondReq('${r.gid}','Accepted')">✅ Accept — I will teach this</button>`);
        btns.push(`<button class="btn btn-ghost btn-sm" onclick="respondReq('${r.gid}','Declined')">Decline</button>`);
      }
      /* Payment can only be confirmed after the teacher has accepted.
         Money classes go through the bKash box below (TrxID + microedu
         verification); free and time-bank classes confirm directly. */
      const isMoney = r.pay_with !== 'time' && Number(r.amount_bdt) > 0;
      if (r.status === 'Pending' && resp === 'Accepted' && !isMoney) btns.push(`<button class="btn btn-primary btn-sm" onclick="advance('${r.gid}','Confirm')">Confirm Payment</button>`);
      let payBox = '';
      /* The bKash box shows until the payment is verified — including on
         bookings that reached Confirm under the old one-click flow, so a
         student can never be stuck without a way to pay. */
      if (mine === 'student' && resp === 'Accepted' && isMoney && !Number(r.verified) && ['Pending', 'Confirm'].includes(r.status)) {
        if (r.trxid && !r.rejected) {
          payBox = `<div class="pay-box"><p>🧾 <b>${esc(L({ en: 'bKash payment submitted', bn: 'bKash পেমেন্ট জমা দেওয়া হয়েছে' }))}</b> — TrxID: <b>${esc(r.trxid)}</b>${r.sender ? ' · From: ' + esc(r.sender) : ''}<br><span class="muted">${esc(L({ en: 'Verifying — microedu checks the TrxID before the class. You will see Payment Confirmed here.', bn: 'যাচাই চলছে — ক্লাসের আগে microedu TrxID যাচাই করছে। এখানেই Payment Confirmed দেখতে পাবেন।' }))}</span></p></div>`;
        } else {
          /* Copy buttons beside the bKash number and the exact amount;
             the sender number comes pre-filled from the member's own
             profile and can still be edited (1.4). */
          const senderVal = (me && (me.mobile || me.phone)) || '';
          payBox = `<div class="pay-box"><p>💳 <b>${esc(L({ en: 'Pay BDT ' + r.amount_bdt + ' by bKash', bn: 'bKash-এ ' + r.amount_bdt + ' টাকা পাঠান' }))}</b> <button type="button" class="btn btn-ghost btn-sm" onclick="copyText('${r.amount_bdt}', this)">📋 ${esc(L({ en: 'Copy amount', bn: 'টাকার অংক কপি করুন' }))}</button><br>${esc(L({ en: 'To microedu: ', bn: 'microedu-র নম্বরে: ' }))}<b>01729-071571</b> <button type="button" class="btn btn-ghost btn-sm" onclick="copyText('01729-071571', this)">📋 ${esc(L({ en: 'Copy number', bn: 'নম্বর কপি করুন' }))}</button><br>${esc(L({ en: 'Then enter your transaction ID:', bn: 'তারপর আপনার লেনদেনের আইডি (TrxID) লিখুন:' }))}</p>${r.rejected ? '<p><span class="escrow refunded">❌ microedu could not verify the last TrxID — please check it and submit again.</span></p>' : ''}<p style="display:flex;gap:8px;flex-wrap:wrap"><input id="trx-${r.gid}" placeholder="bKash TrxID" style="flex:1;min-width:150px"><input id="snd-${r.gid}" data-sender-input placeholder="${esc(L({ en: 'Your bKash number', bn: 'আপনার bKash নম্বর' }))}" value="${esc(senderVal)}" style="flex:1;min-width:140px"><button class="btn btn-primary btn-sm" onclick="submitTrx('${r.gid}')">Submit TrxID</button></p></div>`;
        }
      }
      if (r.status === 'Confirm' && (!isMoney || Number(r.verified))) btns.push(`<button class="btn btn-primary btn-sm" onclick="advance('${r.gid}','Ongoing')">Start (Ongoing)</button>`);
      if (r.status === 'Ongoing') btns.push(`<button class="btn btn-primary btn-sm" onclick="advance('${r.gid}','Done')">Mark Done</button>`);
      if (['Confirm', 'Ongoing'].includes(r.status) && (!isMoney || Number(r.verified) || r.status === 'Ongoing')) btns.push(`<button class="btn btn-orange btn-sm" onclick="joinClass('${r.gid}')">Join Class</button>`);
      if (['Confirm', 'Ongoing'].includes(r.status) && r.extension_status !== 'Requested') btns.push(`<button class="btn btn-ghost btn-sm" onclick="extendReq('${r.gid}')">Request +30 min</button>`);
      if (mine === 'student' && r.escrow_status === 'Held' && r.status !== 'Done') btns.push(`<button class="btn btn-ghost btn-sm" onclick="refundReq('${r.gid}')">Problem? Refund to me</button>`);
      /* One-tap rating after Done (2.2): stars right on the request card
         — tap a rating, one optional line, submit once. A rating already
         given shows instead, and can be changed by tapping again below. */
      let rateBox = '';
      if (mine === 'student' && r.status === 'Done') {
        if (r.my_rating) {
          rateBox = `<div class="rate-box"><p class="muted">${esc(L({ en: 'You rated this class', bn: 'আপনি এই ক্লাসটি রেট করেছেন' }))} ${'★'.repeat(Number(r.my_rating))}${'☆'.repeat(5 - Number(r.my_rating))}${r.my_rating_comment ? ' — “' + esc(r.my_rating_comment) + '”' : ''}</p></div>`;
        } else {
          rateBox = `<div class="rate-box"><p><b>${esc(L({ en: 'How was this class? Tap a star:', bn: 'ক্লাসটি কেমন ছিল? একটি স্টার চাপুন:' }))}</b></p><div class="stars" id="rate-${esc(r.gid)}">${[1, 2, 3, 4, 5].map(v => `<span data-v="${v}" onclick="rateStars('${esc(r.gid)}', ${v})">★</span>`).join('')}</div><p style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px"><input id="rate-comment-${esc(r.gid)}" placeholder="${esc(L({ en: 'One line (optional)', bn: 'এক লাইন (ঐচ্ছিক)' }))}" style="flex:1;min-width:150px"><button class="btn btn-primary btn-sm" onclick="submitRating('${esc(r.gid)}')">${esc(L({ en: 'Submit rating', bn: 'রেটিং জমা দিন' }))}</button></p></div>`;
        }
      }
      const who = mine === 'teacher' ? `<br>👤 From: <b>${esc(r.student_name || 'A student')}</b>` : `<br>👤 Teacher: <b>${esc(r.teacher_name || '')}</b>`;
      const details = [r.level, r.chapter].filter(Boolean).map(x => esc(x)).join(' · ');
      const sent = r.created_at ? `<br>🕐 Sent: ${esc(fmtWhen(r.created_at))}` : '';
      const when = (r.class_start ? `<br>🗓️ Class: ${esc(new Date(r.class_start).toLocaleString())} · <b>${esc(timeUntil(r.class_start))}</b>` : '') + (r.available_time ? `<br>🕒 Available: ${esc(r.available_time)}` : '');
      const ext = r.extension_status === 'Requested' ? '<p class="muted">⏳ Extension requested — waiting for microedu</p>' : r.extension_status === 'Approved' ? `<p class="muted">✅ Extra ${r.extension_minutes} min approved by microedu</p>` : '';
      return `<div class="req-card" id="req-${esc(r.gid)}"><p><b>GID: ${esc(r.gid)}</b> · ${esc(r.subject)} — ${esc(r.topic)}${details ? `<br>${details}` : ''}<br>${r.hours} hr × BDT ${r.rate_bdt_per_hour} = <b>BDT ${r.amount_bdt}</b>${who}${sent}${when}</p>${tracker(r)}${respLine}${holdLine}<p>${escrowLine(r)}</p>${ext}${payBox}${rateBox}${btns.length ? `<p style="display:flex;gap:8px;flex-wrap:wrap">${btns.join('')}</p>` : ''}</div>`;
    };
    setHtml('myRequests', d.asStudent.filter(r => !(r.status === 'Pending' && r.on_hold_until && new Date(r.on_hold_until) > new Date())).map(r => render(r, 'student')).join('') || '<p class="muted">None yet</p>');
    setHtml('teacherReqs', d.asTeacher.map(r => render(r, 'teacher')).join('') || '<p class="muted">None yet</p>');
    lastMineData = d;
    applyDashView();
    renderFlow(d);
    renderBanner(d);
    prefillSenderInputs();
    loadMyRating();
    const goGid = sessionStorage.getItem('microedu_goto');
    if (goGid) { sessionStorage.removeItem('microedu_goto'); setTimeout(() => goToReq(null, goGid), 350); }
    loadWallet();
  } catch (e) { /* not signed in */ }
}
/* ---------- dashboard view toggle: As Student / As Teacher ---------- */
function applyDashView() {
  if (!$('dashMain')) return;
  const teacher = (localStorage.getItem('microedu_dash_view') || 'student') === 'teacher';
  const show = (id, yes) => { const el = $(id); if (el) el.classList.toggle('hidden', !yes); };
  show('myReqCard', !teacher);
  show('walletCard', teacher);
  show('reqToMeCard', teacher);
  const vs = $('viewStudent'), vt = $('viewTeacher');
  if (vs) vs.classList.toggle('sel', !teacher);
  if (vt) vt.classList.toggle('sel', teacher);
  /* The flow card follows the view: the active service as a student is
     a different booking from the active service as a teacher. */
  renderFlow(lastMineData);
  renderBanner(lastMineData);
}
window.setDashView = v => { localStorage.setItem('microedu_dash_view', v); applyDashView(); };
on('viewStudent', 'onclick', () => setDashView('student'));
on('viewTeacher', 'onclick', () => setDashView('teacher'));

/* ---------- notifications: stored on the server, shown in the bell panel ----------
   They stay until the member deletes them (✕ one by one, or Clear all).
   Nothing is recomputed from requests, so a deleted one never comes back. */
async function refreshBellBadge() {
  try {
    const d = await api('/api/notifications');
    const b = $('bellBadge');
    if (b) { if (d.unread > 0) { b.textContent = d.unread; b.classList.remove('hidden'); } else b.classList.add('hidden'); }
  } catch (e) { /* bell stays without a badge */ }
}
async function renderNotifPanel() {
  const p = $('notifPanel'); if (!p) return;
  let d = { notifications: [] };
  try { d = await api('/api/notifications'); } catch (e) { /* offline */ }
  const items = d.notifications.map(n => `<div class="np-item" onclick="gotoNotif('${n.gid || ''}')"><p>${esc(n.text)}</p><small>${esc(fmtWhen(n.created_at))}</small><button type="button" class="np-del" title="Delete this notification" onclick="delNotif(event, ${n.id})">✕</button></div>`).join('');
  p.innerHTML = `<div class="np-head"><b>🔔 Notifications</b>${d.notifications.length ? '<button type="button" class="np-clear" onclick="clearNotifs(event)">Clear all</button>' : ''}</div>` + (items || '<p class="np-empty">No notifications yet.</p>');
}
async function toggleNotifPanel() {
  const p = $('notifPanel'); if (!p) return;
  if (!p.classList.contains('hidden')) { p.classList.add('hidden'); return; }
  await renderNotifPanel();
  p.classList.remove('hidden');
  try { await api('/api/notifications/read', { method: 'POST' }); } catch (e) { /* ignore */ }
  refreshBellBadge();
}
window.delNotif = async (ev, id) => {
  ev.stopPropagation();
  try { await api('/api/notifications/delete', { method: 'POST', body: JSON.stringify({ id }) }); renderNotifPanel(); } catch (e) { /* ignore */ }
};
window.clearNotifs = async ev => {
  ev.stopPropagation();
  if (!confirm('Delete all your notifications?')) return;
  try { await api('/api/notifications/clear', { method: 'POST' }); renderNotifPanel(); refreshBellBadge(); } catch (e) { /* ignore */ }
};
window.gotoNotif = gid => {
  if (!gid) return;
  if (document.getElementById('req-' + gid)) { const p = $('notifPanel'); if (p) p.classList.add('hidden'); goToReq(null, gid); }
  else { sessionStorage.setItem('microedu_goto', gid); location.href = 'dashboard'; }
};
document.addEventListener('click', e => {
  const p = $('notifPanel');
  if (p && !p.classList.contains('hidden') && !e.target.closest('.bell-wrap')) p.classList.add('hidden');
});
/* Clicking a notification jumps straight to that request's card and
   flashes it, so the member lands exactly where the notification came
   from. Clicks on buttons inside the notification do their own job. */
window.goToReq = (ev, gid) => {
  if (ev && ev.target && ev.target.closest('button, a, input')) return;
  const el = document.getElementById('req-' + gid);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 2800);
};
/* bKash advance payment: student submits the TrxID; microedu verifies. */
window.submitTrx = async gid => {
  const trx = (($('trx-' + gid) || {}).value || '').trim();
  const snd = (($('snd-' + gid) || {}).value || '').trim();
  if (!trx) return alert('Please enter the bKash transaction ID (TrxID) first.');
  try { await api('/api/payments/submit', { method: 'POST', body: JSON.stringify({ gid, trxid: trx, sender: snd }) }); alert('TrxID submitted — microedu will verify your payment.'); loadMine(); } catch (e) { alert(e.message); }
};
async function loadVerify() {
  if (!token) return;
  try {
    const d = await api('/api/payments/to-verify');
    const el = $('verifyList'); if (!el) return;
    el.innerHTML = d.payments.length ? d.payments.map(p => `<div class="req-card"><p><b>GID: ${esc(p.gid)}</b> · ${esc(p.subject)} — ${esc(p.topic)}<br>Student: <b>${esc(p.student_name || '')}</b> → Teacher: <b>${esc(p.teacher_name || '')}</b><br>💳 <b>BDT ${p.amount_bdt}</b> · TrxID: <b>${esc(p.trxid)}</b>${p.sender ? ' · From: ' + esc(p.sender) : ''}</p><p style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-primary btn-sm" onclick="verifyPay('${p.gid}',true)">✅ Verify — hold the money</button><button class="btn btn-ghost btn-sm" onclick="verifyPay('${p.gid}',false)">Reject</button></p></div>`).join('') : '<p class="muted">No bKash payments waiting for verification.</p>';
  } catch (e) { /* not admin */ }
}
window.verifyPay = async (gid, ok) => {
  if (!ok && !confirm('Reject this TrxID? The student will be asked to submit it again.')) return;
  try { await api('/api/payments/verify', { method: 'POST', body: JSON.stringify({ gid, ok }) }); loadVerify(); loadMine(); } catch (e) { alert(e.message); }
};
window.joinClass = async gid => { try { const d = await api('/api/requests/join', { method: 'POST', body: JSON.stringify({ gid }) }); window.open(d.class_link, '_blank'); } catch (e) { alert(e.message); } };
window.extendReq = async gid => { try { await api('/api/requests/extend', { method: 'POST', body: JSON.stringify({ gid, minutes: 30 }) }); alert('Extension requested — microedu will approve it.'); loadMine(); } catch (e) { alert(e.message); } };
window.refundReq = async gid => { if (!confirm('Refund this class in full? The booking will be cancelled.')) return; try { await api('/api/payments/refund', { method: 'POST', body: JSON.stringify({ gid }) }); loadMine(); } catch (e) { alert(e.message); } };
window.advance = async (gid, status) => { try { await api('/api/payments/confirm', { method: 'POST', body: JSON.stringify({ gid, status }) }); loadMine(); } catch (e) { alert(e.message); } };
/* Teacher answers a request from "Requests to me" in their dashboard. */
window.respondReq = async (gid, response) => {
  if (response === 'Declined' && !confirm('Decline this request? The booking will be cancelled and the student will see that you declined.')) return;
  try { await api('/api/requests/respond', { method: 'POST', body: JSON.stringify({ gid, response }) }); loadMine(); } catch (e) { alert(e.message); }
};

/* ---------- time bank ---------- */
async function loadTimebank() {
  if (!token) return;
  try {
    const d = await api('/api/timebank');
    myTimeBalance = Number(d.balance_minutes) || 0;
    setText('tbBalance', fmtMins(myTimeBalance));
    setHtml('tbEntries', d.entries.map(en => `<p>${en.kind === 'earn' ? '➕ Earned' : '➖ Spent'} ${fmtMins(Math.abs(en.minutes))} — ${esc(en.topic || 'Class')} ${en.gid ? '(' + esc(en.gid) + ')' : ''}</p>`).join('') || '<p class="muted">No entries yet — teach a free class to earn time credit.</p>');
  } catch (e) { /* not signed in */ }
}

/* ---------- wallet & feedback ---------- */
async function loadWallet() {
  if (!token) return;
  try {
    const d = await api('/api/wallet');
    setText('wBalance', 'BDT ' + d.balance);
    setHtml('wEntries', d.entries.map(en => `<p>${esc(en.topic || '')} ${en.gid ? '(' + esc(en.gid) + ')' : ''} — BDT ${en.amount_bdt} (${esc(en.kind)})</p>`).join('') || '<p class="muted">No entries</p>');
  } catch (e) { /* not signed in */ }
}
on('wBtn', 'onclick', async () => { try { const d = await api('/api/wallet/withdraw', { method: 'POST', body: JSON.stringify({ amount: $('wAmt').value }) }); msg($('wMsg'), 'Withdrawn. New balance: BDT ' + d.balance); loadWallet(); } catch (e) { msg($('wMsg'), e.message, false); } });
document.querySelectorAll('#fStars span').forEach(s => s.onclick = () => { myRanking = Number(s.dataset.v); document.querySelectorAll('#fStars span').forEach(x => x.classList.toggle('on', Number(x.dataset.v) <= myRanking)); });
on('fBtn', 'onclick', async () => { try { await api('/api/feedback', { method: 'POST', body: JSON.stringify({ gid: $('fGid').value, comment: $('fComment').value, ranking: myRanking, complain: $('fComplain').value }) }); msg($('fMsg'), 'Feedback saved'); } catch (e) { msg($('fMsg'), e.message, false); } });

/* ---------- one-tap rating on the request card (2.2) ---------- */
const pendingRatings = {};
window.rateStars = (gid, v) => {
  pendingRatings[gid] = v;
  document.querySelectorAll('#rate-' + gid + ' span').forEach(x => x.classList.toggle('on', Number(x.dataset.v) <= v));
};
window.submitRating = async gid => {
  const v = pendingRatings[gid];
  if (!v) return alert(L({ en: 'Tap a star first (1 to 5).', bn: 'আগে একটি স্টার চাপুন (১ থেকে ৫)।' }));
  const comment = (($('rate-comment-' + gid) || {}).value || '').trim();
  try {
    await api('/api/feedback', { method: 'POST', body: JSON.stringify({ gid, ranking: v, comment: comment || null }) });
    delete pendingRatings[gid];
    alert(L({ en: 'Thank you! Your rating was saved.', bn: 'ধন্যবাদ! আপনার রেটিং সেভ হয়েছে।' }));
    loadMine();
  } catch (e) { alert(e.message); }
};
/* A teacher's own completed classes + average stars (2.2), shown under
   the As Teacher view. */
async function loadMyRating() {
  if (!token) return;
  try {
    const d = await api('/api/my-rating');
    const el = $('myRatingLine'); if (!el) return;
    if (!d.completed && !d.rating_count) {
      el.textContent = L({ en: 'No completed class yet — your first rating will show here.', bn: 'এখনো কোনো ক্লাস শেষ হয়নি — আপনার প্রথম রেটিং এখানে দেখা যাবে।' });
      return;
    }
    el.textContent = L({
      en: `Your teaching so far: ${d.completed} class${d.completed === 1 ? '' : 'es'} done` + (d.rating_avg ? ` · ⭐ ${d.rating_avg} average (${d.rating_count} rating${d.rating_count > 1 ? 's' : ''})` : ' · no ratings yet'),
      bn: `আপনার পড়ানো: ${d.completed}টি ক্লাস শেষ` + (d.rating_avg ? ` · ⭐ গড় ${d.rating_avg} (${d.rating_count}টি রেটিং)` : ' · এখনো কোনো রেটিং নেই'),
    });
  } catch (e) { /* not signed in */ }
}

/* ---------- people & stats ---------- */
async function loadStats() {
  /* Home page counters (1.2): public counts only, so they fill reliably
     for signed-out visitors too. If the fetch fails, the stats band is
     hidden rather than showing dashes that never fill. */
  try {
    const d = await api('/api/stats');
    setText('statTeachers', d.counts.teachers);
    setText('statStudents', d.counts.members);
    setText('statTotal', d.counts.time_teachers);
  } catch (e) {
    const band = document.querySelector('.stats');
    if (band) band.style.display = 'none';
  }
}
async function loadPeople() {
  try {
    const d = await api('/api/people');
    setText('peopleCounts', `Total members: ${d.total} · Teachers: ${d.counts.teachers} · Teach for time exchange: ${d.counts.time_teachers}`);
    setHtml('peopleBody', d.people.map(p => `<tr><td>${p.id}</td><td>${p.cv && Number(p.cv.teacher_ready || 0) ? '👩‍🏫 Teacher' : 'Member'}</td><td>${!p.anonymous && p.photo_data ? `<img class="thumb" src="${p.photo_data}" alt=""> ` : ''}${esc(displayName(p))}</td><td>${esc(p.email || '—')}</td><td>${esc(p.cv?.education || '')}</td><td>${esc(p.cv?.university || '')}</td><td>${esc(p.cv?.profession || '')}</td><td>${esc(p.cv?.experience || '')}</td><td>${p.subscription ? esc(p.subscription.plan) + ' (' + esc(p.subscription.status) + ')' : ''}</td></tr>`).join(''));
    hideEl('peopleSignin'); hideEl('peopleCard', false);
  } catch (e) {
    /* Signed out: the list stays hidden behind a sign-in prompt
       (Decision A) instead of an empty table. */
    if ($('peopleBody')) { hideEl('peopleCard'); hideEl('peopleSignin', false); }
  }
}
on('refreshPeople', 'onclick', loadPeople);

/* On the dashboard, restore the signed-in profile from the saved token. */
async function restoreSession() {
  if (!token || !$('profileBox')) return;
  try { const d = await api('/api/me'); me = d.person; showProfile(d.person, d.cv); } catch (e) { /* stale token */ }
}
/* Signing out must remove every trace of the signed-in header: the chip
   (photo, name, ID, bell) goes away and Sign In / Join Free come back. */
function clearSession() {
  token = '';
  localStorage.removeItem('microedu_token'); localStorage.removeItem('d2d_token'); localStorage.removeItem('microedu_login_at');
  const chip = document.querySelector('.user-chip');
  if (chip) chip.remove();
  document.querySelectorAll('.top-actions a[href="dashboard"], .top-actions a[href="register"]').forEach(a => { a.style.display = ''; });
}
/* Signed-in state in the top menu bar, on every page: the member's own
   photo, name and ID replace Sign In / Join Free, with a notification
   bell (click it — the panel lists the stored notifications) and a
   Sign Out button. Signed-out visitors keep the default bar. */
async function updateHeaderUser() {
  if (!token) return;
  const actions = document.querySelector('.top-actions');
  if (!actions || actions.querySelector('.user-chip')) return;
  try {
    const d = await api('/api/me'); me = d.person;
    actions.querySelectorAll('a[href="dashboard"], a[href="register"]').forEach(a => { a.style.display = 'none'; });
    const chip = document.createElement('span');
    chip.className = 'user-chip';
    chip.innerHTML = `${avatarHtml(d.person)}<a class="user-name" href="dashboard">${esc(displayName(d.person))}<small>Member ID ${d.person.id}</small></a><span class="bell-wrap"><button type="button" class="bell" id="bellBtn" title="Notifications">🔔<span class="bell-badge hidden" id="bellBadge"></span></button><div class="notif-panel hidden" id="notifPanel"></div></span><button type="button" class="btn btn-ghost btn-sm" id="hdrSignOut">Sign Out</button>`;
    actions.appendChild(chip);
    $('hdrSignOut').onclick = () => { clearSession(); location.href = '/'; };
    $('bellBtn').onclick = e => { e.stopPropagation(); toggleNotifPanel(); };
    refreshBellBadge();
  } catch (e) { /* stale token: leave the default bar */ }
}
function loadAll() { loadTeachers(); loadPeople(); loadStats(); loadMine(); restoreSession(); updateHeaderUser(); loadBranches(); restoreHelpDraft(); initHelpParams(); }
/* "I Need Help" needs an identified member: without sign-in there is no
   way to know who is asking, so the help page sends the visitor to the
   sign-in page first and brings them back here after signing in. The
   typed form is saved as a draft first, so nothing is lost. */
if ($('suggestBtn') && !token) {
  saveHelpDraft();
  setReturnTo(location.pathname + location.search);
  sessionStorage.setItem('microedu_after_login', 'help');
  location.replace('dashboard');
}
loadAll();
if (location.hash === '#teacher') setTimeout(() => window.goTeach(), 450);

/* ---------- language switcher (EN / বাংলা) ----------
   English originals are captured from the DOM at load, so only the
   Bengali strings live here. Static page text only; dynamic messages
   and teacher cards stay in English in this version. */
const BN = {
  announce: 'আগাম পেমেন্ট করুন <b>bKash</b>-এ &nbsp;·&nbsp; কোনো সমস্যা হলে সম্পূর্ণ টাকা ফেরত &nbsp;·&nbsp; যেকোনো বিষয়ের যেকোনো অংশে সাহায্য, যেকোনো সময়',
  navHow: 'কীভাবে কাজ করে', navFind: 'আমাদের শিক্ষকগণ', navSub: 'সাবস্ক্রিপশন', navPeople: 'নিবন্ধিত সদস্য', navHelp: 'আমার সাহায্য লাগবে',
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
  bf1: 'রেজিস্টার করে প্রোফাইল তৈরি করুন', bf2: 'সাহায্যের রিকোয়েস্ট পাঠান ও লাইভ ক্লাসে যোগ দিন', bf3: 'ফ্রি পড়ান ও টাইম ক্রেডিট আয় করুন', bf4: 'পেইড ক্লাসে সম্পূর্ণ টাকা ফেরতের সুরক্ষা',
  pf1: 'বেসিকের সবকিছু', pf2: 'অগ্রাধিকার ভিত্তিতে শিক্ষক সাজেশন', pf3: 'অগ্রাধিকার ভিত্তিতে ক্লাসের ব্যবস্থা', pf4: 'শিক্ষক তালিকায় ফিচার্ড প্রোফাইল',
  tf1: 'প্লাসের সবকিছু', tf2: 'সাজেশনে সবার উপরে স্থান', tf3: 'প্রোফাইলে টিচার প্লাস ব্যাজ', tf4: 'অগ্রাধিকার ভিত্তিতে ওয়ালেট উত্তোলন',
  signInBtn: 'সাইন ইন', joinFree: 'ফ্রি যোগ দিন',
  heroPill: '🎓 মাইক্রো এডু. সাপোর্ট — লাইভ ১-টু-১ অনলাইন টিউশন',
  heroTitle: 'একটা টপিকে আটকে গেছেন?<br>আসল শিক্ষকের কাছে <span class="u-line">লাইভ</span> শিখুন।',
  heroLead: 'একবার রেজিস্টার করুন, যাচাই করা শিক্ষক বেছে নিন, ঠিক কোন অধ্যায় বা টপিকে আটকে আছেন তা লিখুন — আর আপনার সময়ে লাইভ ক্লাসে যোগ দিন। যেকোনো বিষয়, যেকোনো লেভেল, বাংলাদেশের যেকোনো জায়গা থেকে।',
  heroFind: 'শিক্ষক খুঁজুন →', heroJoinTeacher: 'শিক্ষক হিসেবে যোগ দিন',
  heroP1: '✔ যাচাই করা শিক্ষকের সিভি', heroP2: '✔ যেকোনো বিষয়, যেকোনো লেভেল', heroP3: '✔ সম্পূর্ণ টাকা ফেরতের গ্যারান্টি',
  fc1t: 'বিশ্বস্ত শিক্ষক', fc1s: 'প্রতিটি প্রোফাইলে বিস্তারিত সিভি',
  fc2t: 'লাইভ ক্লাসের লিংক', fc2s: 'প্রাইভেট ভিডিও রুম, আপনার সময়ে',
  feat1t: 'যেকোনো বিষয়ের যেকোনো অংশ', feat1p: 'একটা গ্রাফ, একটা অধ্যায়, একটা কঠিন টপিক — ঠিক যে অংশে আটকে আছেন সেটুকুই চান। পুরো কোর্স লাগবে না।',
  feat2t: 'আগে পেমেন্ট, ঝুঁকি নেই', feat2p: 'bKash-এ আগাম পেমেন্ট করুন। ক্লাসে কোনো সমস্যা হলে সম্পূর্ণ টাকা ফেরত পাবেন। সহজ ও নিরাপদ।',
  feat3t: 'আপনার সময়ে', feat3p: 'শিক্ষককে জানান কখন আপনি ফ্রি আছেন। সকাল, সন্ধ্যা বা গভীর রাত — ক্লাস হবে আপনার সুবিধামতো সময়ে।',
  howEyebrow: '— কীভাবে কাজ করে', howTitle: 'তিন ধাপেই আপনার <span class="u-line">ক্লাস</span>।',
  step1t: 'একবার রেজিস্টার করুন — ফ্রি', step1p: 'একটি সহজ ফর্ম — নাম, ইমেইল, ফোন। ছাত্র/শিক্ষক আলাদা নয়: যে কেউ শিখতে পারে, আর শিক্ষক প্রোফাইল সম্পূর্ণ করলেই যে কেউ পড়াতে পারে।',
  step2t: 'শিক্ষক ও টপিক বেছে নিন', step2p: 'একজন শিক্ষক বেছে নিন, আপনার লেভেল, বিষয়, অধ্যায় ও নির্দিষ্ট টপিক লিখুন, আর ঘণ্টা ও সময় ঠিক করুন।',
  step3t: 'পেমেন্ট করে ক্লাসে যোগ দিন', step3p: 'পেমেন্ট নিশ্চিত করুন, ক্লাসের স্ট্যাটাস দেখুন — Pending → Confirm → Ongoing → Done — আর ক্লাস লিংক দিয়ে যোগ দিন।',
  startNow: 'এখনই শুরু করুন →',
  studentEyebrow: '— ছাত্রদের জন্য', findTitle: 'আমাদের <span class="u-line">শিক্ষকগণ</span>।',
  findSub: '<b>আমার সাহায্য লাগবে</b> অংশে আপনার টপিক জানান — microedu আপনার জন্য সঠিক শিক্ষক সাজেস্ট করে ক্লাসের ব্যবস্থা করবে। নিচে আমাদের শিক্ষকদের দেখুন; রিকোয়েস্ট করতে I Need Help ব্যবহার করুন অথবা সেখানে নাম দিয়ে শিক্ষক খুঁজুন। রিকোয়েস্ট পাঠালেই রেট জানানো হবে।',
  reqCardTitle: 'আপনার কীসে সাহায্য দরকার?',
  lblLevel: 'লেভেল', lblSubject: 'বিষয়', lblChapter: 'অধ্যায়', lblTopic: 'টপিক', lblHours: 'ঘণ্টা', lblYourTime: 'আপনার ফ্রি সময়',
  phTime: 'আজ সন্ধ্যা ৭টা', estTotal: 'আনুমানিক মোট:', estNote: '(চূড়ান্ত মূল্য নির্ভর করবে আপনার শিক্ষকের নিজের রেটের ওপর)',
  teachersTitle: 'আমাদের শিক্ষকগণ', myReqTitle: 'আমার রিকোয়েস্টসমূহ',
  statsTitle: 'বাংলাদেশে বাড়তে থাকা একটি শিক্ষা কমিউনিটি',
  statTeachers: 'নিবন্ধিত শিক্ষক', statStudents: 'নিবন্ধিত সদস্য', statTotal: 'সময়ের বদলে শেখান', statRate: 'শিক্ষকরা নিজের রেট নিজে ঠিক করেন — কেউ কেউ ফ্রি পড়ান',
  whyEyebrow: '— কেন microedu.com', whyTitle: 'আসল শিক্ষক, আসল <span class="u-line">সিভি</span>, আসল ক্লাস।',
  whySub: 'প্রতিটি সদস্য বিস্তারিত সিভি দিয়ে রেজিস্টার করেন — শিক্ষা, বিশ্ববিদ্যালয়, অভিজ্ঞতা, বিশেষ দক্ষতা ও বিষয়। শিক্ষকের কার্ডে যা দেখবেন, ঠিক সেটাই তিনি রেজিস্টার করেছেন।',
  tick1: 'প্রতিটি শিক্ষকের প্রোফাইলের পেছনে বিস্তারিত সিভি',
  tick2: 'প্রতিটি ক্লাসে পরিষ্কার স্ট্যাটাস: Pending → Confirm → Ongoing → Done',
  tick3: 'শিক্ষকের আয় জমে ওয়ালেটে, যেকোনো সময় উত্তোলন',
  tick4: 'ক্লাসের পর ছাত্ররা রেটিং, রিভিউ ও অভিযোগ জানাতে পারে',
  meetTeachers: 'শিক্ষক সাজেশন নিন →',
  subEyebrow: '— সাবস্ক্রিপশন', subTitle: 'সবার জন্য সহজ <span class="u-line">প্ল্যান</span>।',
  subSubText: 'প্রতিটি সদস্যের জন্য একটি প্ল্যান তালিকা — একই অ্যাকাউন্টে শিখুন ও পড়ান। মেয়াদ বেছে নিন ১, ৩, ৬ বা ১২ মাস। স্ট্যাটাস শুরু হয় Pending দিয়ে — কনফার্ম করলেই সক্রিয়।',
  perMonth: '/মাস', popular: 'জনপ্রিয়',
  lblPlan: 'প্ল্যান', lblDuration: 'মেয়াদ (মাস)', subscribeBtn: 'সাবস্ক্রাইব করুন',
  joinEyebrow: '— শিক্ষক হিসেবে যোগ দিন', joinTitle: 'যা জানেন তাই পড়ান।<br>আর <span class="u-line">আয়</span> করুন।',
  joinSub: 'এক মিনিটে ফ্রি রেজিস্টার করুন, তারপর ড্যাশবোর্ড থেকে শিক্ষক প্রোফাইল সম্পূর্ণ করুন। নিজের রেট নিজে ঠিক করুন — ঘণ্টা হিসেবে, বিডিংয়ে, অথবা সম্পূর্ণ ফ্রি। ফ্রি পড়ালে সময়টা জমবে আপনার টাইম ব্যাংকে, অন্য শিক্ষকের কাছে শেখার জন্য।',
  regTeacherBtn: 'শিক্ষক হিসেবে রেজিস্টার করুন →',
  regEyebrow: '— রেজিস্ট্রেশন', regTitle: 'এখনই <span class="u-line">রেজিস্টার</span> করুন।',
  regSub: 'শুধু নাম, ইমেইল আর ফোন — এক মিনিটে রেজিস্টার করে এখনই শেখা শুরু করুন। ছাত্র/শিক্ষক আলাদা নয়। পড়াতে চাইলে পরে ড্যাশবোর্ড থেকে শিক্ষক প্রোফাইল সম্পূর্ণ করুন।',
  photoQ: 'আপনি কীভাবে দেখাতে চান?',
  photoPersonal: 'আমার নাম', photoPersonalSub: 'আপনার নাম দেখানো হবে',
  photoGroup: 'গ্রুপ নাম', photoGroupSub: 'কোনো গ্রুপ / টিমের জন্য',
  photoAnon: 'অজ্ঞাত (Anonymous)', photoAnonSub: 'নাম লুকানো থাকবে',
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
  lblEmailOrId: 'ইমেইল অথবা মেম্বার আইডি', phEmailOrId: 'you@example.com অথবা 5',
  forgotLink: 'পাসওয়ার্ড ভুলে গেছেন?', forgotTitle: '🔑 পাসওয়ার্ড ভুলে গেছেন?',
  forgotNote: 'আপনার রেজিস্টার করা ইমেইল লিখুন। microedu আপনার পাসওয়ার্ড সাধারণ স্টার্টার পাসওয়ার্ডে রিসেট করে Gmail-এ জানিয়ে দেবে। তারপর সেটা দিয়ে সাইন ইন করে প্রোফাইল থেকে পাসওয়ার্ড বদলে নিন।',
  forgotBtn: 'microedu-কে আমার পাসওয়ার্ড রিসেট করতে বলুন',
  adminPwTitle: '🔑 পাসওয়ার্ড রিসেটের অনুরোধ', adminPayTitle: '💳 যাচাইয়ের অপেক্ষায় bKash পেমেন্ট',
  lblRate: 'রেট (টাকা / ঘণ্টা)',
  lblExpTime: 'বিষয়ভিত্তিক সময়', phExpTime: 'পরিসংখ্যান: শনি–বৃহস্পতি সন্ধ্যা ৬–৮টা · Excel: শুক্রবার সকাল ১০টা–১২টা',
  lblCvFile: 'সিভি ফাইল (ফাইলের নাম সংরক্ষিত হয়)', regSubmit: 'রেজিস্টার করুন — সম্পূর্ণ ফ্রি',
  dashEyebrow: '— আমার ড্যাশবোর্ড', dashTitle: 'আবার <span class="u-line">স্বাগতম</span>।',
  editDetailsTitle: '✏️ আমার তথ্য বদলান', changePassTitle: '🔑 পাসওয়ার্ড বদলান',
  lblFullNamePlain: 'পুরো নাম', lblAppear: 'আপনি কীভাবে দেখাবেন',
  lblCurPass: 'বর্তমান পাসওয়ার্ড', lblNewPass: 'নতুন পাসওয়ার্ড', lblNewPass2: 'নতুন পাসওয়ার্ড আবার',
  saveDetailsBtn: 'আমার তথ্য সেভ করুন', changePassBtn: 'পাসওয়ার্ড বদলান',
  phYourPass: 'আপনার পাসওয়ার্ড', signOutBtn: 'সাইন আউট', myProfile: 'আমার প্রোফাইল', notifTitle: '🔔 নোটিফিকেশন',
  viewStudentBtn: '🎓 ছাত্র হিসেবে', viewTeacherBtn: '👩‍🏫 শিক্ষক হিসেবে',
  subStayTitle: 'microedu তালিকায় থাকুন।', subStayText: 'পেইড প্ল্যান আপাতত বন্ধ আছে। শুধু আপনার ইমেইল ঠিকানাটি দিন — খবর, নতুন শিক্ষক আর অফারের জন্য আপনি microedu সাবস্ক্রিপশন তালিকায় থাকবেন।', lblSubEmail: 'ইমেইল ঠিকানা', subJoinBtn: 'আমার ইমেইল যোগ করুন', adminSubsTitle: '📧 সাবস্ক্রিপশন তালিকা (ইমেইল)',
  navBranches: 'ব্রাঞ্চসমূহ', brEyebrow: '— বিষয় ম্যাপিং', brTitle: 'বিষয়ভিত্তিক <span class="u-line">ম্যাপিং</span>।',
  brSub: 'স্কুল, কলেজ বা বিশ্ববিদ্যালয় — বিষয় বেছে নিন আর দেখুন কোন শিক্ষকরা ওই বিষয়ে সাহায্য করতে পারবেন। বিষয়ে চাপ দিলে সাহায্যের ফর্ম তৈরি হয়ে যাবে, শিক্ষকের নামে চাপ দিলে সরাসরি ওই শিক্ষককেই চাওয়া যাবে।',
  brPH: '⭐ পাবলিক হেলথ — আমাদের বিশেষ ব্রাঞ্চ', brPHSub: 'পাবলিক হেলথ বিশেষজ্ঞ ও শিক্ষক, বিশেষভাবে চিহ্নিত।',
  anonTitle: '🕶️ অজ্ঞাত মোড', anonLabel: 'সবার কাছ থেকে আমার নাম ও ফোন নম্বর লুকিয়ে রাখুন',
  anonHint: 'এটা চালু থাকলে অন্য সদস্যরা আপনাকে শুধু “Anonymous” হিসেবেই দেখবে — কিন্তু আপনার শিক্ষাগত যোগ্যতা দেখা যাবে, তাই পরিচয় না দিয়েই আপনি যে কাউকে পড়াতে বা যে কারো কাছ থেকে সাহায্য নিতে পারবেন। microedu আপনার তথ্য দেখতে পারবে।',
  walletTitle: 'আমার ওয়ালেট', forTeachers: '(শিক্ষকদের জন্য)', lblBalance: 'ব্যালেন্স:',
  lblWithdrawAmt: 'উত্তোলনের পরিমাণ (টাকা)', withdrawBtn: 'উত্তোলন করুন',
  reqToMeTitle: 'আমার কাছে আসা রিকোয়েস্ট', feedbackTitle: '⭐ মূল্যায়ন / ফিডব্যাক',
  flowTitle: 'আমার কার্যক্রমের ধারা', flowFull: 'পুরো কার্যক্রমের ধারা দেখুন →', flowAllReq: 'আমার সব রিকোয়েস্ট →', flowAllToMe: 'আমার কাছে আসা সব রিকোয়েস্ট →',
  flowS1: 'রিকোয়েস্ট পাঠানো', flowS2: 'শিক্ষক রাজি', flowS3: 'পেমেন্ট নিশ্চিত', flowS4: 'ক্লাস লিংক তৈরি', flowS5: 'সেশন', flowS6: 'শেষ ও পেমেন্ট',
  actTitle: 'পুরো কার্যক্রমের ধারা', actSub: 'প্রথম ভিজিট থেকে ক্লাস শেষ ও শিক্ষকের পেমেন্ট পর্যন্ত — টাকা ও সময়, দুইভাবেই। নিচের প্রতিটি ধাপে সেই কাজটি কোথায় হয় তার লিংক দেওয়া আছে।', actBack: '← আমার ড্যাশবোর্ডে ফিরুন', actCheck: 'দেখুন:',
  actT1: 'ভিজিটর এলেন', actD1: 'হোম পেজ · EN / বাংলা ভাষা বদল',
  actT2: 'রেজিস্টার বা সাইন ইন', actD2: 'নাম, ফোন, ইমেইল, পাসওয়ার্ড → মেম্বার আইডি · অথবা ইমেইল / মেম্বার আইডি দিয়ে সাইন ইন',
  actT3: 'পড়াতে চান?', actD3: 'পুরো শিক্ষক প্রোফাইল পূরণ করুন (সব CV তথ্য) → শিক্ষক প্রস্তুত',
  actT4: 'শিক্ষার্থী: I Need Help', actD4: 'সাইন ইন লাগবে · লেভেল, বিষয়, টপিক',
  actT5: 'পরামর্শ', actD5: 'মিলে যাওয়া শিক্ষক, ঘণ্টাপ্রতি রেটসহ · সবাইকে পাঠান / সেরা ৩ / microedu বেছে দেবে / নাম দিয়ে খুঁজুন',
  actT6: 'শিক্ষককে জানানো হলো', actD6: 'বেল → ড্যাশবোর্ড “Requests to me” · রিকোয়েস্টে দেখা যায় কখন পাঠানো, ক্লাসের সময়, কতক্ষণ বাকি',
  actT7: 'শিক্ষক রাজি হলেন?', actD7: 'রাজি — অথবা না করলে শিক্ষার্থী অন্য শিক্ষক বেছে নেবেন',
  actT8: 'শিক্ষার্থী আগাম পেমেন্ট করলেন', actD8: 'bKash → TrxID জমা → microedu (অ্যাডমিন) যাচাই → টাকা জমা (Escrow HELD)',
  actT9: 'নিরাপদ ক্লাস লিংক', actD9: 'Jitsi রুম · Join বাটন শুধু সেই শিক্ষার্থী ও শিক্ষকের জন্য · নির্ধারিত সময় + ৩০ মিনিট',
  actT10: 'সেশন হলো', actD10: 'অডিও / ভিডিও লিংকে সরাসরি ১-টু-১ ক্লাস',
  actT11: 'শিক্ষার্থী Done চিহ্নিত করলেন', actD11: 'শিক্ষার্থী নিশ্চিত করলেন ক্লাস শেষ হয়েছে',
  actT12: 'জমা টাকা ছাড়া হলো', actD12: 'শিক্ষকের ওয়ালেটে টাকা গেল · ফ্রি ক্লাস হলে শিক্ষক টাইম ক্রেডিট পেলেন',
  actT13: 'সম্পূর্ণ ✓', actD13: 'পরের রিকোয়েস্টের জন্য প্রস্তুত',
  actBranchTitle: 'অন্যভাবে গেলে', actBD1: 'শিক্ষক না করলেন', actBDD1: 'বুকিং বাতিল · শিক্ষার্থীকে জানানো হয় · শিক্ষার্থী অন্য শিক্ষক বেছে নেন',
  actBD2: 'ছাড়ার আগে সমস্যা?', actD2x: 'শিক্ষার্থীকে পুরো টাকা ফেরত · একবারে একজন শিক্ষক — বাকিরা ১ দিন বন্ধ, Done হলে বাকিদের তথ্য চলে যায়',
  actAlso: 'সাইটে আরও যা আছে', actAlso1: 'অজ্ঞাত মোড — নাম / ছবি / ফোন লুকান, যোগ্যতা দেখা যাবে · Teacher / Student ড্যাশবোর্ড টগল',
  actAlso2: 'সেশন টাইমআউট · নোটিফিকেশনের ইতিহাস + ডিলিট · শুধু ইমেইলে সাবস্ক্রিপশন (পেইড প্ল্যান বন্ধ আছে)',
  actAlso3: 'Subject Mapping (স্কুল / কলেজ / বিশ্ববিদ্যালয় / প্রফেশনাল) — আপাতত লুকানো, শিক্ষক বাড়লে আসবে',
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
  footCopy: '© ২০২৬ microedu.com — মাইক্রো এডু. সাপোর্ট', footTag: 'একই অ্যাকাউন্টে শিখুন ও পড়ান',
  /* User-friendliness plan (25 Nov 2026): FAQ, footer contact, chips,
     wallet / time-bank labels, sign-in note, people sign-in prompt. */
  navFaq: 'সাধারণ প্রশ্নোত্তর',
  footContact: '📞 +8801729071571 (ফোন ও WhatsApp) · ✉️ data2decision20@gmail.com',
  helpChipsLabel: 'একটি বিষয় চাপুন — অথবা নিজে লিখুন:',
  helpExample: 'উদাহরণ: নবম শ্রেণি গণিত, অধ্যায় ৫, বীজগণিত — সামনে পরীক্ষা',
  helpWaiting: 'শিক্ষকরা সাধারণত কয়েক ঘণ্টার মধ্যে উত্তর দেন। microedu দুই পক্ষ থেকে ক্লাস ফাইনাল করে দেয়।',
  signInNote: 'একটি অ্যাকাউন্টেই শেখা ও পড়ানো — একবার সাইন ইন করুন, তারপর ড্যাশবোর্ড থেকে শিখুন বা পড়ান।',
  walletNote: 'Held = ক্লাস Done না হওয়া পর্যন্ত microedu টাকা নিরাপদে রাখছে। Released = শিক্ষককে দেওয়া হয়েছে। Refunded = শিক্ষার্থীকে ফেরত দেওয়া হয়েছে।',
  timeBankNote2: 'টাইম ক্রেডিট: ১ ঘণ্টা ফ্রি ক্লাস = ৬০ মিনিট আয়। শুধু যেসব শিক্ষক টাইম এক্সচেঞ্জে রাজি, তাদের কাছে এই ক্রেডিট খরচ করা যায়।',
  peopleSigninTitle: 'নিবন্ধিত সদস্য দেখতে সাইন ইন করুন',
  peopleSigninNote: 'সদস্য তালিকা শুধু সাইন ইন করা সদস্যদের জন্য। সাইন ইন করুন — অথবা এক মিনিটে ফ্রি রেজিস্টার করুন — তারপর এখানেই ফিরে আসবেন।',
  faqTitle: 'সাধারণ প্রশ্নোত্তর',
  faqSub: 'সদস্যরা সবচেয়ে বেশি যা জিজ্ঞেস করেন, তার সহজ উত্তর। তবুও আটকে গেলে microedu-র সঙ্গে যোগাযোগ করুন — নম্বর ও ইমেইল নিচে ফুটারে আছে।',
  faqQ1: 'টাকা ফেরত পাব কীভাবে?',
  faqA1: 'ক্লাসে কোনো সমস্যা হলে, ক্লাস Done চিহ্নিত হওয়ার আগেই microedu-কে জানান — পুরো টাকা ফেরত পাবেন। আপনার পেমেন্ট ক্লাস Done না হওয়া পর্যন্ত microedu-র কাছে নিরাপদে জমা (Held) থাকে, তাই ফেরত দেওয়ার টাকা সেখানেই আছে। Done হয়ে গেলে টাকা শিক্ষককে দেওয়া হয়, তখন আর ফেরত হয় না। <a href="activity">পুরো কার্যক্রমের ধারা দেখুন →</a>',
  faqQ2: 'শিক্ষক রিকোয়েস্ট না করলে কী হবে?',
  faqA2: 'বুকিং বাতিল হবে, আর আপনাকে সঙ্গে সঙ্গে জানানো হবে। সাজেশন থেকে অন্য শিক্ষক বেছে নিন, অথবা নতুন রিকোয়েস্ট পাঠান — microedu দুই পক্ষ থেকে ক্লাস ফাইনাল করে দেবে। <a href="activity">পুরো কার্যক্রমের ধারা দেখুন →</a>',
  faqQ3: 'ক্লাস চলাকালীন সমস্যা হলে কী করব?',
  faqA3: 'ক্লাস Done চিহ্নিত হওয়ার আগেই microedu-কে জানান: পেমেন্ট তখনো জমা আছে, তাই পুরো টাকা ফেরত পাবেন, আর ওই সাহায্যের অন্য শিক্ষকরা সঙ্গে সঙ্গে আবার পাওয়া যাবে। ক্লাস শেষ হয়ে Done হয়ে গেলেও জানান — আমরা দেখব।',
  faqQ4: 'টাইম ব্যাংক কীভাবে কাজ করে?',
  faqA4: 'ফ্রি ক্লাস পড়ালেই টাইম ক্রেডিট আয় হয়: ১ ঘণ্টা = ৬০ মিনিট। এই ক্রেডিট দিয়ে যেসব শিক্ষক টাইম এক্সচেঞ্জে রাজি, তাদের কাছে শিখতে পারবেন। টাকার ক্লাস সবসময় bKash-এ দিতে হয়, টাইম ক্রেডিট দিয়ে নয়।',
  faqQ5: 'microedu-তে কীভাবে পড়াব?',
  faqA5: 'একবার রেজিস্টার করুন — শেখা ও পড়ানোর জন্য একটাই অ্যাকাউন্ট — তারপর ড্যাশবোর্ড থেকে আপনার পুরো শিক্ষক প্রোফাইল সম্পূর্ণ করুন; প্রতিটি CV ঘর পূরণ করা বাধ্যতামূলক। সেভ হলেই I Need Help সাজেশনের মাধ্যমে শিক্ষার্থীরা আপনাকে খুঁজে পাবে। নিজের রেট নিজে ঠিক করুন: ঘণ্টা হিসেবে, বিডিংয়ে, অথবা সম্পূর্ণ ফ্রি — দামের কোনো সিলিং নেই।',
  faqQ6: 'microedu-র সঙ্গে যোগাযোগ করব কীভাবে?',
  faqA6: 'ফোন বা WhatsApp করুন +8801729071571 নম্বরে, অথবা ইমেইল করুন data2decision20@gmail.com-এ। প্রতিটি রিকোয়েস্ট microedu দুই পক্ষ থেকে ফাইনাল করে মিটিংয়ের ব্যবস্থা করে — সাইটে সরাসরি মেসেজ করার কোনো ব্যবস্থা নেই।',
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
/* Default language (Decision B): remember the visitor's last choice;
   with no choice stored, open in Bangla first. */
applyLang(localStorage.getItem('microedu_lang') === 'en' ? 'en' : 'bn');
