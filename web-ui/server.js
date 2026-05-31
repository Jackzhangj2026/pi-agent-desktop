import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { spawn, execFile } from 'child_process';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PORT = process.env.PORT || 3003;
const PI_PATH = join(dirname(__dirname), 'pi.exe');
const SESSION_DIR = join(dirname(__dirname), '.sessions');
const CONFIG_FILE = join(__dirname, '.pi-config.json');
const SESSIONS_FILE = join(__dirname, 'sessions.json');

if (!existsSync(SESSION_DIR)) mkdirSync(SESSION_DIR, { recursive: true });
// Scan installed skills
const SKILLS_DIR = join(homedir(), '.codex', 'skills');
let installedSkills = [];
try {
  installedSkills = readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.'))
    .map(d => d.name);
} catch (e) { installedSkills = []; }

const app = express();
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
let sessionCounter = 0;
let currentSessionId = null;

function saveSessionEntry(msg) {
  let sessions = [];
  try { if (existsSync(SESSIONS_FILE)) { let raw = readFileSync(SESSIONS_FILE, 'utf8'); if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1); sessions = JSON.parse(raw); if (!Array.isArray(sessions)) sessions = [sessions]; } } catch(e) {}
  const id = currentSessionId || ('s' + (++sessionCounter));
  const ex = sessions.find(s => s.id === id);
  if (ex) {
    ex.title = ex.title || (msg || '').substring(0, 60);
    ex.preview = (msg || '').substring(0, 80);
    ex.mtime = Date.now();
  } else {
    sessions.push({ id, title: (msg || '').substring(0, 60), preview: (msg || '').substring(0, 80), mtime: Date.now() });
  }
  try { writeFileSync(SESSIONS_FILE, JSON.stringify(sessions)); } catch(e) {}
}

let piConfig = {
  provider: null, modelId: null, apiKey: null, baseUrl: null,
  systemPrompt: null, enabledTools: null, excludedTools: null
};

// Load saved config on startup
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

function startPi(config, sessionId, forkId) {
  config = config || piConfig;
  if (piProcess) { piProcess.removeAllListeners('close'); piProcess.kill(); piProcess = null; }

  const args = ['--mode', 'rpc', '--session-dir', SESSION_DIR];
  if (sessionId) { args.push('--session-id', sessionId); }
  if (forkId) { args.push('--fork', forkId); }
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
    cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'], env
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
        try { const p = JSON.parse(line); if (p.type==='response'&&p.data&&p.data.sessionId) currentSessionId=p.data.sessionId; broadcast(p); } catch (e) {}
      }
    }
  });
  piProcess.stderr.on('data', (chunk) => console.error('pi err:', chunk.toString()));
  piProcess.stdin.on('error', (e) => { if (e.code !== 'EPIPE') console.error('pi stdin error:', e.message); });
  piProcess.on('error', (e) => console.error('pi process error:', e.message));
  piProcess.on('close', (code) => { piProcess = null; broadcast({ type: '_pi_exit', code }); if (code !== 0) setTimeout(() => { if (!piProcess) startPi(); }, 1500); });
}

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: '_connected', skills: installedSkills }));

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());

    if (msg.type === 'configure_model') {
      piConfig = {
        provider: msg.provider || null,
        modelId: msg.modelId || null,
        apiKey: msg.apiKey || null,
        baseUrl: msg.baseUrl || null,
        systemPrompt: msg.systemPrompt || null,
        enabledTools: msg.enabledTools || null,
        excludedTools: msg.excludedTools || null
      };
      // Save to disk
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

    if (msg.type === 'resume_session') {
      startPi(piConfig, msg.sessionId);
      setTimeout(() => {
        if (piProcess) piWrite({ type: 'get_state' });
      }, 1500);
      return;
    }

    if (msg.type === 'fork_session') {
      startPi(piConfig, null, msg.sessionId);
      setTimeout(() => {
        if (piProcess) piWrite({ type: 'get_state' });
      }, 1500);
      return;
    }

    if (msg.type === 'list_sessions') {
      let sessions = [];
      try { if (existsSync(SESSIONS_FILE)) { let raw = readFileSync(SESSIONS_FILE, 'utf8'); if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1); sessions = JSON.parse(raw); if (!Array.isArray(sessions)) sessions = [sessions]; } } catch(e) {}
      sessions.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
      ws.send(JSON.stringify({ type: 'response', command: 'list_sessions', success: true, data: { threads: sessions.slice(0, 50) } }));
      return;
    }

    if (msg.type === 'export_session') {
      if (piProcess) {
        piProcess.kill(); piProcess = null;
      }
      const exportFile = join(SESSION_DIR, 'export-' + Date.now() + '.html');
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
      return;
    }

    if (!piProcess) {
      ws.send(JSON.stringify({ type: '_error', message: 'PI not running' }));
      return;
    }
    console.log('PROMPT:', msg.message);
    if (msg.type === 'prompt' && msg.message) saveSessionEntry(msg.message);
    piWrite(msg);
  });

  ws.on('close', () => clients.delete(ws));
});

server.listen(PORT, () => {
  console.log('PI Web UI at http://localhost:' + PORT);
  startPi();
  setTimeout(() => { if (piProcess) piWrite({ type: 'get_state' }); }, 1000);
});

