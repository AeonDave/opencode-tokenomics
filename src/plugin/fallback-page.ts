/**
 * Built-in live dashboard, served when dashboard/dist is not built yet.
 * Self-contained (no deps): connects to /api/stream and renders the GlobalSnapshot live.
 * Shows everything the snapshot carries — per project: KPIs, cumulative spend, the
 * agent/subagent tree (who · what · how much · how long), by-model, context breakdown,
 * tools (calls/output/schema/complexity/time) and the agent×model cross-breakdown.
 */

export const FALLBACK_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>opencode · tokenomics</title>
<style>
  :root{
    --bg:#0A0D12;--panel:#141A24;--panel2:#10151D;--grid:#222C3A;--soft:#1A212C;
    --ink:#E8EDF4;--mute:#808B9C;--faint:#4A5566;
    --cyan:#5BC8FF;--amber:#FFB454;--green:#54E0A6;--violet:#A98BFF;--cost:#FFC24B;--warn:#FF5C6C;--pink:#FF7AB6;
  }
  *{box-sizing:border-box}
  body{margin:0;background:radial-gradient(1200px 600px at 82% -12%,rgba(91,200,255,.07),transparent 60%),var(--bg);
    color:var(--ink);font-family:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace;font-size:14px;
    padding:20px clamp(12px,3vw,40px) 60px;-webkit-font-smoothing:antialiased}
  .frame{max-width:1240px;margin:0 auto}
  a{color:var(--cyan)}
  .top{display:flex;align-items:center;justify-content:space-between;gap:16px;padding-bottom:14px;
    margin-bottom:18px;border-bottom:1px solid var(--grid);flex-wrap:wrap}
  .brand{font-weight:700;font-size:18px;letter-spacing:-.01em}
  .brand .b{color:var(--cyan);margin-right:8px}
  .brand .s{color:var(--mute);font-weight:400;font-size:12px;margin-left:10px}
  .conn{display:inline-flex;align-items:center;gap:8px;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--mute)}
  .dot{width:8px;height:8px;border-radius:50%;background:var(--warn)}
  .dot.on{background:var(--green);box-shadow:0 0 0 0 rgba(84,224,166,.5);animation:p 2s ease-out infinite}
  @keyframes p{0%{box-shadow:0 0 0 0 rgba(84,224,166,.5)}70%{box-shadow:0 0 0 7px rgba(84,224,166,0)}100%{box-shadow:0 0 0 0 rgba(84,224,166,0)}}
  .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:14px}
  .kpi{background:linear-gradient(180deg,var(--panel),var(--panel2));border:1px solid var(--grid);border-radius:6px;padding:13px 15px}
  .kpi .l{font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--mute);display:flex;gap:6px;align-items:center}
  .kpi .v{font-size:26px;font-weight:600;letter-spacing:-.02em;margin-top:6px;font-variant-numeric:tabular-nums}
  .kpi .sub{font-size:11px;color:var(--mute);margin-top:3px;font-variant-numeric:tabular-nums}
  .kpi .v.cost{color:var(--cost)} .kpi .v.green{color:var(--green)} .kpi .v.cyan{color:var(--cyan)} .kpi .v.violet{color:var(--violet)}
  .search{width:100%;max-width:320px;background:var(--panel2);border:1px solid var(--grid);border-radius:6px;
    color:var(--ink);font:inherit;font-size:13px;padding:8px 11px;margin:4px 0 10px}
  .search::placeholder{color:var(--faint)} .search:focus{outline:none;border-color:var(--cyan)}
  .tabs{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 18px;max-height:148px;overflow:auto}
  .tab{border:1px solid var(--grid);background:transparent;color:var(--mute);border-radius:999px;padding:6px 13px;
    font:inherit;font-size:12px;cursor:pointer;transition:.15s}
  .tab:hover{color:var(--ink)} .tab.on{border-color:var(--cyan);background:rgba(91,200,255,.1);color:var(--ink)}
  .tab b{color:var(--cost);font-weight:500;margin-left:6px}
  .tabwrap{display:inline-flex;align-items:center;border:1px solid var(--grid);border-radius:999px;overflow:hidden;color:var(--mute);transition:.15s}
  .tabwrap:hover{color:var(--ink)} .tabwrap.on{border-color:var(--cyan);background:rgba(91,200,255,.1);color:var(--ink)}
  .tabwrap .tab{border:0;border-radius:0;background:transparent;padding:6px 4px 6px 13px}
  .tabdel{border:0;background:transparent;color:var(--faint);font:inherit;font-size:15px;line-height:1;cursor:pointer;padding:6px 10px 6px 5px}
  .tabdel:hover{color:var(--warn)}
  .clearall{border:1px solid var(--grid);background:transparent;color:var(--mute);border-radius:999px;padding:6px 12px;font:inherit;font-size:12px;cursor:pointer;transition:.15s}
  .clearall:hover{color:var(--warn);border-color:rgba(255,92,108,.4)}
  .proj{background:linear-gradient(180deg,var(--panel),var(--panel2));border:1px solid var(--grid);border-radius:6px;padding:18px 20px;margin-bottom:16px}
  .proj h2{margin:0 0 2px;font-size:15px}
  .proj .path{font-size:11px;color:var(--faint);word-break:break-all;margin-bottom:12px}
  .pstat{display:flex;gap:8px 20px;flex-wrap:wrap;margin-bottom:14px}
  .pstat span{font-size:11px;color:var(--mute)} .pstat b{color:var(--ink);font-weight:500;font-variant-numeric:tabular-nums}
  .cols{display:grid;grid-template-columns:1.35fr 1fr;gap:24px}
  @media(max-width:820px){.cols{grid-template-columns:1fr}}
  .blk{margin-bottom:18px}
  .sub{font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--mute);margin:0 0 9px;display:flex;justify-content:space-between}
  .row{display:grid;grid-template-columns:minmax(0,1fr) 70px;gap:10px;align-items:center;padding:5px 0;border-bottom:1px solid var(--soft)}
  .row:last-child{border-bottom:0}
  .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .nm .meta{color:var(--mute);font-size:10.5px;margin-left:8px}
  .bar{height:5px;border-radius:2px;background:var(--soft);overflow:hidden;margin-top:3px}
  .bar i{display:block;height:100%;border-radius:2px;background:var(--violet)}
  .c{font-variant-numeric:tabular-nums;text-align:right;color:var(--cost)}
  .tree .ind{color:var(--faint);white-space:pre}
  .dayhdr{display:flex;align-items:center;gap:8px;background:var(--soft);border-radius:5px;padding:5px 9px;margin:9px 0 3px;cursor:pointer;font-size:12px}
  .dayhdr:hover{background:var(--grid)} .dayhdr .meta{color:var(--mute);font-size:11px}
  .chev{display:inline-block;color:var(--mute);transition:transform .15s} .chev.open{transform:rotate(90deg)}
  .chevpad{display:inline-block;width:12px;margin-right:4px} .brow .chev{cursor:pointer;margin-right:4px}
  .sd{width:7px;height:7px;border-radius:50%;display:inline-block;margin-right:7px;background:var(--mute);vertical-align:middle}
  .sd.sub{background:var(--violet)} .sd.main{background:var(--cyan)}
  .badge{font-size:10px;color:var(--mute);border:1px solid var(--grid);border-radius:4px;padding:1px 6px;margin-left:6px}
  table{width:100%;border-collapse:collapse;font-size:12px}
  th{text-align:right;color:var(--faint);font-weight:400;font-size:10px;text-transform:uppercase;letter-spacing:.08em;padding:0 0 6px}
  th.l,td.l{text-align:left} td{padding:4px 0;border-bottom:1px solid var(--soft);font-variant-numeric:tabular-nums;text-align:right}
  tr:last-child td{border-bottom:0}
  .cx{display:flex;height:14px;border-radius:3px;overflow:hidden;border:1px solid var(--grid);background:var(--soft)}
  .cx i{height:100%} .cxleg{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:9px}
  .cxleg span{font-size:11px;color:var(--mute);display:inline-flex;align-items:center;gap:6px}
  .cxleg .sw{width:9px;height:9px;border-radius:2px;display:inline-block}
  .cxleg b{color:var(--ink);font-weight:500}
  .pill{font-size:10px;border-radius:3px;padding:0 5px;border:1px solid var(--grid);color:var(--mute)}
  .pill.cmplx{color:var(--amber);border-color:rgba(255,180,84,.3)} .pill.simple{color:var(--green);border-color:rgba(84,224,166,.25)}
  .spark svg{width:100%;height:50px;display:block}
  .empty{color:var(--faint);text-align:center;padding:14px 0;font-size:12px}
  .noproj{color:var(--mute);text-align:center;padding:70px 0}
  .foot{margin-top:26px;color:var(--faint);font-size:11px;border-top:1px solid var(--grid);padding-top:14px}
