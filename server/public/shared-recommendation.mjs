// Display contract contains synthetic totals only, never participant coordinates.
export function sharedRecommendationView(session,now=Date.now()) {
  const report=session?.sharedRecommendation,share=session?.locationShare;
  if(share?.status!=='ready'||!Number.isSafeInteger(share.validUntil)||share.validUntil<=now||
    report?.status!=='ready'||report.source!=='synthetic-fixture'||report.synthetic!==true||
    report.inputMode!=='example'||report.referenceOnly!==true||!Number.isSafeInteger(report.validUntil)||report.validUntil<=now||
    !Array.isArray(report.candidates)||report.candidates.length<1||report.candidates.length>3)return null;
  const ids=new Set(),items=[];
  for(const c of report.candidates) {
    if(!['a','b','c'].includes(c?.id)||ids.has(c.id)||c.curbStatus!=='unknown'||
      ![c.walkMeters,c.walkSeconds,c.detourSeconds].every(n=>Number.isSafeInteger(n)&&n>=0&&n<=2147483647))return null;
    ids.add(c.id);
    items.push({title:`픽업 지점 ${c.id.toUpperCase()}`,copy:`도보 ${c.walkMeters}m · ${Math.ceil(c.walkSeconds/60)}분 / 차량 우회 ${Math.ceil(c.detourSeconds/60)}분`});
  }
  return {items,validUntil:Math.min(report.validUntil,share.validUntil)};
}

export function renderSharedRecommendation(panel,session,now=Date.now()) {
  const view=sharedRecommendationView(session,now);
  panel.hidden=!view;
  const list=panel.querySelector('[data-candidates]');list.replaceChildren();
  if(!view)return;
  for(const item of view.items) {
    const row=document.createElement('p'),title=document.createElement('strong'),copy=document.createElement('span');
    title.textContent=item.title;copy.textContent=item.copy;
    row.append(title,document.createElement('br'),copy);list.append(row);
  }
}
