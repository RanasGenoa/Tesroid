import { afterEach, describe, expect, it, vi } from 'vitest';
import { openOnboardingGuideModal, renderOnboardingGuide } from '../src/views/onboarding.js';
import { renderSetupWizard } from '../src/views/setup-wizard.js';

function setupMockDom() {
  const listeners = new Map<string, () => void>();
  const elementsById = new Map<string, any>();
  const appendedOverlays: any[] = [];

  const nextBtn = {
    addEventListener: (ev: string, fn: () => void) => listeners.set(`guide-next-btn:${ev}`, fn),
    click: () => listeners.get('guide-next-btn:click')?.(),
  };

  const setupForm = {
    addEventListener: (ev: string, fn: () => void) => listeners.set(`setup-form:${ev}`, fn),
  };

  const makeOverlayElement = () => {
    const overlayListeners = new Map<string, (e?: any) => void>();
    const childClickHandlers = new Map<string, () => void>();
    let overlayHtml = '';
    let removed = false;

    const overlay: any = {
      id: '',
      className: '',
      style: {},
      get removed() {
        return removed;
      },
      set innerHTML(html: string) {
        overlayHtml = html;
      },
      get innerHTML() {
        return overlayHtml;
      },
      querySelector: (sel: string) => ({
        addEventListener: (ev: string, fn: () => void) => {
          if (ev === 'click') childClickHandlers.set(sel, fn);
        },
      }),
      addEventListener: (ev: string, fn: (e?: any) => void) => {
        overlayListeners.set(ev, fn);
      },
      remove: () => {
        removed = true;
        if (overlay.id && elementsById.get(overlay.id) === overlay) {
          elementsById.delete(overlay.id);
        }
      },
      triggerChildClick: (sel: string) => childClickHandlers.get(sel)?.(),
      triggerBackdropClick: () => overlayListeners.get('click')?.({ target: overlay }),
      triggerInnerClick: () => overlayListeners.get('click')?.({ target: {} }),
    };

    return overlay;
  };

  (globalThis as any).document = {
    getElementById: (id: string) => elementsById.get(id) || null,
    createElement: () => makeOverlayElement(),
  };

  let htmlValue = '';
  const container: any = {
    appendChild: (el: any) => {
      if (el.id) {
        elementsById.set(el.id, el);
      }
      appendedOverlays.push(el);
    },
  };
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

  return { container, nextBtn, appendedOverlays };
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

  it('opens onboarding guide modal overlay and closes via header close button, footer button, or backdrop', () => {
    const { container, appendedOverlays } = setupMockDom();

    openOnboardingGuideModal(container);
    expect(appendedOverlays).toHaveLength(1);

    const firstModal = appendedOverlays[0];
    expect(firstModal.id).toBe('onboarding-guide-modal');
    expect(firstModal.innerHTML).toContain('Tesroid オンボーディングガイド');
    expect(firstModal.innerHTML).toContain('id="onboarding-modal-close-btn"');
    expect(firstModal.innerHTML).toContain('id="onboarding-modal-close-action-btn"');

    // Clicking inside the card should not close the modal
    firstModal.triggerInnerClick();
    expect(firstModal.removed).toBe(false);

    // Clicking close header button closes it
    firstModal.triggerChildClick('#onboarding-modal-close-btn');
    expect(firstModal.removed).toBe(true);

    // Opening again replaces any existing modal and closes on footer button or backdrop
    openOnboardingGuideModal(container);
    const secondModal = appendedOverlays[1];
    openOnboardingGuideModal(container);
    expect(secondModal.removed).toBe(true);

    const thirdModal = appendedOverlays[2];
    thirdModal.triggerChildClick('#onboarding-modal-close-action-btn');
    expect(thirdModal.removed).toBe(true);

    openOnboardingGuideModal(container);
    const fourthModal = appendedOverlays[3];
    fourthModal.triggerBackdropClick();
    expect(fourthModal.removed).toBe(true);
  });
});
