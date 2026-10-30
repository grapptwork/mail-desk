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

const FILTER_KEY = 'maildesk.filter2';

// 폰에서는 브라우저가 다른 구글 계정이라 Gmail 웹 링크가 안 열린다. 대신 Gmail 앱 작성 화면을 연다.
const UA = navigator.userAgent || '';

const IS_IOS = /iPhone|iPad|iPod/i.test(UA) || (/Macintosh/.test(UA) && navigator.maxTouchPoints > 1);

const IS_ANDROID = /Android/i.test(UA);

const IS_MOBILE = IS_IOS || IS_ANDROID;

const VERDICT_LABEL = { green: '초록', yellow: '노랑', red: '빨강' };

const VERDICT_NAME = { green: '초록', yellow: '노랑', red: '빨강' };

const STATUS = { new: '새 메일', reviewed: '검토함', replied: '답장함', archived: '보관' };

const CATEGORY_LABEL = { collab_followup: '후속', collab_duplicate: '중복', personal: '개인 메일' };

const KIND = { default: '초안', positive: '수락', adjust: '조율', decline: '거절', ask: '확인 질문', followup: '후속' };

// 답장 방향 버튼 type → 이름, 초안 kind
const DIR_TYPE = { accept: '수락', adjust: '조율', decline: '거절', ask: '확인' };

const DIR_KIND = { accept: 'positive', adjust: 'adjust', decline: 'decline', ask: 'ask' };

const COLLAB = { single: '단건', multi: '다건', long_term: '장기', unknown: '미정' };

const COMPANY_TYPE = { agency: '대행사', brand: '브랜드 직접', unknown: '미확인' };

const state = {
  token: null,
  dates: [],
  date: null,
  digest: null,
  mails: {},      // id -> { path, data, sha, pending, saving, el(목록 행), detail(상세), ... }
  order: [],
  dirty: new Set(),
  db: null,       // Promise<{services, companies}>
  filter: lsGet(FILTER_KEY) || 'todo',
  query: '',
  sel: null,      // 보고 있는 메일 id
  ui: {},         // 화면 틀의 고정 요소들
  profile: { data: null, sha: null, loaded: false, saving: false, error: null, el: null },
};

// 폰 폭이면 목록·상세를 한 장씩 보여준다.
const MQ = matchMedia('(max-width: 900px)');
const isNarrow = () => MQ.matches;

// 선 아이콘. index.html 안의 SVG 묶음(#i-…)을 가져다 쓴다.
const SVG_NS = 'http://www.w3.org/2000/svg';
function icon(name, cls) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', `i${cls ? ` ${cls}` : ''}`);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

const dot = (v) => h('span', { class: `vd ${v}` });

// 이름 → 두 글자 이니셜. CapCut → CC, Abacus AI → AA, 한글은 첫 글자.
function initials(name) {
  const s = String(name || '?').replace(/\(.*?\)/g, '').trim();
  if (!s) return '?';
  if (/^[가-힣]/.test(s)) return s[0];
  const words = s.split(/[\s._-]+/).filter(Boolean);
  if (words.length > 1) return (words[0][0] + words[1][0]).toUpperCase();
  const caps = s.match(/[A-Z]/g);
  if (caps && caps.length >= 2) return caps.slice(0, 2).join('');
  return s.slice(0, 2).toUpperCase();
}

const AV_TONES = 5;
function avatar(name, cls) {
  let n = 0;
  for (const c of String(name || '')) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  return h('span', { class: `av t${n % AV_TONES}${cls ? ` ${cls}` : ''}` }, initials(name));
}

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
  if (state.ui.rows) state.ui.rows.replaceChildren(h('p', { class: 'empty' }, `${dateLabel(date)} 불러오는 중…`));
  else document.getElementById('app').replaceChildren(h('p', { class: 'muted center' }, '불러오는 중…'));
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
  state.sel = null;
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
      h('div', { class: 'logo' }, h('span', { class: 'mark' }, icon('send')), '협업메일'),
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

// ---------- 화면 틀 ----------
// PC: 사이드바 · 목록 · 상세 3단. 폰: 목록 → 상세 한 장씩 (상세는 ← 로 돌아감).

function render() {
  const ui = state.ui;
  ui.search = h('input', {
    type: 'search', class: 'search-input', placeholder: '브랜드·발신인 검색', value: state.query,
    oninput: (e) => { state.query = e.target.value; renderList(); },
  });
  ui.nav = h('nav', { class: 'nav-list' });
  ui.chips = h('div', { class: 'chips' });
  ui.rows = h('div', { class: 'rows' });
  ui.pane = h('section', { class: 'detail' });
  ui.pfCard = h('button', { type: 'button', class: 'pf-card', onclick: openProfile });
  ui.pfStrip = h('button', { type: 'button', class: 'status-strip', onclick: openProfile });
  ui.mbar = mobileBar();

  const dateSelect = h('select', { class: 'date-select', 'aria-label': '날짜', onchange: (e) => go(e.target.value) },
    state.dates.map((d) => h('option', { value: d, selected: d === state.date }, dateLabel(d))));

  ui.shell = h('div', { class: 'shell' },
    h('header', { class: 'topbar' },
      h('button', { type: 'button', class: 'back', onclick: () => closeDetail() }, icon('left'), '목록'),
      h('div', { class: 'logo' }, h('span', { class: 'mark' }, icon('send')), '협업메일'),
      h('label', { class: 'search' }, icon('search'), ui.search),
      h('div', { class: 'top-right' },
        dateSelect,
        h('button', { type: 'button', class: 'icon-btn', title: '광고 기간 계산', onclick: openAdPeriod }, icon('cal')),
        h('button', { type: 'button', class: 'icon-btn', title: '새로고침', onclick: () => go(state.date) }, icon('refresh')),
        h('button', { type: 'button', class: 'icon-btn', title: '토큰 다시 넣기', onclick: resetToken }, icon('gear')),
        h('div', { class: 'me' }, h('span', { class: 'av me-av' }, '정'),
          h('div', null, h('b', null, '정원'), h('small', null, GMAIL_ACCOUNT))),
      ),
    ),
    h('aside', { class: 'side' },
      h('button', { type: 'button', class: 'cta', onclick: openProfile }, icon('chart'), '채널 현황'),
      ui.pfCard,
      ui.nav,
      h('h4', null, '날짜'),
      h('div', { class: 'dates' }, state.dates.map((d) => h('button', {
        type: 'button', class: `date-row${d === state.date ? ' on' : ''}`, onclick: () => go(d),
      }, icon('cal'), dateLabel(d)))),
      digestNotes(),
    ),
    h('section', { class: 'list' }, ui.pfStrip, ui.chips, ui.rows),
    ui.pane,
    ui.mbar.el,
  );
  document.getElementById('app').replaceChildren(ui.shell);
  renderPfCard();
  renderList();
  // PC는 첫 메일을 바로 연다.
  if (!state.sel && !isNarrow()) {
    const first = visibleIds()[0];
    if (first) selectMail(first, { quiet: true });
  } else if (state.sel) {
    selectMail(state.sel, { quiet: true });
  } else {
    renderDetailPane();
  }
}

function dateLabel(d) {
  return `${Number(d.slice(5, 7))}월 ${Number(d.slice(8, 10))}일`;
}