</style>
</head>
<body>
<div class="frame">
  <div class="top">
    <div class="brand"><span class="b">◖◗</span>tokenomics<span class="s">opencode usage &amp; cost · live</span></div>
    <span class="conn"><span id="dot" class="dot"></span><span id="connlabel">connecting…</span></span>
  </div>
  <div id="kpis" class="kpis"></div>
  <input id="projsearch" class="search" placeholder="Filter projects…" autocomplete="off" />
  <div id="tabs" class="tabs"></div>
  <div id="projects"></div>
  <div class="foot">Built-in live view · run <b>npm run dashboard:build</b> for the full shadcn dashboard. Costs shown at API pricing when your plan reports $0.</div>
</div>
<script>
var COLORS={systemPrompt:"#5BC8FF",toolDefinitions:"#A98BFF",environment:"#54E0A6",projectTree:"#FFB454",customInstructions:"#FF7AB6",other:"#4A5566"};
var CXLABEL={systemPrompt:"system",toolDefinitions:"tool defs",environment:"environment",projectTree:"project tree",customInstructions:"instructions",other:"other"};

var money=function(n){return "$"+(n||0).toLocaleString("en-US",{minimumFractionDigits:4,maximumFractionDigits:4})};
var money2=function(n){return "$"+(n||0).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})};
var num=function(n){return (n||0).toLocaleString("en-US")};
var pct=function(n){return (100*(n||0)).toFixed(1)+"%"};
function compact(n){n=n||0;if(n>=1e9)return (n/1e9).toFixed(2)+"B";if(n>=1e6)return (n/1e6).toFixed(2)+"M";if(n>=1e3)return (n/1e3).toFixed(1)+"k";return String(Math.round(n))}
function dur(ms){ms=ms||0;if(ms<1000)return Math.round(ms)+"ms";var s=ms/1000;if(s<60)return s.toFixed(1)+"s";var m=Math.floor(s/60);var r=Math.round(s%60);if(m<60)return m+"m"+(r?" "+r+"s":"");var h=Math.floor(m/60);return h+"h "+(m%60)+"m"}
var esc=function(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})};
function shortModel(m){var p=String(m||"").split("/");return p[p.length-1]||"—"}
function providerOf(m){m=String(m||"");return m.indexOf("/")<0?"":m.split("/").slice(0,-1).join("/")}
function costHtml(cost,est){
  if(cost>0)return '<span style="color:var(--cost)">'+money2(cost)+'</span>';
  if(est>0)return '<span style="color:var(--mute)" title="estimated API-equivalent; plan reports $0">~'+money2(est)+'</span>';
  return '<span style="color:var(--mute)">free</span>';
}

