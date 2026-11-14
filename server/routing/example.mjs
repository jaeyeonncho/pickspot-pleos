// Fixed synthetic Yangjae/Maebong experiment. These are NOT verified pickup locations.
export const exampleDestinations = [
  {id:"maebong",name:"예제 목적지 · 양재·매봉",point:{latitude:37.4900,longitude:127.0400}},
  {id:"yangjae",name:"예제 목적지 · 양재역 주변",point:{latitude:37.4845,longitude:127.0340}}
];
export function exampleTrip(destinationId = "maebong") {
  const destination=exampleDestinations.find(d=>d.id===destinationId);
  if(!destination) throw new Error("Unknown example destination");
  return {driver:{latitude:37.4840,longitude:127.0300},passenger:{latitude:37.4859,longitude:127.0348},
    destination:{...destination.point},
    candidates:[
      {id:'a',point:{latitude:37.48544722,longitude:127.03636666},curbStatus:'unknown'},
      {id:'b',point:{latitude:37.4866,longitude:127.0342},curbStatus:'unknown'},
      {id:'c',point:{latitude:37.4845,longitude:127.0335},curbStatus:'unknown'}]};
}

// Freshness metadata is synthetic too; no device position is read.
export function exampleTripInput(at=Date.now(),destinationId="maebong") {
  const trip=exampleTrip(destinationId);
  const fix=p=>({point:p,observedAt:at,accuracyMeters:null,consent:true,source:'example'});
  return {mode:'example',expiresAt:at+15*60_000,driver:fix(trip.driver),passenger:fix(trip.passenger),
    destination:{point:trip.destination,name:exampleDestinations.find(d=>d.id===destinationId).name},waypoints:[],candidates:trip.candidates};
}
