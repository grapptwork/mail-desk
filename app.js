'use strict';

// 데이터는 비공개 repo에 있고, 정원이 발급한 fine-grained 토큰(이 repo만 Contents 읽기·쓰기)으로 읽고 쓴다.
// 형식: 비공개 repo의 automation/스키마.md
const REPO = 'grapptwork/instagram-mail-reply';
const BRANCH = 'main';
const API = 'https://api.github.com';
const GMAIL_ACCOUNT = 'contact@grappt.co.kr';
const TRANSLATE_WAIT_MS = 5 * 60e3;
const RESEARCH_WAIT_MS = 15 * 60e3;
const REGEN_WAIT_MS = 6 * 60e3;
const PROFILE_PATH = 'db/profile.json';
const TOKEN_KEY = 'maildesk.token';
const FILTER_KEY = 'maildesk.filter';
const PROFILE_OPEN_KEY = 'maildesk.profileOpen';

// 폰에서는 브라우저가 다른 구글 계정이라 Gmail 웹 링크가 안 열린다. 대신 Gmail 앱 작성 화면을 연다.
const UA = navigator.userAgent || '';
const IS_IOS = /iPhone|iPad|iPod/i.test(UA) || (/Macintosh/.test(UA) && navigator.maxTouchPoints > 1);
const IS_ANDROID = /Android/i.test(UA);
const IS_MOBILE = IS_IOS || IS_ANDROID;

const VERDICT = { green: '🟢', yellow: '🟡', red: '🔴' };
const VERDICT_NAME = { green: '🟢 초록', yellow: '🟡 노랑', red: '🔴 빨강' };
const STATUS = { new: '새 메일', reviewed: '검토함', replied: '답장함', archived: '보관' };
const STATUS_ICON = { reviewed: '👀', replied: '✅', archived: '📦' };
const KIND = { default: '초안', positive: '수락', decline: '거절', followup: '후속' };
const COLLAB = { single: '단건', multi: '다건', long_term: '장기', unknown: '미정' };
const COMPANY_TYPE = { agency: '대행사', brand: '브랜드 직접', unknown: '미확인' };

const state = {
  token: null,
  dates: [],
  date: null,
  digest: null,
  mails: {},      // id -> { path, data, sha, pending, saving, el }
  order: [],
  dirty: new Set(),
  db: null,       // Promise<{services, companies}>
  filter: lsGet(FILTER_KEY) || 'todo',
  profile: { data: null, sha: null, loaded: false, saving: false, error: null, el: null },
};

// ---------- 작은 도구 ----------

function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) {
  try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* 저장 불가 환경 */ }
}

// 메일 내용은 외부에서 온 글이라 innerHTML을 쓰지 않고 항상 텍스트로 넣는다.
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'value') el.value = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}

function link(url, label) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return url ? String(url) : null;
  return h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, label || url);
}

// 조사 DB 값은 문자열·배열·객체가 섞여 있어 한 줄 텍스트로 바꾼다.
function txt(v) {
  if (v == null || v === '') return null;
  if (Array.isArray(v)) return v.length ? v.map(txt).filter(Boolean).join(', ') : null;
  if (typeof v === 'object') {
    const parts = Object.entries(v).map(([k, x]) => (txt(x) ? `${k} ${txt(x)}` : null)).filter(Boolean);
    return parts.length ? parts.join(' · ') : null;
  }
  if (typeof v === 'boolean') return v ? '예' : '아니오';
  return String(v);
}

function fmtTime(iso) {
  if (!iso || iso.length < 16) return iso || '';
  return `${iso.slice(5, 7)}/${iso.slice(8, 10)} ${iso.slice(11, 16)}`;
}

function nowKst() {
  return new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 19) + '+09:00';
}

function toast(msg, isError, action) {
  const el = document.getElementById('toast');
  el.replaceChildren(msg);
  if (action) {
    el.append(h('button', {
      type: 'button',
      class: 'toast-action',
      onclick: () => { el.hidden = true; action.fn(); },
    }, action.label));
  }
  el.className = isError ? 'error' : '';
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, isError ? 6000 : action ? 5000 : 2200);
}

function errMsg(e) {
  if (e.status === 401) return '토큰이 맞지 않거나 만료됐어요';
  if (e.status === 403) return '권한이 없어요 (토큰의 Contents 쓰기 권한 확인)';
  if (e.status === 404) return '파일이나 repo를 찾지 못했어요';
  if (e.status === 409) return '다른 곳에서 먼저 바뀌었어요. 새로고침 후 다시 해주세요';
  return e.detail || e.message || String(e);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', { class: 'offscreen', value: text });
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('복사했어요');
}

function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 2 + 'px';
}

// ---------- GitHub ----------