var selected="all";
var last=null;
var treeCollapsed={};
var cardCfg={};
function cardOn(id){return cardCfg[id]!==false}

function bar(frac,color){var w=Math.max(0,Math.min(100,(frac||0)*100));return '<div class="bar"><i style="width:'+w.toFixed(1)+'%;background:'+(color||'var(--cyan)')+'"></i></div>'}

function sparkline(series){
  if(!series||series.length<2)return '<div class="empty">— not enough points yet —</div>';
  var max=series[series.length-1].cost||1,n=series.length;
  var pts=series.map(function(p,i){var x=(i/(n-1))*320;var y=46-((p.cost/max)*40);return x.toFixed(1)+","+y.toFixed(1)}).join(" ");
  return '<div class="spark"><svg viewBox="0 0 320 50" preserveAspectRatio="none">'+
    '<polyline fill="none" stroke="rgba(255,194,75,.14)" stroke-width="6" points="'+pts+'"/>'+
    '<polyline fill="none" stroke="var(--cost)" stroke-width="1.6" points="'+pts+'"/></svg></div>'}

/* ---- cross-project merge for the "all" view ---- */
function byCost(a,b){return b.cost-a.cost}
function combineSeries(projects){
  var d={};projects.forEach(function(p){var pc=0,ptk=0;(p.series||[]).forEach(function(pt){var s=d[pt.t]||(d[pt.t]={c:0,tk:0});s.c+=pt.cost-pc;s.tk+=pt.tokens-ptk;pc=pt.cost;ptk=pt.tokens})});
  var ks=Object.keys(d).map(Number).sort(function(a,b){return a-b});var c=0,tk=0,out=[];
  ks.forEach(function(k){c+=d[k].c;tk+=d[k].tk;out.push({t:k,cost:c,tokens:tk})});return out;
}
function mergeAll(g){
  var models={},tools={},skills={},am={},sessions=[],ctx={systemPrompt:0,toolDefinitions:0,environment:0,projectTree:0,customInstructions:0,other:0,total:0};
  var split={main:{cost:0,estimatedCost:0,tokens:0,apiCalls:0},subagents:{cost:0,estimatedCost:0,tokens:0,apiCalls:0}};
  var savings=0;
  (g.projects||[]).forEach(function(p){
    p.models.forEach(function(m){var k=m.model;var c=models[k]||(models[k]={model:k,cost:0,estimatedCost:0,tokens:0,messages:0,errors:0});c.cost+=m.cost;c.estimatedCost+=m.estimatedCost||0;c.tokens+=m.tokens;c.messages+=m.messages;c.errors+=m.errors||0});
    p.tools.forEach(function(t){var c=tools[t.tool]||(tools[t.tool]={tool:t.tool,count:0,outputTokens:0,schemaTokens:t.schemaTokens||0,complexity:t.complexity,totalDurationMs:0,errors:0});c.count+=t.count;c.outputTokens+=t.outputTokens||0;c.totalDurationMs+=t.totalDurationMs||0;c.errors+=t.errors||0});
    (p.skills||[]).forEach(function(s){var c=skills[s.name]||(skills[s.name]={name:s.name,count:0,tokens:0});c.count+=s.count;c.tokens+=s.tokens||0});
    (p.agentModel||[]).forEach(function(a){var k=a.agent+" "+a.model;var c=am[k]||(am[k]={agent:a.agent,model:a.model,cost:0,estimatedCost:0,tokens:0,messages:0});c.cost+=a.cost;c.estimatedCost+=a.estimatedCost||0;c.tokens+=a.tokens;c.messages+=a.messages});
    p.sessions.forEach(function(s){sessions.push(Object.assign({},s,{projectName:p.projectName}))});
    split.main.cost+=p.split.main.cost;split.main.estimatedCost+=p.split.main.estimatedCost||0;split.main.tokens+=p.split.main.tokens;split.main.apiCalls+=p.split.main.apiCalls;
    split.subagents.cost+=p.split.subagents.cost;split.subagents.estimatedCost+=p.split.subagents.estimatedCost||0;split.subagents.tokens+=p.split.subagents.tokens;split.subagents.apiCalls+=p.split.subagents.apiCalls;
    savings+=p.cache.savings;
    if(p.context){["systemPrompt","toolDefinitions","environment","projectTree","customInstructions","other"].forEach(function(k){ctx[k]+=p.context[k]||0})}
  });
  ctx.total=ctx.systemPrompt+ctx.toolDefinitions+ctx.environment+ctx.projectTree+ctx.customInstructions+ctx.other;
  var t=g.totals,hit=(t.cacheRead+t.input)>0?t.cacheRead/(t.cacheRead+t.input):0;
  return {projectName:"All projects",projectRoot:(g.projects||[]).length+" project(s)",totals:t,apiCalls:g.apiCalls,
    cache:{hitRate:hit,savings:savings,effectiveRatePerM:t.tokens>0?(t.cost/t.tokens)*1e6:0,withoutCachingCost:0},
    split:split,models:Object.keys(models).map(function(k){return models[k]}).sort(byCost),
    tools:Object.keys(tools).map(function(k){return tools[k]}).sort(function(a,b){return b.count-a.count}),
    skills:Object.keys(skills).map(function(k){return skills[k]}).sort(function(a,b){return b.count-a.count}),
    agentModel:Object.keys(am).map(function(k){return am[k]}).sort(byCost),
    sessions:sessions,context:ctx,series:combineSeries(g.projects||[])};
}

