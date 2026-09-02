import { getProviderType } from '../core/providers.js';
import { maskApiKey } from '../core/mask.js';
import { escapeHtml } from './format.js';

// 添加 / 编辑供应商弹窗。
// 安全约定：编辑时 API Key 输入框留空表示沿用原密钥，界面从不回显明文密钥。
export function openProviderForm({ mount, providerTypes, existing, onSave }) {
  const isEdit = Boolean(existing);
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  const typeOptions = providerTypes
    .map(
      (t) =>
        `<option value="${t.type}" ${existing && existing.type === t.type ? 'selected' : ''}>${t.label}（${
          t.autoQuery ? '支持自动查询' : '不支持自动查询'
        }）</option>`,
    )
    .join('');

  const num = (v) => (existing && v != null ? v : '');

  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <h2>${isEdit ? '编辑供应商' : '添加供应商'}</h2>
      <div class="form-grid">
        <label>供应商名称 *<input name="name" placeholder="例如：DeepSeek 主账号" value="${escapeHtml(existing ? existing.name : '')}"></label>
        <label>供应商类型
          <select name="type">${typeOptions}</select>
        </label>
        <label><span data-role="api-label">API Key</span>
          <input name="apiKey" type="password" autocomplete="off" placeholder="${
            isEdit ? `${maskApiKey(existing.apiKey)}（留空表示不修改）` : '仅保存在本地浏览器，界面与日志中均脱敏'
          }">
        </label>
        <label data-role="secret-field" hidden><span data-role="secret-label">Secret Access Key</span>
          <input name="apiSecret" type="password" autocomplete="off" placeholder="${
            isEdit && existing.apiSecret ? `${maskApiKey(existing.apiSecret)}（留空表示不修改）` : '与 AccessKey ID 配套的私有密钥'
          }">
        </label>
        <label>Base URL<input name="baseUrl" placeholder="留空使用官方默认地址"></label>
        <label>套餐总额度<input name="planTotalQuota" type="number" step="any" min="0" placeholder="手动填写" value="${num(existing?.planTotalQuota)}"></label>
        <label>已用额度<input name="usedQuota" type="number" step="any" min="0" placeholder="手动填写" value="${num(existing?.usedQuota)}"></label>
        <label>剩余额度<input name="remainingQuota" type="number" step="any" min="0" placeholder="留空时按 总额度 − 已用 自动计算" value="${num(existing?.remainingQuota)}"></label>
        <label>到期时间<input name="expiryDate" type="date" value="${existing ? existing.expiryDate || '' : ''}"></label>
        <label class="full">备注<input name="note" placeholder="可选" value="${escapeHtml(existing ? existing.note || '' : '')}"></label>
        <label class="checkbox"><input name="enabled" type="checkbox" ${!existing || existing.enabled !== false ? 'checked' : ''}> 启用（停用后不参与一键与定时刷新）</label>
      </div>
      <p class="form-error" data-error hidden></p>
      <div class="modal-actions">
        <button class="btn" data-action="cancel">取消</button>
        <button class="btn primary" data-action="save">保存</button>
      </div>
    </div>`;

  mount.appendChild(overlay);

  const $ = (name) => overlay.querySelector(`[name="${name}"]`);
  const errorEl = overlay.querySelector('[data-error]');
  const typeSelect = $('type');
  const baseUrlInput = $('baseUrl');
  const secretField = overlay.querySelector('[data-role="secret-field"]');
  const apiLabel = overlay.querySelector('[data-role="api-label"]');

  baseUrlInput.value = existing && existing.baseUrl ? existing.baseUrl : getProviderType(typeSelect.value).defaultBaseUrl;

  // 按类型切换凭证字段：双凭证类型（如火山方舟 IAM）显示 Secret Access Key 输入
  function syncCredentialFields() {
    const t = getProviderType(typeSelect.value);
    apiLabel.textContent = t.credentialLabel || 'API Key';
    secretField.hidden = !t.needsSecret;
  }
  syncCredentialFields();

  // 切换类型时，若 Base URL 还是默认值/空，则跟随切换到新类型的默认地址
  typeSelect.addEventListener('change', () => {
    const current = baseUrlInput.value.trim();
    const isDefault = current === '' || providerTypes.some((t) => t.defaultBaseUrl === current);
    if (isDefault) baseUrlInput.value = getProviderType(typeSelect.value).defaultBaseUrl;
    syncCredentialFields();
  });

  function close() {
    overlay.remove();
  }

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.hidden = false;
  }

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  overlay.querySelector('[data-action="cancel"]').addEventListener('click', close);

  overlay.querySelector('[data-action="save"]').addEventListener('click', () => {
    errorEl.hidden = true;
    const data = {
      id: existing ? existing.id : undefined,
      name: $('name').value.trim(),
      type: typeSelect.value,
      apiKey: $('apiKey').value.trim(),
      apiSecret: $('apiSecret').value.trim(),
      baseUrl: baseUrlInput.value.trim(),
      planTotalQuota: $('planTotalQuota').value,
      usedQuota: $('usedQuota').value,
      remainingQuota: $('remainingQuota').value,
      expiryDate: $('expiryDate').value,
      note: $('note').value,
      enabled: $('enabled').checked,
    };

    if (!data.name) {
      showError('请填写供应商名称');
      return;
    }
    const type = getProviderType(data.type);
    const keyMissing = !data.apiKey && !(isEdit && existing.apiKey);
    const secretMissing = type.needsSecret && !data.apiSecret && !(isEdit && existing.apiSecret);
    if (type.autoQuery && (keyMissing || secretMissing)) {
      showError(type.needsSecret ? '该类型需要填写 AccessKey ID 和 Secret Access Key（IAM 访问密钥）' : '该类型支持自动查询，需要填写 API Key');
      return;
    }

    onSave(data);
    close();
  });
}
