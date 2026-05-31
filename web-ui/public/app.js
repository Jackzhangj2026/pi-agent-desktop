/* PI Agent Web UI */

// --- State ---
let ws = null;
let models = [];
let skillsList = [];
let toolCalls = {};
let curAssistantMsg = null;
let curTextBlock = null;
let curThinkingBlock = null;
let pendingExtUI = null;
let allCmds = [];
let selectedSlashIdx = -1;

// --- Element refs ---
const $ = (s) => document.querySelector(s);

const el = {
  messages: $('#messages'),
  inputBox: $('#input-box'),
  sendBtn: $('#send-btn'),
  abortBtn: $('#abort-btn'),
  modelSelect: $('#model-select'),
  thinkingSelect: $('#thinking-select'),
  statusDot: $('#status-dot'),
  statusText: $('#status-text'),
  sessionName: $('#session-name'),
  statusModel: $('#status-model'),
  statusThinking: $('#status-thinking'),
  statusMsgs: $('#status-msgs'),
  statusTokens: $('#status-tokens'),
  statusTokenVal: $('#status-token-val'),
  statusCost: $('#status-cost'),
  statusCostVal: $('#status-cost-val'),
  statusContext: $('#status-context'),
  statusContextVal: $('#status-context-val'),
  headerModel: $('#header-model'),
  headerThinking: $('#header-thinking'),
  overlay: $('#overlay'),
  statsModal: $('#stats-modal'),
  statsContent: $('#stats-content'),
  statsClose: $('#stats-close'),
  extModal: $('#ext-modal'),
  extTitle: $('#ext-title'),
  extMessage: $('#ext-message'),
  extContent: $('#ext-content'),
  extActions: $('#ext-actions'),
  slashMenu: $('#slash-menu'),
  slashList: $('#slash-list'),
  threadList: $('#thread-list'),
  configMsg: $('#config-msg'),
};

// --- WebSocket ---
function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(proto + '//' + location.host);

  ws.onopen = () => {
    setStatus('connected', '已连接');
    setTimeout(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        sendCmd({ type: 'get_state' });
        sendCmd({ type: 'get_available_models' });
      }
    }, 800);
  };

  ws.onmessage = (e) => {
    try { handleEvent(JSON.parse(e.data)); } catch (err) { console.error('解析错误', err); }
  };

  ws.onclose = () => {
    setStatus('idle', '已断开');
    setTimeout(connect, 2500);
  };

  ws.onerror = () => { ws.close(); };
}

function sendCmd(cmd) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(cmd));
}

function setStatus(state, text) {
  el.statusDot.className = 'status-dot ' + state;
  el.statusText.textContent = text;
}

// --- Event Router ---
function handleEvent(ev) {
  switch (ev.type) {
    case 'response':
      if (ev.command === 'get_available_models' && ev.data && ev.data.models) {
        models = ev.data.models;
        syncModelSelect();
      }
      if (ev.command === 'get_state' && ev.data) updateState(ev.data);
      if (ev.command === 'get_session_stats' && ev.data) showStats(ev.data);
      if (ev.command === 'get_commands' && ev.data && ev.data.commands) {
        updateCommands(ev.data.commands);
      }
      break;

    case 'agent_start':
      curAssistantMsg = null;
      curTextBlock = null;
      curThinkingBlock = null;
      toolCalls = {};
      el.abortBtn.disabled = false;
      el.sendBtn.disabled = true;
      removeWelcome();
      break;

    case 'agent_end':
      el.abortBtn.disabled = true;
      el.sendBtn.disabled = false;
      finalizeMsg();
      break;

    case 'message_update':
      handleMsgUpdate(ev);
      break;

    case 'tool_execution_start':
      toolStart(ev);
      break;
    case 'tool_execution_update':
      toolUpdate(ev);
      break;
    case 'tool_execution_end':
      toolEnd(ev);
      break;

    case 'compaction_start':
      addSysMsg('正在压缩上下文...');
      break;
    case 'compaction_end':
      addSysMsg('压缩完成');
      break;

    case 'extension_ui_request':
      handleExtUI(ev);
      break;

    case 'model_configured':
      el.configMsg.className = 'config-msg success';
      el.configMsg.textContent = '已应用: ' + (ev.data.provider || '?') + '/' + (ev.data.modelId || '?');
      el.headerModel.textContent = ev.data.modelId || '?';
      el.statusModel.textContent = ev.data.modelId || '?';
      break;

    case 'session_exported':
      addSysMsg('会话已导出: ' + ev.path);
      break;

    case '_pi_restarting':
      el.messages.innerHTML = '';
      showWelcome();
      break;
    case '_pi_exit':
      addSysMsg('PI 进程已退出 (代码 ' + ev.code + ')');
      setStatus('idle', '已断开');
      break;

    case '_connected':
      if (ev.skills) { skillsList = ev.skills; buildCmdList(); }
      sendCmd({ type: 'get_commands' });
      break;

    case '_error':
      addSysMsg('错误: ' + ev.message);
      break;
  }
}