/* ---- renderers ---- */
function renderKpis(g){
  var t=g.totals,hit=(t.cacheRead+t.input)>0?t.cacheRead/(t.cacheRead+t.input):0;
  var saved=0;(g.projects||[]).forEach(function(p){saved+=p.cache.savings});
  var est=t.estimatedCost||0;
  var spendSub=t.cost>0?("eff "+money2(t.tokens>0?(t.cost/t.tokens)*1e6:0)+"/M"):(est>0?("≈ "+money2(est)+" API"):(t.tokens>0?"free":"—"));
  var items=[
    ["⛁ spend",money(t.cost),spendSub,"cost"],
    ["⚡ tokens",compact(t.tokens),num(t.tokens)+" total",""],
    ["◴ api calls",num(g.apiCalls),t.sessions+" sessions",""],
    ["⛃ cache hit",pct(hit),compact(t.cacheRead)+" cached","green"],
    ["⛁ saved",money2(saved),"vs no-cache","green"],
    ["⌗ projects",String((g.projects||[]).length),"tracked","cyan"],
    ["⚠ issues",num(t.errors||0),(t.retries||0)+" retries",""]
  ];
  document.getElementById("kpis").innerHTML=items.map(function(it){
    return '<div class="kpi"><div class="l">'+it[0]+'</div><div class="v '+it[3]+'">'+it[1]+'</div><div class="sub">'+it[2]+'</div></div>'}).join("");
}

