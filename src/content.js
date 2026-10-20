/* Isolated-world UI. Only validated aggregate observations enter this world. */
(function () {
  'use strict';
  let config = C.settings(), pathname = location.pathname, detected = 'unknown';
  let historyRead = null;
  let manual = null, manualStats = null, manualController = null, manualRun = 0;
  const manualScanner = createCWMScanner(C);
  let network = null, signal = null, stats = null, root, badge, panel, notice, observer;
  let highestStage = 0, dismissed = 0, snoozeUntil = 0, ignored = false, scanTimer, open = false;
  let lastObservation = 0, routeChangedAt = 0, storageFailed = false;
  let visibleIds = new Set(), retiredIds = new Set();
  const byId = key => root.querySelector('#cwm-' + key);
  const format = value => new Intl.NumberFormat('zh-CN').format(value || 0);
  const LABELS = {
    hard: '网站已返回会话容量限制，建议新开对话。',
    context: '网站已返回上下文截断限制提示，请查看页面提供的后续操作。',
    quota: '网站返回了使用额度限制。这不表示当前对话容量已满。',
    input: '本次输入或请求上下文过长；尚不能判断对话已永久终止。',
    readonly: '网站将此对话标为只读；原因未确认。'
  };
  function invalidateManual(reason = 'changed') {
    if (!manual && !manualController) return;
    manualRun++; manualController?.abort(); manualController = null; manualStats = null;
    manual = { status: 'stopped', reason, pages: manual?.pages || 0 };
  }
  async function startManual(event) {
    // MAIN messages and synthetic DOM events cannot trigger authenticated requests.
    if (!event.isTrusted || manualController) return;
    resetRoute(); const cid = C.route(location.pathname);
    if (!cid || C.effectiveMode(detected, config.mode) === 'work') return;
    const scanPath = location.pathname, run = ++manualRun;
    const branch = C.id(network?.branch);
    manualStats = null; manual = { status: 'auth', pages: 0 };
    const controller = new AbortController(); manualController = controller; render();
    await manualScanner.scan({ conversationId: cid, branch, signal: controller.signal,
      isCurrent: () => run === manualRun && location.pathname === scanPath,
      onUpdate: value => {
        if (run !== manualRun || location.pathname !== scanPath) return;
        manual = value; manualStats = value.stats && value.pages > 0 && !['changed', 'conflict', 'scope', 'work'].includes(value.reason) ? value.stats : null;
        if (value.mode === 'work' || value.mode === 'chat') detected = value.mode;
        stats = manualStats || network; render();
      } });
    if (run === manualRun) { manualController = null; scheduleScan(); render(); }
  }
  function resetRoute() {
    if (pathname === location.pathname) return false;
    invalidateManual(); manual = null;
    retiredIds = new Set(visibleIds); visibleIds.clear();
    pathname = location.pathname; detected = 'unknown'; network = null; signal = null; stats = null; historyRead = null;
    highestStage = 0; dismissed = 0; snoozeUntil = 0; ignored = false; lastObservation = 0; routeChangedAt = Date.now();
    render(); return true;
  }
  function validStats(value) {
    if (!value || !['chars', 'tokens', 'turns', 'messages'].every(key =>
      Number.isSafeInteger(value[key]) && value[key] >= 0 && value[key] <= 1e10)) return null;
    if (!Array.isArray(value.activeIds) || value.activeIds.length > 100000) return null;
    if (!value.activeIds.every(x => C.id(x))) return null;
    if (!['branch', 'branch-slice', 'message-page'].includes(value.coverage)) return null;
    if (!C.id(value.branch) && value.coverage !== 'message-page') return null;
    const breakdown = {};
    for (const role of C.ROLES) {
      const n = value.breakdown?.[role];
      if (!Number.isSafeInteger(n) || n < 0 || n > 1e10) return null;
      breakdown[role] = n;
    }
    return { chars: value.chars, tokens: value.tokens, turns: value.turns, messages: value.messages,
      omitted: value.omitted === true, activeIds: value.activeIds, branch: value.branch, breakdown,
      source: 'history', coverage: value.coverage, hasPrevious: value.hasPrevious === true,
      requestedTurns: Number.isSafeInteger(value.requestedTurns) && value.requestedTurns >= 0 && value.requestedTurns <= 100000 ? value.requestedTurns : null,
      complete: value.complete === true && value.coverage === 'branch' && value.requestedTurns == null && value.hasPrevious !== true };
  }
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.type !== 'CWM_OBSERVATION_V2') return;
    const p = event.data.packet;
    if (!p || !['snapshot', 'signal', 'stale', 'history-status'].includes(p.type)) return;
    resetRoute();
    if (p.pathname !== pathname || (p.conversationId && p.conversationId !== C.route(pathname))) return;
    if (!Number.isFinite(p.observedAt) || p.observedAt < lastObservation) return;
    lastObservation = p.observedAt;
    if (['chat', 'work'].includes(p.mode)) detected = p.mode;
    if (p.mode === 'work') invalidateManual('work');
    // Fixed allowlist: never render a page-provided message, HTML, model/account name, or URL.
    if (p.signal && C.signal(p.signal.code === 'context-truncation-block' ?
      { banner_info: { name: p.signal.code } } : p.signal.code === 'is_read_only' ?
      { is_read_only: true } : { code: p.signal.code })) {
      const canonical = C.signal(p.signal.code === 'context-truncation-block' ?
        { banner_info: { name: p.signal.code } } : p.signal.code === 'is_read_only' ?
        { is_read_only: true } : { code: p.signal.code });
      // Do not let a later quota error hide a known conversation stop.
      if (!signal || !['hard', 'context'].includes(signal.kind) || ['hard', 'context'].includes(canonical.kind)) signal = canonical;
    }
    if (p.history && ['legacy', 'plural'].includes(p.history.family) &&
      ['pending', 'branch', 'partial', 'unsupported', 'invalid', 'unreadable'].includes(p.history.status)) {
      historyRead = { family: p.history.family, page: p.history.page === true, status: p.history.status,
        requestedTurns: Number.isSafeInteger(p.history.requestedTurns) && p.history.requestedTurns >= 0 && p.history.requestedTurns <= 100000 ? p.history.requestedTurns : null };
    }
    if (p.type === 'snapshot') {
      const next = validStats(p.stats);
      if (manualStats?.branch && next?.branch && next.branch !== manualStats.branch) invalidateManual();
      network = next;
    }
    if (p.type === 'stale') { network = null; invalidateManual(); }
    scheduleScan();
  });
  function scan() {
    scanTimer = null;
    if (!root) return;
    resetRoute();
    // During SPA transitions the old DOM can briefly remain mounted. Wait for it to settle.
    if (Date.now() - routeChangedAt < 700) { scheduleScan(750); return; }
    const elements = [...document.querySelectorAll('[data-message-author-role="user"], [data-message-author-role="assistant"]')]
      .filter(el => !root.contains(el) && !el.closest('[aria-hidden="true"]') && el.getClientRects().length > 0);
    const ids = new Set(), values = [];
    for (const el of elements) {
      const messageId = C.id(el.getAttribute('data-message-id') || el.closest('[data-message-id]')?.getAttribute('data-message-id'));
      if (messageId && ids.has(messageId)) continue;
      if (messageId) ids.add(messageId);
      values.push(C.messageStats({ author: { role: el.getAttribute('data-message-author-role') },
        content: { parts: [el.innerText || ''] } }));
    }
    // Old messages may linger during client-side navigation; never relabel them as the new chat.
    if (retiredIds.size && [...ids].some(id => retiredIds.has(id))) { stats = manualStats || network; render(); return; }
    retiredIds.clear(); visibleIds = ids;
    const visible = values.length ? { ...C.aggregate(values), source: 'dom', complete: false } : null;
    // A changed branch/new stream invalidates a previously loaded active branch.
    if (network && ids.size && [...ids].some(id => !network.activeIds.includes(id))) network = null;
    // Never silently pin old history when streaming mutates an existing message ID.
    if (network && visible && (visible.chars > network.chars || visible.turns > network.turns)) network = null;
    if (manualStats?.complete && ids.size && [...ids].some(id => !manualStats.activeIds.includes(id))) invalidateManual();
    stats = manualStats || network || visible;
    render();
  }
  function scheduleScan(delay = 300) {
    if (scanTimer) return;
    scanTimer = setTimeout(scan, delay);
  }
  function render() {
    if (!root) return;
    const currentMode = C.effectiveMode(detected, config.mode);
    const measuredStage = C.level(stats, config, detected);
    highestStage = Math.max(highestStage, measuredStage);
    // Partial DOM counts may fall after a send/virtual scroll; do not silently retract a reminder.
    const stage = currentMode === 'chat' && config.enabled ? highestStage : 0;
    const remind = stage > dismissed && !ignored && Date.now() >= snoozeUntil;
    const strong = signal && ['hard', 'context'].includes(signal.kind);
    const title = strong ? '网站限制' : remind ? (stage === 2 ? '建议准备接续' : '接续提醒') : '接续';
    badge.textContent = `${title} · ${stats ? format(stats.turns) + ' 条' : '待观察'}`;
    root.dataset.level = strong ? 'stop' : remind ? 'remind' : 'quiet';
    byId('state').textContent = stats?.source === 'scan' ? (stats.complete ? '扫描完成 · 已核对返回分支父链' : manual?.status === 'done' ? '接口历史已读完 · 分支关系未验证' : '扫描已读取部分历史 · 尚不完整') : stats ? (stats.source === 'history' ? (stats.complete ? '已读取当前分支快照' : stats.coverage === 'message-page' ? '本页消息统计 · 非完整对话' : '当前分支片段 · 非完整对话') : '当前页面可见内容 · 可能少算') : '尚未取得可测量内容';
    byId('counts').textContent = stats ? `${stats.source === 'scan' ? '扫描已读 ' : stats.source === 'history' && !stats.complete ? (stats.coverage === 'message-page' ? '本页 ' : '片段中 ') : ''}${format(stats.turns)} 条用户消息 · ${format(stats.chars)} 个字符` : '打开已有对话，或正常发送消息后观察。';
    byId('estimate').textContent = stats ? `约 ${format(stats.tokens)} 个文本 token（启发式估算）` : '';
    byId('coverage').textContent = stats?.source === 'scan'
      ? (stats.complete ? '已沿接口提供的父链核对到根，并复查首页未变；只代表这次返回的分支历史。' : '已按消息 ID 去重。消息数组缺少可核对的父链，不能把翻到最早一页当作完整 active branch 的证明。') + ' 扫描结果是当时快照；发送、编辑或切换分支后需重新扫描。不等于模型输入或剩余容量。'
      : stats?.source === 'history'
      ? stats.complete ? '快照包含接口提供的当前分支文本；不等于模型实际输入。未返回的系统内容、内部推理和附件编码无法计量。'
        : (stats.coverage === 'message-page' ? '仅统计本次响应 messages 中的消息，不展开其他版本，不将不同页直接相加。' : '仅统计从当前节点回溯得到的已返回片段。') +
          (stats.requestedTurns != null ? ` 本次请求 num_turns=${stats.requestedTurns}；它是分页参数，不是总对话轮数。` : '') +
          (stats.hasPrevious ? ' 接口标记前面还有历史页。' : '') + ' 尚未证明已覆盖完整 active branch，未出现提醒也不代表对话很短。'
      : '仅统计已呈现在页面上的用户与助手文本；折叠、虚拟滚动、工具结果和附件可能遗漏。历史接口本身也可能分页，刷新不保证取得全部历史。';
    const historyLabels = { pending: '已识别请求，等待响应', branch: '已解析分支快照', partial: '已解析局部历史',
      unsupported: '已收到响应，但结构暂不支持', invalid: '已收到响应，但无法确认可计数片段', unreadable: '已识别请求，但未能读取响应' };
    byId('history').textContent = historyRead
      ? `${historyRead.family === 'plural' ? '复数历史接口' : '旧版历史接口'}${historyRead.page ? ' /messages' : ''}${historyRead.requestedTurns != null ? ` · num_turns=${historyRead.requestedTurns}` : ''}：${historyLabels[historyRead.status]}。`
      : '尚未观察到支持的历史请求；网页缓存或其他传输路径可能不经过此观察器。';
    const scanLabels = { auth: '正在取得本次扫描的登录凭据…', reading: '正在读取历史…', verifying: '已到历史起点，正在复查首页…',
      done: manualStats?.complete ? '完成：已核对返回分支父链。' : '完成：接口历史已读完；分支关系未验证。' };
    const stopLabels = { cancelled: '扫描已取消，保留已读部分。', changed: '对话或分支发生变化，扫描结果已作废，请重新扫描。',
      auth: '登录凭据不可用，请在网站重新确认登录后再试。', forbidden: '网站拒绝了扫描请求（403）。', 'rate-limit': '网站限制了读取频率（429）；已停止，稍后再试。',
      http: '历史接口返回错误，扫描已停止。', network: '网络请求未完成，扫描已停止。', timeout: '读取超时，扫描已停止。',
      budget: '达到本次扫描的页数、字节或时间预算，当前结果不完整。', schema: '接口结构暂不支持，当前结果不完整。',
      cursor: '分页游标未正常推进，已停止以避免重复请求。', conflict: '分页内容或顺序冲突，结果已作废。',
      scope: '响应会话不符，结果已作废。', work: '识别为 Work，已停止扫描，不套用 Chat 规则。' };
    byId('scan-status').textContent = manual ? (manual.status === 'stopped' ? stopLabels[manual.reason] || '扫描已停止。' : scanLabels[manual.status]) +
      ` 已读 ${format(manual.pages)} 页${manualStats ? ' · ' + format(manualStats.messages) + ' 条消息（含双方及工具等）' : ''}` : '仅点击后扫描；按页读取，可随时取消。';
    byId('scan-start').disabled = !!manualController || !C.route(pathname) || currentMode === 'work';
    byId('scan-cancel').hidden = !manualController;
    byId('mode-label').textContent = currentMode === 'work' ? 'Work：不套用 Chat 提醒阈值' : currentMode === 'chat'
      ? (detected === 'chat' ? 'Chat：按来源识别' : 'Chat：手动指定；若识别出 Work 会停用提醒')
      : '模式未确认：请在设置中指定 Chat 后启用规模提醒。';
    byId('server').hidden = !signal;
    byId('server').textContent = signal ? LABELS[signal.kind] : '';
    byId('observed').textContent = signal ? `观测到：${signal.code}。这里只记录收到过的状态，不保证它仍然有效。` : '暂未观测到已知限制信号；这不代表还剩多少容量。';
    byId('reminder-text').textContent = measuredStage < stage ? '本次查看曾达到你设定的提醒点；当前局部读数变小不代表对话容量已恢复。' : stage === 2 ? '对话已经很长，可以先整理接续信息，避免突然无法继续。' : '到了你设定的提醒点，可以开始准备接续信息。';
    notice.hidden = !remind;
    byId('notice-text').textContent = stage === 2 ? '建议准备接续信息' : '到了接续提醒点';
    byId('reminder-box').hidden = !stage || ignored || Date.now() < snoozeUntil;
    byId('preferences-note').textContent = storageFailed ? '设置暂时无法保存，当前页面仍可使用。' : '只在本机保存设置，不保存聊天内容或会话记录。';
    const labels = { user: '用户', assistant: '助手', tool: '工具', reasoning: '返回的思考摘要', system: '返回的上下文/系统', developer: '开发者', other: '其他' };
    byId('breakdown').replaceChildren();
    if (stats) for (const role of C.ROLES) {
      if (!stats.breakdown[role]) continue;
      const item = document.createElement('li');
      item.textContent = `${labels[role]}：约 ${format(stats.breakdown[role])} token`;
      byId('breakdown').appendChild(item);
    }
  }
  function setOpen(value) {
    open = value; panel.hidden = !value; badge.setAttribute('aria-expanded', String(value));
    if (value) byId('close').focus(); else badge.focus();
  }
  function syncForm() {
    for (const key of Object.keys(C.DEFAULTS)) {
      const input = root.querySelector(`[name="${key}"]`);
      if (key === 'enabled') input.checked = config[key]; else input.value = config[key];
    }
  }
  function init() {
    root = document.createElement('section'); root.id = 'cwm-reminder';
    root.setAttribute('aria-label', '接续提醒器');
    root.innerHTML = `
      <div id="cwm-notice" hidden><span id="cwm-notice-text" role="status"></span><button id="cwm-notice-open" type="button">查看</button><button id="cwm-dismiss" type="button" aria-label="收起本级提醒">×</button></div>
      <button id="cwm-badge" type="button" aria-expanded="false" aria-controls="cwm-panel">接续 · 待观察</button>
      <div id="cwm-panel" role="dialog" aria-label="对话规模与接续提醒" hidden>
        <header><strong>接续提醒器</strong><button id="cwm-close" type="button" aria-label="关闭面板">×</button></header>
        <p id="cwm-state"></p><p id="cwm-history" class="cwm-muted"></p><p id="cwm-counts" class="cwm-counts"></p><p id="cwm-estimate"></p>
        <div class="cwm-buttons"><button id="cwm-scan-start" type="button">扫描当前对话</button><button id="cwm-scan-cancel" type="button" hidden>取消扫描</button></div><p id="cwm-scan-status" class="cwm-muted" role="status"></p><p class="cwm-muted">手动扫描会使用当前登录会话，向 ChatGPT 逐页读取历史；正文与临时令牌不保存。</p>
        <p id="cwm-mode-label" class="cwm-muted"></p>
        <div id="cwm-reminder-box" class="cwm-callout" hidden><p id="cwm-reminder-text"></p><div class="cwm-buttons"><button id="cwm-snooze" type="button">30 分钟后提醒</button><button id="cwm-ignore" type="button">本次查看不再提醒</button></div></div>
        <p id="cwm-server" class="cwm-callout" hidden></p><p id="cwm-observed" class="cwm-muted"></p>
        <details><summary>统计范围与局限</summary><p id="cwm-coverage"></p><ul id="cwm-breakdown"></ul><p>没有可靠的官方剩余容量信号，不能预测必然触顶时间。可见历史、模型上下文和会话硬上限不是同一项指标。</p><p>默认被动观察已有 fetch JSON/SSE；手动扫描会主动读取同源登录会话和历史。不观察 WebSocket。页面更新可能使观察失效。</p></details>
        <details><summary>提醒设置</summary><form id="cwm-settings">
          <label class="cwm-check"><input name="enabled" type="checkbox">启用规模提醒</label>
          <label>提醒模式<select name="mode"><option value="auto">自动识别（未知时不提醒）</option><option value="chat">手动指定 Chat</option><option value="work">Work（不评估容量）</option></select></label>
          <div class="cwm-grid"><label>首次：用户消息数<input name="firstTurns" type="number" min="1" max="99999" required></label><label>加强：用户消息数<input name="secondTurns" type="number" min="2" max="100000" required></label><label>首次：字符数<input name="firstChars" type="number" min="1000" max="99999000" step="1000" required></label><label>加强：字符数<input name="secondChars" type="number" min="2000" max="100000000" step="1000" required></label></div>
          <p class="cwm-muted">消息数或字符数任一到达就提醒。默认 50 / 100 条、4万 / 8万字符是可调整的起点，未经触顶样本校准，不是官方上限。手动模式应用于所有页面；明确识别为 Work 时不使用 Chat 阈值。</p>
          <div class="cwm-buttons"><button type="submit">保存设置</button><button id="cwm-reset" type="button">恢复默认</button></div><p id="cwm-form-status" role="status"></p>
        </form></details><p id="cwm-preferences-note" class="cwm-muted"></p>
      </div>`;
    document.body.appendChild(root);
    badge = byId('badge'); panel = byId('panel'); notice = byId('notice');
    byId('scan-start').addEventListener('click', startManual);
    byId('scan-cancel').addEventListener('click', () => manualController?.abort());
    badge.addEventListener('click', () => setOpen(!open));
    byId('close').addEventListener('click', () => setOpen(false));
    byId('notice-open').addEventListener('click', () => setOpen(true));
    byId('dismiss').addEventListener('click', () => { dismissed = highestStage; render(); });
    byId('snooze').addEventListener('click', () => { snoozeUntil = Date.now() + 1800000; render(); });
    byId('ignore').addEventListener('click', () => { ignored = true; render(); });
    // Editing/regeneration/branch controls can change the active branch without a history GET.
    document.addEventListener('click', event => {
      if (!root.contains(event.target) && event.target.closest?.('article button, [data-message-id] button')) {
        network = null; invalidateManual(); scheduleScan();
      }
    }, true);
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && open) setOpen(false); });
    document.addEventListener('click', event => { if (open && !root.contains(event.target)) setOpen(false); });
    byId('settings').addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.currentTarget;
      const next = { enabled: form.elements.enabled.checked, mode: form.elements.mode.value };
      for (const key of ['firstTurns', 'secondTurns', 'firstChars', 'secondChars']) next[key] = Number(form.elements[key].value);
      if (next.secondTurns <= next.firstTurns || next.secondChars <= next.firstChars) {
        byId('form-status').textContent = '加强提醒的阈值需要大于首次提醒。'; return;
      }
      config = C.settings(next); if (config.mode === 'work') invalidateManual('work'); highestStage = 0; dismissed = 0; ignored = false; snoozeUntil = 0;
      await save();
    });
    byId('reset').addEventListener('click', async () => {
      config = C.settings(); highestStage = 0; dismissed = 0; ignored = false; snoozeUntil = 0; syncForm(); await save();
    });
    async function save() {
      try { await chrome.storage.local.set({ cwmSettingsV2: config }); storageFailed = false; }
      catch { storageFailed = true; }
      byId('form-status').textContent = storageFailed ? '未能保存，设置仅在本页面生效。' : '已保存。'; render();
    }
    syncForm(); scan();
    chrome.storage.local.get('cwmSettingsV2').then(value => {
      config = C.settings(value.cwmSettingsV2); syncForm(); render();
    }).catch(() => { storageFailed = true; render(); });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.cwmSettingsV2) {
        const next = C.settings(changes.cwmSettingsV2.newValue);
        if (JSON.stringify(next) !== JSON.stringify(config)) { highestStage = 0; dismissed = 0; ignored = false; snoozeUntil = 0; }
        config = next; if (config.mode === 'work') invalidateManual('work'); syncForm(); render();
      }
    });
    observer = new MutationObserver(mutations => {
      if (mutations.every(m => root.contains(m.target))) return;
      // Changes inside a rendered message can mean streaming/editing, even at equal text length.
      if (manual && mutations.some(m => {
        const target = m.target.nodeType === 1 ? m.target : m.target.parentElement;
        return target?.closest('[data-message-id], [data-message-author-role]') ||
          [...m.addedNodes, ...m.removedNodes].some(n => n.nodeType === 1 &&
            (n.matches('[data-message-id], [data-message-author-role]') || n.querySelector('[data-message-id], [data-message-author-role]')));
      })) invalidateManual();
      scheduleScan();
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ['data-message-id', 'data-message-author-role', 'aria-hidden'] });
    setInterval(() => { if (resetRoute()) scheduleScan(750); else render(); }, 1000);
    window.postMessage({ type: 'CWM_READY_V2' }, location.origin);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
