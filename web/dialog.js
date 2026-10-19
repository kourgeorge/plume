// Site-styled replacements for the browser's alert / confirm / prompt boxes, so every pop-up looks the same.
// Each returns a promise: alertBox → undefined, confirmBox → true/false, promptBox → the typed text or null.
(() => {
  const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  // Message text may hold line breaks; blank lines start a new paragraph.
  const paragraphs = (text) =>
    String(text ?? '')
      .split(/\n\s*\n/)
      .map((p) => `<p>${escape(p.trim()).replace(/\n/g, '<br>')}</p>`)
      .join('');

  function open({ title, message, ok = 'OK', cancel, danger = false, input }) {
    return new Promise((resolve) => {
      const d = document.createElement('dialog');
      d.className = 'modal modal-small';
      d.setAttribute('aria-labelledby', 'ask-title');
      d.innerHTML = `
        <form method="dialog">
          <div class="modal-head"><h2 id="ask-title">${escape(title)}</h2><button type="button" class="modal-x" data-cancel title="Close" aria-label="Close">×</button></div>
          <div class="modal-body">
            <div class="modal-text">${paragraphs(message)}</div>
            ${input ? `<input class="modal-input" dir="auto" value="${escape(input.value ?? '')}" placeholder="${escape(input.placeholder ?? '')}" autocomplete="off" spellcheck="false">` : ''}
          </div>
          <div class="modal-foot">
            ${cancel ? `<button type="button" class="secondary" data-cancel>${escape(cancel)}</button>` : ''}
            <button type="submit" class="${danger ? 'danger' : ''}" data-ok>${escape(ok)}</button>
          </div>
        </form>`;
      document.body.append(d);
      const field = d.querySelector('.modal-input');
      const okBtn = d.querySelector('[data-ok]');
      // "Type this to confirm" boxes keep the button off until the text matches.
      if (field && input.mustMatch) {
        const check = () => (okBtn.disabled = field.value.trim() !== input.mustMatch);
        field.addEventListener('input', check);
        check();
      }
      let result = cancel ? (input ? null : false) : undefined;
      d.querySelector('form').addEventListener('submit', () => (result = input ? field.value : true));
      for (const b of d.querySelectorAll('[data-cancel]')) b.onclick = () => d.close();
      d.addEventListener('click', (e) => e.target === d && d.close());
      d.addEventListener('close', () => (d.remove(), resolve(result)));
      d.showModal();
      (field || okBtn).focus();
      if (field) field.select();
    });
  }

  window.alertBox = (message, { title = 'Something went wrong' } = {}) => open({ title, message });
  window.confirmBox = (message, { title = 'Are you sure?', ok = 'Continue', cancel = 'Cancel', danger = false } = {}) =>
    open({ title, message, ok, cancel, danger });
  window.promptBox = (message, { title = 'One more thing', value = '', placeholder = '', ok = 'OK', cancel = 'Cancel', mustMatch, danger = false } = {}) =>
    open({ title, message, ok, cancel, danger, input: { value, placeholder, mustMatch } });
})();
