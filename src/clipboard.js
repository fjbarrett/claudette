import { execFile as nativeExecFile } from 'node:child_process';

/** Write text over stdin so message content is never interpreted as a command. */
function writeClipboard(file, args, input, env, execFile) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, {
      env, timeout: 5000, maxBuffer: 64 * 1024, windowsHide: true,
    }, (error, _stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).trim()));
      else resolve();
    });
    // A missing clipboard utility can close its input before accepting text.
    child.stdin.on('error', reject);
    child.stdin.end(input);
  });
}

export async function copyToClipboard(text, {
  platform = process.platform,
  env = process.env,
  execFile = nativeExecFile,
} = {}) {
  let commands;
  let input = text;
  if (platform === 'darwin') {
    commands = [['/usr/bin/pbcopy', []]];
  } else if (platform === 'win32') {
    commands = [['clip.exe', []]];
    input = Buffer.from(text, 'utf16le');
  } else if (platform === 'linux') {
    const wayland = ['wl-copy', []];
    const x11 = [['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]];
    commands = env.WAYLAND_DISPLAY ? [wayland, ...x11] : [...x11, wayland];
  } else {
    throw new Error(`Clipboard copying is not supported on ${platform}.`);
  }

  let lastError;
  for (const [file, args] of commands) {
    try {
      await writeClipboard(file, args, input, env, execFile);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  const hint = platform === 'linux'
    ? ' Install wl-clipboard (Wayland), xclip, or xsel (X11) and run in a desktop session.'
    : '';
  throw new Error(`Could not copy to clipboard: ${lastError.message}.${hint}`);
}

/** Tool results and user prompts never replace the last nonempty assistant text. */
export async function copyLastAssistantMessage(messages, copy = copyToClipboard) {
  const message = messages.findLast(item =>
    item.role === 'assistant' && typeof item.content === 'string' && item.content.trim());
  if (!message) return false;
  await copy(message.content);
  return true;
}