function b64decode(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');

async function gh(path, opts = {}) {
  const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${state.token}` };
  if (opts.body) headers['Content-Type'] = 'application/json';
  const res = await fetch(API + path, { ...opts, headers, cache: 'no-store' });
  if (!res.ok) {
    const err = new Error(`GitHub ${res.status}`);
    err.status = res.status;
    try { err.detail = (await res.json()).message; } catch { /* 본문 없음 */ }
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

const contents = (path) => `/repos/${REPO}/contents/${encPath(path)}`;

function listDir(path) {
  return gh(`${contents(path)}?ref=${BRANCH}`);
}

async function readJson(path) {
  const f = await gh(`${contents(path)}?ref=${BRANCH}`);
  return { data: JSON.parse(b64decode(f.content)), sha: f.sha };
}

async function writeJson(path, data, sha, message) {
  const body = JSON.stringify({
    message,
    content: b64encode(JSON.stringify(data, null, 2) + '\n'),
    sha,
    branch: BRANCH,
  });
  const r = await gh(contents(path), { method: 'PUT', body });
  return r.content.sha;
}

// 비공개 repo의 .github/workflows/ 작업을 깨운다. (translate-draft → translate.yml, research-more → research.yml)
// 처리할 메일은 워크플로가 파일의 translate_request / research_request로 찾는다.
function dispatch(eventType) {
  return gh(`/repos/${REPO}/dispatches`, { method: 'POST', body: JSON.stringify({ event_type: eventType }) });
}

function loadDb() {
  if (!state.db) {
    state.db = Promise.all([readJson('db/services.json'), readJson('db/companies.json')])
      .then(([s, c]) => ({ services: s.data.services || {}, companies: c.data.companies || {} }))
      .catch((e) => { state.db = null; throw e; });
  }
  return state.db;
}

// ---------- 시작 ----------

async function boot() {
  state.token = lsGet(TOKEN_KEY);
  if (!state.token) return renderSetup();
  loadProfile();
  try {
    await loadDates();
  } catch (e) {
    if (e.status === 401) return renderSetup('토큰이 맞지 않거나 만료됐어요. 다시 넣어주세요.');
    renderFatal(errMsg(e));
  }
}

async function loadDates() {
  const items = await listDir('inbox');
  state.dates = items
    .filter((i) => i.type === 'dir' && /^\d{4}-\d{2}-\d{2}$/.test(i.name))
    .map((i) => i.name)
    .sort()
    .reverse();
  if (!state.dates.length) return renderFatal('아직 처리된 메일이 없어요.');
  const want = decodeURIComponent(location.hash.slice(1));
  await loadDate(state.dates.includes(want) ? want : state.dates[0]);
}

function go(date) {
  loadDate(date).catch((e) => renderFatal(errMsg(e)));
}

async function loadDate(date) {
  if (state.dirty.size && !confirm('저장하지 않은 수정이 있어요. 버리고 이동할까요?')) {
    render();
    return;
  }
  document.getElementById('app').replaceChildren(h('p', { class: 'muted center' }, `${date} 불러오는 중…`));
  const files = (await listDir(`inbox/${date}`)).filter((f) => f.type === 'file' && f.name.endsWith('.json'));
  const digestFile = files.find((f) => f.name === '_digest.json');
  const mailFiles = files.filter((f) => f.name !== '_digest.json');

  const [digest, ...mails] = await Promise.all([
    digestFile ? readJson(digestFile.path).then((r) => r.data).catch(() => null) : null,
    ...mailFiles.map((f) => readJson(f.path).then((r) => ({ ...r, path: f.path })).catch(() => null)),
  ]);

  state.date = date;
  state.digest = digest;
  state.mails = {};
  state.dirty.clear();
  for (const m of mails) {
    if (!m) continue;
    const id = m.data.id || m.path.split('/').pop().replace(/\.json$/, '');
    state.mails[id] = { path: m.path, data: m.data, sha: m.sha, pending: emptyPending(), saving: false, el: null };
  }
  const listed = (digest?.order || []).filter((id) => state.mails[id]);
  state.order = [...listed, ...Object.keys(state.mails).filter((id) => !listed.includes(id))];
  if (location.hash.slice(1) !== date) history.replaceState(null, '', `#${date}`);
  render();
}

// ---------- 화면 ----------

function renderSetup(message) {
  const input = h('input', { type: 'password', class: 'input', placeholder: 'github_pat_…', autocomplete: 'off' });
  const status = h('p', { class: message ? 'err' : 'muted' }, message || '');
  const save = async () => {
    const token = input.value.trim();
    if (!token) return;
    state.token = token;
    status.className = 'muted';
    status.textContent = '확인 중…';
    try {
      await gh(`/repos/${REPO}`);
      lsSet(TOKEN_KEY, token);
      boot();
    } catch (e) {
      state.token = null;
      status.className = 'err';
      status.textContent = errMsg(e);
    }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  document.getElementById('app').replaceChildren(
    h('section', { class: 'setup' },
      h('h1', null, '협업메일'),
      h('p', null, 'GitHub 토큰을 한 번만 넣어주세요. 이 브라우저에만 저장돼요.'),
      h('ol', { class: 'steps' },
        h('li', null, link('https://github.com/settings/personal-access-tokens/new', 'Fine-grained 토큰 만들기'), ' 열기'),
        h('li', null, 'Repository access: Only select → ', h('code', null, REPO.split('/')[1])),
        h('li', null, 'Permissions → Contents: Read and write'),
      ),
      input,
      h('button', { type: 'button', class: 'btn primary', onclick: save }, '저장'),
      status,
    ),
  );
  input.focus();
}

function renderFatal(message) {
  document.getElementById('app').replaceChildren(
    h('section', { class: 'setup' },
      h('p', { class: 'err' }, message),
      h('button', { type: 'button', class: 'btn', onclick: () => boot() }, '다시 시도'),
      h('button', { type: 'button', class: 'btn', onclick: resetToken }, '토큰 다시 넣기'),
    ),
  );
}

function resetToken() {
  if (!confirm('이 브라우저에 저장된 토큰을 지울까요?')) return;
  lsSet(TOKEN_KEY, null);
  state.token = null;
  renderSetup();
}

function render() {
  const app = document.getElementById('app');
  app.replaceChildren(topBar(), profileBox(), summary(), cardList());
  requestAnimationFrame(() => autosize(state.profile.inputs.memo));
}

// ---------- 채널 현황 ----------
// 정원이 적어 두는 최신 정보. 매일 아침 라우틴과 「초안 다시 쓰기」 작업이 읽는다.
// 모든 칸은 선택이다. 비워 두면 CLAUDE.md의 기준값·기존 규칙대로 쓴다.

const STALE_DAYS = 30;
const METRICS = [
  ['followers', '팔로워', '예: 11.1만'],
  ['views', '조회수', '예: 통상 10,000~100,000회'],
  ['comments', '댓글', '예: 게시글당 1,000~2,000개'],
];

const today = () => nowKst().slice(0, 10);
const daysSince = (date) => Math.floor((Date.parse(today()) - Date.parse(date)) / 864e5);

async function loadProfile() {
  const pf = state.profile;
  try {
    const r = await readJson(PROFILE_PATH);
    pf.sha = r.sha;
    pf.data = r.data;
    pf.error = null;
  } catch (e) {
    if (e.status !== 404) pf.error = `채널 현황을 못 불러왔어요: ${errMsg(e)}`;
  }
  pf.loaded = true;
  if (pf.el) fillProfile();
  refreshStale();
}

// 카드는 한 번만 만들어 재사용한다. 날짜를 바꿔도 쓰던 값이 사라지지 않게.
function profileBox() {
  const pf = state.profile;
  if (pf.el) return pf.el;
  const onInput = () => syncProfile();
  const f = pf.inputs = {};
  const hints = pf.hints = {};
  const rows = [];
  for (const [key, label, ph] of METRICS) {
    f[key] = h('input', { type: 'text', class: 'input', placeholder: ph, disabled: true });
    hints[key] = h('span', { class: 'hint' });
    rows.push([label, f[key], hints[key]]);
  }
  f.available_from = h('input', { type: 'date', class: 'input', disabled: true });
  hints.available_from = h('span', { class: 'hint' });
  rows.push(['광고 가능 시작일', f.available_from, hints.available_from]);
  f.schedule_note = h('input', { type: 'text', class: 'input', placeholder: '예: 12/1~12/10 불가', disabled: true });
  rows.push(['일정 메모', f.schedule_note, null]);
  f.memo = h('textarea', {
    class: 'memo-input',
    rows: '2',
    disabled: true,
    placeholder: '예: 아주 유명한 브랜드면 일정이 빠듯해도 긍정적으로 검토',
  });
  f.memo.addEventListener('input', () => autosize(f.memo));
  rows.push(['메모', f.memo, null]);
  for (const el of Object.values(f)) el.addEventListener('input', onInput);

  pf.btn = h('button', { type: 'button', class: 'btn small primary', onclick: saveProfile });
  pf.info = h('span', { class: 'muted' });
  pf.summary = h('span', { class: 'muted' });
  const det = h('details', { class: 'profile-det', open: lsGet(PROFILE_OPEN_KEY) !== '0' },
    h('summary', null, h('b', null, '채널 현황'), ' ', pf.summary),
    h('p', { class: 'muted small' }, '전부 선택이에요. 비워 두면 기존 기준대로 답해요. 매일 아침 판정·초안과 「초안 다시 쓰기」에 반영돼요.'),
    h('div', { class: 'pf-grid' }, rows.map(([label, input, hint]) =>
      h('label', { class: 'pf-row' }, h('span', { class: 'pf-label' }, label), input, hint))),
    h('div', { class: 'row' }, pf.btn, pf.info));
  det.addEventListener('toggle', () => {
    lsSet(PROFILE_OPEN_KEY, det.open ? '1' : '0');
    if (det.open) autosize(f.memo);
  });
  pf.el = h('section', { class: 'memo' }, det);
  if (pf.loaded) fillProfile();
  else syncProfile();
  return pf.el;
}

const pfVal = (d, key) => (METRICS.some(([k]) => k === key) ? d?.[key]?.value : d?.[key]) || '';

function fillProfile() {
  const pf = state.profile;
  const dirty = profileDirty();
  for (const [key, el] of Object.entries(pf.inputs)) {
    el.disabled = false;
    if (!dirty) el.value = pfVal(pf.data, key);
  }
  autosize(pf.inputs.memo);
  syncProfile();
}

function profileDirty() {
  const pf = state.profile;
  if (!pf.inputs || pf.inputs.memo.disabled) return false;
  return Object.entries(pf.inputs).some(([key, el]) => el.value.trim() !== pfVal(pf.data, key).trim());
}

function syncProfile() {
  const pf = state.profile;
  const dirty = profileDirty();
  const d = pf.data || {};
  pf.btn.disabled = pf.saving || !dirty;
  pf.btn.textContent = pf.saving ? '저장 중…' : dirty ? '저장' : '저장됨';
  pf.info.className = pf.error ? 'err' : 'muted';
  pf.info.textContent = !pf.loaded ? '불러오는 중…'
    : pf.error || (d.updated_at ? `${fmtTime(d.updated_at)} 저장` : '');

  for (const [key] of METRICS) {
    const m = d[key];
    const old = m?.value && m.checked ? daysSince(m.checked) : null;
    pf.hints[key].textContent = old == null ? '' : `${m.checked.slice(5).replace('-', '/')} 확인${old > STALE_DAYS ? ` · ⚠ ${old}일 지남 (기존 규칙대로 다시 확인)` : ''}`;
    pf.hints[key].classList.toggle('warn-text', old > STALE_DAYS);
  }
  const from = pf.inputs.available_from.value;
  pf.hints.available_from.textContent = from && from < today() ? '지난 날짜라 무시돼요' : '';

  // 접었을 때 보이는 한 줄 요약
  const parts = [
    pfVal(d, 'followers') && `팔로워 ${pfVal(d, 'followers')}`,
    d.available_from && d.available_from >= today() && `${d.available_from.slice(5).replace('-', '/')}부터 광고 가능`,
    d.schedule_note && '일정 메모',
    d.memo && '메모',
  ].filter(Boolean);
  pf.summary.textContent = parts.length ? `· ${parts.join(' · ')}` : '· 비어 있음 (기존 기준대로)';
}

async function saveProfile() {
  const pf = state.profile;
  if (pf.saving || !profileDirty()) return;
  const f = pf.inputs;
  const old = pf.data || {};
  const data = { schema: 1 };
  for (const [key] of METRICS) {
    const value = f[key].value.trim();
    // 확인일은 값을 바꿨을 때만 오늘로. 지우면 null.
    data[key] = { value, checked: !value ? null : value === pfVal(old, key).trim() ? old[key]?.checked || today() : today() };
  }
  data.available_from = f.available_from.value || null;
  data.schedule_note = f.schedule_note.value.trim();
  data.memo = f.memo.value.trim();
  data.updated_at = nowKst();
  pf.saving = true;
  syncProfile();
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        pf.sha = await writeJson(PROFILE_PATH, data, pf.sha || undefined, 'site: 채널 현황 수정');
        break;
      } catch (e) {
        // 사이트에서만 고치는 파일이다. 다른 기기에서 먼저 저장해 sha가 어긋났으면 지금 쓴 내용으로 덮는다.
        if ((e.status === 409 || e.status === 422) && attempt === 0) {
          pf.sha = (await readJson(PROFILE_PATH).catch(() => null))?.sha;
          continue;
        }
        throw e;
      }
    }
    pf.data = data;
    pf.error = null;
    toast('채널 현황을 저장했어요');
    refreshStale();
  } catch (e) {
    toast(`채널 현황 저장 실패: ${errMsg(e)}`, true);
  } finally {
    pf.saving = false;
    syncProfile();
  }
}

