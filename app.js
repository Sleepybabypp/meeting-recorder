'use strict';
/* สรุปประชุม: record or pick audio -> Gemini transcript with speakers -> summary + ask-AI chat.
   Everything (audio, transcripts, summaries) stays on this device in IndexedDB. */

const $ = id => document.getElementById(id);
const API = 'https://generativelanguage.googleapis.com';
/* ตัวกลางเก็บคีย์ (proxy/worker.js บน Cloudflare) ใส่ URL ตรงนี้หลัง deploy แล้วคนใช้ไม่ต้องใส่คีย์เอง */
const PROXY_DEFAULT = 'https://chy-meeting.sleepybabypp.workers.dev';  /* Cloudflare Worker that holds the Gemini key (proxy/worker.js) */
const TR_MODEL = 'models/gemini-3.5-transcribe';
const TEXT_MODELS = ['models/gemini-3.5-flash', 'models/gemini-3.5-flash-lite', 'models/gemini-3.1-flash-lite'];  /* next one is tried when the first is busy or unavailable */

/* ---------- log ---------- */
const T0 = performance.now(), logs = [];
function log(...a){
  const line = ((performance.now() - T0) / 1000).toFixed(1).padStart(6) + 's  ' + a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ');
  logs.push(line); if (logs.length > 400) logs.shift();
  $('log').textContent = logs.join('\n');
}
const fmtLong = s => { s = Math.max(0, Math.round(s || 0)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); if (h) return h + ' ชม.' + (m ? ' ' + m + ' นาที' : ''); if (m) return m + ' นาที'; return s + ' วินาที'; };
const fmt = s => { s = Math.max(0, Math.round(s || 0)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), r = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : String(m).padStart(2, '0')) + ':' + String(r).padStart(2, '0'); };
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const standalone = !!(navigator.standalone || matchMedia('(display-mode: standalone)').matches);
log('UA', navigator.userAgent); log('standalone', standalone);
const MIMES = ['audio/webm;codecs=opus', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'];

/* ---------- key ---------- */
const KEY_LS = 'chy-rec-key';
$('key').value = localStorage.getItem(KEY_LS) || '';
const key = () => (localStorage.getItem(KEY_LS) || '').trim();
{ const q = new URLSearchParams(location.search).get('proxy'); if (q !== null) q ? localStorage.setItem('chy-proxy', q) : localStorage.removeItem('chy-proxy'); }
const PROXY = (localStorage.getItem('chy-proxy') || PROXY_DEFAULT).replace(/\/$/, '');
const base = () => key() ? API : PROXY;
const authH = () => key() ? {'x-goog-api-key': key()} : {};
const hasAI = () => !!(key() || PROXY);
const refreshKeyBanner = () => { $('noKey').hidden = hasAI(); };
/* with the Worker in place nobody needs a key: the key card disappears */
$('keyCard').hidden = !!PROXY && !key();
if (PROXY) { $('keyTitle').textContent = 'ใช้คีย์ของตัวเอง (ไม่จำเป็น)'; $('keyHint').textContent = 'แอปนี้ใช้ AI ได้เลยโดยไม่ต้องใส่คีย์ ถ้าใช้เยอะจนโควตาที่แชร์กันเต็ม ใส่คีย์ฟรีของตัวเองจาก aistudio.google.com ได้ คีย์เก็บในเครื่องนี้เท่านั้น'; }
$('saveKey').onclick = () => { localStorage.setItem(KEY_LS, $('key').value.trim()); $('keyMsg').textContent = 'บันทึกแล้ว'; refreshKeyBanner(); };
$('testKey').onclick = async () => {
  localStorage.setItem(KEY_LS, $('key').value.trim()); refreshKeyBanner();
  $('keyMsg').innerHTML = '<span class="spin"></span>กำลังทดสอบ';
  try {
    const r = await fetch(base() + '/v1beta/models?pageSize=200', {headers: authH()});
    const j = await r.json();
    if (!r.ok) throw new Error((j.error && j.error.message) || r.status);
    const ok = (j.models || []).some(m => m.name.includes('transcribe'));
    $('keyMsg').textContent = ok ? '✅ ใช้ได้' : '⚠️ คีย์ใช้ได้ แต่ไม่พบโมเดลถอดเสียง';
  } catch (e) { $('keyMsg').textContent = '❌ ' + friendly(0, String(e.message || e)); }
};
$('goSet').onclick = () => show('v-set');

/* ---------- storage: meetings ---------- */
const mdb = new Promise((res, rej) => {
  const o = indexedDB.open('chy-meetings', 1);
  o.onupgradeneeded = () => o.result.createObjectStore('meetings', {keyPath: 'id'});
  o.onsuccess = () => res(o.result); o.onerror = () => rej(o.error);
});
async function mdo(mode, fn){ const db = await mdb; return new Promise((res, rej) => { const tx = db.transaction('meetings', mode); const r = fn(tx.objectStore('meetings')); tx.oncomplete = () => res(r && r.result); tx.onerror = () => rej(tx.error); }); }
const saveMeeting = m => mdo('readwrite', s => s.put(m)).catch(e => log('save error', String(e.message || e)));
const getMeeting = id => mdo('readonly', s => s.get(id));
const allMeetings = () => mdo('readonly', s => s.getAll());
const delMeeting = id => mdo('readwrite', s => s.delete(id));
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().then(p => log('persist', p));

/* ---------- navigation ---------- */
const TITLES = {'v-rec': 'อัดเสียง', 'v-list': 'ประชุม', 'v-ai': 'ผู้ช่วย AI', 'v-set': 'ตั้งค่า'};
let view = 'v-rec';
function show(v){
  view = v; document.body.dataset.view = v;
  ['v-rec', 'v-list', 'v-meet', 'v-ai', 'v-set'].forEach(id => $(id).hidden = id !== v);
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.view === v || (v === 'v-meet' && b.dataset.view === 'v-list')));
  $('back').hidden = v !== 'v-meet';
  if (v !== 'v-meet') $('title').textContent = TITLES[v];
  $('delMeet').hidden = v !== 'v-meet';
  if (v !== 'v-meet') { document.querySelectorAll('#mAudio audio').forEach(a => a.pause()); $('nowPlaying').hidden = true; }
  if (v === 'v-list') renderList();
  if (v === 'v-ai') { renderAChat(); renderTasks(); }
  if (v === 'v-set') { renderMemory(); renderPeople(); }
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  scrollTo(0, 0);
}
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => show(b.dataset.view));
$('back').onclick = () => show('v-list');

/* ---------- recording (long meetings: overlapping segments) ---------- */
// Each file stays under the transcription model's 30-minute limit; the overlap lets speakers line up later.
const QS = new URLSearchParams(location.search);
const SEG = Math.max(30, +QS.get('seg') || 20 * 60), OV = Math.min(Math.max(3, +QS.get('ov') || 15), SEG / 3), STEP = SEG - OV;
let stream, startAt = 0, tick, wakeLock = null, recs = [], segBlobs = [], recMime = '', recording = false, recPins = [];

const bdb = new Promise((res, rej) => {   // chunk backup so a crash does not lose a long recording
  const o = indexedDB.open('chy-rec', 1);
  o.onupgradeneeded = () => o.result.createObjectStore('chunks', {autoIncrement: true});
  o.onsuccess = () => res(o.result); o.onerror = () => rej(o.error);
});
async function bdo(mode, fn){ try { const db = await bdb; return await new Promise((res, rej) => { const tx = db.transaction('chunks', mode); const r = fn(tx.objectStore('chunks')); tx.oncomplete = () => res(r && r.result); tx.onerror = () => rej(tx.error); }); } catch (e) { log('backup error', String(e.message || e)); } }

async function getWake(){
  if (!$('wake').checked || !('wakeLock' in navigator) || !recording) return;
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { log('wakeLock', e.name); }
}
document.addEventListener('visibilitychange', () => { log('visibility', document.visibilityState); if (recording && !document.hidden) getWake(); });
addEventListener('beforeunload', e => { if (recording) { e.preventDefault(); e.returnValue = ''; } });

function startSegment(idx){
  const r = new MediaRecorder(stream, recMime ? {mimeType: recMime, audioBitsPerSecond: 32000} : {});
  const ch = []; let seq = 0; r.idx = idx;
  r.done = new Promise(res => r.onstop = () => { segBlobs[idx] = new Blob(ch, {type: r.mimeType || recMime || 'audio/webm'}); res(); });
  r.ondataavailable = e => { if (e.data && e.data.size) { ch.push(e.data); bdo('readwrite', s => s.add({seg: idx, seq: seq++, blob: e.data, type: r.mimeType || recMime})); } };
  r.start(1000); recs.push(r); log('segment start', idx);
  return r;
}
$('recBtn').onclick = async () => {
  if (recording) return stopAll();
  try { stream = await navigator.mediaDevices.getUserMedia({audio: {echoCancellation: true, noiseSuppression: true, autoGainControl: true}}); }
  catch (e) { setResult('bad', 'เปิดไมค์ไม่ได้', 'อนุญาตให้ใช้ไมโครโฟนในการตั้งค่าของเบราว์เซอร์ แล้วลองใหม่'); log('mic', e.name); return; }
  await bdo('readwrite', s => s.clear());
  recMime = MIMES.find(m => MediaRecorder.isTypeSupported(m)) || '';
  recs = []; segBlobs = []; recPins = []; recording = true; startAt = performance.now();
  $('pinBtn').hidden = false; $('pinMsg').textContent = '';
  startSegment(0);
  $('recBtn').classList.add('on'); $('recBtn').setAttribute('aria-label', 'หยุดอัด');
  $('dot').classList.add('live'); $('recText').textContent = 'กำลังอัด แตะอีกครั้งเพื่อหยุด';
  $('recResult').innerHTML = ''; $('recover').hidden = true;
  tick = setInterval(onTick, 250); getWake();
};
function onTick(){
  const el = (performance.now() - startAt) / 1000;
  $('timer').textContent = fmt(el);
  const last = recs[recs.length - 1];
  if (el >= (last.idx + 1) * STEP) startSegment(last.idx + 1);
  recs.forEach(r => { if (r.state === 'recording' && r !== recs[recs.length - 1] && el >= r.idx * STEP + SEG) r.stop(); });
}
async function stopAll(){
  clearInterval(tick); recording = false;
  const wall = (performance.now() - startAt) / 1000;
  recs.forEach(r => { if (r.state !== 'inactive') r.stop(); });
  await Promise.all(recs.map(r => r.done));
  stream.getTracks().forEach(t => t.stop());
  if (wakeLock) { try { await wakeLock.release(); } catch {} wakeLock = null; }
  $('recBtn').classList.remove('on'); $('recBtn').setAttribute('aria-label', 'เริ่มอัด');
  $('dot').classList.remove('live'); $('recText').textContent = 'แตะเพื่อเริ่มอัด'; $('timer').textContent = '00:00';
  $('pinBtn').hidden = true; $('pinMsg').textContent = '';
  const blobs = segBlobs.filter(b => b && b.size);
  let dur = 0; for (const b of blobs) dur += await mediaDuration(b);
  dur -= OV * Math.max(0, blobs.length - 1);
  log('stopped', {wall: +wall.toFixed(1), audio: +dur.toFixed(1), segs: blobs.length});
  if (wall - dur > 5) setResult('warn', `เสียงหายไปประมาณ ${fmt(wall - dur)}`, 'อาจเพราะจอดับหรือสลับไปแอปอื่นระหว่างอัด');
  if (!blobs.length) return;
  const m = await createMeeting(blobs, blobs[0].type, dur || wall);
  if (recPins.length) { m.pins = recPins.slice(); await saveMeeting(m); }
  await bdo('readwrite', s => s.clear());
  openMeeting(m.id);
}
function mediaDuration(blob){
  return new Promise(res => {
    const a = new Audio(); a.preload = 'metadata';
    const url = URL.createObjectURL(blob); let done = false;
    const fin = v => { if (done) return; done = true; URL.revokeObjectURL(url); res(isFinite(v) ? v : 0); };
    a.onloadedmetadata = () => { if (isFinite(a.duration) && a.duration > 0) return fin(a.duration); a.ontimeupdate = () => { a.ontimeupdate = null; fin(a.duration); }; a.currentTime = 1e7; };
    a.onerror = () => fin(0); setTimeout(() => fin(a.duration), 8000); a.src = url;
  });
}
function setResult(kind, title, detail){ $('recResult').innerHTML = `<div class="res ${kind}"><b>${esc(title)}</b>${esc(detail || '')}</div>`; }

