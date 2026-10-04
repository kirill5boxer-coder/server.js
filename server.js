require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { admin, db, auth } = require('./firebase');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 3000;

const UPLOADS_DIR = path.join(__dirname, '../public/uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, '../public')));

/* ========== MIDDLEWARE ========== */
async function authM(req, res, next) {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Нет токена' });
  try {
    const d = await auth.verifyIdToken(token);
    req.userId = d.uid;
    next();
  } catch (e) { res.status(401).json({ error: 'Токен невалиден' }); }
}

const isOwner = (c, u) => c.owner === u;
const isAdmin = (c, u) => (c.admins || []).includes(u);
const isMember = (c, u) => (c.members || []).includes(u);
const canManage = (c, u) => isOwner(c, u) || isAdmin(c, u);

const GIFT_CATALOG = {
  heart: { emoji: '❤️', name: 'Сердце', price: 50 },
  rose: { emoji: '🌹', name: 'Роза', price: 75 },
  star: { emoji: '⭐', name: 'Звезда', price: 100 },
  cake: { emoji: '🎂', name: 'Торт', price: 150 },
  teddy: { emoji: '🧸', name: 'Мишка', price: 200 },
  fire: { emoji: '🔥', name: 'Огонь', price: 250 },
  rocket: { emoji: '🚀', name: 'Ракета', price: 300 },
  gift: { emoji: '🎁', name: 'Подарок', price: 400 },
  crown: { emoji: '👑', name: 'Корона', price: 500 },
  trophy: { emoji: '🏆', name: 'Кубок', price: 750 },
  diamond: { emoji: '💎', name: 'Алмаз', price: 1000 },
  money: { emoji: '💰', name: 'Мешок', price: 1500 }
};

const clients = new Map();
function sendToUser(userId, data) {
  const set = clients.get(userId);
  if (!set) return;
  const str = JSON.stringify(data);
  set.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(str); });
}

/* ========== PING / HEALTH ========== */
app.get('/api/ping', (req, res) => res.json({ ok: true, v: '6' }));
app.get('/api/health', (req, res) => {
  res.json({ ok: true, server: 'Train Messenger v6.0', uptime: Math.floor(process.uptime()), timestamp: Date.now() });
});