function digestNotes() {
  const notes = state.digest?.notes || [];
  if (!notes.length) return null;
  return h('details', { class: 'side-notes' },
    h('summary', null, `라우틴 메모 ${notes.length}`),
    h('ul', null, notes.map((n) => h('li', null, n))));
}

// ---------- 채널 현황 ----------
// 정원이 적어 두는 최신 정보. 매일 아침 라우틴과 「초안 다시 쓰기」 작업이 읽는다.
// 모든 칸은 선택이다. 비워 두면 CLAUDE.md의 기준값·기존 규칙대로 쓴다.
// PC는 사이드바 요약 카드, 폰은 목록 위 한 줄. 누르면 편집 창이 열린다.

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
  renderPfCard();
  refreshStale();
}

// 편집 창 내용은 한 번만 만들어 재사용한다. 날짜를 바꿔도 쓰던 값이 사라지지 않게.
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
  f.active_brands = h('input', { type: 'text', class: 'input', placeholder: '예: 캡컷 (11/18까지)', disabled: true });
  rows.push(['진행 중 브랜드', f.active_brands, null]);
  f.memo = h('textarea', {
    class: 'input memo-input',
    rows: '2',
    disabled: true,
    placeholder: '예: 아주 유명한 브랜드면 일정이 빠듯해도 긍정적으로 검토',
  });
  f.memo.addEventListener('input', () => autosize(f.memo));
  rows.push(['메모', f.memo, null]);
  for (const el of Object.values(f)) el.addEventListener('input', onInput);

  pf.btn = h('button', { type: 'button', class: 'btn primary', onclick: saveProfile });
  pf.info = h('span', { class: 'muted' });
  pf.summary = h('span');
  pf.el = h('div', { class: 'pf-edit' },
    h('p', { class: 'muted small' }, '전부 선택이에요. 비워 두면 기존 기준대로 답해요. 매일 아침 판정·초안과 「초안 다시 쓰기」에 반영돼요.'),
    h('div', { class: 'pf-grid' }, rows.map(([label, input, hint]) =>
      h('label', { class: 'pf-row' }, h('span', { class: 'pf-label' }, label), input, hint))),
    h('div', { class: 'row-end' }, pf.info, pf.btn));
  if (pf.loaded) fillProfile();
  else syncProfile();
  return pf.el;
}

function openProfile() {
  const ui = state.ui;
  if (!ui.modal) {
    ui.modal = h('div', { class: 'modal-bg', hidden: true, onclick: (e) => { if (e.target === ui.modal) closeProfile(); } },
      h('div', { class: 'modal', role: 'dialog', 'aria-label': '채널 현황' },
        h('div', { class: 'modal-head' }, h('h3', null, '채널 현황'),
          h('button', { type: 'button', class: 'icon-btn', title: '닫기', onclick: closeProfile }, icon('x'))),
        profileBox()));
    document.body.append(ui.modal);
  }
  ui.modal.hidden = false;
  requestAnimationFrame(() => autosize(state.profile.inputs.memo));
}

function closeProfile() {
  if (state.ui.modal) state.ui.modal.hidden = true;
}

// ---------- 광고 기간 계산 ----------
// CLAUDE.md 규칙: 업로드 시각 + 기간(일)×24시간이 되는 날의 한국시간 24:00까지.
// 24시간 단위로 더하면 시각은 그대로라, 업로드 날짜 + 기간(일)의 24:00이 된다.

const WEEKDAY = '일월화수목금토';

function openAdPeriod() {
  const ui = state.ui;
  if (!ui.adModal) {
    const start = h('input', { type: 'date', class: 'input', value: today() });
    const days = h('input', { type: 'number', class: 'input', min: '1', step: '1', value: '90', inputmode: 'numeric' });
    const out = h('b', { class: 'ad-out' });
    let line = '';
    const copyBtn = h('button', { type: 'button', class: 'btn primary', onclick: () => line && copyText(line) }, icon('copy'), '문구 복사');
    const calc = () => {
      const n = Number(days.value);
      if (!start.value || !Number.isInteger(n) || n < 1) {
        out.textContent = '업로드일과 기간을 넣어주세요';
        line = '';
        copyBtn.disabled = true;
        return;
      }
      const [y, m, d] = start.value.split('-').map(Number);
      const end = new Date(Date.UTC(y, m - 1, d + n));
      const ymd = (dt) => dt.toISOString().slice(0, 10).replaceAll('-', '.');
      out.textContent = `${ymd(end)}(${WEEKDAY[end.getUTCDay()]}) 24:00까지 (KST)`;
      line = `AD Code 유효기간 : ${start.value.replaceAll('-', '.')} ~ ${ymd(end)} 24:00 (KST, 게시일 기준 ${n}일)`;
      copyBtn.disabled = false;
    };
    start.addEventListener('input', calc);
    days.addEventListener('input', calc);
    calc();
    ui.adModal = h('div', { class: 'modal-bg', hidden: true, onclick: (e) => { if (e.target === ui.adModal) closeAdPeriod(); } },
      h('div', { class: 'modal', role: 'dialog', 'aria-label': '광고 기간 계산' },
        h('div', { class: 'modal-head' }, h('h3', null, '광고 기간 계산'),
          h('button', { type: 'button', class: 'icon-btn', title: '닫기', onclick: closeAdPeriod }, icon('x'))),
        h('p', { class: 'muted small' }, '업로드일 + 기간(일)이 되는 날의 한국시간 24:00까지예요.'),
        h('div', { class: 'pf-grid' },
          h('label', { class: 'pf-row' }, h('span', { class: 'pf-label' }, '업로드일'), start),
          h('label', { class: 'pf-row' }, h('span', { class: 'pf-label' }, '기간(일)'), days)),
        h('div', { class: 'row-end' }, out, copyBtn)));
    document.body.append(ui.adModal);
  }
  ui.adModal.hidden = false;
}

function closeAdPeriod() {
  if (state.ui.adModal) state.ui.adModal.hidden = true;
}

// 사이드바 카드(PC)와 목록 위 한 줄(폰)
function renderPfCard() {
  const { pfCard, pfStrip } = state.ui;
  if (!pfCard) return;
  const d = state.profile.data || {};
  const fol = pfVal(d, 'followers');
  const folChecked = d.followers?.checked;
  const from = d.available_from && d.available_from >= today() ? d.available_from : null;
  const md = (s) => `${Number(s.slice(5, 7))}/${Number(s.slice(8, 10))}`;
  const stale = folChecked && daysSince(folChecked) > STALE_DAYS;

  const rows = [];
  if (fol) rows.push(h('div', { class: 'pf' }, h('span', null, '팔로워'), h('b', null, fol),
    h('small', { class: stale ? 'warn-text' : null }, folChecked ? `${md(folChecked)} 확인${stale ? ' · 오래됨' : ''}` : '')));
  if (from || d.schedule_note) rows.push(h('div', { class: 'pf' }, h('span', null, '광고 가능'),
    h('b', null, from ? `${md(from)}~` : '-'), h('small', null, d.schedule_note || '')));
  if (d.active_brands) rows.push(h('div', { class: 'pf' }, h('span', null, '진행 중'), h('small', { class: 'pf-memo' }, d.active_brands)));
  if (d.memo) rows.push(h('div', { class: 'pf' }, h('span', null, '메모'), h('small', { class: 'pf-memo' }, d.memo)));
  if (!state.profile.loaded) rows.push(h('p', { class: 'muted small' }, '불러오는 중…'));
  else if (!rows.length) rows.push(h('p', { class: 'muted small' }, '비어 있어요 · 기존 기준대로 답해요'));
  pfCard.replaceChildren(...rows);

  const parts = [
    fol && h('b', null, `팔로워 ${fol}`),
    folChecked && fol && `${md(folChecked)} 확인`,
    from && `광고 가능 ${md(from)}~`,
    d.schedule_note && '일정 메모',
    d.active_brands && `진행 중 ${d.active_brands.split(/[,(（]/)[0].trim()}`,
    d.memo && '메모',
  ].filter(Boolean);
  pfStrip.replaceChildren(icon('chart'),
    h('span', { class: 'strip-text' }, ...(parts.length ? parts.flatMap((p, i) => (i ? [' · ', p] : [p])) : ['채널 현황 · 비어 있음'])),
    icon('chev', 'chev'));
}

