// 额度供应商密钥的安全存储：桌面版存 Windows 凭据管理器（Rust 命令 quota_secret_*，
// 条目 quota_key:<providerId>，一条存齐 apiKey/apiSecret），本地 localStorage 记录
// 只留 hasSecret 标记；浏览器版无系统凭据可用，保持原有的 localStorage 明文行为。

const tauriCore = () => globalThis.__TAURI__?.core;

export function secretsAvailable() {
  return typeof tauriCore()?.invoke === 'function';
}

async function invoke(cmd, args) {
  const core = tauriCore();
  if (!core?.invoke) throw new Error('仅桌面版支持凭据管理器');
  return core.invoke(cmd, args);
}

// 读取密钥对；未存过返回 null。任何字段缺省归一为空串
export async function readSecret(providerId) {
  const v = await invoke('quota_secret_get', { providerId });
  return v ? { apiKey: String(v.apiKey || ''), apiSecret: String(v.apiSecret || '') } : null;
}

export async function writeSecret(providerId, { apiKey = '', apiSecret = '' } = {}) {
  return invoke('quota_secret_set', { providerId, apiKey, apiSecret });
}

export async function deleteSecret(providerId) {
  return invoke('quota_secret_delete', { providerId });
}

// 存量明文迁移（启动时/备份导入后共用）：把 localStorage 记录里的明文密钥搬进
// 凭据管理器并抹掉本地明文，标记 hasSecret。单条迁移失败保留明文下次重试，
// 整体不阻塞启动。返回迁移条数。
export async function migrateSecretsToKeyring(repo) {
  if (!secretsAvailable()) return 0;
  const providers = repo.listProviders();
  let moved = 0;
  const updated = [];
  for (const p of providers) {
    if (!p.apiKey && !p.apiSecret) {
      updated.push(p);
      continue;
    }
    try {
      await writeSecret(p.id, { apiKey: p.apiKey || '', apiSecret: p.apiSecret || '' });
      updated.push({ ...p, apiKey: '', apiSecret: '', hasSecret: true });
      moved += 1;
    } catch {
      updated.push(p);
    }
  }
  if (moved) repo.saveProviders(updated);
  return moved;
}
