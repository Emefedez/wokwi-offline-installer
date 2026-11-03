(function () {
  const offlineSwitchDelayMillis = 2000;

  const iframe = document.querySelector('iframe');
  const offlineMessage = document.querySelector('#offline-message');
  const loadingMessage = document.querySelector('#loading-message');
  const offlineSwitch = document.querySelector('#offline-switch');
  const offlineSwitchButton = document.querySelector('#offline-switch-button');
  const vscode = acquireVsCodeApi();
  let wokwiPort = null;
  let wokwiLoaded = false;

  iframe.addEventListener('load', () => {
    if (!wokwiLoaded) {
      if (document.body.dataset.offline) {
        vscode.postMessage({ command: 'goOffline' });
      } else {
        loadingMessage.classList.add('hidden');
        offlineMessage.classList.remove('hidden');
      }
    }
  });
  iframe.src = iframe.getAttribute('data-src');

  // If the simulator is slow to load and a valid offline bundle + license are
  // available, offer switching to offline mode instead of waiting.
  if (document.body.dataset.offlineSwitch) {
    offlineSwitchButton.addEventListener('click', () => {
      vscode.postMessage({ command: 'goOffline' });
    });
    setTimeout(() => {
      if (!wokwiLoaded) {
        offlineSwitch.classList.remove('hidden');
      }
    }, offlineSwitchDelayMillis);
  }

  // Handle messages sent from the extension to the webview
  window.addEventListener('message', (event) => {
    const originUrl = new URL(event.origin);
    if (
      event.origin.startsWith('vscode-webview://') ||
      originUrl.hostname.endsWith('.webview.localhost') ||
      originUrl.hostname.endsWith('.vscode-cdn.net') ||
      originUrl.hostname.endsWith('.gitpod.io') ||
      originUrl.hostname.endsWith('.github.dev')
    ) {
      if (wokwiPort) {
        wokwiPort.postMessage(event.data);
      }
      return;
    }

    wokwiLoaded = true;
    const message = event.data;
    switch (message.command) {
      case 'start': {
        offlineSwitch.classList.add('hidden');
        const { port, ...messageBody } = message;
        wokwiPort = port;
        port.onmessage = (event) => {
          vscode.postMessage(event.data);
        };
        vscode.postMessage(messageBody);
        break;
      }
    }
  });
})();