// --- Message Streaming ---
function handleMsgUpdate(ev) {
  const delta = ev.assistantMessageEvent;
  if (!delta) return;

  removeWelcome();

  if (!curAssistantMsg) {
    curAssistantMsg = document.createElement('div');
    curAssistantMsg.className = 'message assistant';
    el.messages.appendChild(curAssistantMsg);
  }

  switch (delta.type) {
    case 'text_start':
      curTextBlock = document.createElement('div');
      curTextBlock.className = 'bubble';
      curAssistantMsg.appendChild(curTextBlock);
      break;
    case 'text_delta':
      if (curTextBlock) curTextBlock.textContent += delta.delta;
      break;
    case 'text_end':
      break;
    case 'thinking_start':
      curThinkingBlock = createThinkingBlock();
      curAssistantMsg.appendChild(curThinkingBlock);
      break;
    case 'thinking_delta':
      if (curThinkingBlock) {
        const content = curThinkingBlock.querySelector('.thinking-content');
        if (content) content.textContent += delta.delta;
      }
      break;
    case 'thinking_end':
      break;
    case 'toolcall_start':
      createToolCallCard(delta, curAssistantMsg);
      break;
    case 'toolcall_delta':
      break;
    case 'toolcall_end':
      break;
  }

  scrollDown();
  saveMessages();
}

function createThinkingBlock() {
  const block = document.createElement('div');
  block.className = 'thinking-block';
  block.innerHTML = '<div class="thinking-toggle"><span class="thinking-caret">&#9654;</span> 思考过程</div><div class="thinking-content"></div>';
  block.querySelector('.thinking-toggle').addEventListener('click', function() {
    block.classList.toggle('open');
  });
  return block;
}

function createToolCallCard(delta, parent) {
  const card = document.createElement('div');
  card.className = 'tool-call';
  card.dataset.tcPartial = '1';
  const iconClass = getToolIconClass(delta.name || '');
  card.innerHTML = '<div class="tool-header"><div class="tool-header-left"><span class="tool-icon ' + iconClass + '">' + getToolIcon(delta.name || '') + '</span><span class="tool-name">' + esc(delta.name || '工具') + '</span></div><span class="tool-status running">运行中</span></div>';
  if (delta.id) toolCalls[delta.id] = card;
  parent.appendChild(card);
  scrollDown();
  saveMessages();
}

function getToolIconClass(name) {
  const map = { bash: 'bash', read: 'read', write: 'write', edit: 'edit', grep: 'grep', find: 'find', ls: 'ls' };
  return map[name] || 'default';
}

function getToolIcon(name) {
  const map = { bash: '>_', read: 'R', write: 'W', edit: 'E', grep: 'G', find: 'F', ls: 'L' };
  return map[name] || '?';
}

function finalizeMsg() {
  if (curAssistantMsg) {
    if (!curAssistantMsg.querySelector('.bubble') && !curAssistantMsg.querySelector('.tool-call') && !curAssistantMsg.querySelector('.thinking-block')) {
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      while (curAssistantMsg.firstChild) bubble.appendChild(curAssistantMsg.firstChild);
      curAssistantMsg.appendChild(bubble);
    }
    curAssistantMsg = null;
    curTextBlock = null;
    curThinkingBlock = null;
  }
  saveMessages();
}

