// 主窗「用量」页：额度趋势（每次刷新积累的余额快照折线）+ AI Token 用量
// （对话/语音逐条记录按天/按模型汇总；文件分析从分析历史聚合）。
// 自挂载组件（mountUsagePage 由 app.js 在渲染后调用）。

import {
  summarizeUsageByDay, summarizeUsageByModel, loadBalanceHistory, listUsage,
} from '../core/usage.js';
import { getAnalysisHistory } from '../core/analysis.js';
import { lineChart, legend, barRows, CHART_COLORS } from './chart.js';
import { escapeHtml } from './format.js';

export function usageView() {
  return '<div class="usage-page" data-role="usage-root"></div>';
}

const fmtInt = (v) => (Number.isFinite(Number(v)) ? String(Math.round(Number(v))) : '—');
const fmtDayShort = (day) => day.slice(5); // 2026-09-19 → 09-19

export function mountUsagePage(el, { repo } = {}) {
  el.innerHTML = `
    <section class="usage-card">
      <div class="usage-card-head">
        <h3>额度趋势</h3>
        <span class="settings-hint">每次刷新数据后记一个点，随使用逐渐积累</span>
      </div>
      <div data-role="balance-chart"></div>
      <div class="chart-legend" data-role="balance-legend"></div>
    </section>
    <section class="usage-card">
      <div class="usage-card-head">
        <h3>AI Token 用量（近 14 天）</h3>
        <span class="settings-hint">对话与语音逐次记录；文件分析计入其完成日</span>
      </div>
      <div data-role="usage-days"></div>
    </section>
    <section class="usage-card">
      <div class="usage-card-head">
        <h3>按模型汇总</h3>
        <span class="settings-hint" data-role="usage-total"></span>
      </div>
      <div data-role="usage-models"></div>
    </section>`;

  const $ = (sel) => el.querySelector(sel);
  const yFmt = (v) => (Number.isFinite(Number(v)) ? String(Math.round(Number(v))) : '—');

  function renderBalanceChart() {
    const history = loadBalanceHistory().filter((h) => h.points.length);
    const box = $('[data-role="balance-chart"]');
    if (!history.length) {
      box.innerHTML = '<p class="settings-hint">还没有趋势数据。点右上角「一键刷新全部」后，这里会开始积累各供应商的余额曲线。</p>';
      $('[data-role="balance-legend"]').innerHTML = '';
      return;
    }
    const series = history
      .map((h, i) => ({
        name: h.name,
        color: CHART_COLORS[i % CHART_COLORS.length],
        points: h.points.map((p) => ({ t: p.t, b: p.b })),
      }));
    box.innerHTML = lineChart(series);
    $('[data-role="balance-legend"]').innerHTML = legend(series);
  }

  async function renderTokenUsage() {
    // 对话+语音逐条记录
    const byDay = summarizeUsageByDay(14);
    const analysis = await getAnalysisHistory().catch(() => []);
    // 文件分析按完成日聚合进当天
    const dayKeyOf = (t) => {
      const d = new Date(t);
      const pad = (x) => String(x).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    };
    for (const h of analysis) {
      const k = dayKeyOf(h.timestamp_ms);
      const row = byDay.find((r) => r.day === k);
      if (row) {
        row.prompt += h.prompt_tokens || 0;
        row.completion += h.completion_tokens || 0;
        row.calls += 1;
      }
    }
    const maxTotal = Math.max(1, ...byDay.map((r) => r.prompt + r.completion));
    const hasData = byDay.some((r) => r.prompt + r.completion > 0);
    $('[data-role="usage-days"]').innerHTML = hasData
      ? barRows(byDay.map((r) => ({
          label: fmtDayShort(r.day),
          value: r.prompt + r.completion,
          max: maxTotal,
          hint: `${r.day}：提问 ${fmtInt(r.prompt)} + 回复 ${fmtInt(r.completion)} tokens，共 ${r.calls} 次`,
        })), { valueFormatter: fmtInt })
      : '<p class="settings-hint">还没有记录。和桌宠聊几句、或跑一次文件分析后这里会出现每日用量条。</p>';
  }

  function renderByModel() {
    const byModel = summarizeUsageByModel();
    const total = byModel.reduce((s, r) => s + r.total, 0);
    $('[data-role="usage-total"]').textContent = total
      ? `累计 ${fmtInt(total)} tokens · ${listUsage().length} 次调用`
      : '';
    $('[data-role="usage-models"]').innerHTML = byModel.length
      ? `<table class="usage-table">
          <thead><tr><th>模型</th><th>供应商</th><th>次数</th><th>提问</th><th>回复</th><th>合计</th></tr></thead>
          <tbody>${byModel.map((r) => `
            <tr>
              <td class="usage-model">${escapeHtml(r.model || '（未知）')}</td>
              <td>${escapeHtml(r.profileName || '—')}</td>
              <td>${fmtInt(r.calls)}</td>
              <td>${fmtInt(r.prompt)}</td>
              <td>${fmtInt(r.completion)}</td>
              <td><b>${fmtInt(r.total)}</b></td>
            </tr>`).join('')}</tbody>
        </table>`
      : '<p class="settings-hint">还没有模型调用记录。</p>';
  }

  function renderAll() {
    renderBalanceChart();
    void renderTokenUsage();
    renderByModel();
  }

  renderAll();
}
