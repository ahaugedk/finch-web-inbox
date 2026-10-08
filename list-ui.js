window.FinchList = (() => {
  const esc=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function create(label,attributes={},disabled=false){
    const attrs=Object.entries(attributes).map(([key,value])=>`${key}="${esc(value)}"`).join(' ');
    return `<button type="button" class="list-create" title="${esc(label)}" aria-label="${esc(label)}" ${attrs}${disabled?' disabled':''}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button>`;
  }
  return {create};
})();