// --- Tool Execution ---
function toolStart(ev) {
  const card = document.createElement('div');
  card.className = 'tool-call';
  card.dataset.tcId = ev.toolCallId;
  const iconClass = getToolIconClass(ev.toolName);
  card.innerHTML = '<div class="tool-header"><div class="tool-header-left"><span class="tool-icon ' + iconClass + '">' + getToolIcon(ev.toolName) + '</span><span class="tool-name">' + esc(ev.toolName) + '</span></div><span class="tool-status running">运行中</span></div><div class="tool-args">' + esc(JSON.stringify(ev.args)) + '</div>';
  toolCalls[ev.toolCallId] = card;
  el.messages.appendChild(card);
  scrollDown();
  saveMessages();
}

function toolUpdate(ev) {
  const card = toolCalls[ev.toolCallId];
  if (!card) return;
  let result = card.querySelector('.tool-result');
  if (!result) {
    result = document.createElement('div');
    result.className = 'tool-result';
    card.appendChild(result);
  }
  if (ev.partialResult && ev.partialResult.content) {
    result.textContent = ev.partialResult.content.map(function(c) { return c.text || ''; }).join('');
  }
  scrollDown();
  saveMessages();
}

function toolEnd(ev) {
  const card = toolCalls[ev.toolCallId];
  if (!card) return;
  const statusEl = card.querySelector('.tool-status');
  if (statusEl) {
    statusEl.className = 'tool-status ' + (ev.isError ? 'error' : 'done');
    statusEl.textContent = ev.isError ? '错误' : '完成';
  }
  if (!card.querySelector('.tool-result') && ev.result && ev.result.content) {
    const result = document.createElement('div');
    result.className = 'tool-result';
    result.textContent = ev.result.content.map(function(c) { return c.text || ''; }).join('');
    card.appendChild(result);
  }
  delete toolCalls[ev.toolCallId];
  scrollDown();
  saveMessages();
}

// --- Model Select ---
function syncModelSelect() {
  const curVal = el.modelSelect.value;
  el.modelSelect.innerHTML = '<option value="">切换模型...</option>';

  for (let i = 0; i < models.length; i++) {
    const m = models[i];
    const opt = document.createElement('option');
    opt.value = m.provider + '/' + m.id;
    opt.textContent = (m.name || m.id) + ' (' + m.provider + ')';
    el.modelSelect.appendChild(opt);
  }

  const customIds = getModelIds();
  if (customIds.length > 0) {
    const sep = document.createElement('option');
    sep.disabled = true;
    sep.textContent = '---- 自定义 ----';
    el.modelSelect.appendChild(sep);
    for (let j = 0; j < customIds.length; j++) {
      const opt = document.createElement('option');
      opt.value = 'saved:' + customIds[j];
      opt.textContent = customIds[j] + ' (' + $('#provider-select').value + ')';
      el.modelSelect.appendChild(opt);
    }
  }

  if (curVal) {
    try { el.modelSelect.value = curVal; } catch(e) {}
  }
}

function getModelIds() {
  const fields = document.querySelectorAll('.model-id-field');
  const ids = [];
  for (let i = 0; i < fields.length; i++) {
    const v = fields[i].value.trim();
    if (v) ids.push(v);
  }
  return ids;
}

function addModelRow() {
  const container = document.getElementById('model-ids-container');
  const row = document.createElement('div');
  row.className = 'model-id-row';
  row.innerHTML = '<input class="model-id-field" placeholder="\u6a21\u578b ID\uff08\u5982 claude-sonnet-4\uff09"><button class="remove-model-btn" title="\u5220\u9664">-</button>';
  row.querySelector('.remove-model-btn').addEventListener('click', function() {
    row.remove();
    syncModelSelect();
    saveConfig();
  });
  row.querySelector('input').addEventListener('input', function() {
    syncModelSelect();
    saveConfig();
  });
  container.appendChild(row);
  syncModelSelect();
  saveConfig();
}

