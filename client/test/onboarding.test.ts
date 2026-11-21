import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderOnboardingGuide } from '../src/views/onboarding.js';
import { renderSetupWizard } from '../src/views/setup-wizard.js';

function setupMockDom() {
  const listeners = new Map<string, () => void>();
  const elementsById = new Map<string, any>();

  const nextBtn = {
    addEventListener: (ev: string, fn: () => void) => listeners.set(`guide-next-btn:${ev}`, fn),
    click: () => listeners.get('guide-next-btn:click')?.(),
  };

  const setupForm = {
    addEventListener: (ev: string, fn: () => void) => listeners.set(`setup-form:${ev}`, fn),
  };

  (globalThis as any).document = {
    getElementById: (id: string) => elementsById.get(id) || null,
  };

  let htmlValue = '';
  const container: any = {};
  Object.defineProperty(container, 'innerHTML', {
    get: () => htmlValue,
    set: (html: string) => {
      htmlValue = html;
      elementsById.clear();
      if (html.includes('id="guide-next-btn"')) {
        elementsById.set('guide-next-btn', nextBtn);
      }
      if (html.includes('id="setup-form"')) {
        elementsById.set('setup-form', setupForm);
      }
    },
  });

  return { container, nextBtn };
}

describe('Onboarding Guide & Setup Wizard', () => {
  const originalDocument = (globalThis as any).document;

  afterEach(() => {
    (globalThis as any).document = originalDocument;
    vi.restoreAllMocks();
  });

  it('keeps SSL guidance concise without reverse-proxy snippets and explains capabilities and HUD operations', () => {
    const { container, nextBtn } = setupMockDom();
    const onNext = vi.fn();

    renderOnboardingGuide(container, onNext);

    // Concise public SSL requirement
    expect(container.innerHTML).toContain('公的 SSL 証明書');
    expect(container.innerHTML).toContain('docs/NETWORK.md');

    // Redundant infrastructure snippets removed
    expect(container.innerHTML).not.toContain('nginx-snippet');
    expect(container.innerHTML).not.toContain('caddy-snippet');
    expect(container.innerHTML).not.toContain('proxy_pass');
    expect(container.innerHTML).not.toContain('reverse_proxy');

    // Capabilities, basic operations, HUD usage, and rear monitor mode
    expect(container.innerHTML).toContain('Tesroid でできること');
    expect(container.innerHTML).toContain('Dレンジ走行中');
    expect(container.innerHTML).toContain('自動省電力スタンバイ');
    expect(container.innerHTML).toContain('基本操作と文字入力');
    expect(container.innerHTML).toContain('上部 HUD バーの主な操作');
    expect(container.innerHTML).toContain('LIVE');
    expect(container.innerHTML).toContain('後席モニター待ち受けモード');

    nextBtn.click();
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it('transitions from onboarding guide (Step 1) to initial setup form (Step 2)', () => {
    const { container, nextBtn } = setupMockDom();

    renderSetupWizard(container, vi.fn());
    expect(container.innerHTML).toContain('Tesroid オンボーディングガイド');

    nextBtn.click();
    expect(container.innerHTML).toContain('Tesroid 初期セットアップ');
    expect(container.innerHTML).toContain('id="setup-form"');
  });
});
