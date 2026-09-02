import { describe, it, expect } from 'vitest';
import { maskApiKey, sanitizeText } from '../src/core/mask.js';

describe('maskApiKey', () => {
  it('空值返回空字符串', () => {
    expect(maskApiKey('')).toBe('');
    expect(maskApiKey(null)).toBe('');
    expect(maskApiKey(undefined)).toBe('');
  });

  it('短 key 整体打码，不保留任何明文片段', () => {
    expect(maskApiKey('sk-1234')).toBe('••••••');
    expect(maskApiKey('sk-1234')).not.toContain('1234');
  });

  it('长 key 仅保留首尾各 4 位', () => {
    const masked = maskApiKey('sk-abcdef1234567890');
    expect(masked).toBe('sk-a••••••7890');
    expect(masked).not.toContain('abcdef');
    expect(masked).not.toContain('1234567890');
  });
});

describe('sanitizeText', () => {
  it('从错误信息中移除完整 API Key', () => {
    const key = 'sk-abcdefgh12345678';
    const out = sanitizeText(`请求失败，key=${key}，请检查`, [key]);
    expect(out).not.toContain(key);
    expect(out).toContain('***');
  });

  it('兜底替换 sk- 形式的 token', () => {
    const out = sanitizeText('invalid sk-abcdefgh1234 provided');
    expect(out).not.toContain('sk-abcdefgh1234');
    expect(out).toContain('sk-***');
  });

  it('正常文本不受影响', () => {
    expect(sanitizeText('查询失败（HTTP 500）')).toBe('查询失败（HTTP 500）');
  });
});