// --- State Update ---
function updateState(data) {
  if (data.model) {
    const name = data.model.name || data.model.id;
    el.statusModel.textContent = name;
    el.headerModel.textContent = name;
  }
  if (data.thinkingLevel) {
    el.statusThinking.textContent = data.thinkingLevel;
    el.thinkingSelect.value = data.thinkingLevel;
    el.headerThinking.textContent = data.thinkingLevel.substring(0, 3);
  }
  el.statusMsgs.textContent = data.messageCount || 0;

  if (data.sessionName) {
    el.sessionName.textContent = data.sessionName;
  }

  if (data.recentThreads) {
    renderThreads(data.recentThreads);
  }

  if (data.isStreaming) {
    setStatus('running', '运行中...');
  } else {
    setStatus('connected', '就绪');
  }

  if (data.tokens) {
    el.statusTokens.classList.remove('hidden');
    el.statusTokenVal.textContent = (data.tokens.total || 0).toLocaleString();
  }
}

function renderThreads(threads) {
  el.threadList.innerHTML = '';
  for (let i = 0; i < threads.length; i++) {
    const t = threads[i];
    const div = document.createElement('div');
    div.className = 'thread-item';
    div.innerHTML = '<div class="thread-title">' + escHTML(t.title || '未命名') + '</div>' +
      (t.preview ? '<div class="thread-preview">' + escHTML(t.preview) + '</div>' : '');
    div.onclick = function() {
      if (t.id) sendCmd({ type: 'resume_session', sessionId: t.id });
    };
    el.threadList.appendChild(div);
  }
  if (threads.length === 0) {
    el.threadList.innerHTML = '<div class="thread-empty">暂无会话</div>';
  }
}

// --- Stats ---
function showStats(data) {
  let html = '';
  function row(k, v) { html += '<div class="stats-row"><span>' + k + '</span><span class="val">' + v + '</span></div>'; }

  row('消息总数', data.totalMessages || 0);
  row('用户消息', data.userMessages || 0);
  row('助手消息', data.assistantMessages || 0);
  row('工具调用', data.toolCalls || 0);

  if (data.tokens) {
    row('输入 Token', (data.tokens.input || 0).toLocaleString());
    row('输出 Token', (data.tokens.output || 0).toLocaleString());
    if (data.tokens.cacheRead) row('缓存读取', (data.tokens.cacheRead || 0).toLocaleString());
    row('费用', '$' + ((data.cost || 0).toFixed(4)));
  }
  if (data.contextUsage && data.contextUsage.percent !== null) {
    row('上下文占用', data.contextUsage.percent + '%');
  }

  el.statsContent.innerHTML = html;
  el.statsModal.classList.add('visible');
  el.overlay.classList.add('visible');
}

// --- Send Message ---
function sendMessage() {
  const text = el.inputBox.value.trim();
  if (!text) return;

  const div = document.createElement('div');
  div.className = 'message user';
  div.innerHTML = '<div class="bubble">' + esc(text) + '</div>';
  el.messages.appendChild(div);

  el.inputBox.value = '';
  el.inputBox.style.height = 'auto';

  sendCmd({ type: 'prompt', message: text });
  scrollDown();
  saveMessages();
  removeWelcome();
}

// --- Helpers ---
function addSysMsg(text) {
  const div = document.createElement('div');
  div.className = 'message system';
  div.innerHTML = '<div class="bubble">' + esc(text) + '</div>';
  el.messages.appendChild(div);
  scrollDown();
}