$('pinBtn').onclick = () => {
  if (!recording) return;
  const t = (performance.now() - startAt) / 1000; recPins.push(t);
  $('pinMsg').textContent = `ปักหมุดแล้ว ${recPins.length} จุด (ล่าสุด ${fmt(t)}) AI จะสรุปช่วงนี้ละเอียดเป็นพิเศษ`;
  if (navigator.vibrate) navigator.vibrate(30);
};
$('fileIn').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  if (f.size > 14 * 1048576) { e.target.value = ''; setResult('warn', `ไฟล์ใหญ่ ${(f.size / 1048576).toFixed(0)} MB เกินที่ถอดได้ (14 MB)`, 'ตัดไฟล์ให้สั้นลง หรืออัดในแอปนี้แทน แอปจะแบ่งเสียงเป็นช่วงให้เอง'); return; }
  const dur = await mediaDuration(f);
  log('file', {type: f.type || '(none)', mb: +(f.size / 1048576).toFixed(1), dur: +dur.toFixed(1)});
  const m = await createMeeting([f], f.type || '', dur, f.name.replace(/\.[^.]+$/, ''));
  e.target.value = '';
  openMeeting(m.id);
};

(async () => {   // recover an interrupted recording
  const all = await bdo('readonly', s => s.getAll());
  if (!all || !all.length) return;
  const segs = [...new Set(all.map(c => c.seg))].sort((a, b) => a - b);
  $('recover').hidden = false;
  $('recoverMsg').textContent = `มีเสียงที่อัดค้างไว้ประมาณ ${Math.max(1, Math.round(all.filter(c => c.seg === segs[segs.length - 1]).length / 60 + (segs.length - 1) * STEP / 60))} นาที`;
  $('recoverBtn').onclick = async () => {
    const blobs = segs.map(s => { const cs = all.filter(c => c.seg === s).sort((a, b) => a.seq - b.seq); return new Blob(cs.map(c => c.blob), {type: cs[0].type || 'audio/webm'}); });
    let dur = 0; for (const b of blobs) dur += await mediaDuration(b);
    const m = await createMeeting(blobs, blobs[0].type, dur - OV * (blobs.length - 1), 'เสียงที่กู้คืน');
    await bdo('readwrite', s => s.clear()); $('recover').hidden = true; openMeeting(m.id);
  };
  $('discardBtn').onclick = async () => { if (!confirm('ลบเสียงที่อัดค้างไว้? กู้คืนไม่ได้')) return; await bdo('readwrite', s => s.clear()); $('recover').hidden = true; };
})();

function apiMime(t, name){
  t = (t || '').toLowerCase(); name = (name || '').toLowerCase();
  if (t.includes('webm')) return 'audio/webm';
  if (t.includes('ogg')) return 'audio/ogg';
  if (t.includes('mp4') || t.includes('m4a') || name.endsWith('.m4a')) return 'audio/m4a';
  if (t.includes('aac')) return 'audio/aac';
  if (t.includes('mpeg') || t.includes('mp3') || name.endsWith('.mp3')) return 'audio/mp3';
  if (t.includes('wav') || name.endsWith('.wav')) return 'audio/wav';
  return 'audio/m4a';
}
const defaultTitle = d => 'ประชุม ' + d.toLocaleDateString('th-TH', {day: 'numeric', month: 'short'}) + ' ' + d.toLocaleTimeString('th-TH', {hour: '2-digit', minute: '2-digit'});
async function createMeeting(blobs, type, dur, title){
  const now = new Date();
  const m = {id: 'm' + now.getTime(), title: title || defaultTitle(now), autoTitle: !title, created: now.getTime(), dur, mime: apiMime(type, title), audio: blobs,
    items: [], order: [], names: {}, summaries: {}, chat: [], docs: preDocs.splice(0)};
  await saveMeeting(m); renderPreDocs();
  return m;
}

/* ---------- meeting list ---------- */
const initial = n => { const t = String(n || '').replace(/^คนที่\s*/, '').replace(/^(พี่|น้อง|คุณ)\s*/, '').replace(/^[เแโใไ]/, '').trim(); return esc([...t][0] || '?'); };
$('weekTasks').onclick = () => { show('v-ai'); const b = document.querySelector('#v-ai .seg3 [data-ai="a-tasks"]'); if (b) b.click(); };
async function renderList(){
  const list = (await allMeetings() || []).sort((a, b) => b.created - a.created);
  if (!list.length) {
    $('week').hidden = true;
    $('mlist').innerHTML = '<div class="empty"><b>ยังไม่มีประชุม</b>ไปที่แท็บอัดเสียง แล้วแตะปุ่มอัด หรือเลือกไฟล์เสียงจากเครื่อง</div>';
    return;
  }
  const now = new Date(), day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime(), wk0 = day0 - 6 * 864e5;
  const week = list.filter(m => m.created >= wk0), open = list.reduce((a, m) => a + (m.tasks || []).filter(t => !t.done).length, 0);
  $('week').hidden = !week.length;
  $('weekTxt').textContent = `${week.length} ประชุม · ${fmtLong(week.reduce((a, m) => a + (m.dur || 0), 0))}`;
  $('weekN').textContent = open;
  const row = m => {
    const d = new Date(m.created), ls = m.items && m.items.length ? lines(m) : [], last = ls[ls.length - 1];
    const who = (m.order || []).slice(0, 2).map((g, i) => `<span class="av c${Math.min(i + 1, 6) % 6}">${initial(label(m, g))}</span>`).join('') || '<span class="av c0"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg></span>';
    const tasks = (m.tasks || []).filter(t => !t.done).length;
    const chips = (Object.keys(m.summaries || {}).length ? '<span class="chip ok">สรุปแล้ว</span>' : ls.length ? '<span class="chip todo">ถอดแล้ว ยังไม่สรุป</span>' : '<span class="chip todo">ยังไม่ถอดเสียง</span>')
      + (tasks ? `<span class="chip warn">งานค้าง ${tasks}</span>` : '') + `<span class="chip todo">${fmtLong(m.dur)}</span>`;
    const when = m.created >= day0 ? d.toLocaleTimeString('th-TH', {hour: '2-digit', minute: '2-digit'}) : d.toLocaleDateString('th-TH', {day: 'numeric', month: 'short'});
    return `<button class="mitem" data-id="${esc(m.id)}"><span class="stack">${who}</span><span class="mtx"><span class="mtop"><b>${esc(m.title)}</b><small>${when}</small></span>${last ? `<span class="mprev c${last.c}">${last.who ? `<em>${esc(last.who)}:</em> ` : ''}${esc(last.t)}</span>` : ''}<span class="chips2">${chips}</span></span></button>`;
  };
  const groups = [['วันนี้', list.filter(m => m.created >= day0)], ['7 วันที่ผ่านมา', list.filter(m => m.created < day0 && m.created >= wk0)], ['ก่อนหน้านี้', list.filter(m => m.created < wk0)]];
  $('mlist').innerHTML = groups.filter(g => g[1].length).map(([h, ms]) => `<div class="grp">${h}</div><div class="mbox">${ms.map(row).join('')}</div>`).join('');
  $('mlist').querySelectorAll('.mitem').forEach(b => b.onclick = () => openMeeting(b.dataset.id));
}

/* ---------- meeting detail ---------- */
let cur = null, transcript = '';
async function openMeeting(id){
  cur = await getMeeting(id); if (!cur) return show('v-list');
  show('v-meet');
  $('title').textContent = 'ประชุม';
  $('mTitle').value = cur.title; fitTitle();
  const d = new Date(cur.created);
  $('mMeta').textContent = d.toLocaleDateString('th-TH', {weekday: 'short', day: 'numeric', month: 'long', year: 'numeric'}) + ' · ' + d.toLocaleTimeString('th-TH', {hour: '2-digit', minute: '2-digit'}) + ' · ยาว ' + fmtLong(cur.dur);
  $('mAudio').innerHTML = `<div class="player"><div class="prow"><button class="pp" id="ppBtn" aria-label="เล่น">${PLAY_SVG}</button><div class="strip"><span id="ppSegs" style="display:contents"><i class="c0" style="flex:1"></i></span><span class="rest" id="ppRest" style="left:0"></span><span class="head" id="ppHead" style="left:0"></span><input type="range" id="ppBar" min="0" max="${Math.max(1, Math.round(cur.dur))}" step="1" value="0" aria-label="ตำแหน่งเสียง"></div></div><div class="pmeta"><span class="pt" id="ppTime"><b>00:00</b> / ${fmt(cur.dur)}</span><span class="leg" id="ppLeg"></span></div></div>` + cur.audio.map(b => `<audio preload="none" hidden src="${URL.createObjectURL(b)}"></audio>`).join('');
  wirePlayer();
  $('trMsg').textContent = ''; $('sumMsg').textContent = ''; $('guessMsg').textContent = '';
  const done = Object.keys(TEMPLATES).find(k => cur.summaries && cur.summaries[k]);
  $('tpl').value = done || 'meeting';
  cur.pins = cur.pins || []; cur.docs = cur.docs || []; cur.trans = cur.trans || {};
  $('mPins').innerHTML = cur.pins.length ? 'จุดที่ปักหมุด: ' + cur.pins.map(t => `<button class="cite" data-t="${t}">${fmt(t)}</button>`).join(' ') : '';
  renderDocs(); $('trTrOut').innerHTML = ''; $('sumTrOut').innerHTML = '';
  renderTranscriptPane(); renderSummary(); renderChat();
  pane('p-tr');
}
function pane(id){
  ['p-tr', 'p-sum', 'p-ask'].forEach(p => $(p).hidden = p !== id);
  document.querySelectorAll('#v-meet .seg3 button').forEach(b => b.classList.toggle('on', b.dataset.pane === id));
}
document.querySelectorAll('#v-meet .seg3 button').forEach(b => b.onclick = () => pane(b.dataset.pane));
function fitTitle(){ const t = $('mTitle'); t.style.height = 'auto'; t.style.height = t.scrollHeight + 'px'; }
$('mTitle').oninput = fitTitle;
$('mTitle').onkeydown = e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); $('mTitle').blur(); } };
$('mTitle').onchange = () => { cur.title = $('mTitle').value.trim() || cur.title; cur.autoTitle = false; saveMeeting(cur); };
$('delMeet').onclick = async () => {
  if (!confirm(`ลบ "${cur.title}" ทั้งเสียงและสรุป? กู้คืนไม่ได้`)) return;
  await delMeeting(cur.id); cur = null; show('v-list');
};

/* ---------- Gemini ---------- */
const b64 = blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); });
function friendly(status, msg){
  if (status === 503 || status === 500) return 'ระบบของ Google คนใช้เยอะอยู่ (ไม่ใช่ปัญหาคีย์) ลองใหม่อีกสักครู่';
  if (status === 429) return /day|daily/i.test(msg) ? 'ใช้ครบโควตาฟรีของวันนี้แล้ว พรุ่งนี้ใช้ได้ใหม่' : 'กดถี่เกินโควตาฟรี รอประมาณ 1 นาทีแล้วลองใหม่';
  if (/api key/i.test(msg)) return 'คีย์ไม่ถูกต้อง ไปแก้ที่หน้าตั้งค่า';
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return 'ต่อเน็ตไม่ได้ ลองใหม่เมื่อมีสัญญาณ';
  return msg || ('HTTP ' + status);
}
const RETRY_WAIT = [3000, 8000, 20000];
async function interact(body, onWait){
  if (!hasAI()) throw new Error('ยังไม่ได้ใส่คีย์ ไปที่หน้าตั้งค่าก่อน');
  let r, j;
  try {
    for (let i = 0; ; i++) {
      r = await fetch(base() + '/v1beta/interactions', {method: 'POST', headers: {...authH(), 'Content-Type': 'application/json'}, body: JSON.stringify(body)});
      j = await r.json().catch(() => ({}));
      const m = (j.error && j.error.message) || '';
      if (!r.ok && body.store === false && /store/i.test(m)) { delete body.store; i--; continue; }
      if (r.ok || ![429, 500, 503].includes(r.status) || i >= RETRY_WAIT.length || /day|daily/i.test(m)) break;
      log('busy', r.status); if (onWait) onWait(i + 1, RETRY_WAIT[i] / 1000);
      await sleep(RETRY_WAIT[i]);
    }
  } catch (e) { throw new Error(friendly(0, String(e.message || e))); }
  if (!r.ok) { const m = (j.error && j.error.message) || ''; log('api error', r.status, m.slice(0, 160)); const e = new Error(friendly(r.status, m)); e.status = r.status; throw e; }
  for (let i = 0; i < 150 && j.status === 'in_progress' && j.id; i++) {
    await sleep(2000);
    const pr = await fetch(base() + '/v1beta/interactions/' + j.id, {headers: authH()});
    if (pr.ok) j = await pr.json();
  }
  if (j.errors && j.errors.length) throw new Error(j.errors.map(e => e.message).join('; '));
  return j;
}
const outContent = j => { const out = []; (j.steps || []).forEach(s => (s.content || []).forEach(c => { if (c.type === 'text') out.push(c); })); return out; };
/* a model that was still busy after its retries is skipped for 3 minutes, so the next question goes straight to the backup */
const busyUntil = {};
async function askText(prompt, onWait, parts = []){
  let err;
  const list = TEXT_MODELS.filter(m => !(busyUntil[m] > Date.now()));
  for (const m of list.length ? list : TEXT_MODELS) {
    try { const j = await interact({model: m, input: [{type: 'text', text: prompt}, ...parts], store: false}, onWait); return outContent(j).map(c => c.text).join('\n').trim(); }
    catch (e) { err = e; if (![400, 403, 404, 429, 500, 503].includes(e.status) || /คีย์ไม่ถูกต้อง|ยังไม่ได้ใส่คีย์/.test(e.message)) throw e; if ([429, 500, 503].includes(e.status)) busyUntil[m] = Date.now() + 180000; log('fallback', m, e.status); }
  }
  throw err;
}
async function askAI(prompt, onWait, parts = []){
  if (!parts.length) return askText(prompt, onWait);
  try { return await askText(prompt, onWait, parts); }
  catch (e) { if (e.status !== 400) throw e; log('docs rejected', String(e.message).slice(0, 120)); return (await askText(prompt, onWait)) + '\n\n(อ่านเอกสารประกอบไม่ได้ คำตอบนี้มาจากบทสนทนาอย่างเดียว)'; }
}
const busyMsg = el => (n, w) => el.innerHTML = `<span class="spin"></span>Google คนใช้เยอะ ลองใหม่ครั้งที่ ${n} (รอ ${w} วินาที)`;

