const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");
const ADMIN_ID = String(process.env.ADMIN_ID || "admin").trim().toLowerCase();

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml"
};

function id(prefix = "") {
  return `${prefix}${crypto.randomBytes(8).toString("hex")}`;
}

function hash(password, salt = crypto.randomBytes(16).toString("hex")) {
  return `${salt}:${crypto.createHash("sha256").update(`${salt}:${password}`).digest("hex")}`;
}

function verify(password, value) {
  const [salt, digest] = value.split(":");
  return hash(password, salt) === `${salt}:${digest}`;
}

function ensureDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    const now = Date.now();
    const admin = {
      id: ADMIN_ID,
      name: String(process.env.ADMIN_NAME || "站点管理员").trim(),
      passwordHash: hash(String(process.env.ADMIN_PASSWORD || "admin123")),
      role: "admin",
      friends: [],
      blocked: [],
      createdAt: now
    };
    fs.writeFileSync(DB_FILE, JSON.stringify({
      users: [admin],
      sessions: {},
      friendRequests: [],
      messages: [],
      groups: [],
      groupMessages: [],
      moments: [],
      rooms: []
    }, null, 2));
  }
}

function initialDb() {
  const now = Date.now();
  const admin = {
    id: ADMIN_ID,
    name: String(process.env.ADMIN_NAME || "站点管理员").trim(),
    passwordHash: hash(String(process.env.ADMIN_PASSWORD || "admin123")),
    role: "admin",
    friends: [],
    blocked: [],
    createdAt: now
  };
  return {
    users: [admin],
    sessions: {},
    friendRequests: [],
    messages: [],
    groups: [],
    groupMessages: [],
    moments: [],
    rooms: []
  };
}

function loadDb() {
  ensureDb();
  let data;
  try {
    const raw = fs.readFileSync(DB_FILE, "utf8").trim();
    data = raw ? JSON.parse(raw) : initialDb();
  } catch {
    data = initialDb();
  }
  const adminId = ADMIN_ID;
  const adminPassword = String(process.env.ADMIN_PASSWORD || "admin123");
  const adminName = String(process.env.ADMIN_NAME || "站点管理员").trim();
  let admin = data.users.find(u => u.id === adminId);
  if (!admin) {
    admin = { id: adminId, name: adminName, passwordHash: hash(adminPassword), role: "admin", friends: [], blocked: [], createdAt: Date.now() };
    data.users.push(admin);
  } else {
    admin.role = "admin";
    admin.name = admin.name || adminName;
    admin.friends = Array.isArray(admin.friends) ? admin.friends : [];
    admin.blocked = Array.isArray(admin.blocked) ? admin.blocked : [];
  }
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
  return data;
}

let db = loadDb();
if (!Array.isArray(db.groups)) db.groups = [];
if (!Array.isArray(db.groupMessages)) db.groupMessages = [];
if (!Array.isArray(db.moments)) db.moments = [];
if (!Array.isArray(db.rooms)) db.rooms = [];
let saveTimer = null;
function saveDb() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)), 40);
}

const clients = new Map();

function publicUser(user) {
  if (!user) return null;
  return { id: user.id, name: user.name, createdAt: user.createdAt };
}

function selfUser(user) {
  return { ...publicUser(user), role: user.role, canSeeOwnReadReceipts: user.role === "admin" || user.id === ADMIN_ID };
}

function getAuth(req) {
  const raw = req.headers.cookie || "";
  const token = raw.split(";").map(v => v.trim()).find(v => v.startsWith("sid="))?.slice(4);
  const userId = token && db.sessions[token];
  return userId ? db.users.find(u => u.id === userId) : null;
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(body));
}

function text(res, status, body) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 5_000_000) req.destroy();
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch (err) { reject(err); }
    });
  });
}

function requireUser(req, res) {
  const user = getAuth(req);
  if (!user) json(res, 401, { error: "请先登录" });
  return user;
}

function friendship(a, b) {
  return a.friends.includes(b.id) && b.friends.includes(a.id);
}

function blockedEither(a, b) {
  return a.blocked.includes(b.id) || b.blocked.includes(a.id);
}

function conversationId(a, b) {
  return [a, b].sort().join("__");
}

