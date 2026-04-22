require('dotenv').config(); // 从 .env 文件加载环境变量
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const mysql = require('mysql2/promise');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const xml2js = require('xml2js');
const OSS = require('ali-oss');
const multer = require('multer');
const path = require('path');

const app = express();

// ================= 1. 核心配置区 =================
const JWT_SECRET   = process.env.JWT_SECRET;
const WECHAT_TOKEN = process.env.WECHAT_TOKEN;
const WANX_KEY     = process.env.WANX_KEY;
const WUYIN_KEY    = process.env.WUYIN_KEY;
const DOUBAO_KEY   = process.env.DOUBAO_KEY;

// ⚠️ OSS 配置（阿里云对象存储，用于持久化生成图片）
const ossClient = new OSS({
    region:          process.env.OSS_REGION,
    accessKeyId:     process.env.OSS_ACCESS_KEY_ID,
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
    bucket:          process.env.OSS_BUCKET,
});

// ⚠️ 数据库配置
const dbConfig = {
    host:            process.env.DB_HOST,
    user:            process.env.DB_USER,
    password:        process.env.DB_PASSWORD,
    database:        process.env.DB_NAME,
    connectionLimit: 20,
};
const db = mysql.createPool(dbConfig);

// Auto-migrate: 各种表结构升级
(async () => {
    const migrations = [
        "ALTER TABLE generations ADD COLUMN ref_urls TEXT DEFAULT NULL",
        "ALTER TABLE generations ADD COLUMN size VARCHAR(16) DEFAULT NULL",
        "ALTER TABLE generations ADD COLUMN aspect_ratio VARCHAR(16) DEFAULT NULL",
        "ALTER TABLE users ADD COLUMN is_admin TINYINT(1) DEFAULT 0",
        "ALTER TABLE users ADD COLUMN public_uid VARCHAR(16) DEFAULT NULL",
        "ALTER TABLE users ADD COLUMN nickname VARCHAR(32) DEFAULT NULL",
        "ALTER TABLE users ADD COLUMN avatar_url VARCHAR(512) DEFAULT NULL",
        "ALTER TABLE generations ADD COLUMN is_favorite TINYINT(1) DEFAULT 0",
        "ALTER TABLE users ADD COLUMN banned TINYINT(1) DEFAULT 0",
        "ALTER TABLE users ADD COLUMN ban_reason VARCHAR(255) DEFAULT NULL",
        "ALTER TABLE users ADD COLUMN banned_at DATETIME DEFAULT NULL",
        "ALTER TABLE users ADD COLUMN last_login_at DATETIME DEFAULT NULL",
        "ALTER TABLE users ADD COLUMN last_login_ip VARCHAR(64) DEFAULT NULL",
    ];
    for (const sql of migrations) {
        try {
            await db.query(sql);
            console.log('[MIGRATE]', sql);
        } catch(e) {
            if (!e.message.includes('Duplicate column')) console.log('[MIGRATE warn]', e.message);
        }
    }
    // 新建表
    const createTables = [
        `CREATE TABLE IF NOT EXISTS redeem_codes (
            id INT PRIMARY KEY AUTO_INCREMENT,
            code VARCHAR(32) UNIQUE NOT NULL,
            coins INT NOT NULL,
            price DECIMAL(10,2) DEFAULT NULL,
            batch_id VARCHAR(32) DEFAULT NULL,
            used_by INT DEFAULT NULL,
            used_at DATETIME DEFAULT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            expires_at DATETIME DEFAULT NULL,
            INDEX idx_batch (batch_id),
            INDEX idx_used_by (used_by)
        )`,
        `CREATE TABLE IF NOT EXISTS login_logs (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id INT NOT NULL,
            ip VARCHAR(64),
            user_agent VARCHAR(512),
            login_method VARCHAR(16) DEFAULT 'email',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_user (user_id, created_at)
        )`,
        `CREATE TABLE IF NOT EXISTS ip_bans (
            id INT AUTO_INCREMENT PRIMARY KEY,
            ip VARCHAR(64) NOT NULL UNIQUE,
            reason VARCHAR(255),
            banned_by INT,
            banned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            unbanned_at DATETIME DEFAULT NULL,
            INDEX idx_ip (ip, unbanned_at)
        )`,
        `CREATE TABLE IF NOT EXISTS admin_logs (
            id INT AUTO_INCREMENT PRIMARY KEY,
            admin_id INT NOT NULL,
            action VARCHAR(64) NOT NULL,
            target_user_id INT DEFAULT NULL,
            detail TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_admin (admin_id, created_at),
            INDEX idx_target (target_user_id)
        )`,
        `CREATE TABLE IF NOT EXISTS coin_logs (
            id INT PRIMARY KEY AUTO_INCREMENT,
            user_id INT NOT NULL,
            type ENUM('recharge','consume','refund') NOT NULL,
            amount INT NOT NULL,
            balance_after INT DEFAULT NULL,
            description VARCHAR(200) DEFAULT NULL,
            related_id VARCHAR(64) DEFAULT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_user_time (user_id, created_at),
            INDEX idx_type (type)
        )`,
    ];
    for (const sql of createTables) {
        try {
            await db.query(sql);
            console.log('[MIGRATE TABLE]', sql.substring(0, 60) + '...');
        } catch(e) {
            console.log('[MIGRATE TABLE warn]', e.message);
        }
    }
})();

// ========== 积分流水记录函数 ==========
// 记录一条积分变动日志（不修改 users.coins，只记流水）
async function logCoin(userId, type, amount, description, relatedId) {
    try {
        const [rows] = await db.query('SELECT coins FROM users WHERE id = ?', [userId]);
        const balance = rows[0]?.coins ?? null;
        await db.query(
            'INSERT INTO coin_logs (user_id, type, amount, balance_after, description, related_id) VALUES (?, ?, ?, ?, ?, ?)',
            [userId, type, amount, balance, description || null, relatedId || null]
        );
    } catch(e) {
        console.log('[logCoin ERR]', e.message);
    }
}

// 生成不重复的 8 位随机数字 UID
async function genPublicUid() {
    for (let i = 0; i < 50; i++) {
        // 首位不为 0，避免 0 开头
        const uid = String(Math.floor(10000000 + Math.random() * 90000000));
        const [rows] = await db.query('SELECT id FROM users WHERE public_uid = ? LIMIT 1', [uid]);
        if (rows.length === 0) return uid;
    }
    // 极小概率反复冲突，兜底
    return String(Date.now()).slice(-8);
}

const transporter = nodemailer.createTransport({
    host: 'smtp.qq.com', port: 465, secure: true,
    auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS },
});

// ================= 安全：速率限制 =================
const rateLimitMap = new Map(); // userId -> { count, resetTime }
function rateLimit(maxRequests, windowMs) {
    return (req, res, next) => {
        const userId = req.user?.id || req.ip;
        const now = Date.now();
        let entry = rateLimitMap.get(userId);
        if (!entry || now > entry.resetTime) {
            entry = { count: 0, resetTime: now + windowMs };
            rateLimitMap.set(userId, entry);
        }
        entry.count++;
        if (entry.count > maxRequests) {
            return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
        }
        next();
    };
}
// 定期清理过期记录
setInterval(() => {
    const now = Date.now();
    for (const [key, val] of rateLimitMap) {
        if (now > val.resetTime) rateLimitMap.delete(key);
    }
}, 60000);

// Multer 配置：内存存储，限制 10MB
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
        if (allowed.includes(file.mimetype)) cb(null, true);
        else cb(new Error('仅支持 JPG/PNG/WEBP/GIF 格式'));
    }
});

app.use(cors());
// 新增：全局禁止 API 缓存中间件，防止 CDN 导致的数据串台
app.use('/api', (req, res, next) => {
    if (req.method === 'GET') {
        res.set({
            'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
            'Pragma': 'no-cache',
            'Surrogate-Control': 'no-store',
            'Expires': '0',
        });
    }
    next();
});
app.post(['/wechat/message', '/api/wechat/message'], express.text({ type: ['text/xml', 'application/xml'] }));
app.use(express.json({ limit: '15mb' }));

