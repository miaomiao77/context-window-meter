/* Shared, dependency-free logic. No network, DOM, or persistence. */
(function (root, factory) {
  const api = Object.freeze(factory());
  if (typeof module === 'object' && module.exports) module.exports = api;
  else Object.defineProperty(root, '__CWM_CORE', { value: api, configurable: true });
})(globalThis, function () {
  'use strict';
  const ROLES = ['user', 'assistant', 'tool', 'reasoning', 'system', 'developer', 'other'];
  const DEFAULTS = Object.freeze({ enabled: true, mode: 'auto', firstTurns: 50, secondTurns: 100,
    firstChars: 40000, secondChars: 80000 });
  const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : null;
  function route(pathname) {
    return id(pathname.match(/(?:^|\/)c\/([^/]+)\/?$/)?.[1]);
  }
  function endpoint(input, base = 'https://chatgpt.com') {
    try {
      const u = new URL(input, base);
      if (u.origin !== 'https://chatgpt.com') return null;
      const p = u.pathname.replace(/\/$/, '');
      if (/^\/backend-api\/(?:f\/)?conversation\/init$/.test(p)) return { type: 'init' };
      if (/^\/backend-api\/(?:f\/)?conversation(?:\/resume)?$/.test(p)) return { type: 'send' };
      const match = p.match(/^\/backend-api\/conversation\/([a-zA-Z0-9_-]+)$/);
      if (match && !['init', 'resume', 'prepare', 'limit'].includes(match[1])) return { type: 'history', id: id(match[1]) };
      return null;
    } catch { return null; }
  }
  function mode(value) {
    if (['work', 'tpp', 'flora'].includes(value)) return 'work';
    if (['chat', 'chatgpt'].includes(value)) return 'chat';
    return 'unknown';
  }
  function text(content) {
    if (!content || typeof content !== 'object') return '';
    const out = [];
    const add = v => { if (typeof v === 'string') out.push(v); };
    // Never stringify attachment descriptors, opaque metadata or asset pointers.
    for (const part of Array.isArray(content.parts) ? content.parts : []) {
      if (typeof part === 'string') add(part);
      else if (part && ['text', 'input_text', 'output_text'].includes(part.content_type || part.type)) add(part.text);
    }
    for (const key of ['text', 'result', 'content', 'summary', 'model_set_context',
      'structured_context', 'repo_summary', 'repository', 'user_instructions', 'user_profile']) add(content[key]);
    for (const thought of Array.isArray(content.thoughts) ? content.thoughts : []) {
      if (typeof thought === 'string') add(thought);
      else if (thought) {
        add(thought.summary); add(thought.content);
        if (Array.isArray(thought.chunks)) for (const chunk of thought.chunks) {
          if (typeof chunk === 'string') add(chunk); else if (chunk) add(chunk.text);
        }
      }
    }
    return out.join('\n');
  }
  function estimateTokens(value) {
    // A multilingual heuristic, NOT a tokenizer or hidden/model-context count.
    let ascii = 0, cjk = 0, other = 0;
    for (const char of value || '') {
      if (char.codePointAt(0) < 128) ascii++;
      else if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(char)) cjk++;
      else other++;
    }
    return Math.ceil(ascii / 4 + cjk * 1.5 + other * 2);
  }
  function messageStats(message) {
    const content = message?.content || {};
    const value = text(content);
    let role = ROLES.includes(message?.author?.role) ? message.author.role : 'other';
    const type = content.content_type;
    if (['thoughts', 'reasoning_recap'].includes(type)) role = 'reasoning';
    if (['model_editable_context', 'user_editable_context'].includes(type)) role = 'system';
    return { role, chars: [...value].length, tokens: estimateTokens(value),
      turn: role === 'user' && !message?.metadata?.is_visually_hidden_from_conversation ? 1 : 0,
      omitted: (Array.isArray(content.parts) ? content.parts : []).some(p => typeof p !== 'string' &&
        !['text', 'input_text', 'output_text'].includes(p?.content_type || p?.type)) || false };
  }
  function aggregate(nodes) {
    const result = { chars: 0, tokens: 0, turns: 0, messages: 0, omitted: false,
      breakdown: Object.fromEntries(ROLES.map(role => [role, 0])) };
    for (const node of nodes) {
      if (!node) continue;
      result.chars += node.chars; result.tokens += node.tokens; result.turns += node.turn;
      result.messages++; result.omitted ||= node.omitted;
      result.breakdown[node.role] += node.tokens;
    }
    return result;
  }
  function snapshot(json) {
    const mapping = json?.mapping;
    if (!mapping || typeof mapping !== 'object' || !id(json.current_node)) return null;
    const nodes = [], activeIds = [], visited = new Set();
    let cursor = json.current_node;
    while (cursor) {
      if (visited.has(cursor) || !Object.hasOwn(mapping, cursor)) return null;
      visited.add(cursor);
      const node = mapping[cursor];
      if (!node || typeof node !== 'object') return null;
      if (node.message) {
        nodes.push(messageStats(node.message));
        if (id(node.message.id)) activeIds.push(node.message.id);
      }
      cursor = node.parent;
      if (cursor != null && !id(cursor)) return null;
    }
    return { ...aggregate(nodes), activeIds, branch: json.current_node,
      mode: mode(json.conversation_origin), source: 'history', complete: true };
  }
  function signal(obj) {
    if (!obj || typeof obj !== 'object') return null;
    const code = obj.error_code || obj.detail?.code || obj.error?.code || obj.detail?.error?.code || obj.code;
    if (code === 'conversation_too_large') return { kind: 'hard', code };
    if (obj.banner_info?.name === 'context-truncation-block') return { kind: 'context', code: 'context-truncation-block' };
    if (['model_cap_exceeded', 'work_usage_limit_exceeded'].includes(code)) return { kind: 'quota', code };
    if (code === 'input_too_large') return { kind: 'input', code };
    if (obj.is_read_only === true) return { kind: 'readonly', code: 'is_read_only' };
    return null;
  }
  function settings(value) {
    const out = { ...DEFAULTS };
    if (!value || typeof value !== 'object') return out;
    if (typeof value.enabled === 'boolean') out.enabled = value.enabled;
    if (['auto', 'chat', 'work'].includes(value.mode)) out.mode = value.mode;
    for (const key of ['firstTurns', 'secondTurns', 'firstChars', 'secondChars']) {
      const min = key.endsWith('Turns') ? 1 : 1000;
      const max = key.endsWith('Turns') ? 100000 : 100000000;
      if (Number.isSafeInteger(value[key]) && value[key] >= min && value[key] <= max) out[key] = value[key];
    }
    out.secondTurns = Math.max(out.firstTurns + 1, out.secondTurns);
    out.secondChars = Math.max(out.firstChars + 1000, out.secondChars);
    return out;
  }
  function effectiveMode(detected, chosen) {
    // Never override an observed Work origin with Chat thresholds.
    if (detected === 'work' || chosen === 'work') return 'work';
    if (chosen === 'chat' || detected === 'chat') return 'chat';
    return 'unknown';
  }
  function level(stats, config, detected) {
    if (!config.enabled || effectiveMode(detected, config.mode) !== 'chat' || !stats) return 0;
    if (stats.turns >= config.secondTurns || stats.chars >= config.secondChars) return 2;
    if (stats.turns >= config.firstTurns || stats.chars >= config.firstChars) return 1;
    return 0;
  }
  function sseParser(emit, overflow = () => {}) {
    let buffer = '', stopped = false;
    return {
      push(chunk) {
        if (stopped) return;
        buffer += chunk;
        let match;
        while ((match = /\r?\n\r?\n/.exec(buffer))) {
          const block = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          if (block.length > 1048576) { stopped = true; overflow(); return; }
          const data = block.split(/\r?\n/).filter(l => l.startsWith('data:'))
            .map(l => l.slice(5).replace(/^ /, '')).join('\n');
          if (!data || data === '[DONE]') continue;
          try { emit(JSON.parse(data)); } catch { /* Ignore malformed event, not the page's stream. */ }
        }
        if (buffer.length > 1048576) { stopped = true; buffer = ''; overflow(); }
      },
      end() { this.push('\n\n'); buffer = ''; }
    };
  }
  return { ROLES, DEFAULTS, id, route, endpoint, mode, text, estimateTokens, messageStats,
    aggregate, snapshot, signal, settings, effectiveMode, level, sseParser };
});
