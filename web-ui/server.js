import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { spawn, execFile } from 'child_process';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PORT = process.env.PORT || 3003;
const PI_RESOURCES = process.env.PI_RESOURCES || '';
const PI_PACKAGED = process.env.PI_PACKAGED === '1';
function findPiPath() {
  const candidates = [];
  if (PI_PACKAGED && PI_RESOURCES) candidates.push(join(PI_RESOURCES, 'pi.exe'));
  candidates.push(join(__dirname, 'pi.exe'));
  candidates.push(join(dirname(__dirname), 'pi.exe'));
  for (const p of candidates) { if (existsSync(p)) return p; }
  return candidates[0];
}
const PI_PATH = findPiPath();
function findSessionDir() {
  if (PI_PACKAGED) {
    // 打包后 session 存在用户数据目录，保证重启/重装不丢失
    const d = join(USER_DATA_DIR, '.sessions');
    try { mkdirSync(d, { recursive: true }); } catch (_) {}
    return d;
  }
  const d = join(dirname(__dirname), '.sessions');
  try { mkdirSync(d, { recursive: true }); } catch (_) {}
  return d;
}
function findUserDataDir() {
  if (PI_PACKAGED) {
    // 打包后使用用户数据目录，避免写入临时目录
    const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
    const d = join(appData, 'PI-Agent');
    try { mkdirSync(d, { recursive: true }); } catch (_) {}
    return d;
  }
  return __dirname;
}

const USER_DATA_DIR = findUserDataDir();
const SESSION_DIR = findSessionDir();
const CONFIG_FILE = join(USER_DATA_DIR, '.pi-config.json');
const SESSIONS_FILE = join(USER_DATA_DIR, 'sessions.json');
const SESSION_FILE_MAP_FILE = join(USER_DATA_DIR, '.session-file-map.json');

if (!existsSync(SESSION_DIR)) mkdirSync(SESSION_DIR, { recursive: true });

const app = express();
app.get('/api/find-dir', (req, res) => {
  const name = req.query.name;
  if (!name) return res.json({ error: 'No name' });
  const script = join(__dirname, 'find-dir.ps1');
  execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, name], { timeout: 15000 }, (err, stdout) => {
    const found = (stdout || '').trim();
    if (found && existsSync(found)) {
      res.json({ path: found });
    } else {
      res.json({ error: 'Not found' });
    }
  });
});

app.use(express.static(join(__dirname, 'public'), {
  setHeaders: (res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
  }
}));
app.use('/exports', express.static(SESSION_DIR));
const server = createServer(app);
const wss = new WebSocketServer({ server });

let piProcess = null, piBuffer = '', clients = new Set();
const WORKSPACE_FILE = join(USER_DATA_DIR, '.workspace.json');
let workspaceDir = loadWorkspace();

function loadWorkspace() {
  try {
    if (existsSync(WORKSPACE_FILE)) {
      const raw = readFileSync(WORKSPACE_FILE, 'utf8');
      const data = JSON.parse(raw);
      if (data.path && existsSync(data.path)) return data.path;
    }
  } catch (_) {}
  return process.cwd();
}

function saveWorkspace(path) {
  try { writeFileSync(WORKSPACE_FILE, JSON.stringify({ path })); } catch (_) {}
}

let currentSessionId = null;
let currentSessionFile = null;
let sessionsCache = [];

// sessionId -> { file, title, preview, mtime, messageCount }
let sessionFileMap = {};

function loadSessionFileMap() {
  try {
    if (existsSync(SESSION_FILE_MAP_FILE)) {
      const raw = readFileSync(SESSION_FILE_MAP_FILE, 'utf8');
      sessionFileMap = JSON.parse(raw);
    }
  } catch (e) { sessionFileMap = {}; }
}

function saveSessionFileMap() {
  try { writeFileSync(SESSION_FILE_MAP_FILE, JSON.stringify(sessionFileMap)); } catch (e) {}
}

function broadcastSessions() {
  sessionsCache.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  broadcast({ type: 'sessions_updated', threads: sessionsCache.slice(0, 50) });
}