function renderTabs(g){
  var box=document.getElementById("projsearch");
  var q=(box&&box.value||"").trim().toLowerCase();
  var list=(g.projects||[]).filter(function(p){return !q||p.projectName.toLowerCase().indexOf(q)>=0||p.projectRoot.toLowerCase().indexOf(q)>=0});
  list=list.slice().sort(function(a,b){return b.totals.cost-a.totals.cost});
  var parts=['<button class="tab '+(selected==="all"?"on":"")+'" data-k="all">All projects<b>'+money2(g.totals.cost)+'</b></button>'];
  list.forEach(function(p){
    parts.push('<span class="tabwrap '+(selected===p.projectKey?"on":"")+'" title="'+esc(p.projectRoot)+'">'+
      '<button class="tab" data-k="'+esc(p.projectKey)+'">'+esc(p.projectName)+'<b>'+money2(p.totals.cost)+'</b></button>'+
      '<button class="tabdel" data-del="'+esc(p.projectKey)+'" data-name="'+esc(p.projectName)+'" title="Delete project data">×</button>'+
      '</span>');
  });
  if(list.length)parts.push('<button class="clearall" data-clear="1">Clear all</button>');
  if(q&&list.length===0)parts.push('<span style="color:var(--faint);font-size:12px;padding:6px">no matching projects</span>');
  var el=document.getElementById("tabs");el.innerHTML=parts.join("");
  Array.prototype.forEach.call(el.querySelectorAll(".tab"),function(b){b.onclick=function(){selected=b.getAttribute("data-k");draw()}});
  Array.prototype.forEach.call(el.querySelectorAll(".tabdel"),function(b){b.onclick=function(e){e.stopPropagation();del(b.getAttribute("data-del"),b.getAttribute("data-name"))}});
  var ca=el.querySelector(".clearall");if(ca)ca.onclick=delAll;
}
function del(key,name){
  if(!confirm('Delete all stored tokenomics data for "'+name+'"? This only clears the dashboard data, not your code. It cannot be undone.'))return;
  if(selected===key)selected="all";
  fetch("/api/projects/"+encodeURIComponent(key),{method:"DELETE"}).catch(function(){});
}
function delAll(){
  if(!confirm("Delete stored tokenomics data for ALL projects? This only clears the dashboard data, not your code. It cannot be undone."))return;
  selected="all";
  fetch("/api/projects",{method:"DELETE"}).catch(function(){});
}

