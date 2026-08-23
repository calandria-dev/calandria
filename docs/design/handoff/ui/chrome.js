// Calandria UI chrome: glyph + titlebar. Load with <script src="chrome.js"></script>, then CalChrome.titlebar("Diffs").
(function(){
const iso=(i,j)=>[12+(i-j)*2.598,16.6+(i+j)*1.5];
function glyph(h){let s="";const o=[];for(let j=0;j<3;j++)for(let i=0;i<3;i++)o.push([i,j]);o.sort((a,b)=>(a[0]+a[1])-(b[0]+b[1]));
for(const[i,j]of o){const[x,y]=iso(i,j);const d=Math.abs(i-1)+Math.abs(j-1),op=[1,.55,.3][d],rh=i===1&&j===1?13:9.5;
s+=`<ellipse cx="${x}" cy="${y}" rx="1.75" ry=".95" stroke="currentColor" stroke-width=".55" opacity="${op*.7}" fill="none"/><rect x="${x-1.05}" y="${y-rh}" width="2.1" height="${rh}" rx="1.05" fill="currentColor" opacity="${op}"/>`;}
return `<svg width="${(h*14.45/17.23).toFixed(1)}" height="${h}" viewBox="4.78 6.6 14.45 17.23" fill="none" style="display:block">${s}</svg>`;}
function titlebar(active,right){
const tabs=["Board","Diffs","Terminals","Insights"].map(t=>`<a class="cal-tab${t===active?" on":""}" href="./${t==="Board"?"Board":t}.html">${t}</a>`).join("");
return `<div class="cal-tb"><span style="display:inline-flex;color:var(--accent)">${glyph(18.4)}</span><span class="cal-word">Calandria</span><span class="cal-tabs">${tabs}</span><span class="cal-right">${right||'<span style="font-family:var(--font-mono)">7 sessions · 3 running</span><span class="cal-new">New session</span>'}</span></div>`;}
const css=`.cal-tb{display:flex;align-items:center;gap:10px;padding:10px 18px;border-bottom:1px solid var(--line)}
.cal-word{font-family:var(--font-display);font-weight:500;font-size:15px;letter-spacing:.005em}
.cal-tabs{display:flex;gap:2px;margin-left:26px}
.cal-tab{font-size:13px;color:var(--dim);padding:5px 12px;border-radius:6px;text-decoration:none}
.cal-tab.on{color:var(--ink);background:var(--panel);box-shadow:inset 0 -2px 0 var(--accent)}
.cal-tab:hover{color:var(--ink)}
.cal-right{margin-left:auto;display:flex;align-items:center;gap:14px;font-size:12px;color:var(--dim)}
.cal-new{background:var(--accent);color:var(--bg);font-weight:600;font-size:12.5px;padding:6px 14px;border-radius:7px}`;
const st=document.createElement("style");st.textContent=css;document.head.appendChild(st);
window.CalChrome={glyph,titlebar};
})();