// 열려 있는 초안들의 "현황 바뀜" 표시를 다시 맞춘다.
function refreshStale() {
  for (const id of Object.keys(state.mails)) renderRegen(id);
}

function topBar() {
  const select = h('select', { class: 'select', 'aria-label': '날짜', onchange: (e) => go(e.target.value) },
    state.dates.map((d) => h('option', { value: d, selected: d === state.date }, d)));
  const filterBtn = h('button', {
    type: 'button',
    class: 'btn small',
    onclick: () => {
      state.filter = state.filter === 'todo' ? 'all' : 'todo';
      lsSet(FILTER_KEY, state.filter);
      render();
    },
  }, state.filter === 'todo' ? '처리 전만' : '전체');
  return h('header', { class: 'top' },
    h('h1', null, '협업메일'),
    select,
    filterBtn,
    h('button', { type: 'button', class: 'btn small', title: '새로고침', onclick: () => go(state.date) }, '⟳'),
    h('button', { type: 'button', class: 'btn small', title: '토큰 다시 넣기', onclick: resetToken }, '⚙'),
  );
}

function summary() {
  const c = state.digest?.counts;
  const wrap = h('section', { class: 'summary' });
  if (c) {
    const parts = [
      ['🚨', c.urgent], ['🟢', c.green], ['후속', c.followup], ['🟡', c.yellow],
      ['🔴', c.red], ['중복', c.duplicate], ['무시', c.ignored],
    ].filter(([, n]) => n);
    wrap.append(h('div', { class: 'counts' }, parts.map(([k, n]) => h('span', { class: 'count' }, `${k} ${n}`))));
  }
  const notes = state.digest?.notes || [];
  if (notes.length) {
    wrap.append(h('details', { class: 'sec' },
      h('summary', null, `라우틴 메모 ${notes.length}`),
      h('ul', null, notes.map((n) => h('li', null, n)))));
  }
  return wrap;
}

function cardList() {
  const ids = state.order.filter((id) => {
    if (state.filter === 'all') return true;
    const s = state.mails[id].data.status;
    return s !== 'replied' && s !== 'archived';
  });
  if (!ids.length) {
    return h('p', { class: 'muted center' }, state.filter === 'todo' ? '처리할 메일이 없어요 🎉' : '메일이 없어요');
  }
  return h('div', { class: 'cards' }, ids.map((id) => getCard(id)));
}

// 카드 DOM은 날짜를 바꿀 때까지 재사용한다. 필터를 바꿔도 쓰던 초안이 사라지지 않게.
function getCard(id) {
  const entry = state.mails[id];
  if (entry.el) return entry.el;
  const m = entry.data;
  const head = h('button', { type: 'button', class: 'card-head', 'aria-expanded': 'false' });
  const check = h('input', { type: 'checkbox', class: 'done-check', 'aria-label': '답장 완료', title: '답장 완료' });
  check.addEventListener('change', () => toggleDone(id, check.checked));
  const gmail = IS_MOBILE
    ? h('button', { type: 'button', class: 'gmail', title: 'Gmail 앱에서 답장 쓰기', onclick: () => replyInApp(id) }, '답장 ↗')
    : h('a', {
      class: 'gmail',
      href: gmailUrl(m),
      target: '_blank',
      rel: 'noopener noreferrer',
      title: 'Gmail에서 이 메일 열기',
    }, '답장 ↗');
  const card = h('article', { class: cardClass(m), id: `m-${id}` },
    h('div', { class: 'card-row' }, check, head, gmail));
  head.addEventListener('click', () => toggleCard(id));
  entry.el = card;
  entry.head = head;
  entry.check = check;
  fillHead(id);
  syncCheck(id);
  return card;
}

function gmailUrl(m) {
  return `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(GMAIL_ACCOUNT)}#all/${m.thread_id || m.id}`;
}

// Gmail 앱 작성 화면. iOS는 googlegmail:///co, 안드로이드는 Gmail 앱을 지정한 mailto 인텐트.
// 앱에서는 보내는 계정을 고를 수 없어서(from 미지원) 앱에 선택된 계정으로 열린다.
function composeUrl(to, subject, body) {
  const q = (o) => Object.entries(o).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  if (IS_IOS) return `googlegmail:///co?${q({ to, subject, body })}`;
  if (IS_ANDROID) return `intent:${encodeURIComponent(to || '')}?${q({ subject, body })}#Intent;scheme=mailto;package=com.google.android.gm;end`;
  return null;
}

// 아이폰 Gmail 앱은 특정 메일을 바로 여는 공식 링크가 없다. (예전 googlegmail:///cv= 방식은 지금 안 된다는 보고가 있음)
// 그래서 검색어(from:보낸사람)를 복사해 두고 앱을 연다. 앱 검색창에 붙여넣으면 그 사람 메일만 나온다.
// 안드로이드는 mail.google.com 링크를 Gmail 앱이 받아서 일반 링크 그대로 둔다.
function openInGmailApp(m) {
  const q = m.from?.email ? `from:${m.from.email}` : m.subject || '';
  // 탭한 순간 안에 복사와 앱 열기를 같이 해야 사파리가 막지 않는다.
  navigator.clipboard?.writeText(q).catch(() => {});
  toast(`검색어 복사됨 · Gmail 검색창에 붙여넣으세요 (${q})`);
  location.href = 'googlegmail://';
}

// [임시 · 2026-10-28] 아이폰에서 메일 하나를 바로 여는 방법 시험. 되는 걸 찾으면 「Gmail에서 열기」에 넣고 이 줄은 지운다.
// 1~3: 비공식 Gmail 앱 링크(googlegmail:///cv=스레드ID/accountId=앱 계정 순번). 4: 크롬 앱으로 Gmail 웹 열기.
function openTestRow(m) {
  const tid = m.thread_id || m.id;
  const a = (label, href) => h('a', { class: 'btn small', href }, label);
  return h('div', { class: 'note opentest' },
    h('div', null, '메일 바로 열기 시험 — 하나씩 눌러보고 어느 게 이 메일로 가는지 알려주세요'),
    h('div', { class: 'row' },
      a('1', `googlegmail:///cv=${tid}/accountId=0`),
      a('2', `googlegmail:///cv=${tid}/accountId=1`),
      a('3', `googlegmail:///cv=${tid}/accountId=2`),
      a('4 크롬', gmailUrl(m).replace(/^https:/, 'googlechromes:'))));
}

