import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function collectClientSourceFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectClientSourceFiles(fullPath));
    } else if (/\.(ts|html|css)$/.test(entry.name)) {
      results.push(fullPath);
    }
  }
  return results;
}

describe('Tesla Browser Compliance Checks', () => {
  it('must NOT contain any <video> tags in index.html', () => {
    const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf-8');
    expect(html).not.toMatch(/<video\b/i);
  });

  it('must NOT contain any <video> tags in built dist/index.html when present', () => {
    const distPath = path.join(__dirname, '../dist/index.html');
    if (fs.existsSync(distPath)) {
      const distHtml = fs.readFileSync(distPath, 'utf-8');
      expect(distHtml).not.toMatch(/<video\b/i);
    } else {
      // Standalone pre-build test run: verify source index.html still has no <video>
      const srcHtml = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf-8');
      expect(srcHtml).not.toMatch(/<video\b/i);
    }
  });

  it('must contain <canvas id="stream-canvas"> in streaming view source', () => {
    const streamViewSrc = fs.readFileSync(
      path.join(__dirname, '../src/views/streaming.ts'),
      'utf-8',
    );
    expect(streamViewSrc).toContain('<canvas id="stream-canvas">');
    expect(streamViewSrc).not.toMatch(/<video\b/i);
  });

  it('must NOT instantiate or embed <video> elements in any client/src file (D-gear blackout guard)', () => {
    const srcFiles = collectClientSourceFiles(path.join(__dirname, '../src'));
    expect(srcFiles.length).toBeGreaterThan(15);

    for (const filePath of srcFiles) {
      const content = fs.readFileSync(filePath, 'utf-8');
      // Strip single-line and block comments so explanatory comments never false-positive
      const codeOnly = content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(codeOnly, `Forbidden <video> tag in ${filePath}`).not.toMatch(/<video\b/i);
      expect(codeOnly, `Forbidden createElement('video') in ${filePath}`).not.toMatch(
        /createElement\s*\(\s*['"`]video['"`]\s*\)/i,
      );
    }
  });

  it('must configure .stream-hud with safe centering to prevent left-side overflow clipping', () => {
    const css = fs.readFileSync(path.join(__dirname, '../src/styles/main.css'), 'utf-8');
    const hudBlockMatch = css.match(/\.stream-hud\s*\{([^}]+)\}/);
    expect(hudBlockMatch).not.toBeNull();
    const hudBlock = hudBlockMatch![1];

    // Must have overflow-x: auto for scrollability
    expect(hudBlock).toMatch(/overflow-x:\s*auto/);
    // Must contain safe center or flex-start fallback to avoid negative scroll loss
    expect(hudBlock).toMatch(/justify-content:\s*safe center/);
    expect(hudBlock).toMatch(/justify-content:\s*flex-start/);
  });
});
