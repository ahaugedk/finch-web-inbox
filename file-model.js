// Only passive formats are previewed. Active documents remain original downloads.
globalThis.FinchFileModel=(()=>{
  const types={'image/svg+xml':'image','image/png':'image','image/jpeg':'image','image/gif':'image','image/webp':'image','image/avif':'image','image/bmp':'image','application/pdf':'pdf','audio/mpeg':'audio','audio/mp4':'audio','audio/ogg':'audio','audio/wav':'audio','audio/webm':'audio','video/mp4':'video','video/webm':'video','video/ogg':'video','text/plain':'text','text/csv':'text','application/json':'text'};
  const extensions={svg:'image/svg+xml',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',avif:'image/avif',bmp:'image/bmp',pdf:'application/pdf',mp3:'audio/mpeg',m4a:'audio/mp4',ogg:'audio/ogg',wav:'audio/wav',mp4:'video/mp4',webm:'video/webm',txt:'text/plain',csv:'text/csv',json:'application/json'};
  function preview(file){let type=String(file.content_type||'').toLowerCase().split(';')[0].trim();if(!type||type==='application/octet-stream')type=extensions[String(file.name||'').split('.').at(-1).toLowerCase()]||'application/octet-stream';return {kind:types[type]||'download',type:types[type]?type:'application/octet-stream'};}
  return {preview,maxFileBytes:10*1024*1024,maxPreviewBytes:50*1024*1024};
})();