function replySubject(m, dr) {
  if (dr?.subject) return dr.subject;
  if (!m.subject) return '';
  return /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`;
}

// 보낼 초안: 해외 건은 EN, 국내 건은 KO. 없으면 -1.
function sendIndex(m) {
  const want = m.lang === 'ko' ? 'ko' : 'en';
  const i = (m.drafts || []).findIndex((dr) => dr.lang === want);
  return i >= 0 ? i : (m.drafts?.length ? 0 : -1);
}

function openCompose(id, i) {
  const entry = state.mails[id];
  const m = entry.data;
  const dr = i >= 0 ? m.drafts[i] : null;
  // 화면에서 고치던 본문이 있으면 그걸 보낸다.
  const body = i >= 0 ? (entry.draftInputs?.[i]?.value ?? dr.body ?? '') : '';
  const n = (body.match(/\[확인필요/g) || []).length;
  if (n && !confirm(`[확인필요] ${n}곳이 남아 있어요. 그래도 Gmail 앱을 열까요?`)) return;
  location.href = composeUrl(m.from?.email, replySubject(m, dr), body);
}

// 카드의 「답장」 버튼 (폰). 초안이 한 종류면 바로 작성 화면, 수락·거절처럼 여러 종류면 초안 탭으로 보낸다.
function replyInApp(id) {
  const entry = state.mails[id];
  const kinds = new Set((entry.data.drafts || []).map((dr) => dr.kind));
  if (kinds.size > 1) {
    openCard(id);
    entry.detail.querySelector('.drafts')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    toast('보낼 초안 탭에서 「Gmail 앱으로」를 눌러 주세요');
    return;
  }
  openCompose(id, sendIndex(entry.data));
}

const isDone = (status) => status === 'replied' || status === 'archived';

function syncCheck(id) {
  const entry = state.mails[id];
  if (!entry.check) return;
  // 저장 중엔 누른 상태를 그대로 둔다. (pending은 저장 시작 때 비워짐)
  if (!entry.saving) entry.check.checked = isDone(entry.pending.status || entry.data.status);
  entry.check.disabled = entry.saving;
}

// 체크하면 답장함으로 바꾸고, 처리 전만 보기에서는 목록에서 뺀다. 되돌리기는 이전 상태로.
async function toggleDone(id, done) {
  const entry = state.mails[id];
  const before = entry.pending.status || entry.data.status;
  entry.pending.status = done ? 'replied' : (isDone(entry.undoStatus) ? 'new' : entry.undoStatus || 'new');
  if (done) entry.undoStatus = before;
  entry.el.classList.toggle('done', done);
  const ok = await save(id, { quiet: true });
  if (!ok) {
    // 체크는 실패하면 그냥 원래대로. (저장 안 됨 상태로 남기지 않는다)
    entry.pending.status = null;
    if (!hasPending(entry.pending)) state.dirty.delete(id);
    fillHead(id);
    renderActions(id);
    syncCheck(id);
    return;
  }
  if (!done) {
    toast('처리 전으로 돌렸어요');
    return;
  }
  const undo = { label: '되돌리기', fn: () => toggleDone(id, false).then(() => render()) };
  if (state.filter !== 'todo') {
    toast('답장 완료로 표시했어요', false, undo);
    return;
  }
  entry.el.classList.add('leaving');
  setTimeout(() => {
    entry.el.classList.remove('leaving');
    render();
  }, 250);
  toast('답장 완료 · 목록에서 뺐어요', false, undo);
}

function cardClass(m) {
  const cls = ['card'];
  if (m.urgent) cls.push('urgent');
  if (m.verdict) cls.push(`v-${m.verdict}`);
  if (m.category === 'collab_duplicate') cls.push('dim');
  if (isDone(m.status)) cls.push('done');
  return cls.join(' ');
}

function fillHead(id) {
  const entry = state.mails[id];
  const m = entry.data;
  const line = state.digest?.lines?.[id] ||
    `${m.urgent ? '🚨' : ''}${VERDICT[m.verdict] || ''} ${m.brand?.name || m.subject || id}`;
  const draftCount = new Set((m.drafts || []).map((d) => d.kind)).size;
  entry.head.replaceChildren(
    h('div', { class: 'line' }, STATUS_ICON[m.status] ? `${STATUS_ICON[m.status]} ` : '', line),
    h('div', { class: 'sub' },
      h('span', null, `${m.from?.name || m.from?.email || ''} · ${fmtTime(m.received_at)}`),
      m.from_spam ? h('span', { class: 'chip warn' }, '스팸함') : null,
      draftCount ? h('span', { class: 'chip' }, draftCount > 1 ? `초안 ${draftCount}종` : '초안') : null,
      (m.drafts || []).some((d) => d.edited) ? h('span', { class: 'chip' }, '수정함') : null,
      m.translate_request && !m.translate_request.error ? h('span', { class: 'chip' }, '번역 중') : null,
      m.regenerate_request && !m.regenerate_request.error ? h('span', { class: 'chip' }, '다시 쓰는 중') : null,
      m.research_request && !m.research_request.error ? h('span', { class: 'chip' }, '조사 중') : null,
      state.dirty.has(id) ? h('span', { class: 'chip warn' }, '저장 안 됨') : null,
    ),
  );
}

function toggleCard(id) {
  const entry = state.mails[id];
  if (!entry.detail) {
    entry.detail = buildDetail(id);
    entry.el.append(entry.detail);
  } else {
    entry.detail.hidden = !entry.detail.hidden;
  }
  const open = !entry.detail.hidden;
  entry.head.setAttribute('aria-expanded', String(open));
  entry.el.classList.toggle('open', open);
  if (open) requestAnimationFrame(() => entry.detail.querySelectorAll('textarea.draft').forEach(autosize));
}

function openCard(id) {
  const entry = state.mails[id];
  if (!entry) return false;
  if (!entry.el.isConnected) {
    state.filter = 'all';
    render();
  }
  if (!entry.detail || entry.detail.hidden) toggleCard(id);
  entry.el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  return true;
}

function section(title, content, { open = false, cls = '' } = {}) {
  return h('details', { class: `sec ${cls}`, open }, h('summary', null, title), content);
}

function list(items, ordered) {
  return h(ordered ? 'ol' : 'ul', null, (items || []).map((x) => h('li', null, txt(x))));
}

function kv(rows) {
  const dl = h('dl', { class: 'kv' });
  for (const [k, v] of rows) {
    const value = v instanceof Node ? v : txt(v);
    if (value == null) continue;
    dl.append(h('dt', null, k), h('dd', null, value));
  }
  return dl;
}

function buildDetail(id) {
  const m = state.mails[id].data;
  const a = m.analysis || {};
  const d = h('div', { class: 'detail' });

  d.append(h('div', { class: 'meta' },
    h('div', null, h('b', null, m.from?.name || ''), ' ', h('span', { class: 'muted' }, m.from?.email || ''),
      ' · ', IS_IOS
        ? h('button', { type: 'button', class: 'linkish', onclick: () => openInGmailApp(m) }, 'Gmail에서 열기')
        : link(gmailUrl(m), 'Gmail에서 열기')),
    h('div', null, m.subject || ''),
    h('div', { class: 'muted' }, `받음 ${fmtTime(m.received_at)}`,
      m.company?.name ? ` · ${m.company.name}` : '',
      m.company?.type ? ` (${COMPANY_TYPE[m.company.type] || m.company.type})` : ''),
  ));

  if (IS_IOS) d.append(openTestRow(m));

  if (m.deadline) {
    d.append(h('div', { class: 'alert' }, `회신 기한 ${m.deadline.date}`,
      m.deadline.quote ? h('div', { class: 'quote' }, `“${m.deadline.quote}”`) : null));
  }
  if (m.from_spam) d.append(h('div', { class: 'alert' }, '스팸함에서 찾은 메일이에요'));
  if (m.duplicate_of) {
    d.append(h('div', { class: 'note' }, '이전 메일과 같은 제안: ',
      state.mails[m.duplicate_of]
        ? h('button', { type: 'button', class: 'linkish', onclick: () => openCard(m.duplicate_of) },
          state.digest?.lines?.[m.duplicate_of] || m.duplicate_of)
        : m.duplicate_of));
  }
  if (m.changes_from_previous) d.append(h('div', { class: 'note' }, `이전과 달라진 점: ${m.changes_from_previous}`));

  if (a.needs_user_input?.length) d.append(section('정원 확인 필요', list(a.needs_user_input), { open: true, cls: 'ask' }));

  d.append(section('메일 내용 및 분석', h('div', null,
    h('p', { class: 'label' }, '메일 내용'),
    h('div', { class: 'body mailbody' }, m.body || '(내용 없음)'),
    a.questions?.length ? h('div', null, h('p', { class: 'label' }, '상대 질문'), list(a.questions, true)) : null,
    kv([
      ['형태', a.collab_type ? `${COLLAB[a.collab_type] || a.collab_type}${a.content_count ? ` · ${a.content_count}편` : ''}` : null],
      ['일정', a.schedule],
      ['할인 요청', a.discount_request ? '있음' : null],
      ['2차 활용', a.secondary_use ? '언급 있음' : null],
      ['자동DM 질문', a.auto_dm_question ? '있음' : null],
    ]),
    a.risks?.length ? h('div', null, h('p', { class: 'label' }, '유의점'), list(a.risks)) : null,
  )));

  const research = researchSection(id);
  if (research) d.append(research);
  if (m.research_request && !m.research_request.error) watchResearch(id);
  if (m.drafts?.length) d.append(draftsView(id));
  d.append(feedbackView(id));
  d.append(actionsView(id));
  return d;
}

function researchSection(id) {
  const entry = state.mails[id];
  const m = entry.data;
  const hasDb = !!(m.brand?.service_id || m.company?.company_id);
  const reasons = m.verdict_reasons?.length
    ? h('div', null, h('p', { class: 'label' }, `판정 근거${m.verdict ? ` ${VERDICT[m.verdict]}` : ''}`), list(m.verdict_reasons))
    : null;
  if (!hasDb) return reasons ? section('조사 결과', reasons) : null;
  const views = h('div', null, h('p', { class: 'muted' }, '불러오는 중…'));
  const btn = h('button', {
    type: 'button',
    class: 'btn small',
    title: '못 찾은 항목 위주로 조금 더 찾아요 (Sonnet, 검색 10회 이내)',
    onclick: () => startResearch(id),
  }, '더 조사');
  entry.rs = {
    views,
    btn,
    status: h('p', { class: 'tr-status', hidden: true }),
    note: h('div', { class: 'note', hidden: true }),
  };
  const det = section('조사 결과', h('div', { class: 'research' },
    reasons,
    entry.rs.note,
    views,
    h('div', { class: 'row' }, btn),
    entry.rs.status));
  det.addEventListener('toggle', () => {
    if (det.open && !views.dataset.done) fillResearch(id);
  });
  renderResearch(id);
  return det;
}

async function fillResearch(id) {
  const m = state.mails[id].data;
  const { views } = state.mails[id].rs;
  const sid = m.brand?.service_id;
  const cid = m.company?.company_id;
  try {
    const db = await loadDb();
    views.replaceChildren(...[
      sid ? serviceView(db.services[sid], sid) : null,
      cid ? companyView(db.companies[cid], cid) : null,
    ].filter(Boolean));
    views.dataset.done = '1';
  } catch (e) {
    views.replaceChildren(h('p', { class: 'err' }, `조사 DB를 못 불러왔어요: ${errMsg(e)}`));
  }
}

function sources(list_) {
  if (!list_?.length) return null;
  return h('span', { class: 'sources' }, list_.map((s, i) => [i ? ' · ' : '', link(s.url || s, `${i + 1}`)]));
}

// 로그인해야 보이는 곳은 자동 조사에서 빼고 직접 확인 링크로 대신한다.
const LOGIN_WALLED = /linkedin|glassdoor|indeed|잡플래닛|jobplanet|블라인드|blind|크레딧잡|채용\s*(사이트\s*)?평/i;
const stillMissing = (list_) => (list_ || []).filter((x) => !LOGIN_WALLED.test(String(x)));

function domainText(dm) {
  if (!dm?.name) return null;
  if (!dm.registered) return `${dm.name} · 등록일 ${dm.error || '미확인'}`;
  const months = Math.floor((Date.now() - Date.parse(dm.registered)) / (30.44 * 864e5));
  const age = months < 12 ? `${months}개월 전` : `${Math.floor(months / 12)}년 전`;
  return `${dm.name} · ${dm.registered} 등록 (${age})${months < 12 ? ' ⚠ 1년 미만' : ''}`;
}

function manualChecks(name) {
  const n = name.replace(/\s*\(.*\)\s*$/, '');
  const q = encodeURIComponent(n);
  const google = (s) => `https://www.google.com/search?q=${encodeURIComponent(s)}`;
  return h('span', { class: 'sources' },
    link(`https://www.linkedin.com/search/results/companies/?keywords=${q}`, 'LinkedIn'), ' · ',
    link(google(`${n} glassdoor`), 'Glassdoor'), ' · ',
    link(`https://www.jobplanet.co.kr/search?query=${q}`, '잡플래닛'), ' · ',
    link(`https://www.teamblind.com/kr/search/${q}`, '블라인드'), ' · ',
    link(google(`"${n}" scam OR 사기 OR 미지급`), 'scam 검색'));
}

