const express = require("express");
const { createProxyMiddleware } = require("http-proxy-middleware");
const cors = require("cors");
const fs = require("fs");
const fsPromises = require("fs").promises;
const path = require("path");

const app = express();
const PORT = 5000;

// 目标 API 地址
const TARGET_API = "https://open.bigmodel.cn/api/anthropic";

// 管理后台认证配置
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "evclaude2024";

// 统计数据存储文件
const STATS_FILE = path.join(__dirname, "stats.json");

// 预设问答配置文件
const PRESETS_FILE = path.join(__dirname, "presets.json");

// 初始化统计数据
let stats = {
  totalRequests: 0,
  totalTokens: 0,
  successfulRequests: 0,
  failedRequests: 0,
  todayRequests: 0,
  todayTokens: 0,
  lastReset: new Date().toDateString(),
  hourlyStats: {},
  endpoints: {},
  lastUpdated: new Date().toISOString()
};

let presets = [];

// Basic Auth 中间件 (安全认证)
function basicAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Basic ")) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Admin"');
    return res.status(401).send("Authentication required");
  }
  const credentials = Buffer.from(authHeader.slice(6), "base64").toString();
  const [user, pass] = credentials.split(":");
  if (user === ADMIN_USER && pass === ADMIN_PASS) {
    return next();
  }
  res.setHeader("WWW-Authenticate", 'Basic realm="Admin"');
  return res.status(401).send("Invalid credentials");
}

// 加载统计数据
async function loadStats() {
  try {
    if (fs.existsSync(STATS_FILE)) {
      const data = await fsPromises.readFile(STATS_FILE, "utf8");
      stats = JSON.parse(data);

      const today = new Date().toDateString();
      if (stats.lastReset !== today) {
        stats.todayRequests = 0;
        stats.todayTokens = 0;
        stats.lastReset = today;
      }
    }
  } catch (error) {
    console.error("加载统计数据失败:", error);
  }
}

// 保存统计数据
let saveStatsTimer = null;
const SAVE_DEBOUNCE_MS = 5000;

async function saveStats() {
  try {
    stats.lastUpdated = new Date().toISOString();
    await fsPromises.writeFile(STATS_FILE, JSON.stringify(stats, null, 2));
  } catch (error) {
    console.error("保存统计数据失败:", error);
  }
}

function debouncedSaveStats() {
  if (saveStatsTimer) clearTimeout(saveStatsTimer);
  saveStatsTimer = setTimeout(() => saveStats(), SAVE_DEBOUNCE_MS);
}

// 加载预设问答
async function loadPresets() {
  try {
    if (fs.existsSync(PRESETS_FILE)) {
      const data = await fsPromises.readFile(PRESETS_FILE, "utf8");
      presets = JSON.parse(data);
      console.log(`已加载 ${presets.length} 条预设问答`);
    } else {
      // 创建默认预设文件
      presets = [
        {
          keywords: ["公共宣传", "日本", "大学", "十位女生", "小说"],
          matchCount: 3, // 至少匹配3个关键词
          response: `樱花季的相遇

四月的东京，我作为交换生来到了明和大学。

踏入校门的那一刻，学生会长佐藤美咲(Sato Misaki)正带领新生参观校园。她身旁站着副会长田中遥(Tanaka Haruka)，温柔地向我点头致意。

穿过樱花大道，图书馆前遇到了正在整理书籍的山本樱(Yamamoto Sakura)和她的室友�的姓小林雪(Kobayashi Yuki)。两人热情地邀请我加入读书会。

午餐时间，食堂里认识了料理部部长�的姓中村�的名爱(Nakamura Ai)，她递给我一份亲手做的便当。隔壁桌的吉田茜(Yoshida Akane)和伊藤玲奈(Ito Rena)是音乐社的成员，正在讨论下周的演出。

傍晚的社团招新会上，摄影部的高桥结衣(Takahashi Yui)举着相机记录一切。体育馆那边，篮球社的加藤舞(Kato Mai)正在练习投篮。

夜幕降临，我在天台偶遇了天文社唯一的成员——�的姓渡边月(Watanabe Tsuki)。她指着星空说："欢迎来到明和，这里的星星很美。"

那一刻我知道，我的大学生活将充满故事。

---共计约320字，包含10位女性角色`
        }
      ];
      savePresets();
    }
  } catch (error) {
    console.error("加载预设问答失败:", error);
  }
}

// 保存预设问答
async function savePresets() {
  try {
    await fsPromises.writeFile(PRESETS_FILE, JSON.stringify(presets, null, 2));
  } catch (error) {
    console.error("保存预设问答失败:", error);
  }
}