app.get(['/check', '/api/check'], (req, res) => res.status(200).send('<h1>HaotuPro Backend is Online!</h1>'));
app.get(['/', '/api', '/wechat/message', '/api/wechat/message'], (req, res) => {
    const { signature, timestamp, nonce, echostr } = req.query;
    if (!signature || !timestamp || !nonce) return res.status(200).send('HaotuPro API Node Server is Running.');
    const list = [WECHAT_TOKEN, timestamp, nonce].sort().join('');
    if (crypto.createHash('sha1').update(list).digest('hex') === signature) res.status(200).send(echostr); 
    else res.status(403).send('fail');
});

// ================= 2. 安全鉴权 =================
// 从请求中提取真实 IP
function getClientIp(req) {
    return (req.headers['x-real-ip']
         || req.headers['x-forwarded-for']?.split(',')[0]?.trim()
         || req.connection?.remoteAddress
         || req.socket?.remoteAddress
         || '').replace(/^::ffff:/, '');
}

// 检查 IP 是否被封禁（查库 + 内存缓存 30 秒）
const ipBanCache = { list: new Set(), expireAt: 0 };
async function isIpBanned(ip) {
    if (!ip) return false;
    const now = Date.now();
    if (now > ipBanCache.expireAt) {
        try {
            const [rows] = await db.query('SELECT ip FROM ip_bans WHERE unbanned_at IS NULL');
            ipBanCache.list = new Set(rows.map(r => r.ip));
            ipBanCache.expireAt = now + 30000;
        } catch(e) {}
    }
    return ipBanCache.list.has(ip);
}
function invalidateIpBanCache() { ipBanCache.expireAt = 0; }

// 管理员操作日志辅助
async function logAdmin(adminId, action, targetUserId, detail) {
    try {
        await db.query(
            'INSERT INTO admin_logs (admin_id, action, target_user_id, detail) VALUES (?, ?, ?, ?)',
            [adminId, action, targetUserId || null, typeof detail === 'string' ? detail : JSON.stringify(detail || {})]
        );
    } catch(e) { console.log('[logAdmin fail]', e.message); }
}

async function secureAuth(req, res, next) {
    // 先检查 IP 封禁（所有接口，包括未登录的）
    const ip = getClientIp(req);
    if (await isIpBanned(ip)) {
        return res.status(403).json({ error: '您的 IP 已被封禁，如有疑问请联系客服' });
    }

    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: '请先登录' });
    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const [rows] = await db.query('SELECT id, coins, token_version, email, wechat_openid, public_uid, nickname, avatar_url, is_admin, banned, ban_reason FROM users WHERE id = ?', [decoded.id]);
        if (rows.length === 0 || (decoded.version && decoded.version !== rows[0].token_version)) return res.status(401).json({ error: '账号已在其他设备登录' });
        if (rows[0].banned) {
            return res.status(403).json({ error: '账号已被封禁：' + (rows[0].ban_reason || '违反使用条款') });
        }
        req.user = rows[0]; next();
    } catch (err) { res.status(401).json({ error: '登录态失效' }); }
}


// 微信登录
app.post(['/wechat/message', '/api/wechat/message'], async (req, res) => {
    xml2js.parseString(req.body, { explicitArray: false }, async (err, result) => {
        if (err || !result.xml || result.xml.MsgType !== 'text') return res.send('success');
        const { FromUserName, Content, ToUserName } = result.xml;
        const [rows] = await db.query('SELECT * FROM wx_login_codes WHERE code = ? AND status = "pending" AND expires_at > NOW()', [Content.trim()]);
        let reply = "⚠️ 安全码无效或已过期。";
        if (rows.length > 0) {
            await db.query('UPDATE wx_login_codes SET status = "success", openid = ? WHERE code = ?', [FromUserName, Content.trim()]);
            reply = "✅ 认证通过！请在网页端查看。";
        }
        res.set('Content-Type', 'text/xml').send(`<xml><ToUserName><![CDATA[${FromUserName}]]></ToUserName><FromUserName><![CDATA[${ToUserName}]]></FromUserName><CreateTime>${Math.floor(Date.now()/1000)}</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[${reply}]]></Content></xml>`);
    });
});
app.get('/api/auth/wechat/get-code', async (req, res) => {
    const code = Math.floor(100000 + Math.random() * 899999).toString();
    await db.query('INSERT INTO wx_login_codes (code, expires_at) VALUES (?, NOW() + INTERVAL 5 MINUTE)', [code]);
    res.json({ code });
});
app.get('/api/auth/wechat/check', async (req, res) => {
    const { code } = req.query;
    const ip = getClientIp(req);
    if (await isIpBanned(ip)) return res.status(403).json({ error: '您的 IP 已被封禁' });
    const [rows] = await db.query('SELECT openid FROM wx_login_codes WHERE code = ? AND status = "success"', [code]);
    if (rows.length > 0) {
        const openid = rows[0].openid;
        let [users] = await db.query('SELECT id, token_version, banned, ban_reason FROM users WHERE wechat_openid = ?', [openid]);
        if (users[0]?.banned) return res.status(403).json({ error: '账号已被封禁：' + (users[0].ban_reason || '违反使用条款') });
        let userId, newVersion;
        if (users.length === 0) {
            const newUid = await genPublicUid();
            const [reg] = await db.query('INSERT INTO users (wechat_openid, coins, public_uid) VALUES (?, 100, ?)', [openid, newUid]);
            userId = reg.insertId; newVersion = 1;
        } else {
            userId = users[0].id; newVersion = (users[0].token_version || 1) + 1;
            await db.query('UPDATE users SET token_version = ? WHERE id = ?', [newVersion, userId]);
        }
        // 记录登录 + 更新最后登录
        const ua = req.headers['user-agent'] || '';
        db.query('INSERT INTO login_logs (user_id, ip, user_agent, login_method) VALUES (?, ?, ?, ?)', [userId, ip, ua.slice(0,500), 'wechat']).catch(()=>{});
        db.query('UPDATE users SET last_login_at = NOW(), last_login_ip = ? WHERE id = ?', [ip, userId]).catch(()=>{});
        res.json({ token: jwt.sign({ id: userId, version: newVersion }, JWT_SECRET, { expiresIn: '7d' }) });
        await db.query('DELETE FROM wx_login_codes WHERE code = ?', [code]);
    } else res.status(400).json({ error: 'wait' });
});

// 邮箱登录
app.post('/api/auth/send-code', async (req, res) => {
    const { email } = req.body;
    const code = Math.floor(100000 + Math.random() * 899999).toString();
    try {
        await db.query('INSERT INTO verification_codes (email, code, expires_at) VALUES (?, ?, NOW() + INTERVAL 5 MINUTE) ON DUPLICATE KEY UPDATE code=?, expires_at=NOW() + INTERVAL 5 MINUTE', [email, code, code]);
        await transporter.sendMail({ from: `"HaotuPro" <${transporter.options.auth.user}>`, to: email, subject: '登录验证码', text: `您的验证码是：${code}，5分钟内有效。` });
        res.json({ message: 'ok' });
    } catch (e) { res.status(500).json({ error: '发信失败' }); }
});
app.post('/api/auth/login-email', async (req, res) => {
    const { email, code } = req.body;
    const ip = getClientIp(req);
    // 检查 IP 封禁
    if (await isIpBanned(ip)) return res.status(403).json({ error: '您的 IP 已被封禁' });

    const [rows] = await db.query('SELECT * FROM verification_codes WHERE email = ? AND code = ? AND expires_at > NOW()', [email, code]);
    if (rows.length === 0) return res.status(400).json({ error: '验证码错误' });

    let [users] = await db.query('SELECT id, token_version, banned, ban_reason FROM users WHERE email = ?', [email]);
    let userId, newVersion;
    if (users.length === 0) {
        const newUid = await genPublicUid();
        const [reg] = await db.query('INSERT INTO users (email, coins, public_uid) VALUES (?, 100, ?)', [email, newUid]);
        userId = reg.insertId; newVersion = 1;
    } else {
        // 封禁账号拒绝登录
        if (users[0].banned) return res.status(403).json({ error: '账号已被封禁：' + (users[0].ban_reason || '违反使用条款') });
        userId = users[0].id; newVersion = (users[0].token_version || 1) + 1;
        await db.query('UPDATE users SET token_version = ? WHERE id = ?', [newVersion, userId]);
    }

    // 记录登录 + 更新用户最后登录
    const ua = req.headers['user-agent'] || '';
    db.query('INSERT INTO login_logs (user_id, ip, user_agent, login_method) VALUES (?, ?, ?, ?)', [userId, ip, ua.slice(0,500), 'email']).catch(()=>{});
    db.query('UPDATE users SET last_login_at = NOW(), last_login_ip = ? WHERE id = ?', [ip, userId]).catch(()=>{});

    res.json({ token: jwt.sign({ id: userId, version: newVersion }, JWT_SECRET, { expiresIn: '7d' }) });
});