// 서비스·발신 회사는 각각 접었다 펴는 칸. 처음엔 접혀 있다.
function dbToggle(title, content) {
  return h('details', { class: 'db' }, h('summary', null, title.trim()), content);
}

function serviceView(s, sid) {
  if (!s) return dbToggle(`서비스 · ${sid}`, h('p', { class: 'muted' }, '조사 기록 없음'));
  const op = s.operator || {};
  const pa = s.parent || {};
  const rep = s.reputation || {};
  return dbToggle(`서비스 · ${s.name || sid} ${VERDICT[s.verdict_hint] || ''}`,
    kv([
      ['운영사', [op.legal_name || '법인명 미확인', op.country].filter(Boolean).join(' · ')],
      ['모회사', pa.name ? `${pa.name}${pa.country ? ` · ${pa.country}` : ''}${pa.confidence ? ` (${pa.confidence})` : ''}` : null],
      ['중국계', s.china_linked],
      ['요약', rep.summary],
      ['규모', rep.scale],
      ['평점', rep.app_ratings],
      ['리뷰', rep.reviews],
      ['논란', rep.controversies],
      ['도메인', domainText(s.domain)],
      ['미확인', stillMissing(s.missing)],
      ['조사일', s.researched_at],
      ['출처', sources(s.sources)],
    ]),
  );
}

function companyView(c, cid) {
  if (!c) return dbToggle(`발신 회사 · ${cid}`, h('p', { class: 'muted' }, '조사 기록 없음'));
  const rv = c.reviews || {};
  return dbToggle(`발신 회사 · ${c.name || cid} ${VERDICT[c.verdict_hint] || ''}`,
    kv([
      ['유형', COMPANY_TYPE[c.type] || c.type],
      ['국가', c.country],
      ['웹사이트', c.website ? link(c.website) : null],
      ['규모', c.size],
      ['평판', rv.summary],
      ['잡플래닛', rv.jobplanet],
      ['블라인드', rv.blind],
      ['Glassdoor', rv.glassdoor],
      ['논란', c.controversies],
      ['도메인', domainText(c.domain)],
      ['미확인', stillMissing(c.missing)],
      ['조사일', c.researched_at],
      ['출처', sources(c.sources)],
      ['직접 확인', manualChecks(c.name || cid)],
    ]),
  );
}