function broadcastTo(userId, event, payload) {
  for (const ws of clients.get(userId) || []) sendWs(ws, { event, payload });
}

function broadcastUsers(userIds, event, payload) {
  [...new Set(userIds)].forEach(userId => broadcastTo(userId, event, payload));
}

function roomUsers(room) {
  return room.players.map(p => p.id);
}

async function handleApi(req, res, url) {
  try {
    if (req.method === "POST" && url.pathname === "/api/register") {
      const body = await readBody(req);
      const userId = String(body.id || "").trim().toLowerCase();
      const name = String(body.name || "").trim();
      const password = String(body.password || "");
      if (!/^[a-z0-9_]{3,18}$/.test(userId)) return json(res, 400, { error: "ID 需为 3-18 位小写字母、数字或下划线" });
      if (!name || password.length < 6) return json(res, 400, { error: "昵称不能为空，密码至少 6 位" });
      if (db.users.some(u => u.id === userId)) return json(res, 409, { error: "该 ID 已存在" });
      const user = { id: userId, name, passwordHash: hash(password), role: "user", friends: [], blocked: [], createdAt: Date.now() };
      db.users.push(user);
      saveDb();
      return json(res, 201, { user: selfUser(user) });
    }

    if (req.method === "POST" && url.pathname === "/api/login") {
      const body = await readBody(req);
      const user = db.users.find(u => u.id === String(body.id || "").trim().toLowerCase());
      if (!user || !verify(String(body.password || ""), user.passwordHash)) return json(res, 401, { error: "账号或密码错误" });
      const sid = id("s_");
      db.sessions[sid] = user.id;
      saveDb();
      return json(res, 200, { user: selfUser(user) }, { "Set-Cookie": `sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000` });
    }

    if (req.method === "POST" && url.pathname === "/api/logout") {
      const raw = req.headers.cookie || "";
      const sid = raw.split(";").map(v => v.trim()).find(v => v.startsWith("sid="))?.slice(4);
      if (sid) delete db.sessions[sid];
      saveDb();
      return json(res, 200, { ok: true }, { "Set-Cookie": "sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0" });
    }

    const me = requireUser(req, res);
    if (!me) return;

    if (req.method === "GET" && url.pathname === "/api/me") {
      const incoming = db.friendRequests.filter(r => r.to === me.id && r.status === "pending");
      const outgoing = db.friendRequests.filter(r => r.from === me.id && r.status === "pending");
      return json(res, 200, {
        user: selfUser(me),
        friends: me.friends.map(fid => publicUser(db.users.find(u => u.id === fid))).filter(Boolean),
        blocked: me.blocked.map(fid => publicUser(db.users.find(u => u.id === fid))).filter(Boolean),
        incoming,
        outgoing
      });
    }

    if (req.method === "GET" && url.pathname === "/api/users/search") {
      const q = String(url.searchParams.get("q") || "").trim().toLowerCase();
      const users = db.users
        .filter(u => u.id !== me.id)
        .filter(u => {
          const uid = String(u.id || "").toLowerCase();
          const uname = String(u.name || "").toLowerCase();
          return !q || uid.includes(q) || uname.includes(q);
        })
        .slice(0, 20)
        .map(u => ({
          ...publicUser(u),
          relation: me.friends.includes(u.id) ? "friend" : "none",
          blocked: me.blocked.includes(u.id),
          pending: db.friendRequests.some(r => r.status === "pending" && ((r.from === me.id && r.to === u.id) || (r.from === u.id && r.to === me.id)))
        }));
      return json(res, 200, { users });
    }

    if (req.method === "GET" && url.pathname === "/api/admin/messages") return json(res, 404, { error: "接口不存在" });

    if (req.method === "POST" && url.pathname === "/api/friends/request") {
      const { to } = await readBody(req);
      const target = db.users.find(u => u.id === String(to || "").trim().toLowerCase());
      if (!target || target.id === me.id) return json(res, 400, { error: "用户不存在" });
      if (blockedEither(me, target)) return json(res, 403, { error: "当前无法发送好友申请" });
      if (friendship(me, target)) return json(res, 409, { error: "已经是好友" });
      const existing = db.friendRequests.find(r => r.status === "pending" && ((r.from === me.id && r.to === target.id) || (r.from === target.id && r.to === me.id)));
      if (existing) return json(res, 409, { error: "已有待处理申请" });
      const request = { id: id("fr_"), from: me.id, to: target.id, status: "pending", createdAt: Date.now() };
      db.friendRequests.push(request);
      saveDb();
      broadcastTo(target.id, "friend-request", request);
      return json(res, 201, { request });
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/friends/respond/")) {
      const requestId = url.pathname.split("/").pop();
      const { action } = await readBody(req);
      const request = db.friendRequests.find(r => r.id === requestId && r.to === me.id && r.status === "pending");
      if (!request) return json(res, 404, { error: "申请不存在" });
      request.status = action === "accept" ? "accepted" : "rejected";
      request.handledAt = Date.now();
      const from = db.users.find(u => u.id === request.from);
      if (request.status === "accepted" && from && !blockedEither(me, from)) {
        if (!me.friends.includes(from.id)) me.friends.push(from.id);
        if (!from.friends.includes(me.id)) from.friends.push(me.id);
      }
      saveDb();
      broadcastUsers([request.from, request.to], "friend-updated", request);
      return json(res, 200, { request });
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/friends/")) {
      const targetId = url.pathname.split("/").pop();
      const target = db.users.find(u => u.id === targetId);
      if (!target) return json(res, 404, { error: "用户不存在" });
      me.friends = me.friends.filter(id => id !== target.id);
      target.friends = target.friends.filter(id => id !== me.id);
      saveDb();
      broadcastUsers([me.id, target.id], "friend-updated", { by: me.id });
      return json(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/block") {
      const { targetId, blocked } = await readBody(req);
      const target = db.users.find(u => u.id === String(targetId || "").toLowerCase());
      if (!target || target.id === me.id) return json(res, 404, { error: "用户不存在" });
      if (blocked) {
        if (!me.blocked.includes(target.id)) me.blocked.push(target.id);
        me.friends = me.friends.filter(id => id !== target.id);
        target.friends = target.friends.filter(id => id !== me.id);
      } else {
        me.blocked = me.blocked.filter(id => id !== target.id);
      }
      saveDb();
      broadcastUsers([me.id, target.id], "friend-updated", { by: me.id });
      return json(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/messages/")) {
      const target = db.users.find(u => u.id === url.pathname.split("/").pop());
      if (!target || !friendship(me, target) || blockedEither(me, target)) return json(res, 403, { error: "只能与好友聊天" });
      const convId = conversationId(me.id, target.id);
      const now = Date.now();
      let changed = false;
      db.messages.forEach(m => {
        if (m.conversationId === convId && m.to === me.id && !m.readAt) {
          m.readAt = now;
          changed = true;
        }
      });
      if (changed) {
        saveDb();
        broadcastUsers([me.id, target.id, "admin"], "message-read", { conversationId: convId, reader: me.id, at: now });
      }
      const messages = db.messages.filter(m => m.conversationId === convId).map(m => ({
        ...m,
        image: m.image || "",
        readAt: (me.role === "admin" || me.id === ADMIN_ID) ? m.readAt : undefined
      }));
      return json(res, 200, { messages });
    }

    if (req.method === "POST" && url.pathname === "/api/messages") {
      const { to, text: messageText, image } = await readBody(req);
      const target = db.users.find(u => u.id === String(to || "").toLowerCase());
      if (!target || !friendship(me, target) || blockedEither(me, target)) return json(res, 403, { error: "只能给未拉黑好友发消息" });
      const msg = {
        id: id("m_"),
        conversationId: conversationId(me.id, target.id),
        from: me.id,
        to: target.id,
        text: String(messageText || "").trim().slice(0, 1000),
        image: String(image || "").trim().slice(0, 2_500_000),
        createdAt: Date.now(),
        readAt: null
      };
      if (!msg.text && !msg.image) return json(res, 400, { error: "消息不能为空" });
      db.messages.push(msg);
      saveDb();
      broadcastUsers([me.id, target.id], "message", msg);
      return json(res, 201, { message: { ...msg, readAt: (me.role === "admin" || me.id === ADMIN_ID) ? null : undefined } });
    }

    if (req.method === "GET" && url.pathname === "/api/groups") {
      const groups = (db.groups || []).filter(g => g.members.includes(me.id)).map(g => ({
        ...g,
        members: g.members.map(uid => publicUser(db.users.find(u => u.id === uid))).filter(Boolean)
      }));
      return json(res, 200, { groups });
    }

    if (req.method === "POST" && url.pathname === "/api/groups") {
      const body = await readBody(req);
      const memberIds = [...new Set([me.id, ...(body.members || []).map(v => String(v).toLowerCase())])];
      const validIds = memberIds.filter(uid => uid === me.id || me.friends.includes(uid));
      const group = {
        id: id("g_"),
        name: String(body.name || "新的群聊").trim().slice(0, 30),
        owner: me.id,
        members: validIds,
        createdAt: Date.now()
      };
      if (!group.name) return json(res, 400, { error: "群名不能为空" });
      if (!Array.isArray(db.groups)) db.groups = [];
      if (!Array.isArray(db.groupMessages)) db.groupMessages = [];
      db.groups.push(group);
      saveDb();
      broadcastUsers(group.members, "groups", { id: group.id });
      return json(res, 201, { group });
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/groups/") && url.pathname.endsWith("/members")) {
      const groupId = url.pathname.split("/")[3];
      const group = (db.groups || []).find(g => g.id === groupId && g.members.includes(me.id));
      if (!group) return json(res, 404, { error: "群聊不存在" });
      const body = await readBody(req);
      const addIds = [...new Set((body.members || []).map(v => String(v).toLowerCase()))]
        .filter(uid => me.friends.includes(uid))
        .filter(uid => !group.members.includes(uid));
      if (!addIds.length) return json(res, 400, { error: "请选择可邀请的好友" });
      group.members.push(...addIds);
      saveDb();
      broadcastUsers(group.members, "groups", { id: group.id });
      return json(res, 200, { group });
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/groups/") && url.pathname.endsWith("/messages")) {
      const groupId = url.pathname.split("/")[3];
      const group = (db.groups || []).find(g => g.id === groupId && g.members.includes(me.id));
      if (!group) return json(res, 404, { error: "群聊不存在" });
      const messages = (db.groupMessages || []).filter(m => m.groupId === groupId);
      return json(res, 200, { messages });
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/groups/") && url.pathname.endsWith("/messages")) {
      const groupId = url.pathname.split("/")[3];
      const group = (db.groups || []).find(g => g.id === groupId && g.members.includes(me.id));
      if (!group) return json(res, 404, { error: "群聊不存在" });
      const body = await readBody(req);
      const msg = {
        id: id("gm_"),
        groupId,
        from: me.id,
        text: String(body.text || "").trim().slice(0, 1000),
        image: String(body.image || "").trim().slice(0, 2_500_000),
        createdAt: Date.now()
      };
      if (!msg.text && !msg.image) return json(res, 400, { error: "消息不能为空" });
      if (!Array.isArray(db.groupMessages)) db.groupMessages = [];
      db.groupMessages.push(msg);
      saveDb();
      broadcastUsers(group.members, "group-message", msg);
      return json(res, 201, { message: msg });
    }

    if (req.method === "GET" && url.pathname === "/api/moments") {
      const moments = db.moments.sort((a, b) => b.createdAt - a.createdAt).map(m => ({
        ...m,
        likes: Array.isArray(m.likes) ? m.likes : [],
        likedBy: (Array.isArray(m.likes) ? m.likes : []).map(uid => publicUser(db.users.find(u => u.id === uid))).filter(Boolean),
        comments: (Array.isArray(m.comments) ? m.comments : []).map(c => ({ ...c, user: publicUser(db.users.find(u => u.id === c.userId)) })),
        user: publicUser(db.users.find(u => u.id === m.userId))
      }));
      return json(res, 200, { moments });
    }

    if (req.method === "POST" && url.pathname === "/api/moments") {
      const body = await readBody(req);
      const moment = {
        id: id("mo_"),
        userId: me.id,
        text: String(body.text || "").trim().slice(0, 500),
        image: String(body.image || "").trim().slice(0, 1_500_000),
        likes: [],
        comments: [],
        createdAt: Date.now()
      };
      if (!moment.text && !moment.image) return json(res, 400, { error: "动态内容不能为空" });
      db.moments.push(moment);
      saveDb();
      broadcastAll("moment", moment);
      return json(res, 201, { moment });
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/moments/") && url.pathname.endsWith("/like")) {
      const moment = db.moments.find(m => m.id === url.pathname.split("/")[3]);
      if (!moment) return json(res, 404, { error: "动态不存在" });
      if (!Array.isArray(moment.likes)) moment.likes = [];
      moment.likes = moment.likes.includes(me.id) ? moment.likes.filter(id => id !== me.id) : [...moment.likes, me.id];
      saveDb();
      broadcastAll("moment", { id: moment.id });
      return json(res, 200, { moment });
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/moments/") && url.pathname.endsWith("/comments")) {
      const moment = db.moments.find(m => m.id === url.pathname.split("/")[3]);
      if (!moment) return json(res, 404, { error: "动态不存在" });
      const body = await readBody(req);
      const textValue = String(body.text || "").trim().slice(0, 300);
      if (!textValue) return json(res, 400, { error: "评论不能为空" });
      if (!Array.isArray(moment.comments)) moment.comments = [];
      const comment = { id: id("c_"), userId: me.id, text: textValue, createdAt: Date.now() };
      moment.comments.push(comment);
      saveDb();
      broadcastAll("moment", { id: moment.id });
      return json(res, 201, { comment });
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/moments/")) {
      const momentId = url.pathname.split("/").pop();
      const moment = db.moments.find(m => m.id === momentId);
      if (!moment) return json(res, 404, { error: "动态不存在" });
      if (moment.userId !== me.id && me.role !== "admin") return json(res, 403, { error: "只能删除自己的动态" });
      db.moments = db.moments.filter(m => m.id !== momentId);
      saveDb();
      broadcastAll("moment", { id: momentId, deleted: true });
      return json(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/api/rooms") {
      return json(res, 200, { rooms: db.rooms.map(room => safeRoom(room, me.id)) });
    }

    if (req.method === "POST" && url.pathname === "/api/rooms") {
      const body = await readBody(req);
      const type = ["bombcat", "jumpchain"].includes(body.type) ? body.type : "drawguess";
      const room = {
        id: id("r_"),
        type,
        name: String(body.name || defaultRoomName(type)).slice(0, 30),
        owner: me.id,
        players: [{ id: me.id, name: me.name, score: 0 }],
        invited: [],
        state: initialGameState(type),
        createdAt: Date.now()
      };
      db.rooms.push(room);
      saveDb();
      broadcastAll("rooms", { rooms: db.rooms.map(r => safeRoom(r)) });
      return json(res, 201, { room: safeRoom(room, me.id) });
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/rooms/")) {
      const roomId = url.pathname.split("/").pop();
      const room = db.rooms.find(r => r.id === roomId);
      if (!room) return json(res, 404, { error: "房间不存在" });
      if (room.owner !== me.id && me.role !== "admin") return json(res, 403, { error: "只能删除自己创建的房间" });
      db.rooms = db.rooms.filter(r => r.id !== roomId);
      saveDb();
      broadcastUsers(roomUsers(room), "room-deleted", { id: roomId });
      broadcastAll("rooms", { rooms: db.rooms.map(r => safeRoom(r)) });
      return json(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/rooms/") && url.pathname.endsWith("/join")) {
      const room = db.rooms.find(r => r.id === url.pathname.split("/")[3]);
      if (!room) return json(res, 404, { error: "房间不存在" });
      if (!room.players.some(p => p.id === me.id)) room.players.push({ id: me.id, name: me.name, score: 0 });
      saveDb();
      broadcastRoom(room);
      return json(res, 200, { room: safeRoom(room, me.id) });
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/rooms/") && url.pathname.endsWith("/invite")) {
      const room = db.rooms.find(r => r.id === url.pathname.split("/")[3]);
      if (!room || !room.players.some(p => p.id === me.id)) return json(res, 404, { error: "房间不存在或未加入" });
      const body = await readBody(req);
      const target = db.users.find(u => u.id === String(body.userId || "").toLowerCase());
      if (!target || !friendship(me, target) || blockedEither(me, target)) return json(res, 403, { error: "只能邀请好友" });
      if (!Array.isArray(room.invited)) room.invited = [];
      if (!room.invited.includes(target.id)) room.invited.push(target.id);
      saveDb();
      broadcastTo(target.id, "room-invite", { room: safeRoom(room, target.id), from: publicUser(me) });
      broadcastRoom(room);
      return json(res, 200, { room: safeRoom(room, me.id) });
    }

    if (req.method === "POST" && url.pathname.startsWith("/api/rooms/") && url.pathname.endsWith("/action")) {
      const room = db.rooms.find(r => r.id === url.pathname.split("/")[3]);
      if (!room || !room.players.some(p => p.id === me.id)) return json(res, 404, { error: "房间不存在或未加入" });
      const body = await readBody(req);
      applyGameAction(room, me, body);
      saveDb();
      broadcastRoom(room);
      return json(res, 200, { room: safeRoom(room, me.id) });
    }

    return json(res, 404, { error: "接口不存在" });
  } catch (err) {
    console.error(err);
    return json(res, 500, { error: "服务器内部错误" });
  }
}

function initialGameState(type) {
  if (type === "bombcat") return { turn: 0, phase: "waiting", log: ["等待玩家加入"], hands: {}, alive: [], deck: [] };
  if (type === "jumpchain") return { target: 3, jumps: [], round: 1, log: ["等待玩家接龙"] };
  return { drawer: null, word: "星空", strokes: [], guesses: [], round: 0 };
}

function defaultRoomName(type) {
  if (type === "bombcat") return "炸弹猫房间";
  if (type === "jumpchain") return "跳一跳接龙房间";
  return "你画我猜房间";
}

function safeRoom(room, viewerId = null) {
  if (room.type === "drawguess") {
    return {
      ...room,
      state: {
        ...room.state,
        word: room.state.drawer === viewerId ? room.state.word : ""
      }
    };
  }
  if (room.type !== "bombcat") return room;
  const hand = viewerId ? (room.state.hands?.[viewerId] || []) : [];
  return {
    ...room,
    state: {
      ...room.state,
      hands: undefined,
      hand,
      handCounts: Object.fromEntries(Object.entries(room.state.hands || {}).map(([userId, cards]) => [userId, cards.length]))
    }
  };
}

function broadcastRoom(room) {
  for (const userId of roomUsers(room)) broadcastTo(userId, "room", safeRoom(room, userId));
}

function applyGameAction(room, user, body) {
  if (room.type === "drawguess") {
    if (body.kind === "start") {
      const words = ["星空", "咖啡", "自行车", "火锅", "宇航员", "雨伞", "吉他"];
      room.state.round += 1;
      room.state.drawer = room.players[room.state.round % room.players.length]?.id || user.id;
      room.state.word = words[Math.floor(Math.random() * words.length)];
      room.state.strokes = [];
      room.state.guesses = [];
    }
    if (body.kind === "stroke" && room.state.drawer === user.id) {
      room.state.strokes.push({
        color: String(body.color || "#17202a").slice(0, 20),
        points: Array.isArray(body.stroke) ? body.stroke : []
      });
      room.state.strokes = room.state.strokes.slice(-400);
    }
    if (body.kind === "clear" && room.state.drawer === user.id) room.state.strokes = [];
    if (body.kind === "undo" && room.state.drawer === user.id) room.state.strokes.pop();
    if (body.kind === "guess") {
      const text = String(body.text || "").trim().slice(0, 30);
      if (!text) return;
      const hit = text === room.state.word && user.id !== room.state.drawer;
      room.state.guesses.push({ userId: user.id, name: user.name, text, hit, at: Date.now() });
      if (hit) {
        const player = room.players.find(p => p.id === user.id);
        if (player) player.score += 1;
      }
    }
    return;
  }

  if (room.type === "jumpchain") {
    if (body.kind === "start") {
      room.state.round += 1;
      room.state.target = 2 + Math.floor(Math.random() * 8);
      room.state.jumps = [];
      room.state.log = [`新目标：跳到 ${room.state.target}`];
      return;
    }
    if (body.kind === "jump") {
      const value = Math.max(0, Math.min(10, Number(body.value || 0)));
      const diff = Math.abs(value - room.state.target);
      const score = Math.max(0, Math.round((10 - diff) * 10));
      const player = room.players.find(p => p.id === user.id);
      if (player) player.score += score;
      room.state.jumps.push({ userId: user.id, name: user.name, value, score, at: Date.now() });
      room.state.log.push(`${user.name} 跳到 ${value}，得 ${score} 分`);
      room.state.log = room.state.log.slice(-20);
    }
    return;
  }

  if (body.kind === "start") {
    room.state.phase = "playing";
    room.state.alive = room.players.map(p => p.id);
    const playerCount = Math.max(room.players.length, 1);
    const cards = ["跳过", "跳过", "预言", "预言", "拆弹", "拆弹", "安全牌", "安全牌", "安全牌"];
    room.state.deck = [...cards, ...cards, ...Array(Math.max(1, playerCount - 1)).fill("炸弹猫")].sort(() => Math.random() - 0.5);
    room.state.hands = Object.fromEntries(room.players.map(p => [p.id, ["拆弹", "跳过", "预言"]]));
    room.state.turn = 0;
    room.state.log = ["游戏开始"];
  }
  if (room.state.phase !== "playing") return;
  const current = room.state.alive[room.state.turn % room.state.alive.length];
  if (current !== user.id) return;
  if (body.kind === "play") {
    const hand = room.state.hands[user.id] || [];
    const idx = hand.indexOf(body.card);
    if (idx < 0) return;
    hand.splice(idx, 1);
    room.state.log.push(`${user.name} 使用 ${body.card}`);
    if (body.card === "跳过") room.state.turn += 1;
    if (body.card === "预言") room.state.log.push(`${user.name} 查看牌堆顶：${room.state.deck.slice(0, 3).join("、") || "空"}`);
  }
  if (body.kind === "draw") {
    const card = room.state.deck.shift() || "安全牌";
    const hand = room.state.hands[user.id] || [];
    if (card === "炸弹猫") {
      const defuse = hand.indexOf("拆弹");
      if (defuse >= 0) {
        hand.splice(defuse, 1);
        room.state.deck.push("炸弹猫");
        room.state.deck.sort(() => Math.random() - 0.5);
        room.state.log.push(`${user.name} 抽到炸弹猫并拆弹`);
      } else {
        room.state.alive = room.state.alive.filter(id => id !== user.id);
        room.state.log.push(`${user.name} 被炸弹猫淘汰`);
      }
    } else {
      hand.push(card);
      room.state.log.push(`${user.name} 抽到 ${card}`);
    }
    if (room.state.alive.length <= 1) {
      room.state.phase = "ended";
      room.state.log.push(`胜者：${room.players.find(p => p.id === room.state.alive[0])?.name || "无人"}`);
    } else {
      room.state.turn += 1;
    }
  }
  room.state.log = room.state.log.slice(-20);
}

function broadcastAll(event, payload) {
  for (const set of clients.values()) for (const ws of set) sendWs(ws, { event, payload });
}

function serveStatic(req, res, url) {
  let file = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  file = path.normalize(file).replace(/^(\.\.[/\\])+/, "");
  const full = path.join(PUBLIC, file);
  if (!full.startsWith(PUBLIC) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) return text(res, 404, "Not found");
  res.writeHead(200, { "Content-Type": mime[path.extname(full)] || "application/octet-stream" });
  fs.createReadStream(full).pipe(res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith("/api/")) return handleApi(req, res, url);
  serveStatic(req, res, url);
});

server.on("upgrade", (req, socket) => {
  const user = getAuth(req);
  if (!user || req.headers.upgrade?.toLowerCase() !== "websocket") return socket.destroy();
  const key = req.headers["sec-websocket-key"];
  const accept = crypto.createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "\r\n"
  ].join("\r\n"));
  if (!clients.has(user.id)) clients.set(user.id, new Set());
  clients.get(user.id).add(socket);
  sendWs(socket, { event: "hello", payload: { user: selfUser(user) } });
  socket.on("close", () => clients.get(user.id)?.delete(socket));
  socket.on("end", () => clients.get(user.id)?.delete(socket));
  socket.on("error", () => clients.get(user.id)?.delete(socket));
});

function sendWs(socket, data) {
  if (socket.destroyed) return;
  const payload = Buffer.from(JSON.stringify(data));
  const header = payload.length < 126 ? Buffer.from([0x81, payload.length]) : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255]);
  socket.write(Buffer.concat([header, payload]));
}

server.listen(PORT, () => {
  console.log(`Social IM platform running at http://localhost:${PORT}`);
});
