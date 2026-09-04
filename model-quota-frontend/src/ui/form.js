import { getProviderType } from '../core/providers.js';
import { maskApiKey } from '../core/mask.js';
import { escapeHtml } from './format.js';

// 类型默认名（label 去掉括号说明）：如「DeepSeek（API 余额）」→「DeepSeek」
function defaultNameOf(typeDef) {
  return typeDef.label.replace(/（[^）]*）/g, '').trim();
}

// 名称查重：与现有供应商重名时自动追加 _2、_3… 直到不冲突
function uniqueName(base, existingNames) {
  if (!existingNames.includes(base)) return base;
  let n = 2;
  while (existingNames.includes(`${base}_${n}`)) n += 1;
  return `${base}_${n}`;
}

// 添加 / 编辑供应商弹窗。
// 安全约定：编辑时 API Key 输入框留空表示沿用原密钥，界面从不回显明文密钥。
// existingNames：现有供应商名称列表（编辑时不含自身），用于默认名查重。
// testConnection({ type, apiKey, apiSecret, baseUrl })：注入的连通性测试（桌面复用查询适配器，不入库不写日志）。
export function openProviderForm({ mount, providerTypes, existing, onSave, existingNames = [], testConnection }) {
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
    <div class="modal form-modal" role="dialog" aria-modal="true">
      <h2>${isEdit ? '编辑供应商' : '添加供应商'}</h2>
      <div class="form-grid">
        <label>供应商名称 *<input name="name" placeholder="例如：DeepSeek 主账号" value="${escapeHtml(existing ? existing.name : '')}"></label>
        <label>供应商类型
          <select name="type">${typeOptions}</select>
        </label>
        <label class="full"><span data-role="api-label">API Key</span>
          <input name="apiKey" type="password" autocomplete="off" placeholder="${
            isEdit ? `${maskApiKey(existing.apiKey)}（留空表示不修改）` : '仅保存在本地，界面与日志中均脱敏'
          }">
        </label>
        <label class="full" data-role="secret-field" hidden><span data-role="secret-label">Secret Access Key</span>
          <input name="apiSecret" type="password" autocomplete="off" placeholder="${
            isEdit && existing.apiSecret ? `${maskApiKey(existing.apiSecret)}（留空表示不修改）` : '与 AccessKey ID 配套的私有密钥'
          }">
        </label>
        <label class="full" data-role="url-row">
          Base URL
          <span class="url-row" data-role="url-row-inner">
            <input name="baseUrl" placeholder="留空使用官方默认地址">
            <button type="button" class="btn small" data-action="test" data-role="test-btn">测试链接</button>
          </span>
          <span class="test-result" data-role="test-result" hidden></span>
        </label>
      </div>
      <p class="form-divider">额度信息 <i>（可选 · 不支持自动查询的供应商手动维护）</i></p>
      <div class="form-grid">
        <label>套餐总额度<input name="planTotalQuota" type="number" step="any" min="0" placeholder="手动填写" value="${num(existing?.planTotalQuota)}"></label>
        <label>已用额度<input name="usedQuota" type="number" step="any" min="0" placeholder="手动填写" value="${num(existing?.usedQuota)}"></label>
        <label>剩余额度<input name="remainingQuota" type="number" step="any" min="0" placeholder="留空按 总额度 − 已用 计算" value="${num(existing?.remainingQuota)}"></label>
        <label>到期时间<input name="expiryDate" type="date" value="${existing ? existing.expiryDate || '' : ''}"></label>
        <label class="full">备注<input name="note" placeholder="可选" value="${escapeHtml(existing ? existing.note || '' : '')}"></label>
        <label class="checkbox full"><input name="enabled" type="checkbox" ${!existing || existing.enabled !== false ? 'checked' : ''}> 启用（停用后不参与一键与定时刷新）</label>
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
  const nameInput = $('name');
  const secretField = overlay.querySelector('[data-role="secret-field"]');
  const apiLabel = overlay.querySelector('[data-role="api-label"]');
  const testBtn = overlay.querySelector('[data-role="test-btn"]');
  const testResult = overlay.querySelector('[data-role="test-result"]');

  baseUrlInput.value = existing && existing.baseUrl ? existing.baseUrl : getProviderType(typeSelect.value).defaultBaseUrl;

  // 当前密钥取值：输入框有值用输入值；编辑时留空表示沿用已存密钥（测试与保存同规则）
  function effectiveSecrets() {
    const apiKey = $('apiKey').value.trim() || (isEdit ? existing.apiKey || '' : '');
    const apiSecret = $('apiSecret').value.trim() || (isEdit ? existing.apiSecret || '' : '');
    return { apiKey, apiSecret };
  }

  // 按类型切换凭证字段：双凭证类型（如火山方舟 IAM）显示 Secret Access Key 输入
  function syncCredentialFields() {
    const t = getProviderType(typeSelect.value);
    apiLabel.textContent = t.credentialLabel || 'API Key';
    secretField.hidden = !t.needsSecret;
  }
  syncCredentialFields();

  // 切换类型时：Base URL 还是默认值/空则跟随新类型；名称为空或仍是某类型默认名则带出新类型默认名
  typeSelect.addEventListener('change', () => {
    const t = getProviderType(typeSelect.value);
    const current = baseUrlInput.value.trim();
    const isDefault = current === '' || providerTypes.some((p) => p.defaultBaseUrl === current);
    if (isDefault) baseUrlInput.value = t.defaultBaseUrl;

    const allDefaults = providerTypes.map((p) => defaultNameOf(p));
    if (nameInput.value.trim() === '' || allDefaults.includes(nameInput.value.trim())) {
      nameInput.value = defaultNameOf(t);
    }
    syncCredentialFields();
  });

  // ——— 测试链接：直接调用该类型的查询适配器，不入库、不写日志 ———
  let testing = false;
  testBtn.addEventListener('click', async () => {
    const type = getProviderType(typeSelect.value);
    if (!type.autoQuery) {
      testResult.hidden = false;
      testResult.className = 'test-result warn';
      testResult.textContent = '该类型不支持自动查询，无法测试';
      return;
    }
    if (testing) return;
    const { apiKey, apiSecret } = effectiveSecrets();
    if (!apiKey || (type.needsSecret && !apiSecret)) {
      testResult.hidden = false;
      testResult.className = 'test-result warn';
      testResult.textContent = type.needsSecret ? '请先填写 AccessKey ID 和 Secret Access Key' : '请先填写 API Key';
      return;
    }
    testing = true;
    testBtn.disabled = true;
    testBtn.textContent = '测试中…';
    testResult.hidden = true;
    try {
      if (!testConnection) throw new Error('当前环境不支持测试');
      const result = await testConnection({
        type: type.type,
        apiKey,
        apiSecret,
        baseUrl: baseUrlInput.value.trim() || type.defaultBaseUrl,
      });
      testResult.hidden = false;
      testResult.className = 'test-result ok';
      testResult.textContent = `✓ 连接成功${result.balance != null ? `：余额 ${result.balance}${result.currency ? ` ${result.currency}` : ''}` : result.usage ? '：套餐用量已获取' : ''}`;
    } catch (err) {
      testResult.hidden = false;
      testResult.className = 'test-result fail';
      testResult.textContent = `✗ ${err?.message || String(err)}`;
    } finally {
      testing = false;
      testBtn.disabled = false;
      testBtn.textContent = '测试链接';
    }
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
      name: nameInput.value.trim(),
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
    // 重名兜底：手动改名撞上现有名称时自动加 _N 后缀（编辑时排除自身）
    const others = existingNames.filter((n) => !(isEdit && n === existing.name));
    if (others.includes(data.name)) {
      data.name = uniqueName(data.name, others);
      nameInput.value = data.name;
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