/* ---------- transcribe ---------- */
$('trBtn').onclick = () => transcribe();
$('redoTr').onclick = () => { if (confirm('ถอดเสียงใหม่ทั้งหมด? ชื่อคนที่ใส่ไว้จะหายไป')) transcribe(); };
async function transcribe(){
  const m = cur; if (!m) return;
  $('trBtn').disabled = true; $('redoTr').disabled = true;
  try {
    const st = await transcribeBlobs(m.audio, m.mime, {diar: $('diar').checked, thai: $('thai').checked}, h => $('trMsg').innerHTML = h);
    Object.assign(m, {items: st.items, order: st.order, names: {}});
    delete m.tasks; m.trans = {};
    await saveMeeting(m);
    if (cur === m) { $('trMsg').textContent = m.items.length ? '' : '⚠️ ไม่ได้ข้อความกลับมา'; renderTranscriptPane(); }
    if (m.items.length && m.autoTitle) autoTitle(m);
  } catch (e) { log('transcribe error', String(e.message || e)); if (cur === m) $('trMsg').textContent = '❌ ' + (e.message || e); }
  finally { $('trBtn').disabled = false; $('redoTr').disabled = false; }
}
async function transcribeBlobs(blobs, mime, opt, say){
  const n = blobs.length, parts = [];
  {
    for (let k = 0; k < n; k++) {
      const pre = n > 1 ? `ช่วงที่ ${k + 1}/${n}: ` : '';
      const blob = blobs[k];
      if (blob.size > 14 * 1048576) throw new Error('ไฟล์ใหญ่เกินไป ลองไฟล์ที่สั้นกว่า 1 ชั่วโมง หรืออัดในแอปแทน');
      say(`<span class="spin"></span>${pre}กำลังถอดเสียง`);
      const tc = {mode: {type: 'verbatim', timestamp_granularities: ['word']}};
      if (opt.diar) tc.mode.diarization_mode = 'speaker';
      if (opt.thai) tc.language_codes = ['th-TH', 'en-US'];
      const data = await b64(blob), req = () => interact({model: TR_MODEL, input: [{type: 'audio', data, mime_type: mime}], generation_config: {transcription_config: tc}, store: false}, (i, w) => say(`<span class="spin"></span>Google คนใช้เยอะ ลองใหม่ครั้งที่ ${i} (รอ ${w} วินาที)`));
      let j;
      try { j = await req(); }
      catch (e) { if (e.status !== 400) throw e; log('no timestamps, retry'); delete tc.mode.timestamp_granularities; j = await req(); }
      const content = outContent(j), text = content.map(c => c.text).join('\n').trim();
      const anns = content.flatMap(c => (c.annotations || []).filter(a => a.type === 'word_info' && typeof a.text === 'string').map(a => ({spk: a.speaker || null, text: a.text.trim(), k, t: secs(a.start_offset)}))).filter(a => a.text);
      log('segment', k, {chars: text.length, anns: anns.length});
      parts.push({anns: anns.length ? anns : (text ? [{spk: null, text}] : [])});
    }
  }
  return stitch(parts);
}
async function autoTitle(m){
  try {
    const t = (await askText(`ตั้งชื่อการประชุมนี้สั้นๆ ไม่เกิน 6 คำ ภาษาไทย บอกหัวข้อหลัก ตอบแค่ชื่อ ไม่มีเครื่องหมายคำพูด\n\n${plainText(m).slice(0, 6000)}`)).split('\n')[0].replace(/^["'“]|["'”]$/g, '').trim();
    if (t && t.length < 60) { m.title = t; m.autoTitle = false; await saveMeeting(m); if (cur === m) { $('mTitle').value = t; fitTitle(); } }
  } catch (e) { log('title', String(e.message || e)); }
}

const secs = v => { if (v == null) return null; if (typeof v === 'number') return v; if (typeof v === 'object') return (+v.seconds || 0) + (+v.nanos || 0) / 1e9; const n = parseFloat(String(v)); return isFinite(n) ? n : null; };
/* join overlapping segments: matching repeated sentences tells which speaker is which */
const norm = s => s.replace(/[\s.,!?'"“”…\-–—:;()]/g, '');
function bigrams(s){ const b = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); b.set(g, (b.get(g) || 0) + 1); } return b; }
function overlapScore(a, b){
  a = norm(a); b = norm(b); if (a.length < 6 || b.length < 6) return 0;
  const A = bigrams(a), B = bigrams(b); let hit = 0, na = 0, nb = 0;
  A.forEach(v => na += v); B.forEach(v => nb += v); A.forEach((v, g) => hit += Math.min(v, B.get(g) || 0));
  return hit / Math.min(na, nb);
}
function stitch(parts){
  const out = [], order = []; let gn = 0;
  parts.forEach((p, k) => {
    const map = {}, anns = p.anns.map(a => ({...a}));
    if (k > 0 && out.length) {
      const tail0 = Math.max(0, out.length - 8), votes = {};
      anns.slice(0, 8).forEach(h => {
        let best = 0, bi = -1;
        for (let i = tail0; i < out.length; i++) { if (out[i].drop) continue; const sc = overlapScore(h.text, out[i].text); if (sc > best) { best = sc; bi = i; } }
        if (best < 0.6) return;
        const tl = out[bi];
        if (h.spk && tl.g) { const v = votes[h.spk] || (votes[h.spk] = {}); v[tl.g] = (v[tl.g] || 0) + norm(h.text).length; }
        if (norm(tl.text).length <= norm(h.text).length) tl.drop = true; else h.drop = true;
      });
      const used = new Set();
      Object.entries(votes).map(([sp, v]) => [sp, ...Object.entries(v).sort((a, b) => b[1] - a[1])[0]]).sort((a, b) => b[2] - a[2])
        .forEach(([sp, g]) => { if (!used.has(g)) { map[sp] = g; used.add(g); } });
      const freeLocal = [...new Set(anns.map(a => a.spk).filter(sp => sp && !(sp in map)))], freeGlobal = order.filter(g => !used.has(g));
      if (Object.keys(map).length && freeLocal.length === 1 && freeGlobal.length === 1) map[freeLocal[0]] = freeGlobal[0];
    }
    anns.forEach(a => {
      let g = null;
      if (a.spk) { if (!(a.spk in map)) { map[a.spk] = 'g' + (++gn); order.push(map[a.spk]); } g = map[a.spk]; }
      if (!a.drop) out.push({g, text: a.text, k: a.k, t: a.t});
    });
  });
  return {items: out.filter(o => !o.drop).map(({g, text, k, t}) => (t == null ? {g, text} : {g, text, k, t})), order};
}

const label = (m, g) => ((m.names || {})[g] || '').trim() || 'คนที่ ' + (m.order.indexOf(g) + 1);
function lines(m){
  const out = [];
  m.items.forEach(it => {
    const who = m.order.length ? label(m, it.g) : '', last = out[out.length - 1];
    if (last && last.who === who) last.t += ' ' + it.text; else out.push({who, t: it.text, c: Math.min(m.order.indexOf(it.g) + 1, 6) % 6, k: it.k || 0, at: it.t});
  });
  return out;
}
const plainText = m => lines(m).map(l => (l.who ? l.who + ': ' : '') + l.t).join('\n');

function renderTranscriptPane(){
  const m = cur, has = m.items && m.items.length;
  $('trSetup').hidden = !!has; $('trTools').hidden = !has;
  if (!has) { $('trOut').innerHTML = ''; $('names').hidden = true; transcript = ''; return; }
  transcript = plainText(m);
  if (m.order.length) {
    $('nameList').innerHTML = m.order.map((g, i) => {
      const first = m.items.find(it => it.g === g), hint = first ? first.text.slice(0, 40) + (first.text.length > 40 ? '…' : '') : '';
      return `<label class="nm"><span class="spk c${Math.min(i + 1, 6) % 6}">คนที่ ${i + 1}</span><input type="text" data-g="${g}" list="people" placeholder="ใส่ชื่อ หรือเลือกชื่อเดิม" autocomplete="off" value="${esc(m.names[g] || '')}"><small>${esc(hint)}</small></label>`;
    }).join('');
    $('nameList').querySelectorAll('input').forEach(inp => {
      inp.oninput = () => { m.names[inp.dataset.g] = inp.value; drawLines(); };
      inp.onchange = () => { learnName(inp.value); saveMeeting(m); };
    });
    const named = m.order.filter(g => (m.names[g] || '').trim()).length;
    $('namesSum').textContent = `ตั้งชื่อคนพูด (${named}/${m.order.length} คน)`;
    $('names').open = named === 0;
    $('names').hidden = false;
  } else $('names').hidden = true;
  drawLines();
}
function drawLines(){
  const ls = lines(cur); transcript = plainText(cur);
  const pinned = new Map();
  (cur.pins || []).forEach(p => { let best = -1; ls.forEach((l, i) => { if (l.at != null && gT(l) <= p + 2) best = i; }); if (best >= 0 && !pinned.has(best)) pinned.set(best, p); });
  renderStats(); drawStrip(ls);
  $('trOut').innerHTML = cur.order.length
    ? '<div class="tr">' + ls.map((l, i) => (pinned.has(i) ? `<div class="pindiv">${PIN_SVG}ปักหมุดไว้ ${fmt(pinned.get(i))}</div>` : '')
      + `<div class="ln c${l.c}"${l.at != null ? ` data-g="${gT(l)}"` : ''}><span class="av" aria-hidden="true">${initial(l.who)}</span><div class="tb"><div class="nmh"><b title="${esc(l.who)}">${esc(l.who)}</b>${l.at != null ? `<button class="ts" data-k="${l.k}" data-t="${l.at}" aria-label="ฟังตรงนี้">${fmt(l.k * STEP + l.at)}</button>` : ''}</div><p>${esc(l.t)}</p></div></div>`).join('') + '</div>'
    : `<div class="plain">${esc(transcript)}</div>`;
}
/* who spoke when, drawn as the player's scrubber */
function drawStrip(ls){
  const segs = $('ppSegs'), leg = $('ppLeg'); if (!segs) return;
  const timed = ls.filter(l => l.at != null), D = Math.max(1, cur.dur || 1);
  if (!timed.length) { segs.innerHTML = '<i class="c0" style="flex:1"></i>'; leg.innerHTML = ''; return; }
  segs.innerHTML = timed.map((l, i) => { const a = gT(l), b = i + 1 < timed.length ? gT(timed[i + 1]) : D; return `<i class="c${l.c}" style="flex:${Math.max(0.2, b - a).toFixed(1)}"></i>`; }).join('');
  const seen = []; ls.forEach(l => { if (l.who && !seen.some(x => x.who === l.who)) seen.push(l); });
  leg.innerHTML = seen.slice(0, 3).map(l => `<span class="c${l.c}"><i></i>${esc(l.who)}</span>`).join('') + (seen.length > 3 ? `<span>+${seen.length - 3}</span>` : '');
}
/* the bubble being heard gets the mint ring */
function markLine(T){
  const all = $('trOut').querySelectorAll('.ln[data-g]'); let hit = null;
  all.forEach(x => { if (+x.dataset.g <= T + 0.3) hit = x; });
  all.forEach(x => x.classList.toggle('now', x === hit));
}
$('trOut').onclick = e => { const b = e.target.closest('.ts'); if (b) playAt(+b.dataset.k, +b.dataset.t, b); };
const PLAY_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.9l10.4-6.5a1 1 0 0 0 0-1.8L9.5 4.6A1 1 0 0 0 8 5.5z"/></svg>',
  PAUSE_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';
/* long meetings are several overlapping files; one player walks across them on a single timeline */
function wirePlayer(){
  const bar = $('ppBar'), btn = $('ppBtn'), auds = [...$('mAudio').querySelectorAll('audio')];
  let dragging = false;
  const playing = () => auds.some(a => !a.paused);
  const icon = () => { const on = playing(); btn.innerHTML = on ? PAUSE_SVG : PLAY_SVG; btn.setAttribute('aria-label', on ? 'หยุด' : 'เล่น'); };
  auds.forEach(a => { a.addEventListener('play', icon); a.addEventListener('pause', () => setTimeout(icon, 30)); });
  btn.onclick = () => { if (playing()) auds.forEach(a => a.pause()); else seekGlobal(+bar.value >= +bar.max - 1 ? 0 : +bar.value, 0); };
  const paint = T => { const pc = Math.min(100, Math.max(0, T / Math.max(1, +bar.max) * 100)); $('ppRest').style.left = pc + '%'; $('ppHead').style.left = pc + '%'; $('ppTime').innerHTML = `<b>${fmt(T)}</b> / ${fmt(cur.dur)}`; };
  bar.oninput = () => { dragging = true; paint(+bar.value); };
  bar.onchange = () => { dragging = false; if (playing()) seekGlobal(+bar.value, 0); else markLine(+bar.value); };
  wirePlayer.sync = T => { markLine(T); if (dragging) return; bar.value = Math.round(T); paint(T); };
}
function playAt(k, t, btn, pre = 0.5){
  const auds = $('mAudio').querySelectorAll('audio'), a = auds[Math.min(k, auds.length - 1)]; if (!a) return;
  auds.forEach(x => { if (x !== a) x.pause(); });
  document.querySelectorAll('.ln.now').forEach(x => x.classList.remove('now'));
  if (btn) btn.closest('.ln').classList.add('now');
  const go = () => { a.currentTime = Math.max(0, t - pre); a.play().catch(() => {}); };
  if (a.readyState >= 1) go(); else { a.preload = 'auto'; a.addEventListener('loadedmetadata', go, {once: true}); a.load(); }
  const pill = $('nowPlaying'); pill.hidden = false;
  const next = () => { a.ontimeupdate = a.onended = a.onpause = null; a.pause(); playAt(k + 1, Math.max(0, a.currentTime - STEP), null, 0); };
  const tick = () => {
    const T = k * STEP + a.currentTime;
    pill.querySelector('span').textContent = fmt(T);
    if (wirePlayer.sync) wirePlayer.sync(T);
    if (k < auds.length - 1 && a.currentTime >= STEP) next();
  };
  a.ontimeupdate = tick; a.onpause = () => { pill.hidden = true; }; tick();
  a.onended = () => { if (k < auds.length - 1) next(); };
  pill.onclick = () => a.pause();
}
$('copyTr').onclick = () => copy(transcript, $('copyTr'), 'คัดลอกบทสนทนา');
$('guessBtn').onclick = async () => {
  const m = cur; $('guessBtn').disabled = true; $('guessMsg').innerHTML = '<span class="spin"></span>กำลังเดา';
  const plain = m.items.map(it => `คนที่ ${m.order.indexOf(it.g) + 1}: ${it.text}`).join('\n').slice(0, 30000);
  try {
    const t = await askText(`จากบทสนทนาด้านล่าง เดาชื่อหรือชื่อเล่นของแต่ละคน ดูจากที่คนอื่นเรียกหรือที่แนะนำตัว\nตอบเป็น JSON อย่างเดียว เช่น {"คนที่ 1": "ชื่อ", "คนที่ 2": ""} ถ้าเดาไม่ได้ใส่ "" ห้ามเดามั่ว${people().length ? '\nชื่อที่ทีมนี้เคยใช้ (ถ้าตรงให้สะกดตามนี้): ' + people().join(', ') : ''}\n\n${plain}`);
    const g = JSON.parse((t.match(/\{[\s\S]*\}/) || ['{}'])[0]); let filled = 0;
    m.order.forEach((id, i) => { const v = (g['คนที่ ' + (i + 1)] || '').trim(); if (v && !m.names[id]) { m.names[id] = v; learnName(v); filled++; } });
    await saveMeeting(m); if (cur === m) renderTranscriptPane();
    $('guessMsg').textContent = filled ? `เติมให้ ${filled} คน ตรวจดูอีกที` : 'ในบทสนทนาไม่มีใครเรียกชื่อ พิมพ์เองได้เลย';
  } catch (e) { $('guessMsg').textContent = '❌ ' + (e.message || e); }
  finally { $('guessBtn').disabled = false; }
};

/* ---------- summary ---------- */
const RULES = `กติกา:
- เขียนภาษาไทย อ่านง่าย ใช้ Markdown (หัวข้อ ##, ###, bullet และตาราง)
- เรียกคนตามชื่อที่ใช้ในบทสนทนา
- เก็บตัวเลข วันที่ ราคา ชื่อสินค้า ชื่อแคมเปญ ให้ตรงตามที่พูด
- ห้ามแต่งข้อมูลที่ไม่มีในบทสนทนา ถ้าหัวข้อไหนไม่มีข้อมูลให้เขียนว่า "ไม่มีในบทสนทนา"`;
const TEMPLATES = {
  meeting: `คุณเป็นเลขาที่จดรายงานการประชุมอย่างละเอียด สรุปการประชุมต่อไปนี้ตามหัวข้อ:
## ภาพรวม
3-5 ประโยค: ประชุมเรื่องอะไร ใครอยู่ในวง ได้ข้อสรุปหลักอะไร
## รายละเอียดแต่ละประเด็น
แยกเป็น ### ชื่อประเด็น ตามลำดับที่คุย แต่ละประเด็นบอก: ใครเสนออะไร เหตุผล ข้อมูลหรือตัวเลขที่ยกมา ความเห็นที่ไม่ตรงกัน และจบที่อะไร
## สิ่งที่ตกลงกัน
## สิ่งที่ต้องทำต่อ
ตาราง: | งาน | ใครทำ | กำหนดส่ง | หมายเหตุ |
## เรื่องที่ยังค้าง หรือต้องถามเพิ่ม
## ตัวเลขและข้อมูลสำคัญ`,
  plan: `คุณเป็นผู้ช่วยวางแผนงาน สรุปบทสนทนาต่อไปนี้ให้เป็นแผนงานที่เอาไปทำต่อได้ทันที ตามหัวข้อ:
## เป้าหมาย
## สิ่งที่จะทำ
แยกเป็น ### ชื่องาน แต่ละงานบอก: ทำอะไร ทำยังไง ใช้อะไรบ้าง
## ไทม์ไลน์
ตาราง: | ช่วงเวลา | งาน | ใครทำ |
## งบประมาณและทรัพยากร
## วิธีวัดผล (KPI)
## ความเสี่ยงและทางแก้
## สิ่งที่ต้องทำสัปดาห์นี้`,
  short: `สรุปบทสนทนาต่อไปนี้แบบสั้น อ่านจบใน 1 นาที:
## ใจความสำคัญ
ไม่เกิน 5 bullet
## สิ่งที่ต้องทำต่อ
bullet: งาน — ใครทำ — กำหนดส่ง`,
  todo: `ดึงเฉพาะสิ่งที่ต้องทำต่อจากบทสนทนานี้
## สิ่งที่ต้องทำ
ตาราง: | งาน | ใครทำ | กำหนดส่ง | ความด่วน |
เรียงจากด่วนที่สุดก่อน ถ้าไม่ระบุคนหรือวันให้เขียน "ไม่ระบุ"
## สิ่งที่ต้องตัดสินใจต่อ`
};
$('tpl').onchange = renderSummary;
function renderSummary(){
  [...$('tpl').options].forEach(o => { o.dataset.l = o.dataset.l || o.textContent; o.textContent = (cur && cur.summaries && cur.summaries[o.value] ? '✓ ' : '') + o.dataset.l; });
  const s = cur && cur.summaries && cur.summaries[$('tpl').value];
  $('sumOut').innerHTML = s ? md(s) : '';
  $('copySum').hidden = !s; $('sumTools').hidden = !s; $('sumTrOut').innerHTML = '';
  $('sumBtn').textContent = s ? 'สรุปใหม่' : 'สรุป';
}
$('sumBtn').onclick = async () => {
  const m = cur, tpl = $('tpl').value;
  if (!m.items.length) { $('sumMsg').textContent = 'ถอดเสียงก่อน (แท็บบทสนทนา)'; return; }
  $('sumBtn').disabled = true; $('sumMsg').innerHTML = '<span class="spin"></span>กำลังสรุป';
  try {
    const text = await askAI(`${TEMPLATES[tpl]}\n\n${RULES}\n${aiRules(m)}\n${await followUps(m)}\n\nบทสนทนา:\n${aiText(m, 300000)}`, busyMsg($('sumMsg')), await docParts(m));
    m.summaries[tpl] = text; await saveMeeting(m);
    if (cur === m) { $('sumMsg').textContent = ''; renderSummary(); }
    if (localStorage.getItem(MEMAUTO_LS) !== '0') {
      if (cur === m) $('sumMsg').innerHTML = '<span class="spin"></span>กำลังจดลงความจำทีม';
      updateMemory(m, text).then(ok => { if (cur === m) $('sumMsg').textContent = ok ? 'จดลงความจำทีมแล้ว ดูและแก้ได้ที่หน้าตั้งค่า' : ''; }).catch(() => { if (cur === m) $('sumMsg').textContent = ''; });
    }
  } catch (e) { if (cur === m) $('sumMsg').textContent = '❌ ' + (e.message || e); }
  finally { $('sumBtn').disabled = false; }
};
/* promises made in earlier meetings that are still open: the summary says what happened to each */
async function followUps(m){
  const prev = (await allMeetings() || []).filter(x => x.created < m.created && x.id !== m.id).sort((a, b) => b.created - a.created).slice(0, 8);
  const open = []; prev.forEach(x => (x.tasks || []).forEach(t => { if (!t.done) open.push(`- ${t.task} (${t.who || 'ไม่ระบุ'}${t.due && t.due !== 'ไม่ระบุ' ? ', ส่ง ' + t.due : ''}) จากประชุม "${x.title}" ${new Date(x.created).toLocaleDateString('th-TH', {day: 'numeric', month: 'short'})}`); }));
  if (!open.length) return '';
  return `- งานที่ยังค้างจากประชุมก่อน:\n${open.slice(0, 25).join('\n')}\n- ท้ายสรุปให้เพิ่มหัวข้อ "## ติดตามงานจากครั้งก่อน" บอกทีละงานว่าในประชุมนี้มีคนพูดว่าเสร็จแล้ว คืบหน้า หรือเลื่อน (ใส่เวลาอ้างอิง) งานที่ไม่มีใครพูดถึงให้รวมไว้ในข้อเดียวว่า "ยังไม่มีใครพูดถึง: ..." ห้ามเดาว่าเสร็จ`;
}
$('copySum').onclick = () => copy($('sumOut').innerText.trim(), $('copySum'), 'คัดลอกสรุป');

/* ---------- ask AI ---------- */
const CHIPS = ['ใครต้องทำอะไรบ้าง', 'สรุป 3 บรรทัด', 'ร่างข้อความ LINE แจ้งทีม', 'ร่างอีเมลสรุปถึงหัวหน้า', 'มีเรื่องไหนยังไม่ได้ตัดสินใจ', 'ตัวเลขสำคัญมีอะไรบ้าง'];
$('chips').innerHTML = CHIPS.map(c => `<button>${esc(c)}</button>`).join('');
$('chips').querySelectorAll('button').forEach(b => b.onclick = () => ask(b.textContent));
$('askBtn').onclick = () => ask($('askIn').value);
$('askMic').onclick = () => voiceInto($('askMic'), $('askIn'), ask);
$('askIn').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask($('askIn').value); } });
$('askIn').addEventListener('input', () => { const t = $('askIn'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 120) + 'px'; });
function renderChat(extra){
  const c = (cur && cur.chat) || [];
  $('chat').innerHTML = (c.length || extra ? '' : '<p class="hint">ถามอะไรก็ได้เกี่ยวกับประชุมนี้ เช่น ใครรับงานอะไร ตกลงเรื่องงบว่ายังไง หรือให้ช่วยร่างข้อความ</p>')
    + c.map(x => `<div class="bub q">${esc(x.q)}</div><div class="bub a"><div class="sum">${md(x.a)}</div>${SAY_BTN}</div>`).join('') + (extra || '');
}
let asking = false;
async function ask(q){
  q = (q || '').trim(); const m = cur;
  if (!q || asking || !m) return;
  asking = true; $('askIn').value = ''; $('askIn').style.height = 'auto'; $('askBtn').disabled = true;
  renderChat(`<div class="bub q">${esc(q)}</div><div class="bub a" id="pending"><span class="spin"></span>กำลังคิด</div>`);
  $('pending').scrollIntoView({block: 'nearest', behavior: 'smooth'});
  const prompt = askPrompt(m, q, m.chat);
  try {
    const a = await askAI(prompt, (n, w) => { const p = $('pending'); if (p) p.innerHTML = `<span class="spin"></span>Google คนใช้เยอะ ลองใหม่ครั้งที่ ${n}`; }, await docParts(m));
    m.chat.push({q, a, t: Date.now()}); await saveMeeting(m);
  } catch (e) {
    if (cur === m) { renderChat(`<div class="bub q">${esc(q)}</div><div class="bub a">❌ ${esc(e.message || e)}</div>`); $('askIn').value = q; }
    asking = false; $('askBtn').disabled = false; return;
  }
  asking = false; $('askBtn').disabled = false;
  if (cur === m) { renderChat(); const bs = $('chat').querySelectorAll('.bub.a'); if (bs.length) bs[bs.length - 1].scrollIntoView({block: 'start', behavior: 'smooth'}); }
}
function askPrompt(m, q, chat){
  const hist = (chat || []).slice(-6).map(x => `ผู้ใช้: ${x.q}\nผู้ช่วย: ${x.a}`).join('\n\n');
  const sum = Object.values(m.summaries || {})[0];
  return `คุณเป็นผู้ช่วยของทีม ตอบคำถามเกี่ยวกับการประชุมด้านล่าง ตอบภาษาไทย กระชับ ตรงประเด็น ใช้ Markdown ได้
- ถ้าถามเรื่องในประชุมแต่ไม่มีข้อมูลในบทสนทนา ให้บอกตรงๆ ว่าไม่มีในบทสนทนา ห้ามเดา
- ถ้าขอให้ร่างข้อความ อีเมล หรือแผน ให้ร่างจากข้อมูลในประชุม พร้อมใช้ได้เลย
- ถ้าถามเรื่องทั่วไปที่ไม่เกี่ยวกับประชุม ตอบได้ตามปกติ
${aiRules(m)}

บทสนทนาการประชุม "${m.title}":
${m.items.length ? aiText(m, 200000) : '(ยังไม่ได้ถอดเสียง)'}
${sum ? '\nสรุปที่มีอยู่:\n' + sum.slice(0, 6000) : ''}
${hist ? '\nบทสนทนาก่อนหน้ากับผู้ใช้:\n' + hist : ''}

คำถามใหม่: ${q}`;
}