const pfVal = (d, key) => (METRICS.some(([k]) => k === key) ? d?.[key]?.value : d?.[key]) || '';

function fillProfile() {
  const pf = state.profile;
  if (!pf.inputs) return;
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
  renderPfCard();
  if (!pf.btn) return;
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
    pf.hints[key].textContent = old == null ? '' : `${m.checked.slice(5).replace('-', '/')} 확인${old > STALE_DAYS ? ` · ${old}일 지남 (기존 규칙대로 다시 확인)` : ''}`;
    pf.hints[key].classList.toggle('warn-text', old > STALE_DAYS);
  }
  const from = pf.inputs.available_from.value;
  pf.hints.available_from.textContent = from && from < today() ? '지난 날짜라 무시돼요' : '';
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
  data.active_brands = f.active_brands.value.trim();
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

// ---------- 필터 · 목록 ----------

const FILTERS = [
  ['todo', '처리 전', 'inbox'],
  ['urgent', '급함', 'alarm'],
  ['green', '초록', null],
  ['yellow', '노랑', null],
  ['red', '빨강', null],
  ['followup', '후속', 'reply'],
  ['duplicate', '중복', 'dup'],
  ['done', '답장함', 'check'],
  ['all', '전체', 'list'],
];

// 답장함·전체가 아니면 처리 전 메일만 본다.
function matchesFilter(m, f) {
  const done = isDone(m.status);
  if (f === 'all') return true;
  if (f === 'done') return done;
  if (done) return false;
  switch (f) {
    case 'todo': return true;
    case 'urgent': return !!m.urgent;
    case 'green': case 'yellow': case 'red': return m.verdict === f;
    case 'followup': return m.category === 'collab_followup';
    case 'duplicate': return m.category === 'collab_duplicate';
    default: return true;
  }
}

function matchesQuery(m) {
  const q = state.query.trim().toLowerCase();
  if (!q) return true;
  return [m.brand?.name, m.from?.name, m.from?.email, m.company?.name, m.subject]
    .some((x) => x && String(x).toLowerCase().includes(q));
}

function visibleIds() {
  return state.order.filter((id) => {
    const m = state.mails[id].data;
    return matchesFilter(m, state.filter) && matchesQuery(m);
  });
}

function setFilter(f) {
  state.filter = f;
  lsSet(FILTER_KEY, f);
  renderList();
}

function renderNav() {
  const { nav, chips } = state.ui;
  if (!nav) return;
  const all = state.order.map((id) => state.mails[id].data);
  const count = (f) => all.filter((m) => matchesFilter(m, f)).length;
  const lead = (f, ic) => (ic ? icon(ic) : dot(f));
  nav.replaceChildren(...FILTERS.map(([f, label, ic]) => {
    const n = count(f);
    return h('button', { type: 'button', class: `nav${state.filter === f ? ' on' : ''}`, onclick: () => setFilter(f) },
      lead(f, ic), label, n || f === 'todo' ? h('span', { class: 'n' }, n) : null);
  }));
  // 폰 칩: 0건인 칸은 숨긴다 (처리 전·답장함은 늘 보임)
  chips.replaceChildren(...FILTERS.filter(([f]) => f === 'todo' || f === 'done' || f === state.filter || count(f))
    .map(([f, label, ic]) => {
      const n = count(f);
      return h('button', { type: 'button', class: `chip${state.filter === f ? ' on' : ''}`, onclick: () => setFilter(f) },
        ic ? null : dot(f), label, f === 'done' ? null : h('span', { class: 'n' }, n));
    }));
}

function renderList() {
  renderNav();
  const ids = visibleIds();
  const { rows } = state.ui;
  if (!ids.length) {
    rows.replaceChildren(h('p', { class: 'empty' },
      state.query ? '검색 결과가 없어요' : state.filter === 'todo' ? '처리할 메일이 없어요' : '메일이 없어요'));
    return;
  }
  rows.replaceChildren(...ids.map((id) => getRow(id)));
}

// 목록 행 DOM은 날짜를 바꿀 때까지 재사용한다.
function getRow(id) {
  const entry = state.mails[id];
  if (entry.el) return entry.el;
  const row = h('div', { class: 'row', id: `m-${id}`, role: 'button', tabindex: '0' });
  row.addEventListener('click', (e) => {
    if (e.target.closest('.done')) return;
    selectMail(id);
  });
  row.addEventListener('keydown', (e) => { if (e.key === 'Enter') selectMail(id); });
  entry.check = h('button', { type: 'button', class: 'done', title: '답장 완료', 'aria-label': '답장 완료' }, icon('tick'));
  entry.check.addEventListener('click', () => toggleDone(id, !isDone(curStatus(entry))));
  entry.el = row;
  fillHead(id);
  return row;
}

function snippet(id, m) {
  let s = state.digest?.lines?.[id] || '';
  s = s.replace(/^[^\p{L}\p{N}]+/u, '').replace(/^(후속|중복)\s+/, '');
  const b = m.brand?.name;
  if (b && s.startsWith(b)) s = s.slice(b.length).replace(/^\([^)]*\)/, '');
  s = s.replace(/^\s*[·:,-]?\s*/, '').replace(/[,·]?\s*(한국어 |영문 )?초안 있음$/, '').trim();
  return s || m.subject || '';
}

function draftTag(m) {
  const ds = m.drafts || [];
  if (!ds.length) {
    if (m.regenerate_request && !m.regenerate_request.error) return null;
    return m.directions?.options?.length && !isDone(m.status) ? '방향 고르기' : null;
  }
  const kinds = new Set(ds.map((d) => d.kind));
  if (kinds.has('followup')) return '후속 초안';
  if (kinds.has('positive') && kinds.has('decline')) return '초안 수락·거절';
  const k = ds[0].kind;
  const name = k && k !== 'default' && KIND[k] ? `${KIND[k]} 초안` : '초안';
  return new Set(ds.map((d) => d.lang)).size > 1 ? `${name} KO·EN` : name;
}

const md = (iso) => (iso ? `${iso.slice(5, 7)}/${iso.slice(8, 10)}` : '');