function loadSessionsFromDisk() {
  loadSessionFileMap();
  try {
    const files = readdirSync(SESSION_DIR);
    const loaded = [];
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const filePath = join(SESSION_DIR, f);
      try {
        const stat = statSync(filePath);
        const fileMtime = stat.mtimeMs;
        const content = readFileSync(filePath, 'utf8');
        const lines = content.trim().split('\n');
        if (lines.length === 0) continue;

        // Parse header to get session ID
        let sid = null;
        try {
          const header = JSON.parse(lines[0]);
          if (header.type === 'session' && header.id) {
            sid = header.id;
          }
        } catch (_) {}

        if (!sid) {
          // Fallback: extract from filename
          const lastUnderscore = f.lastIndexOf('_');
          if (lastUnderscore >= 0) sid = f.slice(lastUnderscore + 1, -6);
        }

        if (!sid) continue;

        // Extract title and preview from first user message
        let title = '', preview = '';
        let messageCount = 0;
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            if (entry.type === 'message' && entry.message) {
              messageCount++;
              if (!title && entry.message.role === 'user' && entry.message.content) {
                const firstContent = Array.isArray(entry.message.content)
                  ? entry.message.content[0]
                  : entry.message.content;
                if (firstContent && firstContent.text) {
                  preview = firstContent.text.substring(0, 80);
                  title = firstContent.text.substring(0, 60);
                }
              }
            }
          } catch (_) {}
        }

        // Use cached name if available
        if (sessionFileMap[sid] && sessionFileMap[sid].title && !title) {
          title = sessionFileMap[sid].title;
        }
        if (!title) {
          const ts = stat.mtime;
          title = ts.toLocaleString();
          preview = title;
        }

        const mtime = fileMtime || Date.now();
        loaded.push({ id: sid, title, preview, mtime, messageCount, file: f });

        // Update session file map
        sessionFileMap[sid] = {
          file: f,
          title: sessionFileMap[sid]?.title || title,
          preview,
          mtime,
          messageCount
        };
      } catch (_) {}
    }
    loaded.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
    sessionsCache = loaded;
    saveSessionFileMap();
    try { writeFileSync(SESSIONS_FILE, JSON.stringify(loaded)); } catch (_) {}
  } catch (e) {
    console.error('loadSessionsFromDisk error:', e.message);
    try {
      if (existsSync(SESSIONS_FILE)) {
        let raw = readFileSync(SESSIONS_FILE, 'utf8');
        if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
        const parsed = JSON.parse(raw);
        sessionsCache = Array.isArray(parsed) ? parsed : [parsed];
      }
    } catch (_) {}
  }
}

function findSessionFileById(sessionId) {
  // Check file map first
  if (sessionFileMap[sessionId] && sessionFileMap[sessionId].file) {
    const path = join(SESSION_DIR, sessionFileMap[sessionId].file);
    if (existsSync(path)) return path;
  }
  // Scan for matching file
  try {
    const files = readdirSync(SESSION_DIR);
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      if (f.includes('_' + sessionId + '.jsonl')) {
        return join(SESSION_DIR, f);
      }
    }
  } catch (_) {}
  return null;
}

function refreshSessionsFromDisk() {
  loadSessionsFromDisk();
  broadcastSessions();
}

function updateSessionEntry(msg, sessionName) {
  const id = currentSessionId;
  if (!id) return;
  const exIdx = sessionsCache.findIndex(s => s.id === id);
  const now = Date.now();
  if (exIdx >= 0) {
    if (sessionName) {
      sessionsCache[exIdx].title = sessionName;
      if (sessionFileMap[id]) sessionFileMap[id].title = sessionName;
    } else if (!sessionsCache[exIdx].title || sessionsCache[exIdx].title === sessionsCache[exIdx].preview) {
      sessionsCache[exIdx].title = (msg || '').substring(0, 60);
    }
    sessionsCache[exIdx].preview = (msg || '').substring(0, 80);
    sessionsCache[exIdx].mtime = now;
    sessionsCache[exIdx].messageCount = (sessionsCache[exIdx].messageCount || 0) + 1;
    const entry = sessionsCache.splice(exIdx, 1)[0];
    sessionsCache.unshift(entry);
  } else {
    sessionsCache.unshift({
      id,
      title: sessionName || (msg || '').substring(0, 60),
      preview: (msg || '').substring(0, 80),
      mtime: now,
      messageCount: 1
    });
  }
  saveSessionFileMap();
  broadcastSessions();
}