// ================= 3. 查询进度代理 (解决跨域，防止转圈) =================
app.get('/api/proxy/wanx/tasks/:taskId', secureAuth, async (req, res) => {
    // 增加严格校验：只有这个任务确实属于当前用户，才允许查询进度
    // 由于此接口是通过 remote task id 查询，后端需遍历 taskQueue 来验证归属
    let isOwner = false;
    for (const [id, t] of taskQueue) {
        if (t.remoteTaskId === req.params.taskId || t.pollTaskId === req.params.taskId) {
            if (t.userId === req.user.id) isOwner = true;
            break;
        }
    }
    // 临时放行策略：为了防止旧任务卡死，如果不在内存队列中，也拒绝（或可以选放行，但为了安全建议拒绝）
    if (!isOwner) {
        return res.status(403).json({ error: '无权访问或任务已过期' });
    }

    try {
        const response = await axios.get(`https://dashscope.aliyuncs.com/api/v1/tasks/${req.params.taskId}`, { headers: { 'Authorization': `Bearer ${WANX_KEY}` } });
        res.json(response.data);
    } catch(err) { res.status(500).json({error: '万相查询失败'}); }
});

app.get('/api/proxy/wuyin/detail', secureAuth, async (req, res) => {
    // 增加严格校验：只有这个任务确实属于当前用户，才允许查询进度
    let isOwner = false;
    for (const [id, t] of taskQueue) {
        if (t.remoteTaskId === req.query.id || t.pollTaskId === req.query.id) {
            if (t.userId === req.user.id) isOwner = true;
            break;
        }
    }
    if (!isOwner) {
        return res.status(403).json({ error: '无权访问或任务已过期' });
    }

    try {
        const response = await axios.get(`https://api.wuyinkeji.com/api/async/detail?id=${req.query.id}&key=${WUYIN_KEY}`);
        // 临时调试：打印完整返回结构
        console.log('[WUYIN DETAIL]', JSON.stringify(response.data));
        res.json(response.data);
    } catch(err) { 
        console.log('[WUYIN DETAIL ERROR]', err.message);
        res.status(500).json({error: '无界查询失败', detail: err.message}); 
    }
});