function gmailUrl(m) {
  return `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(GMAIL_ACCOUNT)}#all/${m.thread_id || m.id}`;
}

// Gmail 앱 작성 화면. iOS는 googlegmail:///co, 안드로이드는 Gmail 앱을 지정한 mailto 인텐트.
// 앱에서는 보내는 계정을 고를 수 없어서(from 미지원) 앱에 선택된 계정으로 열린다.
function composeUrl(to, subject, body) {
  const q = (o) => Object.entries(o).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  if (IS_IOS) return `googlegmail:///co?${q({ to, subject, body })}`;
  if (IS_ANDROID) return `intent:${encodeURIComponent(to || '')}?${q({ subject, body })}#Intent;scheme=mailto;package=com.google.android.gm;end`;
  // PC: 회사 계정 Gmail 웹 작성 창
  return `https://mail.google.com/mail/?authuser=${encodeURIComponent(GMAIL_ACCOUNT)}&view=cm&fs=1&${q({ to, su: subject, body })}`;
}

// 받은 날 앞뒤 하루로 좁힌 검색어. 시간대 차이로 빠지지 않게 하루씩 여유를 둔다.
function gmailQuery(m) {
  const parts = [];
  if (m.from?.email) parts.push(`from:${m.from.email}`);
  const t = Date.parse(m.received_at);
  if (!Number.isNaN(t)) {
    const day = (ms) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '/');
    parts.push(`after:${day(t - 864e5)}`, `before:${day(t + 2 * 864e5)}`);
  }
  return parts.length ? parts.join(' ') : m.subject || '';
}

// 아이폰 Gmail 앱은 특정 메일을 바로 여는 공식 링크가 없다. googlegmail:///cv= 방식은 2026-10-28 정원 폰에서 시험해 보니 받은편지함만 열림.
// 그래서 검색어(from:보낸사람)를 복사해 두고 앱을 연다. 앱 검색창에 붙여넣으면 그 사람 메일만 나온다.
// 안드로이드는 mail.google.com 링크를 Gmail 앱이 받아서 일반 링크 그대로 둔다.
function openInGmailApp(m) {
  const q = gmailQuery(m);
  // 탭한 순간 안에 복사와 앱 열기를 같이 해야 사파리가 막지 않는다.
  navigator.clipboard?.writeText(q).catch(() => {});
  toast(`검색어 복사됨 · Gmail 검색창에 붙여넣으세요 (${q})`);
  location.href = 'googlegmail://';
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
  const url = composeUrl(m.from?.email, replySubject(m, dr), body);
  if (IS_MOBILE) location.href = url;
  else window.open(url, '_blank', 'noopener');
}

// 카드의 「답장」 버튼 (폰). 초안이 한 종류면 바로 작성 화면, 수락·거절처럼 여러 종류면 초안 탭으로 보낸다.
function replyInApp(id) {
  const entry = state.mails[id];
  const kinds = new Set((entry.data.drafts || []).map((dr) => dr.kind));
  if (kinds.size > 1) {
    openCard(id);
    entry.detail?.querySelector('.drafts')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    toast('보낼 초안 탭을 고른 뒤 「Gmail 앱」을 눌러 주세요');
    return;
  }
  openCompose(id, sendIndex(entry.data));
}

const isDone = (status) => status === 'replied' || status === 'archived';
const curStatus = (entry) => entry.pending.status || entry.data.status;

function syncCheck(id) {
  const entry = state.mails[id];
  const done = isDone(curStatus(entry));
  for (const b of [entry.check, entry.dDone]) {
    if (!b) continue;
    b.classList.toggle('is-done', done);
    b.disabled = entry.saving;
    b.title = done ? '처리 전으로 되돌리기' : '답장 완료';
  }
  if (state.sel === id) syncMobileBar();
}

// 체크하면 답장함으로 바꾸고, 처리 전 보기에서는 목록에서 뺀다. 되돌리기는 이전 상태로.
async function toggleDone(id, done) {
  const entry = state.mails[id];
  if (entry.saving) return;
  const before = curStatus(entry);
  entry.pending.status = done ? 'replied' : (isDone(entry.undoStatus) ? 'new' : entry.undoStatus || 'new');
  if (done) entry.undoStatus = before;
  entry.el?.classList.toggle('is-done', done);
  const ok = await save(id, { quiet: true });
  if (!ok) {
    entry.pending.status = null;
    if (!hasPending(entry.pending)) state.dirty.delete(id);
    fillHead(id);
    renderActions(id);
    syncCheck(id);
    return;
  }
  if (!done) {
    toast('처리 전으로 돌렸어요');
    renderList();
    return;
  }
  const undo = { label: '되돌리기', fn: () => toggleDone(id, false) };
  if (matchesFilter(entry.data, state.filter)) {
    renderNav();
    toast('답장 완료로 표시했어요', false, undo);
    return;
  }
  entry.el?.classList.add('leaving');
  setTimeout(() => {
    entry.el?.classList.remove('leaving');
    renderList();
  }, 250);
  toast('답장 완료 · 목록에서 뺐어요', false, undo);
}

function rowClass(id) {
  const m = state.mails[id].data;
  const cls = ['row'];
  if (state.sel === id) cls.push('on');
  if (m.category === 'collab_duplicate') cls.push('dim');
  if (isDone(m.status)) cls.push('is-done');
  return cls.join(' ');
}

function fillHead(id) {
  const entry = state.mails[id];
  const m = entry.data;
  if (!entry.el) return;
  const title = m.brand?.name || m.from?.name || m.subject || id;
  const lead = m.category === 'collab_followup' ? icon('reply', 'lead')
    : m.category === 'collab_duplicate' ? icon('dup', 'lead')
      : m.verdict ? dot(m.verdict) : null;
  const ask = m.analysis?.needs_user_input?.length || 0;
  const deadline = m.deadline?.date;
  const tags = [
    m.urgent || deadline ? h('span', { class: 'tag urgent' }, icon('alarm'), deadline ? `${md(deadline)}까지` : '급함') : null,
    m.category === 'personal' ? h('span', { class: 'tag' }, '개인 메일') : null,
    draftTag(m) ? h('span', { class: 'tag' }, draftTag(m)) : null,
    ask ? h('span', { class: 'tag ask' }, `확인필요 ${ask}`) : null,
    m.from_spam ? h('span', { class: 'tag' }, '스팸함') : null,
    (m.drafts || []).some((d) => d.edited) ? h('span', { class: 'tag' }, '수정함') : null,
    m.translate_request && !m.translate_request.error ? h('span', { class: 'tag busy' }, '번역 중') : null,
    m.regenerate_request && !m.regenerate_request.error ? h('span', { class: 'tag busy' }, '다시 쓰는 중') : null,
    m.research_request && !m.research_request.error ? h('span', { class: 'tag busy' }, '조사 중') : null,
    state.dirty.has(id) ? h('span', { class: 'tag ask' }, '저장 안 됨') : null,
  ].filter(Boolean);

  entry.el.className = rowClass(id);
  entry.el.replaceChildren(
    avatar(title),
    h('div', { class: 't' }, lead, h('span', { class: 'name' }, title)),
    h('span', { class: 'time' }, md(m.received_at)),
    h('div', { class: 'who' },
      m.from?.name || m.from?.email ? [icon('user'), h('span', null, m.from?.name || m.from?.email)] : null,
      m.company?.name ? [h('span', { class: 'sep' }, '·'), icon('bldg'), h('span', null, m.company.name)] : null),
    h('div', { class: 'snip' }, snippet(id, m)),
    h('div', { class: 'tags' }, tags),
    entry.check,
  );
  syncCheck(id);
}

