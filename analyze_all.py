"""전체 서류 패턴 분석"""
import json
from collections import defaultdict

# 팀 문서 (250건)
with open("screenshots/all_docs/all_documents.json", "r") as f:
    team_docs = json.load(f)

# 내 문서 (25건) - 이전에 가져온 것
with open("screenshots/approved_docs/doc_list.json", "r") as f:
    my_docs = json.load(f)
    for d in my_docs:
        d['source'] = 'my'

# 합치기 (중복 제거)
seen = set()
all_docs = []
for doc in my_docs + team_docs:
    if doc['doc_no'] not in seen:
        seen.add(doc['doc_no'])
        all_docs.append(doc)

print(f"총 {len(all_docs)}건 분석\n")

# 서류 종류별 분류
categories = defaultdict(list)

for doc in all_docs:
    subj = doc['subject']
    subj_lower = subj.lower()

    if 'annual leave' in subj_lower:
        categories['연차휴가'].append(doc)
    elif 'compensatory leave' in subj_lower:
        categories['보상휴가'].append(doc)
    elif 'paternity leave' in subj_lower or 'childcare leave' in subj_lower:
        categories['육아휴직'].append(doc)
    elif 'sick leave' in subj_lower:
        categories['병가'].append(doc)
    elif 'application for working' in subj_lower:
        categories['휴일근무신청'].append(doc)
    elif '[card]' in subj_lower and ('overtime' in subj_lower or 'meal' in subj_lower):
        categories['야근식대'].append(doc)
    elif '[card]' in subj_lower and 'expense' in subj_lower:
        categories['R&D경비(카드)'].append(doc)
    elif '[card]' in subj_lower and ('registration' in subj_lower or 'membership' in subj_lower):
        categories['학회등록비'].append(doc)
    elif '[card]' in subj_lower and ('subscription' in subj_lower or 'software' in subj_lower):
        categories['구독료/소프트웨어'].append(doc)
    elif '[card]' in subj_lower:
        categories['기타카드경비'].append(doc)
    elif '[settlement]' in subj_lower:
        categories['정산서'].append(doc)
    elif '[request]' in subj_lower and ('travel' in subj_lower or 'overseas' in subj_lower):
        categories['해외출장요청'].append(doc)
    elif '[request]' in subj_lower and 'meeting' in subj_lower:
        categories['미팅/세미나요청'].append(doc)
    elif '[request]' in subj_lower:
        categories['기타요청'].append(doc)
    elif 'budget transfer' in subj_lower:
        categories['예산이체'].append(doc)
    elif 'probationary' in subj_lower:
        categories['수습평가'].append(doc)
    else:
        categories['기타'].append(doc)

# 결과 출력
print("=" * 70)
print("서류 종류별 분석 (전체 데이터)")
print("=" * 70)

for cat, docs in sorted(categories.items(), key=lambda x: -len(x[1])):
    print(f"\n## {cat} ({len(docs)}건)")
    print("-" * 50)

    writers = list(set(d['writer'] for d in docs))
    print(f"작성자: {', '.join(writers[:5])}{'...' if len(writers) > 5 else ''}")

    # 제목 패턴 분석
    print(f"제목 예시:")
    for subj in list(set(d['subject'] for d in docs))[:5]:
        print(f"  - {subj[:70]}")

# 종류별 통계
print("\n\n" + "=" * 70)
print("서류 종류별 요약")
print("=" * 70)
print(f"{'종류':<20} {'건수':>6} {'비율':>8}")
print("-" * 40)
total = len(all_docs)
for cat, docs in sorted(categories.items(), key=lambda x: -len(x[1])):
    pct = len(docs) / total * 100
    print(f"{cat:<20} {len(docs):>6}건 {pct:>7.1f}%")

# 작성자별 통계
print("\n\n" + "=" * 70)
print("작성자별 통계")
print("=" * 70)
writers = defaultdict(int)
for doc in all_docs:
    writers[doc['writer']] += 1

for w, cnt in sorted(writers.items(), key=lambda x: -x[1])[:15]:
    print(f"  {w}: {cnt}건")

# JSON 저장
analysis = {}
for cat, docs in categories.items():
    analysis[cat] = {
        "count": len(docs),
        "writers": list(set(d['writer'] for d in docs)),
        "sample_subjects": list(set(d['subject'] for d in docs))[:10]
    }

with open("screenshots/all_docs/full_analysis.json", "w", encoding="utf-8") as f:
    json.dump(analysis, f, ensure_ascii=False, indent=2)

print("\n\n분석 결과 저장: screenshots/all_docs/full_analysis.json")