let piConfig = {
  provider: null, modelId: null, apiKey: null, baseUrl: null,
  systemPrompt: null, enabledTools: null, excludedTools: null,
  // 高级设置
  thinkingBudgets: null,
  compactionReserveTokens: null,
  compactionKeepRecentTokens: null,
  retryMaxRetries: null
};

try { if (existsSync(CONFIG_FILE)) { const c = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')); Object.assign(piConfig, c); } } catch (e) {}

const PROVIDER_ENV = {
  anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY',
  google: 'GEMINI_API_KEY', deepseek: 'DEEPSEEK_API_KEY',
  groq: 'GROQ_API_KEY', cerebras: 'CEREBRAS_API_KEY',
  xai: 'XAI_API_KEY', fireworks: 'FIREWORKS_API_KEY',
  together: 'TOGETHER_API_KEY', openrouter: 'OPENROUTER_API_KEY',
  mistral: 'MISTRAL_API_KEY', github: 'GITHUB_COPILOT_API_KEY',
  azure: 'AZURE_OPENAI_API_KEY',
};

function piWrite(data) {
  if (!piProcess) return;
  try { piProcess.stdin.write(JSON.stringify(data) + '\n'); } catch(e) { console.error('piWrite error:', e.message); }
}

function broadcast(event) {
  const msg = JSON.stringify(event);
  for (const ws of clients) { try { ws.send(msg); } catch (e) {} }
}

function writePiSettings() {
  if (!workspaceDir) return;
  // 只写非空的高级设置
  const settings = {};
  const cfg = piConfig;
  if (cfg.thinkingBudgets && Object.keys(cfg.thinkingBudgets).length) settings.thinkingBudgets = cfg.thinkingBudgets;
  if (cfg.compactionReserveTokens) {
    settings.compaction = settings.compaction || {};
    settings.compaction.reserveTokens = parseInt(cfg.compactionReserveTokens, 10);
  }
  if (cfg.compactionKeepRecentTokens) {
    settings.compaction = settings.compaction || {};
    settings.compaction.keepRecentTokens = parseInt(cfg.compactionKeepRecentTokens, 10);
  }
  if (cfg.retryMaxRetries) {
    settings.retry = settings.retry || {};
    settings.retry.maxRetries = parseInt(cfg.retryMaxRetries, 10);
  }
  settings.hideThinkingBlock = cfg.hideThinkingBlock || false;

  if (Object.keys(settings).length === 1 && settings.hideThinkingBlock === false) {
    // 没有任何有意义的高级设置，删除旧的 .pi/settings.json
    const path = join(workspaceDir, '.pi', 'settings.json');
    try { unlinkSync(path); } catch (_) {}
    return;
  }
  const piDir = join(workspaceDir, '.pi');
  try { mkdirSync(piDir, { recursive: true }); } catch (_) {}
  const path = join(piDir, 'settings.json');
  try { writeFileSync(path, JSON.stringify(settings, null, 2)); } catch (e) { console.error('writePiSettings error:', e.message); }
}

function startPi(config, sessionPath, forkPath) {
  config = config || piConfig;
  if (piProcess) { piProcess.removeAllListeners('close'); piProcess.kill(); piProcess = null; }
  currentSessionFile = null;

  const args = ['--mode', 'rpc', '--session-dir', SESSION_DIR];
  if (sessionPath) {
    args.push('--session', sessionPath);
    currentSessionFile = sessionPath;
  }
  if (forkPath) {
    args.push('--fork', forkPath);
  }

  // 全局 skill 目录（项目根目录下，不占 C 盘空间）
  const globalSkillDir = join(dirname(__dirname), 'skills');
  if (existsSync(globalSkillDir)) {
    args.push('--skill', globalSkillDir);
  }
  // 项目级 skill 目录（当前工作区下的 skills/）
  const projectSkillDir = join(workspaceDir, 'skills');
  if (existsSync(projectSkillDir)) {
    args.push('--skill', projectSkillDir);
  }

  if (config.modelId) {
    args.push('--model', (config.provider || 'openai') + '/' + config.modelId);
  }
  if (config.systemPrompt) {
    args.push('--system-prompt', config.systemPrompt);
  }
  if (config.enabledTools) {
    args.push('--tools', config.enabledTools);
  }
  if (config.excludedTools) {
    args.push('--exclude-tools', config.excludedTools);
  }

  console.log('Starting PI:', PI_PATH, args.join(' '));

  // 写入工作区级 PI 设置文件
  writePiSettings();

  const env = { ...process.env };
  if (config.apiKey && config.provider && PROVIDER_ENV[config.provider]) {
    env[PROVIDER_ENV[config.provider]] = config.apiKey;
  }
  if (config.baseUrl) {
    if (config.provider === 'openai') env['OPENAI_BASE_URL'] = config.baseUrl;
    if (config.provider === 'anthropic') env['ANTHROPIC_BASE_URL'] = config.baseUrl;
  }

  broadcast({ type: '_pi_restarting' });
  piProcess = spawn(PI_PATH, args, {
    cwd: workspaceDir, stdio: ['pipe', 'pipe', 'pipe'], env
  });
  piBuffer = '';

  piProcess.stdout.on('data', (chunk) => {
    piBuffer += chunk.toString();
    while (true) {
      const idx = piBuffer.indexOf('\n');
      if (idx === -1) break;
      const line = piBuffer.slice(0, idx).replace(/\r$/, '');
      piBuffer = piBuffer.slice(idx + 1);
      if (line.trim()) {
        try {
          const p = JSON.parse(line);

          // Track session ID from get_state response
          if (p.type === 'response' && p.command === 'get_state' && p.data) {
            if (p.data.sessionId) {
              const newId = p.data.sessionId;
              currentSessionId = newId;
              if (p.data.sessionFile) {
                currentSessionFile = p.data.sessionFile;
                // Update file map
                const fname = p.data.sessionFile.replace(/\\/g, '/').split('/').pop();
                if (!sessionFileMap[newId]) sessionFileMap[newId] = {};
                sessionFileMap[newId].file = fname;
                sessionFileMap[newId].mtime = Date.now();
                saveSessionFileMap();
              }
            }
            if (p.data.sessionName) {
              // Update title in cache
              const exIdx = sessionsCache.findIndex(s => s.id === currentSessionId);
              if (exIdx >= 0) {
                sessionsCache[exIdx].title = p.data.sessionName;
              }
              if (currentSessionId && sessionFileMap[currentSessionId]) {
                sessionFileMap[currentSessionId].title = p.data.sessionName;
              }
              saveSessionFileMap();
              broadcastSessions();
            }
            if (p.data.messageCount !== undefined) {
              const exIdx = sessionsCache.findIndex(s => s.id === currentSessionId);
              if (exIdx >= 0) sessionsCache[exIdx].messageCount = p.data.messageCount;
            }
          }

          // Track session name changes
          if (p.type === 'response' && p.command === 'set_session_name' && p.success) {
            refreshSessionsFromDisk();
          }

          // After agent finishes, refresh sessions
          if (p.type === 'agent_end') {
            setTimeout(refreshSessionsFromDisk, 500);
          }

          // After new_session, refresh
          if (p.type === 'response' && p.command === 'new_session' && p.success) {
            setTimeout(() => {
              if (piProcess) piWrite({ type: 'get_state' });
              refreshSessionsFromDisk();
            }, 500);
          }

          broadcast(p);
        } catch (e) {}
      }
    }
  });
  piProcess.stderr.on('data', (chunk) => console.error('pi err:', chunk.toString()));
  piProcess.stdin.on('error', (e) => { if (e.code !== 'EPIPE') console.error('pi stdin error:', e.message); });
  piProcess.on('error', (e) => console.error('pi process error:', e.message));
  piProcess.on('close', (code) => {
    piProcess = null;
    currentSessionFile = null;
    broadcast({ type: '_pi_exit', code });
    if (code !== 0) setTimeout(() => { if (!piProcess) startPi(); }, 1500);
  });
}

function handleWebSocketMessage(ws, msg) {
  // ---- Model Configuration ----
  if (msg.type === 'configure_model') {
    piConfig = {
      provider: msg.provider || null,
      modelId: msg.modelId || null,
      apiKey: msg.apiKey || null,
      baseUrl: msg.baseUrl || null,
      systemPrompt: msg.systemPrompt || null,
      enabledTools: msg.enabledTools || null,
      excludedTools: msg.excludedTools || null,
      // 高级设置
      thinkingBudgets: msg.thinkingBudgets || null,
      compactionReserveTokens: msg.compactionReserveTokens || null,
      compactionKeepRecentTokens: msg.compactionKeepRecentTokens || null,
      retryMaxRetries: msg.retryMaxRetries || null,
      hideThinkingBlock: msg.hideThinkingBlock || false
    };
    try { writeFileSync(CONFIG_FILE, JSON.stringify(piConfig, null, 2)); } catch (e) {}
    startPi(piConfig);
    broadcast({
      type: 'model_configured',
      data: { provider: piConfig.provider, modelId: piConfig.modelId }
    });
    setTimeout(() => {
      if (piProcess) piWrite({ type: 'get_state' });
      if (piProcess) piWrite({ type: 'get_available_models' });
    }, 1500);
    return;
  }

  // ---- Session Resume ----
  if (msg.type === 'resume_session') {
    const sessionPath = findSessionFileById(msg.sessionId);
    if (!sessionPath) {
      ws.send(JSON.stringify({ type: '_error', message: 'Session file not found for: ' + msg.sessionId }));
      return;
    }
    currentSessionId = msg.sessionId;
    startPi(piConfig, sessionPath);
    setTimeout(() => {
      if (piProcess) piWrite({ type: 'get_state' });
      if (piProcess) piWrite({ type: 'get_messages' });
    }, 2000);
    return;
  }

  // ---- Session Fork ----
  if (msg.type === 'fork_session') {
    const sessionPath = findSessionFileById(msg.sessionId);
    if (!sessionPath) {
      ws.send(JSON.stringify({ type: '_error', message: 'Session file not found for fork: ' + msg.sessionId }));
      return;
    }
    startPi(piConfig, null, sessionPath);
    setTimeout(() => {
      if (piProcess) piWrite({ type: 'get_state' });
      if (piProcess) piWrite({ type: 'get_messages' });
    }, 2000);
    return;
  }

  // ---- New Session ----
  if (msg.type === 'new_session') {
    startPi(piConfig);
    setTimeout(() => {
      if (piProcess) piWrite({ type: 'get_state' });
      refreshSessionsFromDisk();
    }, 1500);
    ws.send(JSON.stringify({ type: 'response', command: 'new_session', success: true }));
    return;
  }

  // ---- List Sessions ----
  if (msg.type === 'list_sessions') {
    sessionsCache.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
    ws.send(JSON.stringify({ type: 'response', command: 'list_sessions', success: true, data: { threads: sessionsCache.slice(0, 50) } }));
    return;
  }

  // ---- Delete Session ----
  if (msg.type === 'delete_session') {
    const sid = msg.sessionId;
    if (sid) {
      const idx = sessionsCache.findIndex(s => s.id === sid);
      if (idx >= 0) sessionsCache.splice(idx, 1);
      // Delete JSONL file
      try {
        const files = readdirSync(SESSION_DIR);
        for (const f of files) {
          if (f.endsWith('.jsonl') && f.includes('_' + sid + '.jsonl')) {
            unlinkSync(join(SESSION_DIR, f));
            break;
          }
        }
      } catch (_) {}
      // Clean file map
      delete sessionFileMap[sid];
      saveSessionFileMap();
      broadcastSessions();
      ws.send(JSON.stringify({ type: 'session_deleted', sessionId: sid }));
    }
    return;
  }

  // ---- Set Session Name ----
  if (msg.type === 'set_session_name') {
    if (msg.name && currentSessionId) {
      if (piProcess) {
        piWrite({ type: 'set_session_name', name: msg.name });
      }
      // Also update local cache
      const exIdx = sessionsCache.findIndex(s => s.id === currentSessionId);
      if (exIdx >= 0) sessionsCache[exIdx].title = msg.name;
      if (sessionFileMap[currentSessionId]) sessionFileMap[currentSessionId].title = msg.name;
      saveSessionFileMap();
      broadcastSessions();
      ws.send(JSON.stringify({ type: 'response', command: 'set_session_name', success: true }));
    }
    return;
  }

  // ---- Rename any session (sidebar rename) ----
  if (msg.type === 'rename_session') {
    const sid = msg.sessionId;
    const newName = msg.name;
    if (sid && newName) {
      const exIdx = sessionsCache.findIndex(s => s.id === sid);
      if (exIdx >= 0) sessionsCache[exIdx].title = newName;
      if (sessionFileMap[sid]) sessionFileMap[sid].title = newName;
      saveSessionFileMap();
      broadcastSessions();
      ws.send(JSON.stringify({ type: 'response', command: 'rename_session', success: true }));
    }
    return;
  }

  // ---- Export Session ----
  if (msg.type === 'export_session') {
    // If we have a session file, export it directly
    if (currentSessionFile && existsSync(currentSessionFile)) {
      const exportFile = join(SESSION_DIR, 'export-' + Date.now() + '.html');
      if (piProcess) {
        piWrite({ type: 'export_html', outputPath: exportFile });
      } else {
        execFile(PI_PATH, ['--export', exportFile, '--session-dir', SESSION_DIR], {
          cwd: process.cwd()
        }, (err, stdout, stderr) => {
          if (err) {
            ws.send(JSON.stringify({ type: '_error', message: 'Export failed: ' + err.message }));
          } else {
            ws.send(JSON.stringify({ type: 'session_exported', path: exportFile }));
          }
          startPi(piConfig);
          setTimeout(() => { if (piProcess) piWrite({ type: 'get_state' }); }, 1500);
        });
      }
    } else {
      if (piProcess) {
        piWrite({ type: 'export_html' });
      } else {
        ws.send(JSON.stringify({ type: '_error', message: 'No active session to export' }));
      }
    }
    return;
  }

  // ---- Set Workspace ----
  if (msg.type === 'set_workspace') {
    const newPath = msg.workspace;
    if (newPath && existsSync(newPath)) {
      workspaceDir = newPath;
      saveWorkspace(newPath);
      startPi(piConfig);
      broadcast({ type: 'workspace_changed', workspace: workspaceDir });
      setTimeout(() => { if (piProcess) piWrite({ type: 'get_state' }); }, 1500);
    } else {
      ws.send(JSON.stringify({ type: '_error', message: 'Workspace path does not exist: ' + (newPath || '') }));
    }
    return;
  }

  // ---- PI must be running for remaining commands ----
  if (!piProcess) {
    ws.send(JSON.stringify({ type: '_error', message: 'PI not running' }));
    return;
  }

  // ---- Intercept slash commands for native PI operations ----
  if (msg.type === 'prompt' && msg.message) {
    console.log('PROMPT:', msg.message);
    const trimmed = msg.message.trim();

    // /settings - 打开设置
    if (trimmed === '/settings') {
      addSysMsgToAll('设置面板在左侧侧边栏。\n- 模型配置：最上方\n- 工具过滤 / 自动压缩 / 自动重试 / 主题：最下方');
      return;
    }

    // /help - 显示帮助
    if (trimmed === '/help') {
      addSysMsgToAll('PI Agent 命令: /name /new /clone /compact /session /fork /tree /export /copy /resume /stats /model /thinking /clear /reload /help\n\n也支持 /skill:技能名 来调用技能');
      return;
    }

    // /model - 切换模型
    if (trimmed.startsWith('/model ')) {
      addSysMsgToAll('请使用左侧侧边栏或底部下拉框切换模型。\n当前模型配置中的第一个模型 ID 将被使用。');
      return;
    }
    if (trimmed === '/model') {
      addSysMsgToAll('请使用左侧侧边栏或底部下拉框切换模型');
      return;
    }

    // /thinking - 思考级别
    if (trimmed === '/thinking' || trimmed.startsWith('/thinking ')) {
      const level = trimmed.slice(10).trim();
      if (level && ['off','minimal','low','medium','high','xhigh'].includes(level)) {
        piWrite({ type: 'set_thinking_level', level });
        addSysMsgToAll('思考级别已设为: ' + level);
      } else {
        addSysMsgToAll('请使用底部下拉框设置思考级别，或输入 /thinking medium');
      }
      return;
    }

    // /stats - 会话统计
    if (trimmed === '/stats') {
      piWrite({ type: 'get_session_stats' });
      return;
    }

    // /clear - 清空消息
    if (trimmed === '/clear') {
      addSysMsgToAll('会话已清空（客户端）');
      return;
    }

    // /reload - 重新加载
    if (trimmed === '/reload') {
      startPi(piConfig, currentSessionFile);
      addSysMsgToAll('正在重新加载 PI...');
      setTimeout(() => { if (piProcess) piWrite({ type: 'get_state' }); }, 1500);
      return;
    }

    // /hotkeys - 快捷键
    if (trimmed === '/hotkeys') {
      addSysMsgToAll('快捷键: Enter=发送, Shift+Enter=换行, Ctrl+G=外部编辑器,\n/ 查看命令菜单, 点击左侧会话恢复历史');
      return;
    }

    // /quit - 不支持
    if (trimmed === '/quit') {
      addSysMsgToAll('Web 版不支持 /quit。请直接关闭浏览器标签页。');
      return;
    }

    // Handle /name command
    if (trimmed === '/name') {
      if (currentSessionId) {
        piWrite({ type: 'get_state' });
      }
      addSysMsgToAll('用法: /name 新名称  — 给当前会话命名');
      return;
    }
    if (trimmed.startsWith('/name ')) {
      const name = trimmed.slice(6).trim();
      if (name && currentSessionId) {
        piWrite({ type: 'set_session_name', name });
        updateSessionEntry(name, name);
        addSysMsgToAll('会话已命名: ' + name);
        return;
      }
    }

    // Handle /resume command - show session picker
    if (trimmed === '/resume') {
      loadSessionsFromDisk();
      broadcastSessions();
      addSysMsgToAll('请从左侧会话列表选择要恢复的会话');
      return;
    }

    // Handle /new command
    if (trimmed === '/new') {
      piWrite({ type: 'new_session' });
      addSysMsgToAll('正在创建新会话...');
      return;
    }

    // Handle /clone command
    if (trimmed === '/clone') {
      piWrite({ type: 'clone' });
      addSysMsgToAll('正在克隆会话...');
      setTimeout(refreshSessionsFromDisk, 1000);
      return;
    }

    // Handle /compact command
    if (trimmed.startsWith('/compact')) {
      const customInstructions = trimmed.slice(9).trim();
      if (customInstructions) {
        piWrite({ type: 'compact', customInstructions });
      } else {
        piWrite({ type: 'compact' });
      }
      addSysMsgToAll('正在压缩上下文...');
      return;
    }

    // Handle /session command
    if (trimmed === '/session') {
      piWrite({ type: 'get_session_stats' });
      return;
    }

    // Handle /fork command - bare shows list, with entryId forks
    if (trimmed.startsWith('/fork ')) {
      const entryId = trimmed.slice(6).trim();
      if (entryId) {
        piWrite({ type: 'fork', entryId });
        addSysMsgToAll('正在从 ' + entryId + ' 创建分支...');
        setTimeout(refreshSessionsFromDisk, 1000);
      }
      return;
    }
    if (trimmed === '/fork') {
      piWrite({ type: 'get_fork_messages' });
      return;
    }

    // Handle /tree command
    if (trimmed === '/tree') {
      piWrite({ type: 'get_fork_messages' });
      addSysMsgToAll('会话树 - 可用分支点已列出，使用 /fork <entryId> 来分支');
      return;
    }

    // Handle /export command
    if (trimmed === '/export' || trimmed.startsWith('/export ')) {
      const exportPath = trimmed.length > 7 ? trimmed.slice(8).trim() : null;
      if (exportPath) {
        piWrite({ type: 'export_html', outputPath: exportPath });
      } else {
        piWrite({ type: 'export_html' });
      }
      addSysMsgToAll('正在导出会话...');
      return;
    }

    // Handle /copy command
    if (trimmed === '/copy') {
      piWrite({ type: 'get_last_assistant_text' });
      return;
    }

    // Forward message to PI
    updateSessionEntry(msg.message);
    piWrite(msg);
    return;
  }

  // Forward all other messages to PI
  piWrite(msg);
}

function addSysMsgToAll(text) {
  broadcast({ type: 'system_message', message: text });
}

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({
    type: '_connected',
    workspace: workspaceDir,
    sessions: sessionsCache
  }));

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      handleWebSocketMessage(ws, msg);
    } catch (e) {
      console.error('WebSocket message parse error:', e.message);
    }
  });

  ws.on('close', () => clients.delete(ws));
});

loadSessionsFromDisk();

server.listen(PORT, () => {
  console.log('PI Web UI at http://localhost:' + PORT);
  console.log('Session dir:', SESSION_DIR);
  console.log('Session count:', sessionsCache.length);
  startPi();
  setTimeout(() => { if (piProcess) piWrite({ type: 'get_state' }); }, 1500);
});