// ---------- 상세 ----------

function selectMail(id, { quiet = false } = {}) {
  const prev = state.sel;
  state.sel = id;
  if (prev && prev !== id && state.mails[prev]?.el) state.mails[prev].el.className = rowClass(prev);
  const entry = state.mails[id];
  if (!entry) return;
  if (entry.el) entry.el.className = rowClass(id);
  renderDetailPane();
  if (isNarrow() && !quiet) {
    if (!state.ui.shell.classList.contains('show-detail')) history.pushState({ detail: id }, '', location.hash);
    state.ui.shell.classList.add('show-detail');
    window.scrollTo(0, 0);
  }
  state.ui.pane.scrollTop = 0;
}

function closeDetail(fromPop) {
  if (!state.ui.shell?.classList.contains('show-detail')) return;
  state.ui.shell.classList.remove('show-detail');
  if (!fromPop && history.state?.detail) history.back();
  const el = state.sel && state.mails[state.sel]?.el;
  if (el) requestAnimationFrame(() => el.scrollIntoView({ block: 'center' }));
}

function renderDetailPane() {
  const { pane } = state.ui;
  const entry = state.sel && state.mails[state.sel];
  if (!entry) {
    pane.replaceChildren(h('div', { class: 'pane-empty' }, icon('inbox'), h('p', null, '메일을 골라 주세요')));
    syncMobileBar();
    return;
  }
  if (!entry.detail) entry.detail = buildDetail(state.sel);
  pane.replaceChildren(entry.detail);
  syncFolds();
  syncMobileBar();
  requestAnimationFrame(() => entry.detail.querySelectorAll('textarea.draft').forEach(autosize));
}

function openCard(id) {
  if (!state.mails[id]) return false;
  if (!visibleIds().includes(id)) setFilter('all');
  selectMail(id);
  state.mails[id].el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  return true;
}

// PC는 메일 내용을 펼쳐 두고, 폰은 접어 둔다.
function syncFolds() {
  const entry = state.sel && state.mails[state.sel];
  const fold = entry?.detail?.querySelector('details.mailfold');
  if (fold && !fold.dataset.touched) fold.open = !isNarrow();
}
MQ.addEventListener('change', () => {
  syncFolds();
  if (!isNarrow()) state.ui.shell?.classList.remove('show-detail');
});

// ---------- 폰 하단 바 ----------

function mobileBar() {
  const bar = {};
  bar.copy = h('button', { type: 'button', class: 'btn primary' }, icon('copy'), '본문 복사');
  bar.gmail = h('button', { type: 'button', class: 'btn' }, icon('send'), 'Gmail 앱');
  bar.done = h('button', { type: 'button', class: 'btn sq', title: '답장 완료' }, icon('tick'));
  bar.copy.addEventListener('click', () => {
    const entry = state.mails[state.sel];
    const ta = entry?.draftInputs?.[entry.tab];
    if (ta) copyText(ta.value);
  });
  bar.gmail.addEventListener('click', () => {
    const entry = state.mails[state.sel];
    if (!entry) return;
    const m = entry.data;
    const review = m.lang !== 'ko' && m.drafts?.[entry.tab]?.lang === 'ko';
    const i = review ? m.drafts.findIndex((d) => d.kind === m.drafts[entry.tab].kind && d.lang === 'en') : entry.tab;
    openCompose(state.sel, i ?? sendIndex(m));
  });
  bar.done.addEventListener('click', () => {
    const entry = state.mails[state.sel];
    if (entry) toggleDone(state.sel, !isDone(curStatus(entry)));
  });
  bar.el = h('div', { class: 'mbar' }, bar.copy, bar.gmail, bar.done);
  state.ui.bar = bar;
  return bar;
}

function syncMobileBar() {
  const bar = state.ui.bar;
  if (!bar) return;
  const entry = state.sel && state.mails[state.sel];
  const hasDraft = !!entry?.data.drafts?.length;
  bar.copy.disabled = !hasDraft;
  bar.gmail.disabled = !entry;
  const done = entry ? isDone(curStatus(entry)) : false;
  bar.done.classList.toggle('is-done', done);
  bar.done.disabled = !entry || entry.saving;
}

function section(title, content, { open = false, cls = '' } = {}) {
  return h('details', { class: `sec ${cls}`, open }, h('summary', null, title, icon('chev', 'chev')), content);
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
  const entry = state.mails[id];
  const m = entry.data;
  const a = m.analysis || {};
  const lang = m.lang && m.lang !== 'ko' ? 'en' : null;

  entry.dDone = h('button', { type: 'button', class: 'icon-btn done-btn', title: '답장 완료' }, icon('tick'));
  entry.dDone.addEventListener('click', () => toggleDone(id, !isDone(curStatus(entry))));
  const gmail = IS_IOS
    ? h('button', { type: 'button', class: 'icon-btn', title: 'Gmail 앱 열기 (검색어 복사)', onclick: () => openInGmailApp(m) }, icon('ext'))
    : h('a', { class: 'icon-btn', href: gmailUrl(m), target: '_blank', rel: 'noopener noreferrer', title: 'Gmail에서 열기' }, icon('ext'));

  const head = h('div', { class: 'd-head' },
    avatar(m.from?.name || m.from?.email),
    h('div', { class: 'd-from' },
      h('b', null, m.from?.name || m.from?.email || ''),
      h('small', null, [m.from?.email, m.company?.name].filter(Boolean).join(' · ')),
      h('small', { class: 'd-time' }, fmtTime(m.received_at))),
    h('span', { class: 'time' }, fmtTime(m.received_at)),
    h('div', { class: 'acts' }, gmail, entry.dDone));

  const badges = h('div', { class: 'badges' },
    m.verdict ? h('span', { class: `pill v-${m.verdict}` }, dot(m.verdict), VERDICT_LABEL[m.verdict]) : null,
    CATEGORY_LABEL[m.category] ? h('span', { class: 'pill' }, CATEGORY_LABEL[m.category]) : null,
    a.collab_type ? h('span', { class: 'pill plain' },
      `${COLLAB[a.collab_type] || a.collab_type}${a.content_count ? ` · ${a.content_count}편` : ''}`) : null,
    a.schedule ? h('span', { class: 'pill plain' }, a.schedule) : null,
    m.company?.type ? h('span', { class: 'pill plain' }, COMPANY_TYPE[m.company.type] || m.company.type) : null);

  const alerts = [];
  if (m.deadline) {
    alerts.push(h('div', { class: 'alert' }, icon('alarm'), h('div', null, h('b', null, `회신 기한 ${m.deadline.date}`),
      m.deadline.quote ? h('div', { class: 'quote', lang }, `“${m.deadline.quote}”`) : null)));
  }
  if (m.from_spam) alerts.push(h('div', { class: 'alert' }, '스팸함에서 찾은 메일이에요'));
  if (m.duplicate_of) {
    alerts.push(h('div', { class: 'note' }, '이전 메일과 같은 제안: ',
      state.mails[m.duplicate_of]
        ? h('button', { type: 'button', class: 'linkish', onclick: () => openCard(m.duplicate_of) },
          state.mails[m.duplicate_of].data.brand?.name || m.duplicate_of)
        : m.duplicate_of));
  }
  if (m.changes_from_previous) alerts.push(h('div', { class: 'note' }, `이전과 달라진 점: ${m.changes_from_previous}`));

  const ask = a.needs_user_input?.length
    ? h('div', { class: 'askbox' }, h('h3', null, '정원이 정해야 할 것'),
      h('ol', null, a.needs_user_input.map((x, i) => h('li', null, h('i', null, i + 1), h('span', null, txt(x))))))
    : null;

  // 메일 내용 및 분석: PC는 펼쳐 두고 제목줄을 숨긴다. 폰은 접힌 채 시작.
  const fold = h('details', { class: 'mailfold' },
    h('summary', null, '메일 내용 및 분석', icon('chev', 'chev')),
    h('div', { class: 'mail-body', lang }, m.body || '(내용 없음)'),
    a.questions?.length ? h('div', { class: 'block' }, h('h3', null, '상대 질문'), list(a.questions, true)) : null,
    kv([
      ['할인 요청', a.discount_request ? '있음' : null],
      ['2차 활용', a.secondary_use ? '언급 있음' : null],
      ['자동DM 질문', a.auto_dm_question ? '있음' : null],
    ]),
    a.risks?.length ? h('div', { class: 'block' }, h('h3', null, '유의점'), list(a.risks)) : null);
  fold.addEventListener('toggle', () => { if (isNarrow()) fold.dataset.touched = '1'; });

  const main = h('div', { class: 'd-main' },
    h('h2', { lang }, m.subject || '(제목 없음)'),
    badges, ...alerts, ask, fold);

  const d = h('div', { class: 'd-wrap' }, head, h('div', { class: 'd-grid' }, main, researchSection(id)));
  if (m.research_request && !m.research_request.error) watchResearch(id);
  const dirs = directionsView(id);
  if (dirs) d.append(dirs);
  if (m.drafts?.length) d.append(draftsView(id));
  d.append(actionsView(id), feedbackView(id));
  return d;
}

