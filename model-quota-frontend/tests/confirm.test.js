import { describe, it, expect, afterEach } from 'vitest';
import { styledConfirm } from '../src/ui/confirm.js';

afterEach(() => {
  document.body.innerHTML = '';
});

function open(props = {}) {
  return styledConfirm({
    mount: document.body,
    title: '删除供应商',
    message: '确定删除「测试」吗？',
    confirmText: '删除',
    danger: true,
    ...props,
  });
}

describe('styledConfirm 样式化确认弹窗', () => {
  it('打开弹窗：标题、文案与按钮为纯文本渲染', async () => {
    const p = open({ message: '<img src=x onerror=alert(1)>注入尝试' });
    const modal = document.querySelector('.confirm-modal');

    expect(modal).toBeTruthy();
    expect(modal.querySelector('h2').textContent).toBe('删除供应商');
    expect(modal.querySelector('.confirm-message').innerHTML).not.toContain('<img');
    expect(modal.querySelector('.confirm-message').textContent).toContain('注入尝试');
    expect(modal.querySelector('[data-action="confirm-accept"]').textContent).toBe('删除');

    modal.querySelector('[data-action="confirm-cancel"]').click();
    expect(await p).toBe(false);
  });

  it('点击确认按钮 → resolve(true) 且弹窗移除', async () => {
    const p = open();
    document.querySelector('[data-action="confirm-accept"]').click();

    expect(await p).toBe(true);
    expect(document.querySelector('.confirm-overlay')).toBeNull();
  });

  it('点击取消按钮 / 遮罩 → resolve(false)', async () => {
    const p1 = open();
    document.querySelector('[data-action="confirm-cancel"]').click();
    expect(await p1).toBe(false);

    const p2 = open();
    document.querySelector('.confirm-overlay').dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    expect(await p2).toBe(false);
  });

  it('按 Esc → resolve(false)', async () => {
    const p = open();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(await p).toBe(false);
  });

  it('危险操作使用红色实心确认按钮', () => {
    open({ danger: true });
    expect(document.querySelector('[data-action="confirm-accept"]').className).toContain('danger-solid');

    document.querySelector('[data-action="confirm-cancel"]').click();
  });
});