// ================= 3.5 图片上传代理（替代 ImgBB，零 Key 暴露）=================
app.post('/api/upload', secureAuth, rateLimit(30, 60000), (req, res) => {
    upload.single('image')(req, res, async (err) => {
        if (err) return res.status(400).json({ error: err.message || '上传失败' });
        if (!req.file) return res.status(400).json({ error: '未选择文件' });
        try {
            const ext = req.file.mimetype.split('/')[1] === 'jpeg' ? 'jpg' : req.file.mimetype.split('/')[1];
            const filename = `uploads/${req.user.id}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
            await ossClient.put(filename, req.file.buffer);
            const signedUrl = ossClient.signatureUrl(filename, { expires: 7 * 24 * 3600 }).replace('http://', 'https://');
            res.json({ url: signedUrl, oss_path: filename });
        } catch (e) {
            console.log('[UPLOAD ERROR]', e.message);
            res.status(500).json({ error: '上传到 OSS 失败' });
        }
    });
});

// 支持 base64 上传（粘贴图片场景）
app.post('/api/upload-base64', secureAuth, rateLimit(30, 60000), async (req, res) => {
    const { image } = req.body; // base64 string (不含 data:image/... 前缀)
    if (!image) return res.status(400).json({ error: '无图片数据' });
    try {
        const buffer = Buffer.from(image, 'base64');
        if (buffer.length > 10 * 1024 * 1024) return res.status(400).json({ error: '图片超过 10MB' });
        // 通过 magic bytes 检测格式
        let ext = 'jpg';
        if (buffer[0] === 0x89 && buffer[1] === 0x50) ext = 'png';
        else if (buffer[0] === 0x47 && buffer[1] === 0x49) ext = 'gif';
        else if (buffer[0] === 0x52 && buffer[1] === 0x49) ext = 'webp';
        const filename = `uploads/${req.user.id}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
        await ossClient.put(filename, buffer);
        const signedUrl = ossClient.signatureUrl(filename, { expires: 7 * 24 * 3600 }).replace('http://', 'https://');
        res.json({ url: signedUrl, oss_path: filename });
    } catch (e) {
        console.log('[UPLOAD B64 ERROR]', e.message);
        res.status(500).json({ error: '上传失败' });
    }
});

// ================= 4. 统一异步任务队列 =================
// 内存任务队列：所有模型统一 提交→拿ID→轮询 模式
const taskQueue = new Map(); // localTaskId -> { userId, status, resultUrls, errorMsg, provider, model, prompt, createdAt }

// 清理超过30分钟的已完成任务
setInterval(() => {
    const now = Date.now();
    for (const [id, t] of taskQueue) {
        // 强制清理超过30分钟的所有任务，防止特殊任务造成内存泄漏
        if (now - t.createdAt > 30 * 60 * 1000) taskQueue.delete(id);
    }
}, 60000);

// 提交任务（统一入口）
app.post('/api/task/submit', secureAuth, rateLimit(20, 60000), async (req, res) => {
    const { provider, action, body: taskBody } = req.body;
    const act = action || '';
    // 按模型+分辨率计费（与前端 COST_TABLE 对应）
    const costTable = {
        'image_nanoBanana2':    { '1K': 20, '2K': 25, '4K': 30 },
        'image_nanoBanana_pro': { '1K': 50, '2K': 65, '4K': 80 },
        'image_gpt':            { '1K': 20, '2K': 25, '4K': 30 },
        'wan2.7-image':         { '1K': 30, '2K': 40, '4K': 50 },
        'wan2.7-image-pro':     { '1K': 60, '2K': 80, '4K': 100 },
        'doubao_seedream':      { '1K': 30, '2K': 40, '4K': 50 },
        'doubao':               { '1K': 30, '2K': 40, '4K': 50 },
        'responses':            { '1K': 10, '2K': 10, '4K': 10 },
    };

    let key;
    if (provider === 'wuyin') key = act;
    else if (provider === 'wanx') key = taskBody?.model || 'wan2.7-image-pro';
    else key = provider;

    let cost;
    if (key === 'video_grok_imagine') {
        const dur = parseInt(taskBody?.duration) || 10;
        const vidCostMap = { 6: 60, 10: 100, 15: 150, 20: 200, 30: 300 };
        cost = vidCostMap[dur] || Math.ceil(dur * 10);
    } else {
        const sizeKey = (taskBody?.size || '1K').toUpperCase();
        const validSize = ['1K','2K','4K'].includes(sizeKey) ? sizeKey : '1K';
        const modelCosts = costTable[key];
        cost = modelCosts ? (modelCosts[validSize] || modelCosts['1K']) : 10;
    }

    if (req.user.coins < cost) return res.status(402).json({ error: '余额不足，请充值' });
    if (cost > 0) {
        const [update] = await db.query('UPDATE users SET coins = coins - ? WHERE id = ? AND coins >= ?', [cost, req.user.id, cost]);
        if (update.affectedRows === 0) return res.status(402).json({ error: '扣费失败' });
        await logCoin(req.user.id, 'consume', cost, `生成图像 · ${key}`, null);
    }

    // 生成本地任务ID，立即返回给前端
    const localTaskId = 'htask_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const taskEntry = {
        userId: req.user.id, status: 'pending', resultUrls: [], errorMsg: null,
        provider, action: act, model: key, cost, createdAt: Date.now()
    };
    taskQueue.set(localTaskId, taskEntry);
    
    // 立即返回任务ID
    res.json({ code: 200, taskId: localTaskId });

    // 后台异步执行实际 API 调用
    (async () => {
        try {
            let resp;
            if (provider === 'wanx') {
                resp = await axios.post('https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation', taskBody, { 
                    headers: { 'Authorization': `Bearer ${WANX_KEY}`, 'Content-Type': 'application/json' },
                    timeout: 300000
                });
                const d = resp.data;
                if (d.output?.choices?.length > 0) {
                    const urls = [];
                    d.output.choices.forEach(c => (c.message?.content || []).forEach(item => { if (item.type === 'image' && item.image) urls.push(item.image); }));
                    taskEntry.status = 'success'; taskEntry.resultUrls = urls;
                } else {
                    taskEntry.status = 'error'; taskEntry.errorMsg = d.message || JSON.stringify(d);
                }
            } else if (provider === 'wuyin') {
                resp = await axios.post(`https://api.wuyinkeji.com/api/async/${act}`, taskBody, { 
                    headers: { 'Authorization': WUYIN_KEY, 'Content-Type': 'application/json' },
                    timeout: 30000
                });
                const d = resp.data;
                const remoteTaskId = d.data?.task_id || d.data?.id;
                if (d.code === 200 && remoteTaskId) {
                    // 需要轮询远端
                    taskEntry.remoteTaskId = remoteTaskId;
                    await pollRemoteTask(taskEntry, remoteTaskId, key, taskBody, act, cost);
                } else {
                    taskEntry.status = 'error'; taskEntry.errorMsg = d.msg || d.error || JSON.stringify(d);
                }
            } else if (provider === 'doubao') {
                const ep = act === 'responses' ? 'https://ark.cn-beijing.volces.com/api/v3/responses' : 'https://ark.cn-beijing.volces.com/api/v3/images/generations';
                resp = await axios.post(ep, taskBody, { 
                    headers: { 'Authorization': `Bearer ${DOUBAO_KEY}`, 'Content-Type': 'application/json' },
                    timeout: 300000
                });
                const d = resp.data;
                if (act === 'generations' && d.data?.length > 0) {
                    taskEntry.status = 'success'; taskEntry.resultUrls = d.data.map(img => img.url);
                } else if (act === 'responses') {
                    // 诊断对话，直接返回文本
                    taskEntry.status = 'success'; taskEntry.responseData = d;
                } else {
                    taskEntry.status = 'error'; taskEntry.errorMsg = d.error?.message || d.error || JSON.stringify(d);
                }
            }
        } catch (err) {
            // 退还积分
            if (cost > 0) {
                await db.query('UPDATE users SET coins = coins + ? WHERE id = ?', [cost, req.user.id]).catch(() => {});
                await logCoin(req.user.id, 'refund', cost, `生成失败退还 · ${key}`, null);
            }
            let msg = err.message;
            if (err.response && err.response.data) msg = err.response.data.message || err.response.data.error?.message || err.response.data.error || JSON.stringify(err.response.data);
            taskEntry.status = 'error'; taskEntry.errorMsg = `接口拒绝: ${msg}`;
        }
        console.log(`[TASK ${localTaskId}]`, taskEntry.status, taskEntry.resultUrls?.length || 0, 'urls');
    })();
});

// 后端轮询远端（wuyin异步任务）— 干净的单循环 + 超时重试/退款
async function pollRemoteTask(taskEntry, remoteTaskId, modelKey, taskBody, act, cost) {
    const MAX_TRIES = 240;       // 240 * 3秒 = 12分钟
    const POLL_INTERVAL = 3000;
    const MAX_RETRIES_PRO = 2;
    let tries = 0;
    let retryCount = 0;
    
    return new Promise(async (resolve) => {
        while (tries < MAX_TRIES) {
            tries++;
            try {
                const r = await axios.get(
                    `https://api.wuyinkeji.com/api/async/detail?id=${encodeURIComponent(remoteTaskId)}&key=${WUYIN_KEY}`,
                    { timeout: 15000 }
                );
                const d = r.data;
                if (d.code === 200 && d.data) {
                    const data = d.data;
                    const resultArr = data.result || data.results || [];
                    const imgUrl = Array.isArray(resultArr) ? resultArr[0] : resultArr;
                    const fallback = data.image_url || data.output || data.url || data.img || data.file_url;
                    const finalUrl = (imgUrl && String(imgUrl).startsWith('http')) ? imgUrl
                        : (fallback && String(fallback).startsWith('http')) ? fallback : null;
                    const st = data.status;
                    const stStr = String(st || '').toLowerCase();
                    const errMsg = data.message || data.error || '';
                    
                    // 成功
                    if (finalUrl) {
                        taskEntry.status = 'success';
                        taskEntry.resultUrls = [finalUrl];
                        return resolve();
                    }
                    
                    // 失败
                    if (st === 3 || stStr === 'fail' || stStr === 'failed' || stStr === 'error') {
                        // 关键日志：把所有失败信息打印出来
                        console.log(`[REMOTE FAIL] model=${modelKey} status=${st} msg="${errMsg}"`);
                        
                        // NanoBanana Pro 任何失败都自动重试（最多2次）
                        if (modelKey === 'image_nanoBanana_pro' && retryCount < MAX_RETRIES_PRO) {
                            retryCount++;
                            console.log(`[PRO RETRY ${retryCount}] modelKey=${modelKey}`);
                            try {
                                const retryResp = await axios.post(
                                    `https://api.wuyinkeji.com/api/async/${act}`, taskBody,
                                    { headers: { 'Authorization': WUYIN_KEY, 'Content-Type': 'application/json' }, timeout: 30000 }
                                );
                                const rd = retryResp.data;
                                const newTaskId = rd.data?.task_id || rd.data?.id;
                                if (rd.code === 200 && newTaskId) {
                                    remoteTaskId = newTaskId;
                                    taskEntry.remoteTaskId = newTaskId;
                                    tries = 0;
                                    await new Promise(r => setTimeout(r, POLL_INTERVAL));
                                    continue;
                                }
                            } catch (re) { console.log('[PRO RETRY FAIL]', re.message); }
                        }
                        
                        // NanoBanana 2 任何失败都退款
                        if (modelKey === 'image_nanoBanana2') {
                            if (cost > 0) {
                                await db.query('UPDATE users SET coins = coins + ? WHERE id = ?', [cost, taskEntry.userId]).catch(() => {});
                                await logCoin(taskEntry.userId, 'refund', cost, `生成失败退还 · NanoBanana 2`, null);
                            }
                            taskEntry.status = 'error';
                            taskEntry.errorMsg = `生成失败，已自动退还 ${cost} 积分，请稍后重试`;
                            taskEntry.refunded = true;
                            console.log(`[NANO2 REFUND] userId=${taskEntry.userId} cost=${cost}`);
                            return resolve();
                        }

                        // NanoBanana Pro 重试耗尽后也退款
                        if (modelKey === 'image_nanoBanana_pro') {
                            if (cost > 0) {
                                await db.query('UPDATE users SET coins = coins + ? WHERE id = ?', [cost, taskEntry.userId]).catch(() => {});
                                await logCoin(taskEntry.userId, 'refund', cost, `生成失败退还 · NanoBanana Pro`, null);
                            }
                            taskEntry.status = 'error';
                            taskEntry.errorMsg = `生成失败，已自动退还 ${cost} 积分，请稍后重试`;
                            taskEntry.refunded = true;
                            console.log(`[PRO REFUND after retries] userId=${taskEntry.userId} cost=${cost}`);
                            return resolve();
                        }

                        // 其他模型：普通失败
                        taskEntry.status = 'error';
                        taskEntry.errorMsg = errMsg || '生成失败';
                        return resolve();
                    }
                    
                    // 状态码 2 但没URL：异常完成
                    if (st === 2 && !finalUrl) {
                        taskEntry.status = 'error';
                        taskEntry.errorMsg = '完成但未返回结果';
                        return resolve();
                    }
                }
                // 还在 pending/running，继续等
                await new Promise(r => setTimeout(r, POLL_INTERVAL));
            } catch (e) {
                console.log('[POLL ERR]', e.message);
                await new Promise(r => setTimeout(r, POLL_INTERVAL));
            }
        }
        // 超过最大轮询次数
        taskEntry.status = 'error';
        taskEntry.errorMsg = '后端轮询超时（12分钟未返回结果）';
        resolve();
    });
}

// 查询任务状态（前端轮询）
app.get('/api/task/status', secureAuth, async (req, res) => {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: '缺少任务ID' });
    const task = taskQueue.get(id);
    if (!task) return res.status(404).json({ error: '任务不存在或已过期' });
    if (task.userId !== req.user.id) return res.status(403).json({ error: '无权访问' });
    res.json({
        status: task.status, // pending | success | error
        resultUrls: task.resultUrls || [],
        errorMsg: task.errorMsg || null,
        responseData: task.responseData || null
    });
});