// 조사 결과: 판정 근거 → 서비스·발신 회사(각각 접었다 펴는 칸) → 더 조사
function researchSection(id) {
  const entry = state.mails[id];
  const m = entry.data;
  const hasDb = !!(m.brand?.service_id || m.company?.company_id);
  const reasons = m.verdict_reasons?.length
    ? h('div', { class: 'reasons' }, h('h4', null, '판정 근거'), list(m.verdict_reasons))
    : null;
  if (!hasDb && !reasons) return h('aside', { class: 'rail' });
  const views = h('div', { class: 'ents' }, hasDb ? h('p', { class: 'muted small' }, '불러오는 중…') : null);
  const btn = h('button', {
    type: 'button',
    class: 'btn sm ghost',
    title: '못 찾은 항목 위주로 조금 더 찾아요 (Sonnet, 검색 10회 이내)',
    onclick: () => startResearch(id),
  }, icon('search'), '더 조사');
  entry.rs = {
    views,
    btn,
    status: h('p', { class: 'tr-status', hidden: true }),
    note: h('div', { class: 'note', hidden: true }),
  };
  const rail = h('aside', { class: 'rail' },
    h('h3', null, '조사 결과'),
    reasons,
    entry.rs.note,
    views,
    hasDb ? h('div', { class: 'rail-foot' }, btn) : null,
    entry.rs.status);
  if (hasDb) fillResearch(id);
  renderResearch(id);
  return rail;
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
  } catch (e) {
    views.replaceChildren(h('p', { class: 'err small' }, `조사 DB를 못 불러왔어요: ${errMsg(e)}`));
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
function dbToggle(name, sub, hint, content) {
  return h('details', { class: 'ent' },
    h('summary', null,
      h('span', { class: 'ent-av' }, avatar(name), hint ? dot(hint) : null),
      h('div', { class: 'ent-text' }, h('b', null, name), h('small', null, sub)),
      icon('chev', 'chev')),
    h('div', { class: 'ent-body' }, content));
}

function serviceView(s, sid) {
  if (!s) return dbToggle(sid, '서비스 · 조사 기록 없음', null, h('p', { class: 'muted small' }, '조사 기록 없음'));
  const op = s.operator || {};
  const pa = s.parent || {};
  const rep = s.reputation || {};
  const short = (x) => String(x || '').replace(/\s*\(.*?\)\s*/g, ' ').trim();
  const sub = ['서비스', short(pa.name) || short(op.legal_name).split(/[.,]/)[0], s.china_linked ? `중국계 ${s.china_linked}` : null]
    .filter(Boolean).join(' · ');
  return dbToggle(s.name || sid, sub, s.verdict_hint,
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
    ]));
}

