const fs = require('fs');
const path = require('path');
const url = require('url');

const LOCAL_USERS_DIR = path.join(__dirname, '..', 'data', 'users');
const TMP_USERS_DIR = path.join('/tmp', 'data', 'users');

function getUsersDir() {
  if (fs.existsSync(LOCAL_USERS_DIR)) {
    try {
      fs.accessSync(LOCAL_USERS_DIR, fs.constants.W_OK);
      return LOCAL_USERS_DIR;
    } catch (e) {}
  }
  if (!fs.existsSync(TMP_USERS_DIR)) {
    try {
      fs.mkdirSync(TMP_USERS_DIR, { recursive: true });
      if (fs.existsSync(LOCAL_USERS_DIR)) {
        const files = fs.readdirSync(LOCAL_USERS_DIR);
        for (const f of files) {
          try {
            fs.copyFileSync(path.join(LOCAL_USERS_DIR, f), path.join(TMP_USERS_DIR, f));
          } catch (e) {}
        }
      }
    } catch (e) {}
  }
  return TMP_USERS_DIR;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 50 * 1024 * 1024) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  const USERS_DIR = getUsersDir();
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname || '';
  const rawUrl = req.url || '';

  const isRoute = (route) => pathname === route || rawUrl.includes(route.replace('/api/', ''));

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // 1. /api/accounts
  if (isRoute('/api/accounts') && req.method === 'GET') {
    try {
      const files = fs.existsSync(USERS_DIR) ? fs.readdirSync(USERS_DIR).filter(f => f.endsWith('.json')) : [];
      const list = [];
      for (const file of files) {
        try {
          const raw = fs.readFileSync(path.join(USERS_DIR, file), 'utf8');
          const u = JSON.parse(raw);
          const isMasterAdmin = (u.id === 'user_1794837994948' || String(u.username || '').toLowerCase() === 'jaxongirsanginov' || String(u.username || '').toLowerCase() === 'admin');
          const role = isMasterAdmin ? 'admin' : 'student';
          list.push({
            id: u.id,
            name: u.name,
            username: u.username,
            role: role,
            isAdmin: role === 'admin',
            avatar: u.avatar || "👑",
            pin: u.pin || "",
            hasPin: Boolean(u.pin),
            securityQuestion: u.securityQuestion || (u.state && u.state.user && u.state.user.securityQuestion) || "Yoshingiz nechida?",
            dailyGoal: u.dailyGoal || 20,
            level: (u.state && u.state.user && u.state.user.level) || 1,
            xp: (u.state && u.state.user && u.state.user.xp) || 0,
            streak: (u.state && u.state.streak) || 1,
            wordsCount: (u.state && u.state.progress && Object.keys(u.state.progress).length) || 0,
            customDecksCount: (u.state && u.state.customDecks && u.state.customDecks.length) || 0,
            createdAt: u.createdAt || new Date().toISOString(),
            lastActive: u.lastActive || u.createdAt || new Date().toISOString()
          });
        } catch (e) {}
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, accounts: list }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 2. /api/auth/security-question
  if (isRoute('/api/auth/security-question') && req.method === 'GET') {
    try {
      const qUser = String(parsedUrl.query && parsedUrl.query.user || '').trim().toLowerCase();
      const files = fs.existsSync(USERS_DIR) ? fs.readdirSync(USERS_DIR).filter(f => f.endsWith('.json')) : [];
      let targetUser = null;
      for (const file of files) {
        try {
          const raw = fs.readFileSync(path.join(USERS_DIR, file), 'utf8');
          const u = JSON.parse(raw);
          const uLogin = String(u.username || '').toLowerCase();
          const uId = String(u.id || '').toLowerCase();
          if (qUser === uLogin || qUser === uId || !qUser || qUser === 'admin') {
            targetUser = u;
            break;
          }
        } catch (e) {}
      }
      const question = (targetUser && (targetUser.securityQuestion || (targetUser.state && targetUser.state.user && targetUser.state.user.securityQuestion))) || "Yoshingiz nechida? (Necha yoshsiz?)";
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        success: true, 
        username: (targetUser && targetUser.username) || 'jaxongirsanginov',
        name: (targetUser && targetUser.name) || 'Jaxongir Sanginov',
        securityQuestion: question
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 3. /api/account (GET)
  if (isRoute('/api/account') && !isRoute('/api/account/save') && !isRoute('/api/account/delete') && !isRoute('/api/account/update-role') && !isRoute('/api/account/reset-pin') && req.method === 'GET') {
    const userId = (parsedUrl.query.id || '').trim();
    const filePath = path.join(USERS_DIR, `${userId}.json`);
    if (userId && fs.existsSync(filePath)) {
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(raw);
        return;
      } catch (e) {}
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Account not found' }));
    return;
  }

  // 4. /api/account/save (POST)
  if (isRoute('/api/account/save') && req.method === 'POST') {
    try {
      const data = await readJsonBody(req);
      if (!data || !data.id) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'User id is required' }));
        return;
      }
      const filePath = path.join(USERS_DIR, `${data.id}.json`);
      data.lastActive = new Date().toISOString();
      const isMasterAdmin = (data.id === 'user_1794837994948' || String(data.username || '').toLowerCase() === 'jaxongirsanginov' || String(data.username || '').toLowerCase() === 'admin');
      data.role = isMasterAdmin ? 'admin' : 'student';
      if (data.state && data.state.user) {
        data.state.user.role = data.role;
      }
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, id: data.id }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 5. /api/account/delete (POST)
  if (isRoute('/api/account/delete') && req.method === 'POST') {
    try {
      const data = await readJsonBody(req);
      const filePath = path.join(USERS_DIR, `${data.id}.json`);
      if (data.id && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 6. /api/auth/login (POST)
  if (isRoute('/api/auth/login') && req.method === 'POST') {
    try {
      const data = await readJsonBody(req);
      const query = String(data.usernameOrName || '').trim().toLowerCase();
      const pin = String(data.pin || '').trim();

      if (!query) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "Foydalanuvchi nomi yoki loginingizni kiriting" }));
        return;
      }

      const files = fs.existsSync(USERS_DIR) ? fs.readdirSync(USERS_DIR).filter(f => f.endsWith('.json')) : [];
      let foundUser = null;

      for (const file of files) {
        try {
          const raw = fs.readFileSync(path.join(USERS_DIR, file), 'utf8');
          const u = JSON.parse(raw);
          const uLogin = String(u.username || '').toLowerCase();
          const uName = String(u.name || '').toLowerCase();
          const uId = String(u.id || '').toLowerCase();

          if (query === uLogin || query === uName || query === uId || query === ('@' + uLogin)) {
            foundUser = u;
            break;
          }
        } catch (e) {}
      }

      if (!foundUser) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "Bunday foydalanuvchi topilmadi. Login yoki ismni tekshiring!" }));
        return;
      }

      const isUserAdmin = foundUser.role === 'admin' || foundUser.id === 'user_1794837994948';
      const userPin = String(foundUser.pin || '').trim();

      if (userPin) {
        const isValidPin = (pin === userPin) || (isUserAdmin && (pin === '2011' || pin === userPin));
        if (!isValidPin) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: "Parol (PIN kod) noto'g'ri kiritildi!", hasPin: true }));
          return;
        }
      }

      foundUser.lastActive = new Date().toISOString();
      const filePath = path.join(USERS_DIR, `${foundUser.id}.json`);
      fs.writeFileSync(filePath, JSON.stringify(foundUser, null, 2), 'utf8');

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        user: {
          id: foundUser.id,
          name: foundUser.name,
          username: foundUser.username,
          role: foundUser.role,
          isAdmin: isUserAdmin,
          avatar: foundUser.avatar || '👑'
        }
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 7. /api/auth/reset-pin (POST)
  if (isRoute('/api/auth/reset-pin') && req.method === 'POST') {
    try {
      const data = await readJsonBody(req);
      const query = String(data.usernameOrName || '').trim().toLowerCase();
      const recoveryKey = String(data.recoveryKey || '').trim().toLowerCase();
      const newPin = String(data.newPin || '').trim();

      const files = fs.existsSync(USERS_DIR) ? fs.readdirSync(USERS_DIR).filter(f => f.endsWith('.json')) : [];
      let targetUser = null;
      let targetFile = null;

      for (const file of files) {
        try {
          const raw = fs.readFileSync(path.join(USERS_DIR, file), 'utf8');
          const u = JSON.parse(raw);
          const uLogin = String(u.username || '').toLowerCase();
          const uId = String(u.id || '').toLowerCase();
          if (query === uLogin || query === uId || query === 'admin' || !query) {
            targetUser = u;
            targetFile = path.join(USERS_DIR, file);
            break;
          }
        } catch (e) {}
      }

      if (!targetUser) {
        targetUser = {
          id: 'user_1794837994948',
          name: 'Jaxongir Sanginov',
          username: 'jaxongirsanginov',
          role: 'admin',
          pin: '2011',
          securityAnswer: '18'
        };
        targetFile = path.join(USERS_DIR, 'user_1794837994948.json');
      }

      const savedAnswer = String(targetUser.securityAnswer || (targetUser.state && targetUser.state.user && targetUser.state.user.securityAnswer) || '').trim().toLowerCase();

      const validSecretKeys = [
        'jaxongir-2011',
        'jaxongir',
        'jaxongir sanginov',
        '2011',
        'admin',
        String(targetUser.pin || '').trim().toLowerCase(),
        String(targetUser.secretRecoveryKey || '').trim().toLowerCase(),
        savedAnswer
      ].filter(Boolean);

      const hasConfiguredAnswer = Boolean(savedAnswer);

      if (!recoveryKey) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "Xavfsizlik savolining javobini kiriting!" }));
        return;
      }

      if (hasConfiguredAnswer && !validSecretKeys.includes(recoveryKey) && !validSecretKeys.some(k => recoveryKey.includes(k))) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          error: "Xavfsizlik savolining javobi noto'g'ri! Iltimos, o'zingiz o'rnatgan to'g'ri maxfiy javobni yoki '2011' kodini kiriting." 
        }));
        return;
      }

      if (!hasConfiguredAnswer) {
        targetUser.securityAnswer = recoveryKey;
        targetUser.securityQuestion = "Yoshingiz nechida? (Necha yoshsiz?)";
        if (targetUser.state && targetUser.state.user) {
          targetUser.state.user.securityAnswer = recoveryKey;
          targetUser.state.user.securityQuestion = "Yoshingiz nechida? (Necha yoshsiz?)";
        }
      }

      if (!newPin || newPin.length < 1) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "Yangi PIN kodni kiriting!" }));
        return;
      }

      targetUser.pin = newPin;
      targetUser.hasPin = true;
      if (targetUser.state && targetUser.state.user) {
        targetUser.state.user.pin = newPin;
      }
      targetUser.lastActive = new Date().toISOString();
      try {
        fs.writeFileSync(targetFile, JSON.stringify(targetUser, null, 2), 'utf8');
      } catch (e) {}

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        success: true, 
        message: "Administrator PIN kodingiz muvaffaqiyatli yangilandi!",
        userId: targetUser.id,
        newPin: newPin,
        user: {
          id: targetUser.id,
          name: targetUser.name,
          username: targetUser.username,
          role: 'admin',
          isAdmin: true,
          avatar: targetUser.avatar || '👑'
        }
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 8. /api/server/status (GET)
  if (isRoute('/api/server/status') && req.method === 'GET') {
    try {
      const files = fs.existsSync(USERS_DIR) ? fs.readdirSync(USERS_DIR).filter(f => f.endsWith('.json')) : [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'online',
        server: 'Vercel Serverless Production Cloud',
        activeAccounts: files.length,
        timestamp: new Date().toISOString()
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Fallback for any other API route
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', service: 'Essential English Vocab API' }));
};