function draftsView(id) {
  const entry = state.mails[id];
  const m = entry.data;
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const panels = h('div');
  const tabEls = [];
  const panelEls = [];

  const select = (i) => {
    tabEls.forEach((t, j) => t.setAttribute('aria-selected', String(i === j)));
    panelEls.forEach((p, j) => { p.hidden = i !== j; });
    panelEls[i].querySelectorAll('textarea').forEach(autosize);
    entry.tab = i;
    renderRegen(id);
  };

  entry.draftInputs = [];
  entry.draftKeys = m.drafts.map((dr) => `${dr.kind}/${dr.lang}`);
  entry.trEls = [];

  m.drafts.forEach((dr, i) => {
    const review = m.lang !== 'ko' && dr.lang === 'ko';
    const paired = m.lang !== 'ko' && m.drafts.some((x) => x.kind === dr.kind && x.lang === (dr.lang === 'ko' ? 'en' : 'ko'));
    tabEls.push(h('button', { type: 'button', class: 'tab', role: 'tab', onclick: () => select(i) },
      `${KIND[dr.kind] || dr.kind} · ${(dr.lang || '').toUpperCase()}`, review ? ' (검토용)' : '', dr.edited ? ' ✎' : ''));

    const ta = h('textarea', { class: 'draft', spellcheck: 'false', value: dr.body || '' });
    const warn = h('p', { class: 'warn-text' });
    const updateWarn = () => {
      const n = (ta.value.match(/\[확인필요/g) || []).length;
      warn.textContent = n ? `[확인필요] ${n}곳 — 채운 뒤 보내세요` : '';
      warn.hidden = !n;
    };
    ta.addEventListener('input', () => {
      autosize(ta);
      updateWarn();
      entry.pending.drafts[i] = ta.value;
      markDirty(id);
    });
    updateWarn();
    entry.draftInputs[i] = ta;
    // 번역본이 들어왔을 때 값만 바꾸고 높이·경고를 다시 맞춘다. (input 이벤트는 수정으로 잡히므로 따로)
    ta.addEventListener('refresh', () => { autosize(ta); updateWarn(); });

    const trStatus = paired ? h('p', { class: 'tr-status', hidden: true }) : null;
    if (trStatus) entry.trEls.push({ kind: dr.kind, el: trStatus });
    const trBtn = review && paired
      ? h('button', {
        type: 'button',
        class: 'btn',
        title: '이 국문본 기준으로 영문 초안을 다시 써요 (1~2분)',
        onclick: () => startTranslation(id, i),
      }, '영문에 반영')
      : null;

    panelEls.push(h('div', { class: 'panel', role: 'tabpanel' },
      dr.subject ? h('div', { class: 'subject' },
        h('span', { class: 'muted' }, '제목 '), h('span', null, dr.subject),
        h('button', { type: 'button', class: 'btn small', onclick: () => copyText(dr.subject) }, '제목 복사')) : null,
      ta,
      warn,
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn primary', onclick: () => copyText(ta.value) }, '본문 복사'),
        IS_MOBILE && !review
          ? h('button', { type: 'button', class: 'btn', title: '제목·받는 사람·본문을 채운 Gmail 앱 작성 화면을 열어요', onclick: () => openCompose(id, i) }, 'Gmail 앱으로')
          : null,
        trBtn,
        review ? h('span', { class: 'muted' }, '보낼 땐 EN 탭 본문을 복사하세요') : null),
      trStatus,
    ));
  });
  renderTranslation(id);
  if (m.translate_request && !m.translate_request.error) watchTranslation(id);

  tabs.append(...tabEls);
  panels.append(...panelEls);
  // 해외 건은 보낼 영어 초안을 먼저 보여준다.
  const first = Math.max(0, m.drafts.findIndex((dr) => dr.lang === (m.lang === 'ko' ? 'ko' : 'en')));
  tabEls.forEach((t, j) => t.setAttribute('aria-selected', String(j === first)));
  panelEls.forEach((p, j) => { p.hidden = j !== first; });
  entry.tab = first;
  const regen = regenBox(id);
  renderRegen(id);
  if (m.regenerate_request && !m.regenerate_request.error) watchRegenerate(id);
  return h('section', { class: 'drafts' }, h('h3', null, '답장 초안'), tabs, panels, regen);
}

// ---------- 초안 다시 쓰기 ----------
// 보고 있는 탭의 초안 종류(kind)를 다시 쓴다. 해외 건은 KO·EN을 같이.

function regenBox(id) {
  const entry = state.mails[id];
  entry.rg = {
    stale: h('p', { class: 'tr-status err', hidden: true }),
    label: h('p', { class: 'label' }),
    input: h('textarea', {
      class: 'note-input',
      rows: '2',
      placeholder: '예: 광고 일정이 꽉 차서 죄송하지만 이번엔 어렵다는 내용으로 바꿔줘',
    }),
    btn: h('button', { type: 'button', class: 'btn', onclick: () => startRegenerate(id) }, '초안 다시 쓰기'),
    undo: h('button', {
      type: 'button',
      class: 'btn small',
      title: '다시 쓰기 전 초안과 바꿔요. 한 번 더 누르면 다시 돌아와요',
      onclick: () => swapPrevious(id),
    }, '↶ 이전 초안으로'),
    status: h('p', { class: 'tr-status', hidden: true }),
  };
  const { stale, label, input, btn, undo, status } = entry.rg;
  return h('div', { class: 'regen' }, stale, label, input, h('div', { class: 'row' }, btn, undo), status);
}

const tabKind = (entry) => entry.data.drafts?.[entry.tab]?.kind;

function renderRegen(id) {
  const entry = state.mails[id];
  if (!entry.rg) return;
  const { stale, label, btn, undo, status } = entry.rg;
  const kind = tabKind(entry);
  const same = (entry.data.drafts || []).filter((x) => x.kind === kind);
  // 채널 현황을 이 초안을 만든 뒤에 바꿨으면 알려만 준다. (자동으로 다시 쓰지 않는다)
  const changed = state.profile.data?.updated_at;
  const made = same.map((x) => x.regenerated_at || entry.data.processed_at || '').sort().pop();
  stale.hidden = !(changed && made && changed > made);
  stale.textContent = stale.hidden ? '' : `채널 현황이 이 초안 뒤에 바뀌었어요 (${fmtTime(changed)}). 보낼 거면 「초안 다시 쓰기」로 맞춰 주세요`;
  label.textContent = `수정 요청 · ${KIND[kind] || kind} 초안${same.length > 1 ? ' (KO·EN 같이 다시 써요)' : ''}`;
  btn.disabled = !!(entry.regenerating || entry.saving);
  btn.textContent = entry.regenerating ? '다시 쓰는 중…' : '초안 다시 쓰기';
  undo.hidden = !same.some((x) => x.previous_body != null);
  undo.disabled = !!(entry.regenerating || entry.saving);
  const req = entry.data.regenerate_request;
  let note = entry.rgNote;
  if (!note && req?.error) note = { text: `다시 쓰기 실패: ${req.error}`, err: true };
  else if (!note && req) note = { text: `${KIND[req.kind] || req.kind} 초안 다시 쓰는 중… 1~3분 걸려요. 창을 닫아도 계속돼요` };
  status.hidden = !note;
  status.textContent = note ? note.text : '';
  status.classList.toggle('err', !!note?.err);
}

async function startRegenerate(id) {
  const entry = state.mails[id];
  if (entry.saving || entry.regenerating) return;
  if (entry.watching) {
    toast('영문 번역이 끝난 뒤에 눌러 주세요', true);
    return;
  }
  const comment = entry.rg.input.value.trim();
  if (!comment) {
    toast('어떻게 고칠지 적어 주세요', true);
    entry.rg.input.focus();
    return;
  }
  // 고치던 초안도 같이 저장해서, 고친 본문을 바탕으로 다시 쓰게 한다.
  entry.pending.regenerate = { kind: tabKind(entry), comment };
  entry.rgNote = { text: '요청 저장 중…' };
  renderRegen(id);
  if (!(await save(id, { quiet: true }))) {
    entry.rgNote = null;
    renderRegen(id);
    return;
  }
  try {
    await dispatch('regenerate-draft');
  } catch (e) {
    entry.rgNote = { text: `다시 쓰기를 시작하지 못했어요: ${errMsg(e)} — 다시 눌러 주세요`, err: true };
    renderRegen(id);
    return;
  }
  watchRegenerate(id);
}

async function watchRegenerate(id) {
  const entry = state.mails[id];
  if (entry.regenerating) return;
  entry.regenerating = true;
  entry.rgNote = null;
  const kind = entry.data.regenerate_request?.kind;
  renderRegen(id);
  fillHead(id);
  try {
    const r = await waitForJob(id, 'regenerate_request', REGEN_WAIT_MS);
    if (r?.timeout) entry.rgNote = { text: '다시 쓰기가 오래 걸리고 있어요. 잠시 뒤 ⟳ 새로고침해 보세요', err: true };
    else if (r) applyRegenerate(id, r.fresh, kind);
  } finally {
    entry.regenerating = false;
    if (state.mails[id] === entry) {
      renderRegen(id);
      fillHead(id);
    }
  }
}