/* ---------- helpers ---------- */
async function copy(text, btn, label){
  if (!text) return;
  try { await navigator.clipboard.writeText(text); btn.textContent = '✅ คัดลอกแล้ว'; }
  catch { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); btn.textContent = '✅ คัดลอกแล้ว'; }
  setTimeout(() => btn.textContent = label, 2200);
}
const TSR = '\\d{1,2}:\\d{2}(?::\\d{2})?';
const CITE_RE = new RegExp(`\\[((?:M\\d+\\s+)?${TSR}(?:\\s*[,–-]\\s*(?:M\\d+\\s+)?${TSR})*)\\]`, 'g');
const secsOf = p => p.split(':').reduce((a, x) => a * 60 + (+x), 0);
function inline(s){
  return esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(CITE_RE, (all, inner) => {
    let tag = '';
    return inner.split(/\s*[,–-]\s*/).map(p => { const mm = p.match(/^M(\d+)\s+(.+)$/); if (mm) { tag = mm[1]; p = mm[2]; } return `<button class="cite" data-t="${secsOf(p)}"${tag ? ` data-m="${tag}"` : ''}>${p}</button>`; }).join(' ');
  });
}
function md(s){
  const out = []; let list = false, table = null;
  const flush = () => {
    if (list) { out.push('</ul>'); list = false; }
    if (table) {
      const rows = table.filter(r => !/^\|?\s*:?-{2,}/.test(r)).map(r => r.replace(/^\||\|$/g, '').split('|').map(c => c.trim()));
      out.push('<div class="tw"><table>' + rows.map((r, i) => '<tr>' + r.map(c => i ? `<td>${inline(c)}</td>` : `<th>${inline(c)}</th>`).join('') + '</tr>').join('') + '</table></div>');
      table = null;
    }
  };
  String(s).split('\n').forEach(raw => {
    const l = raw.trim();
    if (/^\|.*\|$/.test(l)) { if (list) { out.push('</ul>'); list = false; } (table || (table = [])).push(l); return; }
    if (table) flush();
    if (/^([-*•]|\d+\.)\s+/.test(l)) { if (!list) { out.push('<ul>'); list = true; } out.push('<li>' + inline(l.replace(/^([-*•]|\d+\.)\s+/, '')) + '</li>'); return; }
    flush();
    if (/^###\s/.test(l)) out.push('<h4>' + inline(l.replace(/^#+\s/, '')) + '</h4>');
    else if (/^#{1,2}\s/.test(l)) out.push('<h3>' + inline(l.replace(/^#+\s/, '')) + '</h3>');
    else if (l) out.push('<p>' + inline(l) + '</p>');
  });
  flush();
  return out.join('');
}
$('copyLog').onclick = () => copy(logs.join('\n'), $('copyLog'), 'คัดลอกบันทึก');

/* ---------- install ---------- */
let installEvt = null;
addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; $('installBtn').hidden = false; });
$('installBtn').onclick = async () => { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice; installEvt = null; $('installBtn').hidden = true; };
if (standalone) $('installCard').hidden = true;
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(e => log('sw', String(e)));