function companyView(c, cid) {
  if (!c) return dbToggle(cid, '발신 회사 · 조사 기록 없음', null, h('p', { class: 'muted small' }, '조사 기록 없음'));
  const rv = c.reviews || {};
  const sub = ['발신 회사', COMPANY_TYPE[c.type] && c.type !== 'unknown' ? COMPANY_TYPE[c.type] : null, c.country]
    .filter(Boolean).join(' · ');
  return dbToggle(c.name || cid, sub, c.verdict_hint,
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
    ]));
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
      dr.kind === 'default' ? '' : `${KIND[dr.kind] || dr.kind} · `, (dr.lang || '').toUpperCase(), review ? ' 검토용' : '', dr.edited ? ' · 수정함' : ''));

    const ta = h('textarea', { class: 'draft', spellcheck: 'false', lang: dr.lang === 'en' ? 'en' : null, value: dr.body || '' });
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
      }, icon('globe'), '영문에 반영')
      : null;

    panelEls.push(h('div', { class: 'panel', role: 'tabpanel' },
      dr.subject ? h('div', { class: 'subject' },
        h('span', { class: 'subj-label' }, '제목'), h('span', { class: 'subj-text', lang: dr.lang === 'en' ? 'en' : null }, dr.subject),
        h('button', { type: 'button', class: 'btn sm ghost', onclick: () => copyText(dr.subject) }, icon('copy'), '제목 복사')) : null,
      ta,
      warn,
      h('div', { class: 'd-acts' },
        h('button', { type: 'button', class: 'btn primary pc-only', onclick: () => copyText(ta.value) }, icon('copy'), '본문 복사'),
        review ? null : h('button', {
          type: 'button', class: 'btn pc-only', title: '받는 사람·제목·본문을 채운 Gmail 작성 창을 열어요', onclick: () => openCompose(id, i),
        }, icon('send'), 'Gmail로 쓰기'),
        trBtn,
        review ? h('span', { class: 'muted small' }, '보낼 땐 EN 탭 본문을 복사하세요') : null,
        h('button', { type: 'button', class: 'btn ghost push-right', onclick: () => toggleRegen(id) }, icon('wand'), '초안 다시 쓰기')),
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
  if (m.regenerate_request && !m.regenerate_request.error && !m.regenerate_request.direction) watchRegenerate(id);
  return h('section', { class: 'drafts' }, h('div', { class: 'd-top' }, h('h3', null, '답장 초안'), tabs), panels, regen);
}

// ---------- 답장 방향 ----------
// 라우틴이 추천한 방향 버튼(directions.options) + 늘 붙는 「기타」. 고르면 그 방향으로 초안을 새로 쓴다.
// 처리는 「초안 다시 쓰기」와 같은 워크플로(regenerate_request + direction)가 한다.

const OTHER = { id: 'other', type: null, label: '기타 — 직접 쓰기', detail: '원하는 답장 방향을 아래에 적어 주세요' };

// 「거절 — 같은 브랜드 진행 중」 → 「같은 브랜드 진행 중」 (type은 칩으로 따로 보여준다)
const dirText = (o) => String(o.label || '').replace(/^\s*(수락|조율|거절|확인(\s*질문)?)\s*[—–\-:·]\s*/, '') || o.label || '';

function directionsView(id) {
  const entry = state.mails[id];
  const m = entry.data;
  const opts = m.directions?.options || [];
  const hasDraft = !!m.drafts?.length;
  const req = m.regenerate_request;
  // 방향 추천이 없는 메일은 초안도 없고 답장 전일 때만 「기타」로 직접 방향을 적게 한다.
  if (!opts.length && (hasDraft || m.category === 'collab_duplicate' || isDone(m.status)) && !req?.direction) return null;

  const dv = entry.dv = { pick: null, btns: [] };
  const chosen = m.directions?.chosen;
  for (const o of [...opts, OTHER]) {
    const b = h('button', {
      type: 'button',
      class: `dir t-${o.type || 'other'}`,
      role: 'radio',
      'aria-checked': 'false',
      onclick: () => pickDirection(id, o),
    },
    h('span', { class: 'dir-top' },
      o.type ? h('span', { class: 'dir-type' }, DIR_TYPE[o.type] || o.type) : null,
      h('b', null, o.id === 'other' ? '기타 · 직접 쓰기' : dirText(o)),
      o.recommended ? h('span', { class: 'dir-rec' }, '추천') : null,
      chosen?.id === o.id ? h('span', { class: 'dir-chosen' }, icon('tick'), '고름') : null),
    o.detail ? h('small', null, o.detail) : null);
    dv.btns.push({ o, el: b });
  }
  dv.memo = h('textarea', { class: 'input note-input', rows: '2' });
  dv.memo.addEventListener('input', () => autosize(dv.memo));
  dv.go = h('button', { type: 'button', class: 'btn dark', onclick: () => startDirection(id) });
  dv.cancel = h('button', { type: 'button', class: 'btn ghost', onclick: () => pickDirection(id, null) }, '취소');
  dv.box = h('div', { class: 'dir-go', hidden: true }, dv.memo, h('div', { class: 'd-acts' }, dv.go, dv.cancel));
  dv.status = h('p', { class: 'tr-status', hidden: true });

  const title = hasDraft && chosen ? `답장 방향 · ${chosen.label}` : '답장 방향';
  const wrap = h('details', { class: 'sec dirs', open: !hasDraft },
    h('summary', null, title, icon('chev', 'chev')),
    h('p', { class: 'muted small dir-hint' }, hasDraft
      ? '다른 방향을 고르면 지금 초안 대신 새로 써요.'
      : '방향을 고르면 그 방향으로 초안을 써요 (1~3분).'),
    h('div', { class: 'dir-list', role: 'radiogroup', 'aria-label': '답장 방향' }, dv.btns.map((x) => x.el)),
    dv.box);
  dv.wrap = wrap;
  renderDir(id);
  if (req?.direction && !req.error) watchDirection(id);
  return h('div', null, wrap, dv.status);
}

function pickDirection(id, o) {
  const dv = state.mails[id].dv;
  if (!dv) return;
  dv.pick = dv.pick?.id === o?.id ? null : o;
  renderDir(id);
  if (dv.pick) requestAnimationFrame(() => (dv.pick.id === 'other' ? dv.memo.focus() : dv.go.scrollIntoView({ block: 'nearest' })));
}

function renderDir(id) {
  const entry = state.mails[id];
  const dv = entry?.dv;
  if (!dv) return;
  const busy = !!(entry.dirBusy || entry.saving || entry.regenerating);
  for (const { o, el } of dv.btns) {
    el.setAttribute('aria-checked', String(dv.pick?.id === o.id));
    el.disabled = busy;
  }
  dv.box.hidden = !dv.pick;
  const other = dv.pick?.id === 'other';
  dv.memo.placeholder = other
    ? '예: 이번 건은 거절하되, 12월 이후엔 가능하다고 써줘'
    : '메모 (선택) — 예: 단가는 빼고 짧게';
  const hasDraft = !!entry.data.drafts?.length;
  dv.go.textContent = entry.dirBusy ? '초안 쓰는 중…' : hasDraft ? '이 방향으로 다시 쓰기' : '이 방향으로 초안 쓰기';
  dv.go.disabled = busy;
  dv.cancel.disabled = busy;

  const req = entry.data.regenerate_request;
  let note = entry.dirNote;
  if (!note && req?.direction && req.error) note = { text: `초안 쓰기 실패: ${req.error} — 다시 골라 주세요`, err: true };
  else if (!note && req?.direction) note = { text: `「${req.direction.label}」 방향으로 초안 쓰는 중… 1~3분 걸려요. 창을 닫아도 계속돼요` };
  dv.status.hidden = !note;
  dv.status.textContent = note ? note.text : '';
  dv.status.classList.toggle('err', !!note?.err);
}

async function startDirection(id) {
  const entry = state.mails[id];
  const dv = entry.dv;
  const o = dv?.pick;
  if (!o || entry.saving || entry.dirBusy || entry.regenerating) return;
  if (entry.watching) {
    toast('영문 번역이 끝난 뒤에 눌러 주세요', true);
    return;
  }
  const comment = dv.memo.value.trim();
  if (o.id === 'other' && !comment) {
    toast('어떤 방향으로 쓸지 적어 주세요', true);
    dv.memo.focus();
    return;
  }
  const m = entry.data;
  const editing = Object.keys(entry.pending.drafts).length > 0 || (m.drafts || []).some((x) => x.edited && !x.regenerated_at);
  if (m.drafts?.length && !confirm(editing ? '직접 고친 초안이 새 방향 초안으로 바뀌어요. 계속할까요?' : '지금 초안 대신 이 방향으로 새로 써요. 계속할까요?')) return;
  // 고치던 초안은 버린다 (새로 쓰므로)
  entry.pending.drafts = {};
  const direction = { id: o.id, type: o.type || null, label: o.id === 'other' ? '기타' : o.label, detail: o.id === 'other' ? '' : (o.detail || '') };
  const kind = o.type ? (m.category === 'collab_followup' && o.type !== 'decline' ? 'followup' : DIR_KIND[o.type] || 'default') : 'default';
  entry.pending.regenerate = { kind, direction, comment };
  entry.pending.choose = { id: direction.id, type: direction.type, label: direction.label, note: comment };
  entry.dirNote = { text: '저장 중…' };
  renderDir(id);
  if (!(await save(id, { quiet: true }))) {
    entry.dirNote = null;
    renderDir(id);
    return;
  }
  try {
    await dispatch('regenerate-draft');
  } catch (e) {
    entry.dirNote = { text: `초안 쓰기를 시작하지 못했어요: ${errMsg(e)} — 다시 눌러 주세요`, err: true };
    renderDir(id);
    return;
  }
  dv.memo.value = '';
  watchDirection(id);
}

async function watchDirection(id) {
  const entry = state.mails[id];
  if (entry.dirBusy) return;
  entry.dirBusy = true;
  entry.dirNote = null;
  renderDir(id);
  fillHead(id);
  let rebuilt = false;
  try {
    const r = await waitForJob(id, 'regenerate_request', REGEN_WAIT_MS);
    if (r?.timeout) entry.dirNote = { text: '초안 쓰기가 오래 걸리고 있어요. 잠시 뒤 ⟳ 새로고침해 보세요', err: true };
    else if (r) {
      entry.data = r.fresh.data;
      entry.sha = r.fresh.sha;
      if (r.fresh.data.regenerate_request?.error) toast('초안 쓰기에 실패했어요', true);
      else {
        toast('초안을 썼어요');
        rebuildDetail(id);
        rebuilt = true;
      }
    }
  } finally {
    entry.dirBusy = false;
    if (state.mails[id] === entry) {
      if (!rebuilt) renderDir(id);
      fillHead(id);
    }
  }
}

// 초안이 새로 생기면 상세 화면을 통째로 다시 만든다.
function rebuildDetail(id) {
  const entry = state.mails[id];
  entry.detail = null;
  entry.dv = null;
  entry.rg = null;
  entry.draftInputs = [];
  entry.draftKeys = [];
  entry.trEls = [];
  if (state.sel === id) renderDetailPane();
}

// ---------- 초안 다시 쓰기 ----------
// 보고 있는 탭의 초안 종류(kind)를 다시 쓴다. 해외 건은 KO·EN을 같이.

function regenBox(id) {
  const entry = state.mails[id];
  entry.rg = {
    stale: h('p', { class: 'tr-status err', hidden: true }),
    label: h('p', { class: 'label' }),
    input: h('textarea', {
      class: 'input note-input',
      rows: '2',
      placeholder: '예: 광고 일정이 꽉 차서 죄송하지만 이번엔 어렵다는 내용으로 바꿔줘',
    }),
    btn: h('button', { type: 'button', class: 'btn dark', onclick: () => startRegenerate(id) }, '다시 쓰기'),
    undo: h('button', {
      type: 'button',
      class: 'btn ghost',
      title: '다시 쓰기 전 초안과 바꿔요. 한 번 더 누르면 다시 돌아와요',
      onclick: () => swapPrevious(id),
    }, '↶ 이전 초안으로'),
    status: h('p', { class: 'tr-status', hidden: true }),
  };
  const { stale, label, input, btn, undo, status } = entry.rg;
  entry.rg.box = h('div', { class: 'regen', hidden: true }, label, input, h('div', { class: 'd-acts' }, btn, undo));
  return h('div', null, stale, entry.rg.box, status);
}

// 「초안 다시 쓰기」 버튼은 요청 칸을 열고 닫기만 한다.
function toggleRegen(id) {
  const rg = state.mails[id].rg;
  rg.box.hidden = !rg.box.hidden;
  if (!rg.box.hidden) rg.input.focus();
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
  btn.textContent = entry.regenerating ? '다시 쓰는 중…' : '다시 쓰기';
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
  const wrap = h('details', { class: 'sec feedback' }, h('summary', null, '판정 평가 · 메모', icon('chev', 'chev')));

  const change = () => {
    entry.pending.feedback = { ...fb };
    markDirty(id);
  };

  if (m.verdict) {
    const correct = h('select', { class: 'input select', 'aria-label': '맞는 판정' },
      h('option', { value: '' }, '맞는 판정은?'),
      Object.keys(VERDICT_NAME).filter((v) => v !== m.verdict)
        .map((v) => h('option', { value: v, selected: fb.correct_verdict === v }, VERDICT_NAME[v])));
    correct.hidden = fb.verdict_ok !== false;
    correct.addEventListener('change', () => { fb.correct_verdict = correct.value || null; change(); });

    const yes = h('button', { type: 'button', class: 'btn sm' }, icon('up'), '맞아요');
    const no = h('button', { type: 'button', class: 'btn sm' }, icon('down'), '아니에요');
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
    wrap.append(h('div', { class: 'd-acts' }, h('span', { class: 'muted' }, '판정'), dot(m.verdict), h('b', null, VERDICT_NAME[m.verdict]), yes, no, correct));
  }

  const note = h('textarea', { class: 'input note-input', rows: '2', placeholder: '메모 (판정·초안 기준 개선용)', value: fb.note || '' });
  note.addEventListener('input', () => { fb.note = note.value; change(); });
  wrap.append(note);
  return wrap;
}

function actionsView(id) {
  const entry = state.mails[id];
  const wrap = h('section', { class: 'status-row' });
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
    h('div', { class: 'segs' }, h('span', { class: 'segs-label' }, '상태'), statusBtns),
    h('button', {
      type: 'button',
      class: `btn ${state.dirty.has(id) ? 'dark' : 'ghost'}`,
      disabled: entry.saving || !state.dirty.has(id),
      onclick: () => save(id),
    }, entry.saving ? '저장 중…' : state.dirty.has(id) ? '저장' : '저장됨'),
  );
}

