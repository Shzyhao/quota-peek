// 设置页「Agent 设置」卡：预设提示词 + 技能（skill）导入/删除。
// 配置存 PetConfig（chat_get/save_config），技能文件复制在配置目录 skills/ 下；
// Agent 发起任务时 Rust 端把预设提示词与技能内容注入系统提示。

import {
  getChatConfig, saveChatConfig, agentImportSkill, agentDeleteSkill,
} from '../core/agentConfig.js';
import { escapeHtml } from './format.js';

export function agentSettingsCard() {
  return `
    <section class="settings-card" data-role="agent-settings-card">
      <h3>Agent 设置</h3>
      <p class="settings-hint">桌宠 Agent 的预设要求与技能（markdown 文档）。发起 Agent 任务时自动注入，让 Agent 按你的习惯干活。</p>
      <label class="agent-prompt-label">预设提示词（追加在 Agent 系统提示后，留空不追加）
        <textarea data-role="agent-prompt" rows="3" placeholder="例：回复尽量带步骤；操作文件前先列目录确认…"></textarea>
      </label>
      <div class="chat-form-actions">
        <button class="btn" data-role="agent-prompt-save">保存提示词</button>
      </div>
      <div class="agent-skills">
        <div class="agent-skills-head">
          <b>技能库</b>
          <button class="btn small" data-role="agent-skill-import">＋ 导入技能（.md / .txt）</button>
        </div>
        <div data-role="agent-skill-list"></div>
      </div>
      <p class="settings-hint" data-role="agent-hint"></p>
    </section>`;
}

export function mountAgentSettingsCard(root) {
  const card = root.querySelector('[data-role="agent-settings-card"]');
  if (!card) return;
  let cfg = { agentPrompt: '', skills: [] };

  const $ = (sel) => root.querySelector(sel);

  function showHint(text) {
    const node = $('[data-role="agent-hint"]');
    if (node) node.textContent = text || '';
  }

  function renderSkills() {
    const box = $('[data-role="agent-skill-list"]');
    if (!box) return;
    box.innerHTML = cfg.skills.length
      ? cfg.skills.map((s) => `
        <div class="agent-skill-item">
          <span class="agent-skill-name" title="${escapeHtml(s.path)}">📘 ${escapeHtml(s.name)}</span>
          <button class="btn small danger" data-role="agent-skill-del" data-id="${escapeHtml(s.id)}" data-path="${escapeHtml(s.path)}">删除</button>
        </div>`).join('')
      : '<p class="settings-hint">还没有技能。导入 markdown 文档（如操作手册、常用流程），Agent 会按技能内容行事。</p>';
  }

  async function reload() {
    try {
      const c = await getChatConfig();
      cfg = { agentPrompt: c.agent_prompt || '', skills: c.skills || [] };
    } catch {
      cfg = { agentPrompt: '', skills: [] };
    }
    const ta = $('[data-role="agent-prompt"]');
    if (ta) ta.value = cfg.agentPrompt;
    renderSkills();
  }

  async function persist() {
    await saveChatConfig({
      agent_prompt: cfg.agentPrompt,
      skills: cfg.skills,
    });
  }

  card.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-role]');
    if (!btn) return;
    const role = btn.dataset.role;
    if (role === 'agent-prompt-save') {
      cfg.agentPrompt = $('[data-role="agent-prompt"]').value.trim();
      try {
        await persist();
        showHint('预设提示词已保存，下次 Agent 任务生效');
      } catch (err) {
        showHint(`保存失败：${String(err?.message || err)}`);
      }
    } else if (role === 'agent-skill-import') {
      const selected = await globalThis.__TAURI__?.dialog?.open?.({
        multiple: true,
        title: '选择技能文件（markdown / 文本）',
        filters: [{ name: '技能文档', extensions: ['md', 'markdown', 'txt'] }],
      });
      if (!selected) return;
      const list = Array.isArray(selected) ? selected : [selected];
      let added = 0;
      for (const path of list) {
        try {
          const entry = await agentImportSkill(path);
          if (!cfg.skills.some((s) => s.name === entry.name)) {
            cfg.skills.push(entry);
            added += 1;
          } else {
            void agentDeleteSkill(entry.path).catch(() => {}); // 同名已存在：丢弃重复副本
          }
        } catch (err) {
          showHint(`导入失败：${String(err?.message || err)}`);
        }
      }
      if (added) {
        await persist();
        showHint(`已导入 ${added} 个技能，下次 Agent 任务生效`);
      }
      renderSkills();
    } else if (role === 'agent-skill-del') {
      const id = btn.dataset.id;
      const path = btn.dataset.path;
      cfg.skills = cfg.skills.filter((s) => s.id !== id);
      await persist().catch(() => {});
      void agentDeleteSkill(path).catch(() => {});
      renderSkills();
      showHint('技能已删除');
    }
  });

  void reload();
}