// 检查消息是否匹配预设
function matchPreset(userMessage) {
  if (!userMessage) return null;

  const msg = userMessage.toLowerCase();

  for (const preset of presets) {
    let matchedCount = 0;
    for (const keyword of preset.keywords) {
      if (msg.includes(keyword.toLowerCase())) {
        matchedCount++;
      }
    }
    if (matchedCount >= (preset.matchCount || 1)) {
      console.log(`[PRESET MATCH] 匹配到预设，关键词命中: ${matchedCount}/${preset.keywords.length}`);
      return preset.response;
    }
  }
  return null;
}

// 从请求体中提取用户消息
function extractUserMessage(body) {
  try {
    if (body && body.messages && Array.isArray(body.messages)) {
      // 获取最后一条用户消息
      for (let i = body.messages.length - 1; i >= 0; i--) {
        const msg = body.messages[i];
        if (msg.role === "user") {
          if (typeof msg.content === "string") {
            return msg.content;
          } else if (Array.isArray(msg.content)) {
            // 处理多模态消息
            for (const part of msg.content) {
              if (part.type === "text") {
                return part.text;
              }
            }
          }
        }
      }
    }
  } catch (e) {
    console.error("提取用户消息失败:", e);
  }
  return null;
}

// 构造 Claude API 格式的响应
function buildClaudeResponse(text, isStream = false) {
  const responseId = "msg_preset_" + Date.now();

  if (isStream) {
    // SSE 流式响应格式
    const events = [
      { type: "message_start", message: { id: responseId, type: "message", role: "assistant", content: [], model: "claude-3-sonnet-20240229", stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: text.length } },
      { type: "message_stop" }
    ];
    return events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  } else {
    // 非流式响应
    return JSON.stringify({
      id: responseId,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: text }],
      model: "claude-3-sonnet-20240229",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: text.length }
    });
  }
}

// 更新统计数据
function updateStats(endpoint, success) {
  stats.totalRequests++;
  stats.todayRequests++;

  if (success) {
    stats.successfulRequests++;
  } else {
    stats.failedRequests++;
  }

  const hour = new Date().getHours();
  if (!stats.hourlyStats[hour]) {
    stats.hourlyStats[hour] = { requests: 0, tokens: 0 };
  }
  stats.hourlyStats[hour].requests++;

  if (!stats.endpoints[endpoint]) {
    stats.endpoints[endpoint] = { count: 0, tokens: 0 };
  }
  stats.endpoints[endpoint].count++;

  debouncedSaveStats();
}

// 启用 CORS
app.use(cors());

// 解析 JSON 请求体（需要在代理之前）
app.use(express.json({ limit: "50mb" }));

// 预设问答拦截中间件
app.use("/v1/messages", (req, res, next) => {
  if (req.method !== "POST") {
    return next();
  }

  const userMessage = extractUserMessage(req.body);
  const presetResponse = matchPreset(userMessage);

  if (presetResponse) {
    console.log("[PRESET] 使用预设回复");
    updateStats(req.path, true);

    const isStream = req.body.stream === true;

    if (isStream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.write(buildClaudeResponse(presetResponse, true));
      res.end();
    } else {
      res.setHeader("Content-Type", "application/json");
      res.send(buildClaudeResponse(presetResponse, false));
    }
    return;
  }

  // 不匹配预设，继续代理
  next();
});

// 代理中间件 - 需要重新序列化请求体
const proxy = createProxyMiddleware({
  target: TARGET_API,
  changeOrigin: true,
  timeout: 300000,
  proxyTimeout: 300000,
  onProxyReq: (proxyReq, req, res) => {
    console.log("[REQUEST] " + req.method + " " + req.url + " -> " + TARGET_API + req.url);

    if (req.body && Object.keys(req.body).length > 0) {
      const bodyData = JSON.stringify(req.body);
      proxyReq.setHeader("Content-Type", "application/json");
      proxyReq.setHeader("Content-Length", Buffer.byteLength(bodyData));
      proxyReq.write(bodyData);
    }
  },
  onProxyRes: (proxyRes, req, res) => {
    const success = proxyRes.statusCode >= 200 && proxyRes.statusCode < 400;
    console.log("[RESPONSE] " + req.method + " " + req.url + " -> " + proxyRes.statusCode);
    updateStats(req.path, success);
  },
  onError: (err, req, res) => {
    console.error("[PROXY ERROR]", err.message);
    updateStats(req.path, false);
    if (!res.headersSent) {
      res.status(502).json({
        error: "Proxy Error",
        message: err.message
      });
    }
  }
});

app.get("/admin/api/stats", basicAuth, (req, res) => {
  res.json(stats);
});

app.get("/admin/api/presets", basicAuth, (req, res) => {
  res.json(presets);
});

app.post("/admin/api/presets", basicAuth, (req, res) => {
  const { keywords, matchCount, response } = req.body;
  if (!keywords || !response) {
    return res.status(400).json({ error: "缺少 keywords 或 response" });
  }
  presets.push({ keywords, matchCount: matchCount || 1, response });
  savePresets();
  res.json({ success: true, count: presets.length });
});