function esc(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function escHTML(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function scrollDown() {
  el.messages.scrollTop = el.messages.scrollHeight;
}

function removeWelcome() {
  const welcome = el.messages.querySelector('.welcome');
  if (welcome) welcome.remove();
}

function showWelcome() {
  if (!el.messages.querySelector('.welcome')) {
    const div = document.createElement('div');
    div.className = 'welcome';
    div.innerHTML = '<div class="welcome-icon"><svg width="48" height="48" viewBox="0 0 32 32" fill="none"><circle cx="16" cy="16" r="14" stroke="currentColor" stroke-width="1.5" fill="none"/><text x="16" y="22" text-anchor="middle" font-size="16" font-weight="bold" fill="currentColor">\u03c0</text></svg></div><h2>PI Agent</h2><p>配置模型后开始对话</p>';
    el.messages.appendChild(div);
  }
}

// --- Slash Commands ---
const builtinCmds = [
  { cmd: '/help', desc: '显示帮助', tag: '内置' },
  { cmd: '/model', desc: '切换模型', tag: '内置' },
  { cmd: '/thinking', desc: '设置思考级别', tag: '内置' },
  { cmd: '/compact', desc: '压缩上下文', tag: '内置' },
  { cmd: '/stats', desc: '会话统计', tag: '内置' },
  { cmd: '/clear', desc: '清空消息', tag: '内置' },
  { cmd: '/session', desc: '会话管理', tag: '内置' },
  { cmd: '/export', desc: '导出会话', tag: '内置' },
  { cmd: '/name', desc: '设置会话名称', tag: '内置' },
  { cmd: '/new', desc: '新建会话', tag: '内置' },
  { cmd: '/resume', desc: '恢复会话', tag: '内置' },
  { cmd: '/fork', desc: '分支会话', tag: '内置' },
  { cmd: '/clone', desc: '克隆会话', tag: '内置' },
  { cmd: '/tree', desc: '会话树', tag: '内置' },
  { cmd: '/copy', desc: '复制最后回复', tag: '内置' },
  { cmd: '/reload', desc: '重新加载扩展', tag: '内置' },
  { cmd: '/hotkeys', desc: '显示快捷键', tag: '内置' },
  { cmd: '/quit', desc: '退出', tag: '内置' },
];

function updateCommands(cmds) {
  for (let i = 0; i < cmds.length; i++) {
    const c = cmds[i];
    if (!allCmds.find(function(x) { return x.cmd === '/' + c.name; })) {
      let tag = '扩展';
      if (c.source === 'skill') tag = '技能';
      else if (c.source === 'prompt') tag = '模板';
      allCmds.push({ cmd: '/' + c.name, desc: c.description || '', tag: tag });
    }
  }
  buildCmdList();
}

function buildCmdList() {
  allCmds = builtinCmds.slice();
  for (let i = 0; i < skillsList.length; i++) {
    allCmds.push({ cmd: '/skill:' + skillsList[i], desc: '使用技能: ' + skillsList[i], tag: '技能' });
  }
}

function showSlashMenu(filter) {
  filter = (filter || '').toLowerCase();
  let html = '';
  let count = 0;
  selectedSlashIdx = -1;

  for (let i = 0; i < allCmds.length; i++) {
    const c = allCmds[i];
    if (!filter || c.cmd.toLowerCase().indexOf(filter) >= 0 || c.desc.toLowerCase().indexOf(filter) >= 0) {
      const sel = count === 0 ? ' selected' : '';
      html += '<div class="slash-item' + sel + '" data-idx="' + i + '"><span class="cmd">' + escHTML(c.cmd) + '</span><span class="desc">' + escHTML(c.desc) + '</span><span class="tag">' + c.tag + '</span></div>';
      if (count === 0) selectedSlashIdx = i;
      count++;
    }
  }

  el.slashList.innerHTML = html || '<div class="slash-item" style="color:var(--text-muted)">无匹配</div>';
  if (count > 0) el.slashMenu.classList.add('visible');
  else el.slashMenu.classList.remove('visible');
  bindSlashItems();
}

function bindSlashItems() {
  const items = el.slashList.querySelectorAll('.slash-item[data-idx]');
  for (let i = 0; i < items.length; i++) {
    items[i].addEventListener('click', function() {
      pickCommand(allCmds[parseInt(this.getAttribute('data-idx'))]);
    });
  }
}

function pickCommand(c) {
  if (!c) return;
  el.inputBox.value = c.cmd + ' ';
  el.inputBox.focus();
  el.slashMenu.classList.remove('visible');
  selectedSlashIdx = -1;
}

function updateSlashSelection(items) {
  for (let i = 0; i < items.length; i++) {
    items[i].classList.toggle('selected', i === selectedSlashIdx);
    if (i === selectedSlashIdx) items[i].scrollIntoView({ block: 'nearest' });
  }
}

// --- Extension UI ---
function handleExtUI(ev) {
  if (ev.method === 'select') {
    el.extTitle.textContent = ev.title || '请选择';
    el.extMessage.textContent = '';
    el.extContent.innerHTML = '<div class="options"></div>';
    const opts = el.extContent.querySelector('.options');
    (ev.options || []).forEach(function(o) {
      const b = document.createElement('button');
      b.textContent = o;
      b.addEventListener('click', function() {
        sendCmd({ type: 'extension_ui_response', id: ev.id, value: o });
        closeExtUI();
      });
      opts.appendChild(b);
    });
    el.extActions.innerHTML = '<button class="btn" onclick="closeExtUI()">取消</button>';
    showExtUI();
  } else if (ev.method === 'confirm') {
    el.extTitle.textContent = ev.title || '确认';
    el.extMessage.textContent = ev.message || '';
    el.extContent.innerHTML = '';
    el.extActions.innerHTML = '<button class="btn btn-accent" onclick="confirmExtUI(true)">确认</button><button class="btn" onclick="closeExtUI()">取消</button>';
    pendingExtUI = ev;
    showExtUI();
  } else if (ev.method === 'input' || ev.method === 'editor') {
    el.extTitle.textContent = ev.title || '输入';
    el.extMessage.textContent = '';
    if (ev.method === 'editor') {
      el.extContent.innerHTML = '<textarea id="ext-input-field">' + esc(ev.prefill || '') + '</textarea>';
    } else {
      el.extContent.innerHTML = '<input id="ext-input-field" type="text" placeholder="' + esc(ev.placeholder || '') + '">';
    }
    el.extActions.innerHTML = '<button class="btn btn-accent" onclick="submitExtInput()">确定</button><button class="btn" onclick="closeExtUI()">取消</button>';
    pendingExtUI = ev;
    showExtUI();
  } else if (ev.method === 'notify') {
    addSysMsg('[扩展] ' + (ev.message || ''));
  }
}

function showExtUI() {
  el.extModal.classList.add('visible');
  el.overlay.classList.add('visible');
}

window.closeExtUI = function() {
  el.extModal.classList.remove('visible');
  el.overlay.classList.remove('visible');
  if (pendingExtUI) {
    sendCmd({ type: 'extension_ui_response', id: pendingExtUI.id, cancelled: true });
    pendingExtUI = null;
  }
};

window.confirmExtUI = function(confirmed) {
  if (pendingExtUI) sendCmd({ type: 'extension_ui_response', id: pendingExtUI.id, confirmed: confirmed });
  closeExtUI();
};

window.submitExtInput = function() {
  const field = document.getElementById('ext-input-field');
  const val = field ? field.value : '';
  if (pendingExtUI) sendCmd({ type: 'extension_ui_response', id: pendingExtUI.id, value: val });
  closeExtUI();
};

// --- Persistence ---
function saveMessages() {
  const html = el.messages.innerHTML;
  if (html) localStorage.setItem('pi-messages', html);
}

function restoreMessages() {
  const html = localStorage.getItem('pi-messages');
  if (html) el.messages.innerHTML = html;
}

function saveConfig() {
  if (window._restoring) return;
  const data = {
    provider: $('#provider-select').value,
    apiKey: $('#api-key-input').value,
    baseUrl: $('#base-url-input').value,
    systemPrompt: $('#system-prompt-input').value,
    modelIds: getModelIds(),
    toolsAllow: $('#tools-allow').value,
    toolsDeny: $('#tools-deny').value,
    toolsFilterEnabled: $('#tools-filter-toggle').classList.contains('active'),
    autoCompact: $('#auto-compact-toggle').classList.contains('active'),
    autoRetry: $('#auto-retry-toggle').classList.contains('active')
  };
  localStorage.setItem('pi-model-config', JSON.stringify(data));
}

function restoreConfig() {
  try {
    window._restoring = true;
    const data = JSON.parse(localStorage.getItem('pi-model-config'));
    if (!data) return;
    if (data.provider) $('#provider-select').value = data.provider;
    if (data.apiKey) $('#api-key-input').value = data.apiKey;
    if (data.baseUrl) $('#base-url-input').value = data.baseUrl;
    if (data.systemPrompt) $('#system-prompt-input').value = data.systemPrompt;
    if (data.toolsAllow != null) $('#tools-allow').value = data.toolsAllow;
    if (data.toolsDeny != null) $('#tools-deny').value = data.toolsDeny;
    if (data.toolsFilterEnabled) {
      $('#tools-filter-toggle').classList.add('active');
      $('#tools-filter-group').classList.remove('hidden');
    }
    if (data.autoCompact === false) $('#auto-compact-toggle').classList.remove('active');
    if (data.autoRetry === false) $('#auto-retry-toggle').classList.remove('active');
    if (data.modelIds && data.modelIds.length > 0) {
      const fields = document.querySelectorAll('.model-id-field');
      for (let i = 0; i < data.modelIds.length; i++) {
        if (i === 0) {
          if (fields[0]) fields[0].value = data.modelIds[i];
        } else {
          addModelRow();
          const newFields = document.querySelectorAll('.model-id-field');
          if (newFields[i]) newFields[i].value = data.modelIds[i];
        }
      }
    } else if (data.modelId) {
      const f = document.querySelector('.model-id-field');
      if (f) f.value = data.modelId;
    }
  } catch (e) {
    console.error('restoreConfig error:', e);
  } finally {
    window._restoring = false;
  }
}

// --- Apply Config ---
function applyConfig() {
  const provider = $('#provider-select').value;
  const modelIds = getModelIds();
  const modelId = modelIds[0] || '';
  const apiKey = $('#api-key-input').value.trim();
  const baseUrl = $('#base-url-input').value.trim();
  const systemPrompt = $('#system-prompt-input').value.trim();
  const toolsAllow = $('#tools-allow').value.trim();
  const toolsDeny = $('#tools-deny').value.trim();

  if (!modelId) {
    el.configMsg.className = 'config-msg error';
    el.configMsg.textContent = '请输入模型 ID';
    return;
  }

  el.configMsg.className = 'config-msg';
  el.configMsg.textContent = '正在应用...';
  saveConfig();

  sendCmd({
    type: 'configure_model',
    provider: provider,
    modelId: modelId,
    apiKey: apiKey || undefined,
    systemPrompt: systemPrompt || undefined,
    baseUrl: baseUrl || undefined,
    enabledTools: toolsAllow || undefined,
    excludedTools: toolsDeny || undefined
  });

  setTimeout(function() {
    sendCmd({ type: 'get_state' });
    sendCmd({ type: 'get_available_models' });
    sendCmd({ type: 'get_commands' });
  }, 2000);
}

// --- Theme ---
(function() {
  const root = document.documentElement;
  let themeMode = localStorage.getItem('pi-theme') || 'dark';

  function applyTheme(mode) {
    themeMode = mode;
    localStorage.setItem('pi-theme', mode);
    const isLight = mode === 'light' || (mode === 'system' && window.matchMedia('(prefers-color-scheme: light)').matches);
    root.classList.toggle('theme-light', isLight);

    document.querySelectorAll('.theme-opt').forEach(function(b) { b.removeAttribute('data-active'); });
    const active = document.querySelector('.theme-opt[data-theme="' + mode.replace(/[^\w-]/g, '\\$&') + '"]');
    if (active) active.setAttribute('data-active', '');
  }

  applyTheme(themeMode);

  document.querySelectorAll('.theme-opt').forEach(function(b) {
    b.addEventListener('click', function() { applyTheme(this.getAttribute('data-theme')); });
  });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function() {
    if (themeMode === 'system') applyTheme('system');
  });
})();

// --- Event Listeners ---
el.sendBtn.addEventListener('click', sendMessage);

el.inputBox.addEventListener('keydown', function(e) {
  if (el.slashMenu.classList.contains('visible')) {
    const items = el.slashList.querySelectorAll('.slash-item[data-idx]');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!items.length) return;
      selectedSlashIdx = (selectedSlashIdx + 1) % items.length;
      updateSlashSelection(items);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!items.length) return;
      selectedSlashIdx = (selectedSlashIdx - 1 + items.length) % items.length;
      updateSlashSelection(items);
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      if (selectedSlashIdx >= 0 && items.length > selectedSlashIdx) {
        pickCommand(allCmds[parseInt(items[selectedSlashIdx].getAttribute('data-idx'))]);
      }
      return;
    }
    if (e.key === 'Escape') {
      el.slashMenu.classList.remove('visible');
      return;
    }
  }

  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

