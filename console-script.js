(async () => {
  const results = {};
  const delay = ms => new Promise(r => setTimeout(r, ms));

  // 1. Expand all category accordions
  document.querySelectorAll('[aria-expanded="false"]').forEach(b => b.click());
  await delay(600);

  // 2. Click an item, grab the dialog text, close it
  async function clickAndCapture(btn) {
    btn.click();
    await delay(350);
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) return null;
    const text = dialog.innerText.trim();
    const close = dialog.querySelector('button[aria-label="Close"]');
    if (close) { close.click(); await delay(250); }
    return text;
  }

  // 3. Agent loop steps
  for (const btn of document.querySelectorAll('#agent-loop button[aria-label^="Step"]')) {
    btn.click();
    await delay(500);
    const panel = document.querySelector('#agent-loop .relative.mt-6');
    if (panel) results[btn.getAttribute('aria-label')] = panel.innerText.trim();
  }

  // 4. Tools — individual items inside expanded accordions
  for (const btn of document.querySelectorAll('#tools button')) {
    const mono = btn.querySelector('span.font-mono');
    if (!mono || btn.hasAttribute('aria-expanded')) continue;
    const name = mono.innerText.trim();
    if (!name || name === '▾') continue;
    const text = await clickAndCapture(btn);
    if (text) results[`tool:${name}`] = text;
  }

  // 5. Commands
  for (const btn of document.querySelectorAll('#commands button')) {
    const mono = btn.querySelector('span.font-mono');
    if (!mono || btn.hasAttribute('aria-expanded')) continue;
    const name = mono.innerText.trim();
    if (!name || !name.startsWith('/')) continue;
    const text = await clickAndCapture(btn);
    if (text) results[`cmd:${name}`] = text;
  }

  // 6. Hidden features
  for (const btn of document.querySelectorAll('#hidden-features button')) {
    const h3 = btn.querySelector('h3');
    if (!h3) continue;
    const name = h3.innerText.trim();
    const text = await clickAndCapture(btn);
    if (text) results[`feature:${name}`] = text;
  }

  console.log(JSON.stringify(results, null, 2));
  console.log(`\nTotal items captured: ${Object.keys(results).length}`);
})();