// 保留旧的代理接口（给诊断对话等非任务场景用）
app.post('/api/proxy/:provider/:action?', secureAuth, rateLimit(20, 60000), async (req, res) => {
    const { provider, action } = req.params;
    const act = action || '';
    const costTable2 = {
        'image_nanoBanana2':    { '1K': 20, '2K': 25, '4K': 30 },
        'image_nanoBanana_pro': { '1K': 50, '2K': 65, '4K': 80 },
        'image_gpt':            { '1K': 20, '2K': 25, '4K': 30 },
        'wan2.7-image':         { '1K': 30, '2K': 40, '4K': 50 },
        'wan2.7-image-pro':     { '1K': 60, '2K': 80, '4K': 100 },
        'doubao_seedream':      { '1K': 30, '2K': 40, '4K': 50 },
        'doubao':               { '1K': 30, '2K': 40, '4K': 50 },
        'responses':            { '1K': 10, '2K': 10, '4K': 10 },
    };

    let key;
    if (provider === 'wuyin') key = act;
    else if (provider === 'wanx') key = req.body?.model || 'wan2.7-image-pro';
    else key = provider;

    let cost;
    if (key === 'video_grok_imagine') {
        const dur = parseInt(req.body?.duration) || 10;
        const vidCostMap = { 6: 60, 10: 100, 15: 150, 20: 200, 30: 300 };
        cost = vidCostMap[dur] || Math.ceil(dur * 10);
    } else {
        const sizeKey2 = (req.body?.size || '1K').toUpperCase();
        const validSize2 = ['1K','2K','4K'].includes(sizeKey2) ? sizeKey2 : '1K';
        const modelCosts2 = costTable2[key];
        cost = modelCosts2 ? (modelCosts2[validSize2] || modelCosts2['1K']) : 10;
    }

    if (req.user.coins < cost) return res.status(402).json({ error: '余额不足，请充值' });
    if (cost > 0) {
        const [update] = await db.query('UPDATE users SET coins = coins - ? WHERE id = ? AND coins >= ?', [cost, req.user.id, cost]);
        if (update.affectedRows === 0) return res.status(402).json({ error: '扣费失败' });
        await logCoin(req.user.id, 'consume', cost, `生成图像 · ${key}`, null);
    }

    try {
        let resp;
        if (provider === 'wanx') {
            resp = await axios.post('https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation', req.body, { 
                headers: { 'Authorization': `Bearer ${WANX_KEY}`, 'Content-Type': 'application/json' } 
            });
        } else if (provider === 'wuyin') {
            resp = await axios.post(`https://api.wuyinkeji.com/api/async/${act}`, req.body, { 
                headers: { 'Authorization': WUYIN_KEY, 'Content-Type': 'application/json' } 
            });
            // 为视频任务打个补丁：如果是视频生成，我们把远端任务 id 存进全局内存，用来做归属权校验
            if (key === 'video_grok_imagine' && resp.data && resp.data.data && (resp.data.data.task_id || resp.data.data.id)) {
                const rTaskId = resp.data.data.task_id || resp.data.data.id;
                taskQueue.set('vid_' + rTaskId, {
                    userId: req.user.id,
                    remoteTaskId: rTaskId,
                    pollTaskId: rTaskId,
                    createdAt: Date.now(),
                    status: 'pending'
                });
            }
        } else if (provider === 'doubao') {
            const ep = act === 'responses' ? 'https://ark.cn-beijing.volces.com/api/v3/responses' : 'https://ark.cn-beijing.volces.com/api/v3/images/generations';
            resp = await axios.post(ep, req.body, { headers: { 'Authorization': `Bearer ${DOUBAO_KEY}`, 'Content-Type': 'application/json' } });
        }
        res.json(resp.data);
    } catch (err) {
        if (cost > 0) {
            await db.query('UPDATE users SET coins = coins + ? WHERE id = ?', [cost, req.user.id]);
            await logCoin(req.user.id, 'refund', cost, `接口异常退还 · ${key}`, null);
        }
        let msg = err.message;
        if (err.response && err.response.data) msg = err.response.data.message || err.response.data.error?.message || err.response.data.error || JSON.stringify(err.response.data);
        res.status(500).json({ error: `接口拒绝: ${msg}` });
    }
});

// 获取用户信息与智能名称
app.get('/api/user/info', secureAuth, async (req, res) => {
    // 禁用所有层级的缓存，确保每次都拿到最新余额
    res.set({
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        'Pragma': 'no-cache',
        'Expires': '0',
    });

    let displayName = 'Authorized User';
    if (req.user.email) displayName = req.user.email;
    else if (req.user.wechat_openid) displayName = '微信用户_' + req.user.wechat_openid.slice(-4);

    // 给老用户回填 public_uid（一次性补齐）
    let publicUid = req.user.public_uid;
    if (!publicUid) {
        try {
            publicUid = await genPublicUid();
            await db.query('UPDATE users SET public_uid = ? WHERE id = ?', [publicUid, req.user.id]);
        } catch(e) { publicUid = String(req.user.id).padStart(8, '0'); }
    }

    // 强制重新查询最新余额
    let latestCoins = req.user.coins;
    try {
        const [rows] = await db.query('SELECT coins FROM users WHERE id = ?', [req.user.id]);
        if (rows.length > 0) latestCoins = rows[0].coins;
    } catch(e) { /* 用 req.user.coins 兜底 */ }

    res.json({
        coins: latestCoins,
        id: publicUid,
        username: displayName,
        nickname: req.user.nickname || null,
        avatar_url: req.user.avatar_url || null,
        email: req.user.email || null
    });
});

// ================= 5.5 图像扩图（阿里云 image-out-painting）=================
const OUTPAINT_COST = 25;