// kind 초안 입력칸을 entry.data의 본문으로 바꾼다. 그 사이 직접 고치던 칸은 두고 false.
function showDrafts(id, kind) {
  const entry = state.mails[id];
  let all = true;
  (entry.draftKeys || []).forEach((key, i) => {
    const dr = entry.data.drafts?.find((x) => `${x.kind}/${x.lang}` === key);
    const ta = entry.draftInputs?.[i];
    if (!dr || dr.kind !== kind || !ta) return;
    if (entry.pending.drafts[i] != null) {
      all = false;
      return;
    }
    ta.value = dr.body || '';
    ta.dispatchEvent(new Event('refresh'));
  });
  return all;
}

function applyRegenerate(id, fresh, kind) {
  const entry = state.mails[id];
  entry.data = fresh.data;
  entry.sha = fresh.sha;
  if (fresh.data.regenerate_request?.error) {
    toast('초안 다시 쓰기에 실패했어요', true);
    return;
  }
  if (!showDrafts(id, kind)) {
    entry.rgNote = { text: '초안 칸을 직접 고치던 중이라 새 초안으로 바꾸지 않았어요. ⟳ 새로고침하면 보여요', err: true };
    return;
  }
  entry.rg.input.value = '';
  const comment = fresh.data.drafts?.find((x) => x.kind === kind)?.regen_comment;
  entry.rgNote = { text: `다시 썼어요 ✓${comment ? ` 요청: “${comment}”` : ''}` };
  toast('초안을 다시 썼어요');
}

async function swapPrevious(id) {
  const entry = state.mails[id];
  if (entry.saving || entry.regenerating) return;
  const kind = tabKind(entry);
  const editing = (entry.draftKeys || []).some((key, i) => key.startsWith(`${kind}/`) && entry.pending.drafts[i] != null);
  if (!confirm(editing ? '저장 안 한 수정은 사라지고 이전 초안으로 바뀌어요. 계속할까요?' : '이전 초안으로 바꿀까요?')) return;
  (entry.draftKeys || []).forEach((key, i) => { if (key.startsWith(`${kind}/`)) delete entry.pending.drafts[i]; });
  entry.pending.swap = kind;
  entry.rgNote = null;
  if (await save(id, { quiet: true })) {
    showDrafts(id, kind);
    toast('이전 초안으로 바꿨어요');
  }
  renderRegen(id);
}

// ---------- 영문 다시 번역 ----------

async function startTranslation(id, i) {
  const entry = state.mails[id];
  if (entry.saving || entry.watching) return;
  if (entry.regenerating) {
    toast('초안 다시 쓰기가 끝난 뒤에 눌러 주세요', true);
    return;
  }
  const kind = entry.data.drafts[i].kind;
  const en = entry.data.drafts.findIndex((x) => x.kind === kind && x.lang === 'en');
  if (entry.pending.drafts[en] != null && !confirm('EN 탭에서 고친 내용이 번역본으로 바뀌어요. 계속할까요?')) return;
  entry.pending.drafts[i] = entry.draftInputs[i].value;
  entry.pending.translate = kind;
  entry.trNote = { kind, text: '국문본 저장 중…' };
  renderTranslation(id);
  if (!(await save(id, { quiet: true }))) {
    entry.trNote = null;
    renderTranslation(id);
    return;
  }
  try {
    await dispatch('translate-draft');
  } catch (e) {
    entry.trNote = { kind, text: `번역을 시작하지 못했어요: ${errMsg(e)} — 다시 눌러 주세요`, err: true };
    renderTranslation(id);
    return;
  }
  watchTranslation(id);
}

