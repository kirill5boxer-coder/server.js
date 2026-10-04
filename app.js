/* ==========================================
   TRAIN MESSENGER — Client v6.0 (полный)
========================================== */
let idToken = localStorage.getItem('train_id_token') || null;
let me = null, ws = null, currentChat = null, currentChatData = null;
let currentTab = 'chats', attachQueue = [], postMediaQueue = [], replyTarget = null;
let editingMsgId = null, forwardMsgId = null;

const API = '';
const $ = id => document.getElementById(id);

/* ========== API ========== */
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (idToken) headers['Authorization'] = 'Bearer ' + idToken;
  const res = await fetch(API + path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Ошибка');
  return data;
}

/* ========== HELPERS ========== */
function toast(text, type = 'info') {
  const t = $('toast');
  t.className = 'toast ' + type;
  t.innerText = text;
  t.classList.remove('hide');
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.classList.add('hide'), 500); }, 2500);
}

function esc(s) { return String(s || '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])); }

function fmtTime(ts) { const d = new Date(ts); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }

function fmtRel(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return 'сейчас';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' мин';
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' ч';
  if (diff < 604800000) return Math.floor(diff / 86400000) + ' дн';
  return new Date(ts).toLocaleDateString('ru');
}

function avatarHTML(u, size = '') {
  if (!u) return `<div class="av ${size}"></div>`;
  if (u.avatar) return `<div class="av ${size}"><img src="${u.avatar}" onerror="this.remove()"></div>`;
  const color = u.avatarColor || '#2f7fff';
  const text = u.avatarText || (u.name || '?')[0];
  return `<div class="av ${size}" style="background:${color}">${esc(text)}</div>`;
}

function verifHTML(u) {
  if (!u) return '';
  let s = '';
  if (u.verified) s += '<svg class="verif-ic" viewBox="0 0 24 24"><use href="#i-verified"/></svg>';
  if (u.owner) s += '<svg class="owner-crown" viewBox="0 0 24 24"><use href="#i-crown"/></svg>';
  if (u.premium && !u.owner) s += '<svg class="verif-ic" style="color:#FFD700" viewBox="0 0 24 24"><use href="#i-star"/></svg>';
  return s;
}

function svgIcon(name, cls = 'ic-sm') {
  return `<svg viewBox="0 0 24 24" class="${cls}" style="fill:currentColor"><use href="#i-${name}"/></svg>`;
}

function fileToBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

async function uploadFile(file) {
  const data = await fileToBase64(file);
  const res = await api('/api/upload', { method: 'POST', body: JSON.stringify({ data, name: file.name }) });
  return { url: res.url, type: res.type, size: res.size, name: file.name };
}

/* ========== АВТОРИЗАЦИЯ ========== */
function switchAuth(tab) {
  $('segInd').classList.toggle('right', tab === 'reg');
  $('tabLogin').classList.toggle('on', tab === 'login');
  $('tabReg').classList.toggle('on', tab === 'reg');
  $('loginForm').classList.toggle('hide', tab !== 'login');
  $('regForm').classList.toggle('hide', tab !== 'reg');
}

async function doLogin() {
  const login = $('lLogin').value.trim().toLowerCase();
  const password = $('lPass').value;
  const m = $('lMsg'); m.className = 'msg';
  if (!login || !password) { m.innerText = 'Введите данные'; m.classList.add('err'); return; }
  m.innerText = 'Вход...'; m.classList.add('ok');
  try {
    const data = await api('/api/login', { method: 'POST', body: JSON.stringify({ login, password }) });
    idToken = data.idToken; me = data.profile;
    localStorage.setItem('train_id_token', idToken);
    toast('Привет, ' + me.name + '!', 'ok');
    startApp();
  } catch (e) { m.innerText = e.message; m.classList.remove('ok'); m.classList.add('err'); }
}

async function doRegister() {
  const name = $('rName').value.trim();
  const login = $('rLogin').value.trim().toLowerCase();
  const email = $('rEmail').value.trim();
  const password = $('rPass').value;
  const m = $('rMsg'); m.className = 'msg';
  if (!name || !login || !email || !password) { m.innerText = 'Заполните поля'; m.classList.add('err'); return; }
  if (!/^[a-z0-9_]{3,20}$/.test(login)) { m.innerText = 'Логин: латиница 3-20'; m.classList.add('err'); return; }
  if (password.length < 6) { m.innerText = 'Пароль мин 6'; m.classList.add('err'); return; }
  m.innerText = 'Создаём...'; m.classList.add('ok');
  try {
    await api('/api/register', { method: 'POST', body: JSON.stringify({ email, password, name, login }) });
    const data = await api('/api/login', { method: 'POST', body: JSON.stringify({ login, password }) });
    idToken = data.idToken; me = data.profile;
    localStorage.setItem('train_id_token', idToken);
    toast('Добро пожаловать!', 'ok');
    startApp();
  } catch (e) { m.innerText = e.message; m.classList.remove('ok'); m.classList.add('err'); }
}

function doLogout() {
  if (!confirm('Выйти?')) return;
  localStorage.removeItem('train_id_token');
  idToken = null; me = null;
  if (ws) ws.close();
  location.reload();
}

/* ========== СТАРТ ========== */
async function startApp() {
  $('authScreen').classList.add('hide');
  $('app').classList.remove('hide');
  try { me = await api('/api/me'); } catch (e) { doLogout(); return; }
  initWebSocket();
  renderFeedAvatar();
  //registerServiceWorker();
  switchTab('chats');
  loadChats();
  //checkAchievements();
}

function renderFeedAvatar() {
  const fav = $('feedAv');
  if (!fav) return;
  if (me.avatar) fav.innerHTML = `<img src="${me.avatar}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
  else { fav.innerText = me.avatarText || me.name[0]; fav.style.background = me.avatarColor || '#2f7fff'; }
}

function initWebSocket() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(proto + '://' + location.host + '/?token=' + idToken);
  ws.onmessage = e => { try { handleWsMessage(JSON.parse(e.data)); } catch (err) {} };
  ws.onclose = () => setTimeout(initWebSocket, 3000);
}

function handleWsMessage(data) {
  const { type } = data;
  if (type === 'new_message') {
    if (currentChat === data.data.chatId) appendMessage(data.data.message, data.data.sender);
    loadChats();
  }
  if (type === 'typing') { if (currentChat === data.data.chatId) showTyping(data.data.name); }
  if (type === 'friend_request') toast('Заявка в друзья', 'info');
  if (type === 'friend_accepted') toast('Заявка принята', 'ok');
  if (type === 'new_chat') { toast('Новый чат', 'info'); loadChats(); }
  if (type === 'message_deleted') { if (currentChat === data.data.chatId) openChat(currentChat); }
  if (type === 'message_updated') { if (currentChat === data.data.chatId) openChat(currentChat); }
  if (type === 'gift_received') toast('🎁 Вам подарок!', 'ok');
  if (type === 'premium_activated') { toast('⭐ Premium активирован!', 'ok'); me = null; api('/api/me').then(u => me = u); }
  if (type === 'premium_gifted') toast('⭐ Вам подарили Premium!', 'ok');
  if (type === 'level_up') toast('🎉 Уровень ' + data.data.level + '!', 'ok');
  if (type === 'achievement') toast('🏆 ' + data.data.name, 'ok');
  if (type === 'new_story') toast('📸 Новая история', 'info');
  if (type === 'mention') toast('@ Вас упомянули в чате', 'info');
  if (type === 'chat_pin') { if (currentChat === data.data.chatId) openChat(currentChat); }
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

/* ========== НАВИГАЦИЯ ========== */
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.sb-btn, .mob-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + tab));
  if (tab === 'chats') loadChats();
  if (tab === 'feed') { loadPosts(); renderFeedAvatar(); }
  if (tab === 'friends') loadFriends();
  if (tab === 'profile') renderProfile();
  if (tab === 'settings') loadSettingsUI();
  if (tab === 'premium') renderPremiumPage();
  if (tab === 'gifts') renderGiftsPage();
}

/* ========== ЧАТЫ ========== */
async function loadChats() {
  try {
    const chats = await api('/api/chats');
    const archive = await api('/api/chats/archive/list').catch(() => []);
    const q = ($('chatSearch') ? $('chatSearch').value : '').toLowerCase();
    const filtered = chats.filter(c => !q || c.name.toLowerCase().includes(q));
    const list = $('chatList');
    if (!filtered.length) { list.innerHTML = '<div class="empty">Нет чатов</div>'; return; }
    list.innerHTML = filtered.map(c => {
      const isArchived = archive.includes(c.id);
      return `
        <div class="chat-item ${currentChat === c.id ? 'active' : ''} ${isArchived ? 'archived' : ''}" onclick="openChat('${c.id}')">
          ${avatarHTML(c, 'sm')}
          <div class="chat-info">
            <div class="chat-top">
              <div class="chat-name">${esc(c.name)}${verifHTML(c)}</div>
              <div class="chat-time">${c.lastTime ? fmtTime(c.lastTime) : ''}</div>
            </div>
            <div class="chat-msg">${esc(c.lastMsg || 'Нет сообщений')}</div>
          </div>
          ${isArchived ? '<span class="archived-badge">архив</span>' : ''}
        </div>
      `;
    }).join('');
  } catch (e) { toast(e.message, 'err'); }
}

async function openChat(id) {
  try {
    currentChat = id;
    const c = await api('/api/chats/' + id);
    currentChatData = c;
    $('chatWelcome').classList.add('hide');
    $('chatActive').classList.remove('hide');
    $('chatAv').outerHTML = avatarHTML(c, 'sm').replace('class="av sm', 'id="chatAv" class="av sm');
    $('chatName').innerHTML = esc(c.name) + verifHTML(c);
    $('chatStatus').innerText = c.type === 'channel' ? 'Канал' : c.type === 'group' ? 'Группа' : 'Личный чат';
           // ===== ПРАВИЛЬНЫЙ КЛИК ПО ШАПКЕ ЧАТА =====
    const hdrInfo = document.querySelector('.chat-hdr-info');
    if (hdrInfo) {
      hdrInfo.onclick = () => {
        if (c.type === 'personal' && c.otherUid && c.otherUid !== me.uid) {
          viewUser(c.otherUid);
        } else if (c.type === 'personal' && (!c.otherUid || c.otherUid === me.uid)) {
          // Чат с самим собой
          switchTab('profile');
        } else {
          openChatInfo();
        }
      };
    }
    // ===== КОНЕЦ =====
    if (window.innerWidth <= 900) $('chatView').classList.add('open');
    const result = await api('/api/chats/' + id + '/messages');
    const box = $('messages');
    box.innerHTML = '';
    (result.messages || []).forEach(m => appendMessage(m, null));
    setTimeout(() => box.scrollTop = box.scrollHeight, 50);
    await api('/api/chats/' + id + '/read', { method: 'POST' }).catch(() => {});
    renderPinnedMsg(c.pinnedMsg);
    loadChats();
  } catch (e) { toast(e.message, 'err'); }
}
function renderPinnedMsg(pinned) {
  let el = $('pinnedBar');
  if (!pinned) { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'pinnedBar';
    el.className = 'pinned-bar';
    const hdr = document.querySelector('.chat-hdr');
    hdr.after(el);
  }
  el.innerHTML = `
    <svg viewBox="0 0 24 24" class="ic-sm" style="fill:var(--warning)"><use href="#i-pin"/></svg>
    <div class="pinned-text">
      <div class="pinned-label">Закреплённое</div>
      <div class="pinned-msg">${esc(pinned.text || '')}</div>
    </div>
  `;
  el.onclick = () => scrollToMsg(pinned.msgId);
}

function closeChatMobile() { $('chatView').classList.remove('open'); }

async function sendMessage() {
  const input = $('msgInput');
  const text = input.value.trim();
  if (!text && !attachQueue.length) return;
  if (!currentChat) return;

  // Проверка rate-limit
  try { await api('/api/chats/' + currentChat + '/messages-check', { method: 'POST' }); }
  catch (e) {
    if (e.message.includes('часто') || e.message.includes('Подожди')) {
      return toast(e.message, 'err');
    }
  }

  try {
    input.value = '';
    const media = attachQueue;
    attachQueue = [];
    renderAttachPreview();
    const body = { text, media };
    if (replyTarget) body.replyTo = replyTarget;
    const result = await api('/api/chats/' + currentChat + '/messages', {
      method: 'POST',
      body: JSON.stringify(body)
    });
    // Упоминания
    const mentions = [...text.matchAll(/@([a-z0-9_]+)/gi)].map(m => m[1]);
    if (mentions.length && result.id) {
      api('/api/messages/mention', {
        method: 'POST',
        body: JSON.stringify({ chatId: currentChat, msgId: result.id, mentionedLogins: mentions })
      }).catch(() => {});
    }
    cancelReply();
    me = await api('/api/me');
  } catch (e) { toast(e.message, 'err'); }
}

function appendMessage(m, sender) {
  const box = $('messages');
  if (!box) return;
  const existing = document.querySelector(`[data-msg-id="${m.id}"]`);
  if (existing) existing.remove();
  const isOut = m.from === me.uid;
  const div = document.createElement('div');
  div.className = 'message ' + (isOut ? 'out' : 'in') + (m.pinned ? ' pinned' : '');
  div.dataset.msgId = m.id;

  let mediaHTML = '';
  if (m.media && m.media.length) {
    mediaHTML = '<div class="msg-media">' + m.media.map(x =>
      (x.type && x.type.startsWith('video')) ? `<video src="${x.url}" controls></video>` :
      (x.type && x.type.startsWith('image')) ? `<img src="${x.url}" onclick="openMediaViewer('${x.url}','${x.type}')">` :
      `<a href="${x.url}" target="_blank" class="doc-link">${svgIcon('file')}${esc(x.name || 'Файл')}</a>`
    ).join('') + '</div>';
  }

  let voiceHTML = '';
  if (m.voice) {
    voiceHTML = `<div class="voice-msg">
      <button class="voice-play" onclick="playVoice(this,'${m.voice.url}')">▶</button>
      <div class="voice-wave"></div>
      <span class="voice-time">${Math.floor(m.voice.duration || 0)}с</span>
    </div>`;
  }

  let replyHTML = '';
  if (m.replyTo) {
    replyHTML = `<div class="reply-quote" onclick="scrollToMsg('${m.replyTo.msgId}')">
      <div class="reply-q-name">${esc(m.replyTo.fromName || 'Сообщение')}</div>
      <div class="reply-q-text">${esc((m.replyTo.text || '').substring(0, 80))}</div>
    </div>`;
  }

  let forwardHTML = '';
  if (m.forwardedFrom) {
    forwardHTML = `<div class="forward-label">${svgIcon('arrow-right')} Переслано от ${esc(m.forwardedFrom.fromName || 'Пользователь')}</div>`;
  }

  let pollHTML = '';
  if (m.poll) {
    const totalVotes = m.poll.options.reduce((s, o) => s + (o.votes?.length || 0), 0);
    pollHTML = `<div class="poll-box">
      <div class="poll-q">${esc(m.poll.question)}${m.poll.closed ? ' 🔒' : ''}</div>
      ${m.poll.options.map((o, i) => {
        const v = (o.votes || []).length;
        const pct = totalVotes ? Math.round(v / totalVotes * 100) : 0;
        const voted = (o.votes || []).includes(me.uid);
        return `<div class="poll-option ${voted ? 'voted' : ''}" onclick="${m.poll.closed ? '' : `votePoll('${m.id}',${i})`}">
          <div class="poll-bar" style="width:${pct}%"></div>
          <div class="poll-text">${esc(o.text)} — <b>${v}</b> (${pct}%)</div>
        </div>`;
      }).join('')}
      <div class="poll-info">${m.poll.anonymous ? '🔒 Анонимный' : ''} ${m.poll.multiple ? '☑️ Мультивыбор' : ''} · Всего: ${totalVotes}</div>
      ${m.poll.creator === me.uid && !m.poll.closed ? `<button class="poll-close" onclick="closePoll('${m.id}')">Закрыть</button>` : ''}
    </div>`;
  }

  let textHTML = m.text ? esc(m.text) : '';
  textHTML = textHTML.replace(/@([a-z0-9_]+)/gi, '<span class="mention" onclick="openUserByLogin(\'$1\')">@$1</span>');
  textHTML = textHTML.replace(/#([а-яa-z0-9_]+)/gi, '<span class="hashtag" onclick="searchHashtag(\'$1\')">#$1</span>');

  let reactionsHTML = '';
  if (m.reactions && Object.keys(m.reactions).length) {
    reactionsHTML = '<div class="msg-reactions">' + Object.entries(m.reactions).map(([emoji, users]) => {
      const has = users.includes(me.uid);
      return `<span class="reaction ${has ? 'mine' : ''}${m.animated ? ' animated' : ''}" onclick="addReaction('${m.id}','${emoji}')">${emoji} ${users.length}</span>`;
    }).join('') + '</div>';
  }

  div.innerHTML = `
    ${!isOut && sender ? `<div class="sender">${esc(sender.name)}</div>` : ''}
    ${forwardHTML}
    ${replyHTML}
    <div class="msg-text">${textHTML}</div>
    ${mediaHTML}${voiceHTML}${pollHTML}${reactionsHTML}
    <div class="msg-footer">
      <span class="time">${fmtTime(m.time)}${m.edited ? ' · изм.' : ''}</span>
      ${isOut ? '<svg viewBox="0 0 24 24" class="ic-check"><use href="#i-check2"/></svg>' : ''}
      <button class="msg-more" onclick="openMsgMenu('${m.id}', event)">⋯</button>
    </div>
  `;

  let touchStartX = 0;
  div.addEventListener('touchstart', e => touchStartX = e.touches[0].clientX);
  div.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - touchStartX;
    if (dx > 60) startReply(m.id);
  });
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

let typingTimer;
function onTyping() {
  if (!ws || !currentChat) return;
  clearTimeout(typingTimer);
  ws.send(JSON.stringify({ type: 'typing', chatId: currentChat }));
  typingTimer = setTimeout(() => {}, 1000);
}

function showTyping(name) {
  const el = $('typingInd');
  el.innerText = name + ' печатает...';
  el.classList.remove('hide');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hide'), 2000);
}

async function attachChatMedia(e) {
  const files = Array.from(e.target.files);
  for (const f of files) {
    if (f.size > 20 * 1024 * 1024) { toast(f.name + ' > 20MB', 'err'); continue; }
    toast('Загрузка...', 'info');
    try { attachQueue.push(await uploadFile(f)); renderAttachPreview(); }
    catch (err) { toast('Ошибка', 'err'); }
  }
  e.target.value = '';
}

function renderAttachPreview() {
  const box = $('attachPreview');
  if (!attachQueue.length) { box.classList.add('hide'); box.innerHTML = ''; return; }
  box.classList.remove('hide');
  box.innerHTML = attachQueue.map((m, i) => `
    <div class="pi">
      ${m.type && m.type.startsWith('video') ? `<video src="${m.url}" muted></video>` :
        m.type && m.type.startsWith('image') ? `<img src="${m.url}">` :
        `<div class="doc-preview">${svgIcon('file')}</div>`}
      <div class="rm" onclick="removeAttach(${i})">${svgIcon('x')}</div>
    </div>
  `).join('');
}

function removeAttach(i) { attachQueue.splice(i, 1); renderAttachPreview(); }

/* ========== МЕНЮ СООБЩЕНИЯ ========== */
function openMsgMenu(msgId, event) {
  event.stopPropagation();
  const msgEl = event.target.closest('.message');
  const existing = $('msgContextMenu');
  if (existing) existing.remove();
  const isMine = msgEl.classList.contains('out');
  const menu = document.createElement('div');
  menu.id = 'msgContextMenu';
  menu.className = 'msg-ctx';
  menu.innerHTML = `
    <button onclick="addReaction('${msgId}','❤️');rmCtx()">❤️ Нравится</button>
    <button onclick="addReaction('${msgId}','👍');rmCtx()">👍 Класс</button>
    <button onclick="addReaction('${msgId}','😂');rmCtx()">😂 Смешно</button>
    <button onclick="addReaction('${msgId}','🔥');rmCtx()">🔥 Огонь</button>
    <button onclick="startReply('${msgId}');rmCtx()">↩️ Ответить</button>
    <button onclick="forwardMessage('${msgId}');rmCtx()">➡️ Переслать</button>
    <button onclick="saveMsg('${msgId}');rmCtx()">⭐ Сохранить</button>
    ${isMine ? `<button onclick="editMessage('${msgId}');rmCtx()">✏️ Изменить</button>` : ''}
    ${currentChatData && (currentChatData.isOwner || currentChatData.isAdmin) ? `<button onclick="pinMessage('${msgId}');rmCtx()">📌 Закрепить</button>` : ''}
    <button onclick="copyMsgText('${msgId}');rmCtx()">📋 Копировать</button>
    <button class="danger" onclick="deleteMsgById('${msgId}');rmCtx()">🗑️ Удалить</button>
  `;
  const rect = msgEl.getBoundingClientRect();
  menu.style.left = Math.min(rect.left, window.innerWidth - 240) + 'px';
  menu.style.top = Math.min(rect.top, window.innerHeight - 420) + 'px';
  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 50);
}

function rmCtx() { const m = $('msgContextMenu'); if (m) m.remove(); }

/* ========== РЕАКЦИИ ========== */
async function addReaction(msgId, emoji) {
  if (!currentChat) return;
  try {
    const endpoint = me.premium ? '/api/premium/animated-react' : `/api/messages/${currentChat}/${msgId}/react`;
    await api(endpoint, { method: 'POST', body: JSON.stringify({ emoji, chatId: currentChat, msgId }) });
  } catch (e) { toast(e.message, 'err'); }
}

/* ========== ОТВЕТЫ ========== */
function startReply(msgId) {
  const msgEl = document.querySelector(`[data-msg-id="${msgId}"]`);
  const text = msgEl ? (msgEl.querySelector('.msg-text') ? msgEl.querySelector('.msg-text').innerText : '') : '';
  replyTarget = { msgId, text };
  showReplyPreview();
}

function showReplyPreview() {
  let preview = $('replyPreview');
  if (!preview) {
    preview = document.createElement('div');
    preview.id = 'replyPreview';
    preview.className = 'reply-preview';
    preview.innerHTML = '<div style="flex:1;min-width:0"><div class="reply-label">Ответ на сообщение</div><div class="reply-text" id="replyPreviewText"></div></div><button onclick="cancelReply()" class="reply-cancel">✕</button>';
    const inputArea = document.querySelector('.input-area');
    inputArea.parentElement.insertBefore(preview, inputArea);
  }
  $('replyPreviewText').innerText = replyTarget.text.substring(0, 100);
  preview.classList.add('show');
}

function cancelReply() {
  replyTarget = null;
  const p = $('replyPreview');
  if (p) p.classList.remove('show');
}

/* ========== РЕДАКТИРОВАНИЕ ========== */
async function editMessage(msgId) {
  const msgEl = document.querySelector(`[data-msg-id="${msgId}"]`);
  if (!msgEl) return;
  const textEl = msgEl.querySelector('.msg-text');
  if (!textEl) return;
  const current = textEl.innerText;
  const newText = prompt('Редактировать:', current);
  if (newText === null || newText.trim() === current) return;
  try {
    await api(`/api/messages/${currentChat}/${msgId}/edit`, {
      method: 'POST',
      body: JSON.stringify({ text: newText.trim() })
    });
    toast('Отредактировано', 'ok');
  } catch (e) { toast(e.message, 'err'); }
}

/* ========== ПЕРЕСЫЛКА ========== */
async function forwardMessage(msgId) {
  try {
    const chats = await api('/api/chats/list/simple');
    let html = `<h3 style="text-align:center">Переслать</h3><div class="list">`;
    html += chats.map(c => `
      <div class="user-card" onclick="doForward('${msgId}','${c.id}')">
        ${avatarHTML(c, 'sm')}
        <div class="info">
          <div class="name">${esc(c.name)}</div>
          <div class="login">${c.type === 'channel' ? 'Канал' : c.type === 'group' ? 'Группа' : 'Личный'}</div>
        </div>
        <button>➡️</button>
      </div>
    `).join('');
    html += `</div><div class="modal-actions"><button class="btn ghost" onclick="closeModal('userModal')">Отмена</button></div>`;
    $('userModalContent').innerHTML = html;
    openModal('userModal');
  } catch (e) { toast(e.message, 'err'); }
}

async function doForward(msgId, toChatId) {
  try {
    await api('/api/messages/forward', {
      method: 'POST',
      body: JSON.stringify({ fromChatId: currentChat, msgId, toChatIds: [toChatId] })
    });
    toast('Переслано', 'ok');
    closeModal('userModal');
  } catch (e) { toast(e.message, 'err'); }
}

/* ========== СОХРАНЕНИЕ ========== */
async function saveMsg(msgId) {
  try {
    await api(`/api/saved/${currentChat}/${msgId}`, { method: 'POST' });
    toast('⭐ Сохранено', 'ok');
  } catch (e) { toast(e.message, 'err'); }
}

async function showSaved() {
  try {
    const list = await api('/api/saved');
    let html = '<h3 style="text-align:center">⭐ Избранное</h3>';
    if (!list.length) html += '<div class="empty">Пусто</div>';
    else html += '<div class="list">' + list.map(s => `
      <div class="user-card">
        <div class="info">
          <div class="name">${esc((s.text || '').substring(0, 100))}</div>
          <div class="login">${fmtRel(s.savedAt)}</div>
        </div>
        <button onclick="unsaveMsg('${s.msgId}')">✕</button>
      </div>
    `).join('') + '</div>';
    $('userModalContent').innerHTML = html + '<div class="modal-actions"><button class="btn ghost" onclick="closeModal(\'userModal\')">Закрыть</button></div>';
    openModal('userModal');
  } catch (e) {}
}

async function unsaveMsg(msgId) {
  try {
    await api('/api/saved/' + msgId, { method: 'DELETE' });
    showSaved();
  } catch (e) {}
}

/* ========== КОПИРОВАНИЕ ========== */
function copyMsgText(msgId) {
  const el = document.querySelector(`[data-msg-id="${msgId}"] .msg-text`);
  if (el && navigator.clipboard) navigator.clipboard.writeText(el.innerText);
  toast('Скопировано', 'ok');
}

/* ========== УДАЛЕНИЕ ========== */
async function deleteMsgById(msgId) {
  if (!confirm('Удалить?')) return;
  try { await api('/api/messages/' + currentChat + '/' + msgId, { method: 'DELETE' }); toast('Удалено', 'ok'); }
  catch (e) { toast(e.message, 'err'); }
}

/* ========== ЗАКРЕПЛЕНИЕ ========== */
async function pinMessage(msgId) {
  try {
    await api(`/api/chats/${currentChat}/pin/${msgId}`, { method: 'POST' });
    toast('Закреплено', 'ok');
    currentChatData = await api('/api/chats/' + currentChat);
    renderPinnedMsg(currentChatData.pinnedMsg);
  } catch (e) { toast(e.message, 'err'); }
}

/* ========== СКРОЛЛ ========== */
function scrollToMsg(msgId) {
  const el = document.querySelector(`[data-msg-id="${msgId}"]`);
  if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('highlight'); setTimeout(() => el.classList.remove('highlight'), 2000); }
}

/* ========== УПОМИНАНИЯ И ХЭШТЕГИ ========== */
async function openUserByLogin(login) {
  try {
    const users = await api('/api/users/search?q=' + encodeURIComponent(login));
    const u = users.find(x => x.login === login.toLowerCase());
    if (u) viewUser(u.uid);
    else toast('Не найден', 'err');
  } catch (e) {}
}

function searchHashtag(tag) {
  const inp = $('chatSearch');
  if (inp) { inp.value = tag; loadChats(); }
  toast('Поиск #' + tag, 'info');
}

/* ========== ОПРОСЫ ========== */
function openPollCreator() {
  $('userModalContent').innerHTML = `
    <h3 style="text-align:center">📊 Создать опрос</h3>
    <div class="fld"><label>Вопрос</label><input id="pollQ" placeholder="Ваш вопрос"></div>
    <div class="fld"><label>Вариант 1</label><input id="pollO1"></div>
    <div class="fld"><label>Вариант 2</label><input id="pollO2"></div>
    <div class="fld"><label>Вариант 3</label><input id="pollO3"></div>
    <div class="fld"><label>Вариант 4</label><input id="pollO4"></div>
    <div style="display:flex;gap:16px;margin-top:12px">
      <label style="display:flex;align-items:center;gap:6px;font-size:13px"><input type="checkbox" id="pollAnon" style="width:auto"> Анонимный</label>
      <label style="display:flex;align-items:center;gap:6px;font-size:13px"><input type="checkbox" id="pollMulti" style="width:auto"> Мультивыбор</label>
    </div>
    <div class="modal-actions">
      <button class="btn ghost" onclick="closeModal('userModal')">Отмена</button>
      <button class="btn" onclick="createPoll()">Создать</button>
    </div>
  `;
  openModal('userModal');
}

async function createPoll() {
  const question = $('pollQ').value.trim();
  const options = ['pollO1','pollO2','pollO3','pollO4'].map(id => $(id).value.trim()).filter(Boolean);
  if (!question) return toast('Введите вопрос', 'err');
  if (options.length < 2) return toast('Мин 2 варианта', 'err');
  try {
    await api(`/api/chats/${currentChat}/polls`, {
      method: 'POST',
      body: JSON.stringify({ question, options, anonymous: $('pollAnon').checked, multiple: $('pollMulti').checked })
    });
    closeModal('userModal');
    toast('Опрос создан', 'ok');
  } catch (e) { toast(e.message, 'err'); }
}

async function votePoll(msgId, idx) {
  try {
    await api(`/api/messages/${currentChat}/${msgId}/vote`, { method: 'POST', body: JSON.stringify({ optionIndex: idx }) });
  } catch (e) { toast(e.message, 'err'); }
}

async function closePoll(msgId) {
  try {
    await api(`/api/messages/${currentChat}/${msgId}/poll-close`, { method: 'POST' });
    toast('Опрос закрыт', 'ok');
  } catch (e) { toast(e.message, 'err'); }
}

/* ========== ГОЛОСОВЫЕ ========== */
let mediaRecorder = null, audioChunks = [], recordingStart = 0, recordingTimer = null;

function toggleVoiceRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') stopVoiceRecording();
  else startVoiceRecording();
}

async function startVoiceRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream);
    audioChunks = [];
    mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
    mediaRecorder.start();
    recordingStart = Date.now();
    $('voiceBtn').classList.add('recording');
    toast('Запись... Нажми ещё раз', 'info');
    recordingTimer = setInterval(() => {
      const sec = Math.floor((Date.now() - recordingStart) / 1000);
      const el = $('voiceTimer');
      if (el) el.innerText = sec + 'с';
    }, 200);
  } catch (e) { toast('Нет доступа к микрофону', 'err'); }
}

function stopVoiceRecording() {
  if (!mediaRecorder) return;
  clearInterval(recordingTimer);
  $('voiceBtn').classList.remove('recording');
  const duration = (Date.now() - recordingStart) / 1000;
  if (duration < 0.5) {
    mediaRecorder.stop();
    mediaRecorder.stream.getTracks().forEach(t => t.stop());
    mediaRecorder = null;
    toast('Слишком коротко', 'err');
    return;
  }
  mediaRecorder.onstop = async () => {
    const blob = new Blob(audioChunks, { type: 'audio/webm' });
    const reader = new FileReader();
    reader.onload = async () => {
      toast('Отправка...', 'info');
      try {
        const up = await api('/api/upload', { method: 'POST', body: JSON.stringify({ data: reader.result, name: 'voice.webm' }) });
        await api('/api/chats/' + currentChat + '/messages', { method: 'POST', body: JSON.stringify({ voice: { url: up.url, duration, type: 'voice' } }) });
        toast('Отправлено', 'ok');
      } catch (e) { toast(e.message, 'err'); }
    };
    reader.readAsDataURL(blob);
  };
  mediaRecorder.stop();
  mediaRecorder.stream.getTracks().forEach(t => t.stop());
  mediaRecorder = null;
}

function playVoice(btn, url) {
  const audio = new Audio(url);
  btn.innerText = '⏸';
  audio.play();
  audio.onended = () => { btn.innerText = '▶'; };
}

/* ========== ПОИСК В ЧАТЕ ========== */
function openChatSearch() {
  let bar = $('chatSearchBar');
  if (bar) { bar.remove(); return; }
  bar = document.createElement('div');
  bar.id = 'chatSearchBar';
  bar.className = 'chat-search-bar';
  bar.innerHTML = '<input id="chatSearchInput" placeholder="Поиск в чате..." oninput="doChatSearch()"><button onclick="openChatSearch()">✕</button>';
  const hdr = document.querySelector('.chat-hdr');
  hdr.after(bar);
  $('chatSearchInput').focus();
}

let chatSearchTimer;
function doChatSearch() {
  clearTimeout(chatSearchTimer);
  chatSearchTimer = setTimeout(async () => {
    const q = $('chatSearchInput').value.trim();
    if (!q) return;
    try {
      const results = await api('/api/chats/' + currentChat + '/search?q=' + encodeURIComponent(q));
      if (!results.length) return toast('Не найдено', 'info');
      scrollToMsg(results[0].id);
      toast('Найдено: ' + results.length, 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }, 400);
}

/* ========== ГЛОБАЛЬНЫЙ ПОИСК ========== */
let searchTimer;
function onSearchInput() { clearTimeout(searchTimer); searchTimer = setTimeout(doSearch, 300); }
function openGlobalSearch() { openModal('searchModal'); setTimeout(() => $('globalSearch').focus(), 300); }

async function doSearch() {
  const q = $('globalSearch').value.trim();
  const results = $('searchResults');
  if (!q) { results.innerHTML = ''; return; }
  try {
    const data = await api('/api/search?q=' + encodeURIComponent(q));
    let html = '';
    if (data.users && data.users.length) {
      html += '<div class="search-section-title">Люди</div>';
      html += data.users.map(u => `<div class="search-item" onclick="closeModal('searchModal');viewUser('${u.uid}')">${avatarHTML(u, 'sm')}<div><div class="search-item-name">${esc(u.name)}${verifHTML(u)}</div><div class="search-item-sub">@${esc(u.login)}</div></div></div>`).join('');
    }
    if (data.chats && data.chats.length) {
      html += '<div class="search-section-title">Каналы и группы</div>';
      html += data.chats.map(c => `<div class="search-item" onclick="closeModal('searchModal');openFoundChat('${c.id}')">${avatarHTML(c, 'sm')}<div><div class="search-item-name">${esc(c.name)}${verifHTML(c)}</div><div class="search-item-sub">${c.type === 'channel' ? 'Канал' : 'Группа'}</div></div></div>`).join('');
    }
    results.innerHTML = html || '<div class="empty">Ничего не найдено</div>';
  } catch (e) { toast(e.message, 'err'); }
}

async function openFoundChat(id) {
  try {
    const c = await api('/api/chats/' + id);
    if (c.isMember) openChat(id);
    else {
      $('userModalContent').innerHTML = `<div class="chat-settings-header">${avatarHTML(c, 'lg')}<div class="chat-settings-name">${esc(c.name)}</div><div class="chat-settings-type">${c.type === 'channel' ? 'Канал' : 'Группа'} · ${(c.members || []).length}</div><div class="profile-bio" style="margin-top:12px">${esc(c.description || '')}</div></div><div class="modal-actions"><button class="btn" onclick="joinChat('${id}')">Вступить</button><button class="btn ghost" onclick="closeModal('userModal')">Отмена</button></div>`;
      openModal('userModal');
    }
  } catch (e) { toast(e.message, 'err'); }
}

async function joinChat(id) {
  try { await api('/api/chats/' + id + '/join', { method: 'POST' }); toast('Вступили!', 'ok'); closeModal('userModal'); openChat(id); loadChats(); }
  catch (e) { toast(e.message, 'err'); }
}
/* ========== ДРУЗЬЯ ========== */
let userSearchTimer;
function onUserSearchInput() { clearTimeout(userSearchTimer); userSearchTimer = setTimeout(doUserSearch, 300); }

async function doUserSearch() {
  const q = $('userSearch').value.trim();
  const box = $('searchList');
  if (!q) { box.innerHTML = ''; return; }
  try {
    const users = await api('/api/users/search?q=' + encodeURIComponent(q));
    box.innerHTML = users.length ? users.map(u => `<div class="user-card">${avatarHTML(u, 'sm')}<div class="info" onclick="viewUser('${u.uid}')"><div class="name">${esc(u.name)}${verifHTML(u)}</div><div class="login">@${esc(u.login)}</div></div><div class="actions"><button onclick="viewUser('${u.uid}')">Открыть</button></div></div>`).join('') : '<div class="empty">Не найдено</div>';
  } catch (e) {}
}

async function loadFriends() {
  try {
    const [friends, requests] = await Promise.all([api('/api/friends'), api('/api/friends/requests')]);
    const fl = $('friendsList');
    if (fl) fl.innerHTML = friends.length ? friends.map(u => `<div class="user-card">${avatarHTML(u, 'sm')}<div class="info" onclick="viewUser('${u.uid}')"><div class="name">${esc(u.name)}${verifHTML(u)}</div><div class="login">@${esc(u.login)}</div></div><div class="actions"><button onclick="startDM('${u.uid}')">Написать</button></div></div>`).join('') : '<div class="empty">Нет друзей</div>';
    const rl = $('requestsList');
    if (rl) rl.innerHTML = requests.length ? '<div class="search-section-title">Заявки</div>' + requests.map(r => `<div class="user-card">${avatarHTML(r.from, 'sm')}<div class="info"><div class="name">${esc(r.from.name)}</div><div class="login">@${esc(r.from.login)}</div></div><div class="actions"><button onclick="acceptFriend('${r.from.uid}')">Принять</button><button class="ghost" onclick="declineFriend('${r.from.uid}')">✕</button></div></div>`).join('') : '';
  } catch (e) {}
}

async function acceptFriend(uid) { try { await api('/api/friends/accept/' + uid, { method: 'POST' }); toast('Друг', 'ok'); loadFriends(); } catch (e) { toast(e.message, 'err'); } }
async function declineFriend(uid) { try { await api('/api/friends/decline/' + uid, { method: 'POST' }); loadFriends(); } catch (e) { toast(e.message, 'err'); } }

/* ========== ПРОФИЛЬ ========== */
async function renderProfile() {
  try {
    const u = me;
    const levelInfo = await api('/api/me/level').catch(() => ({ level: 1, progress: 0 }));
    const achievements = await api('/api/me/achievements').catch(() => []);
    const photo = u.avatar ? `<div class="profile-av" onclick="changeAvatar()"><img src="${u.avatar}"></div>` : `<div class="profile-av" onclick="changeAvatar()" style="background:${u.avatarColor}">${esc(u.avatarText)}</div>`;
    const levelHTML = `<div class="level-badge">Ур. ${levelInfo.level}</div>
      <div class="xp-bar"><div class="xp-progress" style="width:${levelInfo.progress}%"></div></div>`;
    const achievementsHTML = achievements.length ? `<div class="achievements-row">${achievements.slice(0, 5).map(a => `<span class="achv">🏆</span>`).join('')}</div>` : '';
    $('profileWrap').innerHTML = `
      <div class="profile-banner" onclick="changeBanner()" style="${u.banner ? `background-image:url('${u.banner}');background-size:cover` : ''}"></div>
      <div class="profile-content">
        <div class="profile-header">
          ${photo}
          <div class="profile-info">
            <div class="profile-name">${esc(u.name)}${verifHTML(u)}</div>
            <div class="profile-user">@${esc(u.login)}</div>
            ${u.status ? `<div class="profile-status">${esc(u.status)}</div>` : ''}
            <div class="profile-bio">${esc(u.bio || 'Без описания')}</div>
            ${levelHTML}
            ${achievementsHTML}
            <button class="btn small mt" onclick="editProfile()">Редактировать</button>
            <button class="btn small mt" style="margin-left:8px;background:linear-gradient(135deg,#ff8c42,#ff6b1a)" onclick="showMyGifts()">🎁 Подарки</button>
            <button class="btn small mt" style="margin-left:8px" onclick="showSaved()">⭐ Избранное</button>
            <button class="btn small mt" style="margin-left:8px" onclick="showNotes()">📝 Заметки</button>
            ${u.owner ? `<button class="btn small mt" style="margin-left:8px" onclick="openAdminPanel()">⚙️ Админка</button>` : ''}
          </div>
        </div>
        <div class="profile-stats">
          <div class="st"><div class="val">${u.balance || 0} ₽</div><div class="lbl">Баланс</div></div>
          <div class="st"><div class="val" id="statFriends">0</div><div class="lbl">Друзей</div></div>
          <div class="st"><div class="val" id="statPosts">0</div><div class="lbl">Постов</div></div>
        </div>
      </div>
    `;
    api('/api/friends').then(f => { const el = $('statFriends'); if (el) el.innerText = f.length; });
    api('/api/posts').then(p => { const el = $('statPosts'); if (el) el.innerText = p.filter(x => x.from === me.uid).length; });
  } catch (e) {}
}

function editProfile() { $('epName').value = me.name; openModal('editModal'); }
async function saveProfile() { const name = $('epName').value.trim(); if (!name) return toast('Введите имя', 'err'); try { me = await api('/api/profile', { method: 'POST', body: JSON.stringify({ name }) }); closeModal('editModal'); toast('OK', 'ok'); renderProfile(); renderFeedAvatar(); } catch (e) { toast(e.message, 'err'); } }
function changeBio() { $('epBio').value = me.bio || ''; openModal('bioModal'); }
async function saveBio() { const bio = $('epBio').value.trim(); try { me = await api('/api/profile', { method: 'POST', body: JSON.stringify({ bio }) }); closeModal('bioModal'); toast('OK', 'ok'); renderProfile(); } catch (e) { toast(e.message, 'err'); } }

function changeAvatar() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*';
  inp.onchange = async () => {
    const f = inp.files[0]; if (!f) return;
    if (f.size > 5 * 1024 * 1024) return toast('>5MB', 'err');
    toast('Загрузка...', 'info');
    try { const up = await uploadFile(f); me = await api('/api/profile', { method: 'POST', body: JSON.stringify({ avatar: up.url }) }); toast('OK', 'ok'); renderProfile(); renderFeedAvatar(); } catch (e) { toast('Ошибка', 'err'); }
  };
  inp.click();
}

function changeBanner() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*';
  inp.onchange = async () => {
    const f = inp.files[0]; if (!f) return;
    if (f.size > 5 * 1024 * 1024) return toast('>5MB', 'err');
    toast('Загрузка...', 'info');
    try { const up = await uploadFile(f); me = await api('/api/profile', { method: 'POST', body: JSON.stringify({ banner: up.url }) }); toast('OK', 'ok'); renderProfile(); } catch (e) { toast('Ошибка', 'err'); }
  };
  inp.click();
}

async function viewUser(id) {
  if (id === me.uid) { switchTab('profile'); return; }
  try {
    const u = await api('/api/users/' + id);
    const friends = await api('/api/friends');
    const isFriend = friends.some(f => f.uid === id);
    const isBlocked = (me.blocked || []).includes(id);
    const gifts = u.gifts || [];
    $('userModalContent').innerHTML = `
      <div style="text-align:center">
        ${avatarHTML(u, 'lg')}
        <div class="profile-name" style="justify-content:center;margin-top:12px">${esc(u.name)}${verifHTML(u)}</div>
        <div class="profile-user">@${esc(u.login)}</div>
        ${u.status ? `<div class="profile-status">${esc(u.status)}</div>` : ''}
        ${u.bio ? `<div class="profile-bio">${esc(u.bio)}</div>` : ''}
        <div style="color:var(--text2);margin-top:10px;font-size:13px">${u.online ? 'онлайн' : 'был(а) ' + (u.lastSeen ? fmtRel(u.lastSeen) : 'давно')}</div>
        ${gifts.length ? `<div class="user-gifts">${gifts.slice(-12).map(g => `<span class="gift-show" title="${esc(g.fromName || 'Аноним')}">${g.emoji || '🎁'}</span>`).join('')}</div>` : ''}
      </div>
      <div class="modal-actions" style="flex-direction:column">
        <button class="btn" onclick="closeModal('userModal');startDM('${id}')">Написать</button>
        <button class="btn" style="background:linear-gradient(135deg,#ff8c42,#ff6b1a)" onclick="openGiftShop('${id}')">🎁 Подарить</button>
        <button class="btn" style="background:linear-gradient(135deg,#FFD700,#ff8c42);color:#000" onclick="giftPremium('${id}')">⭐ Подарить Premium</button>
        ${!isFriend ? `<button class="btn ghost" onclick="sendFriendRequest('${id}')">+ В друзья</button>` : '<button class="btn ghost" disabled>Уже друг</button>'}
      </div>
      <div class="settings-section">
        <div class="setting-row" onclick="reportUser('${id}')">⚠️ Пожаловаться</div>
        <div class="setting-row" onclick="${isBlocked ? `unblockUser('${id}');closeModal('userModal')` : `blockUser('${id}');closeModal('userModal')`}">${isBlocked ? '✅ Разблокировать' : '🚫 Заблокировать'}</div>
      </div>
    `;
    openModal('userModal');
  } catch (e) { toast(e.message, 'err'); }
}

async function startDM(userId) {
  try {
    const chat = await api('/api/chats/start/' + userId, { method: 'POST' });
    toast(chat.existed ? 'Открываю' : 'Создан', 'ok');
    loadChats();
    setTimeout(() => openChat(chat.id), 300);
  } catch (e) { toast(e.message, 'err'); }
}

async function sendFriendRequest(id) {
  try { await api('/api/friends/request/' + id, { method: 'POST' }); toast('Заявка', 'ok'); closeModal('userModal'); }
  catch (e) { toast(e.message, 'err'); }
}

/* ========== ЧС ========== */
async function blockUser(uid) {
  if (!confirm('Заблокировать?')) return;
  try { await api('/api/users/' + uid + '/block', { method: 'POST' }); toast('Заблокирован', 'ok'); me = await api('/api/me'); }
  catch (e) { toast(e.message, 'err'); }
}

async function unblockUser(uid) {
  try { await api('/api/users/' + uid + '/unblock', { method: 'POST' }); toast('Разблокирован', 'ok'); me = await api('/api/me'); }
  catch (e) { toast(e.message, 'err'); }
}

function showBlacklist() {
  const blocked = me.blocked || [];
  let html = '<h3 style="text-align:center">🚫 Чёрный список</h3>';
  if (!blocked.length) html += '<div class="empty">Пусто</div>';
  else html += '<div id="blockList"></div>';
  $('userModalContent').innerHTML = html;
  openModal('userModal');
  blocked.forEach(async uid => {
    try {
      const u = await api('/api/users/' + uid);
      const box = $('blockList');
      if (box) box.innerHTML += `<div class="user-card">${avatarHTML(u, 'sm')}<div class="info"><div class="name">${esc(u.name)}</div><div class="login">@${esc(u.login)}</div></div><button class="btn small" onclick="unblockUser('${uid}');closeModal('userModal')">Разблок</button></div>`;
    } catch (e) {}
  });
}

/* ========== ЖАЛОБЫ ========== */
function reportUser(userId) {
  $('userModalContent').innerHTML = `<h3 style="text-align:center">Жалоба</h3><div class="fld"><label>Причина</label><select id="reportReason"><option value="spam">Спам</option><option value="abuse">Оскорбления</option><option value="fraud">Мошенничество</option><option value="other">Другое</option></select></div><div class="fld"><label>Текст</label><textarea id="reportText" rows="3"></textarea></div><div class="modal-actions"><button class="btn ghost" onclick="closeModal('userModal')">Отмена</button><button class="btn" onclick="sendReport('user','${userId}')">Отправить</button></div>`;
}

async function sendReport(t, id) {
  const reason = $('reportReason').value;
  const text = $('reportText').value;
  try { await api('/api/report', { method: 'POST', body: JSON.stringify({ targetType: t, targetId: id, reason, text }) }); toast('Жалоба отправлена', 'ok'); closeModal('userModal'); }
  catch (e) { toast(e.message, 'err'); }
}

/* ========== ПОДАРКИ ========== */
async function openGiftShop(toUid) {
  try {
    let targetUser = null;
    if (toUid) targetUser = await api('/api/users/' + toUid);
    const catalog = await api('/api/gifts/catalog');
    const giftsArray = Object.entries(catalog).map(([key, g]) => ({ type: key, ...g }));
    let html = '<h3 style="text-align:center">🎁 Магазин подарков</h3>';
    html += `<div style="text-align:center;color:var(--text2);font-size:13px;margin-bottom:8px">Баланс: <b style="color:var(--primary3)">${me.balance || 0} ₽</b></div>`;
    if (targetUser) html += `<div style="display:flex;align-items:center;gap:12px;background:var(--surface2);padding:12px;border-radius:12px;margin-bottom:16px">${avatarHTML(targetUser, 'sm')}<div><div style="font-weight:600">${esc(targetUser.name)}</div><div style="font-size:12px;color:var(--text2)">@${esc(targetUser.login)}</div></div></div>`;
    html += '<div class="gift-grid">';
    giftsArray.forEach(g => {
      const canAfford = (me.balance || 0) >= g.price;
      html += `<div class="gift-item ${canAfford ? '' : 'disabled'}" onclick="${canAfford && targetUser ? `buyGift('${toUid}','${g.type}')` : ''}">
        <div class="gift-emoji">${g.emoji}</div>
        <div class="gift-name">${g.name}</div>
        <div class="gift-price">${g.price} ₽</div>
      </div>`;
    });
    html += '</div>';
    $('userModalContent').innerHTML = html + '<div class="modal-actions"><button class="btn ghost" onclick="closeModal(\'userModal\')">Закрыть</button></div>';
    openModal('userModal');
  } catch (e) { toast(e.message, 'err'); }
}

async function buyGift(toUid, giftType) {
  try {
    await api('/api/buy/gift', { method: 'POST', body: JSON.stringify({ toUid, giftType }) });
    me = await api('/api/me');
    toast('🎁 Подарок отправлен!', 'ok');
    closeModal('userModal');
    if (currentTab === 'profile') renderProfile();
  } catch (e) { toast(e.message, 'err'); }
}

async function showMyGifts() {
  try {
    const gifts = await api('/api/my/gifts');
    let html = '<h3 style="text-align:center">🎁 Мои подарки</h3>';
    if (!gifts.length) html += '<div class="empty">Пусто. Попроси друзей!</div>';
    else {
      html += `<div style="text-align:center;color:var(--text2);font-size:13px;margin-bottom:12px">Всего: ${gifts.length}</div>`;
      html += '<div class="gift-grid">';
      html += gifts.slice().reverse().map(g => `<div class="gift-item">
        <div class="gift-emoji">${g.emoji || '🎁'}</div>
        <div class="gift-name">от ${esc(g.fromName || 'Аноним')}</div>
        <div class="gift-price">${fmtRel(g.time)}</div>
      </div>`).join('');
      html += '</div>';
    }
    $('userModalContent').innerHTML = html + '<div class="modal-actions"><button class="btn ghost" onclick="closeModal(\'userModal\')">Закрыть</button></div>';
    openModal('userModal');
  } catch (e) { toast(e.message, 'err'); }
}

async function giftPremium(toUid) {
  if (!confirm('Подарить Premium за 500 ₽?')) return;
  try {
    await api('/api/premium/gift', { method: 'POST', body: JSON.stringify({ toUid }) });
    me = await api('/api/me');
    toast('⭐ Premium подарен!', 'ok');
    closeModal('userModal');
  } catch (e) { toast(e.message, 'err'); }
}

/* ========== PREMIUM ========== */
async function renderPremiumPage() {
  const content = $('premiumContent');
  if (!content) return;
  try {
    const status = await api('/api/premium/status');
    const isPrem = status.premium;
    let html = `<div class="premium-hero"><svg viewBox="0 0 24 24" class="premium-crown"><use href="#i-crown"/></svg><div class="premium-title">Train Premium</div><div class="premium-sub">${isPrem ? 'Активен с ' + new Date(status.since).toLocaleDateString('ru') : 'Открой все возможности'}</div></div>`;
    if (isPrem) {
      html += `<div class="settings-section"><div class="settings-section-title">Ваши преимущества</div>
        <div class="setting-row"><span>✅</span><span>Галочка верификации</span></div>
        <div class="setting-row"><span>✅</span><span>Золотая звезда в профиле</span></div>
        <div class="setting-row"><span>✅</span><span>+100% рублей (2 ₽ за сообщение)</span></div>
        <div class="setting-row"><span>✅</span><span>Анимированные реакции</span></div>
        <div class="setting-row"><span>✅</span><span>Эксклюзивные стикеры и эмодзи</span></div>
        <div class="setting-row"><span>✅</span><span>Свой цвет имени</span></div>
        <div class="setting-row"><span>✅</span><span>Без рекламы</span></div>
      </div>
      <div class="settings-section"><button class="btn" onclick="toast('Premium активен', 'ok')">⭐ Активен</button></div>`;
    } else {
      html += `<div class="premium-features">
        <div class="premium-feature"><div class="pf-icon">⭐</div><div><div class="pf-title">Галочка верификации</div><div class="pf-sub">Выделяйся</div></div></div>
        <div class="premium-feature"><div class="pf-icon">👑</div><div><div class="pf-title">Золотая звезда</div><div class="pf-sub">Покажи статус</div></div></div>
        <div class="premium-feature"><div class="pf-icon">💰</div><div><div class="pf-title">+100% рублей</div><div class="pf-sub">2 ₽ за сообщение</div></div></div>
        <div class="premium-feature"><div class="pf-icon">🔥</div><div><div class="pf-title">Анимированные реакции</div></div></div>
        <div class="premium-feature"><div class="pf-icon">🎨</div><div><div class="pf-title">Эксклюзивные стикеры</div></div></div>
      </div>
      <div class="premium-price"><div class="price-val">500 ₽</div><div class="price-sub">навсегда</div></div>
      <div style="text-align:center;color:var(--text2);font-size:13px;margin-bottom:12px">Баланс: <b style="color:var(--primary3)">${me.balance || 0} ₽</b></div>
      ${(me.balance || 0) >= 500 ? `<button class="btn premium-buy" onclick="buyPremium()">Купить за 500 ₽</button>` : `<button class="btn ghost" disabled>Нужно 500 ₽</button>`}`;
    }
    content.innerHTML = html;
  } catch (e) { content.innerHTML = '<div class="empty">Ошибка</div>'; }
}

async function buyPremium() {
  if (!confirm('Купить Premium за 500 ₽?')) return;
  try {
    await api('/api/premium/buy', { method: 'POST' });
    me = await api('/api/me');
    toast('⭐ Premium активирован!', 'ok');
    renderPremiumPage();
    renderProfile();
  } catch (e) { toast(e.message, 'err'); }
}

/* ========== МАГАЗИН ========== */
async function renderGiftsPage() {
  const content = $('giftsContent');
  if (!content) return;
  try {
    const catalog = await api('/api/gifts/catalog');
    const giftsArray = Object.entries(catalog).map(([key, g]) => ({ type: key, ...g }));
    content.innerHTML = `
      <div class="gift-hero"><svg viewBox="0 0 24 24" class="gift-hero-icon"><use href="#i-gift"/></svg><div style="font-size:20px;font-weight:700">Дари эмоции</div><div style="color:var(--text2);font-size:14px;margin-top:6px">Подарки остаются в профиле</div><div style="margin-top:12px;font-size:14px">Баланс: <b style="color:var(--primary3)">${me.balance || 0} ₽</b></div></div>
      <div class="settings-section"><div class="settings-section-title">Кому подарить?</div><div class="fld"><input id="giftSearchLogin" placeholder="@логин" oninput="searchGiftRecipient()"></div><div id="giftRecipientResult"></div></div>
      <div class="settings-section"><div class="settings-section-title">Все подарки (${giftsArray.length})</div><div class="gift-grid">${giftsArray.map(g => `<div class="gift-item"><div class="gift-emoji">${g.emoji}</div><div class="gift-name">${g.name}</div><div class="gift-price">${g.price} ₽</div></div>`).join('')}</div></div>
      <div class="settings-section"><button class="btn" onclick="showMyGifts()">🎁 Мои подарки</button></div>
    `;
  } catch (e) { content.innerHTML = '<div class="empty">Ошибка</div>'; }
}

let giftSearchTimer;
function searchGiftRecipient() {
  clearTimeout(giftSearchTimer);
  giftSearchTimer = setTimeout(async () => {
    const q = $('giftSearchLogin').value.trim().toLowerCase().replace('@', '');
    const box = $('giftRecipientResult');
    if (!q) { box.innerHTML = ''; return; }
    try {
      const users = await api('/api/users/search?q=' + encodeURIComponent(q));
      if (!users.length) { box.innerHTML = '<div class="empty" style="padding:12px 0">Не найдено</div>'; return; }
      box.innerHTML = users.map(u => `<div class="user-card" onclick="openGiftShop('${u.uid}')">${avatarHTML(u, 'sm')}<div class="info"><div class="name">${esc(u.name)}${verifHTML(u)}</div><div class="login">@${esc(u.login)}</div></div><button>🎁</button></div>`).join('');
    } catch (e) { box.innerHTML = ''; }
  }, 300);
}

/* ========== ЛЕНТА ========== */
async function loadPosts() {
  try {
    const posts = await api('/api/posts');
    const list = $('postsList');
    if (!posts.length) { list.innerHTML = '<div class="empty">Нет постов</div>'; return; }
    list.innerHTML = posts.map(p => {
      const isMine = p.from === me.uid;
      const liked = p.likes && p.likes.includes(me.uid);
      let mediaHTML = '';
      if (p.media && p.media.length) {
        const cls = p.media.length === 2 ? 'two' : '';
        mediaHTML = `<div class="post-media ${cls}">${p.media.slice(0, 4).map(m => `<div class="m" onclick="openMediaViewer('${m.url}','${m.type}')">${m.type && m.type.startsWith('video') ? `<video src="${m.url}" muted></video>` : `<img src="${m.url}">`}</div>`).join('')}</div>`;
      }
      return `<div class="post-card"><div class="post-hdr">${avatarHTML(p.author, 'sm')}<div class="post-author-wrap" onclick="viewUser('${p.from}')"><div class="post-author">${esc(p.author ? p.author.name : 'Аноним')}${verifHTML(p.author)}</div><div class="post-time">${fmtRel(p.time)}</div></div>${isMine ? `<button class="icon-btn small" onclick="deletePost('${p.id}')">✕</button>` : ''}</div>${p.text ? `<div class="post-text">${esc(p.text)}</div>` : ''}${mediaHTML}<div class="post-actions-row"><button class="${liked ? 'liked' : ''}" onclick="likePost('${p.id}')">♥ ${(p.likes || []).length}</button></div></div>`;
    }).join('');
  } catch (e) {}
}

async function attachPostMedia(e) {
  const files = Array.from(e.target.files);
  for (const f of files) {
    if (f.size > 20 * 1024 * 1024) { toast(f.name + ' > 20MB', 'err'); continue; }
    toast('Загрузка...', 'info');
    try { postMediaQueue.push(await uploadFile(f)); renderPostPreview(); } catch (err) { toast('Ошибка', 'err'); }
  }
  e.target.value = '';
}

function renderPostPreview() { $('postPreview').innerHTML = postMediaQueue.map((m, i) => `<div class="preview-item">${m.type && m.type.startsWith('video') ? `<video src="${m.url}" muted></video>` : `<img src="${m.url}">`}<div class="rm" onclick="removePostMedia(${i})">✕</div></div>`).join(''); }
function removePostMedia(i) { postMediaQueue.splice(i, 1); renderPostPreview(); }

async function createPost() {
  const text = $('postText').value.trim();
  if (!text && !postMediaQueue.length) return toast('Введите текст', 'err');
  try { await api('/api/posts', { method: 'POST', body: JSON.stringify({ text, media: postMediaQueue }) }); $('postText').value = ''; postMediaQueue = []; renderPostPreview(); toast('Опубликовано', 'ok'); loadPosts(); }
  catch (e) { toast(e.message, 'err'); }
}

async function likePost(id) { try { await api('/api/posts/' + id + '/like', { method: 'POST' }); loadPosts(); } catch (e) { toast(e.message, 'err'); } }
async function deletePost(id) { if (!confirm('Удалить?')) return; try { await api('/api/posts/' + id, { method: 'DELETE' }); loadPosts(); } catch (e) { toast(e.message, 'err'); } }

/* ========== НАСТРОЙКИ ЧАТА ========== */
function openChatSettings() {
  if (!currentChatData) return;
  const c = currentChatData;
  const isOwner = c.isOwner;
  const isPersonal = c.type === 'personal';
  const typeLabel = c.type === 'channel' ? 'канал' : c.type === 'group' ? 'группу' : 'чат';
  let html = `<div class="chat-settings-header">${avatarHTML(c)}<div class="chat-settings-name">${esc(c.name)}${verifHTML(c)}</div><div class="chat-settings-type">${isPersonal ? 'Личный чат' : c.type === 'channel' ? 'Канал' : 'Группа'}</div>${c.username ? `<div class="chat-settings-username">@${esc(c.username)}</div>` : ''}</div>`;
  if (isOwner) {
    html += '<div class="settings-section"><div class="settings-section-title">Управление</div>';
    if (!isPersonal) {
      html += `<div class="setting-row" onclick="editChatName()">${svgIcon('edit')}<span>Изменить название</span></div>`;
      html += `<div class="setting-row" onclick="editChatDesc()">${svgIcon('edit')}<span>Описание</span></div>`;
      html += `<div class="setting-row" onclick="editChatUsername()">${svgIcon('at')}<span>@юзернейм</span></div>`;
      html += `<div class="setting-row" onclick="editChatRules()">${svgIcon('shield')}<span>Правила</span></div>`;
    }
    if (c.type === 'channel') html += `<div class="setting-row" onclick="toggleSetting('onlyAdminsPost')">${svgIcon('lock')}<span>Только админы</span><span class="setting-value">${c.settings && c.settings.onlyAdminsPost ? 'Вкл' : 'Выкл'}</span></div>`;
    if (c.type !== 'personal') {
      html += `<div class="setting-row" onclick="toggleSetting('historyVisible')">${svgIcon('eye')}<span>История видна</span><span class="setting-value">${!c.settings || c.settings.historyVisible !== false ? 'Вкл' : 'Выкл'}</span></div>`;
      html += `<div class="setting-row" onclick="openInvites()">${svgIcon('link')}<span>Инвайт-ссылки</span></div>`;
      html += `<div class="setting-row" onclick="openJoinRequests()">${svgIcon('users')}<span>Заявки на вступление</span></div>`;
      html += `<div class="setting-row" onclick="openChatLogs()">${svgIcon('file')}<span>Журнал действий</span></div>`;
      html += `<div class="setting-row" onclick="openSlowMode()">${svgIcon('clock')}<span>Медленный режим</span><span class="setting-value">${c.slowMode || 0}с</span></div>`;
    }
    html += '</div>';
  }
  if (!isPersonal) html += `<div class="settings-section"><div class="settings-section-title">Участники (${(c.members || []).length})</div><div class="members-list" id="membersList"><div class="empty">Загрузка...</div></div></div>`;
  if (!isOwner && !isPersonal) html += `<div class="settings-section"><button class="btn danger" onclick="leaveChat()">Покинуть ${typeLabel}</button></div>`;
  if (isOwner) html += `<div class="settings-section"><button class="btn danger" onclick="deleteChat()">Удалить ${typeLabel}</button></div>`;
  $('chatSettingsContent').innerHTML = html;
  openModal('chatSettingsModal');
  if (!isPersonal) loadMembers();
}

async function loadMembers() {
  const c = currentChatData;
  const box = $('membersList');
  if (!box) return;
  const isOwner = c.isOwner;
  const members = [];
  for (const uid of (c.members || [])) {
    try {
      const u = await api('/api/users/' + uid);
      members.push({ ...u, isOwner: c.owner === uid, isAdmin: (c.admins || []).includes(uid) });
    } catch (e) {}
  }
  box.innerHTML = members.map(m => `<div class="member-row">${avatarHTML(m, 'sm')}<div class="member-info" onclick="closeModal('chatSettingsModal');viewUser('${m.uid}')"><div class="member-name">${esc(m.name)}${verifHTML(m)}${m.isOwner ? '<span class="badge-owner">владелец</span>' : ''}${m.isAdmin ? '<span class="badge-admin">админ</span>' : ''}</div><div class="member-login">@${esc(m.login)}</div></div>${isOwner && !m.isOwner ? `<div class="member-actions">${m.isAdmin ? `<button class="mini-btn" onclick="removeAdmin('${m.uid}')">снять</button>` : `<button class="mini-btn" onclick="addAdmin('${m.uid}')">админ</button>`}<button class="mini-btn danger" onclick="transferOwner('${m.uid}')">владелец</button></div>` : ''}</div>`).join('');
}

async function addAdmin(uid) { try { await api('/api/chats/' + currentChat + '/admins/' + uid, { method: 'POST' }); toast('Админ', 'ok'); currentChatData = await api('/api/chats/' + currentChat); openChatSettings(); } catch (e) { toast(e.message, 'err'); } }
async function removeAdmin(uid) { try { await api('/api/chats/' + currentChat + '/admins/' + uid, { method: 'DELETE' }); toast('Снят', 'ok'); currentChatData = await api('/api/chats/' + currentChat); openChatSettings(); } catch (e) { toast(e.message, 'err'); } }
async function transferOwner(uid) { if (!confirm('Передать права владельца?')) return; try { await api('/api/chats/' + currentChat + '/transfer/' + uid, { method: 'POST' }); toast('Передано', 'ok'); currentChatData = await api('/api/chats/' + currentChat); openChatSettings(); } catch (e) { toast(e.message, 'err'); } }
async function editChatName() { const n = prompt('Новое название:', currentChatData.name); if (!n) return; try { await api('/api/chats/' + currentChat + '/settings', { method: 'POST', body: JSON.stringify({ name: n }) }); toast('OK', 'ok'); currentChatData = await api('/api/chats/' + currentChat); openChat(currentChat); } catch (e) { toast(e.message, 'err'); } }
async function editChatDesc() { const d = prompt('Описание:', currentChatData.description || ''); if (d === null) return; try { await api('/api/chats/' + currentChat + '/settings', { method: 'POST', body: JSON.stringify({ description: d }) }); toast('OK', 'ok'); } catch (e) { toast(e.message, 'err'); } }
async function editChatUsername() { const u = prompt('@юзернейм:', currentChatData.username || ''); if (u === null) return; try { await api('/api/chats/' + currentChat + '/settings', { method: 'POST', body: JSON.stringify({ username: u.toLowerCase() }) }); toast('OK', 'ok'); currentChatData = await api('/api/chats/' + currentChat); openChatSettings(); } catch (e) { toast(e.message, 'err'); } }
async function editChatRules() { const r = prompt('Правила:', currentChatData.rules || ''); if (r === null) return; try { await api('/api/chats/' + currentChat + '/rules', { method: 'POST', body: JSON.stringify({ rules: r }) }); toast('OK', 'ok'); } catch (e) { toast(e.message, 'err'); } }
async function toggleSetting(key) { const cur = currentChatData.settings && currentChatData.settings[key]; const ns = { ...(currentChatData.settings || {}), [key]: !cur }; try { await api('/api/chats/' + currentChat + '/settings', { method: 'POST', body: JSON.stringify({ settings: ns }) }); currentChatData = await api('/api/chats/' + currentChat); openChatSettings(); } catch (e) { toast(e.message, 'err'); } }
async function leaveChat() { if (!confirm('Покинуть?')) return; try { await api('/api/chats/' + currentChat + '/leave', { method: 'POST' }); closeModal('chatSettingsModal'); closeChatMobile(); currentChat = null; currentChatData = null; loadChats(); toast('Вышли', 'info'); } catch (e) { toast(e.message, 'err'); } }
async function deleteChat() { if (!confirm('Удалить навсегда?')) return; try { await api('/api/chats/' + currentChat, { method: 'DELETE' }); closeModal('chatSettingsModal'); closeChatMobile(); currentChat = null; currentChatData = null; loadChats(); toast('Удалено', 'info'); } catch (e) { toast(e.message, 'err'); } }

/* ========== ИНВАЙТЫ ========== */
async function openInvites() {
  try {
    const list = await api('/api/chats/' + currentChat + '/invites');
    let html = '<h3 style="text-align:center">🔗 Инвайт-ссылки</h3>';
    html += '<button class="btn" onclick="createInvite()">+ Создать новую</button>';
    if (list.length) {
      html += '<div class="settings-section">';
      html += list.map(inv => `<div class="invite-row">
        <div class="invite-code">${esc(inv.code)}</div>
        <div class="invite-info">${inv.uses || 0} использований</div>
        <button class="mini-btn" onclick="copyInvite('${inv.code}')">📋</button>
        <button class="mini-btn danger" onclick="deleteInvite('${inv.code}')">✕</button>
      </div>`).join('');
      html += '</div>';
    }
    $('userModalContent').innerHTML = html + '<div class="modal-actions"><button class="btn ghost" onclick="closeModal(\'userModal\')">Закрыть</button></div>';
    openModal('userModal');
  } catch (e) { toast(e.message, 'err'); }
}

async function createInvite() {
  try {
    const r = await api('/api/chats/' + currentChat + '/invite', { method: 'POST' });
    const link = location.origin + '/invite/' + r.code;
    if (navigator.clipboard) navigator.clipboard.writeText(link);
    toast('Ссылка скопирована: ' + r.code, 'ok');
    openInvites();
  } catch (e) { toast(e.message, 'err'); }
}

function copyInvite(code) {
  const link = location.origin + '/invite/' + code;
  if (navigator.clipboard) navigator.clipboard.writeText(link);
  toast('Скопировано', 'ok');
}

async function deleteInvite(code) {
  try { await api('/api/invites/' + code, { method: 'DELETE' }); openInvites(); }
  catch (e) { toast(e.message, 'err'); }
}

async function openJoinRequests() {
  try {
    const list = await api('/api/chats/' + currentChat + '/join-requests');
    let html = '<h3 style="text-align:center">📝 Заявки</h3>';
    if (!list.length) html += '<div class="empty">Нет заявок</div>';
    else html += list.map(r => `<div class="user-card">${avatarHTML(r, 'sm')}<div class="info"><div class="name">${esc(r.name)}</div><div class="login">@${esc(r.login)}</div></div><div class="actions"><button onclick="approveJoin('${r.uid}')">✓</button><button class="ghost" onclick="rejectJoin('${r.uid}')">✕</button></div></div>`).join('');
    $('userModalContent').innerHTML = html + '<div class="modal-actions"><button class="btn ghost" onclick="closeModal(\'userModal\')">Закрыть</button></div>';
    openModal('userModal');
  } catch (e) { toast(e.message, 'err'); }
}

async function approveJoin(uid) { try { await api(`/api/chats/${currentChat}/join-request/${uid}/approve`, { method: 'POST' }); toast('Принят', 'ok'); openJoinRequests(); } catch (e) { toast(e.message, 'err'); } }
async function rejectJoin(uid) { try { await api(`/api/chats/${currentChat}/join-request/${uid}/reject`, { method: 'POST' }); openJoinRequests(); } catch (e) { toast(e.message, 'err'); } }

/* ========== ЛОГ ДЕЙСТВИЙ ========== */
async function openChatLogs() {
  try {
    const list = await api('/api/chats/' + currentChat + '/logs');
    let html = '<h3 style="text-align:center">📜 Журнал</h3>';
    if (!list.length) html += '<div class="empty">Пусто</div>';
    else html += list.slice(0, 50).map(l => `<div class="log-row"><div class="log-name">${esc(l.userName)}</div><div class="log-action">${esc(l.action)}${l.details ? ' — ' + esc(l.details) : ''}</div><div class="log-time">${fmtRel(l.time)}</div></div>`).join('');
    $('userModalContent').innerHTML = html + '<div class="modal-actions"><button class="btn ghost" onclick="closeModal(\'userModal\')">Закрыть</button></div>';
    openModal('userModal');
  } catch (e) { toast(e.message, 'err'); }
}

/* ========== МЕДЛЕННЫЙ РЕЖИМ ========== */
async function openSlowMode() {
  const cur = currentChatData.slowMode || 0;
  const sec = prompt('Медленный режим (секунд, 0 = выкл):', cur);
  if (sec === null) return;
  try { await api('/api/chats/' + currentChat + '/slowmode', { method: 'POST', body: JSON.stringify({ seconds: parseInt(sec) || 0 }) }); toast('OK', 'ok'); } catch (e) { toast(e.message, 'err'); }
}

/* ========== МОДАЛКИ ========== */
function openModal(id) { $(id).classList.remove('hide'); }
function closeModal(id) { $(id).classList.add('hide'); }
function openNewChat() { openModal('newChatModal'); }

async function createChat() {
  const name = $('ncName').value.trim();
  const desc = $('ncDesc').value.trim();
  const username = $('ncUsername').value.trim().toLowerCase();
  const type = $('ncType').value;
  if (!name) return toast('Введите название', 'err');
  try { await api('/api/chats', { method: 'POST', body: JSON.stringify({ name, description: desc, type, username: username || null }) }); closeModal('newChatModal'); $('ncName').value = ''; $('ncDesc').value = ''; $('ncUsername').value = ''; toast('Создано', 'ok'); loadChats(); }
  catch (e) { toast(e.message, 'err'); }
}

function openMediaViewer(url, type) {
  $('mediaViewerContent').innerHTML = type && type.startsWith('video') ? `<video src="${url}" controls autoplay></video>` : `<img src="${url}">`;
  openModal('mediaViewer');
}

/* ========== ЗАМЕТКИ ========== */
async function showNotes() {
  try {
    const list = await api('/api/notes');
    let html = '<h3 style="text-align:center">📝 Заметки</h3>';
    html += '<div class="fld"><input id="noteInput" placeholder="Новая заметка..."><button class="btn small" onclick="createNote()">+</button></div>';
    if (list.length) html += list.map(n => `<div class="user-card"><div class="info"><div class="name">${esc(n.text)}</div><div class="login">${fmtRel(n.time)}</div></div><button onclick="deleteNote('${n.id}')">✕</button></div>`).join('');
    $('userModalContent').innerHTML = html + '<div class="modal-actions"><button class="btn ghost" onclick="closeModal(\'userModal\')">Закрыть</button></div>';
    openModal('userModal');
  } catch (e) {}
}

async function createNote() {
  const text = $('noteInput').value.trim();
  if (!text) return;
  try { await api('/api/notes', { method: 'POST', body: JSON.stringify({ text }) }); showNotes(); }
  catch (e) { toast(e.message, 'err'); }
}

async function deleteNote(id) { try { await api('/api/notes/' + id, { method: 'DELETE' }); showNotes(); } catch (e) {} }

/* ========== АДМИНКА ========== */
async function openAdminPanel() {
  try {
    const stats = await api('/api/admin/stats');
    const premium = await api('/api/admin/premium-list');
    $('userModalContent').innerHTML = `
      <h3 style="text-align:center">⚙️ Админ-панель</h3>
      <div class="admin-stats">
        <div class="as-item"><div class="as-val">${stats.users}</div><div class="as-lbl">Юзеров</div></div>
        <div class="as-item"><div class="as-val">${stats.chats}</div><div class="as-lbl">Чатов</div></div>
        <div class="as-item"><div class="as-val">${stats.posts}</div><div class="as-lbl">Постов</div></div>
        <div class="as-item"><div class="as-val">${stats.reports}</div><div class="as-lbl">Жалоб</div></div>
        <div class="as-item"><div class="as-val">${premium.count}</div><div class="as-lbl">Premium</div></div>
        <div class="as-item"><div class="as-val">${premium.totalRevenue}₽</div><div class="as-lbl">Доход</div></div>
      </div>
      <div class="settings-section"><div class="settings-section-title">Выдать</div>
        <div class="fld"><input id="adminTargetUid" placeholder="UID"></div>
        <div class="setting-row" onclick="adminGrant('verified')">⭐ Галочка</div>
        <div class="setting-row" onclick="adminGrant('premium')">👑 Premium</div>
        <div class="setting-row" onclick="adminGrant('balance')">💰 10000 ₽</div>
        <div class="setting-row" onclick="adminRevoke()">❌ Снять Premium</div>
      </div>`;
    openModal('userModal');
  } catch (e) { toast('Только для владельца проекта', 'err'); }
}

async function adminGrant(type) {
  const uid = $('adminTargetUid').value.trim();
  if (!uid) return toast('Введите UID', 'err');
  try {
    if (type === 'premium') await api('/api/admin/premium/grant', { method: 'POST', body: JSON.stringify({ targetUid: uid }) });
    else {
      const body = { targetUid: uid };
      if (type === 'verified') body.verified = true;
      if (type === 'balance') body.balance = 10000;
      await api('/api/admin/grant', { method: 'POST', body: JSON.stringify(body) });
    }
    toast('Выдано', 'ok');
  } catch (e) { toast(e.message, 'err'); }
}

async function adminRevoke() {
  const uid = $('adminTargetUid').value.trim();
  if (!uid) return toast('Введите UID', 'err');
  try { await api('/api/admin/premium/revoke', { method: 'POST', body: JSON.stringify({ targetUid: uid }) }); toast('Снят', 'ok'); }
  catch (e) { toast(e.message, 'err'); }
}

/* ========== АЧИВКИ ========== */
async function checkAchievements() {
  try { await api('/api/me/check-achievements', { method: 'POST' }); } catch (e) {}
}

/* ========== ЕЖЕДНЕВНЫЕ ========== */
async function claimDaily() {
  try {
    const r = await api('/api/daily/claim', { method: 'POST' });
    toast('🎁 +' + r.bonus + ' ₽! Стрик: ' + r.streak, 'ok');
    me = await api('/api/me');
    renderProfile();
  } catch (e) { toast(e.message, 'err'); }
}

/* ========== НАСТРОЙКИ ========== */
function loadSettingsUI() {
  const theme = localStorage.getItem('train_theme') || 'dark';
  const el = $('themeToggle'); if (el) el.classList.toggle('on', theme === 'dark');
  const bl = $('balanceLabel'); if (bl) bl.innerText = (me.balance || 0) + ' ₽';
  const pl = $('premiumLabel'); if (pl) pl.innerText = me.premium ? '⭐ Активен' : 'Купить за 500 ₽';
}

function toggleTheme() {
  const cur = localStorage.getItem('train_theme') || 'dark';
  const next = cur === 'dark' ? 'light' : 'dark';
  localStorage.setItem('train_theme', next);
  const el = $('themeToggle'); if (el) el.classList.toggle('on', next === 'dark');
  toast(next === 'dark' ? 'Тёмная' : 'Светлая', 'ok');
}

function showWallet() {
  $('walletContent').innerHTML = `<h3 style="text-align:center">💰 Кошелёк</h3><div style="text-align:center;padding:30px 0"><div style="font-size:56px;font-weight:900;background:var(--grad);-webkit-background-clip:text;-webkit-text-fill-color:transparent">${me.balance || 0}</div><div style="color:var(--text2)">рублей</div><div style="color:var(--text2);font-size:12px;margin-top:16px">+1 ₽ за сообщение${me.premium ? ' (+2 ₽ с Premium)' : ''}</div><button class="btn" style="margin-top:16px" onclick="claimDaily();closeModal('walletModal')">🎁 Ежедневный бонус</button></div>`;
  openModal('walletModal');
}

function showPremium() { switchTab('premium'); }
function showMyQR() {
  $('userModalContent').innerHTML = `<h3 style="text-align:center">📱 QR профиля</h3><div style="text-align:center;padding:20px"><div style="font-size:14px;color:var(--text2)">Ссылка</div><div style="font-weight:600;margin-top:8px;font-size:18px">@${esc(me.login)}</div><div style="font-size:12px;color:var(--text2);margin-top:4px">${location.origin}/@${me.login}</div></div>`;
  openModal('userModal');
}

/* ========== СТАРТ ========== */
window.addEventListener('DOMContentLoaded', () => {
  if (idToken) {
    api('/api/me').then(u => { me = u; startApp(); }).catch(() => { localStorage.removeItem('train_id_token'); idToken = null; });
  }
  const lP = $('lPass'); if (lP) lP.addEventListener('keypress', e => { if (e.key === 'Enter') doLogin(); });
  const rP = $('rPass'); if (rP) rP.addEventListener('keypress', e => { if (e.key === 'Enter') doRegister(); });
});

Object.assign(window, {
  switchAuth, doLogin, doRegister, doLogout, switchTab,
  loadChats, openChat, closeChatMobile, sendMessage, onTyping, attachChatMedia, removeAttach,
  openMsgMenu, rmCtx, addReaction, startReply, cancelReply, copyMsgText, deleteMsgById, pinMessage, scrollToMsg,
  editMessage, forwardMessage, doForward, saveMsg, showSaved, unsaveMsg,
  openUserByLogin, searchHashtag,
  openPollCreator, createPoll, votePoll, closePoll,
  toggleVoiceRecording, playVoice, openChatSearch, doChatSearch,
  onSearchInput, openGlobalSearch, doSearch, openFoundChat, joinChat,
  viewUser, startDM, sendFriendRequest, blockUser, unblockUser, showBlacklist, reportUser, sendReport,
  openGiftShop, buyGift, showMyGifts, giftPremium,
  renderPremiumPage, buyPremium, renderGiftsPage, searchGiftRecipient,
  openChatSettings, loadMembers, addAdmin, removeAdmin, transferOwner,
  editChatName, editChatDesc, editChatUsername, editChatRules, toggleSetting, leaveChat, deleteChat,
  openInvites, createInvite, copyInvite, deleteInvite,
  openJoinRequests, approveJoin, rejectJoin, openChatLogs, openSlowMode,
  onUserSearchInput, doUserSearch, loadFriends, acceptFriend, declineFriend,
  loadPosts, attachPostMedia, removePostMedia, createPost, likePost, deletePost,
  renderProfile, editProfile, saveProfile, changeBio, saveBio, changeAvatar, changeBanner,
  loadSettingsUI, toggleTheme, showWallet, showPremium, showMyQR,
  openAdminPanel, adminGrant, adminRevoke, checkAchievements, claimDaily,
  showNotes, createNote, deleteNote,
  openModal, closeModal, openNewChat, createChat, openMediaViewer
});