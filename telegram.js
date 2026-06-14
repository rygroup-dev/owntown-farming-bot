// ============ TELEGRAM INTEGRATION (zero-dependency) ============
// Push notifications + remote command polling via the Telegram Bot API.
const https = require('https');

function tgApi(token, method, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/${method}`,
      method: 'POST',
      headers,
      timeout: 65000,
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ ok: false, raw: d }); } });
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    if (data) req.write(data);
    req.end();
  });
}

class Telegram {
  constructor({ token, chatId, logger, onChatIdLearned }) {
    this.token = token;
    this.chatId = chatId || '';
    this.log = logger || (() => {});
    this.onChatIdLearned = onChatIdLearned || (() => {});
    this.handlers = {};        // command -> fn(args, chatId)
    this.offset = 0;
    this.queue = [];
    this.sending = false;
    this.enabled = !!token;
  }

  on(command, fn) { this.handlers[command] = fn; }

  async send(text) {
    if (!this.enabled || !this.chatId) return;
    this.queue.push(text);
    this._drain();
  }

  async _drain() {
    if (this.sending) return;
    this.sending = true;
    while (this.queue.length) {
      const text = this.queue.shift();
      const res = await tgApi(this.token, 'sendMessage', {
        chat_id: this.chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
      if (!res.ok) this.log(`📱 Telegram send failed: ${res.description || res.error || 'unknown'}`);
      await new Promise(r => setTimeout(r, 400)); // gentle rate-limit
    }
    this.sending = false;
  }

  async startPolling() {
    if (!this.enabled) return;
    const me = await tgApi(this.token, 'getMe', null);
    if (me.ok) this.log(`📱 Telegram connected as @${me.result.username}`);
    else { this.log(`📱 Telegram token invalid: ${me.description || me.error}`); this.enabled = false; return; }
    this._poll();
  }

  async _poll() {
    if (!this.enabled) return;
    const res = await tgApi(this.token, 'getUpdates', { offset: this.offset, timeout: 50 });
    if (res.ok && Array.isArray(res.result)) {
      for (const upd of res.result) {
        this.offset = upd.update_id + 1;
        const msg = upd.message || upd.edited_message;
        if (!msg || !msg.text) continue;
        const fromChat = String(msg.chat.id);

        // Auto-learn chat id on first contact if not configured
        if (!this.chatId) {
          this.chatId = fromChat;
          this.log(`📱 Learned Telegram chat id: ${fromChat}`);
          this.onChatIdLearned(fromChat);
          this.send('✅ Linked! This chat will now receive bot notifications.');
        }
        // Only obey the authorized chat
        if (fromChat !== String(this.chatId)) continue;

        const text = msg.text.trim();
        if (!text.startsWith('/')) continue;
        const [cmdRaw, ...args] = text.slice(1).split(/\s+/);
        const cmd = cmdRaw.split('@')[0].toLowerCase();
        const handler = this.handlers[cmd];
        if (handler) {
          try { await handler(args, fromChat); }
          catch (e) { this.send(`⚠️ Command error: ${e.message}`); }
        } else {
          this.send(`Unknown command: /${cmd}\nTry /help`);
        }
      }
    }
    setImmediate(() => this._poll());
  }
}

module.exports = { Telegram };