/* ---------- AI context: time references, glossary, pins, documents ---------- */
const PIN_SVG = '<svg class="pinic" viewBox="0 0 24 24" fill="currentColor" aria-label="ปักหมุด"><path d="M14.5 2.5l7 7-2.2.6-3.8 3.8.4 4.6-1.6 1.6-4.2-4.2L4.5 21.5l-1-1 5.6-5.6-4.2-4.2 1.6-1.6 4.6.4 3.8-3.8z"/></svg>';
const SAY_BTN = '<button class="say" aria-label="อ่านออกเสียง"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/></svg>ฟัง</button>';
const GLOSS_LS = 'chy-gloss', PEOPLE_LS = 'chy-people', MEM_LS = 'chy-memory', MEMAUTO_LS = 'chy-memory-auto';
const glossRaw = () => (localStorage.getItem(GLOSS_LS) || '').trim();
const people = () => { try { return JSON.parse(localStorage.getItem(PEOPLE_LS) || '[]'); } catch (e) { return []; } };
/* every name typed for a speaker is remembered: offered next time, and spelled right by the AI */
function learnName(n){
  n = String(n || '').trim(); if (!n || /^คนที่\s*\d+$/.test(n) || n.length > 40) return;
  const ps = people().filter(x => x !== n); ps.unshift(n); localStorage.setItem(PEOPLE_LS, JSON.stringify(ps.slice(0, 60))); renderPeople();
}
function renderPeople(){
  $('people').innerHTML = people().map(n => `<option value="${esc(n)}"></option>`).join('');
  $('peopleList').innerHTML = people().length ? people().map((n, i) => `<span class="doc"><span>${esc(n)}</span><button data-i="${i}" aria-label="ลืมชื่อนี้">×</button></span>`).join('') : '<span class="msg">ยังไม่มี ตั้งชื่อคนพูดในประชุมแล้วชื่อจะมาอยู่ที่นี่เอง</span>';
  $('peopleList').querySelectorAll('button').forEach(b => b.onclick = () => { const ps = people(); ps.splice(+b.dataset.i, 1); localStorage.setItem(PEOPLE_LS, JSON.stringify(ps)); renderPeople(); });
}
const gloss = () => { const g = glossRaw(), have = new Set(g.split(/\n+/).map(x => x.trim())); return [g, ...people().filter(n => !have.has(n))].filter(Boolean).join('\n'); };
$('gloss').value = glossRaw();
renderPeople();

