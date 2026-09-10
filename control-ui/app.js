'use strict';
const $ = id => document.getElementById(id);
let token = sessionStorage.getItem('browser-control-token') || '';
let state;
let refreshing = false;
async function api(route, body) {
  const response = await fetch(route, {method: body === undefined ? 'GET' : 'POST', headers: {'Content-Type': 'application/json', Authorization: `Bearer ${token}`}, body: body === undefined ? undefined : JSON.stringify(body)});
  const data = await response.json();
  if (!response.ok) {if (response.status === 401) logout(); throw Error(data.error || '请求失败');}
  return data;
}
function logout() {token = ''; sessionStorage.removeItem('browser-control-token'); $('login').hidden = false; $('dashboard').hidden = true; $('logout').hidden = true;}
function node(tag, text) {const el = document.createElement(tag); if (text !== undefined) el.textContent = text; return el;}
function button(text, action, style = '') {const b = node('button', text); b.className = style; b.addEventListener('click', () => run(action)); return b;}
async function run(action) {try {$('status').textContent = ''; await action(); await refresh();} catch(e) {$('status').textContent = e.message;}}
async function login(code) {const data = await api('/login', {code}); token = data.token; sessionStorage.setItem('browser-control-token', token); $('login-code').value = '';}
async function refresh() {
  if (!token || refreshing) return;
  refreshing = true;
  try {
    state = await api('/admin/state'); $('login').hidden = true; $('dashboard').hidden = false; $('logout').hidden = false;
    $('control-state').textContent = state.policy.paused ? '已暂停：后续浏览器操作将被拒绝。' : '运行中：仅允许已授权站点。';
    $('pause').textContent = state.policy.paused ? '恢复控制' : '暂停全部控制';
    $('pair-state').textContent = state.paired ? '已保存配对凭证。' : '尚未保存自动连接凭证。';
    $('origins').replaceChildren(...state.policy.origins.map(origin => {const li = node('li'); li.append(node('span', origin), button('撤销', () => api('/admin/policy', {revision: state.policy.revision || 0, origins: state.policy.origins.filter(o => o !== origin), paused: state.policy.paused}), 'secondary')); return li;}));
    $('grants').replaceChildren(...state.grants.map(g => {const li = node('li'); li.append(node('span', `${g.origin} · 会话 ${g.session.slice(0,8)} · ${new Date(g.expires).toLocaleTimeString()} 到期`), button('撤销', () => api('/admin/revoke', {session: g.session, origin: g.origin}), 'secondary')); return li;}));
    const pending = state.pending.filter(p => p.decision === 'pending');
    $('requests').replaceChildren(...pending.map(p => {
      const card = node('div'); card.className = 'request'; card.append(node('strong', p.origin), node('p', `${p.tool} · 会话 ${p.session.slice(0,8)}`));
      const buttons = node('div'); buttons.className = 'buttons';
      for (const [label, decision, scope] of [['允许此会话','allow','session'], ['始终允许','allow','global'], ['拒绝','deny','session']]) buttons.append(button(label, () => api('/admin/decide', {id: p.id, decision, scope}), decision === 'deny' ? 'secondary' : ''));
      card.append(buttons); return card;
    }));
    if (!pending.length) $('requests').append(node('p', '目前没有待授权请求。'));
    $('audit').replaceChildren(...state.audit.map(a => {const tr = node('tr'); for (const text of [new Date(a.at).toLocaleString(), `${a.event}${a.tool ? ' / ' + a.tool : ''}`, a.origin || '—', `${a.outcome || a.decision || ''} ${a.session ? a.session.slice(0,8) : ''}`]) tr.append(node('td', text)); return tr;}));
  } finally {refreshing = false;}
}
$('logout').addEventListener('click', () => run(async () => {await api('/admin/logout', {}); logout();}));
$('login-form').addEventListener('submit', e => {e.preventDefault(); run(() => login($('login-code').value.trim()));});
$('origin-form').addEventListener('submit', e => {e.preventDefault(); run(async () => {await api('/admin/policy', {revision: state.policy.revision || 0, origins: [...state.policy.origins, $('origin').value.trim()], paused: state.policy.paused}); $('origin').value = '';});});
$('pair-form').addEventListener('submit', e => {e.preventDefault(); const value = $('extension-token').value.trim(); $('extension-token').value = ''; run(() => api('/admin/pair', {token: value}));});
$('pause').addEventListener('click', () => run(() => api('/admin/policy', {revision: state.policy.revision || 0, origins: state.policy.origins, paused: !state.policy.paused})));
const code = new URLSearchParams(location.hash.slice(1)).get('code');
if (location.hash) history.replaceState(null, '', location.pathname);
run(async () => {if (code) await login(code);});
setInterval(() => {refresh().catch(e => {$('status').textContent = e.message;});}, 2000);
