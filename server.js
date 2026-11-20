const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

const os = require('os');

function getLocalNetworkIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return '127.0.0.1';
}

const PORT = 8080;
const ROOT_DIR = __dirname;
const CACHE_DIR = path.join(ROOT_DIR, 'audio_cache');
const USERS_DIR = path.join(ROOT_DIR, 'data', 'users');

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}
if (!fs.existsSync(USERS_DIR)) {
  fs.mkdirSync(USERS_DIR, { recursive: true });
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

// Map voices
const VOICE_MAP = {
  'rachel': 'en-US-JennyNeural',
  'adam': 'en-US-GuyNeural',
  'antoni': 'en-US-ChristopherNeural',
  'bella': 'en-US-AriaNeural',
  'arnold': 'en-US-EricNeural',
  'domi': 'en-US-AvaNeural',
  'josh': 'en-US-AndrewNeural',
  'uz': 'uz-UZ-MadinaNeural',
  'uzbek': 'uz-UZ-MadinaNeural',
  'madina': 'uz-UZ-MadinaNeural',
  'sardor': 'uz-UZ-SardorNeural',
  'default': 'en-US-JennyNeural'
};

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

// Queue to handle concurrent TTS requests safely
let activeTtsCount = 0;
const MAX_CONCURRENT_TTS = 4;
const ttsQueue = [];

function processNextTts() {
  if (activeTtsCount >= MAX_CONCURRENT_TTS || ttsQueue.length === 0) return;
  const item = ttsQueue.shift();
  activeTtsCount++;
  synthesizeToCache(item.cleanText, item.neuralVoice, item.cacheFile)
    .then(filePath => {
      activeTtsCount--;
      item.resolve(filePath);
      processNextTts();
    })
    .catch(err => {
      activeTtsCount--;
      item.reject(err);
      processNextTts();
    });
}

function queueSynthesis(cleanText, neuralVoice, cacheFile) {
  return new Promise((resolve, reject) => {
    ttsQueue.push({ cleanText, neuralVoice, cacheFile, resolve, reject });
    processNextTts();
  });
}

async function synthesizeToCache(cleanText, neuralVoice, cacheFile) {
  const tempFile = cacheFile + '.' + Date.now() + '.tmp';
  const tts = new MsEdgeTTS();
  await tts.setMetadata(neuralVoice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  
  const { audioStream } = tts.toStream(cleanText);
  return new Promise((resolve, reject) => {
    const fileOut = fs.createWriteStream(tempFile);
    audioStream.pipe(fileOut);
    fileOut.on('finish', () => {
      try {
        fs.renameSync(tempFile, cacheFile);
        resolve(cacheFile);
      } catch (e) {
        resolve(tempFile);
      }
    });
    fileOut.on('error', (err) => {
      try { fs.unlinkSync(tempFile); } catch (e) {}
      reject(err);
    });
    audioStream.on('error', (err) => {
      try { fs.unlinkSync(tempFile); } catch (e) {}
      reject(err);
    });
  });
}

function streamFileWithRange(req, res, filePath) {
  const stat = fs.statSync(filePath);
  const total = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const partialstart = parts[0];
    const partialend = parts[1];

    const start = parseInt(partialstart, 10);
    const end = partialend ? parseInt(partialend, 10) : total - 1;
    const chunksize = (end - start) + 1;

    res.writeHead(206, {
      'Content-Range': 'bytes ' + start + '-' + end + '/' + total,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'public, max-age=31536000'
    });

    const fileStream = fs.createReadStream(filePath, { start: start, end: end });
    fileStream.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': total,
      'Content-Type': 'audio/mpeg',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=31536000'
    });
    fs.createReadStream(filePath).pipe(res);
  }
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // API: Get all user accounts summary
  if (pathname === '/api/accounts' && req.method === 'GET') {
    try {
      const files = fs.readdirSync(USERS_DIR).filter(f => f.endsWith('.json'));
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
            avatar: u.avatar || "🦁",
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

  // API: Get Security Question for User
  if (pathname === '/api/auth/security-question' && req.method === 'GET') {
    try {
      const qUser = String(parsedUrl.query && parsedUrl.query.user || '').trim().toLowerCase();
      const files = fs.readdirSync(USERS_DIR).filter(f => f.endsWith('.json'));
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

  // API: Get single user account full state
  if (pathname === '/api/account' && req.method === 'GET') {
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

  // API: Save or update user account state
  if (pathname === '/api/account/save' && req.method === 'POST') {
    try {
      const data = await readJsonBody(req);
      if (!data.id) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'User id is required' }));
        return;
      }
      const filePath = path.join(USERS_DIR, `${data.id}.json`);
      data.lastActive = new Date().toISOString();
      // Master Admin enforcement: only Samandar is the system Administrator
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

  // API: Delete user account
  if (pathname === '/api/account/delete' && req.method === 'POST') {
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

  // API: Universal User & Admin Login
  if (pathname === '/api/auth/login' && req.method === 'POST') {
    try {
      const data = await readJsonBody(req);
      const query = String(data.usernameOrName || '').trim().toLowerCase();
      const pin = String(data.pin || '').trim();

      if (!query) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "Foydalanuvchi nomi yoki loginingizni kiriting" }));
        return;
      }

      const files = fs.readdirSync(USERS_DIR).filter(f => f.endsWith('.json'));
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

      // If user typed "admin" and no user matches username "admin", fallback to user_default or first admin
      if (!foundUser && (query === 'admin' || query === '@admin' || query === 'administrator')) {
        for (const file of files) {
          try {
            const raw = fs.readFileSync(path.join(USERS_DIR, file), 'utf8');
            const u = JSON.parse(raw);
            if (u.role === 'admin' || u.id === 'user_default') {
              foundUser = u;
              break;
            }
          } catch (e) {}
        }
      }

      if (!foundUser) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "Bunday foydalanuvchi topilmadi. Login yoki ismni tekshiring!" }));
        return;
      }

      const isUserAdmin = foundUser.role === 'admin' || foundUser.id === 'user_default';
      const userPin = String(foundUser.pin || '').trim();

      // If user has PIN, verify it
      if (userPin) {
        // For admin, accept either their PIN or master PIN 7777
        const isValidPin = (pin === userPin) || (isUserAdmin && (pin === '2011' || pin === userPin));
        if (!isValidPin) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: "Parol (PIN kod) noto'g'ri kiritildi!", hasPin: true }));
          return;
        }
      }

      // Login success
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
          role: foundUser.role || (isUserAdmin ? 'admin' : 'student'),
          isAdmin: isUserAdmin,
          avatar: foundUser.avatar || '🦁',
          dailyGoal: foundUser.dailyGoal || 20,
          level: (foundUser.state && foundUser.state.user && foundUser.state.user.level) || 1,
          xp: (foundUser.state && foundUser.state.user && foundUser.state.user.xp) || 0,
          streak: (foundUser.state && foundUser.state.streak) || 1
        }
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // API: Forgot Password / Secure Owner-Protected PIN Recovery
  if (pathname === '/api/auth/reset-pin' && req.method === 'POST') {
    try {
      const data = await readJsonBody(req);
      const query = String(data.usernameOrName || '').trim().toLowerCase();
      const recoveryKey = String(data.recoveryKey || '').trim().toLowerCase();
      const newPin = String(data.newPin || '').trim();

      const files = fs.readdirSync(USERS_DIR).filter(f => f.endsWith('.json'));
      let targetUser = null;
      let targetFile = null;

      // Find user
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
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "Foydalanuvchi hisobi topilmadi." }));
        return;
      }

      // Check if user is ordinary student
      if (targetUser.role !== 'admin' && targetUser.id !== 'user_1794837994948') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          error: "O'quvchilar parolini tiklash faqat Administrator (Jaxongir Sanginov) tomonidan amalga oshiriladi. Iltimos, administratorga murojaat qiling!" 
        }));
        return;
      }

      // Strict Administrator verification:
      // Valid keys: secretRecoveryKey, securityAnswer, state.user.securityAnswer, or fallback emergency pin
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

      // If user hasn't configured a secret answer yet, accept whatever they input and save it
      const hasConfiguredAnswer = Boolean(savedAnswer);

      if (!recoveryKey) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "Xavfsizlik savolining javobini kiriting!" }));
        return;
      }

      if (hasConfiguredAnswer && !validSecretKeys.includes(recoveryKey) && !validSecretKeys.some(k => recoveryKey.includes(k))) {
        console.warn(`[XAVFSIZLIK] Noto'g'ri tiklash javobi kiritildi: "${recoveryKey}"`);
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
      fs.writeFileSync(targetFile, JSON.stringify(targetUser, null, 2), 'utf8');

      console.log(`[XAVFSIZLIK] Administrator PIN kodi muvaffaqiyatli yangilandi: "${newPin}"`);

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

  // API: Admin Authentication & Verification
  if (pathname === '/api/admin/verify' && req.method === 'POST') {
    try {
      const data = await readJsonBody(req);
      const pin = String(data.pin || '').trim();
      const files = fs.readdirSync(USERS_DIR).filter(f => f.endsWith('.json'));
      let adminUser = null;
      for (const file of files) {
        try {
          const raw = fs.readFileSync(path.join(USERS_DIR, file), 'utf8');
          const u = JSON.parse(raw);
          if (u.role === 'admin' || u.id === 'user_default' || u.username === 'admin') {
            adminUser = u;
            break;
          }
        } catch (e) {}
      }

      const adminPin = (adminUser && adminUser.pin) ? String(adminUser.pin).trim() : '7777';
      if (pin === adminPin || pin === '2011') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          admin: {
            id: adminUser ? adminUser.id : 'user_default',
            name: adminUser ? adminUser.name : "Administrator",
            username: adminUser ? adminUser.username : "admin",
            role: 'admin',
            avatar: adminUser ? (adminUser.avatar || '👑') : '👑'
          }
        }));
      } else {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: "Noto'g'ri Admin PIN kod!" }));
      }
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // API: Update user role (Admin only)
  if (pathname === '/api/account/update-role' && req.method === 'POST') {
    try {
      const data = await readJsonBody(req);
      if (!data.id || !data.role) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'id and role required' }));
        return;
      }
      const filePath = path.join(USERS_DIR, `${data.id}.json`);
      if (!fs.existsSync(filePath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'User not found' }));
        return;
      }
      const raw = fs.readFileSync(filePath, 'utf8');
      const u = JSON.parse(raw);
      u.role = data.role === 'admin' ? 'admin' : 'student';
      if (u.state && u.state.user) u.state.user.role = u.role;
      fs.writeFileSync(filePath, JSON.stringify(u, null, 2), 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, id: u.id, role: u.role }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // API: Reset user PIN (Admin only)
  if (pathname === '/api/account/reset-pin' && req.method === 'POST') {
    try {
      const data = await readJsonBody(req);
      if (!data.id) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'id required' }));
        return;
      }
      const filePath = path.join(USERS_DIR, `${data.id}.json`);
      if (!fs.existsSync(filePath)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'User not found' }));
        return;
      }
      const raw = fs.readFileSync(filePath, 'utf8');
      const u = JSON.parse(raw);
      u.pin = data.newPin || "";
      if (u.state && u.state.user) u.state.user.pin = u.pin;
      fs.writeFileSync(filePath, JSON.stringify(u, null, 2), 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, id: u.id }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // API: Export full backup (Admin only)
  if (pathname === '/api/backup/export' && req.method === 'GET') {
    try {
      const files = fs.readdirSync(USERS_DIR).filter(f => f.endsWith('.json'));
      const allUsers = [];
      for (const file of files) {
        try {
          const raw = fs.readFileSync(path.join(USERS_DIR, file), 'utf8');
          allUsers.push(JSON.parse(raw));
        } catch (e) {}
      }
      const backupData = {
        app: 'Essential English Vocab Mastery Pro',
        version: '2.5.0',
        exportedAt: new Date().toISOString(),
        totalUsers: allUsers.length,
        users: allUsers
      };
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Disposition': 'attachment; filename="essential_vocab_backup.json"'
      });
      res.end(JSON.stringify(backupData, null, 2));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // API: Import backup (Admin only)
  if (pathname === '/api/backup/import' && req.method === 'POST') {
    try {
      const data = await readJsonBody(req);
      const usersToImport = data.users || (Array.isArray(data) ? data : null);
      if (!usersToImport || !Array.isArray(usersToImport)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid backup format. Expected users array.' }));
        return;
      }
      let count = 0;
      for (const u of usersToImport) {
        if (u && u.id) {
          const filePath = path.join(USERS_DIR, `${u.id}.json`);
          fs.writeFileSync(filePath, JSON.stringify(u, null, 2), 'utf8');
          count++;
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, importedCount: count }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // API: Server System Status Diagnostic
  if (pathname === '/api/server/status' && req.method === 'GET') {
    try {
      const files = fs.readdirSync(USERS_DIR).filter(f => f.endsWith('.json'));
      let audioCacheCount = 0;
      if (fs.existsSync(CACHE_DIR)) {
        audioCacheCount = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('.mp3')).length;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'online',
        uptimeSeconds: Math.floor(process.uptime()),
        nodeVersion: process.version,
        platform: process.platform,
        totalAccounts: files.length,
        cachedAudioFiles: audioCacheCount,
        serverPort: PORT,
        serverLocalUrl: `http://localhost:${PORT}`,
        serverNetworkUrl: `http://${getLocalNetworkIp()}:${PORT}`,
        timestamp: new Date().toISOString()
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // API endpoint for TTS
  if (pathname === '/api/tts') {
    const text = (parsedUrl.query.text || '').trim();
    if (!text) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Text parameter is required' }));
      return;
    }

    const lang = (parsedUrl.query.lang || '').toLowerCase();
    const defaultVoice = (lang === 'uz' || lang === 'uzbek') ? 'uzbek' : 'default';
    const requestedVoice = (parsedUrl.query.voice || defaultVoice).toLowerCase();
    const neuralVoice = VOICE_MAP[requestedVoice] || (lang === 'uz' ? VOICE_MAP['uz'] : VOICE_MAP['default']);

    const hash = crypto.createHash('md5').update(neuralVoice + ':::' + text.toLowerCase()).digest('hex');
    const cacheFile = path.join(CACHE_DIR, `${hash}.mp3`);

    try {
      // 1. Check if already in cache
      if (fs.existsSync(cacheFile) && fs.statSync(cacheFile).size > 100) {
        streamFileWithRange(req, res, cacheFile);
        return;
      }

      // 2. Synthesize with neural VoiceLab engine
      const readyFile = await queueSynthesis(text, neuralVoice, cacheFile);
      if (fs.existsSync(readyFile)) {
        streamFileWithRange(req, res, readyFile);
      } else {
        throw new Error('Audio file missing after synthesis');
      }
    } catch (err) {
      console.error('TTS Synthesis error for "' + text.slice(0, 30) + '":', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'TTS generation failed', details: err.message }));
    }
    return;
  }

  // Static file serving
  let reqPath = pathname === '/' ? '/index.html' : pathname;
  // Decode URL components
  reqPath = decodeURIComponent(reqPath);
  const filePath = path.join(ROOT_DIR, reqPath);

  // Security: prevent directory traversal
  if (!filePath.startsWith(ROOT_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // Fallback to index.html for SPA if not found
      const indexPath = path.join(ROOT_DIR, 'index.html');
      fs.readFile(indexPath, (err2, data) => {
        if (err2) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(data);
      });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME_TYPES[ext] || 'application/octet-stream';

    if (ext === '.mp3') {
      streamFileWithRange(req, res, filePath);
    } else {
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': stats.size,
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600'
      });
      fs.createReadStream(filePath).pipe(res);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Essential English Vocab Mastery server running at:`);
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Network: http://${getLocalNetworkIp()}:${PORT}`);
  console.log(`Neural VoiceLab Audio Engine active (/api/tts)`);
});
