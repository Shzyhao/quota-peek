// 主窗「文件分析」页：选文件/拖拽/桌宠拖入 → 复用轻析管线流式分析 → Markdown 渲染 →
// 快速导出 / 保存 .ai.md / 查看历史。可选分析模型（模型配置页的 供应商×模型）。
// 自挂载组件（同 chatView 模式），模型配置与对话页共享。

import {
  isAnalysisAvailable, analyzeFiles, analyzeCancel,
  getAnalysisHistory, deleteAnalysisHistory, clearAnalysisHistory,
} from '../core/analysis.js';
import { getChatConfig } from '../core/chat.js';
import { listModelChoices, resolveActiveSelection, selectionValue, parseSelectionValue } from '../core/models.js';
import { renderMarkdown } from './markdown.js';
import { escapeHtml } from './format.js';

// 桌宠拖入的待分析文件（pet.js 写入，分析页挂载即消费）
const PENDING_KEY = 'mqc.analysis.pendingFile';

export function analysisView() {
  return '<div class="analysis-page" data-role="analysis-root"></div>';
}

export function mountAnalysisPage(el) {
  if (!isAnalysisAvailable()) {
    el.innerHTML = `
      <div class="empty-state">
        <p>文件分析仅在桌面版（桌看.exe）中可用——文件解析与模型请求由桌面壳完成。</p>
      </div>`;
    return;
  }

  el.innerHTML = `
    <div class="analysis-toolbar">
      <button class="btn primary" data-role="analysis-pick">选择文件</button>
      <label class="setting-toggle analysis-save"><input type="checkbox" data-role="analysis-save">同时保存 .ai.md 到源文件旁</label>
      <input class="analysis-custom" data-role="analysis-custom" placeholder="自定义分析指令（可选，如：提取待办事项）">
      <select data-role="analysis-model" title="分析使用的模型（在「模型配置」页管理）"></select>
      <button class="btn" data-role="analysis-start" disabled>开始分析</button>
      <button class="btn" data-role="analysis-stop" hidden>停止</button>
    </div>
    <div class="analysis-drop" data-role="analysis-drop">
      拖拽文件到这里（或点「选择文件」，也可以直接拖到桌宠上）<br/>
      <small>支持 txt / md / pdf / xlsx / docx / csv / json / 主流代码文件，一次可多个</small>
    </div>
    <div class="analysis-result" data-role="analysis-result" hidden>
      <div class="analysis-result-head">
        <div class="analysis-status" data-role="analysis-status"></div>
        <button class="btn" data-role="analysis-export" title="把当前分析结果导出为 Markdown 文件" disabled>⬇ 导出结果</button>
      </div>
      <div class="analysis-md" data-role="analysis-md"></div>
    </div>
    <div class="analysis-history">
      <div class="analysis-history-head">
        <h3>分析历史</h3>
        <button class="btn danger" data-role="analysis-clear">清空历史</button>
      </div>
      <div data-role="analysis-history-list"></div>
    </div>`;

  const $ = (sel) => el.querySelector(sel);

  let picked = [];        // 已选绝对路径
  let running = false;
  let currentText = '';   // 当前流式累积文本
  let openHistoryId = null;
  // 分析模型（profileId||model 选择值）；loadModels 异步填充
  let modelChoices = [];

  // ——— 模型下拉 ———

  async function loadModels() {
    try {
      const cfg = await getChatConfig();
      modelChoices = listModelChoices(cfg.profiles || []);
      const sel = $('[data-role="analysis-model"]');
      if (!sel) return;
      if (!modelChoices.length) {
        sel.innerHTML = '<option value="">（未配置模型）</option>';
        return;
      }
      const active = resolveActiveSelection(cfg);
      const activeVal = selectionValue(active.profileId, active.model);
      sel.innerHTML = modelChoices
        .map((c) => `<option value="${escapeHtml(selectionValue(c.profileId, c.model))}" ${selectionValue(c.profileId, c.model) === activeVal ? 'selected' : ''}>${escapeHtml(c.label)}</option>`)
        .join('');
    } catch {
      /* 配置读取失败保持空下拉 */
    }
  }

  // ——— 文件选择 ———

  async function pickFiles() {
    const selected = await globalThis.__TAURI__?.dialog?.open?.({
      multiple: true,
      title: '选择要分析的文件',
    });
    if (!selected) return;
    const list = Array.isArray(selected) ? selected : [selected];
    picked = [...new Set([...picked, ...list])];
    refreshDropZone();
  }

  function refreshDropZone() {
    const drop = $('[data-role="analysis-drop"]');
    drop.classList.toggle('has-files', picked.length > 0);
    drop.innerHTML = picked.length
      ? `已选 ${picked.length} 个文件：<br/><small>${picked.map(escapeHtml).join('<br/>')}</small>`
      : '拖拽文件到这里（或点「选择文件」，也可以直接拖到桌宠上）<br/><small>支持 txt / md / pdf / xlsx / docx / csv / json / 主流代码文件，一次可多个</small>';
    $('[data-role="analysis-start"]').disabled = running || !picked.length;
  }

  // ——— 拖拽（Tauri 拦截系统拖放转发事件，提供绝对路径；HTML5 drop 不会触发） ———

  const webview = globalThis.__TAURI__?.webview?.getCurrentWebview?.();
  let unlistenDrag = null;
  if (webview?.onDragDropEvent) {
    void webview.onDragDropEvent((ev) => {
      const p = ev?.payload;
      if (!p) return;
      if (p.type === 'over') {
        $('[data-role="analysis-drop"]').classList.add('drag-over');
      } else if (p.type === 'leave') {
        $('[data-role="analysis-drop"]').classList.remove('drag-over');
      } else if (p.type === 'drop' && !running) {
        $('[data-role="analysis-drop"]').classList.remove('drag-over');
        picked = [...new Set([...picked, ...(p.paths || [])])];
        refreshDropZone();
      }
    }).then((fn) => { unlistenDrag = fn; });
  }

  // ——— 分析 ———

  function setStatus(text) {
    $('[data-role="analysis-status"]').textContent = text;
  }

  function appendStatusLine(text) {
    const box = $('[data-role="analysis-status"]');
    box.innerHTML += `${escapeHtml(text)}<br/>`;
  }

  function setRunning(on) {
    running = on;
    $('[data-role="analysis-start"]').hidden = on;
    $('[data-role="analysis-stop"]').hidden = !on;
    $('[data-role="analysis-pick"]').disabled = on;
    refreshDropZone();
  }

  // 桌宠拖入：消费待分析文件标记，自动开始分析
  function consumePending() {
    try {
      const raw = localStorage.getItem(PENDING_KEY);
      if (!raw) return;
      localStorage.removeItem(PENDING_KEY);
      const paths = JSON.parse(raw);
      if (Array.isArray(paths) && paths.length && !running) {
        picked = [...new Set([...picked, ...paths])];
        refreshDropZone();
        void start();
      }
    } catch {
      localStorage.removeItem(PENDING_KEY);
    }
  }

  async function start() {
    if (running || !picked.length) return;
    const save = $('[data-role="analysis-save"]').checked;
    const custom = $('[data-role="analysis-custom"]').value.trim();
    const modelSel = $('[data-role="analysis-model"]');
    const { profileId, model } = parseSelectionValue(modelSel?.value || '');
    const paths = [...picked];
    picked = [];
    currentText = '';
    $('[data-role="analysis-result"]').hidden = false;
    $('[data-role="analysis-md"]').innerHTML = '';
    $('[data-role="analysis-status"]').innerHTML = '';
    $('[data-role="analysis-export"]').disabled = true;
    setRunning(true);
    let doneFiles = 0;
    let lastRender = 0;

    await analyzeFiles(paths, {
      save, custom, profileId, model,
      onEvent: (ev) => {
        const { type, data } = ev || {};
        if (type === 'Started') {
          setStatus(`开始分析 ${data?.total ?? paths.length} 个文件…`);
        } else if (type === 'Parsing') {
          setStatus(`解析中（${(data?.index ?? 0) + 1}）：${data?.file ?? ''}`);
        } else if (type === 'Tokens') {
          currentText += data?.text ?? '';
          $('[data-role="analysis-export"]').disabled = !currentText.trim();
          // 节流渲染：流式 token 很密，每 120ms 重排一次 markdown
          const now = performance.now();
          if (now - lastRender > 120) {
            lastRender = now;
            $('[data-role="analysis-md"]').innerHTML = renderMarkdown(currentText);
            $('[data-role="analysis-md"]').scrollTop = 1e9;
          }
        } else if (type === 'FileDone') {
          doneFiles += 1;
          const out = data?.output_path ? `，已保存 ${data.output_path}` : '';
          appendStatusLine(`✓ ${data?.file ?? doneFiles} 完成${out}`);
        } else if (type === 'Error') {
          appendStatusLine(`✗ ${data?.file ? data.file + '：' : ''}${data?.message ?? '失败'}`);
        } else if (type === 'Done') {
          appendStatusLine(`全部完成：${data?.summary ?? ''}`);
        } else if (type === 'Cancelled') {
          appendStatusLine('已取消');
        }
      },
    }).catch((e) => appendStatusLine(`✗ ${e.message}`));
    $('[data-role="analysis-md"]').innerHTML = renderMarkdown(currentText);
    $('[data-role="analysis-export"]').disabled = !currentText.trim();
    setRunning(false);
    void loadHistoryList();
  }

  // ——— 快速导出（当前结果 → 另存 .md 文件） ———

  async function exportResult() {
    if (!currentText.trim()) return;
    const pad = (x) => String(x).padStart(2, '0');
    const d = new Date();
    const suggested = `分析结果-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}.md`;
    const path = await globalThis.__TAURI__?.dialog?.save?.({
      title: '导出分析结果',
      defaultPath: suggested,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (!path) return;
    try {
      await globalThis.__TAURI__.core.invoke('save_text_file', { path, content: currentText });
      appendStatusLine(`✓ 已导出：${path}`);
    } catch (e) {
      appendStatusLine(`✗ 导出失败：${String(e?.message || e)}`);
    }
  }

  // ——— 历史 ———

  function fmtTime(ms) {
    return ms ? new Date(ms).toLocaleString('zh-CN') : '';
  }

  async function loadHistoryList() {
    const list = await getAnalysisHistory().catch(() => []);
    const box = $('[data-role="analysis-history-list"]');
    box.innerHTML = list.length
      ? list.map((h) => `
        <div class="analysis-history-item">
          <div class="analysis-history-row" data-role="history-toggle" data-id="${escapeHtml(h.id)}">
            <span class="analysis-history-name" title="${escapeHtml(h.source_file)}">${escapeHtml(h.source_file.split(/[\\/]/).pop() || h.source_file)}</span>
            <span class="analysis-history-meta">${fmtTime(h.timestamp_ms)} · ${h.prompt_tokens + h.completion_tokens} tokens${h.output_files?.length ? ' · 已导出' : ''}</span>
            <button class="btn danger" data-role="history-del" data-id="${escapeHtml(h.id)}">删除</button>
          </div>
          ${openHistoryId === h.id ? `<div class="analysis-history-md">${renderMarkdown(h.analysis)}</div>` : ''}
        </div>`).join('')
      : '<p class="settings-hint">暂无分析历史。</p>';
  }

  // ——— 事件 ———

  el.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-role]');
    if (!btn) return;
    const role = btn.dataset.role;
    if (role === 'analysis-pick') {
      await pickFiles();
    } else if (role === 'analysis-start') {
      void start();
    } else if (role === 'analysis-export') {
      await exportResult();
    } else if (role === 'analysis-stop') {
      await analyzeCancel().catch(() => {});
    } else if (role === 'history-toggle') {
      openHistoryId = openHistoryId === btn.dataset.id ? null : btn.dataset.id;
      void loadHistoryList();
    } else if (role === 'history-del') {
      await deleteAnalysisHistory(btn.dataset.id).catch(() => {});
      void loadHistoryList();
    } else if (role === 'analysis-clear') {
      await clearAnalysisHistory().catch(() => {});
      openHistoryId = null;
      void loadHistoryList();
    }
  });

  // 组件卸载时解绑拖拽监听（主窗视图切换会重挂载）
  const observer = new MutationObserver(() => {
    if (!el.isConnected && unlistenDrag) {
      unlistenDrag();
      observer.disconnect();
    }
  });
  observer.observe(el.parentElement || document.body, { childList: true, subtree: true });

  refreshDropZone();
  void loadModels();
  void loadHistoryList();
  // 桌宠拖入的待分析文件：挂载即消费（面板窗每次打开都会重新挂载）
  void consumePending();
}