function renderModels(models){
  if(!models.length)return '<div class="empty">—</div>';
  var max=models.reduce(function(mx,m){return Math.max(mx,m.tokens)},0)||1;
  return models.slice(0,8).map(function(m){
    return '<div class="row" style="grid-template-columns:minmax(0,1fr) 76px"><div class="nm">'+esc(shortModel(m.model))+
      '<span class="meta">'+esc(m.providerID||providerOf(m.model))+' · '+compact(m.tokens)+' tok · '+m.messages+' calls</span>'+bar(m.tokens/max,'var(--violet)')+'</div>'+
      '<div class="c">'+costHtml(m.cost,m.estimatedCost)+'</div></div>'}).join("");
}

function dayKeyF(ts){var d=new Date(ts);return new Date(d.getFullYear(),d.getMonth(),d.getDate()).getTime()}
function dayLabelF(ts){var diff=Math.round((dayKeyF(Date.now())-dayKeyF(ts))/86400000);if(diff===0)return"Today";if(diff===1)return"Yesterday";return new Date(ts).toLocaleDateString(undefined,{month:"short",day:"numeric"})}
function buildForestF(sessions){
  var ids={};sessions.forEach(function(s){ids[s.sessionID]=true});
  var byParent={};sessions.forEach(function(s){var k=(s.parentID&&ids[s.parentID])?s.parentID:"__root";(byParent[k]=byParent[k]||[]).push(s)});
  function build(s,depth){
    var kids=(byParent[s.sessionID]||[]).map(function(c){return build(c,depth+1)});
    kids.sort(function(a,b){return b.subtreeCost-a.subtreeCost});
    var n={s:s,depth:depth,children:kids,descendants:0,subtreeCost:s.cost,subtreeEst:s.estimatedCost||0,subtreeTokens:s.tokens};
    kids.forEach(function(c){n.descendants+=c.descendants+1;n.subtreeCost+=c.subtreeCost;n.subtreeEst+=c.subtreeEst;n.subtreeTokens+=c.subtreeTokens});
    return n;
  }
  return (byParent["__root"]||[]).map(function(s){return build(s,0)}).sort(function(a,b){return b.subtreeCost-a.subtreeCost});
}
function renderTree(sessions){
  if(!sessions.length)return '<div class="empty">no sessions yet</div>';
  var forest=buildForestF(sessions);
  var days={};
  forest.forEach(function(n){var ts=n.s.startedAt||n.s.lastActivity||0;var k=dayKeyF(ts);var g=days[k]||(days[k]={ts:k,label:dayLabelF(ts),roots:[],cost:0,est:0,tokens:0,sessions:0});g.roots.push(n);g.cost+=n.subtreeCost;g.est+=n.subtreeEst;g.tokens+=n.subtreeTokens;g.sessions+=n.descendants+1});
  var dayList=Object.keys(days).map(function(k){return days[k]}).sort(function(a,b){return b.ts-a.ts});
  var out=[];
  function emit(n){
    var open=!treeCollapsed[n.s.sessionID],hasKids=n.children.length>0;
    var label=esc(n.s.agent||n.s.title||n.s.sessionID.slice(0,10));
    var chev=hasKids?'<span class="chev'+(open?' open':'')+'" data-tog="'+esc(n.s.sessionID)+'">▸</span>':'<span class="chevpad"></span>';
    var merged=(hasKids&&!open)?' · <span style="color:var(--violet)">+'+n.descendants+' merged</span>':'';
    out.push('<div class="row brow" style="grid-template-columns:minmax(0,1fr) 70px"><div class="nm tree" style="padding-left:'+(n.depth*16)+'px">'+chev+
      '<span class="sd '+(n.s.isSubagent?'sub':'main')+'"></span>'+label+
      '<span class="badge">'+esc(shortModel(n.s.model))+'</span>'+
      '<span class="meta">'+compact(open?n.s.tokens:n.subtreeTokens)+' tok · '+n.s.messages+' calls · '+dur(n.s.durationMs)+merged+'</span></div>'+
      '<div class="c">'+costHtml(open?n.s.cost:n.subtreeCost,open?n.s.estimatedCost:n.subtreeEst)+'</div></div>');
    if(hasKids&&open)n.children.forEach(emit);
  }
  dayList.forEach(function(g){
    var dkey="day:"+g.ts,dopen=!treeCollapsed[dkey];
    out.push('<div class="dayhdr" data-tog="'+dkey+'"><span class="chev'+(dopen?' open':'')+'">▸</span><b>'+esc(g.label)+'</b><span class="meta">'+g.sessions+' sessions · '+compact(g.tokens)+' tok</span><span style="margin-left:auto">'+costHtml(g.cost,g.est)+'</span></div>');
    if(dopen)g.roots.forEach(emit);
  });
  return out.join("");
}

