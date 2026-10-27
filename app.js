'use strict';

// 데이터는 비공개 repo에 있고, 정원이 발급한 fine-grained 토큰(이 repo만 Contents 읽기·쓰기)으로 읽고 쓴다.
// 형식: 비공개 repo의 automation/스키마.md
const REPO = 'grapptwork/instagram-mail-reply';
const BRANCH = 'main';
const API = 'https://api.github.com';
const TOKEN_KEY = 'maildesk.token';
const FILTER_KEY = 'maildesk.filter';

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

function toast(msg, isError) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = isError ? 'error' : '';
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, isError ? 6000 : 2200);
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
  return res.json();
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
  app.replaceChildren(topBar(), summary(), cardList());
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
  const card = h('article', { class: cardClass(m), id: `m-${id}` }, head);
  head.addEventListener('click', () => toggleCard(id));
  entry.el = card;
  entry.head = head;
  fillHead(id);
  return card;
}

function cardClass(m) {
  const cls = ['card'];
  if (m.urgent) cls.push('urgent');
  if (m.verdict) cls.push(`v-${m.verdict}`);
  if (m.category === 'collab_duplicate') cls.push('dim');
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
    h('div', null, h('b', null, m.from?.name || ''), ' ', h('span', { class: 'muted' }, m.from?.email || '')),
    h('div', null, m.subject || ''),
    h('div', { class: 'muted' }, `받음 ${fmtTime(m.received_at)}`,
      m.company?.name ? ` · ${m.company.name}` : '',
      m.company?.type ? ` (${COMPANY_TYPE[m.company.type] || m.company.type})` : ''),
  ));

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
  if (m.verdict_reasons?.length) d.append(section('판정 근거', list(m.verdict_reasons), { open: true }));

  d.append(section('분석', h('div', null,
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

  d.append(section('메일 내용', h('div', { class: 'body' }, m.body || '(내용 없음)')));

  const research = researchSection(m);
  if (research) d.append(research);
  if (m.drafts?.length) d.append(draftsView(id));
  d.append(feedbackView(id));
  d.append(actionsView(id));
  return d;
}

function researchSection(m) {
  const sid = m.brand?.service_id;
  const cid = m.company?.company_id;
  if (!sid && !cid) return null;
  const body = h('div', { class: 'research' }, h('p', { class: 'muted' }, '불러오는 중…'));
  const det = section('조사 결과', body);
  det.addEventListener('toggle', async () => {
    if (!det.open || body.dataset.done) return;
    try {
      const db = await loadDb();
      body.replaceChildren(...[
        sid ? serviceView(db.services[sid], sid) : null,
        cid ? companyView(db.companies[cid], cid) : null,
      ].filter(Boolean));
      body.dataset.done = '1';
    } catch (e) {
      body.replaceChildren(h('p', { class: 'err' }, `조사 DB를 못 불러왔어요: ${errMsg(e)}`));
    }
  });
  return det;
}

function sources(list_) {
  if (!list_?.length) return null;
  return h('span', { class: 'sources' }, list_.map((s, i) => [i ? ' · ' : '', link(s.url || s, `${i + 1}`)]));
}

function serviceView(s, sid) {
  if (!s) return h('div', { class: 'db' }, h('h4', null, `서비스 ${sid}`), h('p', { class: 'muted' }, '조사 기록 없음'));
  const op = s.operator || {};
  const pa = s.parent || {};
  const rep = s.reputation || {};
  return h('div', { class: 'db' },
    h('h4', null, `서비스 · ${s.name || sid} ${VERDICT[s.verdict_hint] || ''}`),
    kv([
      ['운영사', [op.legal_name || '법인명 미확인', op.country].filter(Boolean).join(' · ')],
      ['모회사', pa.name ? `${pa.name}${pa.country ? ` · ${pa.country}` : ''}${pa.confidence ? ` (${pa.confidence})` : ''}` : null],
      ['중국계', s.china_linked],
      ['요약', rep.summary],
      ['규모', rep.scale],
      ['평점', rep.app_ratings],
      ['리뷰', rep.reviews],
      ['논란', rep.controversies],
      ['미확인', s.missing],
      ['조사일', s.researched_at],
      ['출처', sources(s.sources)],
    ]),
  );
}

function companyView(c, cid) {
  if (!c) return h('div', { class: 'db' }, h('h4', null, `발신 회사 ${cid}`), h('p', { class: 'muted' }, '조사 기록 없음'));
  const rv = c.reviews || {};
  return h('div', { class: 'db' },
    h('h4', null, `발신 회사 · ${c.name || cid} ${VERDICT[c.verdict_hint] || ''}`),
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
      ['미확인', c.missing],
      ['조사일', c.researched_at],
      ['출처', sources(c.sources)],
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
  };

  m.drafts.forEach((dr, i) => {
    const review = m.lang !== 'ko' && dr.lang === 'ko';
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

    panelEls.push(h('div', { class: 'panel', role: 'tabpanel' },
      dr.subject ? h('div', { class: 'subject' },
        h('span', { class: 'muted' }, '제목 '), h('span', null, dr.subject),
        h('button', { type: 'button', class: 'btn small', onclick: () => copyText(dr.subject) }, '제목 복사')) : null,
      ta,
      warn,
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn primary', onclick: () => copyText(ta.value) }, '본문 복사'),
        review ? h('span', { class: 'muted' }, '보낼 땐 EN 탭 본문을 복사하세요') : null),
    ));
  });

  tabs.append(...tabEls);
  panels.append(...panelEls);
  // 해외 건은 보낼 영어 초안을 먼저 보여준다.
  const first = Math.max(0, m.drafts.findIndex((dr) => dr.lang === (m.lang === 'ko' ? 'ko' : 'en')));
  tabEls.forEach((t, j) => t.setAttribute('aria-selected', String(j === first)));
  panelEls.forEach((p, j) => { p.hidden = j !== first; });
  return h('section', { class: 'drafts' }, h('h3', null, '답장 초안'), tabs, panels);
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
  return { drafts: {}, feedback: null, status: null };
}

function hasPending(p) {
  return Object.keys(p.drafts).length > 0 || p.feedback != null || p.status != null;
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
  }
  return d;
}