function renderTranslation(id) {
  const entry = state.mails[id];
  const req = entry.data.translate_request;
  let note = entry.trNote;
  if (!note && req?.error) note = { kind: req.kind, text: `번역 실패: ${req.error}`, err: true };
  else if (!note && req) note = { kind: req.kind, text: '영문 번역 중… 1~2분 뒤 EN 탭이 바뀌어요' };
  for (const { kind, el } of entry.trEls || []) {
    const show = note && note.kind === kind;
    el.hidden = !show;
    el.textContent = show ? note.text : '';
    el.classList.toggle('err', !!note?.err);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 워크플로가 field 요청을 지우거나 error를 남길 때까지 파일을 다시 읽는다.
// 끝나면 { fresh }, 너무 오래 걸리면 { timeout: true }, 날짜를 옮겨 화면이 바뀌었으면 null.
async function waitForJob(id, field, waitMs) {
  const entry = state.mails[id];
  const started = Date.parse(entry.data[field]?.requested_at) || Date.now();
  while (state.mails[id] === entry) {
    await sleep(8000);
    if (state.mails[id] !== entry) return null;
    const fresh = await readJson(entry.path).catch(() => null);
    if (!fresh) continue;
    const req = fresh.data[field];
    if (!req || req.error) return { fresh };
    if (Date.now() - started > waitMs) return { timeout: true };
  }
  return null;
}

async function watchTranslation(id) {
  const entry = state.mails[id];
  if (entry.watching) return;
  entry.watching = true;
  entry.trNote = null;
  const kind = entry.data.translate_request?.kind;
  renderTranslation(id);
  fillHead(id);
  try {
    const r = await waitForJob(id, 'translate_request', TRANSLATE_WAIT_MS);
    if (r?.timeout) entry.trNote = { kind, text: '번역이 오래 걸리고 있어요. 잠시 뒤 ⟳ 새로고침해 보세요', err: true };
    else if (r) applyTranslation(id, r.fresh, kind);
  } finally {
    entry.watching = false;
    if (state.mails[id] === entry) {
      renderTranslation(id);
      fillHead(id);
    }
  }
}

function applyTranslation(id, fresh, kind) {
  const entry = state.mails[id];
  entry.data = fresh.data;
  entry.sha = fresh.sha;
  if (fresh.data.translate_request?.error) {
    toast('영문 번역에 실패했어요', true);
    return;
  }
  const en = fresh.data.drafts?.find((x) => x.kind === kind && x.lang === 'en');
  const i = (entry.draftKeys || []).indexOf(`${kind}/en`);
  const ta = entry.draftInputs?.[i];
  if (!en || !ta) return;
  if (entry.pending.drafts[i] != null) {
    entry.trNote = { kind, text: 'EN 탭을 직접 고치던 중이라 번역본으로 바꾸지 않았어요', err: true };
    return;
  }
  ta.value = en.body;
  ta.dispatchEvent(new Event('refresh'));
  entry.trNote = { kind, text: '영문 초안에 반영했어요 ✓ EN 탭에서 확인하세요' };
  toast('영문 초안에 반영했어요');
}

// ---------- 더 조사 ----------

async function startResearch(id) {
  const entry = state.mails[id];
  if (entry.saving || entry.researching) return;
  entry.pending.research = true;
  entry.rsNote = { text: '요청 저장 중…' };
  renderResearch(id);
  if (!(await save(id, { quiet: true }))) {
    entry.rsNote = null;
    renderResearch(id);
    return;
  }
  try {
    await dispatch('research-more');
  } catch (e) {
    entry.rsNote = { text: `조사를 시작하지 못했어요: ${errMsg(e)} — 다시 눌러 주세요`, err: true };
    renderResearch(id);
    return;
  }
  watchResearch(id);
}

function renderResearch(id) {
  const entry = state.mails[id];
  if (!entry.rs) return;
  const { status, note, btn } = entry.rs;
  const req = entry.data.research_request;
  let s = entry.rsNote;
  if (!s && req?.error) s = { text: `조사 실패: ${req.error}`, err: true };
  else if (!s && req) s = { text: '더 조사하는 중… 보통 3~6분 걸려요. 창을 닫아도 계속돼요' };
  status.hidden = !s;
  status.textContent = s ? s.text : '';
  status.classList.toggle('err', !!s?.err);
  btn.disabled = !!entry.researching;
  const rn = entry.data.research_note;
  note.hidden = !rn?.text;
  note.textContent = rn?.text ? `더 조사 결과 (${fmtTime(rn.at)}) — ${rn.text}` : '';
}

async function watchResearch(id) {
  const entry = state.mails[id];
  if (entry.researching) return;
  entry.researching = true;
  entry.rsNote = null;
  renderResearch(id);
  fillHead(id);
  try {
    const r = await waitForJob(id, 'research_request', RESEARCH_WAIT_MS);
    if (r?.timeout) {
      entry.rsNote = { text: '조사가 오래 걸리고 있어요. 잠시 뒤 ⟳ 새로고침해 보세요', err: true };
    } else if (r) {
      entry.data = r.fresh.data;
      entry.sha = r.fresh.sha;
      if (r.fresh.data.research_request?.error) {
        toast('더 조사에 실패했어요', true);
      } else {
        state.db = null;
        await fillResearch(id);
        toast('조사 결과를 반영했어요');
      }
    }
  } finally {
    entry.researching = false;
    if (state.mails[id] === entry) {
      renderResearch(id);
      fillHead(id);
    }
  }
}

function feedbackView(id) {
  const entry = state.mails[id];
  const m = entry.data;
  const fb = { verdict_ok: null, correct_verdict: null, note: '', ...(m.feedback || {}) };
  const wrap = h('section', { class: 'feedback' }, h('h3', null, '판정 평가'));

  const change = () => {
    entry.pending.feedback = { ...fb };
    markDirty(id);
  };

  if (m.verdict) {
    const correct = h('select', { class: 'select', 'aria-label': '맞는 판정' },
      h('option', { value: '' }, '맞는 판정은?'),
      Object.keys(VERDICT_NAME).filter((v) => v !== m.verdict)
        .map((v) => h('option', { value: v, selected: fb.correct_verdict === v }, VERDICT_NAME[v])));
    correct.hidden = fb.verdict_ok !== false;
    correct.addEventListener('change', () => { fb.correct_verdict = correct.value || null; change(); });

    const yes = h('button', { type: 'button', class: 'btn small' }, '👍 맞아요');
    const no = h('button', { type: 'button', class: 'btn small' }, '👎 아니에요');
    const sync = () => {
      yes.classList.toggle('on', fb.verdict_ok === true);
      no.classList.toggle('on', fb.verdict_ok === false);
      correct.hidden = fb.verdict_ok !== false;
    };
    yes.addEventListener('click', () => {
      fb.verdict_ok = fb.verdict_ok === true ? null : true;
      fb.correct_verdict = null;
      correct.value = '';
      sync();
      change();
    });
    no.addEventListener('click', () => {
      fb.verdict_ok = fb.verdict_ok === false ? null : false;
      if (fb.verdict_ok !== false) { fb.correct_verdict = null; correct.value = ''; }
      sync();
      change();
    });
    sync();
    wrap.append(h('div', { class: 'row' }, h('span', null, `판정 ${VERDICT_NAME[m.verdict]}`), yes, no, correct));
  }

  const note = h('textarea', { class: 'note-input', rows: '2', placeholder: '메모 (판정·초안 기준 개선용)', value: fb.note || '' });
  note.addEventListener('input', () => { fb.note = note.value; change(); });
  wrap.append(note);
  return wrap;
}

function actionsView(id) {
  const entry = state.mails[id];
  const wrap = h('section', { class: 'actions' });
  entry.actions = wrap;
  renderActions(id);
  return wrap;
}

function renderActions(id) {
  const entry = state.mails[id];
  if (!entry.actions) return;
  const current = entry.pending.status || entry.data.status;
  const statusBtns = Object.entries(STATUS).map(([k, label]) =>
    h('button', {
      type: 'button',
      class: `seg${current === k ? ' on' : ''}`,
      disabled: entry.saving,
      onclick: () => {
        if (current === k) return;
        entry.pending.status = k;
        save(id);
      },
    }, label));
  entry.actions.replaceChildren(
    h('div', { class: 'segs' }, statusBtns),
    h('button', {
      type: 'button',
      class: 'btn primary',
      disabled: entry.saving || !state.dirty.has(id),
      onclick: () => save(id),
    }, entry.saving ? '저장 중…' : state.dirty.has(id) ? '저장' : '저장됨'),
  );
}

// ---------- 저장 ----------

function emptyPending() {
  return { drafts: {}, feedback: null, status: null, translate: null, research: false, regenerate: null, swap: null };
}

function hasPending(p) {
  return Object.keys(p.drafts).length > 0 || p.feedback != null || p.status != null || p.translate != null ||
    p.research || p.regenerate != null || p.swap != null;
}

function markDirty(id) {
  const was = state.dirty.has(id);
  state.dirty.add(id);
  if (!was) {
    fillHead(id);
    renderActions(id);
  }
}

// 최신 파일에 바뀐 필드만 덮어써서, 그 사이 라우틴이 고친 다른 필드를 지우지 않는다.
function applyPending(fresh, base, p, now) {
  const d = structuredClone(fresh);
  for (const [i, body] of Object.entries(p.drafts)) {
    const orig = base.drafts?.[i];
    if (!orig) continue;
    let t = d.drafts?.[i];
    if (!t || t.kind !== orig.kind || t.lang !== orig.lang) {
      t = d.drafts?.find((x) => x.kind === orig.kind && x.lang === orig.lang);
    }
    if (!t || t.body === body) continue;
    t.body = body;
    t.edited = true;
    t.edited_at = now;
  }
  if (p.feedback) d.feedback = { ...(d.feedback || {}), ...p.feedback };
  if (p.status) {
    d.status = p.status;
    if (p.status === 'replied' && !d.replied_at) d.replied_at = now;
    if (p.status !== 'replied') d.replied_at = null;
  }
  if (p.translate) d.translate_request = { kind: p.translate, requested_at: now };
  if (p.research) d.research_request = { requested_at: now };
  if (p.regenerate) d.regenerate_request = { ...p.regenerate, requested_at: now };
  if (p.swap) {
    for (const t of d.drafts || []) {
      if (t.kind !== p.swap || t.previous_body == null) continue;
      [t.body, t.previous_body] = [t.previous_body, t.body];
      t.edited = true;
      t.edited_at = now;
    }
  }
  return d;
}

function commitMessage(id, p, data) {
  const what = [];
  if (Object.keys(p.drafts).length) what.push('초안 수정');
  if (p.feedback) what.push('판정 평가');
  if (p.status) what.push(`상태 ${p.status}`);
  if (p.translate) what.push('영문 번역 요청');
  if (p.research) what.push('더 조사 요청');
  if (p.regenerate) what.push('초안 다시 쓰기 요청');
  if (p.swap) what.push('이전 초안으로');
  return `site: ${data.brand?.name || id} ${what.join(', ')}`.trim();
}

// 저장이 끝까지 됐으면 true. quiet이면 성공 토스트를 띄우지 않는다. (부른 쪽이 따로 알림)
async function save(id, { quiet = false } = {}) {
  const entry = state.mails[id];
  if (entry.saving || !hasPending(entry.pending)) return false;
  const snap = entry.pending;
  entry.pending = emptyPending();
  entry.saving = true;
  let ok = false;
  renderActions(id);
  renderRegen(id);
  syncCheck(id);
  try {
    for (let attempt = 0; ; attempt++) {
      const fresh = await readJson(entry.path);
      const next = applyPending(fresh.data, entry.data, snap, nowKst());
      try {
        entry.sha = await writeJson(entry.path, next, fresh.sha, commitMessage(id, snap, next));
        entry.data = next;
        break;
      } catch (e) {
        if (e.status === 409 && attempt === 0) continue;
        throw e;
      }
    }
    ok = true;
    if (!quiet) toast('저장했어요');
  } catch (e) {
    const cur = entry.pending;
    entry.pending = {
      drafts: { ...snap.drafts, ...cur.drafts },
      feedback: cur.feedback ?? snap.feedback,
      status: cur.status ?? snap.status,
      // 번역·조사·다시 쓰기 요청은 실패하면 다시 누르게 한다
      translate: null,
      research: false,
      regenerate: null,
      swap: null,
    };
    toast(`저장 실패: ${errMsg(e)}`, true);
  } finally {
    entry.saving = false;
    if (hasPending(entry.pending)) state.dirty.add(id);
    else state.dirty.delete(id);
    entry.el.className = cardClass(entry.data) + (entry.detail && !entry.detail.hidden ? ' open' : '');
    fillHead(id);
    renderActions(id);
    renderRegen(id);
    syncCheck(id);
  }
  return ok;
}

window.addEventListener('beforeunload', (e) => {
  if (state.dirty.size || profileDirty()) {
    e.preventDefault();
    e.returnValue = '';
  }
});

window.addEventListener('hashchange', () => {
  const want = decodeURIComponent(location.hash.slice(1));
  if (state.token && want !== state.date && state.dates.includes(want)) go(want);
});

boot();