// ---------- 저장 ----------

function emptyPending() {
  return { drafts: {}, feedback: null, status: null, translate: null, research: false, regenerate: null, swap: null, choose: null };
}

function hasPending(p) {
  return Object.keys(p.drafts).length > 0 || p.feedback != null || p.status != null || p.translate != null ||
    p.research || p.regenerate != null || p.swap != null || p.choose != null;
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
    // 정원이 무엇을 고쳤는지 답변 패턴 정리에서 보도록, 처음 고칠 때의 본문을 한 번만 남긴다.
    if (t.original_body == null) t.original_body = t.body;
    t.body = body;
    t.edited = true;
    t.edited_at = now;
  }
  if (p.feedback) {
    const noteChanged = (p.feedback.note || '') !== (d.feedback?.note || '');
    d.feedback = { ...(d.feedback || {}), ...p.feedback };
    if (noteChanged) d.feedback.updated_at = now;
  }
  if (p.choose) d.directions = { options: [], ...(d.directions || {}), chosen: { ...p.choose, chosen_at: now } };
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
  if (p.choose) what.push(`답장 방향 「${p.choose.label}」`);
  else if (p.regenerate) what.push('초안 다시 쓰기 요청');
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
  renderDir(id);
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
      choose: null,
    };
    toast(`저장 실패: ${errMsg(e)}`, true);
  } finally {
    entry.saving = false;
    if (hasPending(entry.pending)) state.dirty.add(id);
    else state.dirty.delete(id);
    if (entry.el) entry.el.className = rowClass(id);
    fillHead(id);
    renderActions(id);
    renderRegen(id);
    renderDir(id);
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

// 폰에서 뒤로 가기 = 상세 닫기
window.addEventListener('popstate', () => {
  if (state.ui.shell?.classList.contains('show-detail')) closeDetail(true);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeProfile(); closeAdPeriod(); }
});

boot();