el.inputBox.addEventListener('input', function() {
  el.inputBox.style.height = 'auto';
  el.inputBox.style.height = Math.min(el.inputBox.scrollHeight, 150) + 'px';

  const val = el.inputBox.value;
  if (val.startsWith('/')) {
    if (!allCmds.length) buildCmdList();
    showSlashMenu(val);
  } else {
    el.slashMenu.classList.remove('visible');
  }
});

el.abortBtn.addEventListener('click', function() { sendCmd({ type: 'abort' }); });

$('#new-session-btn').addEventListener('click', function() {
  sendCmd({ type: 'new_session' });
  setTimeout(function() {
    el.messages.innerHTML = '';
    showWelcome();
    localStorage.removeItem('pi-messages');
    sendCmd({ type: 'get_state' });
  }, 500);
});

$('#session-stats-btn').addEventListener('click', function() {
  sendCmd({ type: 'get_session_stats' });
});

$('#apply-btn').addEventListener('click', applyConfig);

$('#resume-btn').addEventListener('click', function() {
  const id = $('#resume-input').value.trim();
  if (id) sendCmd({ type: 'resume_session', sessionId: id });
});

$('#export-btn').addEventListener('click', function() {
  sendCmd({ type: 'export_session' });
});

$('#clear-btn').addEventListener('click', function() {
  el.messages.innerHTML = '';
  showWelcome();
  localStorage.removeItem('pi-messages');
});