// 提交扩图任务
// 【用户】修改个人资料：昵称 + 头像
app.post('/api/user/profile', secureAuth, rateLimit(20, 60000), async (req, res) => {
    const { nickname, avatar_url } = req.body || {};
    const updates = [];
    const params = [];

    if (typeof nickname === 'string') {
        const trimmed = nickname.trim().slice(0, 30);
        if (trimmed.length > 0) {
            updates.push('nickname = ?');
            params.push(trimmed);
        }
    }
    if (typeof avatar_url === 'string') {
        // 简单校验：必须是 http(s) 或 data URL
        if (avatar_url.startsWith('http://') || avatar_url.startsWith('https://') || avatar_url === '') {
            updates.push('avatar_url = ?');
            params.push(avatar_url || null);
        }
    }

    if (updates.length === 0) return res.status(400).json({ error: '没有要修改的字段' });

    params.push(req.user.id);
    try {
        await db.query(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);
        res.json({ success: true });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/outpaint/submit', secureAuth, rateLimit(10, 60000), async (req, res) => {
    const { image_url, output_ratio, x_scale, y_scale, left_offset, right_offset, top_offset, bottom_offset } = req.body;
    if (!image_url) return res.status(400).json({ error: '缺少图片URL' });
    
    if (req.user.coins < OUTPAINT_COST) return res.status(402).json({ error: '余额不足，请充值' });
    const [update] = await db.query('UPDATE users SET coins = coins - ? WHERE id = ? AND coins >= ?', [OUTPAINT_COST, req.user.id, OUTPAINT_COST]);
    if (update.affectedRows === 0) return res.status(402).json({ error: '扣费失败' });
    await logCoin(req.user.id, 'consume', OUTPAINT_COST, `智能扩图`, null);

    try {
        const params = { best_quality: false, limit_image_size: true, add_watermark: false };
        
        // 优先级：offset > scale > ratio
        const hasOffset = (left_offset > 0 || right_offset > 0 || top_offset > 0 || bottom_offset > 0);
        if (hasOffset) {
            if (left_offset > 0) params.left_offset = parseInt(left_offset);
            if (right_offset > 0) params.right_offset = parseInt(right_offset);
            if (top_offset > 0) params.top_offset = parseInt(top_offset);
            if (bottom_offset > 0) params.bottom_offset = parseInt(bottom_offset);
        } else if (x_scale > 1 || y_scale > 1) {
            if (x_scale > 1) params.x_scale = parseFloat(x_scale);
            if (y_scale > 1) params.y_scale = parseFloat(y_scale);
        } else if (output_ratio) {
            params.output_ratio = output_ratio;
        } else {
            params.x_scale = 2.0;
        }

        const resp = await axios.post(
            'https://dashscope.aliyuncs.com/api/v1/services/aigc/image2image/out-painting',
            { model: 'image-out-painting', input: { image_url }, parameters: params },
            { headers: { 'Authorization': `Bearer ${WANX_KEY}`, 'Content-Type': 'application/json', 'X-DashScope-Async': 'enable' }, timeout: 30000 }
        );
        console.log('[OUTPAINT SUBMIT]', JSON.stringify(params), '->', resp.data?.output?.task_id);
        const d = resp.data;
        const taskId = d.output?.task_id;
        if (taskId) {
            // 将扩图任务存入内存以供轮询鉴权
            taskQueue.set('op_' + taskId, {
                userId: req.user.id,
                pollTaskId: taskId,
                createdAt: Date.now(),
                status: 'pending'
            });
            res.json({ code: 200, taskId });
        } else {
            await db.query('UPDATE users SET coins = coins + ? WHERE id = ?', [OUTPAINT_COST, req.user.id]);
            await logCoin(req.user.id, 'refund', OUTPAINT_COST, `扩图失败退还`, null);
            res.status(500).json({ error: d.message || '提交扩图任务失败' });
        }
    } catch (err) {
        await db.query('UPDATE users SET coins = coins + ? WHERE id = ?', [OUTPAINT_COST, req.user.id]);
        await logCoin(req.user.id, 'refund', OUTPAINT_COST, `扩图失败退还`, null);
        const msg = err.response?.data?.message || err.message;
        res.status(500).json({ error: `扩图接口错误: ${msg}` });
    }
});

// 查询扩图任务状态
app.get('/api/outpaint/status', secureAuth, async (req, res) => {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: '缺少任务ID' });

    // 增加严格校验：验证任务归属
    let isOwner = false;
    for (const [key, t] of taskQueue) {
        if (t.remoteTaskId === id || t.pollTaskId === id) {
            if (t.userId === req.user.id) isOwner = true;
            break;
        }
    }
    if (!isOwner) {
        return res.status(403).json({ error: '无权访问或任务已过期' });
    }

    try {
        const resp = await axios.get(`https://dashscope.aliyuncs.com/api/v1/tasks/${id}`, {
            headers: { 'Authorization': `Bearer ${WANX_KEY}` }, timeout: 15000
        });
        const d = resp.data;
        const status = d.output?.task_status;
        if (status === 'SUCCEEDED') {
            res.json({ status: 'success', url: d.output.output_image_url });
        } else if (status === 'FAILED') {
            res.json({ status: 'error', errorMsg: d.output?.message || '扩图失败' });
        } else {
            res.json({ status: 'pending' });
        }
    } catch (err) {
        res.json({ status: 'pending' }); // 网络错误时继续轮询
    }
});

// ================= 6. OSS 图片转存 & 历史记录 =================
// 下载第三方图片并上传到 OSS，返回90天签名URL
async function saveToOSS(sourceUrl, userId, type = 'image') {
    try {
        const response = await axios.get(sourceUrl, { responseType: 'arraybuffer', timeout: 60000 });
        const buffer = Buffer.from(response.data);
        const isVideo = type === 'video';
        const ext = isVideo 
            ? (sourceUrl.match(/\.(mp4|webm|mov)/i)?.[1] || 'mp4')
            : (sourceUrl.match(/\.(png|jpg|jpeg|webp|gif)/i)?.[1] || 'jpg');
        const folder = isVideo ? 'videos' : 'images';
        const filename = `${folder}/${userId}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
        await ossClient.put(filename, buffer);
        const signedUrl = ossClient.signatureUrl(filename, { expires: 90 * 24 * 3600 }).replace('http://', 'https://');
        return { ossUrl: signedUrl, ossPath: filename };
    } catch (err) {
        console.log('[OSS SAVE ERROR]', err.message);
        return null;
    }
}

// 保存单条生成记录（转存到OSS + 写入数据库）
async function saveGeneration(userId, model, prompt, originalUrl, type = 'image', refUrlsJson = null, size = null, aspect = null) {
    try {
        const result = await saveToOSS(originalUrl, userId, type);
        const finalUrl = result ? result.ossUrl : originalUrl;
        const ossPath = result ? result.ossPath : null;
        await db.query(
            'INSERT INTO generations (user_id, model, prompt, image_url, original_url, oss_path, type, ref_urls, size, aspect_ratio) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [userId, model, prompt, finalUrl, originalUrl, ossPath, type, refUrlsJson, size, aspect]
        );
        console.log('[GEN SAVED]', userId, model, result ? 'OSS OK' : 'OSS FAIL using original');
        return finalUrl;
    } catch (err) {
        console.log('[GEN SAVE ERROR]', err.message);
        return originalUrl;
    }
}

// 前端生成成功后调用，批量转存图片到 OSS 并写入数据库
app.post('/api/generations/save', secureAuth, async (req, res) => {
    const { model, prompt, urls, type, ref_urls, size, aspect_ratio } = req.body;
    if (!urls || !urls.length) return res.status(400).json({ error: '无图片URL' });
    const savedUrls = [];
    
    // 异步转存参考图到 OSS（不阻塞主流程）
    let ossRefUrls = ref_urls || [];
    if (ref_urls && ref_urls.length) {
        const convertedRefs = [];
        for (const refUrl of ref_urls) {
            // 如果已经是 OSS 链接则跳过
            if (refUrl.includes('haotupro.oss-cn-shenzhen')) {
                convertedRefs.push(refUrl);
            } else {
                try {
                    const result = await saveToOSS(refUrl, req.user.id, 'image');
                    convertedRefs.push(result ? result.ossUrl : refUrl);
                } catch(e) { convertedRefs.push(refUrl); }
            }
        }
        ossRefUrls = convertedRefs;
    }
    const refUrlsJson = ossRefUrls.length ? JSON.stringify(ossRefUrls) : null;
    
    for (const url of urls) {
        const finalUrl = await saveGeneration(req.user.id, model, prompt, url, type || 'image', refUrlsJson, size || null, aspect_ratio || null);
        savedUrls.push(finalUrl);
    }
    res.json({ saved: savedUrls.length, urls: savedUrls });
});

// 查询历史记录（分页，支持 type 过滤）
app.get('/api/generations/list', secureAuth, async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    const type = req.query.type; // 'image' or 'video', optional
    const onlyFavorite = req.query.favorite === '1';
    const search = (req.query.search || '').trim();
    try {
        let whereClause = 'WHERE user_id = ?';
        let params = [req.user.id];
        if (type) {
            whereClause += ' AND type = ?';
            params.push(type);
        }
        if (onlyFavorite) {
            whereClause += ' AND is_favorite = 1';
        }
        if (search) {
            whereClause += ' AND prompt LIKE ?';
            params.push('%' + search + '%');
        }
        const [rows] = await db.query(
            `SELECT id, model, prompt, image_url, oss_path, type, ref_urls, size, aspect_ratio, is_favorite, created_at FROM generations ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );
        const [countResult] = await db.query(`SELECT COUNT(*) as total FROM generations ${whereClause}`, params);

        // 如果签名URL快过期（<7天），自动重新签名
        for (const row of rows) {
            if (row.oss_path) {
                try {
                    const urlObj = new URL(row.image_url);
                    const expires = parseInt(urlObj.searchParams.get('Expires') || '0');
                    const now = Math.floor(Date.now() / 1000);
                    if (expires > 0 && expires - now < 7 * 24 * 3600) {
                        row.image_url = ossClient.signatureUrl(row.oss_path, { expires: 90 * 24 * 3600 }).replace('http://', 'https://');
                        db.query('UPDATE generations SET image_url = ? WHERE id = ?', [row.image_url, row.id]).catch(() => {});
                    }
                } catch (e) {}
            }
        }

        res.json({ data: rows, total: countResult[0].total, page, limit });
    } catch (err) {
        console.log('[HISTORY ERROR]', err.message);
        res.status(500).json({ error: '查询历史失败' });
    }
});