/* team memory: a short notebook the AI keeps about people, projects and standing agreements */
const memory = () => (localStorage.getItem(MEM_LS) || '').trim();
const memLine = () => memory() ? `- ความจำทีมจากประชุมก่อนๆ (ใช้เป็นพื้นหลังเพื่อเข้าใจว่าใครเป็นใคร โปรเจกต์ไหนคืออะไร ห้ามเอามาเขียนเป็นเนื้อหาของประชุมนี้ ถ้าขัดกับบทสนทนาให้เชื่อบทสนทนา):\n${memory()}` : '';
function renderMemory(){
  $('mem').value = memory();
  const at = +localStorage.getItem(MEM_LS + '-at') || 0;
  $('memAt').textContent = at ? 'อัปเดตล่าสุด ' + new Date(at).toLocaleString('th-TH', {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'}) : 'ยังว่างอยู่ จะเริ่มจดหลังสรุปประชุมครั้งแรก';
  $('memAuto').checked = localStorage.getItem(MEMAUTO_LS) !== '0';
}
const setMemory = t => { localStorage.setItem(MEM_LS, (t || '').trim()); localStorage.setItem(MEM_LS + '-at', Date.now()); renderMemory(); };
$('saveMem').onclick = () => { setMemory($('mem').value); $('memMsg').textContent = 'บันทึกแล้ว'; };
$('clearMem').onclick = () => { if (!confirm('ล้างความจำทีมทั้งหมด? AI จะเริ่มจดใหม่จากประชุมถัดไป')) return; localStorage.removeItem(MEM_LS); localStorage.removeItem(MEM_LS + '-at'); renderMemory(); $('memMsg').textContent = 'ล้างแล้ว'; };
$('memAuto').onchange = () => localStorage.setItem(MEMAUTO_LS, $('memAuto').checked ? '1' : '0');
async function updateMemory(m, summary){
  const d = new Date(m.created).toLocaleDateString('th-TH', {day: 'numeric', month: 'long', year: 'numeric'});
  const clean = summary.replace(/\[(?:M\d+\s+)?[\d:,\s–-]+\]/g, '').slice(0, 12000);
  const t = await askText(`คุณดูแล "ความจำทีม" ของทีมนี้ เป็นสมุดสั้นๆ ที่ AI อ่านก่อนสรุปประชุมทุกครั้ง เพื่อให้รู้ว่าใครเป็นใคร ทำงานอะไร และกำลังทำโปรเจกต์อะไรอยู่

ความจำเดิม:
${memory() || '(ยังว่าง)'}

สรุปประชุมใหม่ "${m.title}" วันที่ ${d}:
${clean}

เขียนความจำฉบับใหม่ทั้งหมด รวมของเดิมกับเรื่องใหม่ ใช้รูปแบบนี้เท่านั้น:
## คนในทีม
- ชื่อ: หน้าที่หรืองานที่ดูแล
## โปรเจกต์และแคมเปญ
- ชื่อ: สถานะล่าสุด (วันที่)
## ข้อตกลงที่ยังใช้อยู่
- ข้อตกลง (วันที่ตกลง)

กติกา:
- ไม่เกิน 40 บรรทัด เก็บเฉพาะเรื่องที่จะช่วยให้เข้าใจประชุมครั้งหน้า ตัดเรื่องที่จบไปแล้ว
- ห้ามแต่งข้อมูลที่ไม่มีในความจำเดิมหรือในสรุป ถ้าไม่แน่ใจว่าใครทำหน้าที่อะไร ไม่ต้องใส่
- ไม่ต้องใส่งานรายชิ้นที่มีกำหนดส่ง (มีรายการงานแยกอยู่แล้ว)
- ตอบเฉพาะความจำฉบับใหม่ ไม่ต้องอธิบาย`);
  const out = (t || '').trim();
  if (out.includes('##')) setMemory(out.split('\n').slice(0, 45).join('\n'));
  return out.includes('##');
}
$('saveGloss').onclick = () => { localStorage.setItem(GLOSS_LS, $('gloss').value.trim()); $('glossMsg').textContent = 'บันทึกแล้ว ใช้กับการสรุปและการถามครั้งต่อไป'; };
const hasTimes = m => (m.items || []).some(it => it.t != null);
const gT = l => l.k * STEP + l.at;
const mtag = m => 'M' + String(m.id).replace(/\D/g, '').slice(-6);

function aiText(m, max = 60000, withTag = false){
  const timed = hasTimes(m), tg = withTag ? mtag(m) + ' ' : '';
  let s = lines(m).map(l => (timed && l.at != null ? `[${tg}${fmt(gT(l))}] ` : '') + (l.who ? l.who + ': ' : '') + l.t).join('\n');
  if (s.length > max) s = s.slice(0, max) + '\n(ส่วนที่เหลือยาวเกิน ตัดออก)';
  return s;
}
function aiRules(m){
  const r = [];
  if (hasTimes(m)) r.push('- ทุกข้อเท็จจริงที่มาจากบทสนทนา ใส่เวลาอ้างอิงในวงเล็บเหลี่ยมท้ายประโยค เช่น [12:34] ใช้เวลาที่ปรากฏในบทสนทนาเท่านั้น ห้ามแต่งเวลาเอง');
  r.push('- ตัวเลข ราคา วันที่ เปอร์เซ็นต์ ให้ใช้ตามที่พูดในบทสนทนาเท่านั้น ถ้าฟังไม่ชัดหรือพูดขัดกันให้ต่อท้ายว่า (ตรวจอีกที)');
  if (gloss() && !m.test) r.push('- คำเฉพาะของทีม บทสนทนาอาจถอดเสียงผิด ให้สะกดตามรายการนี้: ' + gloss().replace(/\n+/g, ', '));
  if (memLine() && !m.test) r.push(memLine());
  if (m.pins && m.pins.length) r.push(`- ผู้ใช้ปักหมุดว่าช่วงนี้สำคัญ: ${m.pins.map(fmt).join(', ')} สรุปเนื้อหาราว 1 นาทีรอบจุดเหล่านี้ให้ละเอียดเป็นพิเศษ ในหัวข้อ "ช่วงที่ปักหมุด"`);
  if (m.docs && m.docs.length) r.push(`- มีเอกสารประกอบแนบมา ${m.docs.length} ไฟล์ (${m.docs.map(d => d.name).join(', ')}) ใช้เป็นบริบท ถ้าใช้ข้อมูลจากเอกสารให้ต่อท้ายว่า (จากเอกสาร)`);
  return r.join('\n');
}
async function docParts(m){
  const out = [];
  for (const d of (m && m.docs) || []) out.push({type: d.type === 'application/pdf' ? 'document' : 'image', data: await b64(d.blob), mime_type: d.type});
  return out;
}

/* citations: tap a [12:34] to hear it; [M123456 12:34] opens that meeting first */
function seekGlobal(T, pre = 0.5){
  if (!cur) return;
  const n = cur.audio.length, k = Math.max(0, Math.min(n - 1, Math.floor(T / STEP)));
  playAt(k, T - k * STEP, null, pre);
}
document.addEventListener('click', async e => {
  const c = e.target.closest('.cite'); if (!c) return;
  const T = +c.dataset.t;
  if (c.dataset.m) {
    const m = (await allMeetings() || []).find(x => String(x.id).replace(/\D/g, '').endsWith(c.dataset.m));
    if (!m) return;
    await openMeeting(m.id);
  }
  seekGlobal(T);
});

/* ---------- documents attached to a meeting ---------- */
/* phone photos and slide exports are 3-5 MB each; 1600 px JPEG keeps slide text readable at a tenth of the size */
async function shrinkImage(f){
  if (!/^image\/(jpeg|png|webp|heic|heif)$/.test(f.type) || f.size < 400 * 1024) return f;
  try {
    const bmp = await createImageBitmap(f), k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, 0, 0, c.width, c.height); bmp.close && bmp.close();
    const out = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.82));
    return out && out.size < f.size ? new File([out], f.name.replace(/\.[^.]+$/, '') + '.jpg', {type: 'image/jpeg'}) : f;
  } catch (e) { return f; }
}
const mb = n => (n / 1048576).toFixed(n < 1048576 ? 2 : 1) + ' MB';
/* shared: add picked files to a doc list, images and PDF only, 12 MB in total */
async function addDocs(list, files){
  let total = list.reduce((a, d) => a + d.blob.size, 0), skipped = [], before = 0, after = 0;
  for (const f0 of files) {
    if (!/^image\/|application\/pdf/.test(f0.type)) { skipped.push(`${f0.name} ไม่ใช่รูปหรือ PDF`); continue; }
    const f = await shrinkImage(f0); before += f0.size; after += f.size;
    if (total + f.size > 12 * 1048576) { skipped.push(`${f0.name} (${mb(f.size)}) ใส่แล้วเกิน 12 MB`); continue; }
    list.push({name: f.name, type: f.type, blob: f}); total += f.size;
  }
  return [before - after > 512 * 1024 ? `ย่อรูปจาก ${mb(before)} เหลือ ${mb(after)}` : '', skipped.length ? 'ข้าม: ' + skipped.join(', ') : '', list.length ? `ใช้ไป ${mb(total)} จาก 12 MB` : ''].filter(Boolean).join(' · ');
}
const preDocs = [];
function renderPreDocs(){
  $('preList').innerHTML = preDocs.map((x, i) => `<span class="doc" title="${esc(x.name)}"><span>${esc(x.name)}</span><button data-i="${i}" aria-label="เอาออก">×</button></span>`).join('');
  $('preList').querySelectorAll('button').forEach(b => b.onclick = () => { preDocs.splice(+b.dataset.i, 1); renderPreDocs(); });
  $('preHint').textContent = preDocs.length ? `${preDocs.length} ไฟล์ จะติดไปกับประชุมที่อัดต่อจากนี้` : 'สไลด์ วาระประชุม หรือ PDF ให้ AI อ่านประกอบตอนสรุป';
}
$('preIn').onchange = async e => { const fs = [...e.target.files]; e.target.value = ''; $('preMsg').innerHTML = '<span class="spin"></span>กำลังเตรียมไฟล์'; $('preMsg').textContent = await addDocs(preDocs, fs); renderPreDocs(); };
function renderDocs(){
  const d = cur.docs || [];
  $('docList').innerHTML = d.map((x, i) => `<span class="doc" title="${esc(x.name)}"><span>${esc(x.name)}</span><button data-i="${i}" aria-label="เอาออก">×</button></span>`).join('');
  $('docList').querySelectorAll('button').forEach(b => b.onclick = async () => { cur.docs.splice(+b.dataset.i, 1); await saveMeeting(cur); renderDocs(); });
}
$('docIn').onchange = async e => {
  const m = cur; m.docs = m.docs || [];
  const fs = [...e.target.files]; e.target.value = ''; $('docMsg').innerHTML = '<span class="spin"></span>กำลังเตรียมไฟล์';
  const msg = await addDocs(m.docs, fs);
  await saveMeeting(m); renderDocs();
  $('docMsg').textContent = msg;
};

/* ---------- speaker stats ---------- */
function renderStats(){
  const m = cur;
  if (!m.order.length || m.order.length < 2) { $('stats').hidden = true; return; }
  const per = {}, timed = hasTimes(m);
  m.items.forEach((it, i) => {
    const nx = m.items[i + 1], est = it.text.length * 0.11 + 0.3;
    let d = est;
    if (timed && it.t != null && nx && nx.t != null && (nx.k || 0) === (it.k || 0) && nx.t >= it.t) d = Math.min(nx.t - it.t, est * 2.5 + 1);
    const w = label(m, it.g); per[w] = per[w] || {s: 0, c: Math.min(m.order.indexOf(it.g) + 1, 6) % 6}; per[w].s += d;
  });
  const rows = Object.entries(per).sort((a, b) => b[1].s - a[1].s), tot = rows.reduce((a, r) => a + r[1].s, 0) || 1;
  $('statsBody').innerHTML = rows.map(([w, v]) => `<div class="st"><span class="stn">${esc(w)}</span><span class="stb"><i class="b${v.c}" style="width:${(v.s / rows[0][1].s * 100).toFixed(1)}%"></i></span><span class="stv">${Math.round(v.s / tot * 100)}% · ${fmtLong(v.s)}</span></div>`).join('')
    + (timed ? '' : '<p class="hint" style="margin:6px 0 0">ประมาณจากความยาวข้อความ ถอดเสียงใหม่เพื่อให้ใช้เวลาจริง</p>');
  $('stats').hidden = false;
}

/* ---------- translation ---------- */
const LANGS = {en: 'English', zh: '简体中文 (Simplified Chinese)'};
async function translate(text, lang, msgEl){
  return askText(`แปลข้อความต่อไปนี้เป็น ${LANGS[lang]}
- คงรูปแบบ Markdown หัวข้อ รายการ ตาราง และเวลาอ้างอิงในวงเล็บเหลี่ยม เช่น [12:34] ไว้ตามเดิม
- ชื่อคนและชื่อแบรนด์ให้เขียนทับศัพท์
- ตอบแค่คำแปล ไม่ต้องอธิบาย

${text}`, busyMsg(msgEl));
}
$('trSum').onclick = async () => {
  const m = cur, tpl = $('tpl').value, lang = $('sumLang').value, k = tpl + ':' + lang, src = m.summaries[tpl];
  if (!src) return;
  if (!m.trans[k]) {
    $('trSum').disabled = true; $('sumMsg').innerHTML = '<span class="spin"></span>กำลังแปล';
    try { m.trans[k] = await translate(src, lang, $('sumMsg')); await saveMeeting(m); $('sumMsg').textContent = ''; }
    catch (e) { $('sumMsg').textContent = '❌ ' + (e.message || e); return; }
    finally { $('trSum').disabled = false; }
  }
  if (cur === m) { $('sumTrOut').innerHTML = `<h3 class="trh">${lang === 'en' ? 'English' : '中文'}</h3>` + md(m.trans[k]); $('sumTrOut').scrollIntoView({block: 'start', behavior: 'smooth'}); }
};
$('trTr').onclick = async () => {
  const m = cur, lang = $('trLang').value, k = 'tr:' + lang;
  if (!m.trans[k]) {
    $('trTr').disabled = true; $('trMsg').innerHTML = '<span class="spin"></span>กำลังแปลบทสนทนา';
    try { m.trans[k] = await translate(aiText(m, 80000), lang, $('trMsg')); await saveMeeting(m); $('trMsg').textContent = ''; }
    catch (e) { $('trMsg').textContent = '❌ ' + (e.message || e); return; }
    finally { $('trTr').disabled = false; }
  }
  if (cur === m) { $('trTrOut').innerHTML = `<h3 class="trh">${lang === 'en' ? 'English' : '中文'}</h3>` + md(m.trans[k]); $('trTrOut').scrollIntoView({block: 'start', behavior: 'smooth'}); }
};

