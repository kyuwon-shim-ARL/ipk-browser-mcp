# IPK 그룹웨어 서류 필드 레퍼런스

## 개요
- URL: https://gw.ip-korea.org
- 분석일: 2024-12-24
- 총 분석 서류: 269건

---

## 1. 휴가신청 (Leave Request)
- **폼 코드**: AppFrm-073
- **사용 빈도**: 연차 6건, 보상휴가 7건, 육아휴직 2건

### 제목 패턴
```
Annual leave, 2025-12-22~2025-12-22, 101dong, 501ho, 20, Jegi-ro, Dongdaemun-gu, Seoul, Kyuwon Shim
Compensatory leave, 2025-12-19~2025-12-19, 101dong, 501ho, 20, Jegi-ro, Dongdaemun-gu, Seoul, Kyuwon Shim
Paternity Leave, 2025-11-24~2025-11-27, Seoul, Kyuwon Shim
```

### 필수 필드
| 필드명 | name 속성 | 타입 | 값 예시 |
|-------|----------|------|--------|
| 휴가종류 | `leave_kind[]` | select | 01=연차, 11=보상휴가, 15=육아휴직 |
| 사용타입 | `using_type[]` | select | 01=Full day, 04=Hours |
| 시작일 | `begin_date[]` | text | 2025-12-22 |
| 종료일 | `end_date[]` | text | 2025-12-22 |
| 사유 | `purpose` | text | child care, personal |
| 목적지 | `destination` | text | 101dong, 501ho, 20, Jegi-ro... |

### 대리자 정보
| 필드명 | name 속성 |
|-------|----------|
| 대리자 이름 | `substitute_name` |
| 대리자 사번 | `substitute_payroll` |
| 대리자 직책 | `substitute_position` |
| 대리자 연락처 | `substitute_contact` |

### 비상연락처
| 필드명 | name 속성 |
|-------|----------|
| 비상 주소 | `emergency_address` |
| 비상 전화 | `emergency_telephone` |

### 휴가 종류 코드
| 코드 | 설명 | 첨부파일 |
|-----|------|---------|
| 01 | Annual leave (연차) | ❌ 불필요 |
| 11 | Compensatory leave (보상휴가) | ❌ 불필요 |
| 14 | Saved Annual leave | ❌ 불필요 |
| 04 | Menstruation leave (UnPaid) | ❌ 불필요 |
| 02 | Sick leave (병가) | ✅ **필수** (진단서, 입원확인서) |
| 03 | Special leave | ✅ **필수** (증빙서류) |
| 05 | Official leave | ✅ **필수** (증빙서류) |
| 07 | Child delivery and Nursing leave | ✅ **필수** (증빙서류) |
| 13 | Fetus Checkup (태아검진) | ✅ **필수** (증빙서류) |
| 15 | Paternity Leave (육아휴직) | ✅ **필수** (출생증명서) |

---

## 2. R&D 경비청구 (R&D Expense Request)
- **폼 코드**: AppFrm-021
- **사용 빈도**: 야근식대 30건, R&D경비 17건, 기타카드 36건
- **첨부파일**: ✅ **필수** (영수증/인보이스)

### 제목 패턴
```
[Card] overtime meal
[Card] ER_overtime meal_20251208_SL_ARL
[Card] R&D Expense Request_Reagent
[Card] Monthly Subscription for Claude (AI agent)
```

### 필수 필드
| 필드명 | name 속성 | 타입 | 값 예시 |
|-------|----------|------|--------|
| 제목 | `subject` | text | [Card] overtime meal |
| 예산타입 | `budget_type` | select | 01=General, 02=R&D |
| 예산코드 | `budget_code` | select | NN2512-0001 등 |
| 결제방법 | `pay_kind` | select | 03=Wire, 04=Reimburse |

