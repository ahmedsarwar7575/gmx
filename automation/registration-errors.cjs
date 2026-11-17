// Runs in the page. Return visible error text only, never form values or bodies.
function readVisibleRegistrationErrors() {
  const roots = [document], elements = [];
  for (const root of roots) for (const element of root.querySelectorAll('*')) {
    if (element.shadowRoot) roots.push(element.shadowRoot);
    elements.push(element);
  }
  const visible = element => {
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    for (let current = element; current; current = current.parentElement || current.getRootNode()?.host) {
      const style = getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    }
    return true;
  };
  const rejected = /(?:account|konto|e-?mail(?:-adresse|\s+address)).{0,100}(?:nicht\s+erstellt\s+werden|cannot\s+be\s+created|can't\s+be\s+created|could\s+not\s+be\s+created)/i;
  const explicit = [], terminal = [];
  for (const element of elements) {
    if (!visible(element)) continue;
    const text = (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > 1000) continue;
    if (rejected.test(text)) terminal.push(text);
    if (element.matches('[role="alert"],[id$="-error"],[data-testid$="-error"],.form-error,.error-message,.form-message-error')) explicit.push(text);
  }
  terminal.sort((a, b) => a.length - b.length);
  return [...new Set([terminal[0], ...explicit].filter(Boolean))].slice(0, 3).map(text => text.slice(0, 600));
}

module.exports = { readVisibleRegistrationErrors };
