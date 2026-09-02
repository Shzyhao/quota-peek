// 样式化确认弹窗：替代原生 window.confirm，支持危险操作红色样式。
// 返回 Promise<boolean>：确认 true / 取消或点遮罩或按 Esc false。
export function styledConfirm({
  mount,
  title = '确认操作',
  message = '',
  confirmText = '确定',
  cancelText = '取消',
  danger = false,
}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay confirm-overlay';
    overlay.innerHTML = `
      <div class="modal confirm-modal" role="alertdialog" aria-modal="true" aria-label="${title}">
        <h2>${title}</h2>
        <p class="confirm-message"></p>
        <div class="modal-actions">
          <button class="btn" data-action="confirm-cancel"></button>
          <button class="btn ${danger ? 'danger-solid' : 'primary'}" data-action="confirm-accept"></button>
        </div>
      </div>`;

    // message 作为纯文本写入，避免注入
    overlay.querySelector('.confirm-message').textContent = message;
    overlay.querySelector('[data-action="confirm-cancel"]').textContent = cancelText;
    overlay.querySelector('[data-action="confirm-accept"]').textContent = confirmText;

    mount.appendChild(overlay);
    overlay.querySelector('[data-action="confirm-accept"]').focus();

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') finish(false);
      if (e.key === 'Enter') finish(true);
    };
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) finish(false);
      if (e.target.closest('[data-action="confirm-cancel"]')) finish(false);
      if (e.target.closest('[data-action="confirm-accept"]')) finish(true);
    });
  });
}