### 경비 항목 (배열)
| 필드명 | name 속성 | 설명 |
|-------|----------|------|
| 인보이스 날짜 | `invoice[]` | |
| 계정코드 | `account_code[]` | |
| 품목명 | `item_name[]` | |
| 품목설명 | `item_desc[]` | |
| 금액(VAT제외) | `item_amount[]` | |
| VAT | `item_amount_vat[]` | |
| 수량 | `item_qty[]` | 기본 1 |
| 총액 | `item_amount_ral[]` | |
| 판매자 | `vender[]` | |

### 야근식대 전용 필드
| 필드명 | name 속성 |
|-------|----------|
| 참석자 | `participants[]` |
| 목적 | `purpose[]` |
| 장소 | `venue[]` |
| 야근 시작일 | `overtime_start_day` |
| 야근 종료일 | `overtime_end_day` |
| 야근 멤버 | `ov_member` |
| 야근 목적 | `ov_purpose` |

### 예산 코드 예시
| 코드 | 프로젝트명 |
|-----|-----------|
| FS2214-0001 | 2022 GARDP FFS_Soojin Jang (ARL) |
| NN2509-0001 | 2025 GloPID-R Program |
| NN2512-0001 | 2025 Mid-career Research Program |
| RS_JSJ | 연구지원계정_Soojin Jang |

---

## 3. 휴일근무신청 (Work Request)
- **폼 코드**: AppFrm-027
- **사용 빈도**: 5건

### 제목 패턴
```
Application for Working on 2025-12-16, Kyuwon Shim
```

### 필수 필드
| 필드명 | name 속성 | 타입 | 값 예시 |
|-------|----------|------|--------|
| 제목 | `subject` | text | Application for Working on 날짜, 이름 |
| 부서 | `division` | text | Antibacterial Resistance Lab (자동) |
| 신청자 | `requester` | text | Kyuwon Shim (자동) |
| 근무날짜 | `desired_date` | text | 2025-12-16 |
| 근무장소 | `wroking_place` | text | IPK |
| 근무내용 | `sub_subject` | text | |
| 상세내용 | `contents1` | textarea | 근무 상세 내용 |

---

## 4. 출장보고서 (Travel Report)
- **폼 코드**: AppFrm-076
- **사용 빈도**: 해외출장 8건, 미팅요청 8건
- **첨부파일**: 권장 (출장 수집 자료, 발표자료 등)

### 제목 패턴
```
[Request] Overseas Business Travel Request (2026 Biophysical Society Annual Meeting)
[Request] A meeting with Dr. Hyuk Lee in KRICT
[Settlement] Participation of MSK 2025
```

### 필수 필드
| 필드명 | name 속성 | 타입 |
|-------|----------|------|
| 제목 | `subject` | text |
| 보고일 | `report_date` | text |
| 보고자 | `report_name` | text |
| 직책 | `report_post` | text |
| 부서 | `report_group` | text |
| 팀장 | `report_leader` | text |
| 시작일 | `start_day` | text |
| 종료일 | `end_day` | text |

### 상세 내용 (textarea)
| 필드명 | name 속성 |
|-------|----------|
| 출장지 | `report_dest` |
| 목적 | `purpose_field` |
| 일정 | `date_field` |
| 기관 | `org_field` |
| 참석자 | `person_field` |
| 논의내용 | `discuss_field` |
| 의제 | `agenda_field` |
| 결과 | `result_field` |
| 기타 | `other_field` |
| 결론 | `conclusion_field` |

---

## 공통 필드

### 모든 서류에 공통
| 필드명 | name 속성 | 기본값 |
|-------|----------|-------|
| 결재마감일 | `close_date` | 2025-12-31 |
| 긴급 | `urgent` | N |
| 비밀 | `security` | N |
| 참조 | `apporve_cc` | |
| 보존기간 | `retention` | 5 (5 years) |
| 첨부파일 | `doc_attach_file[]` | |

---

## 작성자별 통계 (269건)
1. Minjeong Woo: 40건
2. Soojin Jang: 39건
3. Guinam Wee: 38건
4. Sol Lee: 37건
5. Hyungjun Kim: 32건
6. **Kyuwon Shim: 31건**
7. Hyun-Jung Lee: 20건
8. YunMi LEE: 11건
