import { showToast } from './icons.js';

export async function sleep(token: string): Promise<void> {
  try {
    const res = await fetch('/api/system/sleep', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      showToast('ブラウザを省電力一時停止しました (CPU/GPU 0%)', 'info');
    } else {
      showToast(`一時停止に失敗しました (HTTP ${res.status})`, 'error');
    }
  } catch (err: any) {
    showToast(`一時停止に失敗: ${err.message}`, 'error');
  }
}

export async function resume(token: string): Promise<void> {
  try {
    const res = await fetch('/api/system/resume', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      showToast('ブラウザを再開しました', 'success');
    } else {
      showToast(`再開に失敗しました (HTTP ${res.status})`, 'error');
    }
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
      if (
        typeof window !== 'undefined' &&
        typeof window.dispatchEvent === 'function' &&
        typeof CustomEvent === 'function'
      ) {
        window.dispatchEvent(new CustomEvent('tesroid:stream-reset'));
      }
      showToast('最新状態へ同期し、再エンコードを実行しました', 'success');
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
      const res = await fetch('/api/system/restart-browser', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        showToast('ブラウザを再起動しました', 'success');
      } else {
        showToast(`再起動に失敗しました (HTTP ${res.status})`, 'error');
      }
    } catch (err: any) {
      showToast(`再起動に失敗: ${err.message}`, 'error');
    }
  }
}