// 切换收藏状态
app.post('/api/generations/:id/favorite', secureAuth, async (req, res) => {
    try {
        const [rows] = await db.query('SELECT is_favorite FROM generations WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
        if (rows.length === 0) return res.status(404).json({ error: '记录不存在' });
        const newFav = rows[0].is_favorite ? 0 : 1;
        await db.query('UPDATE generations SET is_favorite = ? WHERE id = ? AND user_id = ?', [newFav, req.params.id, req.user.id]);
        res.json({ success: true, is_favorite: newFav });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

// 删除单条记录
app.delete('/api/generations/:id', secureAuth, async (req, res) => {
    try {
        const [rows] = await db.query('SELECT oss_path FROM generations WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
        if (rows.length === 0) return res.status(404).json({ error: '记录不存在' });
        if (rows[0].oss_path) {
            try { await ossClient.delete(rows[0].oss_path); } catch (e) { console.log('[OSS DEL WARN]', e.message); }
        }
        await db.query('DELETE FROM generations WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: '删除失败' }); }
});

// 图片下载代理（解决 OSS 跨域无法直接 fetch 下载的问题）
app.get('/api/download', secureAuth, async (req, res) => {
    let { url } = req.query;
    if (!url) return res.status(400).send('missing url');
    // 旧记录可能是 http，后端服务器不受 Mixed Content 限制，直接请求即可
    try {
        const response = await axios.get(url, { responseType: 'stream', timeout: 30000 });
        const contentType = response.headers['content-type'] || 'image/jpeg';
        const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';
        res.set({
            'Content-Type': contentType,
            'Content-Disposition': `attachment; filename="haotu_${Date.now()}.${ext}"`,
            'Cache-Control': 'no-cache'
        });
        response.data.pipe(res);
    } catch (err) {
        res.status(500).json({ error: '下载失败' });
    }
});


// ================= 7. 兑换码 & 充值 & 流水 =================

// 生成随机兑换码（16位，避开敏感词）
function generateRedeemCode() {
    const chars = 'ABCDEFGHJKLMNPRSTUY23456789'; // 去掉 I O Q V W X Z 0 1，避免歧义和违规
    const forbidden = ['VX','WX','QQ','MM','TG','XJ','AV','FF'];
    while (true) {
        let code = '';
        for (let i = 0; i < 16; i++) code += chars[Math.floor(Math.random() * chars.length)];
        // 检查是否含敏感词
        let hasForbid = false;
        for (const w of forbidden) if (code.includes(w)) { hasForbid = true; break; }
        if (!hasForbid) return code;
    }
}

// 管理员鉴权
async function adminAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: '请先登录' });
    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const [rows] = await db.query('SELECT id, is_admin FROM users WHERE id = ?', [decoded.id]);
        if (rows.length === 0 || !rows[0].is_admin) return res.status(403).json({ error: '需要管理员权限' });
        req.user = rows[0]; next();
    } catch(err) { res.status(401).json({ error: '登录态失效' }); }
}

// ============ 【管理员 · 用户管理】 ============

// 用户列表 + 搜索 + 分页
app.get('/api/admin/users', adminAuth, async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = (page - 1) * limit;
    const search = (req.query.search || '').trim();
    const filter = req.query.filter || ''; // '' | banned | admin

    let where = 'WHERE 1=1';
    const params = [];
    if (search) {
        where += ' AND (email LIKE ? OR public_uid = ? OR nickname LIKE ?)';
        params.push('%' + search + '%', search, '%' + search + '%');
    }
    if (filter === 'banned') where += ' AND banned = 1';
    if (filter === 'admin') where += ' AND is_admin = 1';

    try {
        const [rows] = await db.query(
            `SELECT id, email, nickname, avatar_url, public_uid, coins, is_admin, banned, ban_reason, banned_at, last_login_at, last_login_ip, created_at FROM users ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );
        const [cnt] = await db.query(`SELECT COUNT(*) as total FROM users ${where}`, params);
        res.json({ data: rows, total: cnt[0].total, page, limit });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// 调整用户积分
app.post('/api/admin/users/:id/coins', adminAuth, async (req, res) => {
    const userId = parseInt(req.params.id);
    const { delta, reason } = req.body || {};
    const d = parseInt(delta);
    if (!userId || isNaN(d) || d === 0) return res.status(400).json({ error: '参数无效' });

    try {
        const [rows] = await db.query('SELECT id, coins, email FROM users WHERE id = ?', [userId]);
        if (rows.length === 0) return res.status(404).json({ error: '用户不存在' });
        const u = rows[0];
        const newCoins = Math.max(0, u.coins + d);

        await db.query('UPDATE users SET coins = ? WHERE id = ?', [newCoins, userId]);
        await logCoin(userId, d > 0 ? 'recharge' : 'consume', Math.abs(d), (d > 0 ? '管理员充值' : '管理员扣除') + (reason ? '：' + reason : ''), null);
        await logAdmin(req.user.id, 'adjust_coins', userId, { delta: d, reason, before: u.coins, after: newCoins });

        res.json({ success: true, coins: newCoins });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// 封禁用户
app.post('/api/admin/users/:id/ban', adminAuth, async (req, res) => {
    const userId = parseInt(req.params.id);
    const { reason } = req.body || {};
    if (!userId) return res.status(400).json({ error: '参数无效' });
    if (userId === req.user.id) return res.status(400).json({ error: '不能封禁自己' });

    try {
        const [rows] = await db.query('SELECT id, is_admin, email FROM users WHERE id = ?', [userId]);
        if (rows.length === 0) return res.status(404).json({ error: '用户不存在' });
        if (rows[0].is_admin) return res.status(400).json({ error: '不能封禁管理员' });

        // banned=1 + 提升 token_version 强制所有已登录设备掉线
        await db.query(
            'UPDATE users SET banned = 1, ban_reason = ?, banned_at = NOW(), token_version = IFNULL(token_version,1) + 1 WHERE id = ?',
            [String(reason || '违反使用条款').slice(0, 250), userId]
        );
        await logAdmin(req.user.id, 'ban_user', userId, { reason });

        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// 解封用户
app.post('/api/admin/users/:id/unban', adminAuth, async (req, res) => {
    const userId = parseInt(req.params.id);
    if (!userId) return res.status(400).json({ error: '参数无效' });
    try {
        const [rows] = await db.query('SELECT id FROM users WHERE id = ?', [userId]);
        if (rows.length === 0) return res.status(404).json({ error: '用户不存在' });
        await db.query('UPDATE users SET banned = 0, ban_reason = NULL, banned_at = NULL WHERE id = ?', [userId]);
        await logAdmin(req.user.id, 'unban_user', userId, {});
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// 查看用户登录历史
app.get('/api/admin/users/:id/logins', adminAuth, async (req, res) => {
    const userId = parseInt(req.params.id);
    if (!userId) return res.status(400).json({ error: '参数无效' });
    try {
        const [rows] = await db.query(
            'SELECT id, ip, user_agent, login_method, created_at FROM login_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 100',
            [userId]
        );
        res.json({ data: rows });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// ============ 【管理员 · IP 封禁】 ============

app.get('/api/admin/ip-bans', adminAuth, async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = (page - 1) * limit;
    const showAll = req.query.all === '1';
    const where = showAll ? '' : 'WHERE unbanned_at IS NULL';
    try {
        const [rows] = await db.query(
            `SELECT id, ip, reason, banned_by, banned_at, unbanned_at FROM ip_bans ${where} ORDER BY banned_at DESC LIMIT ? OFFSET ?`,
            [limit, offset]
        );
        const [cnt] = await db.query(`SELECT COUNT(*) as total FROM ip_bans ${where}`);
        res.json({ data: rows, total: cnt[0].total });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/ip-bans', adminAuth, async (req, res) => {
    const { ip, reason } = req.body || {};
    const cleanIp = String(ip || '').trim();
    if (!cleanIp) return res.status(400).json({ error: '请输入 IP' });

    try {
        // 检查是否已封禁
        const [existing] = await db.query('SELECT id FROM ip_bans WHERE ip = ? AND unbanned_at IS NULL', [cleanIp]);
        if (existing.length > 0) return res.status(400).json({ error: '该 IP 已被封禁' });

        await db.query(
            'INSERT INTO ip_bans (ip, reason, banned_by) VALUES (?, ?, ?)',
            [cleanIp, String(reason || '').slice(0, 250), req.user.id]
        );
        invalidateIpBanCache();
        await logAdmin(req.user.id, 'ban_ip', null, { ip: cleanIp, reason });
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/ip-bans/:id', adminAuth, async (req, res) => {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: '参数无效' });
    try {
        const [rows] = await db.query('SELECT ip FROM ip_bans WHERE id = ?', [id]);
        if (rows.length === 0) return res.status(404).json({ error: '记录不存在' });
        await db.query('UPDATE ip_bans SET unbanned_at = NOW() WHERE id = ?', [id]);
        invalidateIpBanCache();
        await logAdmin(req.user.id, 'unban_ip', null, { ip: rows[0].ip });
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// ============ 【管理员 · 操作日志】 ============

app.get('/api/admin/logs', adminAuth, async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = (page - 1) * limit;
    const action = req.query.action || '';

    let where = 'WHERE 1=1';
    const params = [];
    if (action) {
        where += ' AND action = ?';
        params.push(action);
    }
    try {
        const [rows] = await db.query(
            `SELECT al.id, al.action, al.detail, al.target_user_id, al.created_at,
                    admin.email AS admin_email, admin.public_uid AS admin_uid,
                    target.email AS target_email, target.public_uid AS target_uid
             FROM admin_logs al
             LEFT JOIN users admin ON admin.id = al.admin_id
             LEFT JOIN users target ON target.id = al.target_user_id
             ${where}
             ORDER BY al.created_at DESC
             LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );
        const [cnt] = await db.query(`SELECT COUNT(*) as total FROM admin_logs ${where}`, params);
        res.json({ data: rows, total: cnt[0].total });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// 【管理员】批量生成兑换码
app.post('/api/admin/codes/generate', adminAuth, async (req, res) => {
    const { coins, price, count } = req.body;
    if (!coins || coins <= 0) return res.status(400).json({ error: '积分数无效' });
    if (!count || count <= 0 || count > 10000) return res.status(400).json({ error: '数量无效（1-10000）' });

    const batchId = 'B' + Date.now() + Math.random().toString(36).slice(2, 6).toUpperCase();
    const expiresAt = new Date(Date.now() + 60 * 24 * 3600 * 1000); // 60天过期
    const codes = [];
    const BATCH_SIZE = 500; // 每次插入 500 条

    try {
        for (let batch = 0; batch < count; batch += BATCH_SIZE) {
            const n = Math.min(BATCH_SIZE, count - batch);
            const rows = [];
            for (let i = 0; i < n; i++) {
                const code = generateRedeemCode();
                rows.push([code, coins, price || null, batchId, expiresAt]);
                codes.push(code);
            }
            const placeholders = rows.map(() => '(?, ?, ?, ?, ?)').join(',');
            const flatValues = rows.flat();
            await db.query(
                `INSERT INTO redeem_codes (code, coins, price, batch_id, expires_at) VALUES ${placeholders}`,
                flatValues
            );
        }
        res.json({
            success: true, batchId, count: codes.length, coins, price,
            expiresAt: expiresAt.toISOString(), codes
        });
    } catch(e) {
        console.log('[GEN CODES ERR]', e.message);
        res.status(500).json({ error: '生成失败: ' + e.message });
    }
});

// 【管理员】查询所有批次
app.get('/api/admin/codes/batches', adminAuth, async (req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT batch_id, coins, price,
                   COUNT(*) AS total,
                   SUM(CASE WHEN used_by IS NOT NULL THEN 1 ELSE 0 END) AS used,
                   MIN(created_at) AS created_at,
                   MIN(expires_at) AS expires_at
            FROM redeem_codes
            WHERE batch_id IS NOT NULL
            GROUP BY batch_id, coins, price
            ORDER BY MIN(created_at) DESC
        `);
        res.json({ data: rows });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// 【管理员】导出某个批次未使用的兑换码
app.get('/api/admin/codes/export', adminAuth, async (req, res) => {
    const { batchId, unusedOnly } = req.query;
    if (!batchId) return res.status(400).json({ error: '缺少 batchId' });
    try {
        const where = unusedOnly === '1'
            ? 'WHERE batch_id = ? AND used_by IS NULL'
            : 'WHERE batch_id = ?';
        const [rows] = await db.query(`SELECT code, coins FROM redeem_codes ${where} ORDER BY id`, [batchId]);
        res.json({ data: rows });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// 【管理员】查询所有已使用的兑换码及使用人/时间
app.get('/api/admin/codes/used', adminAuth, async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = (page - 1) * limit;
    const keyword = (req.query.keyword || '').trim();
    try {
        let where = 'WHERE rc.used_by IS NOT NULL';
        const params = [];
        if (keyword) {
            where += ' AND (rc.code LIKE ? OR u.email LIKE ? OR u.public_uid LIKE ?)';
            const kw = '%' + keyword + '%';
            params.push(kw, kw, kw);
        }
        const [rows] = await db.query(
            `SELECT rc.code, rc.coins, rc.batch_id, rc.used_at,
                    u.email, u.public_uid, u.wechat_openid
             FROM redeem_codes rc
             LEFT JOIN users u ON rc.used_by = u.id
             ${where}
             ORDER BY rc.used_at DESC
             LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );
        const [cnt] = await db.query(
            `SELECT COUNT(*) AS total FROM redeem_codes rc LEFT JOIN users u ON rc.used_by = u.id ${where}`,
            params
        );
        res.json({ data: rows, total: cnt[0].total, page, limit });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

// 【用户】兑换码使用
app.post('/api/redeem', secureAuth, rateLimit(10, 60000), async (req, res) => {
    const rawCode = String(req.body?.code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!rawCode || rawCode.length < 8) return res.status(400).json({ error: '请输入有效的兑换码' });

    const conn = await db.getConnection();
    try {
        await conn.beginTransaction();
        // 查码 + 锁行
        const [rows] = await conn.query(
            'SELECT id, code, coins, used_by, expires_at FROM redeem_codes WHERE code = ? FOR UPDATE',
            [rawCode]
        );
        if (rows.length === 0) { await conn.rollback(); return res.status(400).json({ error: '兑换码不存在' }); }
        const c = rows[0];
        if (c.used_by) { await conn.rollback(); return res.status(400).json({ error: '此兑换码已使用' }); }
        if (new Date(c.expires_at) < new Date()) { await conn.rollback(); return res.status(400).json({ error: '兑换码已过期' }); }

        // 标记已用 + 加积分
        await conn.query('UPDATE redeem_codes SET used_by = ?, used_at = NOW() WHERE id = ?', [req.user.id, c.id]);
        await conn.query('UPDATE users SET coins = coins + ? WHERE id = ?', [c.coins, req.user.id]);
        // 在同一事务中读取最新余额，确保数据一致
        const [balanceRows] = await conn.query('SELECT coins FROM users WHERE id = ?', [req.user.id]);
        const newBalance = balanceRows[0]?.coins ?? null;
        await conn.commit();

        // 流水（在事务外，不影响兑换）
        await logCoin(req.user.id, 'recharge', c.coins, `兑换码充值`, rawCode);
        res.json({ success: true, coins: c.coins, balance: newBalance, message: `成功兑换 ${c.coins} 积分` });
    } catch(e) {
        await conn.rollback();
        console.log('[REDEEM ERR]', e.message);
        res.status(500).json({ error: '兑换失败: ' + e.message });
    } finally {
        conn.release();
    }
});

// 【用户】我的积分流水（充值 / 消费 / 退款）
app.get('/api/coin/logs', secureAuth, async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 30, 100);
    const offset = (page - 1) * limit;
    const type = req.query.type; // 可选过滤
    try {
        let where = 'WHERE user_id = ?';
        const params = [req.user.id];
        if (type && ['recharge','consume','refund'].includes(type)) {
            where += ' AND type = ?';
            params.push(type);
        }
        const [rows] = await db.query(
            `SELECT id, type, amount, balance_after, description, related_id, created_at
             FROM coin_logs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );
        const [cnt] = await db.query(`SELECT COUNT(*) AS total FROM coin_logs ${where}`, params);
        res.json({ data: rows, total: cnt[0].total, page, limit });
    } catch(e) { res.status(500).json({ error: e.message }); }
});


app.listen(3000, () => console.log('Backend Ready at 3000'));