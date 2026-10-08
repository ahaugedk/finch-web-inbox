// Register compact metadata; full documentation is fetched through get_tool_help.
// Descriptions are annotations. All schema validation keywords remain unchanged.
window.FinchToolCatalog=(()=>{
  const descriptions={
    start_conversation:'Forbind agenten, og hent organisationens briefing og komponentkatalog. Kald først. Ved login_required: vent med wait_for_login. Brug tools i baggrunden; styr ikke menneskets UI. Hent get_tool_help for detaljer.',
    add_knowledge:'Gem eller omstrukturér dokumenteret organisationsspecifik viden. Ingen Common Sense. Hvert udsagn kræver organization_specific_reason. Følg briefingens knowledge_maintenance og afklar uklarheder. focus må kun være true på brugerens udtrykkelige ønske. Hent get_tool_help for detaljer.',
    remove_knowledge:'Fjern erstattede eller forkerte udsagn/begreber efter kontekstuel gennemgang. Ret indgående links og bevar øvrig viden. Settings-begreber er beskyttede. Følg knowledge_maintenance; hent get_tool_help for detaljer.',
    build_page:'Byg en ønsket eller godkendt side med UI-kit eller isoleret WebComponent. Brug aktuelle revisioner, valgte table_ids/file_ids og writable_table_ids. Agentarbejde kræver brugerklik. Siden gemmes i baggrunden. Hent get_tool_help før bygning for komponent-, fil- og dashboard-API.',
    set_branding:'Tilpas organisationens tema, stylesheet, logo og fonts med revision fra get_branding. Brug organisationsfiler; ingen eksterne ressourcer. Bevar læsbarhed, navigation og godkendelser. Hent get_tool_help før ændringer for felter og begrænsninger.',
  };
  function schemaMetadata(value){
    if(Array.isArray(value))return value.map(schemaMetadata);
    if(!value||typeof value!=='object')return value;
    // A property named "description" is an object and must NOT be removed.
    return Object.fromEntries(Object.entries(value).filter(([key,v])=>!(key==='description'&&typeof v==='string')).map(([key,v])=>[key,schemaMetadata(v)]));
  }
  function create(tools){
    const full=tools.map(({run,...def})=>structuredClone(def));
    const definitions=full.map(def=>({...def,description:descriptions[def.name]||def.description,inputSchema:schemaMetadata(def.inputSchema)}));
    return {definitions,help:name=>{const tool=full.find(t=>t.name===name);return tool?structuredClone(tool):null;}};
  }
  const bytes=value=>new TextEncoder().encode(JSON.stringify(value)).length;
  function measure(definitions){return {count:definitions.length,bytes:bytes(definitions),largestToolBytes:Math.max(0,...definitions.map(bytes)),maxDescriptionChars:Math.max(0,...definitions.map(t=>t.description.length))};}
  // Engineering budgets, not claims about undocumented browser limits.
  return {create,measure,budget:{bytes:32768,toolBytes:3072,descriptionChars:512}};
})();