/* ========== РЕГИСТРАЦИЯ ========== */
app.post('/api/register', async (req, res) => {
  try {
    const { email, password, name, login } = req.body;
    if (!email || !password || !name || !login) return res.status(400).json({ error: 'Заполните поля' });
    if (!/^[a-z0-9_]{3,20}$/.test(login)) return res.status(400).json({ error: 'Логин: латиница 3-20' });
    if (password.length < 6) return res.status(400).json({ error: 'Пароль мин 6' });
    const loginSnap = await db.ref('logins/' + login).once('value');
    if (loginSnap.exists()) return res.status(400).json({ error: 'Логин занят' });
    const userRecord = await auth.createUser({ email, password, displayName: name });
    const profile = {
      uid: userRecord.uid, email, name, login,
      avatar: '', avatarText: name[0].toUpperCase(), avatarColor: '#2f7fff',
      bio: '', status: '', socials: {},
      verified: false, owner: login === 'kriptondev',
      balance: 100, premium: false, premiumSince: null,
      joined: Date.now(), online: false, lastSeen: Date.now(),
      lastEarnDate: '', todayEarned: 0, blocked: [], gifts: []
    };
    await db.ref('users/' + userRecord.uid).set(profile);
    await db.ref('logins/' + login).set(userRecord.uid);
    res.json({ uid: userRecord.uid, profile });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ========== ВХОД ========== */
app.post('/api/login', async (req, res) => {
  try {
    const { login, password } = req.body;
    if (!login || !password) return res.status(400).json({ error: 'Заполните' });
    const loginSnap = await db.ref('logins/' + login).once('value');
    if (!loginSnap.exists()) return res.status(400).json({ error: 'Пользователь не найден' });
    const uid = loginSnap.val();
    const userRecord = await auth.getUser(uid);
    const apiKey = 'AIzaSyC0RdmtsTrLyg4Bo2K2DLdciV_yaIqVkZM';
    const r = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + apiKey, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: userRecord.email, password, returnSecureToken: true })
    });
    const data = await r.json();
    if (!r.ok) {
      const msg = data.error?.message;
      if (msg === 'EMAIL_NOT_FOUND') return res.status(400).json({ error: 'Не найден' });
      if (msg && (msg.includes('PASSWORD') || msg.includes('CREDENTIAL'))) return res.status(400).json({ error: 'Неверный пароль' });
      return res.status(400).json({ error: msg || 'Ошибка' });
    }
    const profileSnap = await db.ref('users/' + uid).once('value');
    res.json({ uid, idToken: data.idToken, profile: profileSnap.val() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ========== ПРОФИЛЬ ========== */
app.get('/api/me', authM, async (req, res) => {
  const s = await db.ref('users/' + req.userId).once('value');
  if (!s.exists()) return res.status(404).json({ error: 'Не найден' });
  res.json(s.val());
});

app.post('/api/profile', authM, async (req, res) => {
  const { name, bio, avatar, banner, avatarText, avatarColor, status, socials } = req.body;
  const up = {};
  if (name) up.name = name;
  if (bio !== undefined) up.bio = bio;
  if (avatar !== undefined) up.avatar = avatar;
  if (banner !== undefined) up.banner = banner;
  if (avatarText) up.avatarText = avatarText;
  if (avatarColor) up.avatarColor = avatarColor;
  if (status !== undefined) up.status = status;
  if (socials) up.socials = socials;
  await db.ref('users/' + req.userId).update(up);
  const s = await db.ref('users/' + req.userId).once('value');
  res.json(s.val());
});

/* ========== ПОИСК ========== */
app.get('/api/search', authM, async (req, res) => {
  try {
    const q = (req.query.q || '').toLowerCase().trim();
    if (!q) return res.json({ users: [], chats: [] });
    const usersSnap = await db.ref('users').once('value');
    const users = Object.values(usersSnap.val() || {})
      .filter(u => u.uid !== req.userId)
      .filter(u => (u.name || '').toLowerCase().includes(q) || (u.login || '').toLowerCase().includes(q))
      .slice(0, 20);
    const chatsSnap = await db.ref('chats').once('value');
    const chats = Object.entries(chatsSnap.val() || {})
      .map(([id, c]) => ({ id, ...c }))
      .filter(c => c.type !== 'personal')
      .filter(c => (c.name || '').toLowerCase().includes(q) || (c.username || '').toLowerCase().includes(q))
      .slice(0, 20);
    res.json({ users, chats });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/users/:id', authM, async (req, res) => {
  const s = await db.ref('users/' + req.params.id).once('value');
  if (!s.exists()) return res.status(404).json({ error: 'Не найден' });
  const u = s.val();
  const giftsSnap = await db.ref('users/' + req.params.id + '/gifts').once('value');
  u.gifts = giftsSnap.val() || [];
  res.json(u);
});

app.get('/api/users/search', authM, async (req, res) => {
  try {
    const q = (req.query.q || '').toLowerCase();
    const s = await db.ref('users').once('value');
    const users = Object.values(s.val() || {})
      .filter(u => u.uid !== req.userId)
      .filter(u => !q || (u.name || '').toLowerCase().includes(q) || (u.login || '').includes(q))
      .slice(0, 30);
    res.json(users);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ========== ЧС / ЖАЛОБЫ ========== */
app.post('/api/users/:id/block', authM, async (req, res) => {
  const ref = db.ref('users/' + req.userId);
  const u = (await ref.once('value')).val();
  const blocked = u.blocked || [];
  if (!blocked.includes(req.params.id)) blocked.push(req.params.id);
  await ref.update({ blocked });
  res.json({ ok: true, blocked });
});

app.post('/api/users/:id/unblock', authM, async (req, res) => {
  const ref = db.ref('users/' + req.userId);
  const u = (await ref.once('value')).val();
  const blocked = (u.blocked || []).filter(id => id !== req.params.id);
  await ref.update({ blocked });
  res.json({ ok: true, blocked });
});

app.post('/api/report', authM, async (req, res) => {
  const { targetType, targetId, reason, text } = req.body;
  const report = { from: req.userId, targetType, targetId, reason, text: text || '', time: Date.now(), status: 'new' };
  const ref = db.ref('reports').push();
  await ref.set(report);
  res.json({ ok: true, id: ref.key });
});

/* ========== ЧАТЫ ========== */
app.post('/api/chats/start/:userId', authM, async (req, res) => {
  try {
    const targetId = req.params.userId;
    if (targetId === req.userId) return res.status(400).json({ error: 'Себе нельзя' });
    const targetSnap = await db.ref('users/' + targetId).once('value');
    if (!targetSnap.exists()) return res.status(404).json({ error: 'Не найден' });
    const target = targetSnap.val();
    const me = (await db.ref('users/' + req.userId).once('value')).val();
    if ((target.blocked || []).includes(req.userId)) return res.status(403).json({ error: 'Заблокирован' });
    if ((me.blocked || []).includes(targetId)) return res.status(403).json({ error: 'Вы заблокировали' });
    const myChatsSnap = await db.ref('userChats/' + req.userId).once('value');
    const myIds = myChatsSnap.val() || {};
    for (const cid of Object.keys(myIds)) {
      const c = (await db.ref('chats/' + cid).once('value')).val();
      if (c && c.type === 'personal' && c.members && c.members.includes(targetId)) {
        return res.json({ id: cid, ...c, existed: true });
      }
    }
    const chatId = 'dm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    const chat = {
      name: target.name, type: 'personal',
      owner: req.userId, admins: [], members: [req.userId, targetId],
      created: Date.now(),
      avatar: target.avatar || '', avatarText: target.avatarText, avatarColor: target.avatarColor,
      lastMsg: 'Начните общение', lastTime: Date.now(),
      settings: { historyVisible: true }, pinnedMsg: null
    };
    await db.ref('chats/' + chatId).set(chat);
    await db.ref('userChats/' + req.userId + '/' + chatId).set(true);
    await db.ref('userChats/' + targetId + '/' + chatId).set(true);
    sendToUser(targetId, { type: 'new_chat', data: { chatId, chat } });
    res.json({ id: chatId, ...chat, existed: false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/chats', authM, async (req, res) => {
  try {
    const snap = await db.ref('userChats/' + req.userId).once('value');
    const ids = snap.val() || {};
    const chats = [];
    for (const cid of Object.keys(ids)) {
      const c = (await db.ref('chats/' + cid).once('value')).val();
      if (!c) continue;
      if (c.type === 'personal') {
        const otherId = (c.members || []).find(id => id !== req.userId);
        if (otherId) {
          const u = (await db.ref('users/' + otherId).once('value')).val();
          if (u) { c.name = u.name; c.avatar = u.avatar; c.avatarText = u.avatarText; c.avatarColor = u.avatarColor; c.otherUid = otherId; }
        }
      }
      chats.push({ id: cid, ...c });
    }
    chats.sort((a, b) => (b.lastTime || 0) - (a.lastTime || 0));
    res.json(chats);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/chats', authM, async (req, res) => {
  try {
    const { name, type, description, username } = req.body;
    if (!name) return res.status(400).json({ error: 'Нужно название' });
    if (type === 'personal') return res.status(400).json({ error: 'Личный создаётся из профиля' });
    if (username) {
      if (!/^[a-z0-9_]{4,20}$/.test(username)) return res.status(400).json({ error: 'Юзернейм: латиница 4-20' });
      const chk = await db.ref('usernames/' + username).once('value');
      if (chk.exists()) return res.status(400).json({ error: 'Юзернейм занят' });
    }
    const chatId = 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    const chat = {
      name, type: type || 'group',
      description: description || '', username: username || '',
      owner: req.userId, admins: [], members: [req.userId],
      created: Date.now(),
      avatar: '', avatarText: name[0].toUpperCase(), avatarColor: '#2f7fff',
      verified: false,
      lastMsg: 'Чат создан', lastTime: Date.now(),
      settings: { onlyAdminsPost: type === 'channel', historyVisible: true, membersVisible: true, slowMode: 0 },
      pinnedMsg: null
    };
    await db.ref('chats/' + chatId).set(chat);
    await db.ref('userChats/' + req.userId + '/' + chatId).set(true);
    if (username) await db.ref('usernames/' + username).set({ type: 'chat', id: chatId });
    res.json({ id: chatId, ...chat });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/chats/:id', authM, async (req, res) => {
  const s = await db.ref('chats/' + req.params.id).once('value');
  if (!s.exists()) return res.status(404).json({ error: 'Не найден' });
  const c = s.val();
  res.json({
    id: req.params.id, ...c,
    isMember: isMember(c, req.userId),
    isAdmin: isAdmin(c, req.userId),
    isOwner: isOwner(c, req.userId)
  });
});

app.post('/api/chats/:id/join', authM, async (req, res) => {
  const ref = db.ref('chats/' + req.params.id);
  const s = await ref.once('value');
  if (!s.exists()) return res.status(404).json({ error: 'Не найден' });
  const c = s.val();
  if (isMember(c, req.userId)) return res.json({ ok: true, already: true });
  const members = c.members || [];
  members.push(req.userId);
  await ref.update({ members });
  await db.ref('userChats/' + req.userId + '/' + req.params.id).set(true);
  sendToUser(c.owner, { type: 'user_joined', data: { chatId: req.params.id, userId: req.userId } });
  res.json({ ok: true });
});

app.post('/api/chats/:id/leave', authM, async (req, res) => {
  const ref = db.ref('chats/' + req.params.id);
  const c = (await ref.once('value')).val();
  if (!c) return res.status(404).json({ error: 'Не найден' });
  if (isOwner(c, req.userId)) return res.status(400).json({ error: 'Владелец не может выйти' });
  const members = (c.members || []).filter(id => id !== req.userId);
  const admins = (c.admins || []).filter(id => id !== req.userId);
  await ref.update({ members, admins });
  await db.ref('userChats/' + req.userId + '/' + req.params.id).remove();
  res.json({ ok: true });
});

app.post('/api/chats/:id/settings', authM, async (req, res) => {
  const ref = db.ref('chats/' + req.params.id);
  const c = (await ref.once('value')).val();
  if (!c) return res.status(404).json({ error: 'Не найден' });
  if (!isOwner(c, req.userId)) return res.status(403).json({ error: 'Только владелец' });
  const { name, description, username, avatar, settings } = req.body;
  const up = {};
  if (name) up.name = name;
  if (description !== undefined) up.description = description;
  if (avatar !== undefined) up.avatar = avatar;
  if (settings) up.settings = { ...(c.settings || {}), ...settings };
  if (username !== undefined && username !== c.username) {
    if (username) {
      if (!/^[a-z0-9_]{4,20}$/.test(username)) return res.status(400).json({ error: 'Юзернейм: латиница 4-20' });
      const chk = await db.ref('usernames/' + username).once('value');
      if (chk.exists() && chk.val().id !== req.params.id) return res.status(400).json({ error: 'Юзернейм занят' });
      if (c.username) await db.ref('usernames/' + c.username).remove();
      await db.ref('usernames/' + username).set({ type: 'chat', id: req.params.id });
    } else if (c.username) {
      await db.ref('usernames/' + c.username).remove();
    }
    up.username = username || '';
  }
  await ref.update(up);
  const ns = await ref.once('value');
  res.json({ id: req.params.id, ...ns.val() });
});

app.post('/api/chats/:id/admins/:userId', authM, async (req, res) => {
  const ref = db.ref('chats/' + req.params.id);
  const c = (await ref.once('value')).val();
  if (!c) return res.status(404).json({ error: 'Не найден' });
  if (!isOwner(c, req.userId)) return res.status(403).json({ error: 'Только владелец' });
  const tid = req.params.userId;
  if (!isMember(c, tid)) return res.status(400).json({ error: 'Не в чате' });
  const admins = c.admins || [];
  if (!admins.includes(tid)) admins.push(tid);
  await ref.update({ admins });
  res.json({ ok: true, admins });
});

app.delete('/api/chats/:id/admins/:userId', authM, async (req, res) => {
  const ref = db.ref('chats/' + req.params.id);
  const c = (await ref.once('value')).val();
  if (!c) return res.status(404).json({ error: 'Не найден' });
  if (!isOwner(c, req.userId)) return res.status(403).json({ error: 'Только владелец' });
  const admins = (c.admins || []).filter(id => id !== req.params.userId);
  await ref.update({ admins });
  res.json({ ok: true, admins });
});

app.post('/api/chats/:id/transfer/:userId', authM, async (req, res) => {
  const ref = db.ref('chats/' + req.params.id);
  const c = (await ref.once('value')).val();
  if (!c) return res.status(404).json({ error: 'Не найден' });
  if (!isOwner(c, req.userId)) return res.status(403).json({ error: 'Только владелец' });
  const tid = req.params.userId;
  if (!isMember(c, tid)) return res.status(400).json({ error: 'Не в чате' });
  await ref.update({ owner: tid });
  res.json({ ok: true });
});

app.delete('/api/chats/:id', authM, async (req, res) => {
  const ref = db.ref('chats/' + req.params.id);
  const c = (await ref.once('value')).val();
  if (!c) return res.status(404).json({ error: 'Не найден' });
  if (!isOwner(c, req.userId)) return res.status(403).json({ error: 'Только владелец' });
  if (c.username) await db.ref('usernames/' + c.username).remove();
  for (const uid of (c.members || [])) {
    await db.ref('userChats/' + uid + '/' + req.params.id).remove();
  }
  await ref.remove();
  await db.ref('messages/' + req.params.id).remove();
  res.json({ ok: true });
});

/* ========== СООБЩЕНИЯ ========== */
app.get('/api/chats/:id/messages', authM, async (req, res) => {
  const cs = await db.ref('chats/' + req.params.id).once('value');
  if (!cs.exists()) return res.status(404).json({ error: 'Не найден' });
  const c = cs.val();
  const isMem = isMember(c, req.userId);
  if (!isMem && c.settings && c.settings.historyVisible === false) {
    return res.json({ messages: [], canPost: false, noHistory: true });
  }
  const snap = await db.ref('messages/' + req.params.id).limitToLast(300).once('value');
  const msgs = snap.val() || {};
  const list = Object.entries(msgs).map(([id, m]) => ({ id, ...m })).sort((a, b) => a.time - b.time);
  res.json({ messages: list, canPost: isMem, isMember: isMem });
});

app.post('/api/chats/:id/messages', authM, async (req, res) => {
  const ref = db.ref('chats/' + req.params.id);
  const c = (await ref.once('value')).val();
  if (!c) return res.status(404).json({ error: 'Не найден' });
  if (!isMember(c, req.userId)) return res.status(403).json({ error: 'Не участник' });
  if (c.type === 'channel' && c.settings && c.settings.onlyAdminsPost && !canManage(c, req.userId)) {
    return res.status(403).json({ error: 'Только админы' });
  }
  const { text, media, voice, replyTo } = req.body;
  if (!text && (!media || !media.length) && !voice) return res.status(400).json({ error: 'Пусто' });
  const msg = {
    from: req.userId, text: text || '', media: media || [], voice: voice || null,
    replyTo: replyTo || null, time: Date.now(), reactions: {}, pinned: false
  };
  const mref = db.ref('messages/' + req.params.id).push();
  await mref.set(msg);
  let lastText = text || '[медиа]';
  if (voice) lastText = '[голосовое]';
  await ref.update({ lastMsg: lastText, lastTime: Date.now() });

  const u = (await db.ref('users/' + req.userId).once('value')).val();
  const today = new Date().toDateString();
  const earn = u.premium ? 2 : 1;
  if (u.lastEarnDate !== today) {
    await db.ref('users/' + req.userId).update({ balance: (u.balance || 0) + earn, lastEarnDate: today, todayEarned: earn });
  } else if ((u.todayEarned || 0) < 200) {
    await db.ref('users/' + req.userId).update({ balance: (u.balance || 0) + earn, todayEarned: (u.todayEarned || 0) + earn });
  }

  const sender = (await db.ref('users/' + req.userId).once('value')).val();
  (c.members || []).forEach(uid => {
    sendToUser(uid, { type: 'new_message', data: { chatId: req.params.id, message: { id: mref.key, ...msg }, sender } });
  });
  res.json({ id: mref.key, ...msg });
});

app.post('/api/messages/:chatId/:msgId/react', authM, async (req, res) => {
  const { emoji } = req.body;
  const { chatId, msgId } = req.params;
  const ref = db.ref('messages/' + chatId + '/' + msgId);
  const m = (await ref.once('value')).val();
  if (!m) return res.status(404).json({ error: 'Не найдено' });
  const reactions = m.reactions || {};
  if (!reactions[emoji]) reactions[emoji] = [];
  const idx = reactions[emoji].indexOf(req.userId);
  if (idx >= 0) {
    reactions[emoji].splice(idx, 1);
    if (reactions[emoji].length === 0) delete reactions[emoji];
  } else reactions[emoji].push(req.userId);
  await ref.update({ reactions });
  const c = (await db.ref('chats/' + chatId).once('value')).val();
  (c && c.members || []).forEach(uid => {
    sendToUser(uid, { type: 'message_updated', data: { chatId, msgId, reactions } });
  });
  res.json({ ok: true, reactions });
});

app.post('/api/messages/:chatId/:msgId/pin', authM, async (req, res) => {
  const { chatId, msgId } = req.params;
  const c = (await db.ref('chats/' + chatId).once('value')).val();
  if (!c) return res.status(404).json({ error: 'Чат не найден' });
  if (!canManage(c, req.userId)) return res.status(403).json({ error: 'Только админ/владелец' });
  const ref = db.ref('messages/' + chatId + '/' + msgId);
  const m = (await ref.once('value')).val();
  if (!m) return res.status(404).json({ error: 'Не найдено' });
  await ref.update({ pinned: !m.pinned });
  (c.members || []).forEach(uid => {
    sendToUser(uid, { type: 'message_updated', data: { chatId, msgId, pinned: !m.pinned } });
  });
  res.json({ ok: true, pinned: !m.pinned });
});

app.get('/api/chats/:id/search', authM, async (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  if (!q) return res.json([]);
  const snap = await db.ref('messages/' + req.params.id).once('value');
  const msgs = snap.val() || {};
  const list = Object.entries(msgs)
    .map(([id, m]) => ({ id, ...m }))
    .filter(m => (m.text || '').toLowerCase().includes(q))
    .sort((a, b) => b.time - a.time)
    .slice(0, 50);
  res.json(list);
});

app.delete('/api/messages/:chatId/:msgId', authM, async (req, res) => {
  const { chatId, msgId } = req.params;
  const c = (await db.ref('chats/' + chatId).once('value')).val();
  if (!c) return res.status(404).json({ error: 'Не найден' });
  const m = (await db.ref('messages/' + chatId + '/' + msgId).once('value')).val();
  if (!m) return res.status(404).json({ error: 'Не найдено' });
  if (m.from !== req.userId && !canManage(c, req.userId)) return res.status(403).json({ error: 'Нет прав' });
  await db.ref('messages/' + chatId + '/' + msgId).remove();
  (c.members || []).forEach(uid => sendToUser(uid, { type: 'message_deleted', data: { chatId, msgId } }));
  res.json({ ok: true });
});

/* ========== ЗАГРУЗКА ========== */
app.post('/api/upload', authM, async (req, res) => {
  const { data, name } = req.body;
  if (!data) return res.status(400).json({ error: 'Нет данных' });
  const m = data.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return res.status(400).json({ error: 'Неверный формат' });
  const mime = m[1];
  const buf = Buffer.from(m[2], 'base64');
  const ext = mime.split('/')[1] ? mime.split('/')[1].split('+')[0] : 'bin';
  const fn = 'u_' + req.userId + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6) + '.' + ext;
  fs.writeFileSync(path.join(UPLOADS_DIR, fn), buf);
  res.json({ url: '/uploads/' + fn, type: mime, name, size: buf.length });
});

/* ========== ДРУЗЬЯ ========== */
app.get('/api/friends', authM, async (req, res) => {
  const s = await db.ref('friends/' + req.userId).once('value');
  const ids = Object.keys(s.val() || {});
  const list = [];
  for (const id of ids) {
    const u = (await db.ref('users/' + id).once('value')).val();
    if (u) list.push(u);
  }
  res.json(list);
});

app.get('/api/friends/requests', authM, async (req, res) => {
  const s = await db.ref('friendRequests/' + req.userId).once('value');
  const reqs = s.val() || {};
  const list = [];
  for (const fromId of Object.keys(reqs)) {
    const u = (await db.ref('users/' + fromId).once('value')).val();
    if (u) list.push({ from: u, time: reqs[fromId].time });
  }
  res.json(list);
});

app.post('/api/friends/request/:userId', authM, async (req, res) => {
  const t = req.params.userId;
  if (t === req.userId) return res.status(400).json({ error: 'Себе нельзя' });
  const chk = await db.ref('friends/' + req.userId + '/' + t).once('value');
  if (chk.exists()) return res.status(400).json({ error: 'Уже друзья' });
  const target = (await db.ref('users/' + t).once('value')).val();
  if (target && (target.blocked || []).includes(req.userId)) return res.status(403).json({ error: 'Заблокирован' });
  await db.ref('friendRequests/' + t + '/' + req.userId).set({ time: Date.now() });
  const me = (await db.ref('users/' + req.userId).once('value')).val();
  sendToUser(t, { type: 'friend_request', data: { from: me } });
  res.json({ ok: true });
});

app.post('/api/friends/accept/:userId', authM, async (req, res) => {
  const f = req.params.userId;
  await db.ref('friendRequests/' + req.userId + '/' + f).remove();
  await db.ref('friends/' + req.userId + '/' + f).set({ since: Date.now() });
  await db.ref('friends/' + f + '/' + req.userId).set({ since: Date.now() });
  sendToUser(f, { type: 'friend_accepted', data: { uid: req.userId } });
  res.json({ ok: true });
});

app.post('/api/friends/decline/:userId', authM, async (req, res) => {
  await db.ref('friendRequests/' + req.userId + '/' + req.params.userId).remove();
  res.json({ ok: true });
});

app.delete('/api/friends/:userId', authM, async (req, res) => {
  await db.ref('friends/' + req.userId + '/' + req.params.userId).remove();
  await db.ref('friends/' + req.params.userId + '/' + req.userId).remove();
  res.json({ ok: true });
});

/* ========== ПОСТЫ ========== */
app.get('/api/posts', authM, async (req, res) => {
  const s = await db.ref('posts').limitToLast(50).once('value');
  const posts = s.val() || {};
  const list = Object.entries(posts).map(([id, p]) => ({ id, ...p })).sort((a, b) => b.time - a.time);
  res.json(list);
});

app.post('/api/posts', authM, async (req, res) => {
  const { text, media } = req.body;
  if (!text && (!media || !media.length)) return res.status(400).json({ error: 'Пусто' });
  const author = (await db.ref('users/' + req.userId).once('value')).val();
  const post = { from: req.userId, author, text: text || '', media: media || [], time: Date.now(), likes: [], comments: [] };
  const ref = db.ref('posts').push();
  await ref.set(post);
  res.json({ id: ref.key, ...post });
});

app.post('/api/posts/:id/like', authM, async (req, res) => {
  const ref = db.ref('posts/' + req.params.id);
  const p = (await ref.once('value')).val();
  if (!p) return res.status(404).json({ error: 'Не найден' });
  const likes = p.likes || [];
  const i = likes.indexOf(req.userId);
  if (i >= 0) likes.splice(i, 1); else likes.push(req.userId);
  await ref.update({ likes });
  res.json({ ok: true, likes });
});

app.delete('/api/posts/:id', authM, async (req, res) => {
  const ref = db.ref('posts/' + req.params.id);
  const p = (await ref.once('value')).val();
  if (p.from !== req.userId) return res.status(403).json({ error: 'Не ваш' });
  await ref.remove();
  res.json({ ok: true });
});

/* ========== ПОДАРКИ ========== */
app.get('/api/gifts/catalog', authM, (req, res) => res.json(GIFT_CATALOG));

app.post('/api/buy/gift', authM, async (req, res) => {
  const { toUid, giftType } = req.body;
  if (!toUid || !giftType) return res.status(400).json({ error: 'Параметры' });
  const gift = GIFT_CATALOG[giftType];
  if (!gift) return res.status(400).json({ error: 'Неизвестный подарок' });
  if (toUid === req.userId) return res.status(400).json({ error: 'Себе нельзя' });
  const meRef = db.ref('users/' + req.userId);
  const me = (await meRef.once('value')).val();
  const target = (await db.ref('users/' + toUid).once('value')).val();
  if (!target) return res.status(404).json({ error: 'Не найден' });
  if ((me.balance || 0) < gift.price) return res.status(400).json({ error: 'Мало средств' });
  await meRef.update({ balance: (me.balance || 0) - gift.price });
  const giftObj = { type: giftType, emoji: gift.emoji, name: gift.name, from: req.userId, fromName: me.name, price: gift.price, time: Date.now() };
  const giftsRef = db.ref('users/' + toUid + '/gifts');
  const list = (await giftsRef.once('value')).val() || [];
  list.push(giftObj);
  await giftsRef.set(list);
  sendToUser(toUid, { type: 'gift_received', data: giftObj });
  res.json({ ok: true, gift: giftObj });
});

app.get('/api/my/gifts', authM, async (req, res) => {
  const s = await db.ref('users/' + req.userId + '/gifts').once('value');
  res.json(s.val() || []);
});

/* ========== ADMIN ========== */
app.get('/api/admin/stats', authM, async (req, res) => {
  const meUser = (await db.ref('users/' + req.userId).once('value')).val();
  if (!meUser || !meUser.owner) return res.status(403).json({ error: 'Только владелец' });
  const usersSnap = await db.ref('users').once('value');
  const chatsSnap = await db.ref('chats').once('value');
  const postsSnap = await db.ref('posts').once('value');
  const reportsSnap = await db.ref('reports').once('value');
  res.json({
    users: Object.keys(usersSnap.val() || {}).length,
    chats: Object.keys(chatsSnap.val() || {}).length,
    posts: Object.keys(postsSnap.val() || {}).length,
    reports: Object.keys(reportsSnap.val() || {}).length
  });
});

app.post('/api/admin/grant', authM, async (req, res) => {
  const meUser = (await db.ref('users/' + req.userId).once('value')).val();
  if (!meUser || !meUser.owner) return res.status(403).json({ error: 'Только владелец' });
  const { targetUid, verified, premium, balance } = req.body;
  if (!targetUid) return res.status(400).json({ error: 'Нужен uid' });
  const up = {};
  if (verified !== undefined) up.verified = verified;
  if (premium !== undefined) up.premium = premium;
  if (balance !== undefined) up.balance = balance;
  await db.ref('users/' + targetUid).update(up);
  res.json({ ok: true });
});

/* ========== WEBSOCKET ========== */
wss.on('connection', async (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token');
  let userId = null;
  try { userId = (await auth.verifyIdToken(token)).uid; } catch (e) { ws.close(); return; }
  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId).add(ws);
  await db.ref('users/' + userId).update({ online: true });
  ws.on('message', async (raw) => {
    try {
      const d = JSON.parse(raw);
      if (d.type === 'typing') {
        const c = (await db.ref('chats/' + d.chatId).once('value')).val();
        const u = (await db.ref('users/' + userId).once('value')).val();
        (c && c.members || []).forEach(uid => {
          if (uid !== userId) sendToUser(uid, { type: 'typing', data: { chatId: d.chatId, name: u.name } });
        });
      }
    } catch (e) {}
  });
  ws.on('close', async () => {
    const set = clients.get(userId);
    if (set) set.delete(ws);
    if (!set || !set.size) {
      await db.ref('users/' + userId).update({ online: false, lastSeen: Date.now() });
    }
  });
});
/* ==========================================
   ПАТЧ 1: РЕДАКТИРОВАНИЕ, ПЕРЕСЫЛКА, УПОМИНАНИЯ
========================================== */

app.post('/api/messages/:chatId/:msgId/edit', authM, async (req, res) => {
  try {
    const { chatId, msgId } = req.params;
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'Пусто' });
    const ref = db.ref('messages/' + chatId + '/' + msgId);
    const m = (await ref.once('value')).val();
    if (!m) return res.status(404).json({ error: 'Не найдено' });
    if (m.from !== req.userId) return res.status(403).json({ error: 'Не ваше' });
    await ref.update({ text, edited: true, editedAt: Date.now() });
    const c = (await db.ref('chats/' + chatId).once('value')).val();
    (c?.members || []).forEach(uid => {
      sendToUser(uid, { type: 'message_updated', data: { chatId, msgId, text, edited: true } });
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/messages/forward', authM, async (req, res) => {
  try {
    const { fromChatId, msgId, toChatIds } = req.body;
    if (!fromChatId || !msgId || !toChatIds?.length) return res.status(400).json({ error: 'Параметры' });
    const srcMsg = (await db.ref('messages/' + fromChatId + '/' + msgId).once('value')).val();
    if (!srcMsg) return res.status(404).json({ error: 'Не найдено' });
    const sender = (await db.ref('users/' + req.userId).once('value')).val();
    for (const toChatId of toChatIds) {
      const chat = (await db.ref('chats/' + toChatId).once('value')).val();
      if (!chat || !(chat.members || []).includes(req.userId)) continue;
      const newMsg = {
        from: req.userId, text: srcMsg.text || '', media: srcMsg.media || [], voice: srcMsg.voice || null,
        forwardedFrom: { chatId: fromChatId, fromName: srcMsg.fromName || 'Пользователь', originalTime: srcMsg.time },
        time: Date.now(), reactions: {}, pinned: false
      };
      const mref = db.ref('messages/' + toChatId).push();
      await mref.set(newMsg);
      await db.ref('chats/' + toChatId).update({ lastMsg: '➡️ ' + (srcMsg.text || '[медиа]').substring(0, 30), lastTime: Date.now() });
      (chat.members || []).forEach(uid => {
        sendToUser(uid, { type: 'new_message', data: { chatId: toChatId, message: { id: mref.key, ...newMsg }, sender } });
      });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/chats/list/simple', authM, async (req, res) => {
  try {
    const snap = await db.ref('userChats/' + req.userId).once('value');
    const ids = Object.keys(snap.val() || {});
    const list = [];
    for (const cid of ids) {
      const c = (await db.ref('chats/' + cid).once('value')).val();
      if (!c) continue;
      let name = c.name;
      if (c.type === 'personal') {
        const otherId = (c.members || []).find(id => id !== req.userId);
        if (otherId) {
          const u = (await db.ref('users/' + otherId).once('value')).val();
          if (u) name = u.name;
        }
      }
      list.push({ id: cid, name, type: c.type, avatar: c.avatar, avatarText: c.avatarText, avatarColor: c.avatarColor });
    }
    res.json(list);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/messages/mention', authM, async (req, res) => {
  try {
    const { chatId, msgId, mentionedLogins } = req.body;
    const chat = (await db.ref('chats/' + chatId).once('value')).val();
    if (!chat) return res.status(404).json({ error: 'Не найден' });
    const sender = (await db.ref('users/' + req.userId).once('value')).val();
    for (const login of mentionedLogins || []) {
      const uidSnap = await db.ref('logins/' + login.toLowerCase()).once('value');
      if (!uidSnap.exists()) continue;
      const uid = uidSnap.val();
      if (uid === req.userId) continue;
      if (!(chat.members || []).includes(uid)) continue;
      sendToUser(uid, { type: 'mention', data: { chatId, msgId, fromName: sender.name, fromUid: req.userId } });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ==========================================
   ПАТЧ 2: ОПРОСЫ
========================================== */

app.post('/api/chats/:id/polls', authM, async (req, res) => {
  try {
    const chat = (await db.ref('chats/' + req.params.id).once('value')).val();
    if (!chat) return res.status(404).json({ error: 'Чат не найден' });
    if (!(chat.members || []).includes(req.userId)) return res.status(403).json({ error: 'Не участник' });
    const { question, options, anonymous, multiple } = req.body;
    if (!question || !options || options.length < 2) return res.status(400).json({ error: 'Минимум 2 варианта' });
    const poll = { question, options: options.map(o => ({ text: o, votes: [] })), anonymous: !!anonymous, multiple: !!multiple, creator: req.userId, created: Date.now() };
    const msg = { from: req.userId, text: '📊 ' + question, poll, time: Date.now(), reactions: {}, pinned: false };
    const mref = db.ref('messages/' + req.params.id).push();
    await mref.set(msg);
    await db.ref('chats/' + req.params.id).update({ lastMsg: '📊 ' + question, lastTime: Date.now() });
    const sender = (await db.ref('users/' + req.userId).once('value')).val();
    (chat.members || []).forEach(uid => {
      sendToUser(uid, { type: 'new_message', data: { chatId: req.params.id, message: { id: mref.key, ...msg }, sender } });
    });
    res.json({ id: mref.key, ...msg });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/messages/:chatId/:msgId/vote', authM, async (req, res) => {
  try {
    const { chatId, msgId } = req.params;
    const { optionIndex } = req.body;
    const ref = db.ref('messages/' + chatId + '/' + msgId);
    const m = (await ref.once('value')).val();
    if (!m || !m.poll) return res.status(404).json({ error: 'Опрос не найден' });
    const poll = m.poll;
    if (optionIndex < 0 || optionIndex >= poll.options.length) return res.status(400).json({ error: 'Неверный вариант' });
    if (!poll.multiple) poll.options.forEach(o => { o.votes = (o.votes || []).filter(v => v !== req.userId); });
    const opt = poll.options[optionIndex];
    opt.votes = opt.votes || [];
    const idx = opt.votes.indexOf(req.userId);
    if (idx >= 0) opt.votes.splice(idx, 1); else opt.votes.push(req.userId);
    await ref.update({ poll });
    const c = (await db.ref('chats/' + chatId).once('value')).val();
    (c?.members || []).forEach(uid => {
      sendToUser(uid, { type: 'message_updated', data: { chatId, msgId, poll } });
    });
    res.json({ ok: true, poll });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/messages/:chatId/:msgId/poll-close', authM, async (req, res) => {
  try {
    const { chatId, msgId } = req.params;
    const ref = db.ref('messages/' + chatId + '/' + msgId);
    const m = (await ref.once('value')).val();
    if (!m || !m.poll) return res.status(404).json({ error: 'Не найден' });
    if (m.poll.creator !== req.userId) return res.status(403).json({ error: 'Не ваш опрос' });
    const poll = { ...m.poll, closed: true };
    await ref.update({ poll });
    const c = (await db.ref('chats/' + chatId).once('value')).val();
    (c?.members || []).forEach(uid => {
      sendToUser(uid, { type: 'message_updated', data: { chatId, msgId, poll } });
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ==========================================
   ПАТЧ 3: УПРАВЛЕНИЕ
========================================== */

app.post('/api/chats/:id/clear', authM, async (req, res) => {
  try {
    const { id } = req.params;
    const { forAll } = req.body;
    const chat = (await db.ref('chats/' + id).once('value')).val();
    if (!chat) return res.status(404).json({ error: 'Не найден' });
    if (!(chat.members || []).includes(req.userId)) return res.status(403).json({ error: 'Не участник' });
    if (forAll) {
      if (!isOwner(chat, req.userId) && !isAdmin(chat, req.userId)) return res.status(403).json({ error: 'Только админ' });
      await db.ref('messages/' + id).remove();
      await db.ref('chats/' + id).update({ lastMsg: 'История очищена', lastTime: Date.now() });
      (chat.members || []).forEach(uid => sendToUser(uid, { type: 'chat_cleared', data: { chatId: id } }));
    } else {
      await db.ref('userCleared/' + req.userId + '/' + id).set({ at: Date.now() });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/messages/bulk-delete', authM, async (req, res) => {
  try {
    const { chatId, msgIds } = req.body;
    const chat = (await db.ref('chats/' + chatId).once('value')).val();
    if (!chat) return res.status(404).json({ error: 'Не найден' });
    if (!canManage(chat, req.userId)) return res.status(403).json({ error: 'Нет прав' });
    for (const mid of msgIds || []) {
      await db.ref('messages/' + chatId + '/' + mid).remove();
      (chat.members || []).forEach(uid => sendToUser(uid, { type: 'message_deleted', data: { chatId, msgId: mid } }));
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/chats/:id/read', authM, async (req, res) => {
  try {
    await db.ref('userRead/' + req.userId + '/' + req.params.id).set({ at: Date.now() });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/chats/unread', authM, async (req, res) => {
  try {
    const readsSnap = await db.ref('userRead/' + req.userId).once('value');
    const reads = readsSnap.val() || {};
    const myChats = (await db.ref('userChats/' + req.userId).once('value')).val() || {};
    const result = {};
    for (const cid of Object.keys(myChats)) {
      const lastRead = reads[cid]?.at || 0;
      const msgsSnap = await db.ref('messages/' + cid).once('value');
      const msgs = Object.values(msgsSnap.val() || {});
      result[cid] = msgs.filter(m => m.time > lastRead && m.from !== req.userId).length;
    }
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/chats/:id/mute', authM, async (req, res) => {
  try {
    const ref = db.ref('userMute/' + req.userId + '/' + req.params.id);
    const cur = (await ref.once('value')).val();
    if (cur?.muted) await ref.remove();
    else await ref.set({ muted: true, at: Date.now() });
    res.json({ ok: true, muted: !cur?.muted });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/chats/:id/archive', authM, async (req, res) => {
  try {
    const ref = db.ref('userArchive/' + req.userId + '/' + req.params.id);
    const cur = (await ref.once('value')).val();
    if (cur) await ref.remove();
    else await ref.set({ archived: true, at: Date.now() });
    res.json({ ok: true, archived: !cur });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/chats/archive/list', authM, async (req, res) => {
  try {
    const snap = await db.ref('userArchive/' + req.userId).once('value');
    res.json(Object.keys(snap.val() || {}));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/chats/:id/slowmode', authM, async (req, res) => {
  try {
    const { seconds } = req.body;
    const ref = db.ref('chats/' + req.params.id);
    const c = (await ref.once('value')).val();
    if (!c) return res.status(404).json({ error: 'Не найден' });
    if (!isOwner(c, req.userId) && !isAdmin(c, req.userId)) return res.status(403).json({ error: 'Только админ' });
    await ref.update({ slowMode: Math.max(0, Math.min(3600, parseInt(seconds) || 0)) });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ==========================================
   ПАТЧ 4: ЗАКРЕПЛЕНИЕ, АНТИСПАМ, ЧС
========================================== */

app.post('/api/chats/:id/pin/:msgId', authM, async (req, res) => {
  try {
    const { id, msgId } = req.params;
    const ref = db.ref('chats/' + id);
    const c = (await ref.once('value')).val();
    if (!c) return res.status(404).json({ error: 'Не найден' });
    if (!canManage(c, req.userId)) return res.status(403).json({ error: 'Только админ' });
    if (c.pinnedMsg?.msgId === msgId) {
      await ref.update({ pinnedMsg: null });
      (c.members || []).forEach(uid => sendToUser(uid, { type: 'chat_pin', data: { chatId: id, pinnedMsg: null } }));
    } else {
      const m = (await db.ref('messages/' + id + '/' + msgId).once('value')).val();
      if (!m) return res.status(404).json({ error: 'Не найдено' });
      const pinnedMsg = { msgId, text: (m.text || '').substring(0, 100), from: m.from, time: m.time };
      await ref.update({ pinnedMsg });
      (c.members || []).forEach(uid => sendToUser(uid, { type: 'chat_pin', data: { chatId: id, pinnedMsg } }));
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/chats/:id/messages-check', authM, async (req, res) => {
  try {
    const c = (await db.ref('chats/' + req.params.id).once('value')).val();
    if (!c) return res.status(404).json({ error: 'Не найден' });
    const spamRef = db.ref('spam/' + req.userId + '/' + req.params.id);
    const spam = (await spamRef.once('value')).val() || { count: 0, lastTime: 0 };
    const now = Date.now();
    if (now - spam.lastTime < 1000) {
      spam.count = (spam.count || 0) + 1;
      if (spam.count > 5) return res.status(429).json({ error: 'Слишком часто' });
    } else spam.count = 1;
    spam.lastTime = now;
    await spamRef.set(spam);
    if (c.slowMode) {
      const lastMsgSnap = await db.ref('messages/' + req.params.id).limitToLast(20).once('value');
      const msgs = Object.values(lastMsgSnap.val() || {});
      const myLast = msgs.filter(m => m.from === req.userId).pop();
      if (myLast && now - myLast.time < c.slowMode * 1000) {
        const wait = Math.ceil((c.slowMode * 1000 - (now - myLast.time)) / 1000);
        return res.status(429).json({ error: `Подожди ${wait}с` });
      }
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/hashtags/search', authM, async (req, res) => {
  try {
    const tag = (req.query.tag || '').toLowerCase().replace('#', '').trim();
    if (!tag) return res.json([]);
    const snap = await db.ref('messages').once('value');
    const allMsgs = snap.val() || {};
    const results = [];
    for (const [chatId, msgs] of Object.entries(allMsgs)) {
      const chat = (await db.ref('chats/' + chatId).once('value')).val();
      if (!chat || !(chat.members || []).includes(req.userId)) continue;
      for (const [mid, m] of Object.entries(msgs)) {
        if (m.text && m.text.toLowerCase().includes('#' + tag)) {
          results.push({ id: mid, chatId, chatName: chat.name, text: m.text, time: m.time, from: m.from });
        }
      }
    }
    results.sort((a, b) => b.time - a.time);
    res.json(results.slice(0, 30));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
/* ==========================================
   ПАТЧ 5: ИНВАЙТЫ, ЗАЯВКИ, ПРАВИЛА
========================================== */

app.post('/api/chats/:id/invite', authM, async (req, res) => {
  try {
    const c = (await db.ref('chats/' + req.params.id).once('value')).val();
    if (!c) return res.status(404).json({ error: 'Не найден' });
    if (!canManage(c, req.userId)) return res.status(403).json({ error: 'Только админ' });
    const code = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
    await db.ref('invites/' + code).set({ chatId: req.params.id, createdBy: req.userId, created: Date.now(), uses: 0 });
    res.json({ ok: true, code, link: '/invite/' + code });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/chats/:id/invites', authM, async (req, res) => {
  try {
    const c = (await db.ref('chats/' + req.params.id).once('value')).val();
    if (!c) return res.status(404).json({ error: 'Не найден' });
    if (!canManage(c, req.userId)) return res.status(403).json({ error: 'Только админ' });
    const snap = await db.ref('invites').once('value');
    const all = snap.val() || {};
    const list = Object.entries(all).filter(([code, inv]) => inv.chatId === req.params.id).map(([code, inv]) => ({ code, ...inv }));
    res.json(list);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/invites/:code', authM, async (req, res) => {
  try {
    const inv = (await db.ref('invites/' + req.params.code).once('value')).val();
    if (!inv) return res.status(404).json({ error: 'Не найден' });
    const c = (await db.ref('chats/' + inv.chatId).once('value')).val();
    if (!c || !canManage(c, req.userId)) return res.status(403).json({ error: 'Нет прав' });
    await db.ref('invites/' + req.params.code).remove();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/invites/:code/join', authM, async (req, res) => {
  try {
    const invRef = db.ref('invites/' + req.params.code);
    const inv = (await invRef.once('value')).val();
    if (!inv) return res.status(404).json({ error: 'Не найден' });
    const chatRef = db.ref('chats/' + inv.chatId);
    const c = (await chatRef.once('value')).val();
    if (!c) return res.status(404).json({ error: 'Чат не найден' });
    if ((c.members || []).includes(req.userId)) return res.json({ ok: true, already: true, chatId: inv.chatId });
    const members = c.members || [];
    members.push(req.userId);
    await chatRef.update({ members });
    await db.ref('userChats/' + req.userId + '/' + inv.chatId).set(true);
    await invRef.update({ uses: (inv.uses || 0) + 1 });
    sendToUser(c.owner, { type: 'user_joined', data: { chatId: inv.chatId, userId: req.userId } });
    res.json({ ok: true, chatId: inv.chatId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/chats/:id/rules', authM, async (req, res) => {
  try {
    const ref = db.ref('chats/' + req.params.id);
    const c = (await ref.once('value')).val();
    if (!c) return res.status(404).json({ error: 'Не найден' });
    if (!canManage(c, req.userId)) return res.status(403).json({ error: 'Только админ' });
    await ref.update({ rules: req.body.rules || '' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/chats/:id/join-request', authM, async (req, res) => {
  try {
    const c = (await db.ref('chats/' + req.params.id).once('value')).val();
    if (!c) return res.status(404).json({ error: 'Не найден' });
    if ((c.members || []).includes(req.userId)) return res.json({ ok: true, already: true });
    if (!c.requireApproval) {
      const members = c.members || [];
      members.push(req.userId);
      await db.ref('chats/' + req.params.id).update({ members });
      await db.ref('userChats/' + req.userId + '/' + req.params.id).set(true);
      return res.json({ ok: true, joined: true });
    }
    const reqUser = (await db.ref('users/' + req.userId).once('value')).val();
    await db.ref('joinRequests/' + req.params.id + '/' + req.userId).set({
      uid: req.userId, name: reqUser.name, login: reqUser.login,
      avatar: reqUser.avatar, avatarText: reqUser.avatarText, avatarColor: reqUser.avatarColor,
      time: Date.now()
    });
    sendToUser(c.owner, { type: 'join_request', data: { chatId: req.params.id, from: reqUser } });
    res.json({ ok: true, requested: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/chats/:id/join-requests', authM, async (req, res) => {
  try {
    const c = (await db.ref('chats/' + req.params.id).once('value')).val();
    if (!c || !canManage(c, req.userId)) return res.status(403).json({ error: 'Нет прав' });
    const snap = await db.ref('joinRequests/' + req.params.id).once('value');
    res.json(Object.values(snap.val() || {}));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/chats/:id/join-request/:uid/approve', authM, async (req, res) => {
  try {
    const c = (await db.ref('chats/' + req.params.id).once('value')).val();
    if (!c || !canManage(c, req.userId)) return res.status(403).json({ error: 'Нет прав' });
    const members = c.members || [];
    if (!members.includes(req.params.uid)) members.push(req.params.uid);
    await db.ref('chats/' + req.params.id).update({ members });
    await db.ref('userChats/' + req.params.uid + '/' + req.params.id).set(true);
    await db.ref('joinRequests/' + req.params.id + '/' + req.params.uid).remove();
    sendToUser(req.params.uid, { type: 'join_approved', data: { chatId: req.params.id } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/chats/:id/join-request/:uid/reject', authM, async (req, res) => {
  try {
    const c = (await db.ref('chats/' + req.params.id).once('value')).val();
    if (!c || !canManage(c, req.userId)) return res.status(403).json({ error: 'Нет прав' });
    await db.ref('joinRequests/' + req.params.id + '/' + req.params.uid).remove();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/chats/:id/require-approval', authM, async (req, res) => {
  try {
    const ref = db.ref('chats/' + req.params.id);
    const c = (await ref.once('value')).val();
    if (!c || !isOwner(c, req.userId)) return res.status(403).json({ error: 'Только владелец' });
    await ref.update({ requireApproval: !c.requireApproval });
    res.json({ ok: true, requireApproval: !c.requireApproval });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ==========================================
   ПАТЧ 6: ЛОГИ, ЗАМЕСТИТЕЛИ
========================================== */

async function logChatAction(chatId, userId, action, details) {
  try {
    const user = (await db.ref('users/' + userId).once('value')).val();
    await db.ref('chatLogs/' + chatId).push().set({ userId, userName: user?.name || 'Unknown', action, details: details || '', time: Date.now() });
  } catch (e) {}
}

app.get('/api/chats/:id/logs', authM, async (req, res) => {
  try {
    const c = (await db.ref('chats/' + req.params.id).once('value')).val();
    if (!c || !canManage(c, req.userId)) return res.status(403).json({ error: 'Нет прав' });
    const snap = await db.ref('chatLogs/' + req.params.id).limitToLast(200).once('value');
    const list = Object.values(snap.val() || {}).sort((a, b) => b.time - a.time);
    res.json(list);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ==========================================
   ПАТЧ 7: КОММЕНТАРИИ, РЕПОСТ, СТАТИСТИКА
========================================== */

app.post('/api/channels/:chatId/:msgId/comment', authM, async (req, res) => {
  try {
    const { chatId, msgId } = req.params;
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'Пусто' });
    const c = (await db.ref('chats/' + chatId).once('value')).val();
    if (!c) return res.status(404).json({ error: 'Не найден' });
    const user = (await db.ref('users/' + req.userId).once('value')).val();
    const comment = { from: req.userId, fromName: user.name, text, time: Date.now(), likes: [] };
    const ref = db.ref('comments/' + chatId + '/' + msgId).push();
    await ref.set(comment);
    (c.members || []).forEach(uid => {
      sendToUser(uid, { type: 'new_comment', data: { chatId, msgId, comment: { id: ref.key, ...comment } } });
    });
    res.json({ id: ref.key, ...comment });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/channels/:chatId/:msgId/comments', authM, async (req, res) => {
  try {
    const snap = await db.ref('comments/' + req.params.chatId + '/' + req.params.msgId).once('value');
    const list = Object.entries(snap.val() || {}).map(([id, c]) => ({ id, ...c })).sort((a, b) => a.time - b.time);
    res.json(list);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/posts/:id/repost', authM, async (req, res) => {
  try {
    const { id } = req.params;
    const { toChatId } = req.body;
    const post = (await db.ref('posts/' + id).once('value')).val();
    if (!post) return res.status(404).json({ error: 'Не найден' });
    const chat = (await db.ref('chats/' + toChatId).once('value')).val();
    if (!chat || !(chat.members || []).includes(req.userId)) return res.status(403).json({ error: 'Нет доступа' });
    const repost = {
      from: req.userId, text: '🔁 Репост от @' + (post.author?.login || 'unknown') + '\n\n' + (post.text || ''),
      media: post.media || [], repostedFrom: { postId: id }, time: Date.now(), reactions: {}, pinned: false
    };
    const mref = db.ref('messages/' + toChatId).push();
    await mref.set(repost);
    await db.ref('chats/' + toChatId).update({ lastMsg: '🔁 Репост', lastTime: Date.now() });
    const sender = (await db.ref('users/' + req.userId).once('value')).val();
    (chat.members || []).forEach(uid => {
      sendToUser(uid, { type: 'new_message', data: { chatId: toChatId, message: { id: mref.key, ...repost }, sender } });
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/channels/:id/stats', authM, async (req, res) => {
  try {
    const c = (await db.ref('chats/' + req.params.id).once('value')).val();
    if (!c) return res.status(404).json({ error: 'Не найден' });
    if (!canManage(c, req.userId)) return res.status(403).json({ error: 'Нет прав' });
    const msgsSnap = await db.ref('messages/' + req.params.id).once('value');
    const msgs = Object.values(msgsSnap.val() || {});
    res.json({
      members: (c.members || []).length, messages: msgs.length,
      reactions: msgs.reduce((s, m) => s + Object.values(m.reactions || {}).reduce((a, v) => a + v.length, 0), 0),
      created: c.created
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ==========================================
   ПАТЧ 8: ПЛАНИРОВЩИК
========================================== */

app.post('/api/chats/:id/schedule', authM, async (req, res) => {
  try {
    const c = (await db.ref('chats/' + req.params.id).once('value')).val();
    if (!c) return res.status(404).json({ error: 'Не найден' });
    if (!canManage(c, req.userId)) return res.status(403).json({ error: 'Только админ' });
    const { text, media, when } = req.body;
    if (!text && !media?.length) return res.status(400).json({ error: 'Пусто' });
    if (!when || when < Date.now()) return res.status(400).json({ error: 'Дата в будущем' });
    const ref = db.ref('scheduled/' + req.params.id).push();
    await ref.set({ id: ref.key, chatId: req.params.id, from: req.userId, text: text || '', media: media || [], when, created: Date.now(), sent: false });
    res.json({ ok: true, id: ref.key });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/chats/:id/scheduled', authM, async (req, res) => {
  try {
    const c = (await db.ref('chats/' + req.params.id).once('value')).val();
    if (!c) return res.status(404).json({ error: 'Не найден' });
    if (!canManage(c, req.userId)) return res.status(403).json({ error: 'Нет прав' });
    const snap = await db.ref('scheduled/' + req.params.id).once('value');
    const list = Object.values(snap.val() || {}).filter(s => !s.sent).sort((a, b) => a.when - b.when);
    res.json(list);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

setInterval(async () => {
  try {
    const now = Date.now();
    const snap = await db.ref('scheduled').once('value');
    const allSched = snap.val() || {};
    for (const [chatId, list] of Object.entries(allSched)) {
      for (const [sid, s] of Object.entries(list)) {
        if (s.sent || s.when > now) continue;
        const chat = (await db.ref('chats/' + chatId).once('value')).val();
        if (!chat) { await db.ref('scheduled/' + chatId + '/' + sid).remove(); continue; }
        const msg = { from: s.from, text: s.text || '', media: s.media || [], time: Date.now(), reactions: {}, pinned: false };
        const mref = db.ref('messages/' + chatId).push();
        await mref.set(msg);
        await db.ref('chats/' + chatId).update({ lastMsg: msg.text || '[медиа]', lastTime: Date.now() });
        const sender = (await db.ref('users/' + s.from).once('value')).val();
        (chat.members || []).forEach(uid => {
          sendToUser(uid, { type: 'new_message', data: { chatId, message: { id: mref.key, ...msg }, sender } });
        });
        await db.ref('scheduled/' + chatId + '/' + sid).update({ sent: true });
      }
    }
  } catch (e) {}
}, 30000);
/* ==========================================
   ПАТЧ 9: УРОВНИ, АЧИВКИ, РЕФЕРАЛКА
========================================== */

async function addXP(userId, amount) {
  try {
    const ref = db.ref('users/' + userId);
    const u = (await ref.once('value')).val();
    if (!u) return;
    const xp = (u.xp || 0) + amount;
    const level = Math.floor(Math.sqrt(xp / 100)) + 1;
    await ref.update({ xp, level });
    if (level > (u.level || 1)) sendToUser(userId, { type: 'level_up', data: { level, xp } });
  } catch (e) {}
}

app.get('/api/me/level', authM, async (req, res) => {
  const u = (await db.ref('users/' + req.userId).once('value')).val();
  const xp = u.xp || 0;
  const level = u.level || 1;
  const xpC = Math.pow(level - 1, 2) * 100;
  const xpN = Math.pow(level, 2) * 100;
  res.json({ xp, level, progress: Math.round(((xp - xpC) / (xpN - xpC)) * 100) });
});

app.post('/api/daily/claim', authM, async (req, res) => {
  try {
    const ref = db.ref('users/' + req.userId);
    const u = (await ref.once('value')).val();
    const today = new Date().toDateString();
    if (u.lastDaily === today) return res.status(400).json({ error: 'Уже получено' });
    const streak = u.streak || 0;
    const bonus = 50 + Math.min(streak * 10, 100);
    const newStreak = (u.lastDaily && new Date(u.lastDaily).getTime() > Date.now() - 2 * 86400000) ? streak + 1 : 1;
    await ref.update({ balance: (u.balance || 0) + bonus, lastDaily: today, streak: newStreak });
    await addXP(req.userId, 20);
    res.json({ ok: true, bonus, streak: newStreak });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ==========================================
   ПАТЧ 10: БЕЗОПАСНОСТЬ, PIN
========================================== */

app.post('/api/security/pin/set', authM, async (req, res) => {
  try {
    const { pin } = req.body;
    if (!pin || pin.length < 4) return res.status(400).json({ error: 'PIN мин 4' });
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update(pin).digest('hex');
    await db.ref('users/' + req.userId).update({ pinHash: hash, pinEnabled: true });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/security/pin/verify', authM, async (req, res) => {
  try {
    const { pin } = req.body;
    const u = (await db.ref('users/' + req.userId).once('value')).val();
    if (!u.pinHash) return res.status(400).json({ error: 'PIN не установлен' });
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update(pin).digest('hex');
    res.json({ ok: hash === u.pinHash });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/security/login-history', authM, async (req, res) => {
  const snap = await db.ref('loginHistory/' + req.userId).limitToLast(50).once('value');
  const list = Object.entries(snap.val() || {}).map(([id, h]) => ({ id, ...h })).sort((a, b) => b.time - a.time);
  res.json(list);
});

/* ==========================================
   ПАТЧ 11: ИСТОРИИ, КЛИПЫ, REELS
========================================== */

app.post('/api/stories', authM, async (req, res) => {
  try {
    const { media, text, bg } = req.body;
    if (!media?.length && !text) return res.status(400).json({ error: 'Пусто' });
    const user = (await db.ref('users/' + req.userId).once('value')).val();
    const story = {
      id: 's_' + Date.now(), from: req.userId,
      author: { uid: user.uid, name: user.name, login: user.login, avatar: user.avatar, avatarText: user.avatarText, avatarColor: user.avatarColor },
      media: media || [], text: text || '', bg: bg || '#2f7fff',
      time: Date.now(), expiresAt: Date.now() + 24 * 3600 * 1000, views: []
    };
    await db.ref('stories/' + story.id).set(story);
    const allUsers = (await db.ref('users').once('value')).val() || {};
    Object.keys(allUsers).forEach(uid => {
      if (uid !== req.userId) sendToUser(uid, { type: 'new_story', data: story });
    });
    res.json(story);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/stories', authM, async (req, res) => {
  const snap = await db.ref('stories').once('value');
  const now = Date.now();
  const list = Object.values(snap.val() || {}).filter(s => s.expiresAt > now);
  const grouped = {};
  list.forEach(s => {
    if (!grouped[s.from]) grouped[s.from] = { user: s.author, items: [] };
    grouped[s.from].items.push(s);
  });
  res.json(Object.values(grouped));
});

app.post('/api/stories/:id/view', authM, async (req, res) => {
  const ref = db.ref('stories/' + req.params.id);
  const s = (await ref.once('value')).val();
  if (!s) return res.status(404).json({ error: 'Не найдена' });
  const views = s.views || [];
  if (!views.includes(req.userId)) { views.push(req.userId); await ref.update({ views }); }
  res.json({ ok: true, views: views.length });
});

app.post('/api/clips', authM, async (req, res) => {
  const { video, title, thumbnail } = req.body;
  if (!video) return res.status(400).json({ error: 'Нужно видео' });
  const user = (await db.ref('users/' + req.userId).once('value')).val();
  const clip = {
    id: 'cl_' + Date.now(), from: req.userId,
    author: { uid: user.uid, name: user.name, login: user.login, avatar: user.avatar, avatarText: user.avatarText, avatarColor: user.avatarColor },
    video, thumbnail: thumbnail || '', title: title || '', time: Date.now(), likes: [], views: 0
  };
  await db.ref('clips/' + clip.id).set(clip);
  res.json(clip);
});

app.get('/api/clips', authM, async (req, res) => {
  const snap = await db.ref('clips').once('value');
  res.json(Object.values(snap.val() || {}).sort((a, b) => b.time - a.time).slice(0, 50));
});

app.post('/api/clips/:id/like', authM, async (req, res) => {
  const ref = db.ref('clips/' + req.params.id);
  const clip = (await ref.once('value')).val();
  if (!clip) return res.status(404).json({ error: 'Не найден' });
  const likes = clip.likes || [];
  const i = likes.indexOf(req.userId);
  if (i >= 0) likes.splice(i, 1); else likes.push(req.userId);
  await ref.update({ likes });
  res.json({ ok: true, likes });
});

/* ==========================================
   ПАТЧ 12: ПАПКИ, ЗАМЕТКИ, ИЗБРАННОЕ
========================================== */

app.post('/api/notes', authM, async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'Пусто' });
  const ref = db.ref('notes/' + req.userId).push();
  await ref.set({ id: ref.key, text, time: Date.now() });
  res.json({ ok: true, id: ref.key });
});

app.get('/api/notes', authM, async (req, res) => {
  const snap = await db.ref('notes/' + req.userId).once('value');
  res.json(Object.values(snap.val() || {}).sort((a, b) => b.time - a.time));
});

app.delete('/api/notes/:id', authM, async (req, res) => {
  await db.ref('notes/' + req.userId + '/' + req.params.id).remove();
  res.json({ ok: true });
});

app.post('/api/saved/:chatId/:msgId', authM, async (req, res) => {
  const m = (await db.ref('messages/' + req.params.chatId + '/' + req.params.msgId).once('value')).val();
  if (!m) return res.status(404).json({ error: 'Не найдено' });
  await db.ref('saved/' + req.userId + '/' + req.params.msgId).set({
    chatId: req.params.chatId, msgId: req.params.msgId, text: m.text, media: m.media, from: m.from, time: m.time, savedAt: Date.now()
  });
  res.json({ ok: true });
});

app.get('/api/saved', authM, async (req, res) => {
  const snap = await db.ref('saved/' + req.userId).once('value');
  res.json(Object.values(snap.val() || {}).sort((a, b) => b.savedAt - a.savedAt));
});

app.delete('/api/saved/:msgId', authM, async (req, res) => {
  await db.ref('saved/' + req.userId + '/' + req.params.msgId).remove();
  res.json({ ok: true });
});

/* ==========================================
   ПАТЧ PREMIUM
========================================== */

const PREMIUM_PRICE = 500;
const PREMIUM_FEATURES = { verified: true, noAds: true, doubleEarnings: true, animatedReactions: true, customEmoji: true, premiumBadge: true, exclusiveStickers: true };

app.post('/api/premium/buy', authM, async (req, res) => {
  try {
    const ref = db.ref('users/' + req.userId);
    const u = (await ref.once('value')).val();
    if (u.premium) return res.status(400).json({ error: 'Уже активен' });
    if ((u.balance || 0) < PREMIUM_PRICE) return res.status(400).json({ error: 'Мало средств' });
    await ref.update({ premium: true, premiumSince: Date.now(), premiumFeatures: PREMIUM_FEATURES, balance: (u.balance || 0) - PREMIUM_PRICE });
    sendToUser(req.userId, { type: 'premium_activated', data: { since: Date.now() } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/premium/status', authM, async (req, res) => {
  const u = (await db.ref('users/' + req.userId).once('value')).val();
  res.json({ premium: !!u.premium, since: u.premiumSince || null });
});

app.post('/api/premium/gift', authM, async (req, res) => {
  try {
    const { toUid } = req.body;
    if (toUid === req.userId) return res.status(400).json({ error: 'Себе нельзя' });
    const meRef = db.ref('users/' + req.userId);
    const me = (await meRef.once('value')).val();
    if ((me.balance || 0) < PREMIUM_PRICE) return res.status(400).json({ error: 'Мало средств' });
    const target = (await db.ref('users/' + toUid).once('value')).val();
    if (!target) return res.status(404).json({ error: 'Не найден' });
    if (target.premium) return res.status(400).json({ error: 'Уже Premium' });
    await meRef.update({ balance: (me.balance || 0) - PREMIUM_PRICE });
    await db.ref('users/' + toUid).update({ premium: true, premiumSince: Date.now(), premiumFeatures: PREMIUM_FEATURES, premiumGiftedBy: req.userId });
    sendToUser(toUid, { type: 'premium_gifted', data: { from: me.name } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/premium-list', authM, async (req, res) => {
  const me = (await db.ref('users/' + req.userId).once('value')).val();
  if (!me.owner) return res.status(403).json({ error: 'Только владелец' });
  const snap = await db.ref('users').once('value');
  const premium = Object.values(snap.val() || {}).filter(u => u.premium);
  res.json({ count: premium.length, totalRevenue: premium.length * PREMIUM_PRICE, list: premium.map(u => ({ uid: u.uid, name: u.name, login: u.login, since: u.premiumSince })) });
});

app.post('/api/admin/premium/grant', authM, async (req, res) => {
  const me = (await db.ref('users/' + req.userId).once('value')).val();
  if (!me.owner) return res.status(403).json({ error: 'Только владелец' });
  const { targetUid } = req.body;
  if (!targetUid) return res.status(400).json({ error: 'Нужен uid' });
  await db.ref('users/' + targetUid).update({ premium: true, premiumSince: Date.now(), premiumFeatures: PREMIUM_FEATURES });
  sendToUser(targetUid, { type: 'premium_activated', data: { since: Date.now() } });
  res.json({ ok: true });
});

app.post('/api/admin/premium/revoke', authM, async (req, res) => {
  const me = (await db.ref('users/' + req.userId).once('value')).val();
  if (!me.owner) return res.status(403).json({ error: 'Только владелец' });
  const { targetUid } = req.body;
  await db.ref('users/' + targetUid).update({ premium: false });
  sendToUser(targetUid, { type: 'premium_revoked', data: {} });
  res.json({ ok: true });
});

/* ==========================================
   ПАТЧ 13: PWA, HEALTH
========================================== */

app.get('/manifest.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.json({
    name: 'Train Messenger', short_name: 'Train', start_url: '/', display: 'standalone',
    theme_color: '#0a1128', background_color: '#0a1128', lang: 'ru',
    icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png' }]
  });
});

app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`
    const CACHE = 'train-v6';
    const ASSETS = ['/', '/index.html', '/style.css', '/app.js'];
    self.addEventListener('install', e => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS).catch(()=>{}))); });
    self.addEventListener('activate', e => { e.waitUntil(clients.claim()); });
    self.addEventListener('fetch', e => {
      if (e.request.method !== 'GET') return;
      if (e.request.url.includes('/api/')) return;
      e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
    });
  `);
});
/* ========== START ========== */
server.listen(PORT, () => {
  console.log('\n========================================');
  console.log('  Train Messenger v6.0');
  console.log('========================================');
  console.log('  Сервер: http://localhost:' + PORT);
  console.log('  Firebase: messeger-d3a9f');
  console.log('========================================\n');
});