/* ==========================================
   ПАТЧ 1: РЕДАКТИРОВАНИЕ, ПЕРЕСЫЛКА, УПОМИНАНИЯ
========================================== */

/* --- Редактировать сообщение --- */
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

/* --- Пересылка сообщений --- */
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
        from: req.userId,
        text: srcMsg.text || '',
        media: srcMsg.media || [],
        voice: srcMsg.voice || null,
        forwardedFrom: { chatId: fromChatId, fromName: srcMsg.fromName || 'Пользователь', originalTime: srcMsg.time },
        time: Date.now(),
        reactions: {},
        pinned: false
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

/* --- Список чатов для пересылки --- */
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

/* --- Упоминания: уведомление --- */
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

/* --- Создать опрос --- */
app.post('/api/chats/:id/polls', authM, async (req, res) => {
  try {
    const chat = (await db.ref('chats/' + req.params.id).once('value')).val();
    if (!chat) return res.status(404).json({ error: 'Чат не найден' });
    if (!(chat.members || []).includes(req.userId)) return res.status(403).json({ error: 'Не участник' });
    const { question, options, anonymous, multiple } = req.body;
    if (!question || !options || options.length < 2) return res.status(400).json({ error: 'Минимум 2 варианта' });
    const poll = {
      question,
      options: options.map(o => ({ text: o, votes: [] })),
      anonymous: !!anonymous,
      multiple: !!multiple,
      creator: req.userId,
      created: Date.now()
    };
    const msg = {
      from: req.userId,
      text: '📊 ' + question,
      poll,
      time: Date.now(),
      reactions: {},
      pinned: false
    };
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

/* --- Голосовать в опросе --- */
app.post('/api/messages/:chatId/:msgId/vote', authM, async (req, res) => {
  try {
    const { chatId, msgId } = req.params;
    const { optionIndex } = req.body;
    const ref = db.ref('messages/' + chatId + '/' + msgId);
    const m = (await ref.once('value')).val();
    if (!m || !m.poll) return res.status(404).json({ error: 'Опрос не найден' });
    const poll = m.poll;
    if (optionIndex < 0 || optionIndex >= poll.options.length) return res.status(400).json({ error: 'Неверный вариант' });
    if (!poll.multiple) {
      poll.options.forEach(o => { o.votes = (o.votes || []).filter(v => v !== req.userId); });
    }
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

/* --- Закрыть опрос (создатель) --- */
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
   ПАТЧ 3: УПРАВЛЕНИЕ СООБЩЕНИЯМИ
========================================== */

/* --- Очистить историю чата --- */
app.post('/api/chats/:id/clear', authM, async (req, res) => {
  try {
    const { id } = req.params;
    const { forAll } = req.body;
    const chat = (await db.ref('chats/' + id).once('value')).val();
    if (!chat) return res.status(404).json({ error: 'Не найден' });
    if (!(chat.members || []).includes(req.userId)) return res.status(403).json({ error: 'Не участник' });

    if (forAll) {
      if (!isOwner(chat, req.userId) && !isAdmin(chat, req.userId)) {
        return res.status(403).json({ error: 'Только админ может очистить для всех' });
      }
      await db.ref('messages/' + id).remove();
      await db.ref('chats/' + id).update({ lastMsg: 'История очищена', lastTime: Date.now() });
      (chat.members || []).forEach(uid => {
        sendToUser(uid, { type: 'chat_cleared', data: { chatId: id } });
      });
    } else {
      await db.ref('userCleared/' + req.userId + '/' + id).set({ at: Date.now() });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* --- Массовое удаление сообщений --- */
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

/* --- Счётчик непрочитанных --- */
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

/* --- Мьют чата --- */
app.post('/api/chats/:id/mute', authM, async (req, res) => {
  try {
    const ref = db.ref('userMute/' + req.userId + '/' + req.params.id);
    const cur = (await ref.once('value')).val();
    if (cur?.muted) await ref.remove();
    else await ref.set({ muted: true, at: Date.now() });
    res.json({ ok: true, muted: !cur?.muted });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* --- Архив чата --- */
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

/* --- Медленный режим --- */
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
   ПАТЧ 4: ЗАКРЕПЛЕНИЕ, АНТИСПАМ, ЧЁРНЫЙ СПИСОК
========================================== */

/* --- Закрепить сообщение сверху чата --- */
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
      if (!m) return res.status(404).json({ error: 'Сообщение не найдено' });
      const pinnedMsg = { msgId, text: (m.text || '').substring(0, 100), from: m.from, time: m.time };
      await ref.update({ pinnedMsg });
      (c.members || []).forEach(uid => sendToUser(uid, { type: 'chat_pin', data: { chatId: id, pinnedMsg } }));
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* --- Антиспам: проверка при отправке --- */
app.post('/api/chats/:id/messages-check', authM, async (req, res) => {
  try {
    const c = (await db.ref('chats/' + req.params.id).once('value')).val();
    if (!c) return res.status(404).json({ error: 'Не найден' });
    const spamRef = db.ref('spam/' + req.userId + '/' + req.params.id);
    const spam = (await spamRef.once('value')).val() || { count: 0, lastTime: 0 };
    const now = Date.now();
    if (now - spam.lastTime < 1000) {
      spam.count = (spam.count || 0) + 1;
      if (spam.count > 5) {
        return res.status(429).json({ error: 'Слишком часто. Подожди 5 секунд.', cooldown: 5000 });
      }
    } else {
      spam.count = 1;
    }
    spam.lastTime = now;
    await spamRef.set(spam);

    if (c.slowMode) {
      const lastMsgSnap = await db.ref('messages/' + req.params.id).limitToLast(20).once('value');
      const msgs = Object.values(lastMsgSnap.val() || {});
      const myLast = msgs.filter(m => m.from === req.userId).pop();
      if (myLast && now - myLast.time < c.slowMode * 1000) {
        const wait = Math.ceil((c.slowMode * 1000 - (now - myLast.time)) / 1000);
        return res.status(429).json({ error: `Медленный режим. Подожди ${wait}с`, cooldown: wait * 1000 });
      }
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* --- Расширенный чёрный список --- */
app.get('/api/users/blocked/list', authM, async (req, res) => {
  try {
    const u = (await db.ref('users/' + req.userId).once('value')).val();
    const blocked = u.blocked || [];
    const list = [];
    for (const uid of blocked) {
      const bu = (await db.ref('users/' + uid).once('value')).val();
      if (bu) list.push({ uid: bu.uid, name: bu.name, login: bu.login, avatar: bu.avatar, avatarText: bu.avatarText, avatarColor: bu.avatarColor });
    }
    res.json(list);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* --- Хэштеги: поиск --- */
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

/* --- Создать инвайт-ссылку --- */
app.post('/api/chats/:id/invite', authM, async (req, res) => {
  try {
    const chatRef = db.ref('chats/' + req.params.id);
    const c = (await chatRef.once('value')).val();
    if (!c) return res.status(404).json({ error: 'Не найден' });
    if (!canManage(c, req.userId)) return res.status(403).json({ error: 'Только админ' });
    const code = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
    await db.ref('invites/' + code).set({
      chatId: req.params.id,
      createdBy: req.userId,
      created: Date.now(),
      uses: 0,
      maxUses: req.body.maxUses || 0,
      expiresAt: req.body.expiresIn ? Date.now() + req.body.expiresIn * 1000 : 0
    });
    res.json({ ok: true, code, link: location + '/invite/' + code });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* --- Получить все инвайты чата --- */
app.get('/api/chats/:id/invites', authM, async (req, res) => {
  try {
    const c = (await db.ref('chats/' + req.params.id).once('value')).val();
    if (!c) return res.status(404).json({ error: 'Не найден' });
    if (!canManage(c, req.userId)) return res.status(403).json({ error: 'Только админ' });
    const snap = await db.ref('invites').once('value');
    const all = snap.val() || {};
    const list = Object.entries(all)
      .filter(([code, inv]) => inv.chatId === req.params.id)
      .map(([code, inv]) => ({ code, ...inv }));
    res.json(list);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* --- Удалить инвайт --- */
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

/* --- Вступить по инвайту --- */
app.post('/api/invites/:code/join', authM, async (req, res) => {
  try {
    const invRef = db.ref('invites/' + req.params.code);
    const inv = (await invRef.once('value')).val();
    if (!inv) return res.status(404).json({ error: 'Инвайт не найден' });
    if (inv.expiresAt && Date.now() > inv.expiresAt) return res.status(400).json({ error: 'Инвайт истёк' });
    if (inv.maxUses && inv.uses >= inv.maxUses) return res.status(400).json({ error: 'Лимит использований' });
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

/* --- Правила группы --- */
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

/* --- Заявки на вступление --- */
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
   ПАТЧ 6: QR, ЗАМЕСТИТЕЛИ, ЛОГ
========================================== */

/* --- QR-приглашение (генерирует код) --- */
app.post('/api/chats/:id/qr-invite', authM, async (req, res) => {
  try {
    const c = (await db.ref('chats/' + req.params.id).once('value')).val();
    if (!c) return res.status(404).json({ error: 'Не найден' });
    if (!canManage(c, req.userId)) return res.status(403).json({ error: 'Только админ' });
    const code = 'qr_' + Math.random().toString(36).slice(2, 12);
    await db.ref('invites/' + code).set({
      chatId: req.params.id, createdBy: req.userId, created: Date.now(),
      uses: 0, isQR: true
    });
    res.json({ ok: true, code, qrData: JSON.stringify({ type: 'train_invite', code }) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* --- Заместители владельца --- */
app.post('/api/chats/:id/deputies/:userId', authM, async (req, res) => {
  try {
    const ref = db.ref('chats/' + req.params.id);
    const c = (await ref.once('value')).val();
    if (!c) return res.status(404).json({ error: 'Не найден' });
    if (!isOwner(c, req.userId)) return res.status(403).json({ error: 'Только владелец' });
    const tid = req.params.userId;
    if (!(c.members || []).includes(tid)) return res.status(400).json({ error: 'Не в чате' });
    const deputies = c.deputies || [];
    if (!deputies.includes(tid)) deputies.push(tid);
    await ref.update({ deputies });
    res.json({ ok: true, deputies });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/chats/:id/deputies/:userId', authM, async (req, res) => {
  try {
    const ref = db.ref('chats/' + req.params.id);
    const c = (await ref.once('value')).val();
    if (!c || !isOwner(c, req.userId)) return res.status(403).json({ error: 'Нет прав' });
    const deputies = (c.deputies || []).filter(id => id !== req.params.userId);
    await ref.update({ deputies });
    res.json({ ok: true, deputies });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* --- Лог действий --- */
async function logChatAction(chatId, userId, action, details) {
  try {
    const user = (await db.ref('users/' + userId).once('value')).val();
    await db.ref('chatLogs/' + chatId).push().set({
      userId, userName: user?.name || 'Unknown', action,
      details: details || '', time: Date.now()
    });
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

app.post('/api/chats/:id/log', authM, async (req, res) => {
  try {
    const c = (await db.ref('chats/' + req.params.id).once('value')).val();
    if (!c) return res.status(404).json({ error: 'Не найден' });
    await logChatAction(req.params.id, req.userId, req.body.action, req.body.details);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* --- Второй владелец (передать совладельца) --- */
app.post('/api/chats/:id/co-owner/:userId', authM, async (req, res) => {
  try {
    const ref = db.ref('chats/' + req.params.id);
    const c = (await ref.once('value')).val();
    if (!c || !isOwner(c, req.userId)) return res.status(403).json({ error: 'Только владелец' });
    const tid = req.params.userId;
    if (!(c.members || []).includes(tid)) return res.status(400).json({ error: 'Не в чате' });
    const coOwners = c.coOwners || [];
    if (!coOwners.includes(tid)) coOwners.push(tid);
    await ref.update({ coOwners });
    await logChatAction(req.params.id, req.userId, 'co_owner_added', tid);
    res.json({ ok: true, coOwners });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
/* ==========================================
   ПАТЧ 7: КОММЕНТАРИИ КАНАЛА + РЕПОСТ
========================================== */

/* --- Комментарии к постам канала --- */
app.post('/api/channels/:chatId/:msgId/comment', authM, async (req, res) => {
  try {
    const { chatId, msgId } = req.params;
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'Пусто' });
    const c = (await db.ref('chats/' + chatId).once('value')).val();
    if (!c) return res.status(404).json({ error: 'Не найден' });

    const user = (await db.ref('users/' + req.userId).once('value')).val();
    const comment = {
      id: 'cm_' + Date.now(),
      from: req.userId, fromName: user.name, fromAvatar: user.avatar,
      fromAvatarText: user.avatarText, fromAvatarColor: user.avatarColor,
      text, time: Date.now(), likes: []
    };
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

app.delete('/api/channels/:chatId/:msgId/comments/:commentId', authM, async (req, res) => {
  try {
    const c = (await db.ref('chats/' + req.params.chatId).once('value')).val();
    if (!c) return res.status(404).json({ error: 'Не найден' });
    const cm = (await db.ref('comments/' + req.params.chatId + '/' + req.params.msgId + '/' + req.params.commentId).once('value')).val();
    if (!cm) return res.status(404).json({ error: 'Не найдено' });
    if (cm.from !== req.userId && !canManage(c, req.userId)) return res.status(403).json({ error: 'Нет прав' });
    await db.ref('comments/' + req.params.chatId + '/' + req.params.msgId + '/' + req.params.commentId).remove();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/channels/:chatId/:msgId/comments/:commentId/like', authM, async (req, res) => {
  try {
    const ref = db.ref('comments/' + req.params.chatId + '/' + req.params.msgId + '/' + req.params.commentId);
    const cm = (await ref.once('value')).val();
    if (!cm) return res.status(404).json({ error: 'Не найдено' });
    const likes = cm.likes || [];
    const i = likes.indexOf(req.userId);
    if (i >= 0) likes.splice(i, 1); else likes.push(req.userId);
    await ref.update({ likes });
    res.json({ ok: true, likes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* --- Репост поста из канала --- */
app.post('/api/posts/:id/repost', authM, async (req, res) => {
  try {
    const { id } = req.params;
    const { toChatId } = req.body;
    const post = (await db.ref('posts/' + id).once('value')).val();
    if (!post) return res.status(404).json({ error: 'Пост не найден' });
    const chat = (await db.ref('chats/' + toChatId).once('value')).val();
    if (!chat || !(chat.members || []).includes(req.userId)) return res.status(403).json({ error: 'Нет доступа' });

    const repost = {
      from: req.userId,
      text: '🔁 Репост от @' + (post.author?.login || 'unknown') + '\n\n' + (post.text || ''),
      media: post.media || [],
      repostedFrom: { postId: id, authorName: post.author?.name, originalTime: post.time },
      time: Date.now(),
      reactions: {}, pinned: false
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

/* --- Реакции на посты канала --- */
app.post('/api/channels/:chatId/:msgId/react', authM, async (req, res) => {
  try {
    const { chatId, msgId } = req.params;
    const { emoji } = req.body;
    const ref = db.ref('messages/' + chatId + '/' + msgId);
    const m = (await ref.once('value')).val();
    if (!m) return res.status(404).json({ error: 'Не найдено' });
    const reactions = m.reactions || {};
    if (!reactions[emoji]) reactions[emoji] = [];
    const idx = reactions[emoji].indexOf(req.userId);
    if (idx >= 0) {
      reactions[emoji].splice(idx, 1);
      if (!reactions[emoji].length) delete reactions[emoji];
    } else reactions[emoji].push(req.userId);
    await ref.update({ reactions });
    const c = (await db.ref('chats/' + chatId).once('value')).val();
    (c?.members || []).forEach(uid => sendToUser(uid, { type: 'message_updated', data: { chatId, msgId, reactions } }));
    res.json({ ok: true, reactions });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* --- Статистика канала --- */
app.get('/api/channels/:id/stats', authM, async (req, res) => {
  try {
    const c = (await db.ref('chats/' + req.params.id).once('value')).val();
    if (!c) return res.status(404).json({ error: 'Не найден' });
    if (!canManage(c, req.userId)) return res.status(403).json({ error: 'Нет прав' });
    const msgsSnap = await db.ref('messages/' + req.params.id).once('value');
    const msgs = Object.values(msgsSnap.val() || {});
    const totalReactions = msgs.reduce((s, m) => s + Object.values(m.reactions || {}).reduce((a, v) => a + v.length, 0), 0);
    const totalViews = msgs.reduce((s, m) => s + (m.views || 0), 0);
    res.json({
      members: (c.members || []).length,
      messages: msgs.length,
      reactions: totalReactions,
      views: totalViews,
      created: c.created,
      growth: msgs.filter(m => Date.now() - m.time < 7 * 86400000).length
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* --- Просмотр сообщения (счётчик) --- */
app.post('/api/channels/:chatId/:msgId/view', authM, async (req, res) => {
  try {
    const ref = db.ref('messages/' + req.params.chatId + '/' + req.params.msgId);
    const m = (await ref.once('value')).val();
    if (!m) return res.status(404).json({ error: 'Не найдено' });
    const views = m.viewedBy || [];
    if (!views.includes(req.userId)) {
      views.push(req.userId);
      await ref.update({ viewedBy: views, views: views.length });
    }
    res.json({ ok: true, views: views.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
/* ==========================================
   ПАТЧ 8: ПЛАНИРОВЩИК + АВТОПОСТИНГ
========================================== */

/* --- Отложенный пост --- */
app.post('/api/chats/:id/schedule', authM, async (req, res) => {
  try {
    const c = (await db.ref('chats/' + req.params.id).once('value')).val();
    if (!c) return res.status(404).json({ error: 'Не найден' });
    if (!canManage(c, req.userId)) return res.status(403).json({ error: 'Только админ' });
    const { text, media, when } = req.body;
    if (!text && !media?.length) return res.status(400).json({ error: 'Пусто' });
    if (!when || when < Date.now()) return res.status(400).json({ error: 'Дата в будущем' });
    const ref = db.ref('scheduled/' + req.params.id).push();
    await ref.set({
      id: ref.key, chatId: req.params.id, from: req.userId,
      text: text || '', media: media || [], when, created: Date.now(), sent: false
    });
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

app.delete('/api/chats/:id/scheduled/:sid', authM, async (req, res) => {
  try {
    const s = (await db.ref('scheduled/' + req.params.id + '/' + req.params.sid).once('value')).val();
    if (!s) return res.status(404).json({ error: 'Не найдено' });
    if (s.from !== req.userId) return res.status(403).json({ error: 'Не ваше' });
    await db.ref('scheduled/' + req.params.id + '/' + req.params.sid).remove();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* --- Автопостинг: RSS-лента --- */
app.post('/api/chats/:id/rss', authM, async (req, res) => {
  try {
    const c = (await db.ref('chats/' + req.params.id).once('value')).val();
    if (!c || !isOwner(c, req.userId)) return res.status(403).json({ error: 'Только владелец' });
    const { url, interval } = req.body;
    if (!url) return res.status(400).json({ error: 'URL обязателен' });
    await db.ref('chats/' + req.params.id).update({
      rss: { url, interval: interval || 3600, lastCheck: 0, enabled: true }
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/chats/:id/rss/toggle', authM, async (req, res) => {
  try {
    const ref = db.ref('chats/' + req.params.id);
    const c = (await ref.once('value')).val();
    if (!c || !isOwner(c, req.userId)) return res.status(403).json({ error: 'Нет прав' });
    if (!c.rss) return res.status(400).json({ error: 'RSS не настроен' });
    await ref.update({ rss: { ...c.rss, enabled: !c.rss.enabled } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* --- Автопостинг: отправка сообщений по расписанию (периодическая функция) --- */
setInterval(async () => {
  try {
    const now = Date.now();
    const snap = await db.ref('scheduled').once('value');
    const allSched = snap.val() || {};
    for (const [chatId, list] of Object.entries(allSched)) {
      for (const [sid, s] of Object.entries(list)) {
        if (s.sent) continue;
        if (s.when > now) continue;
        const chat = (await db.ref('chats/' + chatId).once('value')).val();
        if (!chat) {
          await db.ref('scheduled/' + chatId + '/' + sid).remove();
          continue;
        }
        const msg = {
          from: s.from, text: s.text || '', media: s.media || [],
          time: Date.now(), reactions: {}, pinned: false, scheduled: true
        };
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
  } catch (e) { /* тихо */ }
}, 30000);
/* ==========================================
   ПАТЧ 9: УРОВНИ, ОПЫТ, АЧИВКИ, РЕФЕРАЛКА
========================================== */

/* Начислить опыт */
async function addXP(userId, amount) {
  try {
    const ref = db.ref('users/' + userId);
    const u = (await ref.once('value')).val();
    if (!u) return;
    const xp = (u.xp || 0) + amount;
    const level = Math.floor(Math.sqrt(xp / 100)) + 1;
    const updates = { xp, level };
    if (level > (u.level || 1)) {
      updates.levelUpAt = Date.now();
      sendToUser(userId, { type: 'level_up', data: { level, xp } });
    }
    await ref.update(updates);
  } catch (e) {}
}

/* Получить профиль с уровнем */
app.get('/api/me/level', authM, async (req, res) => {
  const u = (await db.ref('users/' + req.userId).once('value')).val();
  const xp = u.xp || 0;
  const level = u.level || 1;
  const xpForCurrent = Math.pow(level - 1, 2) * 100;
  const xpForNext = Math.pow(level, 2) * 100;
  res.json({
    xp, level,
    xpInLevel: xp - xpForCurrent,
    xpNeeded: xpForNext - xpForCurrent,
    progress: Math.round(((xp - xpForCurrent) / (xpForNext - xpForCurrent)) * 100)
  });
});

/* Ачивки */
const ACHIEVEMENTS = {
  first_msg: { name: 'Первое сообщение', icon: 'msg', xp: 10 },
  ten_msgs: { name: '10 сообщений', icon: 'msg', xp: 50 },
  hundred_msgs: { name: '100 сообщений', icon: 'fire', xp: 500 },
  first_friend: { name: 'Первый друг', icon: 'users', xp: 50 },
  five_friends: { name: '5 друзей', icon: 'users', xp: 200 },
  first_gift: { name: 'Первый подарок', icon: 'gift', xp: 100 },
  premium: { name: 'Premium', icon: 'star', xp: 1000 },
  owner: { name: 'Владелец', icon: 'crown', xp: 5000 },
  first_chat: { name: 'Создал чат', icon: 'chat', xp: 50 },
  voice_sent: { name: 'Голосовое', icon: 'mic', xp: 30 }
};

app.get('/api/achievements', authM, (req, res) => res.json(ACHIEVEMENTS));

app.get('/api/me/achievements', authM, async (req, res) => {
  const u = (await db.ref('users/' + req.userId).once('value')).val();
  res.json(u.achievements || []);
});

async function unlockAchievement(userId, key) {
  try {
    const ref = db.ref('users/' + userId);
    const u = (await ref.once('value')).val();
    const list = u.achievements || [];
    if (list.includes(key)) return;
    list.push(key);
    await ref.update({ achievements: list });
    if (ACHIEVEMENTS[key]) await addXP(userId, ACHIEVEMENTS[key].xp);
    sendToUser(userId, { type: 'achievement', data: { key, ...ACHIEVEMENTS[key] } });
  } catch (e) {}
}

app.post('/api/me/check-achievements', authM, async (req, res) => {
  try {
    const u = (await db.ref('users/' + req.userId).once('value')).val();
    const friendsSnap = await db.ref('friends/' + req.userId).once('value');
    const friendsCount = Object.keys(friendsSnap.val() || {}).length;
    const chatsSnap = await db.ref('userChats/' + req.userId).once('value');
    const chatsCount = Object.keys(chatsSnap.val() || {}).length;
    const gifts = u.gifts || [];

    let msgCount = 0;
    const allChats = Object.keys(chatsSnap.val() || {});
    for (const cid of allChats) {
      const msgs = (await db.ref('messages/' + cid).once('value')).val() || {};
      msgCount += Object.values(msgs).filter(m => m.from === req.userId).length;
    }

    if (msgCount >= 1) await unlockAchievement(req.userId, 'first_msg');
    if (msgCount >= 10) await unlockAchievement(req.userId, 'ten_msgs');
    if (msgCount >= 100) await unlockAchievement(req.userId, 'hundred_msgs');
    if (friendsCount >= 1) await unlockAchievement(req.userId, 'first_friend');
    if (friendsCount >= 5) await unlockAchievement(req.userId, 'five_friends');
    if (gifts.length >= 1) await unlockAchievement(req.userId, 'first_gift');
    if (u.premium) await unlockAchievement(req.userId, 'premium');
    if (u.owner) await unlockAchievement(req.userId, 'owner');
    if (chatsCount >= 1) await unlockAchievement(req.userId, 'first_chat');

    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* Реферальная программа */
app.post('/api/ref/create', authM, async (req, res) => {
  try {
    const u = (await db.ref('users/' + req.userId).once('value')).val();
    let code = u.refCode;
    if (!code) {
      code = req.userId.slice(0, 6) + Math.random().toString(36).slice(2, 6);
      await db.ref('users/' + req.userId).update({ refCode: code });
      await db.ref('refs/' + code).set({ uid: req.userId, invited: [], totalEarned: 0 });
    }
    res.json({ ok: true, code, link: '/ref/' + code });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/ref/apply', authM, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Нет кода' });
    const ref = (await db.ref('refs/' + code).once('value')).val();
    if (!ref) return res.status(404).json({ error: 'Реф-код не найден' });
    if (ref.uid === req.userId) return res.status(400).json({ error: 'Нельзя себя' });
    const me = (await db.ref('users/' + req.userId).once('value')).val();
    if (me.referrer) return res.status(400).json({ error: 'Уже применён' });

    const invited = ref.invited || [];
    if (!invited.includes(req.userId)) invited.push(req.userId);
    await db.ref('refs/' + code).update({ invited });

    await db.ref('users/' + req.userId).update({ referrer: ref.uid });
    await db.ref('users/' + ref.uid).update({
      balance: ((await db.ref('users/' + ref.uid).once('value')).val().balance || 0) + 50
    });

    sendToUser(ref.uid, { type: 'ref_bonus', data: { amount: 50, from: me.name } });
    res.json({ ok: true, bonus: 50 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/ref/info', authM, async (req, res) => {
  try {
    const u = (await db.ref('users/' + req.userId).once('value')).val();
    if (!u.refCode) return res.json({ code: null, invited: 0, totalEarned: 0 });
    const ref = (await db.ref('refs/' + u.refCode).once('value')).val();
    res.json({
      code: u.refCode,
      invited: (ref.invited || []).length,
      totalEarned: (ref.invited || []).length * 50,
      link: '/ref/' + u.refCode
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* Ежедневные монеты */
app.post('/api/daily/claim', authM, async (req, res) => {
  try {
    const ref = db.ref('users/' + req.userId);
    const u = (await ref.once('value')).val();
    const today = new Date().toDateString();
    if (u.lastDaily === today) return res.status(400).json({ error: 'Уже получено' });
    const streak = u.streak || 0;
    const bonus = 50 + Math.min(streak * 10, 100);
    const newStreak = (u.lastDaily && new Date(u.lastDaily).getTime() > Date.now() - 2 * 86400000) ? streak + 1 : 1;
    await ref.update({
      balance: (u.balance || 0) + bonus,
      lastDaily: today,
      streak: newStreak
    });
    await addXP(req.userId, 20);
    res.json({ ok: true, bonus, streak: newStreak });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
/* ==========================================
   ПАТЧ 10: БЕЗОПАСНОСТЬ, PIN, СЕССИИ, 2FA
========================================== */

/* PIN-код */
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

app.post('/api/security/pin/remove', authM, async (req, res) => {
  try {
    const { pin } = req.body;
    const u = (await db.ref('users/' + req.userId).once('value')).val();
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update(pin).digest('hex');
    if (hash !== u.pinHash) return res.status(400).json({ error: 'Неверный PIN' });
    await db.ref('users/' + req.userId).update({ pinHash: null, pinEnabled: false });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* 2FA (TOTP-заглушка, простой секрет) */
app.post('/api/security/2fa/enable', authM, async (req, res) => {
  try {
    const crypto = require('crypto');
    const secret = crypto.randomBytes(20).toString('hex');
    await db.ref('users/' + req.userId).update({ twoFA: { enabled: false, secret } });
    res.json({ ok: true, secret });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/security/2fa/verify', authM, async (req, res) => {
  try {
    const { code } = req.body;
    const u = (await db.ref('users/' + req.userId).once('value')).val();
    if (!u.twoFA?.secret) return res.status(400).json({ error: 'Не настроено' });
    const crypto = require('crypto');
    const expected = crypto.createHmac('sha256', u.twoFA.secret).update(Math.floor(Date.now() / 30000).toString()).digest('hex').slice(0, 6);
    if (code === expected) {
      await db.ref('users/' + req.userId).update({ 'twoFA.enabled': true });
      res.json({ ok: true });
    } else {
      res.json({ ok: false });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/security/2fa/disable', authM, async (req, res) => {
  try {
    await db.ref('users/' + req.userId).update({ twoFA: null });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* Скрыть онлайн-статус */
app.post('/api/security/hide-online', authM, async (req, res) => {
  try {
    const ref = db.ref('users/' + req.userId);
    const u = (await ref.once('value')).val();
    await ref.update({ hideOnline: !u.hideOnline });
    res.json({ ok: true, hideOnline: !u.hideOnline });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* Скрыть последний онлайн */
app.post('/api/security/hide-lastseen', authM, async (req, res) => {
  try {
    const ref = db.ref('users/' + req.userId);
    const u = (await ref.once('value')).val();
    await ref.update({ hideLastSeen: !u.hideLastSeen });
    res.json({ ok: true, hideLastSeen: !u.hideLastSeen });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* Скрыть аватар от чужих */
app.post('/api/security/hide-avatar', authM, async (req, res) => {
  try {
    const ref = db.ref('users/' + req.userId);
    const u = (await ref.once('value')).val();
    await ref.update({ hideAvatar: !u.hideAvatar });
    res.json({ ok: true, hideAvatar: !u.hideAvatar });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* История входов */
app.post('/api/security/log-login', authM, async (req, res) => {
  try {
    const { userAgent, ip } = req.body;
    const ref = db.ref('loginHistory/' + req.userId).push();
    await ref.set({
      ua: userAgent || 'Unknown',
      ip: ip || 'Unknown',
      time: Date.now()
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/security/login-history', authM, async (req, res) => {
  try {
    const snap = await db.ref('loginHistory/' + req.userId).limitToLast(50).once('value');
    const list = Object.entries(snap.val() || {}).map(([id, h]) => ({ id, ...h })).sort((a, b) => b.time - a.time);
    res.json(list);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* Активные сессии */
app.post('/api/security/session', authM, async (req, res) => {
  try {
    const { sessionId, userAgent } = req.body;
    const sid = sessionId || ('s_' + Date.now());
    await db.ref('sessions/' + req.userId + '/' + sid).set({
      id: sid, ua: userAgent || 'Unknown', created: Date.now(),
      lastActivity: Date.now(), current: true
    });
    res.json({ ok: true, sessionId: sid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/security/sessions', authM, async (req, res) => {
  try {
    const snap = await db.ref('sessions/' + req.userId).once('value');
    const list = Object.entries(snap.val() || {}).map(([id, s]) => ({ id, ...s })).sort((a, b) => b.lastActivity - a.lastActivity);
    res.json(list);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/security/session/:sid', authM, async (req, res) => {
  try {
    await db.ref('sessions/' + req.userId + '/' + req.params.sid).remove();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* Удаление аккаунта */
app.post('/api/security/delete-account', authM, async (req, res) => {
  try {
    const { confirm } = req.body;
    if (confirm !== 'DELETE') return res.status(400).json({ error: 'Подтверждение неверно' });
    const uid = req.userId;
    const u = (await db.ref('users/' + uid).once('value')).val();
    if (u.login) await db.ref('logins/' + u.login).remove();
    await db.ref('users/' + uid).remove();
    await db.ref('friends/' + uid).remove();
    await db.ref('userChats/' + uid).remove();
    await auth.deleteUser(uid);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
/* ==========================================
   ПАТЧ 11: ИСТОРИИ 24Ч, КЛИПЫ, REELS
========================================== */

/* --- Истории --- */
app.post('/api/stories', authM, async (req, res) => {
  try {
    const { media, text, bg } = req.body;
    if (!media?.length && !text) return res.status(400).json({ error: 'Пусто' });
    const user = (await db.ref('users/' + req.userId).once('value')).val();
    const story = {
      id: 's_' + Date.now(),
      from: req.userId,
      author: { uid: user.uid, name: user.name, login: user.login, avatar: user.avatar, avatarText: user.avatarText, avatarColor: user.avatarColor },
      media: media || [], text: text || '', bg: bg || '#2f7fff',
      time: Date.now(),
      expiresAt: Date.now() + 24 * 3600 * 1000,
      views: []
    };
    const ref = db.ref('stories/' + story.id);
    await ref.set(story);
    const allUsers = (await db.ref('users').once('value')).val() || {};
    Object.keys(allUsers).forEach(uid => {
      if (uid !== req.userId) sendToUser(uid, { type: 'new_story', data: story });
    });
    res.json(story);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/stories', authM, async (req, res) => {
  try {
    const snap = await db.ref('stories').once('value');
    const now = Date.now();
    const list = Object.values(snap.val() || {}).filter(s => s.expiresAt > now);
    const grouped = {};
    list.forEach(s => {
      if (!grouped[s.from]) grouped[s.from] = { user: s.author, items: [] };
      grouped[s.from].items.push(s);
    });
    const result = Object.values(grouped).map(g => {
      g.items.sort((a, b) => a.time - b.time);
      g.lastTime = g.items[g.items.length - 1].time;
      const allViewed = g.items.every(i => i.views.includes(req.userId));
      g.allViewed = allViewed;
      return g;
    }).sort((a, b) => a.allViewed - b.allViewed || b.lastTime - a.lastTime);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/stories/:id/view', authM, async (req, res) => {
  try {
    const ref = db.ref('stories/' + req.params.id);
    const s = (await ref.once('value')).val();
    if (!s) return res.status(404).json({ error: 'Не найдена' });
    const views = s.views || [];
    if (!views.includes(req.userId)) {
      views.push(req.userId);
      await ref.update({ views });
    }
    res.json({ ok: true, views: views.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/stories/:id', authM, async (req, res) => {
  try {
    const s = (await db.ref('stories/' + req.params.id).once('value')).val();
    if (!s) return res.status(404).json({ error: 'Не найдена' });
    if (s.from !== req.userId) return res.status(403).json({ error: 'Не ваша' });
    await db.ref('stories/' + req.params.id).remove();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* --- Клипы (видео-лента) --- */
app.post('/api/clips', authM, async (req, res) => {
  try {
    const { video, title, thumbnail, description } = req.body;
    if (!video) return res.status(400).json({ error: 'Нужно видео' });
    const user = (await db.ref('users/' + req.userId).once('value')).val();
    const clip = {
      id: 'cl_' + Date.now(),
      from: req.userId,
      author: { uid: user.uid, name: user.name, login: user.login, avatar: user.avatar, avatarText: user.avatarText, avatarColor: user.avatarColor, verified: user.verified },
      video, thumbnail: thumbnail || '',
      title: title || '', description: description || '',
      time: Date.now(),
      likes: [], views: 0, viewedBy: [],
      comments: []
    };
    const ref = db.ref('clips/' + clip.id);
    await ref.set(clip);
    res.json(clip);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/clips', authM, async (req, res) => {
  try {
    const snap = await db.ref('clips').once('value');
    const list = Object.values(snap.val() || {}).sort((a, b) => b.time - a.time).slice(0, 50);
    res.json(list);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/clips/:id/like', authM, async (req, res) => {
  try {
    const ref = db.ref('clips/' + req.params.id);
    const clip = (await ref.once('value')).val();
    if (!clip) return res.status(404).json({ error: 'Не найден' });
    const likes = clip.likes || [];
    const i = likes.indexOf(req.userId);
    if (i >= 0) likes.splice(i, 1); else likes.push(req.userId);
    await ref.update({ likes });
    res.json({ ok: true, likes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/clips/:id/view', authM, async (req, res) => {
  try {
    const ref = db.ref('clips/' + req.params.id);
    const clip = (await ref.once('value')).val();
    if (!clip) return res.status(404).json({ error: 'Не найден' });
    const viewed = clip.viewedBy || [];
    if (!viewed.includes(req.userId)) {
      viewed.push(req.userId);
      await ref.update({ viewedBy: viewed, views: viewed.length });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/clips/:id', authM, async (req, res) => {
  try {
    const c = (await db.ref('clips/' + req.params.id).once('value')).val();
    if (!c) return res.status(404).json({ error: 'Не найден' });
    if (c.from !== req.userId) return res.status(403).json({ error: 'Не ваш' });
    await db.ref('clips/' + req.params.id).remove();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* --- Reels (короткие, вертикальные) --- */
app.post('/api/reels', authM, async (req, res) => {
  try {
    const { video, title } = req.body;
    if (!video) return res.status(400).json({ error: 'Нужно видео' });
    const user = (await db.ref('users/' + req.userId).once('value')).val();
    const reel = {
      id: 'rl_' + Date.now(),
      from: req.userId,
      author: { uid: user.uid, name: user.name, login: user.login, avatar: user.avatar, avatarText: user.avatarText, avatarColor: user.avatarColor },
      video, title: title || '',
      time: Date.now(), likes: [], views: 0, comments: []
    };
    const ref = db.ref('reels/' + reel.id);
    await ref.set(reel);
    res.json(reel);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/reels', authM, async (req, res) => {
  try {
    const snap = await db.ref('reels').once('value');
    const list = Object.values(snap.val() || {}).sort((a, b) => b.time - a.time).slice(0, 50);
    res.json(list);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/reels/:id/like', authM, async (req, res) => {
  try {
    const ref = db.ref('reels/' + req.params.id);
    const r = (await ref.once('value')).val();
    if (!r) return res.status(404).json({ error: 'Не найден' });
    const likes = r.likes || [];
    const i = likes.indexOf(req.userId);
    if (i >= 0) likes.splice(i, 1); else likes.push(req.userId);
    await ref.update({ likes });
    res.json({ ok: true, likes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* Автоудаление истёкших историй */
setInterval(async () => {
  try {
    const now = Date.now();
    const snap = await db.ref('stories').once('value');
    const all = snap.val() || {};
    for (const [id, s] of Object.entries(all)) {
      if (s.expiresAt < now) await db.ref('stories/' + id).remove();
    }
  } catch (e) {}
}, 300000);
/* ==========================================
   ПАТЧ 12: ПАПКИ, ТЕГИ, АВТООТВЕТЧИК
========================================== */

/* --- Папки чатов --- */
app.post('/api/folders', authM, async (req, res) => {
  try {
    const { name, emoji, chatIds } = req.body;
    if (!name) return res.status(400).json({ error: 'Нужно название' });
    const ref = db.ref('folders/' + req.userId).push();
    await ref.set({ id: ref.key, name, emoji: emoji || '📁', chatIds: chatIds || [], created: Date.now() });
    res.json({ ok: true, id: ref.key });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/folders', authM, async (req, res) => {
  try {
    const snap = await db.ref('folders/' + req.userId).once('value');
    res.json(Object.values(snap.val() || {}));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/folders/:id', authM, async (req, res) => {
  try {
    await db.ref('folders/' + req.userId + '/' + req.params.id).remove();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/folders/:id/add/:chatId', authM, async (req, res) => {
  try {
    const ref = db.ref('folders/' + req.userId + '/' + req.params.id);
    const f = (await ref.once('value')).val();
    if (!f) return res.status(404).json({ error: 'Не найдена' });
    const chatIds = f.chatIds || [];
    if (!chatIds.includes(req.params.chatId)) chatIds.push(req.params.chatId);
    await ref.update({ chatIds });
    res.json({ ok: true, chatIds });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/folders/:id/remove/:chatId', authM, async (req, res) => {
  try {
    const ref = db.ref('folders/' + req.userId + '/' + req.params.id);
    const f = (await ref.once('value')).val();
    if (!f) return res.status(404).json({ error: 'Не найдена' });
    const chatIds = (f.chatIds || []).filter(id => id !== req.params.chatId);
    await ref.update({ chatIds });
    res.json({ ok: true, chatIds });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* --- Теги чатов --- */
app.post('/api/chat-tags/:chatId', authM, async (req, res) => {
  try {
    const { tags } = req.body;
    await db.ref('chatTags/' + req.userId + '/' + req.params.chatId).set({ tags: tags || [] });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/chat-tags', authM, async (req, res) => {
  try {
    const snap = await db.ref('chatTags/' + req.userId).once('value');
    res.json(snap.val() || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* --- Автоответчик --- */
app.post('/api/autoreply', authM, async (req, res) => {
  try {
    const { text, enabled, schedule } = req.body;
    await db.ref('users/' + req.userId).update({
      autoreply: { text: text || '', enabled: !!enabled, schedule: schedule || null }
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/autoreply', authM, async (req, res) => {
  try {
    const u = (await db.ref('users/' + req.userId).once('value')).val();
    res.json(u.autoreply || { text: '', enabled: false, schedule: null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* --- Экспорт данных --- */
app.get('/api/export', authM, async (req, res) => {
  try {
    const uid = req.userId;
    const user = (await db.ref('users/' + uid).once('value')).val();
    const friends = (await db.ref('friends/' + uid).once('value')).val() || {};
    const chats = (await db.ref('userChats/' + uid).once('value')).val() || {};
    const messages = {};
    for (const cid of Object.keys(chats)) {
      messages[cid] = (await db.ref('messages/' + cid).limitToLast(1000).once('value')).val() || {};
    }
    const posts = (await db.ref('posts').once('value')).val() || {};
    const myPosts = Object.values(posts).filter(p => p.from === uid);
    const exportData = {
      exported: Date.now(),
      user: { ...user, password: undefined, pinHash: undefined },
      friends: Object.keys(friends),
      chats: Object.keys(chats),
      messages, posts: myPosts
    };
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="train_export.json"');
    res.send(JSON.stringify(exportData, null, 2));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* --- Заметки --- */
app.post('/api/notes', authM, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'Пусто' });
    const ref = db.ref('notes/' + req.userId).push();
    await ref.set({ id: ref.key, text, time: Date.now() });
    res.json({ ok: true, id: ref.key });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/notes', authM, async (req, res) => {
  try {
    const snap = await db.ref('notes/' + req.userId).once('value');
    res.json(Object.values(snap.val() || {}).sort((a, b) => b.time - a.time));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/notes/:id', authM, async (req, res) => {
  try {
    await db.ref('notes/' + req.userId + '/' + req.params.id).remove();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* --- Избранное (сохранённые сообщения) --- */
app.post('/api/saved/:chatId/:msgId', authM, async (req, res) => {
  try {
    const m = (await db.ref('messages/' + req.params.chatId + '/' + req.params.msgId).once('value')).val();
    if (!m) return res.status(404).json({ error: 'Не найдено' });
    await db.ref('saved/' + req.userId + '/' + req.params.msgId).set({
      chatId: req.params.chatId, msgId: req.params.msgId, text: m.text, media: m.media,
      from: m.from, time: m.time, savedAt: Date.now()
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/saved', authM, async (req, res) => {
  try {
    const snap = await db.ref('saved/' + req.userId).once('value');
    res.json(Object.values(snap.val() || {}).sort((a, b) => b.savedAt - a.savedAt));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/saved/:msgId', authM, async (req, res) => {
  try {
    await db.ref('saved/' + req.userId + '/' + req.params.msgId).remove();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
/* ==========================================
   ПАТЧ PREMIUM — ВСЕ ФУНКЦИИ
========================================== */

const PREMIUM_PRICE = 500;
const PREMIUM_FEATURES = {
  verified: true,           // галочка
  crownBadge: true,          // золотая звезда
  noAds: true,               // без рекламы
  doubleEarnings: true,      // +100% рублей
  animatedReactions: true,   // анимированные реакции
  customEmoji: true,         // свои эмодзи
  longerBio: true,           // длинное bio
  morePinnedChats: true,     // больше закреплённых
  prioritySupport: true,     // приоритетная поддержка
  premiumBadge: true,        // значок Premium
  exclusiveStickers: true,   // эксклюзивные стикеры
  biggerFiles: true          // файлы до 100MB
};

/* --- Купить Premium --- */
app.post('/api/premium/buy', authM, async (req, res) => {
  try {
    const ref = db.ref('users/' + req.userId);
    const u = (await ref.once('value')).val();
    if (u.premium) return res.status(400).json({ error: 'Premium уже активен' });
    if ((u.balance || 0) < PREMIUM_PRICE) {
      return res.status(400).json({ error: `Нужно ${PREMIUM_PRICE} ₽. У вас ${u.balance || 0} ₽` });
    }
    await ref.update({
      premium: true,
      premiumSince: Date.now(),
      premiumExpires: 0,
      premiumFeatures: PREMIUM_FEATURES,
      balance: (u.balance || 0) - PREMIUM_PRICE
    });
    sendToUser(req.userId, { type: 'premium_activated', data: { since: Date.now() } });
    res.json({ ok: true, premium: true, features: PREMIUM_FEATURES });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* --- Проверить статус --- */
app.get('/api/premium/status', authM, async (req, res) => {
  try {
    const u = (await db.ref('users/' + req.userId).once('value')).val();
    res.json({
      premium: !!u.premium,
      since: u.premiumSince || null,
      expires: u.premiumExpires || 0,
      features: u.premium ? (u.premiumFeatures || PREMIUM_FEATURES) : {}
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* --- Отменить Premium --- */
app.post('/api/premium/cancel', authM, async (req, res) => {
  try {
    const ref = db.ref('users/' + req.userId);
    const u = (await ref.once('value')).val();
    if (!u.premium) return res.status(400).json({ error: 'Не активен' });
    if (!confirm) return res.status(400).json({ error: 'Нужно подтверждение' });
    await ref.update({ premium: false, premiumFeatures: null });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* --- Подарить Premium другому --- */
app.post('/api/premium/gift', authM, async (req, res) => {
  try {
    const { toUid } = req.body;
    if (!toUid) return res.status(400).json({ error: 'Укажи получателя' });
    if (toUid === req.userId) return res.status(400).json({ error: 'Себе нельзя' });
    const meRef = db.ref('users/' + req.userId);
    const me = (await meRef.once('value')).val();
    if ((me.balance || 0) < PREMIUM_PRICE) {
      return res.status(400).json({ error: `Нужно ${PREMIUM_PRICE} ₽` });
    }
    const target = (await db.ref('users/' + toUid).once('value')).val();
    if (!target) return res.status(404).json({ error: 'Получатель не найден' });
    if (target.premium) return res.status(400).json({ error: 'У получателя уже есть Premium' });

    await meRef.update({ balance: (me.balance || 0) - PREMIUM_PRICE });
    await db.ref('users/' + toUid).update({
      premium: true,
      premiumSince: Date.now(),
      premiumFeatures: PREMIUM_FEATURES,
      premiumGiftedBy: req.userId
    });

    sendToUser(toUid, {
      type: 'premium_gifted',
      data: { from: me.name, since: Date.now() }
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* --- Автосписание (если сделаешь подписку) --- */
app.post('/api/premium/renew', authM, async (req, res) => {
  try {
    const ref = db.ref('users/' + req.userId);
    const u = (await ref.once('value')).val();
    if (!u.premium) return res.status(400).json({ error: 'Не активен' });
    if ((u.balance || 0) < PREMIUM_PRICE) return res.status(400).json({ error: 'Недостаточно средств' });
    const newExpiry = Math.max(Date.now(), u.premiumExpires || Date.now()) + 30 * 86400000;
    await ref.update({
      premiumExpires: newExpiry,
      balance: (u.balance || 0) - PREMIUM_PRICE
    });
    res.json({ ok: true, expires: newExpiry });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* --- Проверка Premium middleware --- */
async function requirePremium(req, res, next) {
  const u = (await db.ref('users/' + req.userId).once('value')).val();
  if (!u || !u.premium) return res.status(403).json({ error: 'Нужен Premium' });
  req.userData = u;
  next();
}

/* --- Эксклюзивные стикеры (только Premium) --- */
app.get('/api/premium/stickers', requirePremium, async (req, res) => {
  const stickers = [
    { id: 'ps1', emoji: '👑', name: 'Корона' },
    { id: 'ps2', emoji: '💎', name: 'Алмаз' },
    { id: 'ps3', emoji: '🚀', name: 'Ракета' },
    { id: 'ps4', emoji: '🏆', name: 'Кубок' },
    { id: 'ps5', emoji: '⭐', name: 'Звезда' },
    { id: 'ps6', emoji: '🔥', name: 'Огонь' },
    { id: 'ps7', emoji: '💯', name: '100' },
    { id: 'ps8', emoji: '🎉', name: 'Праздник' },
    { id: 'ps9', emoji: '🦄', name: 'Единорог' },
    { id: 'ps10', emoji: '🐉', name: 'Дракон' },
    { id: 'ps11', emoji: '💫', name: 'Искры' },
    { id: 'ps12', emoji: '⚡', name: 'Молния' }
  ];
  res.json(stickers);
});

/* --- Эксклюзивные эмодзи (только Premium) --- */
app.get('/api/premium/emoji', requirePremium, (req, res) => {
  const emojis = ['🦄','🐉','👑','💎','🚀','🏆','⭐','🔥','💯','🎉','✨','⚡','🌈','🦋','🌸','🌺','🍀','🎨','🎭','🎪'];
  res.json(emojis);
});

/* --- Кастомный цвет имени (только Premium) --- */
app.post('/api/premium/name-color', requirePremium, async (req, res) => {
  try {
    const { color } = req.body;
    if (!color || !/^#[0-9a-f]{6}$/i.test(color)) {
      return res.status(400).json({ error: 'Неверный цвет' });
    }
    await db.ref('users/' + req.userId).update({ nameColor: color });
    res.json({ ok: true, color });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* --- Кастомный фон профиля (только Premium) --- */
app.post('/api/premium/profile-bg', requirePremium, async (req, res) => {
  try {
    const { bg } = req.body;
    await db.ref('users/' + req.userId).update({ profileBg: bg || '' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* --- Анимированные реакции (только Premium) --- */
app.post('/api/premium/animated-react', requirePremium, async (req, res) => {
  try {
    const { chatId, msgId, emoji } = req.body;
    const ref = db.ref('messages/' + chatId + '/' + msgId);
    const m = (await ref.once('value')).val();
    if (!m) return res.status(404).json({ error: 'Не найдено' });
    const reactions = m.reactions || {};
    if (!reactions[emoji]) reactions[emoji] = [];
    const idx = reactions[emoji].indexOf(req.userId);
    if (idx >= 0) reactions[emoji].splice(idx, 1);
    else reactions[emoji].push(req.userId);
    await ref.update({ reactions, animatedBy: req.userId });
    const c = (await db.ref('chats/' + chatId).once('value')).val();
    (c?.members || []).forEach(uid => {
      sendToUser(uid, { type: 'message_updated', data: { chatId, msgId, reactions, animated: true } });
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* --- Premium статистика (для владельца проекта) --- */
app.get('/api/admin/premium-list', authM, async (req, res) => {
  try {
    const me = (await db.ref('users/' + req.userId).once('value')).val();
    if (!me.owner) return res.status(403).json({ error: 'Только владелец проекта' });
    const snap = await db.ref('users').once('value');
    const all = Object.values(snap.val() || {});
    const premium = all.filter(u => u.premium);
    const totalRevenue = premium.length * PREMIUM_PRICE;
    res.json({
      count: premium.length,
      totalRevenue,
      list: premium.map(u => ({
        uid: u.uid, name: u.name, login: u.login,
        since: u.premiumSince,
        giftedBy: u.premiumGiftedBy || null
      }))
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* --- Выдать Premium (только владелец проекта) --- */
app.post('/api/admin/premium/grant', authM, async (req, res) => {
  try {
    const me = (await db.ref('users/' + req.userId).once('value')).val();
    if (!me.owner) return res.status(403).json({ error: 'Только владелец проекта' });
    const { targetUid } = req.body;
    if (!targetUid) return res.status(400).json({ error: 'Нужен uid' });
    await db.ref('users/' + targetUid).update({
      premium: true,
      premiumSince: Date.now(),
      premiumFeatures: PREMIUM_FEATURES,
      premiumGrantedByAdmin: true
    });
    sendToUser(targetUid, { type: 'premium_activated', data: { since: Date.now() } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* --- Снять Premium (только владелец проекта) --- */
app.post('/api/admin/premium/revoke', authM, async (req, res) => {
  try {
    const me = (await db.ref('users/' + req.userId).once('value')).val();
    if (!me.owner) return res.status(403).json({ error: 'Только владелец проекта' });
    const { targetUid } = req.body;
    if (!targetUid) return res.status(400).json({ error: 'Нужен uid' });
    await db.ref('users/' + targetUid).update({
      premium: false, premiumFeatures: null, premiumExpires: 0
    });
    sendToUser(targetUid, { type: 'premium_revoked', data: {} });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* --- Проверка истёкших Premium (периодическая) --- */
setInterval(async () => {
  try {
    const snap = await db.ref('users').once('value');
    const all = snap.val() || {};
    const now = Date.now();
    for (const [uid, u] of Object.entries(all)) {
      if (u.premium && u.premiumExpires && u.premiumExpires > 0 && u.premiumExpires < now) {
        await db.ref('users/' + uid).update({ premium: false, premiumFeatures: null });
        sendToUser(uid, { type: 'premium_expired', data: {} });
      }
    }
  } catch (e) {}
}, 60000);
/* ==========================================
   ПАТЧ 13: ФИНАЛЬНЫЕ СИСТЕМЫ
   PWA, Push, Rate-limit, Health, Cleanup
========================================== */

/* --- Health check --- */
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    server: 'Train Messenger v6.0',
    uptime: Math.floor(process.uptime()),
    timestamp: Date.now(),
    memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + ' MB'
  });
});

/* --- PWA Manifest --- */
app.get('/manifest.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.json({
    name: 'Train Messenger',
    short_name: 'Train',
    description: 'Современный мессенджер',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    theme_color: '#0a1128',
    background_color: '#0a1128',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
    ],
    categories: ['social', 'communication'],
    lang: 'ru'
  });
});

/* --- Service Worker --- */
app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`
    const CACHE = 'train-v6';
    const ASSETS = ['/', '/index.html', '/style.css', '/app.js'];
    self.addEventListener('install', e => {
      self.skipWaiting();
      e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS).catch(()=>{})));
    });
    self.addEventListener('activate', e => {
      e.waitUntil(clients.claim());
    });
    self.addEventListener('fetch', e => {
      if (e.request.method !== 'GET') return;
      if (e.request.url.includes('/api/')) return;
      e.respondWith(
        caches.match(e.request).then(r => r || fetch(e.request).then(res => {
          if (res.ok && res.type === 'basic') {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(e.request, clone));
          }
          return res;
        }))
      );
    });
    self.addEventListener('notificationclick', e => {
      e.notification.close();
      e.waitUntil(clients.openWindow('/'));
    });
  `);
});

/* --- Push-подписка --- */
app.post('/api/push/subscribe', authM, async (req, res) => {
  try {
    const { subscription } = req.body;
    if (!subscription) return res.status(400).json({ error: 'Нет подписки' });
    await db.ref('pushSubs/' + req.userId).set({
      subscription,
      subscribedAt: Date.now(),
      userAgent: req.headers['user-agent'] || ''
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/push/unsubscribe', authM, async (req, res) => {
  try {
    await db.ref('pushSubs/' + req.userId).remove();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/push/status', authM, async (req, res) => {
  try {
    const sub = (await db.ref('pushSubs/' + req.userId).once('value')).val();
    res.json({ subscribed: !!sub, since: sub?.subscribedAt || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* --- Rate limiting (простой) --- */
const rateLimitMap = new Map();
function rateLimit(maxRequests = 60, windowMs = 60000) {
  return (req, res, next) => {
    const key = (req.userId || req.ip) + ':' + req.path;
    const now = Date.now();
    const entry = rateLimitMap.get(key) || { count: 0, reset: now + windowMs };
    if (now > entry.reset) {
      entry.count = 0;
      entry.reset = now + windowMs;
    }
    entry.count++;
    rateLimitMap.set(key, entry);
    if (entry.count > maxRequests) {
      return res.status(429).json({ error: 'Слишком много запросов. Подожди.', retryAfter: Math.ceil((entry.reset - now) / 1000) });
    }
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateLimitMap.entries()) {
    if (now > v.reset) rateLimitMap.delete(k);
  }
}, 120000);

/* --- Очистка старых данных (раз в час) --- */
setInterval(async () => {
  try {
    const now = Date.now();
    // Старые инвайты
    const invSnap = await db.ref('invites').once('value');
    const invs = invSnap.val() || {};
    for (const [code, inv] of Object.entries(invs)) {
      if (inv.expiresAt && inv.expiresAt < now) {
        await db.ref('invites/' + code).remove();
      }
    }
    // Старые уведомления
    const notifSnap = await db.ref('notifications').once('value');
    const notifs = notifSnap.val() || {};
    for (const [uid, list] of Object.entries(notifs)) {
      if (Array.isArray(list)) {
        const filtered = list.filter(n => !n.time || now - n.time < 30 * 86400000);
        if (filtered.length !== list.length) {
          await db.ref('notifications/' + uid).set(filtered);
        }
      }
    }
    // Старые истории (страховка)
    const stSnap = await db.ref('stories').once('value');
    const sts = stSnap.val() || {};
    for (const [id, s] of Object.entries(sts)) {
      if (s.expiresAt && s.expiresAt < now) {
        await db.ref('stories/' + id).remove();
      }
    }
  } catch (e) {}
}, 3600000);

/* --- Обработка ошибок --- */
app.use((err, req, res, next) => {
  console.error('Ошибка:', err.message);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

/* --- 404 для API --- */
app.use('/api/*', (req, res) => {
  res.status(404).json({ error: 'API endpoint не найден' });
});

/* --- Graceful shutdown --- */
process.on('SIGINT', async () => {
  console.log('\n⛔ Сервер останавливается...');
  try {
    await db.ref('.info/connected').off();
    server.close(() => {
      console.log('✅ Сервер остановлен\n');
      process.exit(0);
    });
  } catch (e) {
    process.exit(0);
  }
  setTimeout(() => process.exit(0), 3000);
});

process.on('uncaughtException', (err) => {
  console.error('⚠️ Uncaught Exception:', err.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('⚠️ Unhandled Rejection:', reason);
});
server.listen(PORT, () => {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║                                                  ║');
  console.log('║   ████████╗██████╗  █████╗ ██╗███╗   ██╗         ║');
  console.log('║   ╚══██╔══╝██╔══██╗██╔══██╗██║████╗  ██║         ║');
  console.log('║      ██║   ██████╔╝███████║██║██╔██╗ ██║         ║');
  console.log('║      ██║   ██╔══██╗██╔══██║██║██║╚██╗██║         ║');
  console.log('║      ██║   ██║  ██║██║  ██║██║██║ ╚████║         ║');
  console.log('║      ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝╚═╝  ╚═══╝         ║');
  console.log('║                                                  ║');
  console.log('║           TRAIN MESSENGER v6.0                   ║');
  console.log('║                                                  ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');
  console.log('  ✅ Сервер запущен успешно');
  console.log('');
  console.log('  🌐 Адрес:      http://localhost:' + PORT);
  console.log('  🔥 Firebase:   messeger-d3a9f');
  console.log('  📁 Файлы:      ./public/uploads/');
  console.log('');
  console.log('  ─────────────────────────────────────────────────');
  console.log('  📦 ФУНКЦИИ:');
  console.log('  ─────────────────────────────────────────────────');
  console.log('  💬 Чаты:           личные, группы, каналы');
  console.log('  ✏️ Сообщения:      редактирование, пересылка, опросы');
  console.log('  🎙️ Голосовые:      запись + воспроизведение');
  console.log('  📸 Медиа:          фото, видео, файлы');
  console.log('  😀 Реакции:        ❤️👍😂🔥 + кастом');
  console.log('  ↩️  Ответы:         reply + цитаты');
  console.log('  📌 Закрепление:    pin в чатах');
  console.log('  👥 Друзья:         заявки, поиск');
  console.log('  🔒 Приватность:    блокировки, жалобы');
  console.log('  ⭐ Premium:        покупка, подарок');
  console.log('  🎁 Подарки:        12 типов');
  console.log('  💰 Рубли:          +1 за сообщение');
  console.log('  ⚙️ Настройки:      роли, права, заместители');
  console.log('  🔗 Инвайты:        ссылки + QR');
  console.log('  📊 Статистика:     каналов и чатов');
  console.log('  📜 Логи:           действий участников');
  console.log('  📚 Истории:        24 часа');
  console.log('  🎬 Клипы:          видео-лента');
  console.log('  📱 Reels:          короткие видео');
  console.log('  🔑 2FA:            безопасность');
  console.log('  📁 Папки:          группировка чатов');
  console.log('  📝 Заметки:        личные');
  console.log('  ⭐ Избранное:      сохранённые');
  console.log('  📤 Экспорт:        данных');
  console.log('');
  console.log('  ─────────────────────────────────────────────────');
  console.log('  🔑 ВЛАДЕЛЕЦ:  kriptondev / KriptonDev2026');
  console.log('  ─────────────────────────────────────────────────');
  console.log('');
  console.log('  💡 Открой браузер → http://localhost:' + PORT);
  console.log('  ⛔ Не закрывай это окно!');
  console.log('');
  console.log('══════════════════════════════════════════════════\n');
});