// Model select change
el.modelSelect.addEventListener('change', function() {
  const val = el.modelSelect.value;
  if (!val) return;
  if (val.startsWith('saved:')) {
    const id = val.substring(6);
    const f = document.querySelector('.model-id-field');
    if (f) f.value = id;
    applyConfig();
    return;
  }
  const parts = val.split('/');
  if (parts.length === 2) {
    sendCmd({ type: 'set_model', provider: parts[0], modelId: parts[1] });
  }
});

el.thinkingSelect.addEventListener('change', function() {
  sendCmd({ type: 'set_thinking_level', level: el.thinkingSelect.value });
  el.headerThinking.textContent = el.thinkingSelect.value.substring(0, 3);
  el.statusThinking.textContent = el.thinkingSelect.value;
});

// Toggles
function makeToggle(elToggle, cmd) {
  elToggle.addEventListener('click', function() {
    const active = elToggle.classList.toggle('active');
    sendCmd({ type: cmd, enabled: active });
  });
}

makeToggle($('#auto-compact-toggle'), 'set_auto_compaction');
makeToggle($('#auto-retry-toggle'), 'set_auto_retry');

$('#tools-filter-toggle').addEventListener('click', function() {
  const active = this.classList.toggle('active');
  $('#tools-filter-group').classList.toggle('hidden', !active);
});

