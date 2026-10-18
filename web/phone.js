// Phone approvals (Telegram) on the Settings page. Uses $, esc, api, post and when from app.js (loaded first).
// app.js calls window.plumePhone.settings() from loadSettings once the Telegram card is on the page.
(() => {
  // The Telegram card itself is built by app.js (integrationCard); this fills its #tg-link step.
  async function settings() {
    if ($('tg-link')) await linkCard();
  }

  async function linkCard() {
    const card = $('tg-link');
    if (!card) return;
    const t = await api('/api/telegram').catch((err) => ({ error: err.message }));
    if (t.error) return (card.innerHTML = `<span class="warn small">${esc(t.error)}</span>`);
    if (!t.connected) {
      card.innerHTML = '<div class="sub-head"><strong>Link your chat</strong><span class="muted small">Save a bot token first</span></div>';
      return;
    }
    if (t.problem) {
      card.innerHTML = `<div class="sub-head"><strong>Link your chat</strong><span class="warn small">${esc(t.problem)}</span></div>`;
      return;
    }
    if (t.linked) {
      card.innerHTML = `<div class="sub-head"><strong>Linked</strong><span class="good small">${esc(t.name ?? 'your chat')} · since ${esc(when(t.linkedAt))}</span></div>
        <p class="muted small">New drafts go to @${esc(t.bot)} as they're written. Tap Approve or Not useful, or reply to a draft with new text. Send /report for the last 7 days; a report also arrives on Monday mornings.</p>
        <p class="actions-row"><button id="tg-test" class="secondary">Send a report now</button> <button id="tg-unlink" class="secondary">Unlink</button> <span id="tg-msg" class="small"></span></p>`;
      $('tg-test').onclick = async () => {
        $('tg-msg').className = 'small muted';
        $('tg-msg').textContent = 'Sending…';
        try {
          const r = await post('/api/telegram/test');
          $('tg-msg').className = 'small good';
          $('tg-msg').textContent = `Sent${r.sent ? `, plus ${r.sent} waiting draft(s)` : ''}. Check Telegram.`;
        } catch (err) {
          $('tg-msg').className = 'small warn';
          $('tg-msg').textContent = err.message;
        }
      };
      $('tg-unlink').onclick = async () => {
        if (!confirm('Unlink this chat? Drafts stop arriving until you link again.')) return;
        await post('/api/telegram/unlink');
        linkCard();
      };
      return;
    }
    const cmd = `/start ${t.code}`;
    card.innerHTML = `<div class="sub-head"><strong>Link your chat</strong><span class="muted small">Not linked yet</span></div>
      <ol class="small">
        <li>Open <a href="https://t.me/${encodeURIComponent(t.bot)}?start=${encodeURIComponent(t.code)}" target="_blank" rel="noopener">@${esc(t.bot)}</a> in Telegram${' '}(the link fills in the code), or send it this message:</li>
        <li><code id="tg-code">${esc(cmd)}</code> <button id="tg-copy" class="secondary">Copy</button></li>
        <li>This page shows "Linked" within a few seconds. Only that chat can approve anything.</li>
      </ol>`;
    $('tg-copy').onclick = () => navigator.clipboard?.writeText(cmd).then(() => ($('tg-copy').textContent = 'Copied'));
    // Watch for the link while the page is open.
    setTimeout(() => !$('view-settings').hidden && $('tg-link') && linkCard(), 4000);
  }

  window.plumePhone = { settings };
})();
