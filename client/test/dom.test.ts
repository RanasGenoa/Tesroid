import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('Tesla Browser Compliance Checks', () => {
  it('must NOT contain any <video> tags in index.html', () => {
    const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf-8');
    expect(html).not.toMatch(/<video/i);
  });

  it('must NOT contain any <video> tags in built dist/index.html', () => {
    const distHtml = fs.readFileSync(path.join(__dirname, '../dist/index.html'), 'utf-8');
    expect(distHtml).not.toMatch(/<video/i);
  });

  it('must contain <canvas id="stream-canvas"> in streaming view source', () => {
    const streamViewSrc = fs.readFileSync(path.join(__dirname, '../src/views/streaming.ts'), 'utf-8');
    expect(streamViewSrc).toContain('<canvas id="stream-canvas">');
    expect(streamViewSrc).not.toMatch(/<video/i);
  });
});