el.statsClose.addEventListener('click', function() {
  el.statsModal.classList.remove('visible');
  el.overlay.classList.remove('visible');
});

el.overlay.addEventListener('click', function() {
  el.statsModal.classList.remove('visible');
  el.extModal.classList.remove('visible');
  el.overlay.classList.remove('visible');
  if (pendingExtUI) {
    sendCmd({ type: 'extension_ui_response', id: pendingExtUI.id, cancelled: true });
    pendingExtUI = null;
  }
});

// --- Init ---
restoreConfig();
restoreMessages();

// Auto-save all config fields on input change
$('#api-key-input').addEventListener('input', function() { saveConfig(); });
$('#base-url-input').addEventListener('input', function() { saveConfig(); });
$('#system-prompt-input').addEventListener('input', function() { saveConfig(); });
$('#tools-allow').addEventListener('input', function() { saveConfig(); });
$('#tools-deny').addEventListener('input', function() { saveConfig(); });

// Add model button
$('#add-model-btn').addEventListener('click', addModelRow);

// First model-id field change
const firstField = document.querySelector('.model-id-field');
if (firstField) {
  firstField.addEventListener('input', function() { syncModelSelect(); saveConfig(); });
}

// Provider change refreshes model select
$('#provider-select').addEventListener('change', function() {
  syncModelSelect();
  saveConfig();
});

connect();
