/* DC Quality Reports - shared warehouse core (used by index.html AND server.js, identical logic).
   Pure functions over a plain state object S = {batches, ops, mvs, rcv, users, set}. */
var WH_UNA='__una';
function whCbs(b){return b.contrib&&b.contrib.length?b.contrib:[{rid:b.rid,qty:b.qty}]}
function whOpsOf(S,b,ex){
  var shared=null;
  return (S.ops||[]).filter(function(o){
    if(o.batch!==b.no||(ex&&o.mid===ex))return false;
    if(!o.prod||!b.prod||o.prod===b.prod)return true;
    if(shared===null)shared=(S.batches||[]).some(function(x){return x!==b&&x.no===b.no&&x.prod!==b.prod});
    return !shared;
  });
}
/* Per-warehouse ledger of ONE lot (batch record).
   Receipts (contribs) open each warehouse bucket. Operations then move it:
   - v3 operations carry an explicit warehouse (o.wh) and move exactly o.qty.
   - legacy operations (no v3 flag) never had a warehouse: they are attributed ONLY when unambiguous
     (declared source that is a real bucket, or the lot sits in a single bucket); otherwise they land in WH_UNA
     ("unassigned") and nothing is invented. A legacy transfer moved the whole lot, as the old app did. */
function whLedger(S,b,ex){
  var B={},rm={},mm={},has=function(k){return Object.prototype.hasOwnProperty.call(B,k)};
  (S.rcv||[]).forEach(function(r){rm[r.id]=r});(S.mvs||[]).forEach(function(m){mm[m.id]=m});
  function add(w,q){w=w||WH_UNA;B[w]=(B[w]||0)+q}
  whCbs(b).forEach(function(c){var w=c.wh||(rm[c.rid]&&rm[c.rid].wh)||b.wh;add(w,+c.qty||0)});
  var ops=whOpsOf(S,b,ex).slice().sort(function(a,c){
    var x=String(a.date||'')+'|'+String(a.cr||'')+'|'+String(a.id||''),y=String(c.date||'')+'|'+String(c.cr||'')+'|'+String(c.id||'');
    return x<y?-1:x>y?1:0});
  function single(){
    var ks=Object.keys(B);if(ks.length===1)return ks[0];
    var pos=ks.filter(function(k){return k!==WH_UNA&&B[k]>1e-9});
    return pos.length===1?pos[0]:WH_UNA}
  function pick(o){
    var known=o.wh||(mm[o.mid]&&mm[o.mid].src)||'';
    if(known&&has(known))return known;
    return single()}
  ops.forEach(function(o){
    var q=+o.qty||0,t=o.type;
    if(t==='تحويل'){
      if(o.v3){var to=o.to;if(!o.wh||!to)return;add(o.wh,-q);add(to,q);return}
      var from=pick(o),amt=B[from]||0,to2=o.to;
      if(amt>0&&to2){B[from]=0;add(to2,amt)}
      return}
    if(t==='صرف'){add(o.v3?o.wh:pick(o),-q);return}
    if(t==='مرتجع'||t==='تسوية'){add(o.v3?o.wh:pick(o),q);return}
    if(t==='تخصيص'){if(!o.wh)return;add(WH_UNA,-q);add(o.wh,q);return}
  });
  Object.keys(B).forEach(function(k){B[k]=+B[k].toFixed(6)});
  return B;
}
function whBalOf(S,b,w,ex){var B=whLedger(S,b,ex);return B[w]||0}
/* ---- warehouse groups / data scope ---- */
function whGroupOf(S,w){
  var g=((S.set||{}).wgs||[]);
  for(var i=0;i<g.length;i++)if((g[i].wh||[]).indexOf(w)>=0)return g[i].id;
  return '';
}
function whRecWhs(k,r,cx){
  var out=[];
  if(k==='batches')whCbs(r).forEach(function(c){var w=c.wh||r.wh;if(w)out.push(w)});
  else if(k==='rcv'){if(r.wh)out.push(r.wh)}
  else if(k==='mvs'){if(r.src)out.push(r.src)}
  else if(k==='ops'){var w2=r.wh||(cx.mm[r.mid]&&cx.mm[r.mid].src);if(w2)out.push(w2)}
  return out;
}
function whAuthor(S,r){
  var us=S.users||[];
  for(var i=0;i<us.length;i++){if(r.bu?us[i].u===r.bu:us[i].n===r.by)return us[i]}
  return null;
}
function whCtx(S){var mm={};(S.mvs||[]).forEach(function(m){mm[m.id]=m});return{mm:mm}}
/* Can `user` (non-privileged) see record r of collection k? ownFn(r) = authored by that user. */
function whCanSee(S,user,k,r,cx,ownFn){
  if(!user.wg)return ownFn(r);
  var gs=whRecWhs(k,r,cx).map(function(w){return whGroupOf(S,w)}).filter(Boolean);
  if(gs.length)return gs.indexOf(user.wg)>=0;
  if(ownFn(r))return true;
  var a=whAuthor(S,r);return !!a&&a.wg===user.wg;
}
function whCanSeeContrib(S,user,b,c,ownFn){
  if(!user.wg)return ownFn(c);
  var w=c.wh||b.wh,g=w?whGroupOf(S,w):'';
  if(g)return g===user.wg;
  if(ownFn(c))return true;
  var a=whAuthor(S,c);return !!a&&a.wg===user.wg;
}
function whPriv(u){return !!u&&(u.r==='Admin'||u.r==='QMgr')}
if(typeof module!=='undefined'&&module.exports)module.exports={WH_UNA:WH_UNA,whCbs:whCbs,whOpsOf:whOpsOf,whLedger:whLedger,whBalOf:whBalOf,whGroupOf:whGroupOf,whRecWhs:whRecWhs,whAuthor:whAuthor,whCtx:whCtx,whCanSee:whCanSee,whCanSeeContrib:whCanSeeContrib,whPriv:whPriv};