/* ---------- share / PDF ---------- */
$('shareSum').onclick = async () => {
  const s = cur.summaries[$('tpl').value]; if (!s) return;
  const text = `${cur.title}\n\n` + s.replace(/\*\*/g, '').replace(/^#+\s*/gm, '');
  if (navigator.share) { try { await navigator.share({title: cur.title, text}); } catch (e) { log('share', e.name); } }
  else copy(text, $('shareSum'), 'แชร์');
};
$('pdfSum').onclick = () => { document.body.classList.add('print-sum'); print(); };
addEventListener('afterprint', () => document.body.classList.remove('print-sum'));

/* ---------- voice question + read aloud ---------- */
async function voiceInto(btn, ta, send){
  if (btn._rec) { btn._rec.stop(); return; }
  if (!hasAI()) { ta.placeholder = 'ยังใช้ AI ไม่ได้ ไปที่หน้าตั้งค่าก่อน'; return; }
  let st;
  try { st = await navigator.mediaDevices.getUserMedia({audio: true}); }
  catch (e) { ta.placeholder = 'เปิดไมค์ไม่ได้ อนุญาตไมโครโฟนก่อน'; return; }
  const mime = MIMES.find(x => MediaRecorder.isTypeSupported(x)) || '', r = new MediaRecorder(st, mime ? {mimeType: mime} : {}), ch = [];
  const ph = ta.placeholder;
  r.ondataavailable = e => { if (e.data.size) ch.push(e.data); };
  r.onstop = async () => {
    st.getTracks().forEach(t => t.stop()); btn._rec = null; btn.classList.remove('on'); clearTimeout(btn._to);
    const blob = new Blob(ch, {type: r.mimeType || mime});
    if (blob.size < 1500) { ta.placeholder = ph; return; }
    ta.placeholder = 'กำลังฟังที่พูด...'; btn.disabled = true;
    try {
      const j = await interact({model: TR_MODEL, input: [{type: 'audio', data: await b64(blob), mime_type: apiMime(blob.type)}], generation_config: {transcription_config: {mode: {type: 'verbatim'}, language_codes: ['th-TH', 'en-US']}}, store: false});
      const t = outContent(j).map(c => c.text).join(' ').trim();
      ta.placeholder = ph;
      if (t) send(t); else ta.placeholder = 'ไม่ได้ยินเสียง แตะไมค์แล้วพูดอีกครั้ง';
    } catch (e) { ta.placeholder = '❌ ' + (e.message || e); }
    finally { btn.disabled = false; }
  };
  r.start(); btn._rec = r; btn.classList.add('on'); ta.placeholder = 'กำลังอัด พูดคำถามแล้วแตะไมค์อีกครั้ง';
  btn._to = setTimeout(() => r.state === 'recording' && r.stop(), 60000);
}
function speak(btn){
  if (!('speechSynthesis' in window)) { btn.textContent = 'เครื่องนี้อ่านออกเสียงไม่ได้'; return; }
  const was = btn.classList.contains('on');
  speechSynthesis.cancel(); document.querySelectorAll('.say.on').forEach(b => b.classList.remove('on'));
  if (was) return;
  const text = btn.closest('.bub').querySelector('.sum').innerText.replace(/\d{1,2}:\d{2}(:\d{2})?/g, '').replace(/[|#*]/g, ' ');
  const u = new SpeechSynthesisUtterance(text); u.lang = 'th-TH'; u.rate = 1.05;
  const v = speechSynthesis.getVoices().find(x => /^th/i.test(x.lang)); if (v) u.voice = v;
  u.onend = u.onerror = () => btn.classList.remove('on');
  btn.classList.add('on'); speechSynthesis.speak(u);
}
document.addEventListener('click', e => { const b = e.target.closest('.say'); if (b) speak(b); });

/* ---------- assistant tab: ask across all meetings ---------- */
const ACHAT_LS = 'chy-ai-chat';
const achat = () => { try { return JSON.parse(localStorage.getItem(ACHAT_LS) || '[]'); } catch { return []; } };
const ACHIPS = ['เดือนนี้ตกลงอะไรไปบ้าง', 'ใครยังค้างงานอะไรบ้าง', 'เสนอวาระประชุมครั้งหน้า', 'เรื่องไหนคุยหลายครั้งแต่ยังไม่จบ', 'ตัวเลขยอดขายที่พูดถึงทั้งหมด'];
$('aChips').innerHTML = ACHIPS.map(c => `<button>${esc(c)}</button>`).join('');
$('aChips').querySelectorAll('button').forEach(b => b.onclick = () => aAsk(b.textContent));
$('aBtn').onclick = () => aAsk($('aIn').value);
$('aMic').onclick = () => voiceInto($('aMic'), $('aIn'), aAsk);
$('aIn').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); aAsk($('aIn').value); } });
$('aClear').onclick = () => { if (confirm('ล้างแชทผู้ช่วยทั้งหมด?')) { localStorage.removeItem(ACHAT_LS); renderAChat(); } };
document.querySelectorAll('#v-ai .seg3 button').forEach(b => b.onclick = () => {
  ['a-ask', 'a-tasks'].forEach(p => $(p).hidden = p !== b.dataset.ai);
  document.querySelectorAll('#v-ai .seg3 button').forEach(x => x.classList.toggle('on', x === b));
});
function renderAChat(extra){
  const c = achat();
  $('aChat').innerHTML = (c.length || extra ? '' : '<p class="hint">ถามข้ามทุกประชุมที่ถอดเสียงแล้ว เช่น ใครรับงานอะไรไว้บ้าง หรือเรื่องงบตกลงกันว่ายังไง แตะเวลาในคำตอบเพื่อเปิดประชุมนั้นและฟังเสียงช่วงนั้น</p>')
    + c.map(x => `<div class="bub q">${esc(x.q)}</div><div class="bub a"><div class="sum">${md(x.a)}</div>${SAY_BTN}</div>`).join('') + (extra || '');
  $('aClear').hidden = !c.length;
}
async function globalContext(){
  const ms = (await allMeetings() || []).filter(m => m.items && m.items.length).sort((a, b) => a.created - b.created);
  const per = Math.max(6000, Math.floor(350000 / Math.max(1, ms.length)));
  return {n: ms.length, text: ms.map(m => {
    const d = new Date(m.created).toLocaleDateString('th-TH', {day: 'numeric', month: 'long', year: 'numeric'});
    const sum = Object.values(m.summaries || {})[0];
    const open = (m.tasks || []).filter(t => !t.done).map(t => `- ${t.task} (${t.who}, ส่ง ${t.due})`).join('\n');
    return `===== ประชุม "${m.title}" วันที่ ${d} รหัส ${mtag(m)} =====\n` + (sum ? `สรุป:\n${sum.slice(0, 5000)}\n` : '') + (open ? `งานที่ยังไม่เสร็จ:\n${open}\n` : '') + `บทสนทนา:\n${aiText(m, per, true)}`;
  }).join('\n\n')};
}
let aBusy = false;
async function aAsk(q){
  q = (q || '').trim(); if (!q || aBusy) return;
  aBusy = true; $('aIn').value = ''; $('aBtn').disabled = true;
  renderAChat(`<div class="bub q">${esc(q)}</div><div class="bub a" id="aPending"><span class="spin"></span>กำลังอ่านทุกประชุม</div>`);
  $('aPending').scrollIntoView({block: 'nearest', behavior: 'smooth'});
  try {
    const g = await globalContext();
    if (!g.n) throw new Error('ยังไม่มีประชุมที่ถอดเสียงแล้ว ถอดเสียงอย่างน้อย 1 ประชุมก่อน');
    const hist = achat().slice(-4).map(x => `ผู้ใช้: ${x.q}\nผู้ช่วย: ${x.a}`).join('\n\n');
    const today = new Date().toLocaleDateString('th-TH', {weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'});
    const a = await askText(`คุณเป็นผู้ช่วยของทีม มีบันทึกการประชุม ${g.n} ครั้งด้านล่าง วันนี้คือ${today} ตอบภาษาไทย กระชับ ใช้ Markdown ได้
กติกา:
- ตอบจากบันทึกการประชุมเท่านั้น ถ้าไม่มีข้อมูลให้บอกตรงๆ ว่าไม่พบในประชุมที่บันทึกไว้ ห้ามเดา
- เวลาพูดถึงประชุม ให้เรียกด้วยชื่อประชุมและวันที่
- ทุกข้อเท็จจริง ใส่ที่มาท้ายประโยคในรูป [รหัสประชุม เวลา] เช่น [M123456 12:34] ใช้รหัสและเวลาที่ปรากฏในบันทึกเท่านั้น
- ถ้าเรื่องเดียวกันพูดหลายครั้งแล้วข้อมูลเปลี่ยน ให้ใช้ของประชุมล่าสุดและบอกว่าเปลี่ยนจากอะไร
${gloss() ? '- คำเฉพาะของทีม ให้สะกดตามนี้: ' + gloss().replace(/\n+/g, ', ') : ''}
${memLine()}

${g.text}
${hist ? '\nบทสนทนาก่อนหน้า:\n' + hist : ''}

คำถาม: ${q}`, (n) => { const p = $('aPending'); if (p) p.innerHTML = `<span class="spin"></span>Google คนใช้เยอะ ลองใหม่ครั้งที่ ${n}`; });
    const c = achat(); c.push({q, a, t: Date.now()}); localStorage.setItem(ACHAT_LS, JSON.stringify(c.slice(-30)));
    renderAChat();
    const bs = $('aChat').querySelectorAll('.bub.a'); if (bs.length) bs[bs.length - 1].scrollIntoView({block: 'start', behavior: 'smooth'});
  } catch (e) { renderAChat(`<div class="bub q">${esc(q)}</div><div class="bub a">❌ ${esc(e.message || e)}</div>`); $('aIn').value = q; }
  finally { aBusy = false; $('aBtn').disabled = false; }
}

/* ---------- assistant tab: tasks from every meeting ---------- */
$('showDone').onchange = () => renderTasks();
async function renderTasks(){
  const ms = (await allMeetings() || []).sort((a, b) => b.created - a.created);
  const pending = ms.filter(m => m.items && m.items.length && (!m.tasks || m.tasksFor !== m.items.length));
  $('taskSync').hidden = !pending.length;
  $('taskSync').textContent = `ดึงงานจาก ${pending.length} ประชุมที่ยังไม่ได้ดึง`;
  const all = [];
  ms.forEach(m => (m.tasks || []).forEach((t, i) => all.push({...t, m, i})));
  const show = all.filter(t => $('showDone').checked || !t.done);
  if (!all.length) { $('taskList').innerHTML = `<div class="empty"><b>ยังไม่มีรายการงาน</b>${pending.length ? 'แตะปุ่มด้านบน ให้ AI ดึงงานจากประชุมที่ถอดเสียงแล้ว' : 'ถอดเสียงประชุมก่อน แล้วกลับมาที่นี่'}</div>`; return; }
  const groups = {};
  show.forEach(t => (groups[t.who || 'ไม่ระบุ'] = groups[t.who || 'ไม่ระบุ'] || []).push(t));
  const left = all.filter(t => !t.done).length;
  $('taskList').innerHTML = `<p class="hint">ค้างอยู่ ${left} งาน จากทั้งหมด ${all.length} งาน</p>` + Object.entries(groups).sort((a, b) => b[1].filter(t => !t.done).length - a[1].filter(t => !t.done).length).map(([who, ts]) =>
    `<div class="tgroup"><h3>${esc(who)} <small>${ts.filter(t => !t.done).length ? 'ค้าง ' + ts.filter(t => !t.done).length : 'เสร็จหมดแล้ว'}</small></h3>` + ts.map(t =>
      `<div class="task${t.done ? ' done' : ''}"><label><input type="checkbox" data-id="${esc(t.m.id)}" data-i="${t.i}"${t.done ? ' checked' : ''}><span>${esc(t.task)}</span></label><small>${t.due && t.due !== 'ไม่ระบุ' ? 'ส่ง ' + esc(t.due) + ' · ' : ''}${esc(t.m.title)}${t.at ? ` <button class="cite" data-m="${mtag(t.m).slice(1)}" data-t="${secsOf(t.at)}">${esc(t.at)}</button>` : ''}</small></div>`).join('') + '</div>').join('');
  $('taskList').querySelectorAll('input[type=checkbox]').forEach(cb => cb.onchange = async () => {
    const m = await getMeeting(cb.dataset.id); if (!m || !m.tasks[+cb.dataset.i]) return;
    m.tasks[+cb.dataset.i].done = cb.checked; await saveMeeting(m); renderTasks();
  });
}
$('taskSync').onclick = async () => {
  const ms = (await allMeetings() || []).filter(m => m.items && m.items.length && (!m.tasks || m.tasksFor !== m.items.length));
  $('taskSync').disabled = true; let done = 0;
  try {
    for (const m of ms) {
      $('taskMsg').innerHTML = `<span class="spin"></span>กำลังอ่าน "${esc(m.title)}" (${done + 1}/${ms.length})`;
      const t = await askText(`ดึงงานที่ต้องทำ (action items) จากบทสนทนาการประชุมด้านล่าง
ตอบเป็น JSON array อย่างเดียว ไม่มีข้อความอื่น รูปแบบ:
[{"task": "งานที่ต้องทำ เขียนสั้นชัด", "who": "ชื่อคนรับผิดชอบ หรือ ไม่ระบุ", "due": "กำหนดส่งตามที่พูด หรือ ไม่ระบุ", "at": "เวลาในบทสนทนาที่พูดถึงงานนี้ เช่น 12:34 หรือ \\"\\" ถ้าไม่มี"}]
- เอาเฉพาะงานที่มีคนพูดว่าจะทำหรือมอบหมายจริง ห้ามแต่งเพิ่ม ถ้าไม่มีงานตอบ []
${gloss() ? '- คำเฉพาะของทีม ให้สะกดตามนี้: ' + gloss().replace(/\n+/g, ', ') : ''}
${memLine()}

บทสนทนา "${m.title}":
${aiText(m, 200000)}`, busyMsg($('taskMsg')));
      let arr = [];
      try { arr = JSON.parse((t.match(/\[[\s\S]*\]/) || ['[]'])[0]); } catch { log('tasks parse', t.slice(0, 120)); }
      const old = m.tasks || [];
      m.tasks = (Array.isArray(arr) ? arr : []).filter(x => x && x.task).map(x => ({task: String(x.task), who: String(x.who || 'ไม่ระบุ'), due: String(x.due || 'ไม่ระบุ'), at: /^\d{1,2}:\d{2}(:\d{2})?$/.test(x.at || '') ? x.at : '', done: !!(old.find(o => o.task === x.task) || {}).done}));
      m.tasksFor = m.items.length; await saveMeeting(m); done++;
    }
    $('taskMsg').textContent = `ดึงงานจาก ${done} ประชุมแล้ว ตรวจดูอีกที AI อาจตกหล่น`;
  } catch (e) { $('taskMsg').textContent = '❌ ' + (e.message || e); }
  finally { $('taskSync').disabled = false; renderTasks(); }
};

/* ---------- accuracy test: simulated meeting with a known answer ---------- */
function lev(a, b){
  let prev = new Int32Array(b.length + 1).map((_, i) => i), curr = new Int32Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}
function scoreTest(ref, st){
  const nz = s => s.replace(/[\s.,!?'"“”…\-–—:;()]/g, '');
  const R = nz(ref.map(x => x.text).join('')), H = nz(st.items.map(x => x.text).join(''));
  const words = Math.max(0, 1 - lev(R, H) / R.length);
  const refSpk = [...new Set(ref.map(x => x.speaker))];
  let spk = null;
  if (st.items.some(x => x.t != null) && st.order.length) {
    const cnt = {}; let total = 0;
    st.items.forEach(it => {
      if (it.t == null || !it.g) return;
      const cands = ref.filter(r => it.t >= r.start - 0.4 && it.t <= r.end + 0.4);
      const r = cands.sort((a, b) => b.start - a.start)[0]; if (!r) return;
      const w = nz(it.text).length; total += w;
      (cnt[it.g] = cnt[it.g] || {})[r.speaker] = (cnt[it.g][r.speaker] || 0) + w;
    });
    const pairs = []; Object.entries(cnt).forEach(([g, v]) => Object.entries(v).forEach(([s, w]) => pairs.push([g, s, w])));
    pairs.sort((a, b) => b[2] - a[2]);
    const ug = new Set(), us = new Set(); let hit = 0;
    pairs.forEach(([g, s, w]) => { if (!ug.has(g) && !us.has(s)) { ug.add(g); us.add(s); hit += w; } });
    spk = total ? hit / total : null;
  }
  return {words, spk, found: st.order.length, want: refSpk.length, chars: [R.length, H.length]};
}
/* ---------- AI smartness test: questions with known answers on the scripted meeting ---------- */
const n0 = t => String(t || '').replace(/(\d),(\d)/g, '$1$2').replace(/\s+/g, ' ');
const has = (t, ...alts) => alts.some(a => n0(t).includes(a));
const NO_INFO = ['ไม่มี', 'ไม่พบ', 'ไม่ได้พูดถึง', 'ไม่ได้มีการพูดถึง', 'ไม่ได้ระบุ', 'ไม่ได้กล่าวถึง', 'ไม่มีการพูดถึง', 'ไม่ได้คุย'];
const IQ = [
  {q: 'ยอดขายจากไลฟ์สัปดาห์ที่แล้วเท่าไหร่', why: 'ตัวเลขที่พูดเป็นคำ (สามแสนสองหมื่น)', ok: a => has(a, '320000', '320 000', 'สามแสนสองหมื่น', '320K', '3.2 แสน')},
  {q: 'ค่าแอดสัปดาห์ที่แล้วใช้ไปเท่าไหร่', why: 'ตัวเลขยาก (สี่หมื่นเอ็ด = 41,000)', ok: a => has(a, '41000', 'สี่หมื่นเอ็ด', '41K', '41 000') && !has(a, '40000 บาท', '4,000 บาท')},
  {q: 'ใครรับผิดชอบทดลองยิงแอดช่วงบ่าย ใช้งบวันละเท่าไหร่ นานแค่ไหน', why: 'ข้อตกลงที่มีหลายส่วน', ok: a => has(a, 'ต้น') && has(a, '5000', 'ห้าพัน') && has(a, 'สัปดาห์', 'อาทิตย์')},
  {q: 'มายด์ต้องได้อะไรก่อนวันจันทร์ และถ้าไม่ได้จะเกิดอะไร', why: 'เหตุและผล', ok: a => has(a, 'รูป') && has(a, 'ปก')},
  {q: 'ไลฟ์ใหญ่จัดวันไหน ยาวกี่ชั่วโมง', why: 'ตั้งต้นสำหรับคำถามต่อเนื่อง', ok: a => has(a, '12', 'สิบสอง') && has(a, '3 ชั่วโมง', 'สามชั่วโมง', '3 ชม')},
  {q: 'แล้วต้องใช้กี่คน ใครขอ', follow: true, why: 'คำถามต่อเนื่อง ต้องจำว่าคุยเรื่องไลฟ์ใหญ่อยู่', ok: a => has(a, '2', 'สอง') && has(a, 'บอส')},
  {q: 'โค้ดส่วนลด 12% อนุมัติแล้วหรือยัง', why: 'เรื่องที่ยังไม่ได้ตัดสิน ห้ามตอบว่าอนุมัติแล้ว', ok: a => has(a, 'ยัง', 'รอ', 'ต้องเช็ก', 'ต้องคุย') && has(a, 'บัญชี') && !/อนุมัติแล้ว(?!หรือ)/.test(a.replace(/ยังไม่(ได้)?อนุมัติ/g, ''))},
  {q: 'ตกลงจ้างอินฟลูเอนเซอร์คนไหนมารีวิวลิป', why: 'คำถามกับดัก ในประชุมไม่มีเรื่องนี้ ต้องไม่แต่ง', ok: a => has(a, ...NO_INFO)},
  {q: 'งบรวมของแคมเปญ 12.12 ทั้งหมดกี่บาท', why: 'คำถามกับดัก ไม่มีใครพูดงบรวม ต้องไม่แต่งตัวเลข', ok: a => has(a, ...NO_INFO)},
  {q: 'ใครพูดแทรกตอนที่ต้นยังพูดไม่จบ แล้วใครเบรก', why: 'เข้าใจว่าใครพูดกับใคร', ok: a => has(a, 'บอส') && has(a, 'นุ่น')},
];
const IQ_TASKS = [['ต้น', 'แอด'], ['ฝน', 'คลิป'], ['ฝน', 'รูป'], ['มายด์', 'ปก', 'ฉาก'], ['บอส', 'โฮสต์'], ['บัญชี', 'พุธ']];
function iqMeeting(key){
  const order = [...new Set(key.map(x => x.speaker))];
  return {id: 'm000000000000', title: 'ประชุมทดสอบ แคมเปญ 12.12', created: Date.now(), dur: key[key.length - 1].end, order, names: Object.fromEntries(order.map(n => [n, n])),
    items: key.map(x => ({g: x.speaker, text: x.text, k: 0, t: x.start})), summaries: {}, chat: [], pins: [], docs: [], test: true};
}
/* every [mm:ss] must land on a line that exists */
function badCites(m, a){
  const ls = lines(m).filter(l => l.at != null), out = [];
  for (const c of a.matchAll(/\[(\d{1,2}):(\d{2})/g)) {
    const T = +c[1] * 60 + +c[2];
    const okAt = ls.some((l, i) => T >= gT(l) - 3 && T <= (i + 1 < ls.length ? gT(ls[i + 1]) : m.dur) + 3);
    if (!okAt) out.push(c[0] + ']');
  }
  return out;
}
$('iqBtn').onclick = async () => {
  if (!hasAI()) { $('iqMsg').textContent = 'ต้องเชื่อม AI ก่อน (ใส่คีย์ด้านบน)'; return; }
  $('iqBtn').disabled = true; $('iqOut').innerHTML = '';
  const rows = []; let chat = [];
  try {
    const key = await (await fetch('test-audio/answer-key.json')).json(), m = iqMeeting(key);
    for (let i = 0; i < IQ.length; i++) {
      const t = IQ[i]; $('iqMsg').innerHTML = `<span class="spin"></span>ถามข้อ ${i + 1} จาก ${IQ.length + 1}`;
      if (!t.follow) chat = [];
      const a = await askText(askPrompt(m, t.q, chat));
      chat.push({q: t.q, a});
      const bad = badCites(m, a), pass = t.ok(a) && !bad.length;
      rows.push({q: t.q, why: t.why, a, pass, note: bad.length ? 'อ้างเวลาที่ไม่มีจริง: ' + bad.join(' ') : ''});
      drawIq(rows);
    }
    $('iqMsg').innerHTML = `<span class="spin"></span>ให้สรุปประชุม (ข้อ ${IQ.length + 1})`;
    const sum = await askText(`${TEMPLATES.meeting}\n\n${RULES}\n${aiRules(m)}\n\nบทสนทนา:\n${aiText(m, 300000)}`);
    const said = n0(key.map(x => x.text).join(' ')), miss = IQ_TASKS.filter(ws => !ws.every(w => sum.includes(w))).map(ws => ws.join('+'));
    const allowed = new Set(['320000', '18', '41000', '5000', '12', '5', '3', '2', '100', '1', '20', '22', '2.00', '4.00', '0']);
    const nums = [...n0(sum.replace(/\[[^\]]*\]/g, '').replace(/\b\d{1,2}[:.]\d{2}\b/g, '')).matchAll(/\d+(?:\.\d+)?/g)].map(x => x[0]);  /* clock times like 20:00 are how the AI writes สองทุ่ม, not invented numbers */
    /* dates (1-31) and years are fine; any other number the meeting never said is invented */
    const strange = [...new Set(nums.filter(x => !allowed.has(x) && !said.includes(x) && !(+x >= 1 && +x <= 31) && !(+x >= 2024 && +x <= 2600)))];
    const bad = badCites(m, sum);
    rows.push({q: 'สรุปประชุมแบบละเอียด', why: 'ต้องมีงานครบ 6 ชิ้น ไม่มีตัวเลขแปลกปลอม และอ้างเวลาถูก', a: sum, pass: !miss.length && !strange.length && !bad.length,
      note: [miss.length ? 'งานที่ขาด: ' + miss.join(', ') : '', strange.length ? 'ตัวเลขที่ไม่มีในประชุม: ' + strange.join(', ') : '', bad.length ? 'อ้างเวลาที่ไม่มีจริง: ' + bad.join(' ') : ''].filter(Boolean).join(' · ')});
    drawIq(rows);
    const n = rows.filter(r => r.pass).length;
    $('iqMsg').textContent = `ผ่าน ${n} จาก ${rows.length} ข้อ`;
    log('iq', {pass: n, of: rows.length, fail: rows.filter(r => !r.pass).map(r => r.q)});
  } catch (e) { $('iqMsg').textContent = '❌ ' + (e.message || e); }
  finally { $('iqBtn').disabled = false; }
};
function drawIq(rows){
  $('iqOut').innerHTML = rows.map((r, i) => `<details class="iq ${r.pass ? 'ok' : 'no'}"><summary><b>${r.pass ? '✓' : '✗'}</b><span>${i + 1}. ${esc(r.q)}<small>${esc(r.why)}${r.note ? ' · ' + esc(r.note) : ''}</small></span></summary><div class="sum">${md(r.a)}</div></details>`).join('');
}
$('testBtn').onclick = async () => {
  const f = $('testFile').value;
  $('testBtn').disabled = true; $('testOut').innerHTML = '';
  try {
    $('testMsg').innerHTML = '<span class="spin"></span>กำลังโหลดไฟล์ทดสอบ';
    const [blob, ref] = await Promise.all([fetch('test-audio/' + encodeURIComponent(f)).then(r => { if (!r.ok) throw new Error('ไม่พบไฟล์ทดสอบ'); return r.blob(); }), fetch('test-audio/answer-key.json').then(r => r.json())]);
    const t0 = performance.now();
    const st = await transcribeBlobs([blob], 'audio/m4a', {diar: true, thai: true}, h => $('testMsg').innerHTML = h);
    const sc = scoreTest(ref, st), pct = x => x == null ? 'วัดไม่ได้ (ไม่มีเวลาของแต่ละคำ)' : Math.round(x * 100) + '%';
    log('accuracy', f, {words: +sc.words.toFixed(3), spk: sc.spk == null ? null : +sc.spk.toFixed(3), found: sc.found});
    $('testMsg').textContent = `เสร็จใน ${Math.round((performance.now() - t0) / 1000)} วินาที`;
    const fake = {items: st.items, order: st.order, names: {}};
    $('testOut').innerHTML = `<table class="score"><tr><th>ถอดคำถูก</th><td><b>${pct(sc.words)}</b></td></tr><tr><th>ระบุคนพูดถูก</th><td><b>${pct(sc.spk)}</b></td></tr><tr><th>จำนวนคนที่แยกได้</th><td><b>${sc.found}</b> จากจริง ${sc.want} คน</td></tr></table>
      <p class="hint" style="margin:8px 0 0">ถอดคำถูก = เทียบตัวอักษรกับเฉลย (100% = ตรงทุกตัว) ระบุคนพูดถูก = สัดส่วนข้อความที่ถูกจัดให้คนที่พูดจริง</p>
      <details style="margin-top:8px"><summary>ดูข้อความที่ถอดได้</summary><div class="plain">${esc(plainText(fake))}</div></details>`;
  } catch (e) { $('testMsg').textContent = '❌ ' + (e.message || e); }
  finally { $('testBtn').disabled = false; }
};

refreshKeyBanner();
show('v-rec');