function renderContext(ctx){
  if(!ctx||!ctx.total)return '<div class="empty">awaiting first request…</div>';
  var keys=["systemPrompt","toolDefinitions","environment","projectTree","customInstructions","other"];
  var segs=keys.filter(function(k){return ctx[k]>0}).map(function(k){
    return '<i style="width:'+((ctx[k]/ctx.total)*100).toFixed(1)+'%;background:'+COLORS[k]+'" title="'+CXLABEL[k]+'"></i>'}).join("");
  var leg=keys.filter(function(k){return ctx[k]>0}).map(function(k){
    return '<span><span class="sw" style="background:'+COLORS[k]+'"></span>'+CXLABEL[k]+' <b>'+compact(ctx[k])+'</b></span>'}).join("");
  return '<div class="cx">'+segs+'</div><div class="cxleg">'+leg+'<span style="margin-left:auto">est. total <b>'+compact(ctx.total)+'</b> tok</span></div>';
}

function renderTools(tools){
  if(!tools.length)return '<div class="empty">no tool calls yet</div>';
  var rows=tools.slice(0,10).map(function(t){
    var cx=t.complexity==="complex"?'<span class="pill cmplx">complex</span>':(t.complexity==="simple"?'<span class="pill simple">simple</span>':'');
    var err=t.errors>0?'<span style="color:var(--warn)">'+t.errors+'</span>':'—';
    var avg=t.count?dur(t.totalDurationMs/t.count):dur(0);
    return '<tr><td class="l">'+esc(t.tool)+' '+cx+'</td><td>'+compact(t.count)+'</td><td>'+err+'</td><td>'+compact(t.outputTokens)+'</td><td>'+dur(t.totalDurationMs)+'</td><td>'+avg+'</td></tr>'}).join("");
  return '<table><thead><tr><th class="l">tool</th><th>calls</th><th>err</th><th>out tok</th><th>time</th><th>avg</th></tr></thead><tbody>'+rows+'</tbody></table>';
}
function renderSkills(skills){
  if(!skills||!skills.length)return '<div class="empty">no skills loaded</div>';
  var rows=skills.slice(0,12).map(function(s){return '<tr><td class="l">'+esc(s.name)+'</td><td>'+s.count+'</td><td>'+compact(s.tokens)+'</td></tr>'}).join("");
  return '<table><thead><tr><th class="l">skill</th><th>loads</th><th>tokens</th></tr></thead><tbody>'+rows+'</tbody></table>';
}

function renderAgentModel(am){
  if(!am||!am.length)return '<div class="empty">—</div>';
  var rows=am.slice(0,10).map(function(a){
    return '<tr><td class="l">'+esc(a.agent)+'</td><td class="l" style="color:var(--mute)">'+esc(shortModel(a.model))+(providerOf(a.model)?' <span style="opacity:.6">· '+esc(providerOf(a.model))+'</span>':'')+'</td><td>'+compact(a.tokens)+'</td><td>'+a.messages+'</td><td class="c">'+costHtml(a.cost,a.estimatedCost)+'</td></tr>'}).join("");
  return '<table><thead><tr><th class="l">agent</th><th class="l">model</th><th>tokens</th><th>calls</th><th>cost</th></tr></thead><tbody>'+rows+'</tbody></table>';
}

