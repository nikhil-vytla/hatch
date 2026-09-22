const atlas = JSON.parse(document.querySelector('#atlas-data').textContent);
const query = document.querySelector('#search');
const category = document.querySelector('#category');
const list = document.querySelector('#experiment-list');
const detail = document.querySelector('#detail');
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let selected = atlas.records.some(r => r.id === location.hash.slice(1)) ? location.hash.slice(1) : 'materials';
for (const name of [...new Set(atlas.records.map(r => r.category))]) {
  const option = document.createElement('option'); option.value = name; option.textContent = name; category.append(option);
}
function renderDetail() {
  const r = atlas.records.find(item => item.id === selected);
  if (!r) { detail.innerHTML = '<p>Clear the filters to choose an experiment.</p>'; document.querySelector('#selection-status').textContent = `${document.querySelector('#count').textContent}. No experiment selected`; return; }
  document.querySelector('#selection-status').textContent = `${document.querySelector('#count').textContent}. Showing ${r.title}`;
  const questions = r.questions.map(q => `<li>${escape(q.primitives)}<span>${escape(q.scope)}${q.count_note ? ' · '+escape(q.count_note) : ''}</span></li>`).join('');
  detail.innerHTML = `<div class="eyebrow">${escape(r.category)}</div><h2>${escape(r.title)}</h2>
    <p class="modes">${r.execution_modes.map(escape).join(' · ')}</p>
    <div class="flow">
      <section><h3>01 · INPUT</h3><p>${escape(r.input)}</p></section>
      <section><h3>02 · QUESTION</h3><div><ul class="questions">${questions}</ul><p class="note">${escape(r.instructions_and_criteria)}</p></div></section>
      <section><h3>03 · CODE USES</h3><div><p>${escape(r.output_effect)}</p><p class="note">${escape(r.distribution_use)}</p></div></section>
      <section><h3>04 · EVIDENCE</h3><p>${escape(r.recorded_evidence)}</p></section>
    </div>
    <div class="next-study"><h3>Go deeper here</h3><p>${escape(r.depth_opportunity)}</p></div>
    <details><summary>Inspect the call sites</summary><p class="note">Repository-relative paths from the audited working tree. File hashes are in the downloadable atlas.</p><ul class="evidence">${r.evidence.map(e=>`<li><code>${escape(e.path)}</code>${escape(e.symbol)}</li>`).join('')}</ul></details>`;
}
function renderList() {
  const restoreFocus = document.activeElement?.dataset.experiment === selected;
  const text = query.value.trim().toLowerCase();
  const matches = atlas.records.filter(r => (!category.value || r.category === category.value) && `${r.title} ${r.input} ${r.distribution_use} ${r.instructions_and_criteria} ${r.depth_opportunity} ${r.questions.map(q=>q.primitives).join(' ')}`.toLowerCase().includes(text));
  if (!matches.some(r => r.id === selected)) selected = matches[0]?.id ?? null;
  history.replaceState(null,'',selected ? '#'+selected : location.pathname + location.search);
  list.innerHTML = '';
  for (const r of matches) {
    const button = document.createElement('button');
    button.type = 'button'; button.setAttribute('aria-current', String(r.id === selected));
    button.dataset.experiment = r.id; button.setAttribute('aria-controls','detail');
    button.innerHTML = `${escape(r.title)}<small>${escape(r.category)}</small>`;
    button.addEventListener('click', () => { selected = r.id; history.replaceState(null,'','#'+r.id); renderList(); });
    list.append(button);
  }
  document.querySelector('#count').textContent = `${matches.length} of ${atlas.records.length} experiments`;
  if (!matches.length) { const p=document.createElement('p'); p.textContent='No matching experiments.'; list.append(p); }
  renderDetail();
  if (restoreFocus && selected) list.querySelector('[aria-current=true]')?.focus({preventScroll:true});
}
query.addEventListener('input',renderList); category.addEventListener('change',renderList);
window.addEventListener('hashchange',()=>{const id=location.hash.slice(1);if(atlas.records.some(r=>r.id===id)){selected=id;query.value='';category.value='';renderList();}});
document.querySelectorAll('[data-panel]').forEach(button=>button.addEventListener('click',()=>{
  document.querySelectorAll('[data-panel]').forEach(item=>item.setAttribute('aria-pressed',String(item===button)));
  document.querySelectorAll('[data-view]').forEach(view=>view.hidden=view.dataset.view!==button.dataset.panel);
}));
document.querySelector('#download-atlas').addEventListener('click',()=>{
  const url=URL.createObjectURL(new Blob([JSON.stringify(atlas,null,2)+'\n'],{type:'application/json'}));
  const a=document.createElement('a');a.href=url;a.download='jev-capability-atlas.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
renderList();
