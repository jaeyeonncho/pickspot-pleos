// Synthetic inputs only. No route or curb-condition provider is connected.
export const exampleLocation = Object.freeze({ latitude: 37.4859, longitude: 127.0348 });
export function demoCandidates() {
  return [
    ['a', '만남 지점 A', 37.48544722, 127.03636666, 230, 240, 120, 'designated', '도보와 우회를 함께 줄이는 시나리오'],
    ['b', '만남 지점 B', 37.4866, 127.0342, 90, 120, 300, 'designated', '동승자가 적게 걷는 시나리오'],
    ['c', '만남 지점 C', 37.4845, 127.0335, 480, 420, 45, 'designated', '운전자가 적게 우회하는 시나리오'],
    ['d', '미확인 지점 D', 37.4851, 127.0350, 170, 180, 240, 'unknown', '정차 관련 정보가 부족한 후보'],
    ['e', '제외 지점 E', 37.4860, 127.0350, 30, 60, 15, 'restricted', '제한 구간은 가까워도 제외']
  ].map(([id,name,latitude,longitude,walkMeters,walkSeconds,detourSeconds,curbStatus,note]) =>
    ({id,name,point:{latitude,longitude},walkMeters,walkSeconds,detourSeconds,curbStatus,note}));
}
