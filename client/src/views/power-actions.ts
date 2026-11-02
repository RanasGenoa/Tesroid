import { showToast } from './icons.js';

export async function sleep(token: string): Promise<void> {
  try {
    await fetch('/api/system/sleep', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    showToast('ブラウザを省電力一時停止しました (CPU/GPU 0%)', 'info');
  } catch (err: any) {
    showToast(`一時停止に失敗: ${err.message}`, 'error');
  }
}

export async function resume(token: string): Promise<void> {
  try {
    await fetch('/api/system/resume', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    showToast('ブラウザを再開しました', 'success');
  } catch (err: any) {
    showToast(`再開に失敗: ${err.message}`, 'error');
  }
}

export async function encoderRestart(token: string): Promise<void> {
  try {
    const res = await fetch('/api/encoder/restart', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
        window.dispatchEvent(new CustomEvent('tesroid:stream-reset'));
      }
      showToast('配信プロセスをクリーン再起動しました（映像・音声リセット中）', 'success');
    } else {
      showToast(`再エンコードに失敗しました (HTTP ${res.status})`, 'error');
    }
  } catch (err: any) {
    showToast(`再エンコードに失敗しました: ${err.message}`, 'error');
  }
}

export async function browserRestart(token: string): Promise<void> {
  if (confirm('ブラウザプロセスを再起動しますか？')) {
    try {
      await fetch('/api/system/restart-browser', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      showToast('ブラウザを再起動しました', 'success');
    } catch (err: any) {
      showToast(`再起動に失敗: ${err.message}`, 'error');
    }
  }
}