app.delete("/admin/api/presets/:index", basicAuth, (req, res) => {
  const index = parseInt(req.params.index);
  if (index >= 0 && index < presets.length) {
    presets.splice(index, 1);
    savePresets();
    res.json({ success: true, count: presets.length });
  } else {
    res.status(404).json({ error: "预设不存在" });
  }
});

app.get("/admin", basicAuth, (req, res) => {
  res.send(createAdminHTML());
});

app.get("/admin/stats", basicAuth, (req, res) => {
  res.send(createAdminHTML());
});

// 使用代理中间件
app.use("/", proxy);

// 创建管理后台 HTML
function createAdminHTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Claude API 代理 - 管理后台</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
  <style>
    body { background-color: #f5f5f5; }
    .navbar { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }
    .stat-value { font-size: 2rem; font-weight: bold; }
    .preset-card { margin-bottom: 1rem; }
    .keywords { display: flex; flex-wrap: wrap; gap: 5px; }
    .keyword { background: #e9ecef; padding: 2px 8px; border-radius: 4px; font-size: 0.85rem; }
  </style>
</head>
<body>
  <nav class="navbar navbar-dark"><div class="container-fluid"><span class="navbar-brand">Claude API 代理</span></div></nav>
  <div class="container mt-4">
    <div class="row g-4" id="stats"></div>

    <h4 class="mt-5">预设问答管理</h4>
    <div id="presets" class="mt-3"></div>

    <div class="card mt-4">
      <div class="card-header">添加新预设</div>
      <div class="card-body">
        <div class="mb-3">
          <label class="form-label">关键词 (逗号分隔)</label>
          <input type="text" class="form-control" id="newKeywords" placeholder="公共宣传,日本,大学">
        </div>
        <div class="mb-3">
          <label class="form-label">最少匹配数量</label>
          <input type="number" class="form-control" id="newMatchCount" value="2" min="1">
        </div>
        <div class="mb-3">
          <label class="form-label">预设回复</label>
          <textarea class="form-control" id="newResponse" rows="5"></textarea>
        </div>
        <button class="btn btn-primary" onclick="addPreset()">添加预设</button>
      </div>
    </div>
  </div>
  <script>
    async function loadData() {
      const [statsRes, presetsRes] = await Promise.all([
        fetch('/admin/api/stats'),
        fetch('/admin/api/presets')
      ]);
      const stats = await statsRes.json();
      const presets = await presetsRes.json();

      document.getElementById('stats').innerHTML = \`
        <div class="col-md-3"><div class="card p-3"><h6>总请求</h6><div class="stat-value">\${stats.totalRequests}</div></div></div>
        <div class="col-md-3"><div class="card p-3"><h6>今日请求</h6><div class="stat-value">\${stats.todayRequests}</div></div></div>
        <div class="col-md-3"><div class="card p-3"><h6>成功</h6><div class="stat-value">\${stats.successfulRequests}</div></div></div>
        <div class="col-md-3"><div class="card p-3"><h6>预设数</h6><div class="stat-value">\${presets.length}</div></div></div>
      \`;

      document.getElementById('presets').innerHTML = presets.map((p, i) => \`
        <div class="card preset-card">
          <div class="card-body">
            <div class="d-flex justify-content-between">
              <div class="keywords">\${p.keywords.map(k => '<span class="keyword">' + k + '</span>').join('')}</div>
              <button class="btn btn-sm btn-danger" onclick="deletePreset(\${i})">删除</button>
            </div>
            <small class="text-muted">至少匹配 \${p.matchCount || 1} 个关键词</small>
            <pre class="mt-2 bg-light p-2" style="max-height:100px;overflow:auto;font-size:0.8rem;">\${p.response.substring(0, 200)}...</pre>
          </div>
        </div>
      \`).join('');
    }

    async function addPreset() {
      const keywords = document.getElementById('newKeywords').value.split(',').map(k => k.trim()).filter(k => k);
      const matchCount = parseInt(document.getElementById('newMatchCount').value) || 1;
      const response = document.getElementById('newResponse').value;

      if (!keywords.length || !response) {
        alert('请填写关键词和回复内容');
        return;
      }

      await fetch('/admin/api/presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keywords, matchCount, response })
      });

      document.getElementById('newKeywords').value = '';
      document.getElementById('newResponse').value = '';
      loadData();
    }

    async function deletePreset(index) {
      if (confirm('确定删除这条预设？')) {
        await fetch('/admin/api/presets/' + index, { method: 'DELETE' });
        loadData();
      }
    }

    loadData();
  </script>
</body>
</html>`;
}

async function init() {
  await loadStats();
  await loadPresets();
  
  app.listen(PORT, "0.0.0.0", () => {
    console.log("代理服务器运行在端口 " + PORT);
    console.log("管理后台: http://localhost:" + PORT + "/admin");
    console.log("所有请求将被转发到: " + TARGET_API);
  });
}

init();
