const tapes = [...document.querySelectorAll('.tape-stack button')];
const readout = document.querySelector('#active-readout');
function activateTape(index) {
  tapes.forEach((tape, i) => {
    const active = i === index;
    tape.classList.toggle('is-active', active);
    tape.setAttribute('aria-pressed', String(active));
  });
  const { name, role, region } = tapes[index].dataset;
  readout.textContent = tapes[index].dataset.readout || `${name} · ${role} · ${region}`;
}
tapes.forEach((tape, i) => tape.addEventListener('click', () => activateTape(i)));
document.addEventListener('keydown', event => {
  const target = event.target;
  if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable) return;
  const index = Number(event.key) - 1;
  if (index >= 0 && index < tapes.length) activateTape(index);
});

const demoQuery = document.querySelector('#demo-query');
const demoResults = document.querySelector('#demo-results');
const results = [
  { color: 'red', tag: '生产', service: 'Lambda · web-api', account: '生产环境', region: 'ap-northeast-1', search: 'prod lambda tokyo' },
  { color: 'red', tag: '生产', service: 'Lambda · billing', account: '生产环境', region: 'ap-northeast-1', search: 'prod lambda tokyo' },
  { color: 'red', tag: '生产', service: 'Lambda · worker', account: '生产环境', region: 'ap-northeast-1', search: 'prod lambda tokyo' },
  { color: 'green', tag: '测试', service: 'Lambda · web-api', account: '测试环境', region: 'ap-northeast-1', search: 'test lambda tokyo' },
  { color: 'orange', tag: '开发', service: 'Lambda · data-sync', account: '数据平台', region: 'ap-northeast-1', search: 'data lambda tokyo' },
  { color: 'red', tag: '生产', service: 'S3 · app-assets', account: '生产环境', region: 'ap-northeast-1', search: 's3 prod tokyo' },
  { color: 'red', tag: '生产', service: 'S3 · audit-backup', account: '生产环境', region: 'us-east-1', search: 's3 prod virginia' }
];
let typingTimer;
function marked(text, match) {
  const span = document.createElement('span');
  const index = match ? text.toLowerCase().indexOf(match) : -1;
  if (index < 0) { span.textContent = text; return span; }
  span.append(document.createTextNode(text.slice(0, index)));
  const strong = document.createElement('strong');
  strong.textContent = text.slice(index, index + match.length);
  span.append(strong, document.createTextNode(text.slice(index + match.length)));
  return span;
}
function showResults(query) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = results.filter(row => terms.every(term => row.search.split(' ').some(word => word.startsWith(term))));
  const shown = query === 'lambda tokyo' ? [matches[0], matches[3], matches[4]].filter(Boolean) : matches.slice(0, 4);
  demoResults.replaceChildren();
  shown.forEach((row, index) => {
    const item = document.createElement('div');
    item.className = `result-row${index === 0 ? ' is-top' : ''}`;
    const dot = document.createElement('span');
    dot.className = `tape-dot dot-${row.color}`;
    const tag = marked(row.tag, terms.some(term => 'prod'.startsWith(term)) && row.tag === '生产' ? '生产' : '');
    tag.classList.add('env-tag');
    const account = document.createElement('span');
    account.className = 'result-account';
    account.append(marked(row.account, terms.some(term => 'prod'.startsWith(term)) && row.account === '生产环境' ? '生产' : ''), document.createTextNode(' · '), marked(row.service, terms.find(term => row.service.toLowerCase().startsWith(term)) || ''));
    const region = marked(row.region, terms.some(term => 'tokyo'.startsWith(term)) && row.region === 'ap-northeast-1' ? row.region : '');
    region.classList.add('result-region');
    item.append(dot, tag, account, region);
    if (index === 0) {
      const hint = document.createElement('span');
      hint.className = 'open-hint';
      hint.textContent = '↵ 打开';
      item.append(hint);
    }
    demoResults.append(item);
  });
}
function typeQuery(query) {
  clearInterval(typingTimer);
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    demoQuery.textContent = query;
    showResults(query);
    return;
  }
  let position = 0;
  demoQuery.textContent = '';
  showResults('');
  typingTimer = setInterval(() => {
    demoQuery.textContent = query.slice(0, ++position);
    showResults(demoQuery.textContent);
    if (position >= query.length) clearInterval(typingTimer);
  }, 75);
}
showResults(demoQuery.textContent);
document.querySelectorAll('[data-query]').forEach(button => button.addEventListener('click', () => typeQuery(button.dataset.query)));

const revealSections = document.querySelectorAll('.reveal');
if ('IntersectionObserver' in window && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('is-visible');
      observer.unobserve(entry.target);
      if (entry.target.classList.contains('jump')) typeQuery('prod lambda tokyo');
    }
  }, { threshold: 0.08 });
  revealSections.forEach(section => observer.observe(section));
} else {
  revealSections.forEach(section => section.classList.add('is-visible'));
}

document.querySelector('#copy-code').addEventListener('click', async event => {
  const button = event.currentTarget;
  try {
    await navigator.clipboard.writeText([...document.querySelectorAll('#install-code span')].map(line => line.textContent).join('\n'));
    button.textContent = '已复制';
    window.setTimeout(() => { button.textContent = '复制命令'; }, 2000);
  } catch {
    button.textContent = '请手动复制';
  }
});