function renderProject(p){
  return '<div class="proj"><h2>'+esc(p.projectName)+'</h2><div class="path">'+esc(p.projectRoot)+'</div>'+
    '<div class="pstat">'+
      '<span>spend '+costHtml(p.totals.cost,p.totals.estimatedCost)+'</span>'+
      '<span>tokens <b>'+compact(p.totals.tokens)+'</b></span>'+
      '<span>api calls <b>'+num(p.apiCalls)+'</b></span>'+
      '<span>cache hit <b style="color:var(--green)">'+pct(p.cache.hitRate)+'</b></span>'+
      '<span>saved <b style="color:var(--green)">'+money2(p.cache.savings)+'</b></span>'+
      '<span>main/sub '+costHtml(p.split.main.cost,p.split.main.estimatedCost)+' / '+costHtml(p.split.subagents.cost,p.split.subagents.estimatedCost)+'</span>'+
      ((p.totals.errors||p.totals.retries)?'<span>issues <b style="color:var(--warn)">'+(p.totals.errors||0)+' err · '+(p.totals.retries||0)+' retry</b></span>':'')+
    '</div>'+
    (cardOn("spend")?'<div class="blk"><div class="sub"><span>cumulative spend</span><span>'+compact(p.totals.tokens)+' tok</span></div>'+sparkline(p.series)+'</div>':'')+
    '<div class="cols">'+
      '<div>'+
        (cardOn("tree")?'<div class="blk"><div class="sub"><span>agents &amp; subagents · who · what · how much · how long</span></div>'+renderTree(p.sessions)+'</div>':'')+
        (cardOn("agentModel")?'<div class="blk"><div class="sub"><span>agent × model</span></div>'+renderAgentModel(p.agentModel)+'</div>':'')+
      '</div>'+
      '<div>'+
        (cardOn("models")?'<div class="blk"><div class="sub"><span>by model</span></div>'+renderModels(p.models)+'</div>':'')+
        (cardOn("context")?'<div class="blk"><div class="sub"><span>context breakdown</span></div>'+renderContext(p.context)+'</div>':'')+
        (cardOn("tools")?'<div class="blk"><div class="sub"><span>tools</span></div>'+renderTools(p.tools)+'</div>':'')+
        (cardOn("skills")?'<div class="blk"><div class="sub"><span>skills loaded</span></div>'+renderSkills(p.skills)+'</div>':'')+
      '</div>'+
    '</div></div>';
}

function draw(){
  if(!last)return;
  renderKpis(last);renderTabs(last);
  var el=document.getElementById("projects");
  if(!(last.projects||[]).length){el.innerHTML='<div class="noproj">No usage yet — send a message in opencode and it will appear here in real time.</div>';return}
  var view=selected==="all"?mergeAll(last):(last.projects.filter(function(p){return p.projectKey===selected})[0]||mergeAll(last));
  el.innerHTML=renderProject(view);
  Array.prototype.forEach.call(el.querySelectorAll("[data-tog]"),function(b){b.onclick=function(e){e.stopPropagation();var k=b.getAttribute("data-tog");if(treeCollapsed[k])delete treeCollapsed[k];else treeCollapsed[k]=true;draw()}});
}

var dot=document.getElementById("dot"),lbl=document.getElementById("connlabel");
function connect(){
  var es=new EventSource("/api/stream");
  es.onopen=function(){dot.className="dot on";lbl.textContent="live"};
  es.onmessage=function(e){try{last=JSON.parse(e.data);draw()}catch(_){}}
  es.onerror=function(){dot.className="dot";lbl.textContent="reconnecting…";es.close();setTimeout(connect,2000)}
}
var ps=document.getElementById("projsearch");
if(ps)ps.addEventListener("input",function(){if(last)renderTabs(last)});
fetch("/api/config").then(function(r){return r.json()}).then(function(d){if(d&&d.cards){cardCfg=d.cards;draw()}}).catch(function(){});
connect();
</script>
</body>
</html>`