function commitMessage(id, p, data) {
  const what = [];
  if (Object.keys(p.drafts).length) what.push('초안 수정');
  if (p.feedback) what.push('판정 평가');
  if (p.status) what.push(`상태 ${p.status}`);
  return `site: ${data.brand?.name || id} ${what.join(', ')}`.trim();
}

async function save(id) {
  const entry = state.mails[id];
  if (entry.saving || !hasPending(entry.pending)) return;
  const snap = entry.pending;
  entry.pending = emptyPending();
  entry.saving = true;
  renderActions(id);
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
    toast('저장했어요');
  } catch (e) {
    const cur = entry.pending;
    entry.pending = {
      drafts: { ...snap.drafts, ...cur.drafts },
      feedback: cur.feedback ?? snap.feedback,
      status: cur.status ?? snap.status,
    };
    toast(`저장 실패: ${errMsg(e)}`, true);
  } finally {
    entry.saving = false;
    if (hasPending(entry.pending)) state.dirty.add(id);
    else state.dirty.delete(id);
    entry.el.className = cardClass(entry.data) + (entry.detail && !entry.detail.hidden ? ' open' : '');
    fillHead(id);
    renderActions(id);
  }
}

window.addEventListener('beforeunload', (e) => {
  if (state.dirty.size) {
    e.preventDefault();
    e.returnValue = '';
  }
});

window.addEventListener('hashchange', () => {
  const want = decodeURIComponent(location.hash.slice(1));
  if (state.token && want !== state.date && state.dates.includes(want)) go(want);
});

boot();
