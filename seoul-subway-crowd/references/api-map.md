# SK Open API 지하철 혼잡도 매핑

확인 기준: https://openapi.sk.com/products/detail?svcSeq=59 (TMAP 대중교통 > 통계성 열차 혼잡도)

## 1) 인증
- Base host: `https://apis.openapi.sk.com`
- 인증 방식: **HTTP Header**
  - `appkey: {발급받은 appKey}`
- 권장 헤더:
  - `Accept: application/json`

## 2) 엔드포인트
- 진입 역 기준 **열차 혼잡도**
  - `GET /transit/puzzle/subway/congestion/stat/train`
  - 전체 URL 예:
    - `https://apis.openapi.sk.com/transit/puzzle/subway/congestion/stat/train?routeNm=1호선&stationNm=서울역&dow=MON&hh=08`
- 진입 역 기준 **칸 혼잡도**
  - `GET /transit/puzzle/subway/congestion/stat/car`
  - 전체 URL 예:
    - `https://apis.openapi.sk.com/transit/puzzle/subway/congestion/stat/car?routeNm=1호선&stationNm=서울역&dow=TUE&hh=08`

## 3) 요청 파라미터 매핑
- `routeNm` (required): 노선명 (예: `1호선`)
- `stationNm` (required): 역명 (예: `서울역`)
- `dow` (optional): `MON|TUE|WED|THU|FRI|SAT|SUN`
- `hh` (optional): `05`~`23` (해당 시각 00~50, 10분 단위 통계)

## 4) 응답 필드 매핑
### 공통 상위
- `status.code` (성공: `00`)
- `status.message` (`success`)
- `status.totalCount`
- `contents.subwayLine`
- `contents.stationName`
- `contents.stationCode`
- `contents.stat[]`

### stat 하위 공통
- `startStationCode`, `startStationName`
- `endStationCode`, `endStationName`
- `prevStationCode`, `prevStationName`
- `updnLine` (`0`=상행/외선, `1`=하행/내선)
- `directAt` (`0`=일반, `1`=급행)
- `data[]`

### 열차 혼잡도(train)
- `data[].dow`, `data[].hh`, `data[].mm`
- `data[].congestionTrain` (%, int)

### 칸 혼잡도(car)
- `data[].dow`, `data[].hh`, `data[].mm`
- `data[].congestionCar` (칸별 배열)

## 5) 로컬 레벨 규칙(요약용)
`congestionTrain`(%) 기준:
- 0~39: 여유
- 40~69: 보통
- 70~84: 혼잡
- 85+: 매우 혼잡

## 6) 테스트 케이스
- train: `routeNm=2호선, stationNm=강남역`
- car: `routeNm=2호선, stationNm=홍대입구역, dow=MON, hh=08`
- 잘못된 역명/노선명 입력 시 에러 처리
