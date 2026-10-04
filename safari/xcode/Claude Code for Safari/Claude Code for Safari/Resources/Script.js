function setStatus(s) {
    const ext = document.getElementById('ext');
    if (!s.extensionEnabled) { ext.textContent = 'Off. Turn it on in Safari Settings > Extensions.'; ext.className = 'bad'; }
    else if (s.extensionConnected) { ext.textContent = `On and connected (v${s.extensionVersion}).`; ext.className = 'good'; }
    else { ext.textContent = 'On, waiting for Safari to connect…'; ext.className = 'warn'; }

    const bridge = document.getElementById('bridge');
    if (s.bridgeError) { bridge.textContent = `Failed: ${s.bridgeError}`; bridge.className = 'bad'; }
    else { bridge.textContent = `Listening on 127.0.0.1:${s.bridgePort}.`; bridge.className = 'good'; }

    const claude = document.getElementById('claude');
    claude.textContent = s.lastClaudeCall ? `Last call ${s.lastClaudeCall}.` : 'No calls yet. Run /safari in Claude Code.';
    claude.className = s.lastClaudeCall ? 'good' : '';

    document.getElementById('login').checked = !!s.launchAtLogin;
    document.getElementById('version').textContent = `Version ${s.appVersion}`;
}
document.querySelector('button.open-preferences').addEventListener('click', () => webkit.messageHandlers.controller.postMessage('open-preferences'));
document.querySelector('button.copy-command').addEventListener('click', () => webkit.messageHandlers.controller.postMessage('copy-command'));
document.getElementById('login').addEventListener('change', () => webkit.messageHandlers.controller.postMessage('toggle-login'));
